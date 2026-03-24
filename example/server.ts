import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

import { Server } from "socket.io";

import { ClientSafeError, serveRoomType } from "../src/index";
import { chatRoomType, type ChatMessage } from "./common";

type ChatAuth = {
  userId: string;
};

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const port = Number(process.env.PORT || 3000);
const publicDir = path.join(__dirname, "public");

function normalizeRoomId(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new ClientSafeError("Room id is required.");
  }

  return value.trim().toLowerCase();
}

function normalizeRoomKey(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new ClientSafeError("Room key is required.");
  }

  return value.trim();
}

function normalizeUserId(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new ClientSafeError("User id is required.");
  }

  return value.trim();
}

function normalizeDisplayName(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new ClientSafeError("Display name is required.");
  }

  const name = value.trim();
  if (name.length > 32) {
    throw new ClientSafeError("Display name must be 32 characters or fewer.");
  }

  return name;
}

function normalizeMessageText(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new ClientSafeError("Message text is required.");
  }

  const text = value.trim();
  if (text.length > 500) {
    throw new ClientSafeError("Message text must be 500 characters or fewer.");
  }

  return text;
}

function serveFile(filePath: string, res: http.ServerResponse): void {
  fs.readFile(filePath, (error, contents) => {
    if (error) {
      res.statusCode = 404;
      res.end("Not found");
      return;
    }

    const ext = path.extname(filePath);
    const contentType =
      ext === ".html"
        ? "text/html; charset=utf-8"
        : ext === ".css"
          ? "text/css; charset=utf-8"
          : ext === ".js"
            ? "text/javascript; charset=utf-8"
            : "application/octet-stream";

    res.writeHead(200, {
      "content-type": contentType,
      "cache-control": "no-store",
    });
    res.end(contents);
  });
}

const server = http.createServer((req, res) => {
  const requestUrl = new URL(req.url || "/", "http://127.0.0.1");

  if (requestUrl.pathname === "/" || requestUrl.pathname === "/index.html") {
    serveFile(path.join(publicDir, "index.html"), res);
    return;
  }

  if (requestUrl.pathname === "/styles.css") {
    serveFile(path.join(publicDir, "styles.css"), res);
    return;
  }

  if (requestUrl.pathname === "/app.js") {
    serveFile(path.join(publicDir, "app.js"), res);
    return;
  }

  res.statusCode = 404;
  res.end("Not found");
});

const io = new Server(server);

io.on("connection", (socket) => {
  serveRoomType<typeof chatRoomType, ChatAuth>(socket, chatRoomType, {
    onAuth: () => ({
      userId: socket.id,
    }),

    initState: async (join) => {
      return {
        roomKey: normalizeRoomKey(join.roomKey),
        created: new Date().toISOString(),
        history: [],
      };
    },

    admit: async (join, ctx) => {
      const roomId = normalizeRoomId(join.roomId);
      const roomKey = normalizeRoomKey(join.roomKey);
      const userId = normalizeUserId(ctx.auth.userId);
      const userName = normalizeDisplayName(join.userName);

      if (ctx.serverState.roomKey !== roomKey) {
        throw new ClientSafeError("That room key is incorrect.");
      }

      return {
        roomId,
        memberId: userId,
        memberProfile: {
          userId,
          userName,
          joinedAt: Date.now(),
        },
        roomProfile: {
          roomId,
          created: ctx.serverState.created,
          history: ctx.serverState.history.slice(-50),
        },
      };
    },

    onJoin: async (member, ctx) => {
      await ctx.emit.systemNotice({
        text: `${member.userName} joined the room`,
        sentAt: new Date().toISOString(),
      });
    },

    onLeave: async (member, ctx) => {
      await ctx.emit.systemNotice({
        text: `${member.userName} left the room`,
        sentAt: new Date().toISOString(),
      });
    },

    rpc: {
      sendMessage: async ({ text }, ctx) => {
        const messageText = normalizeMessageText(text);

        const message: ChatMessage = {
          id: randomUUID(),
          name: ctx.memberProfile.userName,
          text: messageText,
          sentAt: new Date().toISOString(),
        };

        ctx.serverState.history.push(message);
        if (ctx.serverState.history.length > 50) {
          ctx.serverState.history.shift();
        }

        await ctx.emit.message(message);
        return { id: message.id };
      },
    },
  });
});

server.listen(port, "127.0.0.1", () => {
  console.log(`Chat example listening on http://127.0.0.1:${port}`);
});
