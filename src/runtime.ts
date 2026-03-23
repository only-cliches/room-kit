import { Err, Ok } from "iron-enum";

import type {
	ChannelLayerOptions,
	ChannelContext,
	ChannelLayer,
	RequestOptions,
	RequestHandler,
	ServerEventHandler,
	SubscribeHandler,
} from "./runtime-types";
import type {
	AnyChannelDef,
	EventChannelDef,
	RequestChannelDef,
	RoomChannelDef,
	StreamChannelDef,
	Unsubscribe,
} from "./channel";
import {
	type SafeCallResult,
	SubscriptionState,
	type SubscriptionStateVariant,
	eventEventName,
	makeRequestFailureInvalidResponse,
	makeRequestFailureRejected,
	makeRequestFailureTimeout,
	parseWireFrame,
	publishEventName,
	roomJoinEventName,
	roomLeaveEventName,
	requestEventName,
	responseErrorEventName,
	responseEventName,
	subscribeEventName,
	unsubscribeEventName,
	toChannelSpec,
	eventFrame,
	requestFrame,
	responseErrorFrame,
	responseFrame,
	subscribeFrame,
	unsubscribeFrame,
	publishFrame,
	roomJoinFrame,
	roomLeaveFrame,
	emitRawFrame,
} from "./protocol";
import type { ChannelTransport, SendTargetApi, TransportHandler } from "./transport";

export type {
	ChannelLayerOptions,
	ChannelContext,
	ChannelLayer,
	RequestHandler,
	ServerEventHandler,
	SubscribeHandler,
} from "./runtime-types";

