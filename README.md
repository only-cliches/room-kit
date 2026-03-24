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

## Core API

- `defineRoomType<TSchema>({ name, presence? })`
- `serveRoomType(socket, roomType, handlers, adapter?)`
- `createRoomClient(socket, roomType)`
- `ClientSafeError`

## Quick Start

```ts
// common.ts
import { defineRoomType } from "room-kit";

type ChatMessage = {
  id: string;
  name: string;
  text: string;
  sentAt: string;
};

export const chatRoom = defineRoomType<{
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
    history: ChatMessage[];
  };
  events: {
    message: ChatMessage;
    systemNotice: { text: string; sentAt: string };
  };
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
    events: {
      // Client emits are allowlisted by key in this object.
      // If you don't need client-originated events, omit this.
      message: async () => undefined,
    },
    rpc: {
      sendMessage: async ({ text }, ctx) => {
        // Prefer RPC for validated state-changing operations.
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

const socket = io("http://127.0.0.1:3000");
const chatClient = createRoomClient(socket, chatRoom);

const joined = await chatClient.join({
  roomId: "team-alpha",
  roomKey: "secret",
  userName: "Ada",
});

joined.on.message((payload, meta) => {
  // meta.source.kind is "server" or "member".
  console.log(payload.text, meta.source.kind);
});

// Fully typed request/response based on your room definition.
await joined.rpc.sendMessage({ text: "hello" });
await joined.leave();
```

## Room Schema

`defineRoomType<TSchema>()` is type-first. The schema keys are:

- `joinRequest`: data required to join; must include `roomId`.
- `memberProfile`: server-tracked member metadata.
- `roomProfile`: room metadata returned to each joined client; must include `roomId`.
- `serverState`: private mutable server state per room instance.
- `events`: named room events.
- `rpc`: named RPC methods.

Runtime presence mode is configured in the `defineRoomType` options:

- `"none"`: no presence query support.
- `"count"`: only count support.
- `"list"`: count + paginated members.

## Server Handlers

`serveRoomType(socket, roomType, handlers, adapter?)` accepts:

- `onAuth(socket)`: optional unless you type a non-`unknown` auth context.
- `onConnect(socket, auth)`: optional transport-connect hook (runs once per socket handler attach).
- `revalidateAuth(socket, auth)`: optional per-request auth validation/rotation hook.
- `initState(joinRequest)`: initialize room server state on first join.
- `admit(joinRequest, ctx)`: required gate; returns `roomId`, `memberId`, `memberProfile`, `roomProfile`.
- `onJoin(memberProfile, ctx)` / `onLeave(memberProfile, ctx)`: room membership lifecycle hooks (`onLeave` also runs on socket disconnect for joined rooms).
- `onDisconnect(socket, auth)`: optional transport-disconnect hook.
- `events`: handlers for client-emitted events.
- `rpc`: handlers for client RPC calls.

Server context (`ctx`) includes:

- `ctx.auth`, `ctx.memberId`, `ctx.memberProfile`
- `ctx.roomProfile`, `ctx.serverState`
- `ctx.emit.<event>(payload)` to emit to current room
- `ctx.broadcast.emit.<event>(payload)` to emit across namespace
- `ctx.broadcast.toRoom(roomId).emit.<event>(payload)`
- `ctx.broadcast.toMembers(memberIds).emit.<event>(payload)`
- `ctx.getPresence()`, `ctx.getPresenceCount()`, `ctx.listPresenceMembers({ offset, limit })`

`serveRoomType` returns a handle:

- `stop()` unregisters listeners for that socket
- `stop.rooms()`, `stop.room(roomId)`, `stop.count(roomId)`, `stop.members(roomId, query)` for introspection

## Client API

`createRoomClient(socket, roomType)` returns:

- `client.name`
- `client.connection.current` (`"connecting" | "connected" | "reconnecting" | "disconnected"`)
- `client.connection.onChange(handler)`
- `client.join(joinRequest) -> joinedRoom`

`joinedRoom` includes:

- `joinedRoom.roomId`, `joinedRoom.memberId`, `joinedRoom.roomProfile`
- `joinedRoom.rpc.<name>(...args)`
- `joinedRoom.emit.<event>(payload)` (must match a declared server `events` handler)
- `joinedRoom.on.<event>((payload, meta) => {})`
- `joinedRoom.leave()`
- `joinedRoom.presence` only when presence is enabled by room definition:
- `presence.current`
- `presence.onChange(handler)`
- `presence.count()`
- `presence.list({ offset, limit })` only for `"list"` presence

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
