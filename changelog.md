# Changelog

## 1.0.5

- Made `onAuth` optional in server configs.
- Made `admit` optional and allowed it to return partial admission data.
- Added runtime defaults for missing admission fields and validation for room identity.
- Updated docs and tests for the new auth and admission behavior.

## 1.0.4

- Added `serveRoomType(...).cleanup()` as the explicit server-handle teardown API.
- Added `JoinedRoom.listen({ events, presence })` for batched subscription setup.
- Improved reconnect replay for joined rooms and transport state tracking.

## 1.0.3

- Hardened client and server event handling with payload validation and safe handler-name checks.
- Added acknowledgement timeouts and listener error isolation on the client.
- Added server-side request limits and safer wire-frame parsing.

## 1.0.2

- Hardened room-key comparison in the example server with timing-safe equality.
- Tightened server join validation and static file handling.
- Cleaned up the example server routing and path resolution.

## 1.0.1

- Updated package metadata for ESM publishing.
- Cleaned up the README packaging docs.
- Simplified the package and JSR metadata layout.

## 1.0.0

- Initial release of `room-kit`.
- Typed channel primitives for Socket.IO events, requests, streams, and room membership.
- Runtime protocol support for event, request/response, stream subscribe/publish, and room join/leave flows.
- Test coverage for runtime behavior and Socket.IO integration.
- Added first-class room membership flows with `channel(...).room(...)`.
- Added reconnect replay for active stream subscriptions and room memberships.
- Added Socket.IO client and server adapters for room-aware sends and membership mutation.
- Added a JSR-ready package entrypoint via `jsr.json`.
- Expanded the README with current client, server, and JSR examples.
