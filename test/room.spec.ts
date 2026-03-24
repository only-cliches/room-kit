// @ts-nocheck
import { describe, expect, expectTypeOf, it } from "vitest";

import { ClientSafeError, createRoomClient, defineRoomType, serveRoomType } from "../src";
import type { ClientSocketLike, JoinedRoom, RoomDefinition, RoomServerAdapter, RoomServerHandlers, ServerSocketLike } from "../src";
import type { PresencePolicy } from "../src";

type Listener = (...args: any[]) => void;

class MockNamespace {
	private readonly sockets = new Map<string, MockClientSocket>();

	register(socket: MockClientSocket): void {
		this.sockets.set(socket.id, socket);
	}

	unregister(socket: MockClientSocket): void {
		const current = this.sockets.get(socket.id);
		if (current === socket) {
			this.sockets.delete(socket.id);
		}
	}

	to(roomOrSocketId: string): { emit(eventName: string, payload: unknown): void } {
		return {
			emit: (eventName: string, payload: unknown) => {
				this.sockets.get(roomOrSocketId)?.receive(eventName, payload);
			},
		};
	}
}

class MockServerSocket implements ServerSocketLike {
	readonly id: string;
	readonly nsp: MockNamespace;

	private readonly listeners = new Map<string, Set<Listener>>();
	readonly joinedRooms: string[] = [];
	readonly leftRooms: string[] = [];

	constructor(id: string, nsp: MockNamespace) {
		this.id = id;
		this.nsp = nsp;
	}

	emit(eventName: string, ...args: any[]): void {
		this.nsp.to(this.id).emit(eventName, args[0]);
	}

	on(eventName: string, handler: Listener): void {
		const handlers = this.listeners.get(eventName) ?? new Set<Listener>();
		handlers.add(handler);
		this.listeners.set(eventName, handlers);
	}

	off(eventName: string, handler: Listener): void {
		this.listeners.get(eventName)?.delete(handler);
	}

	join(room: string): void {
		this.joinedRooms.push(room);
	}

	leave(room: string): void {
		this.leftRooms.push(room);
	}

	receive(eventName: string, payload: unknown, ack?: Listener): void {
		for (const handler of this.listeners.get(eventName) ?? []) {
			handler(payload, ack);
		}
	}
}

class MockClientSocket implements ClientSocketLike {
	readonly id: string;

	private readonly listeners = new Map<string, Set<Listener>>();

	constructor(
		id: string,
		private readonly serverSocket: MockServerSocket,
		private readonly namespace: MockNamespace,
	) {
		this.id = id;
		this.namespace.register(this);
	}

	emit(eventName: string, ...args: any[]): void {
		const maybeAck = args.at(-1);
		const ack = typeof maybeAck === "function" ? (maybeAck as Listener) : undefined;
		this.serverSocket.receive(eventName, args[0], ack);
	}

	on(eventName: string, handler: Listener): void {
		const handlers = this.listeners.get(eventName) ?? new Set<Listener>();
		handlers.add(handler);
		this.listeners.set(eventName, handlers);
	}

	off(eventName: string, handler: Listener): void {
		this.listeners.get(eventName)?.delete(handler);
	}

	receive(eventName: string, payload: unknown): void {
		for (const handler of this.listeners.get(eventName) ?? []) {
			handler(payload);
		}
	}

	close(): void {
		this.namespace.unregister(this);
	}
}

class MockConnection {
	readonly serverSocket: MockServerSocket;
	readonly clientSocket: MockClientSocket;

	constructor(namespace: MockNamespace, id: string) {
		this.serverSocket = new MockServerSocket(id, namespace);
		this.clientSocket = new MockClientSocket(id, this.serverSocket, namespace);
	}

	close(): void {
		this.clientSocket.close();
	}
}

type ChatMessage = {
	id: string;
	name: string;
	text: string;
	sentAt: string;
};

type ChatRoomSchema = {
	joinRequest: {
		roomId: string;
		roomKey: string;
		userId: string;
		userName: string;
	};
	memberProfile: {
		userId: string;
		userName: string;
	};
	roomProfile: {
		roomId: string;
		created: string;
	};
	serverState: {
		roomKey: string;
		created: string;
		history: ChatMessage[];
	};
	events: {
		broadcastNotice: { text: string };
		roomNotice: { text: string };
		relay: { text: string };
		privateNotice: { text: string };
		message: { text: string };
	};
	rpc: {
		announce: (input: { text: string }) => Promise<void>;
		announceRoom: (input: { roomId: string; text: string }) => Promise<void>;
		sendMessage: (input: { text: string }) => Promise<{ id: string; historySize: number }>;
		whisper: (input: { targetMemberId: string; text: string }) => Promise<void>;
	};
};

type ChatRoomType<TPresence extends PresencePolicy = "list"> = RoomDefinition<ChatRoomSchema, TPresence>;

function createRoomType<TPresence extends PresencePolicy = "list">(name: string, presence: TPresence = "list" as TPresence): ChatRoomType<TPresence> {
	return defineRoomType<ChatRoomSchema, TPresence>({ name: name, presence });
}

function createClientPair<TRoom extends RoomDefinition<any, PresencePolicy>, TAuth = unknown>(
	namespace: MockNamespace,
	id: string,
	roomType: TRoom,
	handlers: RoomServerHandlers<any, TAuth>,
	adapter?: RoomServerAdapter,
) {
	const connection = new MockConnection(namespace, id);
	const stop = serveRoomType(connection.serverSocket, roomType, handlers, adapter);
	return {
		connection,
		stop,
		client: createRoomClient(connection.clientSocket, roomType),
	};
}

function createBaseHandlers(options: {
	initState?: (joinRequest: { roomId: string; roomKey: string; userId: string; userName: string }) => {
		roomKey: string;
		created: string;
		history: ChatMessage[];
	} | Promise<{
		roomKey: string;
		created: string;
		history: ChatMessage[];
	}>;
	admit?: (joinRequest: { roomId: string; roomKey: string; userId: string; userName: string }, ctx: any) => Promise<any> | any;
	onJoin?: (memberProfile: { userId: string; userName: string }, ctx: any) => Promise<void> | void;
	onLeave?: (memberProfile: { userId: string; userName: string }, ctx: any) => Promise<void> | void;
	rpc?: {
		sendMessage?: (input: { text: string }, ctx: any) => Promise<{ id: string; historySize: number }> | { id: string; historySize: number };
		whisper?: (input: { targetMemberId: string; text: string }, ctx: any) => Promise<void> | void;
	};
} = {}) {
	return {
		initState: options.initState ?? (() => ({
			roomKey: "shared-key",
			created: "2026-03-23T00:00:00.000Z",
			history: [],
		})),
		admit: options.admit ?? ((join: any) => ({
			roomId: join.roomId,
			memberId: join.userId,
			memberProfile: {
				userId: join.userId,
				userName: join.userName,
			},
			roomProfile: {
				roomId: join.roomId,
				created: "2026-03-23T00:00:00.000Z",
			},
		})),
		onJoin: options.onJoin,
		onLeave: options.onLeave,
		events: {
			relay: async () => undefined,
		},
		rpc: {
			announce: async ({ text }, ctx: any) => {
				await ctx.broadcast.emit.broadcastNotice({ text });
			},
			announceRoom: async ({ roomId, text }, ctx: any) => {
				await ctx.broadcast.toRoom(roomId).emit.roomNotice({ text });
			},
			sendMessage: options.rpc?.sendMessage ?? (async ({ text }, ctx: any) => {
				const message = {
					id: `message-${ctx.serverState.history.length + 1}`,
					name: ctx.memberProfile.userName,
					text,
					sentAt: "2026-03-23T00:00:00.000Z",
				};
				ctx.serverState.history.push(message);
				await ctx.emit.message({ text });
				return {
					id: message.id,
					historySize: ctx.serverState.history.length,
				};
			}),
			whisper: options.rpc?.whisper ?? (async ({ targetMemberId, text }, ctx: any) => {
				await ctx.broadcast.toMembers([targetMemberId]).emit.privateNotice({ text });
			}),
		},
	} satisfies RoomServerHandlers<any>;
}

