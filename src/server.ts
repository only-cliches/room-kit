import type {
    AuthRevalidationDecision,
    EventEmitApi,
    EventMetaFor,
    JoinRequest,
    PresenceFor,
    PresenceListQuery,
    PresencePageFor,
    PresencePolicy,
    RoomMemberSnapshot,
    RoomDefinition,
    RoomEvents,
    RoomServerAdapter,
    RoomServerBroadcastApi,
    RoomServerHandle,
    RoomServerContext,
    RoomServerHandlers,
    RoomSnapshot,
    ServerSocketLike,
    ServerStateFor,
    PresenceValueFor,
    VisibleMemberFor,
} from "./types";
import { ClientSafeError } from "./types";

const JOIN_EVENT = "room-kit:join";
const LEAVE_EVENT = "room-kit:leave";
const RPC_EVENT = "room-kit:rpc";
const CLIENT_EVENT = "room-kit:client-event";
const SERVER_EVENT = "room-kit:server-event";
const PRESENCE_EVENT = "room-kit:presence";
const PRESENCE_QUERY_EVENT = "room-kit:presence-query";

type StoredMember<TRoom extends RoomDefinition<any>> = {
    socketId: string;
    memberId: string;
    memberProfile: any;
};

type RoomState<TRoom extends RoomDefinition<any>> = {
    presence: PresencePolicy;
    roomProfile: any;
    serverState: ServerStateFor<TRoom>;
    membersBySocketId: Map<string, StoredMember<TRoom>>;
    socketIdsByMemberId: Map<string, Set<string>>;
};

type NamespaceState = {
    roomsByNameSpace: Map<string, Map<string, RoomState<any>>>;
};

type AuthCacheEntry<TAuth> = {
    pending?: Promise<TAuth>;
    value?: TAuth;
};

const namespaceStates = new WeakMap<object, NamespaceState>();

/**
 * Attaches room runtime handlers to a connected server socket.
 *
 * Returns a callable handle that unregisters all listeners for the bound
 * socket, and exposes room introspection helpers.
 *
 * @example
 * ```ts
 * io.on("connection", (socket) => {
 *   const stop = serveRoomType(socket, chatRoomType, {
 *     onAuth: async () => ({ userId: socket.id }),
 *     admit: async (join, ctx) => ({
 *       roomId: join.roomId,
 *       memberId: ctx.auth.userId,
 *       memberProfile: { userId: ctx.auth.userId, userName: join.userName },
 *       roomProfile: { roomId: join.roomId, created: new Date().toISOString() },
 *     }),
 *   });
 *
 *   // Later if needed:
 *   // stop();
 * });
 * ```
 */
