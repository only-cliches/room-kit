/**
 * Controls which presence operations are available for a room type.
 *
 * - `"none"`: no presence APIs
 * - `"count"`: count only
 * - `"list"`: count + paginated member listings
 */
export type PresencePolicy = "none" | "count" | "list";

/**
 * Transport-level connection state exposed by `RoomClient.connection`.
 */
export type ClientConnectionState = "connecting" | "connected" | "reconnecting" | "disconnected";

/**
 * Marks an error message as safe to send to clients.
 *
 * Any non-`ClientSafeError` thrown by handlers is sanitized to a generic
 * internal error message by the server runtime.
 *
 * @example
 * ```ts
 * import { ClientSafeError } from "room-kit";
 *
 * throw new ClientSafeError("Invalid room key");
 * ```
 */
export class ClientSafeError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "ClientSafeError";
        Object.setPrototypeOf(this, new.target.prototype);
    }
}

/**
 * Pagination options for presence list queries.
 */
export type PresenceListQuery = {
    offset?: number;
    limit?: number;
};

/**
 * Type-only schema used by `defineRoomType`.
 *
 * `joinRequest.roomId` and `roomProfile.roomId` are required for room
 * separation and runtime consistency checks.
 */
export type RoomSchema = {
    joinRequest: {
        roomId: string;
        [key: string]: unknown;
    };
    memberProfile?: object;
    roomProfile: {
        roomId: string;
        [key: string]: unknown;
    };
    serverState?: object;
    events?: Record<string, unknown>;
    rpc?: Record<string, (...args: any[]) => any>;
};

/**
 * Runtime room type definition returned by `defineRoomType`.
 */
export type RoomDefinition<TSchema extends RoomSchema, TPresence extends PresencePolicy = PresencePolicy> = {
    readonly kind: "room";
    readonly name: string;
    readonly presence: TPresence;
    readonly __schema?: TSchema;
};

/**
 * Extracts the `joinRequest` payload type for a room definition.
 */
export type JoinRequest<TRoom extends RoomDefinition<any>> =
    TRoom extends RoomDefinition<infer TSchema>
        ? TSchema extends { joinRequest: infer TJoin }
            ? TJoin
            : Record<string, never>
        : never;

/**
 * Extracts the `memberProfile` type for a room definition.
 */
export type MemberProfileFor<TRoom extends RoomDefinition<any>> =
    TRoom extends RoomDefinition<infer TSchema>
        ? TSchema extends { memberProfile: infer TMember }
            ? TMember
            : Record<string, never>
        : never;

/**
 * Extracts the `roomProfile` type for a room definition.
 */
export type RoomProfileFor<TRoom extends RoomDefinition<any>> =
    TRoom extends RoomDefinition<infer TSchema>
        ? TSchema extends { roomProfile: infer TProps }
            ? TProps
            : Record<string, never>
        : never;

/**
 * Extracts the room event payload map.
 */
export type RoomEvents<TRoom extends RoomDefinition<any>> =
    TRoom extends RoomDefinition<infer TSchema>
        ? TSchema extends { events: infer TEvents }
            ? TEvents extends Record<string, unknown>
                ? TEvents
                : Record<string, never>
            : Record<string, never>
        : never;

/**
 * Extracts the room private server-state type.
 */
export type ServerStateFor<TRoom extends RoomDefinition<any>> =
    TRoom extends RoomDefinition<infer TSchema>
        ? TSchema extends { serverState: infer TState }
            ? TState
            : Record<string, never>
        : never;

/**
 * Extracts the room RPC handler contract.
 */
export type RoomRpc<TRoom extends RoomDefinition<any>> =
    TRoom extends RoomDefinition<infer TSchema>
        ? TSchema extends { rpc: infer TRpc }
            ? TRpc extends Record<string, (...args: any[]) => any>
                ? TRpc
                : Record<string, never>
            : Record<string, never>
        : never;

/**
 * Presence shape available to a joined client or server context.
 *
 * Derived from the room definition's runtime `presence` mode.
 */
export type PresenceFor<TRoom extends RoomDefinition<any>> =
    TRoom extends RoomDefinition<any, infer TPresence>
        ? TPresence extends "list"
            ? { count: number; members: Array<VisibleMemberFor<TRoom>> }
            : TPresence extends "count"
                ? { count: number }
                : never
        : never;

/**
 * Presence value including the `"none"` case (`undefined`).
 */
