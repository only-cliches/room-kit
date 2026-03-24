# Example Chat App

This folder contains a small standalone HTTP chat app with:

- private rooms protected by a room key
- live presence updates
- room-scoped chat messages
- `room-kit` room types used for admission, presence, events, and RPC

## Run

Install the example dependencies first, then run it from this folder:

```bash
npm install
```

```bash
npm start
```

Then open:

```text
http://127.0.0.1:3000
```

## How it works

- [`server.ts`](/home/slott/Developer/channel-io/example/server.ts#L1) adapts Socket.IO into `room-kit` and wires the room and request handlers.
- [`public/app.ts`](/home/slott/Developer/channel-io/example/public/app.ts#L1) creates a room client once, then calls `.join(...)` for one room instance.
- The first user to join a room sets the room key.
- Anyone else who wants to join that room must provide the same key.
- Presence is tracked per room and exposed through `joinedRoom.presence`.
- Messages stay inside the active room via room-scoped RPC and events.

## Files

- `common.ts` defines the shared room type and chat payload types.
- `server.ts` serves the page and runs the chat server.
- `public/index.html` is the UI shell.
- `public/styles.css` handles layout and styling.
- `public/app.ts` is the browser source that gets bundled into `public/app.js`.