export function serveRoomType<TRoom extends RoomDefinition<any>, TAuth = unknown>(
    socket: ServerSocketLike,
    _room: TRoom,
    handlers: RoomServerHandlers<TRoom, TAuth>,
    adapter?: RoomServerAdapter,
): RoomServerHandle<TRoom> {
    const namespaceState = getNamespaceState(socket);
    const authCache = new WeakMap<ServerSocketLike, AuthCacheEntry<TAuth>>();

    const onJoin = async (
        frame: {
            roomType: string;
            payload: JoinRequest<TRoom>;
        },
        ack?: (result: { ok: true; value: { roomId: string; memberId: string; roomProfile: any; presence: PresenceValueFor<TRoom> } } | { ok: false; error: string }) => void,
    ) => {
        try {
            assertMatchingRoomName(_room, frame.roomType);
            const requestedRoomId = extractRoomId(frame.payload);
            const roomCollection = getOrCreateRoomCollection(namespaceState, frame.roomType);
            const existingRoomState = roomCollection.get(requestedRoomId);
            const initialState = (existingRoomState?.serverState ??
                await Promise.resolve(handlers.initState?.(frame.payload) ?? {})) as ServerStateFor<TRoom>;
            const auth = await resolveSocketAuth(socket, handlers, authCache, true);
            const provisional = createContext<TRoom, TAuth>(socket, namespaceState, {
                adapter,
                name: frame.roomType,
                roomId: requestedRoomId,
                auth: auth as TAuth,
                memberId: socket.id,
                memberProfile: undefined,
                roomProfile: undefined,
                serverState: initialState,
            });
            const admission = await handlers.admit(frame.payload, provisional);
            assertMatchingRoomIds(
                requestedRoomId,
                admission.roomId,
                (admission.roomProfile as { roomId: string }).roomId,
            );

            const roomState: RoomState<TRoom> = roomCollection.get(admission.roomId) ?? {
                presence: _room.presence,
                roomProfile: admission.roomProfile,
                serverState: provisional.serverState as ServerStateFor<TRoom>,
                membersBySocketId: new Map(),
                socketIdsByMemberId: new Map(),
            };
            roomState.roomProfile = roomState.roomProfile ?? admission.roomProfile;
            roomState.serverState = roomState.serverState ?? provisional.serverState;
            roomState.membersBySocketId.set(socket.id, {
                socketId: socket.id,
                memberId: admission.memberId,
                memberProfile: admission.memberProfile,
            });

            const memberSockets = roomState.socketIdsByMemberId.get(admission.memberId) ?? new Set();
            memberSockets.add(socket.id);
            roomState.socketIdsByMemberId.set(admission.memberId, memberSockets);
            roomCollection.set(admission.roomId, roomState);

            await Promise.resolve(socket.join(admission.roomId));

            const ctx = createContext<TRoom, TAuth>(socket, namespaceState, {
                adapter,
                name: frame.roomType,
                auth: auth as TAuth,
                ...admission,
                serverState: roomState.serverState,
            });
            await handlers.onJoin?.(admission.memberProfile, ctx);
            broadcastPresence(socket, namespaceState, frame.roomType, admission.roomId, adapter);

            ack?.({
                ok: true,
                value: {
                    roomId: admission.roomId,
                    memberId: admission.memberId,
                    roomProfile: roomState.roomProfile,
                    presence: getPresenceSnapshot(namespaceState, frame.roomType, admission.roomId),
                },
            });
        } catch (error) {
            ack?.({ ok: false, error: toErrorMessage(error) });
        }
    };

    const onLeave = async (
        payload: { roomType: string; roomId: string },
        ack?: (result: { ok: true; value: void } | { ok: false; error: string }) => void,
    ) => {
        try {
            assertMatchingRoomName(_room, payload.roomType);
            const stored = getStoredMembership(namespaceState, payload.roomType, payload.roomId, socket.id);
            if (!stored) {
                throw new ClientSafeError("Socket is not joined to that room");
            }
            const auth = await resolveSocketAuth(socket, handlers, authCache, true);

            const ctx = createContext<TRoom, TAuth>(socket, namespaceState, {
                adapter,
                name: payload.roomType,
                roomId: payload.roomId,
                auth: auth as TAuth,
                memberId: stored.memberId,
                memberProfile: stored.memberProfile,
                roomProfile: getRoomState(namespaceState, payload.roomType, payload.roomId).roomProfile,
                serverState: getRoomState(namespaceState, payload.roomType, payload.roomId).serverState as ServerStateFor<TRoom>,
            });

            removeMembership(namespaceState, payload.roomType, payload.roomId, socket.id);
            await Promise.resolve(socket.leave(payload.roomId));
            await handlers.onLeave?.(stored.memberProfile, ctx);
            broadcastPresence(socket, namespaceState, payload.roomType, payload.roomId, adapter);

            ack?.({ ok: true, value: undefined });
        } catch (error) {
            ack?.({ ok: false, error: toErrorMessage(error) });
        }
    };

    const onRpc = async (
        frame: { roomType: string; roomId: string; name: string; args: unknown[] },
        ack?: (result: { ok: true; value: unknown } | { ok: false; error: string }) => void,
    ) => {
        try {
            assertMatchingRoomName(_room, frame.roomType);
            if (!handlers.rpc || !Object.hasOwn(handlers.rpc, frame.name)) {
                throw new ClientSafeError(`Unknown RPC '${frame.name}'`);
            }
            const handler = handlers.rpc[frame.name as keyof typeof handlers.rpc];
            if (typeof handler !== "function") {
                throw new ClientSafeError(`Invalid RPC handler for '${frame.name}'`);
            }

            const stored = getStoredMembership(namespaceState, frame.roomType, frame.roomId, socket.id);
            if (!stored) {
                throw new ClientSafeError("Socket is not joined to that room");
            }
            const auth = await resolveSocketAuth(socket, handlers, authCache, true);

            const ctx = createContext<TRoom, TAuth>(socket, namespaceState, {
                adapter,
                name: frame.roomType,
                roomId: frame.roomId,
                auth: auth as TAuth,
                memberId: stored.memberId,
                memberProfile: stored.memberProfile,
                roomProfile: getRoomState(namespaceState, frame.roomType, frame.roomId).roomProfile,
                serverState: getRoomState(namespaceState, frame.roomType, frame.roomId).serverState as ServerStateFor<TRoom>,
            });

            const result = await handler(...frame.args, ctx);
            ack?.({ ok: true, value: result });
        } catch (error) {
            ack?.({ ok: false, error: toErrorMessage(error) });
        }
    };

    const onClientEvent = async (
        frame: { roomType: string; roomId: string; name: string; payload: unknown },
        ack?: (result: { ok: true; value: void } | { ok: false; error: string }) => void,
    ) => {
        try {
            assertMatchingRoomName(_room, frame.roomType);
            const stored = getStoredMembership(namespaceState, frame.roomType, frame.roomId, socket.id);
            if (!stored) {
                throw new ClientSafeError("Socket is not joined to that room");
            }
            const auth = await resolveSocketAuth(socket, handlers, authCache, true);

            const ctx = createContext<TRoom, TAuth>(socket, namespaceState, {
                adapter,
                name: frame.roomType,
                roomId: frame.roomId,
                auth: auth as TAuth,
                memberId: stored.memberId,
                memberProfile: stored.memberProfile,
                roomProfile: getRoomState(namespaceState, frame.roomType, frame.roomId).roomProfile,
                serverState: getRoomState(namespaceState, frame.roomType, frame.roomId).serverState as ServerStateFor<TRoom>,
            });

            if (!handlers.events || !Object.hasOwn(handlers.events, frame.name)) {
                throw new ClientSafeError(`Unknown event '${frame.name}'`);
            }
            const handler = handlers.events[frame.name as keyof typeof handlers.events];
            if (typeof handler !== "function") {
                throw new ClientSafeError(`Invalid event handler for '${frame.name}'`);
            }

            await handler(frame.payload as never, ctx);
            emitToMembers(socket, namespaceState, frame.roomType, frame.roomId, allMemberIds(namespaceState, frame.roomType, frame.roomId), frame.name, frame.payload, {
                roomId: frame.roomId,
                sentAt: new Date(),
                source: makeMemberSource(ctx),
            } as EventMetaFor<TRoom>, undefined, adapter);

            ack?.({ ok: true, value: undefined });
        } catch (error) {
            ack?.({ ok: false, error: toErrorMessage(error) });
        }
    };

    const onPresenceQuery = async (
        frame: {
            roomType: string;
            roomId: string;
            kind: "count" | "list";
            offset?: number;
            limit?: number;
        },
        ack?: (result: { ok: true; value: number | PresencePageFor<TRoom> } | { ok: false; error: string }) => void,
    ) => {
        try {
            assertMatchingRoomName(_room, frame.roomType);
            const stored = getStoredMembership(namespaceState, frame.roomType, frame.roomId, socket.id);
            if (!stored) {
                throw new ClientSafeError("Socket is not joined to that room");
            }
            const auth = await resolveSocketAuth(socket, handlers, authCache, true);
            const ctx = createContext<TRoom, TAuth>(socket, namespaceState, {
                adapter,
                name: frame.roomType,
                roomId: frame.roomId,
                auth: auth as TAuth,
                memberId: stored.memberId,
                memberProfile: stored.memberProfile,
                roomProfile: getRoomState(namespaceState, frame.roomType, frame.roomId).roomProfile,
                serverState: getRoomState(namespaceState, frame.roomType, frame.roomId).serverState as ServerStateFor<TRoom>,
            });

            const roomState = getRoomState(namespaceState, frame.roomType, frame.roomId);
            const requestedPolicy = await Promise.resolve(handlers.presencePolicy?.(ctx) ?? roomState.presence);
            const effectivePolicy = clampPresencePolicy(roomState.presence, requestedPolicy);

            if (effectivePolicy === "none") {
                throw new ClientSafeError("Presence is disabled for this room");
            }

            if (frame.kind === "count") {
                ack?.({ ok: true, value: getPresenceCount(namespaceState, frame.roomType, frame.roomId) });
                return;
            }

            if (effectivePolicy !== "list") {
                throw new ClientSafeError("Member lists are disabled for this room");
            }

            ack?.({
                ok: true,
                value: getPresenceMembersPage(namespaceState, frame.roomType, frame.roomId, {
                    offset: frame.offset,
                    limit: frame.limit,
                }),
            });
        } catch (error) {
            ack?.({ ok: false, error: toErrorMessage(error) });
        }
    };

    const onDisconnect = async () => {
        const joinedRooms = joinedRoomsForSocket(namespaceState, socket.id);
        const disconnectedMemberships: Array<{
            roomType: string;
            roomId: string;
            memberId: string;
            memberProfile: any;
            roomProfile: any;
            serverState: ServerStateFor<TRoom>;
        }> = [];

        for (const joined of joinedRooms) {
            const stored = getStoredMembership(namespaceState, joined.roomType, joined.roomId, socket.id);
            if (!stored) {
                continue;
            }

            const roomState = getRoomState(namespaceState, joined.roomType, joined.roomId);
            disconnectedMemberships.push({
                roomType: joined.roomType,
                roomId: joined.roomId,
                memberId: stored.memberId,
                memberProfile: stored.memberProfile,
                roomProfile: roomState.roomProfile,
                serverState: roomState.serverState as ServerStateFor<TRoom>,
            });
            removeMembership(namespaceState, joined.roomType, joined.roomId, socket.id);
        }

        let auth: TAuth | undefined;
        let hasAuth = false;
        try {
            auth = await resolveSocketAuth(socket, handlers, authCache, true);
            hasAuth = true;
            await handlers.onDisconnect?.(socket, auth as TAuth);
        } catch {
            hasAuth = false;
        }

        for (const disconnected of disconnectedMemberships) {
            const ctx = createContext<TRoom, TAuth>(socket, namespaceState, {
                adapter,
                name: disconnected.roomType,
                roomId: disconnected.roomId,
                auth: auth as TAuth,
                memberId: disconnected.memberId,
                memberProfile: disconnected.memberProfile,
                roomProfile: disconnected.roomProfile,
                serverState: disconnected.serverState,
            });

            if (hasAuth) {
                await handlers.onLeave?.(disconnected.memberProfile, ctx);
            }
            broadcastPresence(socket, namespaceState, disconnected.roomType, disconnected.roomId, adapter);
        }
    };

    socket.on(JOIN_EVENT, onJoin);
    socket.on(LEAVE_EVENT, onLeave);
    socket.on(RPC_EVENT, onRpc);
    socket.on(CLIENT_EVENT, onClientEvent);
    socket.on(PRESENCE_QUERY_EVENT, onPresenceQuery);
    socket.on("disconnect", onDisconnect);

    if (handlers.onConnect) {
        void Promise.resolve()
            .then(async () => {
                const auth = await resolveSocketAuth(socket, handlers, authCache, false);
                await handlers.onConnect?.(socket, auth as TAuth);
            })
            .catch(() => undefined);
    }

    const stop = () => {
        socket.off(JOIN_EVENT, onJoin);
        socket.off(LEAVE_EVENT, onLeave);
        socket.off(RPC_EVENT, onRpc);
        socket.off(CLIENT_EVENT, onClientEvent);
        socket.off(PRESENCE_QUERY_EVENT, onPresenceQuery);
        socket.off("disconnect", onDisconnect);
    };

    return Object.assign(stop, {
        rooms: () => listRoomSnapshots<TRoom>(namespaceState, _room.name),
        room: (roomId: string) => getRoomSnapshot<TRoom>(namespaceState, _room.name, roomId),
        members: (roomId: string, query?: PresenceListQuery) =>
            getPresenceMembersPage<TRoom>(namespaceState, _room.name, roomId, query),
        count: (roomId: string) => getPresenceCount(namespaceState, _room.name, roomId),
    });
}

