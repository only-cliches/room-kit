import { IronEnum, type ResultVariant, Err, Ok, IronEnumFactory } from "iron-enum";

import type {
	AnyChannelDef,
	EventChannelDef,
	RequestChannelDef,
	RoomChannelDef,
	StreamChannelDef,
} from "./channel";

type ChannelSpecVariants = {
	Event: { name: string };
	Request: { name: string };
	Stream: { name: string };
	Room: { name: string };
}

const ChannelSpec: IronEnumFactory<ChannelSpecVariants> = IronEnum<ChannelSpecVariants>({ keys: ["Event", "Request", "Stream", "Room"] });

type WireFrameVariants = {
	Event: { channel: string; payload: unknown };
	Request: { id: string; channel: string; payload: unknown };
	Response: { id: string; payload: unknown };
	ResponseError: { id: string; error: unknown };
	Subscribe: { id: string; channel: string; payload: unknown };
	Unsubscribe: { id: string; channel: string };
	Publish: { channel: string; payload: unknown };
	RoomJoin: { id: string; channel: string; payload: unknown };
	RoomLeave: { id: string; channel: string; payload: unknown };
};

const WireFrame: IronEnumFactory<WireFrameVariants> = IronEnum<WireFrameVariants>({
	keys: [
		"Event",
		"Request",
		"Response",
		"ResponseError",
		"Subscribe",
		"Unsubscribe",
		"Publish",
		"RoomJoin",
		"RoomLeave",
	],
});

type RequestFailureVariants = {
	Timeout: { ms: number };
	InvalidResponse: { reason: string };
	Rejected: { error: unknown };
};

export const RequestFailure: IronEnumFactory<RequestFailureVariants> = IronEnum<RequestFailureVariants>({ keys: ["Timeout", "InvalidResponse", "Rejected"] });

export type RequestFailureVariant = typeof RequestFailure._.typeOf;
export type SafeCallResult<T> = ResultVariant<{ Ok: T; Err: RequestFailureVariant }>;

export const SubscriptionState = IronEnum<{
	Idle: undefined;
	Starting: { id: string };
	Active: { id: string; channel: string };
	Stopped: { id: string; channel: string };
	Failed: { id: string; error: unknown };
}>({ keys: ["Idle", "Starting", "Active", "Stopped", "Failed"] });

export type SubscriptionStateVariant = typeof SubscriptionState._.typeOf;

export type WireFrameVariant = any;
export type WireFrameJson = any;

export function toChannelSpec(channel: AnyChannelDef): typeof ChannelSpec._.typeOf {
	switch (channel.kind) {
		case "event":
			return ChannelSpec.Event({ name: channel.name });
		case "request":
			return ChannelSpec.Request({ name: channel.name });
		case "stream":
			return ChannelSpec.Stream({ name: channel.name });
		case "room":
			return ChannelSpec.Room({ name: channel.name });
	}
}

export function eventEventName(name: string): string {
	return `${baseChannelEventName(name)}:event`;
}

export function requestEventName(name: string): string {
	return `${baseChannelEventName(name)}:request`;
}

export function responseEventName(name: string, id: string): string {
	return `${baseChannelEventName(name)}:response:${id}`;
}

export function responseErrorEventName(name: string, id: string): string {
	return `${baseChannelEventName(name)}:response-error:${id}`;
}

export function subscribeEventName(name: string): string {
	return `${baseChannelEventName(name)}:subscribe`;
}

export function unsubscribeEventName(name: string): string {
	return `${baseChannelEventName(name)}:unsubscribe`;
}

export function publishEventName(name: string): string {
	return `${baseChannelEventName(name)}:publish`;
}

export function roomJoinEventName(name: string): string {
	return `${baseChannelEventName(name)}:room-join`;
}

export function roomLeaveEventName(name: string): string {
	return `${baseChannelEventName(name)}:room-leave`;
}

export function eventFrame<TPayload>(channel: EventChannelDef<TPayload>, payload: TPayload): WireFrameVariant {
	return WireFrame.Event({ channel: channel.name, payload }) as WireFrameVariant;
}

export function requestFrame<TRequest>(
	channel: RequestChannelDef<TRequest, unknown>,
	id: string,
	payload: TRequest,
): WireFrameVariant {
	return WireFrame.Request({ id, channel: channel.name, payload }) as WireFrameVariant;
}

export function responseFrame<TResponse>(id: string, payload: TResponse): WireFrameVariant {
	return WireFrame.Response({ id, payload }) as WireFrameVariant;
}

export function responseErrorFrame(id: string, error: unknown): WireFrameVariant {
	return WireFrame.ResponseError({ id, error }) as WireFrameVariant;
}

export function subscribeFrame<TSubscribe>(
	channel: StreamChannelDef<TSubscribe, unknown>,
	id: string,
	payload: TSubscribe,
): WireFrameVariant {
	return WireFrame.Subscribe({ id, channel: channel.name, payload }) as WireFrameVariant;
}

export function unsubscribeFrame(channel: StreamChannelDef<any, any>, id: string): WireFrameVariant {
	return WireFrame.Unsubscribe({ id, channel: channel.name }) as WireFrameVariant;
}

export function publishFrame<TPublish>(
	channel: StreamChannelDef<any, TPublish>,
	payload: TPublish,
): WireFrameVariant {
	return WireFrame.Publish({ channel: channel.name, payload }) as WireFrameVariant;
}

export function roomJoinFrame<TPayload>(
	channel: RoomChannelDef<TPayload>,
	id: string,
	payload: TPayload,
): WireFrameVariant {
	return WireFrame.RoomJoin({ id, channel: channel.name, payload }) as WireFrameVariant;
}

export function roomLeaveFrame<TPayload>(
	channel: RoomChannelDef<TPayload>,
	id: string,
	payload: TPayload,
): WireFrameVariant {
	return WireFrame.RoomLeave({ id, channel: channel.name, payload }) as WireFrameVariant;
}

export function emitRawFrame(
	transport: { emit(eventName: string, payload: unknown): void },
	eventName: string,
	frame: WireFrameVariant,
): void {
	transport.emit(eventName, frame.toJSON());
}

export function parseWireFrame(raw: unknown): WireFrameVariant {
	if (!isWireFrameShape(raw)) {
		return WireFrame.ResponseError({
			id: "unknown",
			error: new Error("Invalid wire frame shape"),
		});
	}

	try {
		return WireFrame._.parse(raw as WireFrameJson) as WireFrameVariant;
	} catch (error) {
		return WireFrame.ResponseError({
			id: "unknown",
			error: error instanceof Error ? error : new Error(String(error)),
		}) as WireFrameVariant;
	}
}

export function makeRequestFailureTimeout(ms: number): RequestFailureVariant {
	return RequestFailure.Timeout({ ms });
}

export function makeRequestFailureInvalidResponse(reason: string): RequestFailureVariant {
	return RequestFailure.InvalidResponse({ reason });
}

export function makeRequestFailureRejected(error: unknown): RequestFailureVariant {
	return RequestFailure.Rejected({ error });
}

function baseChannelEventName(name: string): string {
	return `channel:${name}`;
}

function isWireFrameShape(raw: unknown): raw is WireFrameJson {
	if (!raw || typeof raw !== "object") {
		return false;
	}

	const value = raw as { tag?: unknown };
	return typeof value.tag === "string";
}
