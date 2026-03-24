import type { RoomDefinition, RoomSchema } from "./types";

/**
 * Defines a room type using a type-only schema and runtime options.
 *
 * @example
 * ```ts
 * const chatRoom = defineRoomType<{
 *   joinRequest: { roomId: string; roomKey: string; userName: string };
 *   memberProfile: { userId: string; userName: string };
 *   roomProfile: { roomId: string; created: string };
 *   serverState: { roomKey: string; created: string };
 *   events: { message: { text: string } };
 *   rpc: { sendMessage: (input: { text: string }) => Promise<void> };
 * }>({
 *   name: "chat",
 *   presence: "count",
 * });
 * ```
 */
export function defineRoomType<TSchema extends RoomSchema, TPresence extends "none" | "count" | "list" = "list">(
    options: {
        readonly name: string;
        readonly presence?: TPresence;
    },
): RoomDefinition<TSchema, TPresence> {
    return {
        kind: "room",
        name: options.name,
        presence: options.presence ?? "list",
    } as RoomDefinition<TSchema, TPresence>;
}