function createContext<TRoom extends RoomDefinition<any>, TAuth = unknown>(
    socket: ServerSocketLike,
    namespaceState: NamespaceState,
    ctxState: {
        adapter?: RoomServerAdapter;
        name: string;
        roomId: string;
        auth: TAuth;
        memberId: string;
        memberProfile: any;
        roomProfile: any;
        serverState: ServerStateFor<TRoom>;
    },
): RoomServerContext<TRoom, TAuth> {
    const emit = createEventEmitApi<TRoom>((eventName, payload) => {
        emitToMembers(socket, namespaceState, ctxState.name, ctxState.roomId, allMemberIds(namespaceState, ctxState.name, ctxState.roomId), eventName, payload, {
            roomId: ctxState.roomId,
            sentAt: new Date(),
            source: {
                kind: "server",
            },
        } as EventMetaFor<TRoom>, undefined, ctxState.adapter);
    });

    const broadcast = createBroadcastApi<TRoom>(socket, namespaceState, ctxState.name, ctxState.roomId, socket.id, ctxState.adapter);

    return {
        name: ctxState.name,
        roomId: ctxState.roomId,
        auth: ctxState.auth,
        memberId: ctxState.memberId,
        memberProfile: ctxState.memberProfile,
        roomProfile: ctxState.roomProfile,
        serverState: ctxState.serverState,
        emit,
        broadcast,
        getPresence() {
            return getPresenceSnapshot(namespaceState, ctxState.name, ctxState.roomId);
        },
        getPresenceCount() {
            return getPresenceCount(namespaceState, ctxState.name, ctxState.roomId);
        },
        listPresenceMembers(query: PresenceListQuery = {}) {
            return getPresenceMembersPage(namespaceState, ctxState.name, ctxState.roomId, query);
        },
    };
}

