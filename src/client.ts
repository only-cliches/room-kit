import type {
    ClientConnectionState,
    ClientSocketLike,
    EventEmitApi,
    EventListenApi,
    EventMetaFor,
    JoinedRoom,
    JoinRequest,
    PresenceFor,
    PresenceListQuery,
    PresencePageFor,
    PresenceValueFor,
    RoomClient,
    RoomDefinition,
    RoomEvents,
    RoomProfileFor,
    RoomRpc,
    RpcClientApi,
} from "./types";

const JOIN_EVENT = "room-kit:join";
const LEAVE_EVENT = "room-kit:leave";
const RPC_EVENT = "room-kit:rpc";
const CLIENT_EVENT = "room-kit:client-event";
const SERVER_EVENT = "room-kit:server-event";
const PRESENCE_EVENT = "room-kit:presence";
const PRESENCE_QUERY_EVENT = "room-kit:presence-query";

const DEFAULT_ACK_TIMEOUT_MS = 30_000;

type ClientRegistry = {
    serverHandlerInstalled: boolean;
    presenceHandlerInstalled: boolean;
    reconnectHandlerInstalled: boolean;
    disconnectHandlerInstalled: boolean;
    connectErrorHandlerInstalled: boolean;
    reconnectAttemptHandlerInstalled: boolean;
    reconnectErrorHandlerInstalled: boolean;
    reconnectFailedHandlerInstalled: boolean;
    hasConnectedOnce: boolean;
    connectionState: ClientConnectionState;
    connectionListeners: Set<(state: ClientConnectionState) => void>;
    joinedRooms: Map<string, JoinedRoomState<any>>;
};

type JoinedRoomState<TRoom extends RoomDefinition<any>> = {
    name: string;
    roomId: string;
    memberId: string;
    roomProfile: RoomProfileFor<TRoom>;
    presenceCurrent: PresenceValueFor<TRoom>;
    joinRequest: JoinRequest<TRoom>;
    eventListeners: Map<string, Set<(payload: unknown, meta: EventMetaFor<TRoom>) => void>>;
    presenceListeners: Set<(presence: PresenceFor<TRoom>) => void>;
};

const clientRegistries = new WeakMap<ClientSocketLike, ClientRegistry>();

/**
 * Binds a client socket to a room type and returns a typed room client.
 *
 * @example
 * ```ts
 * import { io } from "socket.io-client";
 * import { createRoomClient } from "room-kit";
 *
 * const socket = io("http://127.0.0.1:3000");
 * const client = createRoomClient(socket, chatRoomType);
 * const joined = await client.join({ roomId: "team", roomKey: "secret", userName: "Ada" });
 * ```
 */
export function createRoomClient<TRoom extends RoomDefinition<any>>(
    socket: ClientSocketLike,
    room: TRoom,
): RoomClient<TRoom> {
    return {
        name: room.name,
        get connection() {
            const registry = getClientRegistry(socket);
            return {
                get current(): ClientConnectionState {
                    return registry.connectionState;
                },
                onChange(handler: (state: ClientConnectionState) => void): () => void {
                    registry.connectionListeners.add(handler);
                    return () => {
                        registry.connectionListeners.delete(handler);
                    };
                },
            };
        },
        join(payload: JoinRequest<TRoom>): Promise<JoinedRoom<TRoom>> {
            const registry = getClientRegistry(socket);

            return emitAck<{
                roomId: string;
                memberId: string;
                roomProfile: RoomProfileFor<TRoom>;
                presence: PresenceValueFor<TRoom>;
            }>(socket, JOIN_EVENT, {
                roomType: room.name,
                payload,
            }).then((value) => {
                const state: JoinedRoomState<TRoom> = {
                    name: room.name,
                    roomId: value.roomId,
                    memberId: value.memberId,
                    roomProfile: value.roomProfile,
                    presenceCurrent: value.presence,
                    joinRequest: payload,
                    eventListeners: new Map(),
                    presenceListeners: new Set(),
                };

                registry.joinedRooms.set(makeJoinedRoomKey(room.name, value.roomId), state);
                return createJoinedRoom(socket, state);
            });
        },
    };
}