export function createSocketChannels<TContext = unknown>(
	transport: ChannelTransport,
	options: ChannelLayerOptions<TContext> = {},
): ChannelLayer<TContext> {
	const createId = options.createId ?? defaultCreateId;
	const defaultTimeoutMs = options.defaultTimeoutMs ?? 10_000;
	const contextData = options.context as TContext;

	const subscriptions = new Map<
		string,
		{
			id: string;
			channelDef: StreamChannelDef<any, any>;
			channelName: string;
			params: unknown;
			handler: TransportHandler;
			state: SubscriptionStateVariant;
		}
	>();
	const roomMemberships = new Set<string>();
	const roomReplayEntries = new Map<
		string,
		{
			replay: () => Promise<void>;
			drop: () => void;
		}
	>();
	let hasConnected = transport.isConnected();
	let reconnectWatcherInstalled = false;

	const makeSendTarget = (target: SendTargetApi): SendTargetApi => target;
	const callRoomOperation = (operation: "joinRoom" | "leaveRoom", room: string): Promise<void> => {
		const method = transport[operation];
		if (!method) {
			return Promise.reject(new Error("Room membership is not supported by this transport"));
		}

		return Promise.resolve(method.call(transport, room));
	};

	const makeCtx = (): ChannelContext<TContext> => ({
		transport,
		data: contextData,
		emit<T>(channel: EventChannelDef<T>, payload: T): void {
			emitRawFrame(transport, eventEventName(channel.name), eventFrame(channel, payload));
		},
		publish<TSub, TPub>(channel: StreamChannelDef<TSub, TPub>, payload: TPub): void {
			emitRawFrame(transport, publishEventName(channel.name), publishFrame(channel, payload));
		},
		async joinRoom(room: string): Promise<void> {
			installReconnectWatcher();
			roomMemberships.add(room);
			try {
				await callRoomOperation("joinRoom", room);
			} catch (error) {
				roomMemberships.delete(room);
				throw error;
			}
		},
		async leaveRoom(room: string): Promise<void> {
			await callRoomOperation("leaveRoom", room);
			roomMemberships.delete(room);
		},
		toRoom(room: string): SendTargetApi {
			return makeSendTarget(transport.toRoom(room));
		},
		broadcast: makeSendTarget(transport.broadcast),
	});

	const replayActiveRooms = (): void => {
		for (const room of roomMemberships) {
			void callRoomOperation("joinRoom", room).catch(() => {
				roomMemberships.delete(room);
			});
		}

		for (const entry of roomReplayEntries.values()) {
			void entry.replay().catch(() => {
				entry.drop();
			});
		}
	};

	const makeRoomReplayKey = (channelName: string, payload: unknown): string => {
		return `${channelName}:${stableSerialize(payload)}`;
	};

	const resubscribeActiveStreams = (): void => {
		for (const subscription of subscriptions.values()) {
			subscription.state.if("Active", () => {
				emitRawFrame(
					transport,
					subscribeEventName(subscription.channelName),
					subscribeFrame(subscription.channelDef, subscription.id, subscription.params),
				);
			});
		}
	};

	const installReconnectWatcher = (): void => {
		if (reconnectWatcherInstalled) {
			return;
		}

		// Watchers may be installed after the initial connect (for example, after first room.join()).
		hasConnected = hasConnected || transport.isConnected();
		reconnectWatcherInstalled = true;
		transport.onConnect(() => {
			if (hasConnected) {
				replayActiveRooms();
				resubscribeActiveStreams();
				return;
			}

			hasConnected = true;
		});
	};

	const layer: any = {
		event(channel: EventChannelDef<any>) {
			const spec = toChannelSpec(channel);
			if (!spec.is("Event")) {
				throw new Error(`Channel '${channel.name}' is not an event channel`);
			}

			return {
				send(payload: any): void {
					emitRawFrame(transport, eventEventName(channel.name), eventFrame(channel, payload));
				},
				on(handler: any): Unsubscribe {
					const eventName = eventEventName(channel.name);
					const wrapped: TransportHandler = (raw) => {
						const frame = parseWireFrame(raw);
						frame.if("Event", ({ channel: frameChannel, payload }: any) => {
							if (frameChannel === channel.name) {
								handler(payload);
							}
						});
					};
					transport.on(eventName, wrapped);
					return () => transport.off(eventName, wrapped);
				},
				handle(handler: any): Unsubscribe {
					const eventName = eventEventName(channel.name);
					const wrapped: TransportHandler = (raw) => {
						const frame = parseWireFrame(raw);
						frame.if("Event", ({ channel: frameChannel, payload }: any) => {
							if (frameChannel === channel.name) {
								void handler(payload, makeCtx());
							}
						});
					};
					transport.on(eventName, wrapped);
					return () => transport.off(eventName, wrapped);
				},
			};
		},

		request(channel: RequestChannelDef<any, any>) {
			const spec = toChannelSpec(channel);
			if (!spec.is("Request")) {
				throw new Error(`Channel '${channel.name}' is not a request channel`);
			}

			return {
				async call(payload: any, options?: RequestOptions): Promise<any> {
					const result = await this.safeCall(payload, options);
					return result.matchExhaustive({
						Ok: (value: any) => value,
						Err: (error: any) => {
							throw error;
						},
					});
				},

				async safeCall(payload: any, options?: RequestOptions): Promise<any> {
					const id = createId();
					const responseEvent = responseEventName(channel.name, id);
					const errorEvent = responseErrorEventName(channel.name, id);
					const timeoutMs = options?.timeoutMs ?? defaultTimeoutMs;

					return await new Promise<any>((resolve) => {
						const cleanup = () => {
							clearTimeout(timer);
							transport.off(responseEvent, onResponse);
							transport.off(errorEvent, onError);
						};

						const onResponse: TransportHandler = (raw) => {
							cleanup();
							const frame = parseWireFrame(raw);
							frame.match({
								Response: ({ id: responseId, payload: responsePayload }: any) =>
									responseId === id
										? resolve(Ok(responsePayload))
										: resolve(Err(makeRequestFailureInvalidResponse("Mismatched response id"))),
								_: () =>
									resolve(Err(makeRequestFailureInvalidResponse("Expected Response frame"))),
							});
						};

						const onError: TransportHandler = (raw) => {
							cleanup();
							const frame = parseWireFrame(raw);
							frame.match({
								ResponseError: ({ id: responseId, error }: any) =>
									responseId === id
										? resolve(Err(makeRequestFailureRejected(error)))
										: resolve(Err(makeRequestFailureInvalidResponse("Mismatched response id"))),
								_: () =>
									resolve(Err(makeRequestFailureInvalidResponse("Expected ResponseError frame"))),
							});
						};

						const timer = setTimeout(() => {
							cleanup();
							resolve(Err(makeRequestFailureTimeout(timeoutMs)));
						}, timeoutMs);

						transport.on(responseEvent, onResponse);
						transport.on(errorEvent, onError);
						emitRawFrame(transport, requestEventName(channel.name), requestFrame(channel, id, payload));
					});
				},

				handle(handler: any): Unsubscribe {
					const eventName = requestEventName(channel.name);
					const wrapped: TransportHandler = (raw) => {
						const frame = parseWireFrame(raw);
						frame.if("Request", ({ id, channel: frameChannel, payload }: any) => {
							if (frameChannel !== channel.name) {
								return;
							}

							void Promise.resolve(handler(payload, makeCtx()))
								.then((value) => {
									emitRawFrame(transport, responseEventName(channel.name, id), responseFrame(id, value));
								})
								.catch((error) => {
									emitRawFrame(transport, responseErrorEventName(channel.name, id), responseErrorFrame(id, error));
								});
						});
					};

					transport.on(eventName, wrapped);
					return () => transport.off(eventName, wrapped);
				},
			};
		},

		stream(channel: StreamChannelDef<any, any>) {
			const spec = toChannelSpec(channel);
			if (!spec.is("Stream")) {
				throw new Error(`Channel '${channel.name}' is not a stream channel`);
			}

			return {
				subscribe(params: any, onPublish: (payload: any) => void): Unsubscribe {
					const id = createId();
					const eventName = publishEventName(channel.name);
					const wrapped: TransportHandler = (raw) => {
						const frame = parseWireFrame(raw);
						frame.if("Publish", ({ channel: frameChannel, payload }: any) => {
							if (frameChannel === channel.name) {
								onPublish(payload);
							}
						});
					};

					subscriptions.set(id, {
						id,
						channelDef: channel,
						channelName: channel.name,
						params,
						handler: wrapped,
						state: SubscriptionState.Active({ id, channel: channel.name }),
					});

					installReconnectWatcher();
					transport.on(eventName, wrapped);
					emitRawFrame(transport, subscribeEventName(channel.name), subscribeFrame(channel, id, params));

					return () => {
						const current = subscriptions.get(id);
						current?.state.match({
							Active: () => {
								transport.off(eventName, wrapped);
								emitRawFrame(transport, unsubscribeEventName(channel.name), unsubscribeFrame(channel, id));
								subscriptions.delete(id);
							},
							_: () => {
								transport.off(eventName, wrapped);
								subscriptions.delete(id);
							},
						});
					};
				},

				publish(payload: any): void {
					emitRawFrame(transport, publishEventName(channel.name), publishFrame(channel, payload));
				},

				handleSubscribe(handler: any): Unsubscribe {
					const eventName = subscribeEventName(channel.name);
					const wrapped: TransportHandler = (raw) => {
						const frame = parseWireFrame(raw);
						frame.if("Subscribe", ({ id, channel: frameChannel, payload }: any) => {
							if (frameChannel === channel.name) {
								void handler(payload, makeCtx());
							}
						});
					};

					transport.on(eventName, wrapped);
					return () => transport.off(eventName, wrapped);
				},

				onPublish(handler: (payload: any) => void): Unsubscribe {
					const eventName = publishEventName(channel.name);
					const wrapped: TransportHandler = (raw) => {
						const frame = parseWireFrame(raw);
						frame.if("Publish", ({ channel: frameChannel, payload }: any) => {
							if (frameChannel === channel.name) {
								handler(payload);
							}
						});
					};

					transport.on(eventName, wrapped);
					return () => transport.off(eventName, wrapped);
				},
			};
		},

		room(channel: RoomChannelDef<any>) {
			const spec = toChannelSpec(channel);
			if (!spec.is("Room")) {
				throw new Error(`Channel '${channel.name}' is not a room channel`);
			}

			const sendRoomMutation = (
				eventName: string,
				frameFactory: (id: string, payload: any) => any,
				payload: any,
				options?: RequestOptions,
			): Promise<void> => {
				const id = createId();
				const responseEvent = responseEventName(channel.name, id);
				const errorEvent = responseErrorEventName(channel.name, id);
				const timeoutMs = options?.timeoutMs ?? defaultTimeoutMs;

				return new Promise<void>((resolve, reject) => {
					const cleanup = () => {
						clearTimeout(timer);
						transport.off(responseEvent, onResponse);
						transport.off(errorEvent, onError);
					};

					const onResponse: TransportHandler = (raw) => {
						cleanup();
						const frame = parseWireFrame(raw);
						frame.match({
							Response: ({ id: responseId }: any) =>
								responseId === id
									? resolve()
									: reject(makeRequestFailureInvalidResponse("Mismatched response id")),
							_: () => reject(makeRequestFailureInvalidResponse("Expected Response frame")),
						});
					};

					const onError: TransportHandler = (raw) => {
						cleanup();
						const frame = parseWireFrame(raw);
						frame.match({
							ResponseError: ({ id: responseId, error }: any) =>
								responseId === id
									? reject(makeRequestFailureRejected(error))
									: reject(makeRequestFailureInvalidResponse("Mismatched response id")),
							_: () => reject(makeRequestFailureInvalidResponse("Expected ResponseError frame")),
						});
					};

					const timer = setTimeout(() => {
						cleanup();
						reject(makeRequestFailureTimeout(timeoutMs));
					}, timeoutMs);

					transport.on(responseEvent, onResponse);
					transport.on(errorEvent, onError);
					emitRawFrame(transport, eventName, frameFactory(id, payload));
				});
			};

			const handleRoomMutation = (
				eventName: string,
				tag: "RoomJoin" | "RoomLeave",
				handler: any,
			): Unsubscribe => {
				const wrapped: TransportHandler = (raw) => {
					const frame = parseWireFrame(raw);
					frame.if(tag, ({ id, channel: frameChannel, payload }: any) => {
						if (frameChannel !== channel.name) {
							return;
						}

						void Promise.resolve(handler(payload, makeCtx()))
							.then(() => {
								emitRawFrame(transport, responseEventName(channel.name, id), responseFrame(id, undefined));
							})
							.catch((error) => {
								emitRawFrame(transport, responseErrorEventName(channel.name, id), responseErrorFrame(id, error));
							});
					});
				};

				transport.on(eventName, wrapped);
				return () => transport.off(eventName, wrapped);
			};

			return {
				join(payload: any, options?: RequestOptions): Promise<void> {
					installReconnectWatcher();
					const replayKey = makeRoomReplayKey(channel.name, payload);
					return sendRoomMutation(
						roomJoinEventName(channel.name),
						(id, value) => roomJoinFrame(channel, id, value),
						payload,
						options,
					).then(() => {
						roomReplayEntries.set(
							replayKey,
							{
								replay: () =>
									sendRoomMutation(
										roomJoinEventName(channel.name),
										(id, value) => roomJoinFrame(channel, id, value),
										payload,
										options,
									),
								drop: () => {
									roomReplayEntries.delete(replayKey);
								},
							},
						);
					});
				},
				leave(payload: any, options?: RequestOptions): Promise<void> {
					const replayKey = makeRoomReplayKey(channel.name, payload);
					return sendRoomMutation(
						roomLeaveEventName(channel.name),
						(id, value) => roomLeaveFrame(channel, id, value),
						payload,
						options,
					).then(() => {
						roomReplayEntries.delete(replayKey);
					});
				},
				handleJoin(handler: any): Unsubscribe {
					return handleRoomMutation(roomJoinEventName(channel.name), "RoomJoin", handler);
				},
				handleLeave(handler: any): Unsubscribe {
					return handleRoomMutation(roomLeaveEventName(channel.name), "RoomLeave", handler);
				},
			};
		},
	};

	return layer;
}