export type PresenceValueFor<TRoom extends RoomDefinition<any>> =
    [PresenceFor<TRoom>] extends [never]
        ? undefined
        : PresenceFor<TRoom>;

/**
 * Paginated presence page for `"list"` presence mode.
 */
export type PresencePageFor<TRoom extends RoomDefinition<any>> =
    PresenceFor<TRoom> extends { members: Array<VisibleMemberFor<TRoom>> }
        ? {
            count: number;
            offset: number;
            limit: number;
            members: Array<VisibleMemberFor<TRoom>>;
        }
        : never;

/**
 * Public member entry used in list presence responses.
 */
export type VisibleMemberFor<TRoom extends RoomDefinition<any>> = {
    memberId: string;
    memberProfile: MemberProfileFor<TRoom>;
};

/**
 * Event metadata supplied to event listeners.
 *
 * Includes source information so consumers can distinguish server-originated
 * events from member-originated events.
 */
export type EventMetaFor<TRoom extends RoomDefinition<any>> =
    | {
        roomId: string;
        sentAt: Date;
        source: {
            kind: "server";
        };
    }
    | {
        roomId: string;
        sentAt: Date;
        source:
            PresenceFor<TRoom> extends { members: any[] }
                ? {
                kind: "member";
                memberId: string;
                memberProfile: MemberProfileFor<TRoom>;
            }
            : {
                kind: "member";
                memberId: string;
                    member?: never;
                };
    };

/**
 * Listener signature for room events.
 */
export type EventListener<TRoom extends RoomDefinition<any>, TName extends keyof RoomEvents<TRoom>> = (
    payload: RoomEvents<TRoom>[TName],
    meta: EventMetaFor<TRoom>,
) => void;

/**
 * Event listener map accepted by `JoinedRoom.listen`.
 */
export type RoomEventListenerMap<TRoom extends RoomDefinition<any>> = Partial<{
    [K in keyof RoomEvents<TRoom>]: EventListener<TRoom, K>;
}>;

/**
 * Server-side snapshot entry for a connected socket membership.
 */
export type RoomMemberSnapshot<TRoom extends RoomDefinition<any>> = {
    readonly socketId: string;
    readonly memberId: string;
    readonly memberProfile: MemberProfileFor<TRoom>;
};

/**
 * Introspection snapshot for a room instance.
 */
export type RoomSnapshot<TRoom extends RoomDefinition<any>> = {
    readonly roomId: string;
    readonly roomProfile: RoomProfileFor<TRoom>;
    readonly serverState: ServerStateFor<TRoom>;
    readonly presence: PresenceValueFor<TRoom>;
    readonly memberCount: number;
    readonly members: Array<RoomMemberSnapshot<TRoom>>;
};

/**
 * Server broadcast API for emitting events beyond the current room scope.
 */
export type RoomServerBroadcastApi<TRoom extends RoomDefinition<any>> = {
    readonly emit: EventEmitApi<TRoom>;
    toRoom(roomId: string): {
        readonly emit: EventEmitApi<TRoom>;
    };
    toMembers(memberIds: readonly string[]): {
        readonly emit: EventEmitApi<TRoom>;
    };
};

/**
 * Joined room instance returned by `RoomClient.join`.
 *
 * @example
 * ```ts
 * const joined = await client.join({ roomId: "a", roomKey: "k", userName: "Ada" });
 * await joined.rpc.sendMessage({ text: "hello" });
 * joined.on.message((payload) => console.log(payload.text));
 * await joined.leave();
 * ```
 */
export type JoinedRoom<TRoom extends RoomDefinition<any>> = {
    readonly name: string;
    readonly roomId: string;
    readonly memberId: string;
    readonly roomProfile: RoomProfileFor<TRoom>;
    readonly rpc: RpcClientApi<TRoom>;
    readonly emit: EventEmitApi<TRoom>;
    readonly on: EventListenApi<TRoom>;
    listen(options: RoomListenApi<TRoom>): () => void;
    leave(): Promise<void>;
} & PresenceClientApi<TRoom>;

/**
 * Batched listener registration accepted by `JoinedRoom.listen`.
 */
export type RoomListenApi<TRoom extends RoomDefinition<any>> = {
    readonly events?: RoomEventListenerMap<TRoom>;
} & ([PresenceFor<TRoom>] extends [never]
    ? {}
    : {
        readonly presence?: {
            onChange: (presence: PresenceFor<TRoom>) => void;
        };
    });

