import { defineRoomType } from "../src/index";

export type ChatMessage = {
  id: string;
  name: string;
  text: string;
  sentAt: string;
};

export const chatRoomType = defineRoomType<{
  joinRequest: {
    roomId: string;
    roomKey: string;
    userName: string;
  };
  memberProfile: {
    userId: string;
    userName: string;
    joinedAt: number;
  };
  roomProfile: {
    roomId: string;
    created: string;
    history: ChatMessage[];
  };
  serverState: {
    roomKey: string;
    created: string;
    history: ChatMessage[];
  };
  events: {
    message: ChatMessage;
    systemNotice: {
      text: string;
      sentAt: string;
    };
  };
  rpc: {
    sendMessage: (input: { text: string }) => Promise<{ id: string }>;
  };
}>({ name: "example-chat", presence: "list" });