describe("room kit", () => {
	it("rejects admission failures", async () => {
		const namespace = new MockNamespace();
		const roomType = createRoomType("reject-admission");
		const handlers = createBaseHandlers({
			admit: async () => {
				throw new ClientSafeError("forbidden");
			},
		});
		const { client, connection, stop } = createClientPair(namespace, "alice-socket", roomType, handlers);

		await expect(
			client.join({
				roomId: "room-1",
				roomKey: "shared-key",
				userId: "alice",
				userName: "Ada",
			}),
		).rejects.toThrow("forbidden");

		expect(connection.serverSocket.joinedRooms).toEqual([]);

		stop();
		connection.close();
	});

	it("keeps namespaces isolated", async () => {
		const namespace = new MockNamespace();
		const roomTypeA = createRoomType("namespace-a");
		const roomTypeB = createRoomType("namespace-b");
		const handlersA = createBaseHandlers();
		const handlersB = createBaseHandlers();
		const { client: clientA, connection: connectionA, stop: stopA } = createClientPair(namespace, "a-socket", roomTypeA, handlersA);
		const { client: clientB, connection: connectionB, stop: stopB } = createClientPair(namespace, "b-socket", roomTypeB, handlersB);

		const roomA = await clientA.join({
			roomId: "room-1",
			roomKey: "shared-key",
			userId: "alice",
			userName: "Ada",
		});
		const roomB = await clientB.join({
			roomId: "room-1",
			roomKey: "shared-key",
			userId: "bob",
			userName: "Ben",
		});

		const seenA: string[] = [];
		const seenB: string[] = [];
		roomA.on.message((payload) => seenA.push(payload.text));
		roomB.on.message((payload) => seenB.push(payload.text));

		await roomA.rpc.sendMessage({ text: "only-a" });
		expect(seenA).toEqual(["only-a"]);
		expect(seenB).toEqual([]);

		stopA();
		stopB();
		connectionA.close();
		connectionB.close();
	});

	it("reuses room state and initState only once", async () => {
		const namespace = new MockNamespace();
		const roomType = createRoomType("state-reuse");
		let initCount = 0;
		const handlers = createBaseHandlers({
			initState: () => {
				initCount += 1;
				return {
					roomKey: "shared-key",
					created: "2026-03-23T00:00:00.000Z",
					history: [],
				};
			},
		});
		const first = createClientPair(namespace, "alice-socket", roomType, handlers);
		const second = createClientPair(namespace, "bob-socket", roomType, handlers);

		const aliceRoom = await first.client.join({
			roomId: "room-1",
			roomKey: "shared-key",
			userId: "alice",
			userName: "Ada",
		});
		const bobRoom = await second.client.join({
			roomId: "room-1",
			roomKey: "shared-key",
			userId: "bob",
			userName: "Ben",
		});

		expect(initCount).toBe(1);
			expect(aliceRoom.roomProfile.created).toBe("2026-03-23T00:00:00.000Z");
			expect(bobRoom.roomProfile.created).toBe("2026-03-23T00:00:00.000Z");

		first.stop();
		second.stop();
		first.connection.close();
		second.connection.close();
	});

	it("supports targeted delivery to specific members", async () => {
		const namespace = new MockNamespace();
		const roomType = createRoomType("targeted-delivery");
		const handlers = createBaseHandlers();
		const first = createClientPair(namespace, "alice-socket", roomType, handlers);
		const second = createClientPair(namespace, "bob-socket", roomType, handlers);

		const aliceRoom = await first.client.join({
			roomId: "room-1",
			roomKey: "shared-key",
			userId: "alice",
			userName: "Ada",
		});
		const bobRoom = await second.client.join({
			roomId: "room-1",
			roomKey: "shared-key",
			userId: "bob",
			userName: "Ben",
		});

		const aliceNotices: string[] = [];
		const bobNotices: string[] = [];
		aliceRoom.on.privateNotice((payload) => aliceNotices.push(payload.text));
		bobRoom.on.privateNotice((payload) => bobNotices.push(payload.text));

		await bobRoom.rpc.whisper({
			targetMemberId: "alice",
			text: "private hello",
		});

		expect(aliceNotices).toEqual(["private hello"]);
		expect(bobNotices).toEqual([]);

		first.stop();
		second.stop();
		first.connection.close();
		second.connection.close();
	});

	it("supports broadcast operators and custom adapter delivery", async () => {
		const namespace = new MockNamespace();
		const roomType = createRoomType("broadcast-operators");
		const adapterCalls: Array<{ socketIds: string[]; eventName: string; payload: unknown }> = [];
		const adapter: RoomServerAdapter = {
			emitToSocketIds(socketIds, eventName, payload) {
				adapterCalls.push({
					socketIds: [...socketIds],
					eventName,
					payload,
				});
				for (const socketId of socketIds) {
					namespace.to(socketId).emit(eventName, payload);
				}
			},
		};
		const handlers = createBaseHandlers();
		const first = createClientPair(namespace, "alice-socket", roomType, handlers, adapter);
		const second = createClientPair(namespace, "bob-socket", roomType, handlers, adapter);

		const aliceRoom = await first.client.join({
			roomId: "room-1",
			roomKey: "shared-key",
			userId: "alice",
			userName: "Ada",
		});
		const bobRoom = await second.client.join({
			roomId: "room-1",
			roomKey: "shared-key",
			userId: "bob",
			userName: "Ben",
		});

		const aliceBroadcasts: string[] = [];
		const bobBroadcasts: string[] = [];
		const aliceRoomNotices: string[] = [];
		const bobRoomNotices: string[] = [];

		aliceRoom.on.broadcastNotice((payload) => aliceBroadcasts.push(payload.text));
		bobRoom.on.broadcastNotice((payload) => bobBroadcasts.push(payload.text));
		aliceRoom.on.roomNotice((payload) => aliceRoomNotices.push(payload.text));
		bobRoom.on.roomNotice((payload) => bobRoomNotices.push(payload.text));

		await aliceRoom.rpc.announce({ text: "namespace wide" });
		expect(aliceBroadcasts).toEqual([]);
		expect(bobBroadcasts).toEqual(["namespace wide"]);
		expect(adapterCalls.at(-1)?.socketIds).toEqual(["bob-socket"]);

		await bobRoom.rpc.announceRoom({ roomId: "room-1", text: "room scoped" });
		expect(aliceRoomNotices).toEqual(["room scoped"]);
		expect(bobRoomNotices).toEqual([]);

		first.stop();
		second.stop();
		first.connection.close();
		second.connection.close();
	});

	it("reports presence counts and paginated member lists", async () => {
		const namespace = new MockNamespace();
		const roomType = createRoomType("presence-pages", "list");
		const handlers = createBaseHandlers();
		const first = createClientPair(namespace, "alice-socket", roomType, handlers);
		const second = createClientPair(namespace, "bob-socket", roomType, handlers);
		const third = createClientPair(namespace, "carol-socket", roomType, handlers);

		const aliceRoom = await first.client.join({
			roomId: "room-1",
			roomKey: "shared-key",
			userId: "alice",
			userName: "Ada",
		});
		await second.client.join({
			roomId: "room-1",
			roomKey: "shared-key",
			userId: "bob",
			userName: "Ben",
		});
		await third.client.join({
			roomId: "room-1",
			roomKey: "shared-key",
			userId: "carol",
			userName: "Cid",
		});

		expect(await aliceRoom.presence.count()).toBe(3);
		expect(await aliceRoom.presence.list({ offset: 0, limit: 2 })).toMatchObject({
			count: 3,
			offset: 0,
			limit: 2,
			members: [
				{ memberId: "alice" },
				{ memberId: "bob" },
			],
		});
		expect(await aliceRoom.presence.list({ offset: 2, limit: 2 })).toMatchObject({
			count: 3,
			offset: 2,
			limit: 2,
			members: [
				{ memberId: "carol" },
			],
		});

		first.stop();
		second.stop();
		third.stop();
		first.connection.close();
		second.connection.close();
		third.connection.close();
	});

	it("dedupes presence counts for repeated member ids", async () => {
		const namespace = new MockNamespace();
		const roomType = createRoomType("presence-dedupe", "list");
		const handlers = createBaseHandlers();
		const first = createClientPair(namespace, "alice-socket-1", roomType, handlers);
		const second = createClientPair(namespace, "alice-socket-2", roomType, handlers);
		const third = createClientPair(namespace, "bob-socket", roomType, handlers);

		const primaryRoom = await first.client.join({
			roomId: "room-1",
			roomKey: "shared-key",
			userId: "alice",
			userName: "Ada",
		});
		await second.client.join({
			roomId: "room-1",
			roomKey: "shared-key",
			userId: "alice",
			userName: "Ada",
		});
		await third.client.join({
			roomId: "room-1",
			roomKey: "shared-key",
			userId: "bob",
			userName: "Ben",
		});

		expect(await primaryRoom.presence.count()).toBe(2);
		expect(await primaryRoom.presence.list()).toMatchObject({
			count: 2,
			members: [
				{ memberId: "alice" },
				{ memberId: "bob" },
			],
		});

		first.stop();
		second.stop();
		third.stop();
		first.connection.close();
		second.connection.close();
		third.connection.close();
	});

	it("cleans up on leave and disconnect", async () => {
		const namespace = new MockNamespace();
		const roomType = createRoomType("cleanup");
		const handlers = createBaseHandlers();
		const first = createClientPair(namespace, "alice-socket", roomType, handlers);
		const second = createClientPair(namespace, "bob-socket", roomType, handlers);

		const aliceRoom = await first.client.join({
			roomId: "room-1",
			roomKey: "shared-key",
			userId: "alice",
			userName: "Ada",
		});
		const bobRoom = await second.client.join({
			roomId: "room-1",
			roomKey: "shared-key",
			userId: "bob",
			userName: "Ben",
		});

		const seen: string[] = [];
		aliceRoom.on.message((payload) => seen.push(payload.text));

		await bobRoom.rpc.sendMessage({ text: "first" });
		expect(seen).toEqual(["first"]);

		await aliceRoom.leave();
		await bobRoom.rpc.sendMessage({ text: "after-leave" });
		expect(seen).toEqual(["first"]);
		expect(first.connection.serverSocket.leftRooms).toEqual(["room-1"]);

		const rejoinedAliceRoom = await first.client.join({
			roomId: "room-1",
			roomKey: "shared-key",
			userId: "alice",
			userName: "Ada",
		});
		const rejoinedSeen: string[] = [];
		rejoinedAliceRoom.on.message((payload) => rejoinedSeen.push(payload.text));
		first.connection.serverSocket.receive("disconnect", undefined);

		await bobRoom.rpc.sendMessage({ text: "after-disconnect" });
		expect(rejoinedSeen).toEqual([]);

		first.stop();
		second.stop();
		first.connection.close();
		second.connection.close();
	});

	it("replays joined rooms after reconnect", async () => {
		const namespace = new MockNamespace();
		const roomType = createRoomType("reconnect");
		const handlers = createBaseHandlers();
		const first = createClientPair(namespace, "alice-socket", roomType, handlers);
		const second = createClientPair(namespace, "bob-socket", roomType, handlers);

		const aliceRoom = await first.client.join({
			roomId: "room-1",
			roomKey: "shared-key",
			userId: "alice",
			userName: "Ada",
		});
		const bobRoom = await second.client.join({
			roomId: "room-1",
			roomKey: "shared-key",
			userId: "bob",
			userName: "Ben",
		});

		const seen: string[] = [];
		aliceRoom.on.message((payload) => seen.push(payload.text));

		await bobRoom.rpc.sendMessage({ text: "before reconnect" });
		expect(seen).toEqual(["before reconnect"]);

		first.connection.serverSocket.receive("disconnect", undefined);
		first.connection.clientSocket.receive("connect", undefined);
		await new Promise<void>((resolve) => setTimeout(resolve, 0));

		await bobRoom.rpc.sendMessage({ text: "after reconnect" });
		expect(seen).toEqual(["before reconnect", "after reconnect"]);
		expect(first.connection.serverSocket.joinedRooms).toEqual(["room-1", "room-1"]);

		first.stop();
		second.stop();
		first.connection.close();
		second.connection.close();
	});

	it("exposes server room snapshots and member pages", async () => {
		const namespace = new MockNamespace();
		const roomType = createRoomType("introspection", "list");
		const handlers = createBaseHandlers();
		const first = createClientPair(namespace, "alice-socket", roomType, handlers);
		const second = createClientPair(namespace, "bob-socket", roomType, handlers);

		const serverHandle = first.stop;
		await first.client.join({
			roomId: "room-1",
			roomKey: "shared-key",
			userId: "alice",
			userName: "Ada",
		});
		await second.client.join({
			roomId: "room-1",
			roomKey: "shared-key",
			userId: "bob",
			userName: "Ben",
		});

		expect(serverHandle.count("room-1")).toBe(2);
		expect(serverHandle.rooms()).toHaveLength(1);
		expect(serverHandle.room("room-1")).toMatchObject({
			roomId: "room-1",
			memberCount: 2,
			presence: {
				count: 2,
			},
		});
		expect(serverHandle.members("room-1", { offset: 0, limit: 1 })).toMatchObject({
			count: 2,
			offset: 0,
			limit: 1,
			members: [
				{ memberId: "alice" },
			],
		});

		first.stop();
		second.stop();
		first.connection.close();
		second.connection.close();
	});

	it("includes source metadata for server and member events", async () => {
		const namespace = new MockNamespace();
		const roomType = createRoomType("source-meta", "list");
		const handlers = createBaseHandlers();
		const first = createClientPair(namespace, "alice-socket", roomType, handlers);
		const second = createClientPair(namespace, "bob-socket", roomType, handlers);

		const aliceRoom = await first.client.join({
			roomId: "room-1",
			roomKey: "shared-key",
			userId: "alice",
			userName: "Ada",
		});
		const bobRoom = await second.client.join({
			roomId: "room-1",
			roomKey: "shared-key",
			userId: "bob",
			userName: "Ben",
		});

		const sources: Array<{ text: string; sourceKind: string; memberId?: string }> = [];
		aliceRoom.on.relay((payload, meta) => {
			sources.push({
				text: payload.text,
				sourceKind: meta.source.kind,
				memberId: meta.source.kind === "member" ? meta.source.memberId : undefined,
			});
		});
		aliceRoom.on.message((payload, meta) => {
			sources.push({
				text: payload.text,
				sourceKind: meta.source.kind,
				memberId: meta.source.kind === "member" ? meta.source.memberId : undefined,
			});
		});

		await aliceRoom.emit.relay({ text: "from-alice" });
		await bobRoom.rpc.sendMessage({ text: "from-server" });

		expect(sources).toEqual([
			{
				text: "from-alice",
				sourceKind: "member",
				memberId: "alice",
			},
			{
				text: "from-server",
				sourceKind: "server",
			},
		]);

		first.stop();
		second.stop();
		first.connection.close();
		second.connection.close();
	});

	it("rejects mismatched room ids", async () => {
		const namespace = new MockNamespace();
		const roomType = createRoomType("mismatched-room-id");
		const handlers = createBaseHandlers({
			admit: async (join) => ({
				roomId: `${join.roomId}-other`,
				memberId: join.userId,
				memberProfile: {
					userId: join.userId,
					userName: join.userName,
				},
				roomProfile: {
					roomId: `${join.roomId}-other`,
					created: "2026-03-23T00:00:00.000Z",
				},
			}),
		});
		const { client, connection, stop } = createClientPair(namespace, "alice-socket", roomType, handlers);

		await expect(
			client.join({
				roomId: "room-1",
				roomKey: "shared-key",
				userId: "alice",
				userName: "Ada",
			}),
		).rejects.toThrow("Admission roomId must match join request roomId");

		stop();
		connection.close();
	});

	it("rejects when onAuth fails", async () => {
		const namespace = new MockNamespace();
		const roomType = createRoomType("reject-auth", "list");
		const handlers: RoomServerHandlers<typeof roomType, { userId: string }> = {
			onAuth: async () => {
				throw new ClientSafeError("unauthorized");
			},
			initState: async () => ({
				roomKey: "shared-key",
				created: "2026-03-23T00:00:00.000Z",
				history: [],
			}),
			admit: async () => {
				throw new ClientSafeError("should not admit");
			},
		};
		const { client, connection, stop } = createClientPair(namespace, "alice-socket", roomType, handlers);

		await expect(
			client.join({
				roomId: "room-1",
				roomKey: "shared-key",
				userId: "alice",
				userName: "Ada",
			}),
		).rejects.toThrow("unauthorized");

		stop();
		connection.close();
	});

	it("calls onAuth once and exposes auth in handlers", async () => {
		const namespace = new MockNamespace();
		type Auth = {
			userId: string;
			token: string;
		};

		type AuthRoomSchema = {
			joinRequest: {
				roomId: string;
				roomKey: string;
				userName: string;
			};
			memberProfile: {
				userId: string;
				userName: string;
			};
			roomProfile: {
				roomId: string;
				created: string;
			};
			serverState: {
				roomKey: string;
				created: string;
			};
			events: {
				message: { text: string };
			};
			rpc: {
				sendMessage: (input: { text: string }) => Promise<void>;
			};
		};

		const roomType = defineRoomType<AuthRoomSchema, "count">({ name: "auth-hooks", presence: "count" });
		let authCalls = 0;
		const handlers: RoomServerHandlers<typeof roomType, Auth> = {
			onAuth: async () => {
				authCalls += 1;
				return {
					userId: "alice",
					token: "trusted-token",
				};
			},
			initState: async () => ({
				roomKey: "shared-key",
				created: "2026-03-23T00:00:00.000Z",
			}),
			admit: async (join, ctx) => {
				expect(ctx.auth).toEqual({
					userId: "alice",
					token: "trusted-token",
				});
				expect(join.userName).toBe("Ada");

				return {
					roomId: join.roomId,
					memberId: ctx.auth.userId,
					memberProfile: {
						userId: ctx.auth.userId,
						userName: join.userName,
					},
					roomProfile: {
						roomId: join.roomId,
						created: ctx.serverState.created,
					},
				};
			},
			rpc: {
				sendMessage: async ({ text }, ctx) => {
					expect(ctx.auth).toEqual({
						userId: "alice",
						token: "trusted-token",
					});
					expect(text).toBe("hello");
				},
			},
		};

		const { client, connection, stop } = createClientPair(namespace, "alice-socket", roomType, handlers);

		const firstRoom = await client.join({
			roomId: "room-1",
			roomKey: "shared-key",
			userName: "Ada",
		});

		await firstRoom.rpc.sendMessage({ text: "hello" });

		await client.join({
			roomId: "room-2",
			roomKey: "shared-key",
			userName: "Ada",
		});

		expect(authCalls).toBe(1);

		stop();
		connection.close();
	});

	it("calls onConnect once with resolved auth", async () => {
		const namespace = new MockNamespace();
		type Auth = {
			userId: string;
		};
		const roomType = createRoomType("on-connect", "count");
		const connected: Array<{ socketId: string; auth: Auth }> = [];
		let authCalls = 0;
		const handlers: RoomServerHandlers<typeof roomType, Auth> = {
			onAuth: async () => {
				authCalls += 1;
				return { userId: "alice" };
			},
			onConnect: (socket, auth) => {
				connected.push({
					socketId: socket.id,
					auth,
				});
			},
			admit: async (join, ctx) => ({
				roomId: join.roomId,
				memberId: ctx.auth.userId,
				memberProfile: {
					userId: ctx.auth.userId,
					userName: join.userName,
				},
				roomProfile: {
					roomId: join.roomId,
					created: "2026-03-23T00:00:00.000Z",
				},
			}),
		};

		const { connection, stop } = createClientPair(namespace, "alice-socket", roomType, handlers);

		await new Promise<void>((resolve) => setTimeout(resolve, 0));

		expect(connected).toEqual([
			{
				socketId: "alice-socket",
				auth: { userId: "alice" },
			},
		]);
		expect(authCalls).toBe(1);

		stop();
		connection.close();
	});

	it("calls onDisconnect once with resolved auth", async () => {
		const namespace = new MockNamespace();
		type Auth = {
			userId: string;
		};
		const roomType = createRoomType("on-disconnect", "count");
		const disconnected: Array<{ socketId: string; auth: Auth }> = [];
		let authCalls = 0;
		const handlers: RoomServerHandlers<typeof roomType, Auth> = {
			onAuth: async () => {
				authCalls += 1;
				return { userId: "alice" };
			},
			onDisconnect: (socket, auth) => {
				disconnected.push({
					socketId: socket.id,
					auth,
				});
			},
			admit: async (join, ctx) => ({
				roomId: join.roomId,
				memberId: ctx.auth.userId,
				memberProfile: {
					userId: ctx.auth.userId,
					userName: join.userName,
				},
				roomProfile: {
					roomId: join.roomId,
					created: "2026-03-23T00:00:00.000Z",
				},
			}),
		};

		const { client, connection, stop } = createClientPair(namespace, "alice-socket", roomType, handlers);
		await client.join({
			roomId: "room-1",
			roomKey: "shared-key",
			userId: "alice",
			userName: "Ada",
		});

		connection.serverSocket.receive("disconnect", undefined);
		await new Promise<void>((resolve) => setTimeout(resolve, 0));

		expect(disconnected).toEqual([
			{
				socketId: "alice-socket",
				auth: { userId: "alice" },
			},
		]);
		expect(authCalls).toBe(1);

		stop();
		connection.close();
	});

	it("supports per-request auth revalidation", async () => {
		const namespace = new MockNamespace();
		type Auth = {
			userId: string;
			sessionVersion: number;
		};
		const roomType = createRoomType("auth-revalidate", "count");
		let authCalls = 0;
		let revalidateCalls = 0;
		let revoked = false;
		const handlers: RoomServerHandlers<typeof roomType, Auth> = {
			onAuth: async () => {
				authCalls += 1;
				return {
					userId: "alice",
					sessionVersion: 1,
				};
			},
			revalidateAuth: async () => {
				revalidateCalls += 1;
				if (revoked) {
					return {
						kind: "reject",
						message: "session expired",
					};
				}

				return {
					kind: "ok",
				};
			},
			admit: async (join, ctx) => ({
				roomId: join.roomId,
				memberId: ctx.auth.userId,
				memberProfile: {
					userId: ctx.auth.userId,
					userName: join.userName,
				},
				roomProfile: {
					roomId: join.roomId,
					created: "2026-03-23T00:00:00.000Z",
				},
			}),
			rpc: {
				sendMessage: async () => {
					return {
						id: "message-1",
						historySize: 1,
					};
				},
			},
		};
		const { client, connection, stop } = createClientPair(namespace, "alice-socket", roomType, handlers);

		const joined = await client.join({
			roomId: "room-1",
			roomKey: "shared-key",
			userId: "alice",
			userName: "Ada",
		});
		expect(authCalls).toBe(1);
		expect(revalidateCalls).toBe(1);

		revoked = true;
		await expect(joined.rpc.sendMessage({ text: "hello" })).rejects.toThrow("session expired");
		expect(revalidateCalls).toBe(2);

		stop();
		connection.close();
	});

	it("supports auth rotation via revalidateAuth", async () => {
		const namespace = new MockNamespace();
		type Auth = {
			userId: string;
			version: number;
		};
		const roomType = createRoomType("auth-revalidate-rotation", "count");
		let authCalls = 0;
		let revalidateCalls = 0;
		let observedRpcAuthVersion = 0;
		const handlers: RoomServerHandlers<typeof roomType, Auth> = {
			onAuth: async () => {
				authCalls += 1;
				return {
					userId: "alice",
					version: 1,
				};
			},
			revalidateAuth: async (_socket, auth) => {
				revalidateCalls += 1;
				return {
					kind: "ok",
					auth: {
						...auth,
						version: auth.version + 1,
					},
				};
			},
			admit: async (join, ctx) => ({
				roomId: join.roomId,
				memberId: ctx.auth.userId,
				memberProfile: {
					userId: ctx.auth.userId,
					userName: join.userName,
				},
				roomProfile: {
					roomId: join.roomId,
					created: "2026-03-23T00:00:00.000Z",
				},
			}),
			rpc: {
				sendMessage: async (_input, ctx) => {
					observedRpcAuthVersion = ctx.auth.version;
					return {
						id: "message-1",
						historySize: 1,
					};
				},
			},
		};
		const { client, connection, stop } = createClientPair(namespace, "alice-socket", roomType, handlers);

		const joined = await client.join({
			roomId: "room-1",
			roomKey: "shared-key",
			userId: "alice",
			userName: "Ada",
		});
		await joined.rpc.sendMessage({ text: "hello" });

		expect(authCalls).toBe(1);
		expect(revalidateCalls).toBe(2);
		expect(observedRpcAuthVersion).toBe(3);

		stop();
		connection.close();
	});

	it("runs revalidateAuth on each presence query", async () => {
		const namespace = new MockNamespace();
		type Auth = {
			userId: string;
		};
		const roomType = createRoomType("auth-revalidate-presence", "list");
		let revalidateCalls = 0;
		const handlers: RoomServerHandlers<typeof roomType, Auth> = {
			...createBaseHandlers(),
			onAuth: async () => ({ userId: "alice" }),
			revalidateAuth: async () => {
				revalidateCalls += 1;
				return { kind: "ok" };
			},
		};
		const pair = createClientPair(namespace, "alice-socket", roomType, handlers);
		const room = await pair.client.join({
			roomId: "room-1",
			roomKey: "shared-key",
			userId: "alice",
			userName: "Ada",
		});

		await room.presence.count();
		await room.presence.list({ offset: 0, limit: 10 });

		expect(revalidateCalls).toBe(3);

		pair.stop();
		pair.connection.close();
	});

	it("blocks client events when revalidateAuth rejects", async () => {
		const namespace = new MockNamespace();
		type Auth = {
			userId: string;
		};
		const roomType = createRoomType("auth-revalidate-client-event", "count");
		let revoked = false;
		let relayCalls = 0;
		const handlers: RoomServerHandlers<typeof roomType, Auth> = {
			...createBaseHandlers(),
			onAuth: async () => ({ userId: "alice" }),
			revalidateAuth: async () => {
				if (revoked) {
					return {
						kind: "reject",
						message: "session expired",
					};
				}
				return {
					kind: "ok",
				};
			},
			events: {
				relay: async () => {
					relayCalls += 1;
				},
			},
		};
		const pair = createClientPair(namespace, "alice-socket", roomType, handlers);
		const room = await pair.client.join({
			roomId: "room-1",
			roomKey: "shared-key",
			userId: "alice",
			userName: "Ada",
		});

		revoked = true;
		await expect(room.emit.relay({ text: "blocked" })).rejects.toThrow("session expired");
		expect(relayCalls).toBe(0);

		pair.stop();
		pair.connection.close();
	});

	it("runs onDisconnect before per-room onLeave callbacks", async () => {
		const namespace = new MockNamespace();
		type Auth = {
			userId: string;
		};
		const roomType = createRoomType("disconnect-ordering", "count");
		const sequence: string[] = [];
		const handlers: RoomServerHandlers<typeof roomType, Auth> = {
			...createBaseHandlers(),
			onAuth: async () => ({ userId: "alice" }),
			onDisconnect: async () => {
				sequence.push("onDisconnect");
			},
			onLeave: async (member) => {
				sequence.push(`onLeave:${member.userId}`);
			},
		};
		const pair = createClientPair(namespace, "alice-socket", roomType, handlers);
		await pair.client.join({
			roomId: "room-1",
			roomKey: "shared-key",
			userId: "alice",
			userName: "Ada",
		});

		pair.connection.serverSocket.receive("disconnect", undefined);
		await new Promise<void>((resolve) => setTimeout(resolve, 0));

		expect(sequence).toEqual(["onDisconnect", "onLeave:alice"]);

		pair.stop();
		pair.connection.close();
	});

	it("keeps disconnect cleanup active when onDisconnect throws", async () => {
		const namespace = new MockNamespace();
		type Auth = {
			userId: string;
		};
		const roomType = createRoomType("disconnect-error-isolation", "list");
		const handlers: RoomServerHandlers<typeof roomType, Auth> = {
			...createBaseHandlers(),
			onAuth: async () => ({ userId: "alice" }),
			onDisconnect: async () => {
				throw new Error("disconnect observer failed");
			},
		};
		const alice = createClientPair(namespace, "alice-socket", roomType, handlers);
		const bob = createClientPair(namespace, "bob-socket", roomType, handlers);

		await alice.client.join({
			roomId: "room-1",
			roomKey: "shared-key",
			userId: "alice",
			userName: "Ada",
		});
		const bobRoom = await bob.client.join({
			roomId: "room-1",
			roomKey: "shared-key",
			userId: "bob",
			userName: "Ben",
		});
		expect(await bobRoom.presence.count()).toBe(2);

		alice.connection.serverSocket.receive("disconnect", undefined);
		await new Promise<void>((resolve) => setTimeout(resolve, 0));

		expect(await bobRoom.presence.count()).toBe(1);
		expect(bob.stop.count("room-1")).toBe(1);

		alice.stop();
		bob.stop();
		alice.connection.close();
		bob.connection.close();
	});

	it("does not block room operations when onConnect throws", async () => {
		const namespace = new MockNamespace();
		type Auth = {
			userId: string;
		};
		const roomType = createRoomType("on-connect-error", "count");
		const handlers: RoomServerHandlers<typeof roomType, Auth> = {
			...createBaseHandlers(),
			onAuth: async () => ({ userId: "alice" }),
			onConnect: async () => {
				throw new Error("connect hook failed");
			},
		};
		const pair = createClientPair(namespace, "alice-socket", roomType, handlers);

		const room = await pair.client.join({
			roomId: "room-1",
			roomKey: "shared-key",
			userId: "alice",
			userName: "Ada",
		});
		await expect(room.rpc.sendMessage({ text: "still-works" })).resolves.toMatchObject({
			id: "message-1",
		});

		pair.stop();
		pair.connection.close();
	});

	it("clears auth cache after revalidateAuth rejection and resolves auth again", async () => {
		const namespace = new MockNamespace();
		type Auth = {
			userId: string;
			token: string;
		};
		const roomType = createRoomType("auth-cache-reset-after-reject", "count");
		let authCalls = 0;
		let rejectNext = false;
		const handlers: RoomServerHandlers<typeof roomType, Auth> = {
			onAuth: async () => {
				authCalls += 1;
				return {
					userId: "alice",
					token: `token-${authCalls}`,
				};
			},
			revalidateAuth: async () => {
				if (rejectNext) {
					rejectNext = false;
					return {
						kind: "reject",
						message: "session expired",
					};
				}
				return {
					kind: "ok",
				};
			},
			admit: async (join, ctx) => ({
				roomId: join.roomId,
				memberId: ctx.auth.userId,
				memberProfile: {
					userId: ctx.auth.userId,
					userName: join.userName,
				},
				roomProfile: {
					roomId: join.roomId,
					created: "2026-03-23T00:00:00.000Z",
				},
			}),
			rpc: {
				sendMessage: async () => ({
					id: "message-1",
					historySize: 1,
				}),
			},
		};
		const pair = createClientPair(namespace, "alice-socket", roomType, handlers);
		const room = await pair.client.join({
			roomId: "room-1",
			roomKey: "shared-key",
			userId: "alice",
			userName: "Ada",
		});
		expect(authCalls).toBe(1);

		rejectNext = true;
		await expect(room.rpc.sendMessage({ text: "blocked" })).rejects.toThrow("session expired");
		await expect(room.rpc.sendMessage({ text: "after-refresh" })).resolves.toMatchObject({
			id: "message-1",
		});
		expect(authCalls).toBe(2);

		pair.stop();
		pair.connection.close();
	});

	it("calls onDisconnect once and onLeave per room for multi-room sockets", async () => {
		const namespace = new MockNamespace();
		type Auth = {
			userId: string;
		};
		const roomType = createRoomType("multi-room-disconnect-hooks", "count");
		let disconnectCalls = 0;
		const leftRoomIds: string[] = [];
		const handlers: RoomServerHandlers<typeof roomType, Auth> = {
			...createBaseHandlers(),
			onAuth: async () => ({ userId: "alice" }),
			onDisconnect: async () => {
				disconnectCalls += 1;
			},
			onLeave: async (_member, ctx) => {
				leftRoomIds.push(ctx.roomId);
			},
		};
		const pair = createClientPair(namespace, "alice-socket", roomType, handlers);
		await pair.client.join({
			roomId: "room-1",
			roomKey: "shared-key",
			userId: "alice",
			userName: "Ada",
		});
		await pair.client.join({
			roomId: "room-2",
			roomKey: "shared-key",
			userId: "alice",
			userName: "Ada",
		});

		pair.connection.serverSocket.receive("disconnect", undefined);
		await new Promise<void>((resolve) => setTimeout(resolve, 0));

		expect(disconnectCalls).toBe(1);
		expect(leftRoomIds.slice().sort()).toEqual(["room-1", "room-2"]);

		pair.stop();
		pair.connection.close();
	});

	it("passes rotated auth to onDisconnect", async () => {
		const namespace = new MockNamespace();
		type Auth = {
			userId: string;
			version: number;
		};
		const roomType = createRoomType("disconnect-rotated-auth", "count");
		let disconnectVersion = 0;
		const handlers: RoomServerHandlers<typeof roomType, Auth> = {
			...createBaseHandlers(),
			onAuth: async () => ({
				userId: "alice",
				version: 1,
			}),
			revalidateAuth: async (_socket, auth) => ({
				kind: "ok",
				auth: {
					...auth,
					version: auth.version + 1,
				},
			}),
			onDisconnect: async (_socket, auth) => {
				disconnectVersion = auth.version;
			},
		};
		const pair = createClientPair(namespace, "alice-socket", roomType, handlers);
		const room = await pair.client.join({
			roomId: "room-1",
			roomKey: "shared-key",
			userId: "alice",
			userName: "Ada",
		});
		await room.rpc.sendMessage({ text: "before-disconnect" });

		pair.connection.serverSocket.receive("disconnect", undefined);
		await new Promise<void>((resolve) => setTimeout(resolve, 0));

		expect(disconnectVersion).toBe(4);

		pair.stop();
		pair.connection.close();
	});

	it("rejects presence.list when revalidateAuth rejects", async () => {
		const namespace = new MockNamespace();
		type Auth = {
			userId: string;
		};
		const roomType = createRoomType("presence-list-revalidate-reject", "list");
		let revoked = false;
		const handlers: RoomServerHandlers<typeof roomType, Auth> = {
			...createBaseHandlers(),
			onAuth: async () => ({ userId: "alice" }),
			revalidateAuth: async () => {
				if (revoked) {
					return {
						kind: "reject",
						message: "presence list blocked",
					};
				}
				return {
					kind: "ok",
				};
			},
		};

		const pair = createClientPair(namespace, "alice-socket", roomType, handlers);
		const room = await pair.client.join({
			roomId: "room-1",
			roomKey: "shared-key",
			userId: "alice",
			userName: "Ada",
		});

		revoked = true;
		await expect(room.presence.list({ offset: 0, limit: 10 })).rejects.toThrow("presence list blocked");

		pair.stop();
		pair.connection.close();
	});

	it("still removes membership when auth resolution fails during disconnect", async () => {
		const namespace = new MockNamespace();
		type Auth = {
			userId: string;
		};
		const roomType = createRoomType("disconnect-auth-failure-cleanup", "list");
		let rejectNext = false;
		let failAliceAuth = false;
		let onLeaveCalls = 0;
		const handlers: RoomServerHandlers<typeof roomType, Auth> = {
			...createBaseHandlers(),
			onAuth: async (socket) => {
				if (failAliceAuth && socket.id === "alice-socket") {
					throw new ClientSafeError("auth lookup failed");
				}
				return {
					userId: socket.id === "alice-socket" ? "alice" : "bob",
				};
			},
			revalidateAuth: async () => {
				if (rejectNext) {
					rejectNext = false;
					return {
						kind: "reject",
						message: "session expired",
					};
				}
				return {
					kind: "ok",
				};
			},
			onLeave: async () => {
				onLeaveCalls += 1;
			},
		};

		const alice = createClientPair(namespace, "alice-socket", roomType, handlers);
		const bob = createClientPair(namespace, "bob-socket", roomType, handlers);

		const aliceRoom = await alice.client.join({
			roomId: "room-1",
			roomKey: "shared-key",
			userId: "alice",
			userName: "Ada",
		});
		const bobRoom = await bob.client.join({
			roomId: "room-1",
			roomKey: "shared-key",
			userId: "bob",
			userName: "Ben",
		});
		expect(await bobRoom.presence.count()).toBe(2);

		rejectNext = true;
		await expect(aliceRoom.rpc.sendMessage({ text: "forces-clear" })).rejects.toThrow("session expired");
		failAliceAuth = true;

		alice.connection.serverSocket.receive("disconnect", undefined);
		await new Promise<void>((resolve) => setTimeout(resolve, 0));

		expect(await bobRoom.presence.count()).toBe(1);
		expect(onLeaveCalls).toBe(0);

		alice.stop();
		bob.stop();
		alice.connection.close();
		bob.connection.close();
	});

	it("surfaces ClientSafeError and sanitizes generic errors from revalidateAuth throws", async () => {
		const namespace = new MockNamespace();
		type Auth = {
			userId: string;
		};
		const roomType = createRoomType("revalidate-throw-errors", "count");
		let mode: "none" | "safe" | "generic" = "none";
		const handlers: RoomServerHandlers<typeof roomType, Auth> = {
			...createBaseHandlers(),
			onAuth: async () => ({ userId: "alice" }),
			revalidateAuth: async () => {
				if (mode === "safe") {
					throw new ClientSafeError("safe denial");
				}
				if (mode === "generic") {
					throw new Error("unexpected backend failure");
				}
				return {
					kind: "ok",
				};
			},
		};

		const pair = createClientPair(namespace, "alice-socket", roomType, handlers);
		const room = await pair.client.join({
			roomId: "room-1",
			roomKey: "shared-key",
			userId: "alice",
			userName: "Ada",
		});

		mode = "safe";
		await expect(room.rpc.sendMessage({ text: "safe" })).rejects.toThrow("safe denial");
		mode = "generic";
		await expect(room.rpc.sendMessage({ text: "generic" })).rejects.toThrow("An internal server error occurred.");

		pair.stop();
		pair.connection.close();
	});

	it("reuses a single onAuth refresh for concurrent RPCs after cache clear", async () => {
		const namespace = new MockNamespace();
		type Auth = {
			userId: string;
			token: string;
		};
		const roomType = createRoomType("concurrent-auth-refresh", "count");
		let onAuthCalls = 0;
		let rejectNext = false;
		const handlers: RoomServerHandlers<typeof roomType, Auth> = {
			onAuth: async () => {
				onAuthCalls += 1;
				return {
					userId: "alice",
					token: `token-${onAuthCalls}`,
				};
			},
			revalidateAuth: async () => {
				if (rejectNext) {
					rejectNext = false;
					return {
						kind: "reject",
						message: "session expired",
					};
				}
				return {
					kind: "ok",
				};
			},
			admit: async (join, ctx) => ({
				roomId: join.roomId,
				memberId: ctx.auth.userId,
				memberProfile: {
					userId: ctx.auth.userId,
					userName: join.userName,
				},
				roomProfile: {
					roomId: join.roomId,
					created: "2026-03-23T00:00:00.000Z",
				},
			}),
			rpc: {
				sendMessage: async () => ({
					id: "message-1",
					historySize: 1,
				}),
			},
		};

		const pair = createClientPair(namespace, "alice-socket", roomType, handlers);
		const room = await pair.client.join({
			roomId: "room-1",
			roomKey: "shared-key",
			userId: "alice",
			userName: "Ada",
		});
		expect(onAuthCalls).toBe(1);

		rejectNext = true;
		await expect(room.rpc.sendMessage({ text: "reject-once" })).rejects.toThrow("session expired");

		const [first, second] = await Promise.all([
			room.rpc.sendMessage({ text: "a" }),
			room.rpc.sendMessage({ text: "b" }),
		]);
		expect(first.id).toBe("message-1");
		expect(second.id).toBe("message-1");
		expect(onAuthCalls).toBe(2);

		pair.stop();
		pair.connection.close();
	});

	it("does not invoke lifecycle hooks after stop()", async () => {
		const namespace = new MockNamespace();
		type Auth = {
			userId: string;
		};
		const roomType = createRoomType("stop-detaches-hooks", "count");
		let onDisconnectCalls = 0;
		let onLeaveCalls = 0;
		const handlers: RoomServerHandlers<typeof roomType, Auth> = {
			...createBaseHandlers(),
			onAuth: async () => ({ userId: "alice" }),
			onDisconnect: async () => {
				onDisconnectCalls += 1;
			},
			onLeave: async () => {
				onLeaveCalls += 1;
			},
		};

		const pair = createClientPair(namespace, "alice-socket", roomType, handlers);
		await pair.client.join({
			roomId: "room-1",
			roomKey: "shared-key",
			userId: "alice",
			userName: "Ada",
		});

		pair.stop();
		pair.connection.serverSocket.receive("disconnect", undefined);
		await new Promise<void>((resolve) => setTimeout(resolve, 0));

		expect(onDisconnectCalls).toBe(0);
		expect(onLeaveCalls).toBe(0);

		pair.connection.close();
	});

	it("keeps same-member presence and delivery when one socket disconnects", async () => {
		const namespace = new MockNamespace();
		const roomType = createRoomType("same-member-multi-socket", "list");
		const handlers = createBaseHandlers();
		const alicePrimary = createClientPair(namespace, "alice-socket-1", roomType, handlers);
		const aliceSecondary = createClientPair(namespace, "alice-socket-2", roomType, handlers);
		const bob = createClientPair(namespace, "bob-socket", roomType, handlers);

		await alicePrimary.client.join({
			roomId: "room-1",
			roomKey: "shared-key",
			userId: "alice",
			userName: "Ada",
		});
		const aliceSecondaryRoom = await aliceSecondary.client.join({
			roomId: "room-1",
			roomKey: "shared-key",
			userId: "alice",
			userName: "Ada",
		});
		const bobRoom = await bob.client.join({
			roomId: "room-1",
			roomKey: "shared-key",
			userId: "bob",
			userName: "Ben",
		});
		expect(await bobRoom.presence.count()).toBe(2);

		alicePrimary.connection.serverSocket.receive("disconnect", undefined);
		await new Promise<void>((resolve) => setTimeout(resolve, 0));
		expect(await bobRoom.presence.count()).toBe(2);

		const seen: string[] = [];
		aliceSecondaryRoom.on.message((payload) => {
			seen.push(payload.text);
		});
		await bobRoom.rpc.sendMessage({ text: "still-here" });
		expect(seen).toEqual(["still-here"]);

		alicePrimary.stop();
		aliceSecondary.stop();
		bob.stop();
		alicePrimary.connection.close();
		aliceSecondary.connection.close();
		bob.connection.close();
	});

	it("keeps auth rotation monotonic across multiple operations", async () => {
		const namespace = new MockNamespace();
		type Auth = {
			userId: string;
			version: number;
		};
		const roomType = createRoomType("auth-rotation-monotonic", "list");
		const seen = {
			admit: 0,
			presence: [] as number[],
			rpc: [] as number[],
		};
		const handlers: RoomServerHandlers<typeof roomType, Auth> = {
			...createBaseHandlers(),
			onAuth: async () => ({
				userId: "alice",
				version: 0,
			}),
			revalidateAuth: async (_socket, auth) => ({
				kind: "ok",
				auth: {
					...auth,
					version: auth.version + 1,
				},
			}),
			admit: async (join, ctx) => {
				seen.admit = ctx.auth.version;
				return {
					roomId: join.roomId,
					memberId: ctx.auth.userId,
					memberProfile: {
						userId: ctx.auth.userId,
						userName: join.userName,
					},
					roomProfile: {
						roomId: join.roomId,
						created: "2026-03-23T00:00:00.000Z",
					},
				};
			},
			presencePolicy: (ctx) => {
				seen.presence.push(ctx.auth.version);
				return "list";
			},
			rpc: {
				sendMessage: async (_input, ctx) => {
					seen.rpc.push(ctx.auth.version);
					return {
						id: "message-1",
						historySize: 1,
					};
				},
			},
		};

		const pair = createClientPair(namespace, "alice-socket", roomType, handlers);
		const room = await pair.client.join({
			roomId: "room-1",
			roomKey: "shared-key",
			userId: "alice",
			userName: "Ada",
		});
		await room.presence.count();
		await room.rpc.sendMessage({ text: "one" });
		await room.presence.list({ offset: 0, limit: 10 });
		await room.rpc.sendMessage({ text: "two" });

		expect(seen.admit).toBe(1);
		expect(seen.presence).toEqual([2, 4]);
		expect(seen.rpc).toEqual([3, 5]);

		pair.stop();
		pair.connection.close();
	});

	it("keeps presence APIs out of the type surface when disabled", () => {
		const noneRoom = defineRoomType<{
			joinRequest: { roomId: string };
			roomProfile: { roomId: string };
		}, "none">({ name: "no-presence", presence: "none" });
		const countRoom = defineRoomType<{
			joinRequest: { roomId: string };
			roomProfile: { roomId: string };
		}, "count">({ name: "count-presence", presence: "count" });

		type NoneHasPresence = JoinedRoom<typeof noneRoom> extends { presence: unknown } ? true : false;
		type CountHasPresence = JoinedRoom<typeof countRoom> extends { presence: unknown } ? true : false;
		expectTypeOf<NoneHasPresence>().toEqualTypeOf<false>();
		expectTypeOf<CountHasPresence>().toEqualTypeOf<true>();
	});

	it("rejects presence queries when presence is disabled", async () => {
		const namespace = new MockNamespace();
		const roomType = createRoomType("presence-disabled", "none");
		const handlers = createBaseHandlers();
		const { client, connection, stop } = createClientPair(namespace, "alice-socket", roomType, handlers);

		const room = await client.join({
			roomId: "room-1",
			roomKey: "shared-key",
			userId: "alice",
			userName: "Ada",
		});

		await expect((room as any).presence.count()).rejects.toThrow("Presence is disabled for this room");
		await expect((room.presence as any).list()).rejects.toThrow("Presence is disabled for this room");
		expect(() => stop.count("room-1")).toThrow("Presence is disabled for this room");

		stop();
		connection.close();
	});

	it("rejects member lists when only count presence is enabled", async () => {
		const namespace = new MockNamespace();
		const roomType = createRoomType("presence-count-only", "count");
		const handlers = createBaseHandlers();
		const { client, connection, stop } = createClientPair(namespace, "alice-socket", roomType, handlers);

		const room = await client.join({
			roomId: "room-1",
			roomKey: "shared-key",
			userId: "alice",
			userName: "Ada",
		});

		await expect(room.presence.count()).resolves.toBe(1);
		await expect((room.presence as any).list()).rejects.toThrow("Member lists are disabled for this room");
		expect(() => stop.members("room-1")).toThrow("Member lists are disabled for this room");

		stop();
		connection.close();
	});

	it("rejects undeclared client events", async () => {
		const namespace = new MockNamespace();
		const roomType = createRoomType("unknown-client-event", "list");
		const handlers = createBaseHandlers();
		const { client, connection, stop } = createClientPair(namespace, "alice-socket", roomType, handlers);

		const room = await client.join({
			roomId: "room-1",
			roomKey: "shared-key",
			userId: "alice",
			userName: "Ada",
		});

		await expect((room.emit as any).doesNotExist({ text: "nope" })).rejects.toThrow("Unknown event 'doesNotExist'");

		stop();
		connection.close();
	});

	it("supports per-request presence policy overrides", async () => {
		const namespace = new MockNamespace();
		const roomType = createRoomType("presence-policy-override", "list");
		const handlers: RoomServerHandlers<typeof roomType> = {
			...createBaseHandlers(),
			presencePolicy: (ctx) => (ctx.memberId === "alice" ? "list" : "count"),
		};

		const alicePair = createClientPair(namespace, "alice-socket", roomType, handlers);
		const bobPair = createClientPair(namespace, "bob-socket", roomType, handlers);

		const aliceRoom = await alicePair.client.join({
			roomId: "room-1",
			roomKey: "shared-key",
			userId: "alice",
			userName: "Ada",
		});

		const bobRoom = await bobPair.client.join({
			roomId: "room-1",
			roomKey: "shared-key",
			userId: "bob",
			userName: "Ben",
		});

		await expect(aliceRoom.presence.count()).resolves.toBe(2);
		await expect(aliceRoom.presence.list({ offset: 0, limit: 10 })).resolves.toMatchObject({
			count: 2,
			members: [
				{ memberId: "alice" },
				{ memberId: "bob" },
			],
		});

		await expect(bobRoom.presence.count()).resolves.toBe(2);
		await expect((bobRoom.presence as any).list()).rejects.toThrow("Member lists are disabled for this room");

		alicePair.stop();
		bobPair.stop();
		alicePair.connection.close();
		bobPair.connection.close();
	});

	it("does not allow presencePolicy to escalate beyond room default", async () => {
		const namespace = new MockNamespace();
		const roomType = createRoomType("presence-no-escalation", "count");
		const handlers: RoomServerHandlers<typeof roomType> = {
			...createBaseHandlers(),
			presencePolicy: () => "list",
		};

		const alice = createClientPair(namespace, "alice-socket", roomType, handlers);
		const bob = createClientPair(namespace, "bob-socket", roomType, handlers);

		const aliceRoom = await alice.client.join({
			roomId: "room-1",
			roomKey: "shared-key",
			userId: "alice",
			userName: "Ada",
		});
		await bob.client.join({
			roomId: "room-1",
			roomKey: "shared-key",
			userId: "bob",
			userName: "Ben",
		});

		await expect(aliceRoom.presence.count()).resolves.toBe(2);
		await expect((aliceRoom.presence as any).list()).rejects.toThrow("Member lists are disabled for this room");

		alice.stop();
		bob.stop();
		alice.connection.close();
		bob.connection.close();
	});

	it("calls presencePolicy for each presence query request", async () => {
		const namespace = new MockNamespace();
		const roomType = createRoomType("presence-policy-called-per-request", "list");
		let calls = 0;
		const handlers: RoomServerHandlers<typeof roomType> = {
			...createBaseHandlers(),
			presencePolicy: () => {
				calls += 1;
				return "list";
			},
		};
		const pair = createClientPair(namespace, "alice-socket", roomType, handlers);
		const room = await pair.client.join({
			roomId: "room-1",
			roomKey: "shared-key",
			userId: "alice",
			userName: "Ada",
		});

		await room.presence.count();
		await room.presence.list({ offset: 0, limit: 10 });
		await room.presence.count();
		expect(calls).toBe(3);

		pair.stop();
		pair.connection.close();
	});

	it("returns ClientSafeError messages from presencePolicy", async () => {
		const namespace = new MockNamespace();
		const roomType = createRoomType("presence-policy-client-safe-error", "list");
		const handlers: RoomServerHandlers<typeof roomType> = {
			...createBaseHandlers(),
			presencePolicy: () => {
				throw new ClientSafeError("presence blocked");
			},
		};
		const pair = createClientPair(namespace, "alice-socket", roomType, handlers);
		const room = await pair.client.join({
			roomId: "room-1",
			roomKey: "shared-key",
			userId: "alice",
			userName: "Ada",
		});

		await expect(room.presence.count()).rejects.toThrow("presence blocked");

		pair.stop();
		pair.connection.close();
	});

	it("sanitizes non-ClientSafeError presencePolicy failures", async () => {
		const namespace = new MockNamespace();
		const roomType = createRoomType("presence-policy-sanitized-error", "list");
		const handlers: RoomServerHandlers<typeof roomType> = {
			...createBaseHandlers(),
			presencePolicy: () => {
				throw new Error("db down");
			},
		};
		const pair = createClientPair(namespace, "alice-socket", roomType, handlers);
		const room = await pair.client.join({
			roomId: "room-1",
			roomKey: "shared-key",
			userId: "alice",
			userName: "Ada",
		});

		await expect(room.presence.count()).rejects.toThrow("An internal server error occurred.");

		pair.stop();
		pair.connection.close();
	});

	it("supports auth-aware presencePolicy", async () => {
		const namespace = new MockNamespace();
		const roomType = createRoomType("presence-policy-auth-aware", "list");
		const handlers: RoomServerHandlers<typeof roomType, { role: "admin" | "member" }> = {
			...createBaseHandlers(),
			onAuth: (socket) => ({
				role: socket.id === "alice-socket" ? "admin" : "member",
			}),
			presencePolicy: (ctx) => (ctx.auth.role === "admin" ? "list" : "count"),
		};

		const alice = createClientPair(namespace, "alice-socket", roomType, handlers);
		const bob = createClientPair(namespace, "bob-socket", roomType, handlers);

		const aliceRoom = await alice.client.join({
			roomId: "room-1",
			roomKey: "shared-key",
			userId: "alice",
			userName: "Ada",
		});
		const bobRoom = await bob.client.join({
			roomId: "room-1",
			roomKey: "shared-key",
			userId: "bob",
			userName: "Ben",
		});

		await expect(aliceRoom.presence.list()).resolves.toMatchObject({ count: 2 });
		await expect((bobRoom.presence as any).list()).rejects.toThrow("Member lists are disabled for this room");

		alice.stop();
		bob.stop();
		alice.connection.close();
		bob.connection.close();
	});

	it("rejects prototype-like client event keys", async () => {
		const namespace = new MockNamespace();
		const roomType = createRoomType("event-prototype-keys", "list");
		const handlers = createBaseHandlers();
		const pair = createClientPair(namespace, "alice-socket", roomType, handlers);
		const room = await pair.client.join({
			roomId: "room-1",
			roomKey: "shared-key",
			userId: "alice",
			userName: "Ada",
		});

		await expect((room.emit as any)["__proto__"]({ text: "x" })).rejects.toThrow("Unknown event '__proto__'");
		await expect((room.emit as any)["toString"]({ text: "x" })).rejects.toThrow("Unknown event 'toString'");

		pair.stop();
		pair.connection.close();
	});

	it("rejects prototype-like RPC keys", async () => {
		const namespace = new MockNamespace();
		const roomType = createRoomType("rpc-prototype-keys", "list");
		const handlers = createBaseHandlers();
		const pair = createClientPair(namespace, "alice-socket", roomType, handlers);
		const room = await pair.client.join({
			roomId: "room-1",
			roomKey: "shared-key",
			userId: "alice",
			userName: "Ada",
		});

		await expect((room.rpc as any)["__proto__"]()).rejects.toThrow("Unknown RPC '__proto__'");
		await expect((room.rpc as any)["toString"]()).rejects.toThrow("Unknown RPC 'toString'");

		pair.stop();
		pair.connection.close();
	});

	it("delivers presence frames through the custom adapter path", async () => {
		const namespace = new MockNamespace();
		const roomType = createRoomType("presence-adapter-delivery", "list");
		const adapterEvents: string[] = [];
		const adapter: RoomServerAdapter = {
			emitToSocketIds(socketIds, eventName, payload) {
				adapterEvents.push(eventName);
				for (const socketId of socketIds) {
					namespace.to(socketId).emit(eventName, payload);
				}
			},
		};
		const handlers = createBaseHandlers();
		const alice = createClientPair(namespace, "alice-socket", roomType, handlers, adapter);
		const bob = createClientPair(namespace, "bob-socket", roomType, handlers, adapter);

		await alice.client.join({
			roomId: "room-1",
			roomKey: "shared-key",
			userId: "alice",
			userName: "Ada",
		});
		await bob.client.join({
			roomId: "room-1",
			roomKey: "shared-key",
			userId: "bob",
			userName: "Ben",
		});

		expect(adapterEvents).toContain("room-kit:presence");

		alice.stop();
		bob.stop();
		alice.connection.close();
		bob.connection.close();
	});

	it("keeps introspection member listing independent from per-request presencePolicy", async () => {
		const namespace = new MockNamespace();
		const roomType = createRoomType("introspection-vs-policy", "list");
		const handlers: RoomServerHandlers<typeof roomType> = {
			...createBaseHandlers(),
			presencePolicy: () => "count",
		};
		const first = createClientPair(namespace, "alice-socket", roomType, handlers);
		const second = createClientPair(namespace, "bob-socket", roomType, handlers);

		const aliceRoom = await first.client.join({
			roomId: "room-1",
			roomKey: "shared-key",
			userId: "alice",
			userName: "Ada",
		});
		await second.client.join({
			roomId: "room-1",
			roomKey: "shared-key",
			userId: "bob",
			userName: "Ben",
		});

		await expect((aliceRoom.presence as any).list()).rejects.toThrow("Member lists are disabled for this room");
		expect(first.stop.members("room-1")).toMatchObject({
			count: 2,
			members: [
				{ memberId: "alice" },
				{ memberId: "bob" },
			],
		});

		first.stop();
		second.stop();
		first.connection.close();
		second.connection.close();
	});

	it("routes broadcast.toRoom to the target room only", async () => {
		const namespace = new MockNamespace();
		const roomType = createRoomType("broadcast-to-other-room", "list");
		const handlers = createBaseHandlers();
		const alice = createClientPair(namespace, "alice-socket", roomType, handlers);
		const bob = createClientPair(namespace, "bob-socket", roomType, handlers);
		const carol = createClientPair(namespace, "carol-socket", roomType, handlers);

		const aliceRoom = await alice.client.join({
			roomId: "room-1",
			roomKey: "shared-key",
			userId: "alice",
			userName: "Ada",
		});
		const bobRoom = await bob.client.join({
			roomId: "room-2",
			roomKey: "shared-key",
			userId: "bob",
			userName: "Ben",
		});
		const carolRoom = await carol.client.join({
			roomId: "room-1",
			roomKey: "shared-key",
			userId: "carol",
			userName: "Cid",
		});

		const seenRoom1: string[] = [];
		const seenRoom2: string[] = [];
		aliceRoom.on.roomNotice((payload) => seenRoom1.push(payload.text));
		bobRoom.on.roomNotice((payload) => seenRoom2.push(payload.text));

		await carolRoom.rpc.announceRoom({ roomId: "room-2", text: "hello-room-2" });

		expect(seenRoom1).toEqual([]);
		expect(seenRoom2).toEqual(["hello-room-2"]);

		alice.stop();
		bob.stop();
		carol.stop();
		alice.connection.close();
		bob.connection.close();
		carol.connection.close();
	});

	it("drops replay state after reconnect admission roomId mismatch", async () => {
		const namespace = new MockNamespace();
		const roomType = createRoomType("reconnect-mismatch-cleanup", "list");
		const joinCalls = new Map<string, number>();
		const handlers = createBaseHandlers({
			admit: (join) => {
				const count = (joinCalls.get(join.userId) ?? 0) + 1;
				joinCalls.set(join.userId, count);
				if (count === 1) {
					return {
						roomId: join.roomId,
						memberId: join.userId,
						memberProfile: {
							userId: join.userId,
							userName: join.userName,
						},
						roomProfile: {
							roomId: join.roomId,
							created: "2026-03-23T00:00:00.000Z",
						},
					};
				}

				return {
					roomId: `${join.roomId}-other`,
					memberId: join.userId,
					memberProfile: {
						userId: join.userId,
						userName: join.userName,
					},
					roomProfile: {
						roomId: `${join.roomId}-other`,
						created: "2026-03-23T00:00:00.000Z",
					},
				};
			},
		});

		const alice = createClientPair(namespace, "alice-socket", roomType, handlers);
		const bob = createClientPair(namespace, "bob-socket", roomType, handlers);

		const aliceRoom = await alice.client.join({
			roomId: "room-1",
			roomKey: "shared-key",
			userId: "alice",
			userName: "Ada",
		});
		const bobRoom = await bob.client.join({
			roomId: "room-1",
			roomKey: "shared-key",
			userId: "bob",
			userName: "Ben",
		});

		const seen: string[] = [];
		aliceRoom.on.message((payload) => seen.push(payload.text));

		await bobRoom.rpc.sendMessage({ text: "before" });
		expect(seen).toEqual(["before"]);

		alice.connection.serverSocket.receive("disconnect", undefined);
		alice.connection.clientSocket.receive("connect", undefined);
		await new Promise<void>((resolve) => setTimeout(resolve, 0));
		alice.connection.clientSocket.receive("connect", undefined);
		await new Promise<void>((resolve) => setTimeout(resolve, 0));

		await bobRoom.rpc.sendMessage({ text: "after" });
		expect(seen).toEqual(["before"]);
		expect(joinCalls.get("alice")).toBe(2);

		alice.stop();
		bob.stop();
		alice.connection.close();
		bob.connection.close();
	});

	it("exposes client transport state changes", () => {
		const namespace = new MockNamespace();
		const roomType = createRoomType("connection-state", "list");
		const handlers = createBaseHandlers();
		const pair = createClientPair(namespace, "alice-socket", roomType, handlers);
		const states: string[] = [];

		expect(pair.client.connection.current).toBe("connecting");
		const unsubscribe = pair.client.connection.onChange((state) => {
			states.push(state);
		});

		pair.connection.clientSocket.receive("connect_error", undefined);
		expect(pair.client.connection.current).toBe("connecting");

		pair.connection.clientSocket.receive("connect", undefined);
		expect(pair.client.connection.current).toBe("connected");

		pair.connection.clientSocket.receive("reconnect_attempt", undefined);
		expect(pair.client.connection.current).toBe("reconnecting");
		pair.connection.clientSocket.receive("reconnect_error", undefined);
		expect(pair.client.connection.current).toBe("reconnecting");

		pair.connection.clientSocket.receive("disconnect", undefined);
		expect(pair.client.connection.current).toBe("disconnected");
		expect(states).toEqual(["connected", "reconnecting", "disconnected"]);

		unsubscribe();
		pair.stop();
		pair.connection.close();
	});
});