/**
 * Handle returned by `serveRoomType`.
 *
 * The handle unregisters listeners for the bound socket via `cleanup()`.
 * It also exposes read-only introspection helpers for tests and diagnostics.
 */
export type RoomServerHandle<TRoom extends RoomDefinition<any>> = {
    cleanup(): void;
    rooms(): Array<RoomSnapshot<TRoom>>;
    room(roomId: string): RoomSnapshot<TRoom> | undefined;
    members(roomId: string, query?: PresenceListQuery): PresencePageFor<TRoom> | undefined;
    count(roomId: string): number;
};

/**
 * Client adapter bound to a specific room type.
 *
 * @example
 * ```ts
 * const client = createRoomClient(socket, chatRoomType);
 * const joined = await client.join({ roomId: "a", roomKey: "k", userName: "Ada" });
 * ```
 */
export type RoomClient<TRoom extends RoomDefinition<any>> = {
    readonly name: string;
    /**
     * Transport-state monitor for the underlying socket.
     */
    readonly connection: {
        /**
         * Latest known transport connection state.
         */
        readonly current: ClientConnectionState;
        /**
         * Subscribes to transport-state changes.
         */
        onChange(handler: (state: ClientConnectionState) => void): () => void;
    };
    join(payload: JoinRequest<TRoom>): Promise<JoinedRoom<TRoom>>;
};

/**
 * Conditionally adds presence APIs to a joined room.
 */
export type PresenceClientApi<TRoom extends RoomDefinition<any>> =
    PresenceFor<TRoom> extends never
        ? Record<string, never>
        : {
            readonly presence: {
                readonly current: PresenceFor<TRoom>;
                onChange(handler: (presence: PresenceFor<TRoom>) => void): () => void;
                count(): Promise<number>;
            } & (PresenceFor<TRoom> extends { members: Array<VisibleMemberFor<TRoom>> }
                ? {
                    list(query?: PresenceListQuery): Promise<PresencePageFor<TRoom>>;
                }
                : Record<string, never>);
        };

/**
 * RPC call surface generated from `RoomRpc`.
 */
export type RpcClientApi<TRoom extends RoomDefinition<any>> = {
    [K in keyof RoomRpc<TRoom>]:
        RoomRpc<TRoom>[K] extends (...args: infer TArgs) => infer TResult
            ? (...args: TArgs) => Promise<Awaited<TResult>>
            : never;
};

/**
 * Event emit surface generated from `RoomEvents`.
 */
export type EventEmitApi<TRoom extends RoomDefinition<any>> = {
    [K in keyof RoomEvents<TRoom>]:
        (payload: RoomEvents<TRoom>[K]) => Promise<void>;
};

/**
 * Event subscription surface generated from `RoomEvents`.
 */
export type EventListenApi<TRoom extends RoomDefinition<any>> = {
    [K in keyof RoomEvents<TRoom>]:
        (handler: EventListener<TRoom, K>) => () => void;
};

/**
 * Successful admission payload returned by `handlers.admit`.
 */
export type ServerAdmission<TRoom extends RoomDefinition<any>> = {
    roomId: string;
    memberId: string;
    memberProfile: MemberProfileFor<TRoom>;
    roomProfile: RoomProfileFor<TRoom>;
};

/**
 * Optional decision result returned by `revalidateAuth`.
 *
 * - `{ kind: "ok" }`: keep existing auth
 * - `{ kind: "ok", auth }`: replace cached auth with `auth`
 * - `{ kind: "reject" }`: reject request with a safe error
 */
export type AuthRevalidationDecision<TAuth> =
    | {
        kind: "ok";
        auth?: TAuth;
    }
    | {
        kind: "reject";
        message?: string;
    };

type IsUnknown<T> = unknown extends T
    ? ([T] extends [unknown] ? true : false)
    : false;

