# Changelog

## 1.0.0

- Initial release of `channel-io`.
- Typed channel primitives for Socket.IO events, requests, streams, and room membership.
- Runtime protocol support for event, request/response, stream subscribe/publish, and room join/leave flows.
- Test coverage for runtime behavior and Socket.IO integration.
- Added first-class room membership flows with `channel(...).room(...)`.
- Added reconnect replay for active stream subscriptions and room memberships.
- Added Socket.IO client and server adapters for room-aware sends and membership mutation.
- Added a JSR-ready package entrypoint via `jsr.json`.
- Expanded the README with current client, server, and JSR examples.