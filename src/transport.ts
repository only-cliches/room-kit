import type { AnyChannelDef, EventChannelDef, StreamChannelDef, Unsubscribe } from "./channel";
import {
	emitRawFrame,
	eventEventName,
	publishEventName,
	publishFrame,
	eventFrame,
} from "./protocol";

export type TransportHandler = (payload: unknown) => void;

export type SendTargetApi = {
	emit<T>(channel: EventChannelDef<T>, payload: T): void;
	publish<TSub, TPub>(channel: StreamChannelDef<TSub, TPub>, payload: TPub): void;
};

export interface ChannelTransport {
	emit(eventName: string, payload: unknown): void;
	on(eventName: string, handler: TransportHandler): void;
	off(eventName: string, handler: TransportHandler): void;
	isConnected(): boolean;
	onConnect(handler: () => void): Unsubscribe;
	joinRoom?(room: string): Promise<void> | void;
	leaveRoom?(room: string): Promise<void> | void;
	toRoom(room: string): SendTargetApi;
	broadcast: SendTargetApi;
}

type SocketIoRawEmitter = {
	emit(eventName: string, payload: unknown): void;
};

type SocketIoLike = SocketIoRawEmitter & {
	on(eventName: string, handler: TransportHandler): void;
	off(eventName: string, handler: TransportHandler): void;
	join?(room: string): Promise<void> | void;
	leave?(room: string): Promise<void> | void;
	to?(room: string): SocketIoRawEmitter;
	broadcast?: SocketIoRawEmitter;
};

function createSocketIoSendTarget(target: SocketIoRawEmitter): SendTargetApi {
	return {
		emit<T>(channel: EventChannelDef<T>, payload: T): void {
			emitRawFrame(target, eventEventName(channel.name), eventFrame(channel, payload));
		},
		publish<TSub, TPub>(channel: StreamChannelDef<TSub, TPub>, payload: TPub): void {
			emitRawFrame(target, publishEventName(channel.name), publishFrame(channel, payload));
		},
	};
}

function createSocketIoTransport(socketLike: SocketIoLike): ChannelTransport {
	return {
		emit(eventName: string, payload: unknown): void {
			socketLike.emit(eventName, payload);
		},
		on(eventName: string, handler: TransportHandler): void {
			socketLike.on(eventName, handler);
		},
		off(eventName: string, handler: TransportHandler): void {
			socketLike.off(eventName, handler);
		},
		isConnected(): boolean {
			return Boolean((socketLike as { connected?: boolean }).connected);
		},
		onConnect(handler: () => void): Unsubscribe {
			socketLike.on("connect", handler as never);
			return () => socketLike.off("connect", handler as never);
		},
		joinRoom(room: string): Promise<void> {
			if (typeof socketLike.join !== "function") {
				return Promise.reject(new Error("Room membership is not supported by this transport"));
			}

			return Promise.resolve(socketLike.join(room));
		},
		leaveRoom(room: string): Promise<void> {
			if (typeof socketLike.leave !== "function") {
				return Promise.reject(new Error("Room membership is not supported by this transport"));
			}

			return Promise.resolve(socketLike.leave(room));
		},
		toRoom(room: string): SendTargetApi {
			return createSocketIoSendTarget(socketLike.to ? socketLike.to(room) : socketLike);
		},
		broadcast: createSocketIoSendTarget(socketLike.broadcast ?? socketLike),
	};
}

export function adaptSocketIoTransport(socketLike: SocketIoLike): ChannelTransport {
	return createSocketIoTransport(socketLike);
}

export function adaptInMemoryTransport(): ChannelTransport {
	const listeners = new Map<string, Set<TransportHandler>>();
	const connectListeners = new Set<() => void>();
	const rooms = new Set<string>();

	const emit = (eventName: string, payload: unknown): void => {
		for (const handler of listeners.get(eventName) ?? []) {
			handler(payload);
		}
	};

	const emitIfInRoom = (room: string, eventName: string, payload: unknown): void => {
		if (rooms.has(room)) {
			emit(eventName, payload);
		}
	};

	return {
		emit,
		on(eventName: string, handler: TransportHandler): void {
			const set = listeners.get(eventName) ?? new Set<TransportHandler>();
			set.add(handler);
			listeners.set(eventName, set);
		},
		off(eventName: string, handler: TransportHandler): void {
			listeners.get(eventName)?.delete(handler);
		},
		isConnected(): boolean {
			return false;
		},
		onConnect(handler: () => void): Unsubscribe {
			connectListeners.add(handler);
			return () => connectListeners.delete(handler);
		},
		joinRoom(room: string): Promise<void> {
			rooms.add(room);
			return Promise.resolve();
		},
		leaveRoom(room: string): Promise<void> {
			rooms.delete(room);
			return Promise.resolve();
		},
		toRoom(room: string): SendTargetApi {
			return createSocketIoSendTarget({
				emit(eventName: string, payload: unknown): void {
					emitIfInRoom(room, eventName, payload);
				},
			});
		},
		broadcast: createSocketIoSendTarget({ emit }),
	};
}

export type { AnyChannelDef };