type RoomServerHandlersCommon<TRoom extends RoomDefinition<any>, TAuth> = {
    initState?(join: JoinRequest<TRoom>): Promise<ServerStateFor<TRoom>> | ServerStateFor<TRoom>;
    /**
     * Called once when server listeners are attached for a socket.
     *
     * Useful for transport-level telemetry and side effects that should happen
     * before any room join.
     */
    onConnect?(socket: ServerSocketLike, auth: TAuth): Promise<void> | void;
    /**
     * Called before each authenticated room operation (`admit`, `events`, `rpc`,
     * presence queries, and disconnect cleanup).
     *
     * Return `{ kind: "ok", auth }` to rotate auth context, or
     * `{ kind: "reject", message }` to reject the operation.
     */
    revalidateAuth?(socket: ServerSocketLike, auth: TAuth): Promise<AuthRevalidationDecision<TAuth> | void> | AuthRevalidationDecision<TAuth> | void;
    admit(join: JoinRequest<TRoom>, ctx: RoomServerContext<TRoom, TAuth>): Promise<ServerAdmission<TRoom>> | ServerAdmission<TRoom>;
    /**
     * Called once when a server socket disconnects.
     *
     * Runs before per-room `onLeave` hooks are emitted for disconnect cleanup.
     */
    onDisconnect?(socket: ServerSocketLike, auth: TAuth): Promise<void> | void;
    onJoin?(member: MemberProfileFor<TRoom>, ctx: RoomServerContext<TRoom, TAuth>): Promise<void> | void;
    onLeave?(member: MemberProfileFor<TRoom>, ctx: RoomServerContext<TRoom, TAuth>): Promise<void> | void;
    /**
     * Optional per-request presence override for presence queries.
     *
     * The returned policy is clamped by the room type's configured presence mode,
     * so it cannot escalate visibility above the room default.
     */
    presencePolicy?(ctx: RoomServerContext<TRoom, TAuth>): Promise<PresencePolicy> | PresencePolicy;
    events?: Partial<{
        [K in keyof RoomEvents<TRoom>]:
            (payload: RoomEvents<TRoom>[K], ctx: RoomServerContext<TRoom, TAuth>) => Promise<void> | void;
    }>;
    rpc?: Partial<{
        [K in keyof RoomRpc<TRoom>]:
            RoomRpc<TRoom>[K] extends (...args: infer TArgs) => infer TResult
                ? (...args: [...TArgs, RoomServerContext<TRoom, TAuth>]) => Promise<Awaited<TResult>> | Awaited<TResult>
                : never;
    }>;
};

/**
 * Server handler contract for a room type.
 *
 * `onAuth` is required when `TAuth` is explicitly typed to a non-`unknown`
 * shape, and optional otherwise.
 *
 * Returning `false` rejects the socket before any room state is initialized.
 */
export type RoomServerHandlers<TRoom extends RoomDefinition<any>, TAuth = unknown> =
    IsUnknown<TAuth> extends true
        ? RoomServerHandlersCommon<TRoom, TAuth> & {
            onAuth?(socket: ServerSocketLike): Promise<TAuth | false> | TAuth | false;
        }
        : RoomServerHandlersCommon<TRoom, TAuth> & {
            onAuth(socket: ServerSocketLike): Promise<TAuth | false> | TAuth | false;
        };

/**
 * Context provided to server handlers (`admit`, `rpc`, `events`, join/leave).
 */
export type RoomServerContext<TRoom extends RoomDefinition<any>, TAuth = unknown> = {
    readonly name: string;
    readonly roomId: string;
    readonly auth: TAuth;
    readonly memberId: string;
    readonly memberProfile: MemberProfileFor<TRoom>;
    readonly roomProfile: RoomProfileFor<TRoom>;
    readonly serverState: ServerStateFor<TRoom>;
    readonly emit: EventEmitApi<TRoom>;
    readonly broadcast: RoomServerBroadcastApi<TRoom>;
    getPresence(): PresenceValueFor<TRoom>;
    getPresenceCount(): number;
    listPresenceMembers(query?: PresenceListQuery): PresencePageFor<TRoom>;
};

/**
 * Minimal client socket contract required by the runtime.
 */
export type ClientSocketLike = {
    emit(eventName: string, ...args: any[]): void;
    on(eventName: string, handler: (...args: any[]) => void): void;
    off(eventName: string, handler: (...args: any[]) => void): void;
};

/**
 * Minimal namespace contract required for targeted emits.
 */
export type ServerNamespaceLike = {
    to(roomOrSocketId: string): {
        emit(eventName: string, payload: unknown): void;
    };
};

/**
 * Optional adapter for custom socket-id fanout behavior.
 */
export type RoomServerAdapter = {
    emitToSocketIds(socketIds: readonly string[], eventName: string, payload: unknown): void;
};

/**
 * Minimal server socket contract required by `serveRoomType`.
 */
export type ServerSocketLike = ClientSocketLike & {
    readonly id: string;
    readonly nsp: ServerNamespaceLike;
    join(room: string): Promise<void> | void;
    leave(room: string): Promise<void> | void;
};
