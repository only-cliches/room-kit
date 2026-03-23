# channel-kit

[![GitHub Repo stars](https://img.shields.io/github/stars/only-cliches/channel-kit)](https://github.com/only-cliches/channel-kit)
[![NPM Version](https://img.shields.io/npm/v/channel-kit)](https://www.npmjs.com/package/channel-kit)
[![JSR Version](https://img.shields.io/jsr/v/%40onlycliches/channel-kit)](https://jsr.io/@onlycliches/channel-kit)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.0+-blue.svg)](https://www.typescriptlang.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

Type-safe channel primitives for Socket.IO events, requests, streams, and room membership.

## Install

```bash
npm install channel-kit socket.io socket.io-client
```

## Import Matrix

- npm:
  - `import { channel, createSocketChannels, adaptSocketIoTransport } from "channel-kit";`
- JSR:
  - `import { channel, createSocketChannels, adaptSocketIoTransport } from "jsr:@only-cliches/channel-kit@1";`

## Quick Start

```ts
// common.ts
import { channel } from "channel-kit";

export const typing = channel("chat.typing").event<{ roomId: string; userId: string }>();
export const sendMessage = channel("chat.sendMessage")
    .request<{ roomId: string; text: string }>()
    .response<{ messageId: string }>();
export const roomMembership = channel("chat.roomMembership").room<{ roomId: string }>();
```

```ts
// server.ts
import http from "node:http";
import { Server } from "socket.io";
import { adaptSocketIoTransport, createSocketChannels } from "channel-kit";
import { sendMessage, roomMembership, typing } from "./common";

const httpServer = http.createServer();
const io = new Server(httpServer);

io.on("connection", (socket) => {
    const api = createSocketChannels(adaptSocketIoTransport(socket));

    api.event(typing).handle((payload, ctx) => {
        ctx.broadcast.emit(typing, payload);
    });

    api.request(sendMessage).handle(async () => {
        return { messageId: crypto.randomUUID() };
    });

    api.room(roomMembership).handleJoin(async (payload, ctx) => {
        await ctx.joinRoom(payload.roomId);
    });
});

httpServer.listen(3000);
```

```ts
// client.ts
import { io } from "socket.io-client";
import { adaptSocketIoTransport, createSocketChannels } from "channel-kit";
import { roomMembership, sendMessage, typing } from "./common";

const socket = io("http://127.0.0.1:3000");
const api = createSocketChannels(adaptSocketIoTransport(socket));

api.event(typing).send({ roomId: "room-1", userId: "u1" });
await api.room(roomMembership).join({ roomId: "room-1" });
const reply = await api.request(sendMessage).call({ roomId: "room-1", text: "hello" });
console.log(reply.messageId);
```

## API Reference

### Channel builders

- `channel(name).event<TPayload>()`
- `channel(name).request<TRequest>().response<TResponse>()`
- `channel(name).subscribe<TSubscribe>().publish<TPublish>()`
- `channel(name).room<TPayload>()`

### Layer API

- `api.event(channel).send(payload)`
- `api.event(channel).on(handler)`
- `api.event(channel).handle(handler)`
- `api.request(channel).call(payload, options?)`
- `api.request(channel).safeCall(payload, options?)`
- `api.request(channel).handle(handler)`
- `api.stream(channel).subscribe(params, onPublish)`
- `api.stream(channel).publish(payload)`
- `api.stream(channel).handleSubscribe(handler)`
- `api.stream(channel).onPublish(handler)`
- `api.room(channel).join(payload, options?)`
- `api.room(channel).leave(payload, options?)`
- `api.room(channel).handleJoin(handler)`
- `api.room(channel).handleLeave(handler)`

### Handler context

- `ctx.emit(eventChannel, payload)`
- `ctx.publish(streamChannel, payload)`
- `ctx.joinRoom(roomId)`
- `ctx.leaveRoom(roomId)`
- `ctx.toRoom(roomId).emit(...)`
- `ctx.toRoom(roomId).publish(...)`
- `ctx.broadcast.emit(...)`
- `ctx.broadcast.publish(...)`

## Failure Semantics

- `api.request(channel).call(...)`:
  - Resolves with response payload on success.
  - Throws a `RequestFailure` variant on failure.
- `api.request(channel).safeCall(...)`:
  - Returns `Ok<TResponse>` on success.
  - Returns `Err<RequestFailure>` on failure.

Current `RequestFailure` variants:

- `Timeout { ms }`
- `InvalidResponse { reason }`
- `Rejected { error }`

`api.room(channel).join(...)` and `leave(...)` use the same failure style as `.call(...)` and throw `RequestFailure` variants.

## Reconnect Behavior

- Active stream subscriptions are replayed after reconnect.
- Successful room joins made through `api.room(...).join(...)` are replayed after reconnect.
- `api.room(...).leave(...)` removes replay state for that room payload.
- Request calls are not replayed.

## Security Notes

- Clients do not target rooms directly; routing is server-authoritative.
- Always validate join/leave permissions in server handlers.
- Do not treat client payloads as trusted authorization state.
- Use room membership APIs as transport routing controls, not as business-level authorization by themselves.