function createJoinedRoom<TRoom extends RoomDefinition<any>>(
    socket: ClientSocketLike,
    state: JoinedRoomState<TRoom>,
): JoinedRoom<TRoom> {
    const rpc = new Proxy({} as RpcClientApi<TRoom>, {
        get(_target, key) {
            if (typeof key !== "string") {
                return undefined;
            }

            return (...args: unknown[]) => {
                return emitAck(socket, RPC_EVENT, {
                    roomType: state.name,
                    roomId: state.roomId,
                    name: key,
                    args,
                });
            };
        },
    });

    const emit = new Proxy({} as EventEmitApi<TRoom>, {
        get(_target, key) {
            if (typeof key !== "string") {
                return undefined;
            }

            return (payload: unknown) => {
                return emitAck<void>(socket, CLIENT_EVENT, {
                    roomType: state.name,
                    roomId: state.roomId,
                    name: key,
                    payload,
                });
            };
        },
    });

    const on = new Proxy({} as EventListenApi<TRoom>, {
        get(_target, key) {
            if (typeof key !== "string") {
                return undefined;
            }

            return (handler: (payload: unknown, meta: EventMetaFor<TRoom>) => void) => {
                const handlers = state.eventListeners.get(key) ?? new Set();
                handlers.add(handler);
                state.eventListeners.set(key, handlers);
                return () => {
                    handlers.delete(handler);
                    if (handlers.size === 0) {
                        state.eventListeners.delete(key);
                    }
                };
            };
        },
    });

    const base = {
        name: state.name,
        roomId: state.roomId,
        memberId: state.memberId,
        roomProfile: state.roomProfile,
        rpc,
        emit,
        on,
        async leave(): Promise<void> {
            await emitAck<void>(socket, LEAVE_EVENT, {
                roomType: state.name,
                roomId: state.roomId,
            });
            const registry = getClientRegistry(socket);
            registry.joinedRooms.delete(makeJoinedRoomKey(state.name, state.roomId));
        },
    };

    return new Proxy(base, {
        get(target, key, receiver) {
            if (key === "presence") {
                return {
                    get current(): PresenceFor<TRoom> {
                        return state.presenceCurrent as PresenceFor<TRoom>;
                    },
                    onChange(handler: (presence: PresenceFor<TRoom>) => void): () => void {
                        state.presenceListeners.add(handler);
                        return () => {
                            state.presenceListeners.delete(handler);
                        };
                    },
                    count(): Promise<number> {
                        return emitAck<number>(socket, PRESENCE_QUERY_EVENT, {
                            roomType: state.name,
                            roomId: state.roomId,
                            kind: "count",
                        });
                    },
                    list(query: PresenceListQuery = {}): Promise<PresencePageFor<TRoom>> {
                        return emitAck<PresencePageFor<TRoom>>(socket, PRESENCE_QUERY_EVENT, {
                            roomType: state.name,
                            roomId: state.roomId,
                            kind: "list",
                            ...query,
                        });
                    },
                };
            }

            return Reflect.get(target, key, receiver);
        },
    }) as JoinedRoom<TRoom>;
}

function getClientRegistry(socket: ClientSocketLike): ClientRegistry {
    const existing = clientRegistries.get(socket);
    if (existing) {
        return existing;
    }

    const created: ClientRegistry = {
        serverHandlerInstalled: false,
        presenceHandlerInstalled: false,
        reconnectHandlerInstalled: false,
        disconnectHandlerInstalled: false,
        connectErrorHandlerInstalled: false,
        reconnectAttemptHandlerInstalled: false,
        reconnectErrorHandlerInstalled: false,
        reconnectFailedHandlerInstalled: false,
        hasConnectedOnce: false,
        connectionState: "connecting",
        connectionListeners: new Set(),
        joinedRooms: new Map(),
    };

    installClientHandlers(socket, created);
    clientRegistries.set(socket, created);
    return created;
}

