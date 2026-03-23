import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

import { adaptInMemoryTransport, channel, type EventChannelDef, type StreamChannelDef } from "../src/index";
import {
	createSocketChannels,
	eventEventName,
	eventFrame,
	publishEventName,
	publishFrame,
	requestEventName,
	requestFrame,
	responseErrorFrame,
	responseErrorEventName,
	responseEventName,
	responseFrame,
	subscribeEventName,
	unsubscribeEventName,
} from "../src/index";
import type { ChannelTransport, SendTargetApi, TransportHandler } from "../src/transport";

class MockTransport implements ChannelTransport {
	emitted: Array<{ eventName: string; payload: unknown }> = [];
	joinedRooms: string[] = [];
	leftRooms: string[] = [];
	joinRoomImpl?: (room: string) => Promise<void> | void;
	leaveRoomImpl?: (room: string) => Promise<void> | void;
	private listeners = new Map<string, Set<TransportHandler>>();
	private connectListeners = new Set<() => void>();
	connected = true;

	emit(eventName: string, payload: unknown): void {
		this.emitted.push({ eventName, payload });
	}

	on(eventName: string, handler: TransportHandler): void {
		const handlers = this.listeners.get(eventName) ?? new Set<TransportHandler>();
		handlers.add(handler);
		this.listeners.set(eventName, handlers);
	}

	off(eventName: string, handler: TransportHandler): void {
		this.listeners.get(eventName)?.delete(handler);
	}

	isConnected(): boolean {
		return this.connected;
	}

	onConnect(handler: () => void): () => void {
		this.connectListeners.add(handler);
		return () => this.connectListeners.delete(handler);
	}

	joinRoom(room: string): Promise<void> {
		if (this.joinRoomImpl) {
			return Promise.resolve(this.joinRoomImpl(room));
		}
		this.joinedRooms.push(room);
		return Promise.resolve();
	}

	leaveRoom(room: string): Promise<void> {
		if (this.leaveRoomImpl) {
			return Promise.resolve(this.leaveRoomImpl(room));
		}
		this.leftRooms.push(room);
		return Promise.resolve();
	}

	toRoom(): SendTargetApi {
		return createMockSendTarget(this);
	}

	broadcast: SendTargetApi = createMockSendTarget(this);

	trigger(eventName: string, payload: unknown): void {
		for (const handler of this.listeners.get(eventName) ?? []) {
			handler(payload);
		}
	}

	triggerConnect(): void {
		for (const handler of this.connectListeners) {
			handler();
		}
	}
}

function createMockSendTarget(transport: MockTransport): SendTargetApi {
	return {
		emit<T>(channelDef: EventChannelDef<T>, payload: T): void {
			transport.emit(eventEventName(channelDef.name), eventFrame(channelDef, payload).toJSON());
		},
		publish<TSub, TPub>(channelDef: StreamChannelDef<TSub, TPub>, payload: TPub): void {
			transport.emit(publishEventName(channelDef.name), publishFrame(channelDef, payload).toJSON());
		},
	};
}