async function resolveSocketAuth<TAuth>(
    socket: ServerSocketLike,
    handlers: RoomServerHandlers<any, TAuth>,
    authCache: WeakMap<ServerSocketLike, AuthCacheEntry<TAuth>>,
    revalidate: boolean,
): Promise<TAuth> {
    let entry = authCache.get(socket);
    if (!entry) {
        entry = {};
        authCache.set(socket, entry);
    }

    if (entry.pending) {
        return entry.pending;
    }

    if (entry.value === undefined) {
        const pending = Promise.resolve(handlers.onAuth?.(socket) as TAuth)
            .then((auth) => {
                const current = authCache.get(socket) ?? {};
                current.value = auth;
                current.pending = undefined;
                authCache.set(socket, current);
                return auth;
            })
            .catch((error) => {
                authCache.delete(socket);
                throw error;
            });
        entry.pending = pending;
        authCache.set(socket, entry);
        await pending;
        entry = authCache.get(socket) ?? entry;
    }

    let auth = entry.value as TAuth;
    if (!revalidate || !handlers.revalidateAuth) {
        return auth;
    }

    const decision = await Promise.resolve(handlers.revalidateAuth(socket, auth));
    if (!decision || decision.kind === "ok") {
        if (decision?.auth !== undefined) {
            auth = decision.auth;
            entry.value = auth;
            authCache.set(socket, entry);
        }
        return auth;
    }

    handleRejectedAuth(authCache, socket, decision);
}

