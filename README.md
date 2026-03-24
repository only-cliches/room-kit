# room-kit

[![GitHub Repo stars](https://img.shields.io/github/stars/only-cliches/room-kit)](https://github.com/only-cliches/room-kit)
[![NPM Version](https://img.shields.io/npm/v/room-kit)](https://www.npmjs.com/package/room-kit)
[![JSR Version](https://img.shields.io/jsr/v/%40onlycliches/room-kit)](https://jsr.io/@onlycliches/room-kit)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.0+-blue.svg)](https://www.typescriptlang.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

Small and type-safe room membership, presence, and realtime messaging for Socket.IO.

## Install

```bash
npm install room-kit socket.io socket.io-client
```

## Quick Start

```ts
// common.ts
import { defineRoomType } from "room-kit";

// Shared room schema used by both server and client.
type ChatMessage = {
  id: string;
  name: string;
  text: string;
  sentAt: string;
};

// The generic schema below drives the inferred server and client typing.
export const chatRoom = defineRoomType<{
  // Data required from the client to join a room.
  joinRequest: {
    roomId: string;
    roomKey: string;
    userName: string;
  };
  // Per-member metadata stored by the server.
  memberProfile: {
    userId: string;
    userName: string;
  };
  // Per-room metadata exposed to every joined client.
  roomProfile: {
    roomId: string;
    created: string;
  };
  // Private mutable state that only lives on the server.
  serverState: {
    roomKey: string;
    created: string;
    history: ChatMessage[];
  };
  // Named events the server can emit to room members.
  events: {
    message: ChatMessage;
    systemNotice: { text: string; sentAt: string };
  };
  // Typed request/response calls for validated mutations.
  rpc: {
    sendMessage: (input: { text: string }): Promise<{ id: string }>;
  };
}>({ name: "chat", presence: "list" });
```

```ts
// server.ts
import { randomUUID } from "node:crypto";
import http from "node:http";
import { Server } from "socket.io";
import { ClientSafeError, serveRoomType } from "room-kit";
import { chatRoom } from "./common";

const httpServer = http.createServer();
const io = new Server(httpServer);

io.on("connection", (socket) => {
  // Attach room behavior to each socket connection.
  serveRoomType<typeof chatRoom, { userId: string }>(socket, chatRoom, {
    onAuth: async () => {
      // Replace with real session/JWT validation.
      // This is your trusted identity source.
      return { userId: socket.id };
    },
    initState: async (join) => ({
      // Runs once per room instance (first successful join).
      roomKey: join.roomKey,
      created: new Date().toISOString(),
      history: [],
    }),
    admit: async (join, ctx) => {
      // Admission gate for private rooms.
      // Throw ClientSafeError for messages safe to show users.
      if (ctx.serverState.roomKey !== join.roomKey) {
        throw new ClientSafeError("Invalid room key");
      }

      return {
        roomId: join.roomId,
        memberId: ctx.auth.userId,
        // This profile is returned to the joining member and stored server-side.
        memberProfile: {
          userId: ctx.auth.userId,
          userName: join.userName,
        },
        // Room metadata available to all joined members.
        roomProfile: {
          roomId: join.roomId,
          created: ctx.serverState.created,
        },
      };
    },
    events: {
      // Client emits are allowlisted by key in this object.
      // If you don't need client-originated events, omit this.
      message: async () => undefined,
    },
    rpc: {
      sendMessage: async ({ text }, ctx) => {
        // Prefer RPC for validated state-changing operations.
        // Build the canonical message once, then persist and broadcast it.
        const message = {
          id: randomUUID(),
          name: ctx.memberProfile.userName,
          text,
          sentAt: new Date().toISOString(),
        };
        ctx.serverState.history.push(message);
        await ctx.emit.message(message);
        return { id: message.id };
      },
    },
  });
});

httpServer.listen(3000);
```

```ts
// client.ts
import { io } from "socket.io-client";
import { createRoomClient } from "room-kit";
import { chatRoom } from "./common";

// Create the socket transport and bind the typed room client to it.
const socket = io("http://127.0.0.1:3000");
const chatClient = createRoomClient(socket, chatRoom);

// Join returns a typed room handle with events, RPC, and leave().
const joined = await chatClient.join({
  roomId: "team-alpha",
  roomKey: "secret",
  userName: "Ada",
});

// Event payload and metadata are both inferred from the room schema.
joined.on.message((payload, meta) => {
  // meta.source.kind is "server" or "member".
  console.log(payload.text, meta.source.kind);
});

// Fully typed request/response based on your room definition.
await joined.rpc.sendMessage({ text: "hello" });
// Cleanly leave the room when you're done.
await joined.leave();
```

## Room Schema

`defineRoomType<TSchema>(options)` takes a runtime options object. `TSchema` controls the inferred API surface:

- `joinRequest`: payload the client must send to join a room; it must include `roomId`.
- `memberProfile`: per-member metadata stored by the server and exposed in membership snapshots.
- `roomProfile`: per-room metadata returned on join and reused in server context; it must include `roomId`.
- `serverState`: private mutable state owned by the server for each room instance.
- `events`: named room events the server may emit and, if declared in handlers, accept from clients.
- `rpc`: named request/response methods exposed to joined clients.

Runtime presence mode is configured in the `defineRoomType` options:

- `"none"`: no presence query support.
- `"count"`: only count support.
- `"list"`: count + paginated members.
- default: `"list"` when `presence` is omitted.

## Server Handlers

`serveRoomType(socket, roomType, handlers, adapter?)` accepts:

- `onAuth(socket)`: optional unless you type a non-`unknown` auth context.
- `onConnect(socket, auth)`: optional transport-connect hook attempted once when the socket handler is attached (after auth resolution).
- `revalidateAuth(socket, auth)`: optional per-request auth validation hook; return `{ kind: "ok", auth? }` to continue or `{ kind: "reject" }` to deny.
- `initState(joinRequest)`: initializes room server state on first join for a given room instance.
- `admit(joinRequest, ctx)`: required admission gate; returns `roomId`, `memberId`, `memberProfile`, and `roomProfile`.
- `onJoin(memberProfile, ctx)`: called after a successful join.
- `onLeave(memberProfile, ctx)`: called on leave and during socket disconnect cleanup for joined rooms when auth is available for cleanup.
- `onDisconnect(socket, auth)`: optional transport-disconnect hook.
- `presencePolicy(ctx)`: optional server-side override for presence queries; the returned policy is clamped by the room's configured presence mode.
- `events`: handlers for client-emitted events. Leave a key out to deny that client event.
- `rpc`: handlers for client RPC calls.

Server context (`ctx`) includes:

- `ctx.name`, `ctx.roomId`, `ctx.auth`, `ctx.memberId`, `ctx.memberProfile`
- `ctx.roomProfile`, `ctx.serverState`
- `ctx.emit.<event>(payload)` to emit to the current room
- `ctx.broadcast.emit.<event>(payload)` to emit across the namespace
- `ctx.broadcast.toRoom(roomId).emit.<event>(payload)` to target a room
- `ctx.broadcast.toMembers(memberIds).emit.<event>(payload)` to target specific members
- `ctx.getPresence()`, `ctx.getPresenceCount()`, `ctx.listPresenceMembers({ offset, limit })`

`serveRoomType` returns a handle:

- `stop()` unregisters listeners for that socket
- `stop.rooms()` returns snapshots for all rooms on the namespace
- `stop.room(roomId)` returns one room snapshot or `undefined`
- `stop.count(roomId)` returns the current member count for a room (`0` when the room does not exist; throws when room presence mode is `"none"`)
- `stop.members(roomId, query)` returns a paginated presence listing (`{ count: 0, offset: 0, limit: 0, members: [] }` when the room does not exist; throws when room presence mode is not `"list"`)

## Client API

`createRoomClient(socket, roomType)` returns:

- `client.name`
- `client.connection.current` (`"connecting" | "connected" | "reconnecting" | "disconnected"`)
- `client.connection.onChange(handler)` subscribes to transport-state changes and returns an unsubscribe function.
- `client.join(joinRequest)` resolves to a `joinedRoom` handle.

`joinedRoom` includes:

- `joinedRoom.name`, `joinedRoom.roomId`, `joinedRoom.memberId`, `joinedRoom.roomProfile`
- `joinedRoom.rpc.<name>(...args)` for typed RPC calls
- `joinedRoom.emit.<event>(payload)` for client-emitted room events
- `joinedRoom.on.<event>((payload, meta) => {})` for room event subscriptions
- `joinedRoom.leave()` to leave the room and unregister the joined-room handle
- `joinedRoom.presence` is part of the typed API when room presence mode is `"count"` or `"list"`; it exposes `current`, `onChange(handler)`, `count()`, and `list({ offset, limit })` when presence mode is `"list"`.

## Errors and Security

- Throw `ClientSafeError` for messages you want sent to clients.
- Non-`ClientSafeError` exceptions are sanitized to: `"An internal server error occurred."`
- RPC and event dispatch only allow own properties (`Object.hasOwn`) to prevent prototype-based handler access.
- Client event names are default-deny unless explicitly declared in `handlers.events`.
- Do not trust client payloads for authorization; derive identity in `onAuth`.
- Validate runtime payload shapes in your handlers. TypeScript types are compile-time only.

## Reconnect Behavior

- Joined rooms are automatically replayed after socket reconnect.
- Replay uses the original `joinRequest` payload.
- If replay fails, that joined room is removed from the client registry.

## Example App

A complete chat example is in the `example` directory:

```bash
cd example
npm install
npm start
```