function defaultCreateId(): string {
	const time = Date.now().toString(36);
	const rand = Math.random().toString(36).slice(2, 10);
	return `${time}_${rand}`;
}

function stableSerialize(value: unknown): string {
	if (value === null || typeof value === "number" || typeof value === "boolean" || typeof value === "string") {
		return JSON.stringify(value);
	}

	if (typeof value === "bigint") {
		return `{"$bigint":${JSON.stringify(value.toString())}}`;
	}

	if (typeof value === "undefined") {
		return '"$undefined"';
	}

	if (typeof value === "function") {
		return `{"$function":${JSON.stringify(value.name || "anonymous")}}`;
	}

	if (typeof value === "symbol") {
		return `{"$symbol":${JSON.stringify(String(value))}}`;
	}

	if (Array.isArray(value)) {
		return `[${value.map((entry) => stableSerialize(entry)).join(",")}]`;
	}

	if (value instanceof Date) {
		return `{"$date":${JSON.stringify(value.toISOString())}}`;
	}

	if (value && typeof value === "object") {
		const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) =>
			left.localeCompare(right),
		);
		return `{${entries
			.map(([key, entryValue]) => `${JSON.stringify(key)}:${stableSerialize(entryValue)}`)
			.join(",")}}`;
	}

	return JSON.stringify(String(value));
}