function handleRejectedAuth<TAuth>(
    authCache: WeakMap<ServerSocketLike, AuthCacheEntry<TAuth>>,
    socket: ServerSocketLike,
    decision: Extract<AuthRevalidationDecision<TAuth>, { kind: "reject" }>,
): never {
    authCache.delete(socket);
    throw new ClientSafeError(decision.message ?? "Unauthorized");
}

function createEventEmitApi<TRoom extends RoomDefinition<any>>(
    send: (eventName: string, payload: unknown) => void,
): EventEmitApi<TRoom> {
    return new Proxy({} as EventEmitApi<TRoom>, {
        get(_target, key) {
            if (typeof key !== "string") {
                return undefined;
            }

            return async (payload: unknown) => {
                send(key, payload);
            };
        },
    });
}

function createBroadcastApi<TRoom extends RoomDefinition<any>>(
    socket: ServerSocketLike,
    namespaceState: NamespaceState,
    name: string,
    roomId: string,
    senderSocketId: string,
    adapter?: RoomServerAdapter,
): RoomServerBroadcastApi<TRoom> {
    return {
        emit: createEventEmitApi<TRoom>((eventName, payload) => {
            emitToNamespace(socket, namespaceState, name, eventName, payload, senderSocketId, {
                roomId,
                sentAt: new Date(),
                source: {
                    kind: "server",
                },
            } as EventMetaFor<TRoom>, adapter);
        }),
        toRoom(targetRoomId: string) {
            return {
                emit: createEventEmitApi<TRoom>((eventName, payload) => {
                    emitToRoom(socket, namespaceState, name, targetRoomId, eventName, payload, {
                        roomId: targetRoomId,
                        sentAt: new Date(),
                        source: {
                            kind: "server",
                        },
                    } as EventMetaFor<TRoom>, senderSocketId, adapter);
                }),
            };
        },
        toMembers(memberIds: readonly string[]) {
            return {
                emit: createEventEmitApi<TRoom>((eventName, payload) => {
                    emitToMembers(socket, namespaceState, name, roomId, memberIds, eventName, payload, {
                        roomId,
                        sentAt: new Date(),
                        source: {
                            kind: "server",
                        },
                    } as EventMetaFor<TRoom>, senderSocketId, adapter);
                }),
            };
        },
    };
}