describe("createSocketChannels", () => {
	let transport: MockTransport;

	beforeEach(() => {
		transport = new MockTransport();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("sends and receives event payloads", () => {
		const typing = channel("chat.typing").event<{ roomId: string; userId: string }>();
		const api = createSocketChannels(transport, {
			createId: () => "room-ctx",
		});
		const seen: Array<{ roomId: string; userId: string }> = [];

		const stop = api.event(typing).on((payload) => seen.push(payload));

		api.event(typing).send({ roomId: "r1", userId: "u1" });

		expect(transport.emitted).toHaveLength(1);
		expect(transport.emitted[0]).toEqual({
			eventName: eventEventName(typing.name),
			payload: {
				tag: "Event",
				data: {
					channel: typing.name,
					payload: { roomId: "r1", userId: "u1" },
				},
			},
		});

		transport.trigger(eventEventName(typing.name), transport.emitted[0].payload);
		expect(seen).toEqual([{ roomId: "r1", userId: "u1" }]);

		stop();
		transport.trigger(eventEventName(typing.name), transport.emitted[0].payload);
		expect(seen).toHaveLength(1);
	});

	it("handles requests, invalid frames, and explicit errors", async () => {
		const rpc = channel("chat.send")
			.request<{ text: string }>()
			.response<{ messageId: string }>();

		const api = createSocketChannels(transport, {
			createId: () => "req-1",
			defaultTimeoutMs: 50,
		});

		const safeCall = api.request(rpc).safeCall({ text: "hello" });
		expect(transport.emitted[0]).toEqual({
			eventName: requestEventName(rpc.name),
			payload: {
				tag: "Request",
				data: {
					id: "req-1",
					channel: rpc.name,
					payload: { text: "hello" },
				},
			},
		});

		transport.trigger(
			responseEventName(rpc.name, "req-1"),
			responseFrame("req-1", { messageId: "m1" }).toJSON(),
		);

		await expect(safeCall).resolves.toMatchObject({
			tag: "Ok",
			data: { messageId: "m1" },
		});

		const call = api.request(rpc).call({ text: "again" });
		expect(transport.emitted[1]).toMatchObject({
			eventName: requestEventName(rpc.name),
		});
		transport.trigger(responseEventName(rpc.name, "req-1"), { tag: "not-a-frame" });
		await expect(call).rejects.toMatchObject({
			tag: "InvalidResponse",
			data: { reason: "Expected Response frame" },
		});

		const rejectedApi = createSocketChannels(transport, {
			createId: () => "req-3",
			defaultTimeoutMs: 50,
		});
		const rejectedCall = rejectedApi.request(rpc).call({ text: "reject me" });
		transport.trigger(
			responseErrorEventName(rpc.name, "req-3"),
			{
				tag: "ResponseError",
				data: {
					id: "req-3",
					error: { reason: "nope" },
				},
			},
		);

		await expect(rejectedCall).rejects.toMatchObject({
			tag: "Rejected",
			data: {
				error: { reason: "nope" },
			},
		});

		const failingRpc = channel("chat.fail")
			.request<{ text: string }>()
			.response<{ ok: boolean }>();
		const handlerApi = createSocketChannels(transport, { createId: () => "req-2" });
		handlerApi.request(failingRpc).handle(async () => {
			throw new Error("boom");
		});

		transport.trigger(
			requestEventName(failingRpc.name),
			{
				tag: "Request",
				data: {
					id: "req-2",
					channel: failingRpc.name,
					payload: { text: "x" },
				},
			},
		);

		await new Promise<void>((resolve) => setTimeout(resolve, 0));

		expect(transport.emitted[transport.emitted.length - 1]?.eventName).toBe(
			`channel:${failingRpc.name}:response-error:req-2`,
		);
	});

	it("times out safe calls", async () => {
		vi.useFakeTimers();

		const rpc = channel("chat.timeout")
			.request<{ text: string }>()
			.response<{ ok: boolean }>();

		const api = createSocketChannels(transport, {
			createId: () => "req-timeout",
			defaultTimeoutMs: 5,
		});

		const safeCall = api.request(rpc).safeCall({ text: "hello" }, { timeoutMs: 5 });
		await vi.advanceTimersByTimeAsync(5);

		const result = await safeCall;
		expect(result).toMatchObject({
			tag: "Err",
			data: {
				tag: "Timeout",
				data: { ms: 5 },
			},
		});
	});

	it("handles stream subscriptions and unsubscribe cleanup", () => {
		const feed = channel("chat.feed")
			.subscribe<{ roomId: string }>()
			.publish<{ text: string }>();

		const api = createSocketChannels(transport, {
			createId: () => "sub-1",
		});

		const received: Array<{ text: string }> = [];
		const stop = api.stream(feed).subscribe({ roomId: "r1" }, (payload) => received.push(payload));

		expect(transport.emitted[0]).toEqual({
			eventName: subscribeEventName(feed.name),
			payload: {
				tag: "Subscribe",
				data: {
					id: "sub-1",
					channel: feed.name,
					payload: { roomId: "r1" },
				},
			},
		});

		transport.trigger(
			publishEventName(feed.name),
			publishFrame(feed, { text: "first" }).toJSON(),
		);
		expect(received).toEqual([{ text: "first" }]);

		stop();
		expect(transport.emitted.at(-1)?.eventName).toBe(unsubscribeEventName(feed.name));

		transport.trigger(
			publishEventName(feed.name),
			publishFrame(feed, { text: "second" }).toJSON(),
		);
		expect(received).toEqual([{ text: "first" }]);
	});

	it("replays active stream subscriptions after reconnect", () => {
		const feed = channel("chat.reconnect")
			.subscribe<{ roomId: string }>()
			.publish<{ text: string }>();

		const api = createSocketChannels(transport, {
			createId: () => "sub-reconnect",
		});

		api.stream(feed).subscribe({ roomId: "r1" }, () => undefined);
		expect(transport.emitted).toHaveLength(1);

		transport.triggerConnect();

		expect(transport.emitted).toHaveLength(2);
		expect(transport.emitted[1]).toEqual(transport.emitted[0]);
	});

	it("does not replay unsubscribed stream subscriptions after reconnect", () => {
		const feed = channel("chat.unsubReconnect")
			.subscribe<{ roomId: string }>()
			.publish<{ text: string }>();

		const api = createSocketChannels(transport, {
			createId: () => "sub-unsub",
		});

		const stop = api.stream(feed).subscribe({ roomId: "r1" }, () => undefined);
		expect(transport.emitted).toHaveLength(1);

		stop();
		expect(transport.emitted).toHaveLength(2);

		transport.triggerConnect();

		expect(transport.emitted).toHaveLength(2);
	});

	it("does not replay stopped subscriptions under churn", () => {
		const feed = channel("chat.churn")
			.subscribe<{ roomId: string }>()
			.publish<{ text: string }>();

		let nextId = 0;
		const api = createSocketChannels(transport, {
			createId: () => `sub-${nextId++}`,
		});

		for (let i = 0; i < 100; i += 1) {
			const stop = api.stream(feed).subscribe({ roomId: "r1" }, () => undefined);
			stop();
		}

		expect(transport.emitted).toHaveLength(200);
		transport.triggerConnect();
		expect(transport.emitted).toHaveLength(200);
	});

	it("replays active stream subscriptions on each reconnect", () => {
		const feed = channel("chat.multiReconnect")
			.subscribe<{ roomId: string }>()
			.publish<{ text: string }>();

		const api = createSocketChannels(transport, {
			createId: () => "sub-multi",
		});

		api.stream(feed).subscribe({ roomId: "r1" }, () => undefined);
		expect(transport.emitted).toHaveLength(1);

		transport.triggerConnect();
		expect(transport.emitted).toHaveLength(2);
		expect(transport.emitted[1]).toEqual(transport.emitted[0]);

		transport.triggerConnect();
		expect(transport.emitted).toHaveLength(3);
		expect(transport.emitted[2]).toEqual(transport.emitted[0]);
	});

	it("replays active room memberships after reconnect", async () => {
		const roomControl = channel("chat.roomReplay").room<{ roomId: string }>();

		const api = createSocketChannels(transport, {
			createId: () => "room-replay",
		});

		api.room(roomControl).handleJoin(async (payload, ctx) => {
			await ctx.joinRoom(payload.roomId);
		});

		const joinPromise = api.room(roomControl).join({ roomId: "alpha" });
		transport.trigger(
			"channel:chat.roomReplay:room-join",
			transport.emitted[0].payload,
		);

		await new Promise<void>((resolve) => setTimeout(resolve, 0));

		transport.trigger(
			"channel:chat.roomReplay:response:room-replay",
			transport.emitted[1].payload,
		);

		await joinPromise;
		expect(transport.joinedRooms).toEqual(["alpha"]);

		transport.triggerConnect();
		expect(transport.joinedRooms).toEqual(["alpha", "alpha"]);

		api.room(roomControl).handleLeave(async (payload, ctx) => {
			await ctx.leaveRoom(payload.roomId);
		});

		const leavePromise = api.room(roomControl).leave({ roomId: "alpha" });
		const leaveRequest = transport.emitted.at(-1);
		transport.trigger(
			"channel:chat.roomReplay:room-leave",
			leaveRequest?.payload,
		);

		await new Promise<void>((resolve) => setTimeout(resolve, 0));

		const leaveResponse = transport.emitted.at(-1);
		transport.trigger(
			"channel:chat.roomReplay:response:room-replay",
			leaveResponse?.payload,
		);

		await leavePromise;
		expect(transport.leftRooms).toEqual(["alpha"]);

		transport.triggerConnect();
		expect(transport.joinedRooms).toEqual(["alpha", "alpha"]);
	});

	it("drops client-side room replay state after replay rejection", async () => {
		const roomControl = channel("chat.roomReplayReject").room<{ roomId: string }>();
		const api = createSocketChannels(transport, {
			createId: () => "room-replay-reject",
			defaultTimeoutMs: 100,
		});

		api.room(roomControl).handleJoin(async (payload, ctx) => {
			if (transport.joinedRooms.length > 0) {
				throw new Error(`rejected:${payload.roomId}`);
			}
			await ctx.joinRoom(payload.roomId);
		});

		const joinPromise = api.room(roomControl).join({ roomId: "alpha" });
		transport.trigger(
			"channel:chat.roomReplayReject:room-join",
			transport.emitted[0].payload,
		);
		await new Promise<void>((resolve) => setTimeout(resolve, 0));
		transport.trigger(
			"channel:chat.roomReplayReject:response:room-replay-reject",
			transport.emitted[1].payload,
		);
		await joinPromise;

		expect(transport.joinedRooms).toEqual(["alpha"]);

		transport.triggerConnect();
		await new Promise<void>((resolve) => setTimeout(resolve, 0));

		const replayRequest = transport.emitted.at(-1);
		expect(replayRequest?.eventName).toBe("channel:chat.roomReplayReject:room-join");
		transport.trigger("channel:chat.roomReplayReject:room-join", replayRequest?.payload);
		await new Promise<void>((resolve) => setTimeout(resolve, 0));
		const replayError = transport.emitted.at(-1);
		expect(replayError?.eventName).toBe("channel:chat.roomReplayReject:response-error:room-replay-reject");
		transport.trigger("channel:chat.roomReplayReject:response-error:room-replay-reject", replayError?.payload);
		await new Promise<void>((resolve) => setTimeout(resolve, 0));

		const emittedAfterRejectedReplay = transport.emitted.length;
		transport.triggerConnect();
		await new Promise<void>((resolve) => setTimeout(resolve, 0));
		expect(transport.emitted).toHaveLength(emittedAfterRejectedReplay);
	});

	it("suppresses unhandled rejections when room replay fails", async () => {
		const roomControl = channel("chat.roomReplayFailure").room<{ roomId: string }>();
		const api = createSocketChannels(transport, {
			createId: () => "room-replay-failure",
		});

		let joinCalls = 0;
		transport.joinRoomImpl = async (room) => {
			joinCalls += 1;
			if (joinCalls === 1) {
				transport.joinedRooms.push(room);
				return;
			}

			throw new Error("replay failed");
		};

		const unhandled: unknown[] = [];
		const onUnhandled = (reason: unknown) => {
			unhandled.push(reason);
		};
		process.on("unhandledRejection", onUnhandled);

		try {
			api.room(roomControl).handleJoin(async (payload, ctx) => {
				await ctx.joinRoom(payload.roomId);
			});

			const joinPromise = api.room(roomControl).join({ roomId: "alpha" });
			transport.trigger(
				"channel:chat.roomReplayFailure:room-join",
				transport.emitted[0].payload,
			);

			await new Promise<void>((resolve) => setTimeout(resolve, 0));

			transport.trigger(
				"channel:chat.roomReplayFailure:response:room-replay-failure",
				transport.emitted[1].payload,
			);
			await joinPromise;

			transport.triggerConnect();
			await new Promise<void>((resolve) => setTimeout(resolve, 0));
		} finally {
			process.off("unhandledRejection", onUnhandled);
		}

		expect(unhandled).toEqual([]);
	});

	it("exposes room membership to handler contexts", async () => {
		const roomControl = channel("chat.roomControl").room<{
			action: "join" | "leave";
			roomId: string;
		}>();

		const api = createSocketChannels(transport, {
			createId: () => "room-ctx",
		});

		api.room(roomControl).handleJoin(async (payload, ctx) => {
			expect(payload).toEqual({ action: "join", roomId: "alpha" });
			await ctx.joinRoom(payload.roomId);
		});

		const joinPromise = api.room(roomControl).join({ action: "join", roomId: "alpha" });
		transport.trigger(
			"channel:chat.roomControl:room-join",
			transport.emitted[0].payload,
		);

		await new Promise<void>((resolve) => setTimeout(resolve, 0));

		transport.trigger(
			"channel:chat.roomControl:response:room-ctx",
			transport.emitted[1].payload,
		);

		await joinPromise;

		expect(transport.joinedRooms).toEqual(["alpha"]);

		api.room(roomControl).handleLeave(async (payload, ctx) => {
			expect(payload).toEqual({ action: "leave", roomId: "alpha" });
			await ctx.leaveRoom(payload.roomId);
		});

		const leavePromise = api.room(roomControl).leave({ action: "leave", roomId: "alpha" });
		transport.trigger(
			"channel:chat.roomControl:room-leave",
			transport.emitted[2].payload,
		);

		await new Promise<void>((resolve) => setTimeout(resolve, 0));

		transport.trigger(
			"channel:chat.roomControl:response:room-ctx",
			transport.emitted[3].payload,
		);

		await leavePromise;

		expect(transport.leftRooms).toEqual(["alpha"]);
	});

	it("times out room membership joins without a server response", async () => {
		vi.useFakeTimers();

		const roomControl = channel("chat.roomTimeout").room<{ roomId: string }>();
		const api = createSocketChannels(transport, {
			createId: () => "room-timeout",
			defaultTimeoutMs: 5,
		});

		const joinPromise = api.room(roomControl).join({ roomId: "alpha" }, { timeoutMs: 5 });
		const assertion = expect(joinPromise).rejects.toMatchObject({
			tag: "Timeout",
			data: { ms: 5 },
		});
		await vi.advanceTimersByTimeAsync(5);

		await assertion;
	});

	it("propagates room membership handler failures", async () => {
		const roomControl = channel("chat.roomReject").room<{ roomId: string }>();
		const api = createSocketChannels(transport, {
			createId: () => "room-reject",
		});

		api.room(roomControl).handleJoin(async () => {
			throw new Error("room denied");
		});

		const joinPromise = api.room(roomControl).join({ roomId: "alpha" });
		transport.trigger(
			"channel:chat.roomReject:room-join",
			transport.emitted[0].payload,
		);

		await new Promise<void>((resolve) => setTimeout(resolve, 0));

		transport.trigger(
			"channel:chat.roomReject:response-error:room-reject",
			transport.emitted[1].payload,
		);

		await expect(joinPromise).rejects.toMatchObject({
			tag: "Rejected",
		});
	});

	it("rejects room membership operations on transports without room APIs", async () => {
		const emitted: Array<{ eventName: string; payload: unknown }> = [];
		const listeners = new Map<string, Set<TransportHandler>>();
		const transport = {
			emit(eventName: string, payload: unknown): void {
				emitted.push({ eventName, payload });
			},
			on(eventName: string, handler: TransportHandler): void {
				const set = listeners.get(eventName) ?? new Set<TransportHandler>();
				set.add(handler);
				listeners.set(eventName, set);
			},
			off(eventName: string, handler: TransportHandler): void {
				listeners.get(eventName)?.delete(handler);
			},
			isConnected(): boolean {
				return true;
			},
			onConnect(): () => void {
				return () => undefined;
			},
			toRoom(): SendTargetApi {
				return createMockSendTarget(new MockTransport());
			},
			broadcast: createMockSendTarget(new MockTransport()),
			trigger(eventName: string, payload: unknown): void {
				for (const handler of listeners.get(eventName) ?? []) {
					handler(payload);
				}
			},
		} as ChannelTransport;

		const roomControl = channel("chat.roomUnsupported")
			.request<{ roomId: string }>()
			.response<{ ok: true }>();
		const api = createSocketChannels(transport);

		let membershipAttempt: Promise<void> | undefined;
		api.request(roomControl).handle(async (_payload, ctx) => {
			membershipAttempt = ctx.joinRoom("alpha");
			await membershipAttempt;
			return { ok: true };
		});

		(transport as unknown as { trigger(eventName: string, payload: unknown): void }).trigger(
			requestEventName(roomControl.name),
			requestFrame(roomControl, "room-ctx", { roomId: "alpha" }).toJSON(),
		);

		await expect(membershipAttempt).rejects.toThrow(
			"Room membership is not supported by this transport",
		);

		let leaveAttempt: Promise<void> | undefined;
		api.request(roomControl).handle(async (_payload, ctx) => {
			leaveAttempt = ctx.leaveRoom("beta");
			await leaveAttempt;
			return { ok: true };
		});

		(transport as unknown as { trigger(eventName: string, payload: unknown): void }).trigger(
			requestEventName(roomControl.name),
			requestFrame(roomControl, "room-ctx-2", { roomId: "beta" }).toJSON(),
		);

		await expect(leaveAttempt).rejects.toThrow(
			"Room membership is not supported by this transport",
		);
	});

	it("rejects invalid room response frames", async () => {
		const roomControl = channel("chat.roomInvalid").room<{ roomId: string }>();
		const api = createSocketChannels(transport, {
			createId: () => "room-invalid",
		});

		const joinPromise = api.room(roomControl).join({ roomId: "alpha" });
		transport.trigger(
			"channel:chat.roomInvalid:response:room-invalid",
			{
				tag: "Event",
				data: {
					channel: roomControl.name,
					payload: { roomId: "alpha" },
				},
			},
		);

		await expect(joinPromise).rejects.toMatchObject({
			tag: "InvalidResponse",
			data: { reason: "Expected Response frame" },
		});

		const leaveApi = createSocketChannels(transport, {
			createId: () => "room-invalid-2",
		});
		const leavePromise = leaveApi.room(roomControl).leave({ roomId: "alpha" });
		transport.trigger(
			"channel:chat.roomInvalid:response:room-invalid-2",
			{
				tag: "Publish",
				data: {
					channel: roomControl.name,
					payload: { roomId: "alpha" },
				},
			},
		);

		await expect(leavePromise).rejects.toMatchObject({
			tag: "InvalidResponse",
			data: { reason: "Expected Response frame" },
		});
	});

	it("rejects mismatched response ids for requests and room mutations", async () => {
		const rpc = channel("chat.mismatch")
			.request<{ text: string }>()
			.response<{ ok: boolean }>();
		const requestApi = createSocketChannels(transport, {
			createId: () => "req-mismatch",
			defaultTimeoutMs: 100,
		});

		const badResponse = requestApi.request(rpc).safeCall({ text: "hi" });
		transport.trigger(
			responseEventName(rpc.name, "req-mismatch"),
			responseFrame("req-someone-else", { ok: true }).toJSON(),
		);
		await expect(badResponse).resolves.toMatchObject({
			tag: "Err",
			data: { tag: "InvalidResponse", data: { reason: "Mismatched response id" } },
		});

		const badErrorResponse = requestApi.request(rpc).safeCall({ text: "hi again" });
		transport.trigger(
			responseErrorEventName(rpc.name, "req-mismatch"),
			responseErrorFrame("req-someone-else", { reason: "nope" }).toJSON(),
		);
		await expect(badErrorResponse).resolves.toMatchObject({
			tag: "Err",
			data: { tag: "InvalidResponse", data: { reason: "Mismatched response id" } },
		});

		const roomControl = channel("chat.roomMismatch").room<{ roomId: string }>();
		const roomApi = createSocketChannels(transport, {
			createId: () => "room-mismatch",
			defaultTimeoutMs: 100,
		});
		const joinPromise = roomApi.room(roomControl).join({ roomId: "alpha" });
		transport.trigger(
			"channel:chat.roomMismatch:response:room-mismatch",
			responseFrame("room-other", undefined).toJSON(),
		);
		await expect(joinPromise).rejects.toMatchObject({
			tag: "InvalidResponse",
			data: { reason: "Mismatched response id" },
		});

		const leaveApi = createSocketChannels(transport, {
			createId: () => "room-mismatch-2",
			defaultTimeoutMs: 100,
		});
		const leavePromise = leaveApi.room(roomControl).leave({ roomId: "alpha" });
		transport.trigger(
			"channel:chat.roomMismatch:response-error:room-mismatch-2",
			responseErrorFrame("room-other", { reason: "not yours" }).toJSON(),
		);
		await expect(leavePromise).rejects.toMatchObject({
			tag: "InvalidResponse",
			data: { reason: "Mismatched response id" },
		});
	});

	it("normalizes room replay keys across equivalent payload shapes", async () => {
		const roomControl = channel("chat.roomNormalize").room<{
			roomId: string;
			meta: { scope: string; priority: number };
		}>();
		const api = createSocketChannels(transport, {
			createId: () => "room-normalize",
		});

		api.room(roomControl).handleJoin(async (payload, ctx) => {
			await ctx.joinRoom(payload.roomId);
		});
		api.room(roomControl).handleLeave(async (payload, ctx) => {
			await ctx.leaveRoom(payload.roomId);
		});

		const joinPayload = {
			roomId: "alpha",
			meta: { scope: "chat", priority: 1 },
		};
		const leavePayload = {
			meta: { priority: 1, scope: "chat" },
			roomId: "alpha",
		};

		const joinPromise = api.room(roomControl).join(joinPayload);
		transport.trigger("channel:chat.roomNormalize:room-join", transport.emitted[0].payload);
		await new Promise<void>((resolve) => setTimeout(resolve, 0));
		transport.trigger("channel:chat.roomNormalize:response:room-normalize", transport.emitted[1].payload);
		await joinPromise;

		const leavePromise = api.room(roomControl).leave(leavePayload);
		const leaveRequest = transport.emitted.at(-1);
		transport.trigger("channel:chat.roomNormalize:room-leave", leaveRequest?.payload);
		await new Promise<void>((resolve) => setTimeout(resolve, 0));
		const leaveResponse = transport.emitted.at(-1);
		transport.trigger("channel:chat.roomNormalize:response:room-normalize", leaveResponse?.payload);
		await leavePromise;

		const emittedBeforeReconnect = transport.emitted.length;
		transport.triggerConnect();
		await new Promise<void>((resolve) => setTimeout(resolve, 0));
		expect(transport.emitted).toHaveLength(emittedBeforeReconnect);
	});

	it("scopes in-memory room sends to joined members only", async () => {
		const transport = adaptInMemoryTransport();
		const api = createSocketChannels(transport);
		const notify = channel("chat.inMemoryNotify").event<{ text: string }>();
		const roomControl = channel("chat.inMemoryRoom")
			.request<{ roomId: string }>()
			.response<{ ok: true }>();
		const seen: string[] = [];

		api.event(notify).on((payload) => {
			seen.push(payload.text);
		});

		api.request(roomControl).handle(async (payload, ctx) => {
			ctx.toRoom(payload.roomId).emit(notify, { text: "before-join" });
			await ctx.joinRoom(payload.roomId);
			ctx.toRoom(payload.roomId).emit(notify, { text: "after-join" });
			await ctx.leaveRoom(payload.roomId);
			ctx.toRoom(payload.roomId).emit(notify, { text: "after-leave" });
			return { ok: true };
		});

		await expect(api.request(roomControl).call({ roomId: "alpha" })).resolves.toEqual({ ok: true });
		expect(seen).toEqual(["after-join"]);
	});
});
