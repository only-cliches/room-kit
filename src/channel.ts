export type Unsubscribe = () => void;

export type ChannelMap = Record<string, AnyChannelDef>;

export type EventPayload<C> = C extends EventChannelDef<infer T> ? T : never;
export type RequestPayload<C> = C extends RequestChannelDef<infer TReq, any> ? TReq : never;
export type ResponsePayload<C> = C extends RequestChannelDef<any, infer TRes> ? TRes : never;
export type SubscribePayload<C> = C extends StreamChannelDef<infer TSub, any> ? TSub : never;
export type PublishPayload<C> = C extends StreamChannelDef<any, infer TPub> ? TPub : never;
export type RoomPayload<C> = C extends RoomChannelDef<infer T> ? T : never;

export type EventChannelDef<TPayload> = {
    readonly kind: "event";
    readonly name: string;
    readonly __payload?: TPayload;
};

export type RequestChannelDef<TRequest, TResponse> = {
    readonly kind: "request";
    readonly name: string;
    readonly __request?: TRequest;
    readonly __response?: TResponse;
};

export type StreamChannelDef<TSubscribe, TPublish> = {
    readonly kind: "stream";
    readonly name: string;
    readonly __subscribe?: TSubscribe;
    readonly __publish?: TPublish;
};

export type RoomChannelDef<TPayload> = {
    readonly kind: "room";
    readonly name: string;
    readonly __payload?: TPayload;
};

export type AnyChannelDef =
    | EventChannelDef<any>
    | RequestChannelDef<any, any>
    | StreamChannelDef<any, any>
    | RoomChannelDef<any>;

export type ChannelBuilder<Name extends string> = {
    readonly name: Name;
    event<TPayload>(): EventChannelDef<TPayload>;
    request<TRequest>(): RequestResponseBuilder<Name, TRequest>;
    subscribe<TSubscribe>(): StreamPublishBuilder<Name, TSubscribe>;
    room<TPayload>(): RoomChannelDef<TPayload>;
};

export type RequestResponseBuilder<Name extends string, TRequest> = {
    readonly name: Name;
    response<TResponse>(): RequestChannelDef<TRequest, TResponse>;
};

export type StreamPublishBuilder<Name extends string, TSubscribe> = {
    readonly name: Name;
    publish<TPublish>(): StreamChannelDef<TSubscribe, TPublish>;
};

export function channel<const Name extends string>(name: Name): ChannelBuilder<Name> {
    return {
        name,
        event<TPayload>(): EventChannelDef<TPayload> {
            return {
                kind: "event",
                name,
            } as EventChannelDef<TPayload>;
        },
        request<TRequest>(): RequestResponseBuilder<Name, TRequest> {
            return {
                name,
                response<TResponse>(): RequestChannelDef<TRequest, TResponse> {
                    return {
                        kind: "request",
                        name,
                    } as RequestChannelDef<TRequest, TResponse>;
                },
            };
        },
        subscribe<TSubscribe>(): StreamPublishBuilder<Name, TSubscribe> {
            return {
                name,
                publish<TPublish>(): StreamChannelDef<TSubscribe, TPublish> {
                    return {
                        kind: "stream",
                        name,
                    } as StreamChannelDef<TSubscribe, TPublish>;
                },
            };
        },
        room<TPayload>(): RoomChannelDef<TPayload> {
            return {
                kind: "room",
                name,
            } as RoomChannelDef<TPayload>;
        },
    };
}