function emitToMembers(
    socket: ServerSocketLike,
    namespaceState: NamespaceState,
    name: string,
    roomId: string,
    memberIds: readonly string[],
    eventName: string,
    payload: unknown,
    meta: { roomId: string; sentAt: Date; source: unknown },
    excludeSocketId?: string,
    adapter?: RoomServerAdapter,
): void {
    const roomState = getRoomCollection(namespaceState, name)?.get(roomId);
    if (!roomState) {
        return;
    }

    const socketIds = new Set<string>();
    for (const memberId of memberIds) {
        const ids = roomState.socketIdsByMemberId.get(memberId);
        if (!ids) {
            continue;
        }

        for (const socketId of ids) {
            if (excludeSocketId && socketId === excludeSocketId) {
                continue;
            }
            socketIds.add(socketId);
        }
    }

    emitToSocketIds(socket, socketIds, eventName, payload, name, roomId, meta, adapter);
}

function emitToRoom(
    socket: ServerSocketLike,
    namespaceState: NamespaceState,
    name: string,
    roomId: string,
    eventName: string,
    payload: unknown,
    meta: { roomId: string; sentAt: Date; source: unknown },
    excludeSocketId?: string,
    adapter?: RoomServerAdapter,
): void {
    const roomState = getRoomCollection(namespaceState, name)?.get(roomId);
    if (!roomState) {
        return;
    }

    const socketIds = new Set<string>();
    for (const stored of roomState.membersBySocketId.values()) {
        if (excludeSocketId && stored.socketId === excludeSocketId) {
            continue;
        }
        socketIds.add(stored.socketId);
    }

    emitToSocketIds(socket, socketIds, eventName, payload, name, roomId, meta, adapter);
}

function emitToNamespace(
    socket: ServerSocketLike,
    namespaceState: NamespaceState,
    name: string,
    eventName: string,
    payload: unknown,
    excludeSocketId: string | undefined,
    meta: { roomId: string; sentAt: Date; source: unknown },
    adapter?: RoomServerAdapter,
): void {
    const socketIds = allSocketIdsForNamespace(namespaceState, name, excludeSocketId);
    emitToSocketIds(socket, socketIds, eventName, payload, name, meta.roomId, meta, adapter);
}

function emitToSocketIds(
    socket: ServerSocketLike,
    socketIds: Iterable<string>,
    eventName: string,
    payload: unknown,
    name: string,
    roomId: string,
    meta: { roomId: string; sentAt: Date; source: unknown },
    adapter?: RoomServerAdapter,
): void {
    const emitted = {
        roomType: name,
        roomId,
        name: eventName,
        payload,
        meta: {
            ...meta,
            sentAt: meta.sentAt.toISOString(),
        },
    };

    if (adapter) {
        adapter.emitToSocketIds(Array.from(socketIds), SERVER_EVENT, emitted);
        return;
    }

    for (const socketId of socketIds) {
        socket.nsp.to(socketId).emit(SERVER_EVENT, emitted);
    }
}

function broadcastPresence(
    socket: ServerSocketLike,
    namespaceState: NamespaceState,
    name: string,
    roomId: string,
    adapter?: RoomServerAdapter,
): void {
    const roomState = getRoomCollection(namespaceState, name)?.get(roomId);
    if (!roomState) {
        return;
    }

    const presence = getPresenceSnapshot(namespaceState, name, roomId);
    if (presence === undefined) {
        return;
    }

    for (const stored of roomState.membersBySocketId.values()) {
        const frame = {
            roomType: name,
            roomId,
            presence,
        };

        if (adapter) {
            adapter.emitToSocketIds([stored.socketId], PRESENCE_EVENT, frame);
            continue;
        }

        socket.nsp.to(stored.socketId).emit(PRESENCE_EVENT, frame);
    }
}

function getPresenceSnapshot<TRoom extends RoomDefinition<any>>(
    namespaceState: NamespaceState,
    name: string,
    roomId: string,
): PresenceValueFor<TRoom> {
    const roomState = getRoomCollection(namespaceState, name)?.get(roomId);
    if (!roomState) {
        return undefined as PresenceValueFor<TRoom>;
    }

    if (roomState.presence === "none") {
        return undefined as PresenceValueFor<TRoom>;
    }

    const members = dedupeMembers(roomState);
    if (roomState.presence === "list") {
        return {
            count: members.length,
            members: members.map((entry) => ({
                memberId: entry.memberId,
                memberProfile: entry.memberProfile,
            })),
        } as PresenceValueFor<TRoom>;
    }

    return {
        count: members.length,
    } as PresenceValueFor<TRoom>;
}

