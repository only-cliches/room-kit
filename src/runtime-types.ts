import type { ResultVariant } from "iron-enum";

import type {
	EventChannelDef,
	RequestChannelDef,
	RoomChannelDef,
	StreamChannelDef,
	Unsubscribe,
} from "./channel";
import type { ChannelTransport } from "./transport";
import type { RequestFailureVariant, SafeCallResult } from "./protocol";

export interface RequestOptions {
	timeoutMs?: number;
}

export interface ChannelLayerOptions<TContext = unknown> {
	context?: TContext;
	defaultTimeoutMs?: number;
	createId?: () => string;
}

export type SendTargetApi = {
	emit<T>(channel: EventChannelDef<T>, payload: T): void;
	publish<TSub, TPub>(channel: StreamChannelDef<TSub, TPub>, payload: TPub): void;
};

export interface ChannelContext<TContext = unknown> {
	readonly transport: ChannelTransport;
	readonly data: TContext;
	emit<T>(channel: EventChannelDef<T>, payload: T): void;
	publish<TSub, TPub>(channel: StreamChannelDef<TSub, TPub>, payload: TPub): void;
	joinRoom(room: string): Promise<void>;
	leaveRoom(room: string): Promise<void>;
	toRoom(room: string): SendTargetApi;
	broadcast: SendTargetApi;
}

export type ClientEventHandler<TPayload> = (payload: TPayload) => void;
export type ServerEventHandler<TPayload, TContext> =
	(payload: TPayload, ctx: ChannelContext<TContext>) => void | Promise<void>;

export type RequestHandler<TRequest, TResponse, TContext> =
	(payload: TRequest, ctx: ChannelContext<TContext>) => TResponse | Promise<TResponse>;

export type SubscribeHandler<TSubscribe, TContext> =
	(payload: TSubscribe, ctx: ChannelContext<TContext>) => void | Promise<void>;

export type RoomMembershipHandler<TPayload, TContext> =
	(payload: TPayload, ctx: ChannelContext<TContext>) => void | Promise<void>;

export interface ChannelLayer<TContext = unknown> {
	event<TPayload>(channel: EventChannelDef<TPayload>): {
		send(payload: TPayload): void;
		on(handler: ClientEventHandler<TPayload>): Unsubscribe;
		handle(handler: ServerEventHandler<TPayload, TContext>): Unsubscribe;
	};

	request<TRequest, TResponse>(channel: RequestChannelDef<TRequest, TResponse>): {
		call(payload: TRequest, options?: RequestOptions): Promise<TResponse>;
		safeCall(payload: TRequest, options?: RequestOptions): Promise<SafeCallResult<TResponse>>;
		handle(handler: RequestHandler<TRequest, TResponse, TContext>): Unsubscribe;
	};

	stream<TSubscribe, TPublish>(channel: StreamChannelDef<TSubscribe, TPublish>): {
		subscribe(params: TSubscribe, onPublish: (payload: TPublish) => void): Unsubscribe;
		publish(payload: TPublish): void;
		handleSubscribe(handler: SubscribeHandler<TSubscribe, TContext>): Unsubscribe;
		onPublish(handler: ClientEventHandler<TPublish>): Unsubscribe;
	};

	room<TPayload>(channel: RoomChannelDef<TPayload>): {
		join(payload: TPayload, options?: RequestOptions): Promise<void>;
		leave(payload: TPayload, options?: RequestOptions): Promise<void>;
		handleJoin(handler: RoomMembershipHandler<TPayload, TContext>): Unsubscribe;
		handleLeave(handler: RoomMembershipHandler<TPayload, TContext>): Unsubscribe;
	};
}