function installClientHandlers(socket: ClientSocketLike, registry: ClientRegistry): void {
    if (!registry.serverHandlerInstalled) {
        const onServerEvent = (frame: {
            roomType: string;
            roomId: string;
            name: string;
            payload: unknown;
            meta: {
                roomId: string;
                sentAt: string;
                source: unknown;
            };
        }) => {
            if (
                !frame ||
                typeof frame !== "object" ||
                typeof frame.roomType !== "string" ||
                typeof frame.roomId !== "string" ||
                typeof frame.name !== "string" ||
                !frame.meta ||
                typeof frame.meta !== "object" ||
                typeof frame.meta.sentAt !== "string"
            ) {
                return;
            }

            const state = registry.joinedRooms.get(makeJoinedRoomKey(frame.roomType, frame.roomId));
            if (!state) {
                return;
            }

            const handlers = state.eventListeners.get(frame.name);
            if (!handlers || handlers.size === 0) {
                return;
            }

            const meta = {
                ...frame.meta,
                sentAt: new Date(frame.meta.sentAt),
            } as EventMetaFor<any>;

            for (const handler of handlers) {
                try {
                    handler(frame.payload, meta);
                } catch {
                    // Swallow per-listener errors to avoid breaking the event loop
                }
            }
        };

        socket.on(SERVER_EVENT, onServerEvent);
        registry.serverHandlerInstalled = true;
    }

    if (!registry.presenceHandlerInstalled) {
        const onPresence = (frame: { roomType: string; roomId: string; presence: unknown }) => {
            if (
                !frame ||
                typeof frame !== "object" ||
                typeof frame.roomType !== "string" ||
                typeof frame.roomId !== "string"
            ) {
                return;
            }

            const state = registry.joinedRooms.get(makeJoinedRoomKey(frame.roomType, frame.roomId));
            if (!state) {
                return;
            }

            state.presenceCurrent = frame.presence as PresenceFor<any>;
            if (state.presenceCurrent === undefined) {
                return;
            }

            for (const handler of state.presenceListeners) {
                try {
                    handler(state.presenceCurrent);
                } catch {
                    // Swallow per-listener errors
                }
            }
        };

        socket.on(PRESENCE_EVENT, onPresence);
        registry.presenceHandlerInstalled = true;
    }

    if (!registry.reconnectHandlerInstalled) {
        const onConnect = () => {
            registry.hasConnectedOnce = true;
            setConnectionState(registry, "connected");
            void replayJoinedRooms(socket, registry);
        };

        socket.on("connect", onConnect);
        registry.reconnectHandlerInstalled = true;
    }

    if (!registry.disconnectHandlerInstalled) {
        const onDisconnect = () => {
            setConnectionState(registry, "disconnected");
        };

        socket.on("disconnect", onDisconnect);
        registry.disconnectHandlerInstalled = true;
    }

    if (!registry.connectErrorHandlerInstalled) {
        const onConnectError = () => {
            setConnectionState(registry, registry.hasConnectedOnce ? "reconnecting" : "connecting");
        };

        socket.on("connect_error", onConnectError);
        registry.connectErrorHandlerInstalled = true;
    }

    if (!registry.reconnectAttemptHandlerInstalled) {
        const onReconnectAttempt = () => {
            setConnectionState(registry, "reconnecting");
        };

        socket.on("reconnect_attempt", onReconnectAttempt);
        registry.reconnectAttemptHandlerInstalled = true;
    }

    if (!registry.reconnectFailedHandlerInstalled) {
        const onReconnectFailed = () => {
            setConnectionState(registry, "disconnected");
        };

        socket.on("reconnect_failed", onReconnectFailed);
        registry.reconnectFailedHandlerInstalled = true;
    }

    if (!registry.reconnectErrorHandlerInstalled) {
        const onReconnectError = () => {
            setConnectionState(registry, "reconnecting");
        };

        socket.on("reconnect_error", onReconnectError);
        registry.reconnectErrorHandlerInstalled = true;
    }
}

async function replayJoinedRooms(socket: ClientSocketLike, registry: ClientRegistry): Promise<void> {
    for (const [key, state] of Array.from(registry.joinedRooms.entries())) {
        try {
            const value = await emitAck<{
                roomId: string;
                memberId: string;
                roomProfile: RoomProfileFor<any>;
                presence: PresenceFor<any>;
            }>(socket, JOIN_EVENT, {
                roomType: state.name,
                payload: state.joinRequest,
            });

            state.roomId = value.roomId;
            state.memberId = value.memberId;
            state.roomProfile = value.roomProfile;
            state.presenceCurrent = value.presence;

            const newKey = makeJoinedRoomKey(state.name, value.roomId);
            if (newKey !== key) {
                registry.joinedRooms.delete(key);
            }
            registry.joinedRooms.set(newKey, state);
        } catch {
            registry.joinedRooms.delete(key);
        }
    }
}

function makeJoinedRoomKey(name: string, roomId: string): string {
    return `${name}:${roomId}`;
}

function emitAck<TValue>(socket: ClientSocketLike, eventName: string, payload: unknown): Promise<TValue> {
    return new Promise<TValue>((resolve, reject) => {
        const timer = setTimeout(() => {
            reject(new Error(`Acknowledgement timeout for '${eventName}'`));
        }, DEFAULT_ACK_TIMEOUT_MS);

        socket.emit(eventName, payload, (result: { ok: true; value: TValue } | { ok: false; error: string }) => {
            clearTimeout(timer);

            if (!result || typeof result !== "object") {
                reject(new Error("Invalid acknowledgement payload"));
                return;
            }

            if (result.ok) {
                resolve(result.value);
                return;
            }

            reject(new Error(result.error));
        });
    });
}

function setConnectionState(registry: ClientRegistry, next: ClientConnectionState): void {
    if (registry.connectionState === next) {
        return;
    }

    registry.connectionState = next;
    for (const listener of registry.connectionListeners) {
        try {
            listener(next);
        } catch {
            // Swallow per-listener errors
        }
    }
}