function getRoomSnapshot<TRoom extends RoomDefinition<any>>(
    namespaceState: NamespaceState,
    name: string,
    roomId: string,
): RoomSnapshot<TRoom> | undefined {
    const roomState = getRoomCollection(namespaceState, name)?.get(roomId);
    if (!roomState) {
        return undefined;
    }

    const members = dedupeMembers(roomState);
    return {
        roomId,
        roomProfile: roomState.roomProfile,
        serverState: roomState.serverState,
        presence: getPresenceSnapshot(namespaceState, name, roomId),
        memberCount: members.length,
        members: members.map((entry) => ({
            socketId: entry.socketId,
            memberId: entry.memberId,
            memberProfile: entry.memberProfile,
        })),
    } as RoomSnapshot<TRoom>;
}

function listRoomSnapshots<TRoom extends RoomDefinition<any>>(
    namespaceState: NamespaceState,
    name: string,
): Array<RoomSnapshot<TRoom>> {
    const roomCollection = getRoomCollection(namespaceState, name);
    if (!roomCollection) {
        return [];
    }

    const snapshots: Array<RoomSnapshot<TRoom>> = [];
    for (const roomId of roomCollection.keys()) {
        const snapshot = getRoomSnapshot<TRoom>(namespaceState, name, roomId);
        if (snapshot) {
            snapshots.push(snapshot);
        }
    }

    return snapshots;
}

function getPresenceCount(namespaceState: NamespaceState, name: string, roomId: string): number {
    const roomState = getRoomCollection(namespaceState, name)?.get(roomId);
    if (!roomState) {
        return 0;
    }

    if (roomState.presence === "none") {
        throw new ClientSafeError("Presence is disabled for this room");
    }

    return dedupeMembers(roomState).length;
}

function getPresenceMembersPage<TRoom extends RoomDefinition<any>>(
    namespaceState: NamespaceState,
    name: string,
    roomId: string,
    query: PresenceListQuery = {},
): PresencePageFor<TRoom> {
    const roomState = getRoomCollection(namespaceState, name)?.get(roomId);
    if (!roomState) {
        return {
            count: 0,
            offset: 0,
            limit: 0,
            members: [],
        } as unknown as PresencePageFor<TRoom>;
    }

    if (roomState.presence === "none") {
        throw new ClientSafeError("Presence is disabled for this room");
    }

    if (roomState.presence !== "list") {
        throw new ClientSafeError("Member lists are disabled for this room");
    }

    const members = dedupeMembers(roomState).map((entry) => ({
        memberId: entry.memberId,
        memberProfile: entry.memberProfile,
    })) as Array<VisibleMemberFor<TRoom>>;
    const count = members.length;
    const offset = normalizePageOffset(query.offset, count);
    const limit = normalizePageLimit(query.limit, count);

    return {
        count,
        offset,
        limit,
        members: members.slice(offset, offset + limit),
    } as PresencePageFor<TRoom>;
}

function normalizePageOffset(value: number | undefined, count: number): number {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
        return 0;
    }

    return Math.min(Math.floor(value), count);
}

function normalizePageLimit(value: number | undefined, count: number): number {
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
        return Math.max(count, 0);
    }

    return Math.floor(value);
}

function dedupeMembers(roomState: RoomState<any>): Array<{ socketId: string; memberId: string; memberProfile: unknown }> {
    const seen = new Set<string>();
    const members: Array<{ socketId: string; memberId: string; memberProfile: unknown }> = [];

    for (const stored of roomState.membersBySocketId.values()) {
        if (seen.has(stored.memberId)) {
            continue;
        }

        seen.add(stored.memberId);
        members.push({
            socketId: stored.socketId,
            memberId: stored.memberId,
            memberProfile: stored.memberProfile,
        });
    }

    return members;
}

function allSocketIdsForNamespace(
    namespaceState: NamespaceState,
    name: string,
    excludeSocketId?: string,
): Set<string> {
    const socketIds = new Set<string>();
    const roomCollection = getRoomCollection(namespaceState, name);
    if (!roomCollection) {
        return socketIds;
    }

    for (const roomState of roomCollection.values()) {
        for (const stored of roomState.membersBySocketId.values()) {
            if (excludeSocketId && stored.socketId === excludeSocketId) {
                continue;
            }
            socketIds.add(stored.socketId);
        }
    }

    return socketIds;
}

