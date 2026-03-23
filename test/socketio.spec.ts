import http from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";
import { Server } from "socket.io";
import { io as createClient, type Socket } from "socket.io-client";

import {
	adaptSocketIoTransport,
	channel,
	createSocketChannels,
} from "../src/index";

function waitForSocketEvent(socket: Socket, eventName: string): Promise<void> {
	return new Promise<void>((resolve) => {
		socket.once(eventName, () => resolve());
	});
}

describe("Socket.IO compatibility", () => {
	const sockets: Socket[] = [];
	const servers: Array<{
		io: Server;
		httpServer: http.Server;
	}> = [];

	afterEach(async () => {
		for (const socket of sockets.splice(0)) {
			socket.close();
		}

		for (const { io, httpServer } of servers.splice(0)) {
			io.close();
			await new Promise<void>((resolve) => httpServer.close(() => resolve()));
		}
	});

	it("supports client and server adapters with room-aware sends", async () => {
		const httpServer = http.createServer();
		const io = new Server(httpServer);

		servers.push({ io, httpServer });

		await new Promise<void>((resolve, reject) => {
			httpServer.listen({ port: 0, host: "127.0.0.1" }, () => resolve());
			httpServer.once("error", reject);
		});
		const { port } = httpServer.address() as AddressInfo;

		const notify = channel("chat.notify").event<{ text: string }>();
		const announce = channel("chat.announce").event<{ text: string }>();
		const roomAction = channel("chat.roomAction").room<{
			action: "join" | "leave";
			roomId: string;
			allow: boolean;
		}>();

		io.on("connection", (socket) => {
			const api = createSocketChannels(adaptSocketIoTransport(socket));

			api.room(roomAction).handleJoin(async (payload, ctx) => {
				if (!payload.allow) {
					throw new Error(`room '${payload.roomId}' rejected`);
				}

				await ctx.joinRoom(payload.roomId);
				ctx.broadcast.emit(announce, {
					text: `broadcast:${payload.action}:${payload.roomId}`,
				});
				ctx.toRoom(payload.roomId).emit(notify, {
					text: `${payload.action}:${payload.roomId}`,
				});
			});

			api.room(roomAction).handleLeave(async (payload, ctx) => {
				if (!payload.allow) {
					throw new Error(`room '${payload.roomId}' rejected`);
				}

				await ctx.leaveRoom(payload.roomId);
				ctx.broadcast.emit(announce, {
					text: `broadcast:${payload.action}:${payload.roomId}`,
				});
				ctx.toRoom(payload.roomId).emit(notify, {
					text: `${payload.action}:${payload.roomId}`,
				});
			});
		});

		const client1 = createClient(`http://127.0.0.1:${port}`, {
			forceNew: true,
			transports: ["websocket"],
			reconnection: false,
		});
		const client2 = createClient(`http://127.0.0.1:${port}`, {
			forceNew: true,
			transports: ["websocket"],
			reconnection: false,
		});

		sockets.push(client1, client2);

		const client1Api = createSocketChannels(adaptSocketIoTransport(client1));
		const client2Api = createSocketChannels(adaptSocketIoTransport(client2));

		const client1Messages: string[] = [];
		const client2Messages: string[] = [];
		const client1Announcements: string[] = [];
		const client2Announcements: string[] = [];

		client1Api.event(notify).on((payload) => client1Messages.push(payload.text));
		client2Api.event(notify).on((payload) => client2Messages.push(payload.text));
		client1Api.event(announce).on((payload) => client1Announcements.push(payload.text));
		client2Api.event(announce).on((payload) => client2Announcements.push(payload.text));

		await Promise.all([waitForSocketEvent(client1, "connect"), waitForSocketEvent(client2, "connect")]);

		const joinResponse1 = await client1Api.room(roomAction).join({
			action: "join",
			roomId: "room-1",
			allow: true,
		});
		expect(joinResponse1).toBeUndefined();

		await new Promise<void>((resolve) => setTimeout(resolve, 50));

		expect(client1Messages).toEqual([]);
		expect(client2Messages).toEqual([]);
		expect(client1Announcements).toEqual([]);
		expect(client2Announcements).toEqual(["broadcast:join:room-1"]);

		const joinResponse2 = await client2Api.room(roomAction).join({
			action: "join",
			roomId: "room-1",
			allow: true,
		});
		expect(joinResponse2).toBeUndefined();

		await new Promise<void>((resolve) => setTimeout(resolve, 50));

		expect(client1Messages).toEqual(["join:room-1"]);
		expect(client2Messages).toEqual([]);
		expect(client1Announcements).toEqual(["broadcast:join:room-1"]);
		expect(client2Announcements).toEqual(["broadcast:join:room-1"]);

		const leaveResponse = await client2Api.room(roomAction).leave({
			action: "leave",
			roomId: "room-1",
			allow: true,
		});
		expect(leaveResponse).toBeUndefined();

		await new Promise<void>((resolve) => setTimeout(resolve, 50));

		expect(client1Messages).toEqual(["join:room-1", "leave:room-1"]);
		expect(client2Messages).toEqual([]);
		expect(client1Announcements).toEqual([
			"broadcast:join:room-1",
			"broadcast:leave:room-1",
		]);
		expect(client2Announcements).toEqual([
			"broadcast:join:room-1",
		]);

		await expect(
			client1Api.room(roomAction).join({
				action: "join",
				roomId: "room-2",
				allow: false,
			}),
		).rejects.toMatchObject({
			tag: "Rejected",
		});
	}, 15_000);

	it("replays active stream subscriptions after reconnect", async () => {
		const httpServer = http.createServer();
		const io = new Server(httpServer);

		servers.push({ io, httpServer });

		await new Promise<void>((resolve, reject) => {
			httpServer.listen({ port: 0, host: "127.0.0.1" }, () => resolve());
			httpServer.once("error", reject);
		});
		const { port } = httpServer.address() as AddressInfo;

		const feed = channel("chat.replay").subscribe<{ roomId: string }>().publish<{
			text: string;
		}>();
		let subscribeCount = 0;

		io.on("connection", (socket) => {
			const api = createSocketChannels(adaptSocketIoTransport(socket));

			api.stream(feed).handleSubscribe(async (_payload, ctx) => {
				subscribeCount += 1;
				ctx.publish(feed, {
					text: `welcome:${subscribeCount}`,
				});
			});
		});

		const client = createClient(`http://127.0.0.1:${port}`, {
			forceNew: true,
			transports: ["websocket"],
			reconnection: false,
		});

		sockets.push(client);

		const api = createSocketChannels(adaptSocketIoTransport(client));
		const seen: string[] = [];
		api.stream(feed).subscribe({ roomId: "r1" }, (payload) => {
			seen.push(payload.text);
		});

		await waitForSocketEvent(client, "connect");
		await new Promise<void>((resolve) => setTimeout(resolve, 50));

		expect(seen).toEqual(["welcome:1"]);

		client.disconnect();
		client.connect();

		await new Promise<void>((resolve) => setTimeout(resolve, 150));

		expect(seen).toEqual(["welcome:1", "welcome:2"]);
	}, 15_000);

	it("replays room membership after reconnect", async () => {
		const httpServer = http.createServer();
		const io = new Server(httpServer);

		servers.push({ io, httpServer });

		await new Promise<void>((resolve, reject) => {
			httpServer.listen({ port: 0, host: "127.0.0.1" }, () => resolve());
			httpServer.once("error", reject);
		});
		const { port } = httpServer.address() as AddressInfo;

		const notify = channel("chat.roomReplayNotify").event<{ text: string }>();
		const roomAction = channel("chat.roomReplayAction").room<{ roomId: string }>();
		const poke = channel("chat.roomReplayPoke")
			.request<{ roomId: string; text: string }>()
			.response<{ ok: true }>();

		io.on("connection", (socket) => {
			const api = createSocketChannels(adaptSocketIoTransport(socket));

			api.room(roomAction).handleJoin(async (payload, ctx) => {
				await ctx.joinRoom(payload.roomId);
			});
			api.room(roomAction).handleLeave(async (payload, ctx) => {
				await ctx.leaveRoom(payload.roomId);
			});

			api.request(poke).handle(async (payload, ctx) => {
				ctx.toRoom(payload.roomId).emit(notify, { text: payload.text });
				return { ok: true };
			});
		});

		const member = createClient(`http://127.0.0.1:${port}`, {
			forceNew: true,
			transports: ["websocket"],
			reconnection: false,
		});
		const caller = createClient(`http://127.0.0.1:${port}`, {
			forceNew: true,
			transports: ["websocket"],
			reconnection: false,
		});
		sockets.push(member, caller);

		const memberApi = createSocketChannels(adaptSocketIoTransport(member));
		const callerApi = createSocketChannels(adaptSocketIoTransport(caller));
		const seen: string[] = [];
		memberApi.event(notify).on((payload) => seen.push(payload.text));

		await Promise.all([waitForSocketEvent(member, "connect"), waitForSocketEvent(caller, "connect")]);

		await memberApi.room(roomAction).join({ roomId: "room-1" });
		await callerApi.request(poke).call({ roomId: "room-1", text: "first" });
		await new Promise<void>((resolve) => setTimeout(resolve, 50));
		expect(seen).toEqual(["first"]);

		member.disconnect();
		member.connect();

		await waitForSocketEvent(member, "connect");
		let replayObserved = false;
		for (let i = 0; i < 8; i += 1) {
			await new Promise<void>((resolve) => setTimeout(resolve, 50));
			await callerApi.request(poke).call({ roomId: "room-1", text: "after-reconnect" });
			await new Promise<void>((resolve) => setTimeout(resolve, 25));
			if (seen.includes("after-reconnect")) {
				replayObserved = true;
				break;
			}
		}
		expect(replayObserved).toBe(true);
		expect(seen).toEqual(["first", "after-reconnect"]);

		await memberApi.room(roomAction).leave({ roomId: "room-1" });
		await callerApi.request(poke).call({ roomId: "room-1", text: "after-leave" });
		await new Promise<void>((resolve) => setTimeout(resolve, 50));
		expect(seen).toEqual(["first", "after-reconnect"]);

		member.disconnect();
		member.connect();
		await waitForSocketEvent(member, "connect");
		await new Promise<void>((resolve) => setTimeout(resolve, 150));

		await callerApi.request(poke).call({ roomId: "room-1", text: "after-leave-reconnect" });
		await new Promise<void>((resolve) => setTimeout(resolve, 50));
		expect(seen).toEqual(["first", "after-reconnect"]);
	}, 15_000);

	it("drops replayed room membership after server rejection", async () => {
		const httpServer = http.createServer();
		const io = new Server(httpServer);

		servers.push({ io, httpServer });

		await new Promise<void>((resolve, reject) => {
			httpServer.listen({ port: 0, host: "127.0.0.1" }, () => resolve());
			httpServer.once("error", reject);
		});
		const { port } = httpServer.address() as AddressInfo;

		const notify = channel("chat.roomReplayRejectNotify").event<{ text: string }>();
		const roomAction = channel("chat.roomReplayRejectAction").room<{ roomId: string }>();
		const poke = channel("chat.roomReplayRejectPoke")
			.request<{ roomId: string; text: string }>()
			.response<{ ok: true }>();
		let allowReplay = true;
		let joinAttempts = 0;

		io.on("connection", (socket) => {
			const api = createSocketChannels(adaptSocketIoTransport(socket));

			api.room(roomAction).handleJoin(async (payload, ctx) => {
				joinAttempts += 1;
				if (!allowReplay && joinAttempts > 1) {
					throw new Error(`rejected:${payload.roomId}`);
				}
				await ctx.joinRoom(payload.roomId);
			});

			api.request(poke).handle(async (payload, ctx) => {
				ctx.toRoom(payload.roomId).emit(notify, { text: payload.text });
				return { ok: true };
			});
		});

		const member = createClient(`http://127.0.0.1:${port}`, {
			forceNew: true,
			transports: ["websocket"],
			reconnection: false,
		});
		const caller = createClient(`http://127.0.0.1:${port}`, {
			forceNew: true,
			transports: ["websocket"],
			reconnection: false,
		});
		sockets.push(member, caller);

		const memberApi = createSocketChannels(adaptSocketIoTransport(member));
		const callerApi = createSocketChannels(adaptSocketIoTransport(caller));
		const seen: string[] = [];
		memberApi.event(notify).on((payload) => seen.push(payload.text));

		await Promise.all([waitForSocketEvent(member, "connect"), waitForSocketEvent(caller, "connect")]);

		await memberApi.room(roomAction).join({ roomId: "room-1" });
		await callerApi.request(poke).call({ roomId: "room-1", text: "before-reject" });
		await new Promise<void>((resolve) => setTimeout(resolve, 50));
		expect(seen).toEqual(["before-reject"]);

		allowReplay = false;
		member.disconnect();
		member.connect();
		await waitForSocketEvent(member, "connect");
		await new Promise<void>((resolve) => setTimeout(resolve, 150));

		await callerApi.request(poke).call({ roomId: "room-1", text: "after-reject" });
		await new Promise<void>((resolve) => setTimeout(resolve, 50));
		expect(seen).toEqual(["before-reject"]);

		const attemptsAfterRejectedReplay = joinAttempts;
		member.disconnect();
		member.connect();
		await waitForSocketEvent(member, "connect");
		await new Promise<void>((resolve) => setTimeout(resolve, 150));
		expect(joinAttempts).toBe(attemptsAfterRejectedReplay);
	}, 15_000);
});