function makeMemberSource<TRoom extends RoomDefinition<any>>(ctx: RoomServerContext<TRoom>): EventMetaFor<TRoom>["source"] {
    return {
        kind: "member",
        memberId: ctx.memberId,
        memberProfile: ctx.memberProfile,
    } as EventMetaFor<TRoom>["source"];
}

function getNamespaceState(socket: ServerSocketLike): NamespaceState {
    const existing = namespaceStates.get(socket.nsp);
    if (existing) {
        return existing;
    }

    const created: NamespaceState = {
        roomsByNameSpace: new Map(),
    };
    namespaceStates.set(socket.nsp, created);
    return created;
}

function getRoomCollection(namespaceState: NamespaceState, name: string): Map<string, RoomState<any>> | undefined {
    return namespaceState.roomsByNameSpace.get(name);
}

function getOrCreateRoomCollection(namespaceState: NamespaceState, name: string): Map<string, RoomState<any>> {
    const existing = getRoomCollection(namespaceState, name);
    if (existing) {
        return existing;
    }

    const created = new Map<string, RoomState<any>>();
    namespaceState.roomsByNameSpace.set(name, created);
    return created;
}

function getRoomState(namespaceState: NamespaceState, name: string, roomId: string): RoomState<any> {
    const roomState = getRoomCollection(namespaceState, name)?.get(roomId);
    if (!roomState) {
        throw new ClientSafeError("Unknown room");
    }

    return roomState;
}

function getStoredMembership(namespaceState: NamespaceState, name: string, roomId: string, socketId: string): StoredMember<any> | undefined {
    return getRoomCollection(namespaceState, name)?.get(roomId)?.membersBySocketId.get(socketId);
}

function removeMembership(namespaceState: NamespaceState, name: string, roomId: string, socketId: string): void {
    const roomCollection = getRoomCollection(namespaceState, name);
    const roomState = roomCollection?.get(roomId);
    const stored = roomState?.membersBySocketId.get(socketId);
    if (!roomState || !stored) {
        return;
    }

    roomState.membersBySocketId.delete(socketId);
    const socketIds = roomState.socketIdsByMemberId.get(stored.memberId);
    socketIds?.delete(socketId);
    if (socketIds && socketIds.size === 0) {
        roomState.socketIdsByMemberId.delete(stored.memberId);
    }

    if (roomState.membersBySocketId.size === 0) {
        roomCollection?.delete(roomId);
        if (roomCollection && roomCollection.size === 0) {
            namespaceState.roomsByNameSpace.delete(name);
        }
    }
}

function joinedRoomsForSocket(namespaceState: NamespaceState, socketId: string): Array<{ roomType: string; roomId: string }> {
    const rooms: Array<{ roomType: string; roomId: string }> = [];
    for (const [name, roomCollection] of namespaceState.roomsByNameSpace) {
        for (const [roomId, roomState] of roomCollection) {
            if (roomState.membersBySocketId.has(socketId)) {
                rooms.push({ roomType: name, roomId });
            }
        }
    }

    return rooms;
}

function allMemberIds(namespaceState: NamespaceState, name: string, roomId: string): string[] {
    return Array.from(getRoomCollection(namespaceState, name)?.get(roomId)?.socketIdsByMemberId.keys() ?? []);
}

function extractRoomId(payload: unknown): string {
    if (!payload || typeof payload !== "object" || typeof (payload as { roomId?: unknown }).roomId !== "string") {
        throw new ClientSafeError("Join request must include a string roomId");
    }

    return (payload as { roomId: string }).roomId;
}

function toErrorMessage(error: unknown): string {
    return error instanceof ClientSafeError ? error.message : "An internal server error occurred.";
}

function clampPresencePolicy(base: PresencePolicy, requested: PresencePolicy): PresencePolicy {
    const rank = (policy: PresencePolicy): number => {
        if (policy === "none") {
            return 0;
        }
        if (policy === "count") {
            return 1;
        }
        return 2;
    };

    return rank(requested) <= rank(base) ? requested : base;
}

function assertMatchingRoomName(room: RoomDefinition<any>, name: string): void {
    if (room.name !== name) {
        throw new ClientSafeError(`Expected namespace '${room.name}' but received '${name}'`);
    }
}

function assertMatchingRoomIds(joinRoomId: string, admissionRoomId: string, roomProfileRoomId: string): void {
    if (joinRoomId !== admissionRoomId) {
        throw new ClientSafeError("Admission roomId must match join request roomId");
    }

    if (roomProfileRoomId !== admissionRoomId) {
        throw new ClientSafeError("Admission roomProfile.roomId must match admission roomId");
    }
}
