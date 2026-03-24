import { io } from "socket.io-client";

import { createRoomClient, type JoinedRoom } from "../../src/index";
import { chatRoomType, type ChatMessage } from "../common";

const socket = io();
const chatClient = createRoomClient(socket, chatRoomType);

const joinPanel = document.getElementById("join-panel") as HTMLElement;
const workspace = document.getElementById("workspace") as HTMLElement;
const joinForm = document.getElementById("join-form") as HTMLFormElement;
const messageForm = document.getElementById("message-form") as HTMLFormElement;
const leaveButton = document.getElementById("leave-button") as HTMLButtonElement;
const presencePrevButton = document.getElementById("presence-prev") as HTMLButtonElement;
const presenceNextButton = document.getElementById("presence-next") as HTMLButtonElement;
const status = document.getElementById("status") as HTMLParagraphElement;
const roomTitle = document.getElementById("room-title") as HTMLHeadingElement;
const roomSubtitle = document.getElementById("room-subtitle") as HTMLParagraphElement;
const messages = document.getElementById("messages") as HTMLElement;
const presenceList = document.getElementById("presence-list") as HTMLUListElement;
const presenceCount = document.getElementById("presence-count") as HTMLSpanElement;
const presencePage = document.getElementById("presence-page") as HTMLParagraphElement;
const nameInput = document.getElementById("name-input") as HTMLInputElement;
const roomInput = document.getElementById("room-input") as HTMLInputElement;
const keyInput = document.getElementById("key-input") as HTMLInputElement;
const messageInput = document.getElementById("message-input") as HTMLInputElement;

let joinedRoom: JoinedRoom<typeof chatRoomType> | null = null;
let stopRoomListeners: (() => void) | null = null;
let presenceOffset = 0;
const presencePageSize = 4;

function setStatus(message: string): void {
	status.textContent = message;
}

function setWorkspaceVisible(visible: boolean): void {
	workspace.classList.toggle("hidden", !visible);
	joinPanel.classList.toggle("hidden", visible);
}

function clearMessages(): void {
	messages.innerHTML = "";
}

function renderMessage(message: ChatMessage): void {
	const item = document.createElement("article");
	item.className = "message";
	item.innerHTML = `
    <div class="message-header">
      <span class="message-name">${escapeHtml(message.name)}</span>
      <span class="message-time">${formatTime(message.sentAt)}</span>
    </div>
    <div class="message-text">${escapeHtml(message.text)}</div>
  `;
	messages.appendChild(item);
	messages.scrollTop = messages.scrollHeight;
}

function renderSystemNotice(text: string, sentAt: string): void {
	const item = document.createElement("article");
	item.className = "message";
	item.innerHTML = `
    <div class="message-header">
      <span class="message-name">System</span>
      <span class="message-time">${formatTime(sentAt)}</span>
    </div>
    <div class="message-text">${escapeHtml(text)}</div>
  `;
	messages.appendChild(item);
	messages.scrollTop = messages.scrollHeight;
}

function renderHistory(history: ChatMessage[]): void {
	clearMessages();
	for (const message of history) {
		renderMessage(message);
	}
}

function renderPresence(): void {
	if (!joinedRoom) {
		presenceCount.textContent = "0 online";
		presencePage.textContent = "Showing 0 members.";
		presenceList.innerHTML = "";
		return;
	}

	const presence = joinedRoom.presence.current;
	presenceCount.textContent = `${presence.count} online`;
	presencePage.textContent = `Showing ${Math.min(presenceOffset + 1, presence.count)}-${Math.min(
		presenceOffset + presence.members.length,
		presence.count,
	)} of ${presence.count} members.`;
	presenceList.innerHTML = "";

	if (presence.members.length === 0) {
		const empty = document.createElement("li");
		empty.className = "presence-empty";
		empty.textContent = "Nobody is here yet.";
		presenceList.appendChild(empty);
		return;
	}

	for (const entry of presence.members) {
		const item = document.createElement("li");
		item.className = "presence-item";
		item.innerHTML = `
      <span>${escapeHtml(entry.memberProfile.userName)}</span>
      <span class="presence-pill" aria-hidden="true"></span>
    `;
		presenceList.appendChild(item);
	}
}

async function refreshPresence(): Promise<void> {
	if (!joinedRoom) {
		return;
	}

	const [count, page] = await Promise.all([
		joinedRoom.presence.count(),
		joinedRoom.presence.list({ offset: presenceOffset, limit: presencePageSize }),
	]);

	presenceCount.textContent = `${count} online`;
	presencePage.textContent = page.members.length === 0
		? `Showing 0 of ${count} members.`
		: `Showing ${page.offset + 1}-${page.offset + page.members.length} of ${count} members.`;

	presenceList.innerHTML = "";
	if (page.members.length === 0) {
		const empty = document.createElement("li");
		empty.className = "presence-empty";
		empty.textContent = "Nobody is here yet.";
		presenceList.appendChild(empty);
		return;
	}

	for (const entry of page.members) {
		const item = document.createElement("li");
		item.className = "presence-item";
		item.innerHTML = `
      <span>${escapeHtml(entry.memberProfile.userName)}</span>
      <span class="presence-pill" aria-hidden="true"></span>
    `;
		presenceList.appendChild(item);
	}
}

function formatTime(value: string): string {
	const date = new Date(value);
	return Number.isNaN(date.getTime())
		? ""
		: new Intl.DateTimeFormat(undefined, {
			hour: "2-digit",
			minute: "2-digit",
		}).format(date);
}

function escapeHtml(value: string): string {
	return String(value)
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#39;");
}

async function connectRoom(): Promise<void> {
	const payload = {
		roomId: roomInput.value.trim().toLowerCase(),
		roomKey: keyInput.value,
		userName: nameInput.value,
	};

	setStatus("Joining room...");

	try {
		presenceOffset = 0;
		joinedRoom = await chatClient.join(payload);
		renderHistory(joinedRoom.roomProfile.history);
		stopRoomListeners = joinedRoom.listen({
			events: {
				message: (message) => {
					renderMessage(message);
				},
				systemNotice: (notice) => {
					renderSystemNotice(notice.text, notice.sentAt);
				},
			},
			presence: {
				onChange: () => {
					void refreshPresence();
				},
			},
		});
		await refreshPresence();

		roomTitle.textContent = joinedRoom.roomId;
		roomSubtitle.textContent = `Signed in as ${payload.userName}. The room stays private behind the shared key.`;
		setWorkspaceVisible(true);
		setStatus(`Connected to ${joinedRoom.roomId}.`);
		messageInput.focus();
	} catch (error) {
		joinedRoom = null;
		setStatus(error instanceof Error ? error.message : String(error));
	}
}

async function leaveRoom(): Promise<void> {
	if (!joinedRoom) {
		return;
	}

	const roomId = joinedRoom.roomId;

	try {
		await joinedRoom.leave();
	} finally {
		stopRoomListeners?.();
		stopRoomListeners = null;
		joinedRoom = null;

		setWorkspaceVisible(false);
		joinForm.reset();
		clearMessages();
		presenceList.innerHTML = "";
		presenceCount.textContent = "0 online";
		presencePage.textContent = "Showing 0 members.";
		roomTitle.textContent = "-";
		roomSubtitle.textContent = "-";
		setStatus(`Left ${roomId}.`);
	}
}

joinForm.addEventListener("submit", async (event) => {
	event.preventDefault();
	await connectRoom();
});

messageForm.addEventListener("submit", async (event) => {
	event.preventDefault();

	if (!joinedRoom) {
		setStatus("Join a room before sending messages.");
		return;
	}

	const text = messageInput.value.trim();
	if (!text) {
		return;
	}

	try {
		await joinedRoom.rpc.sendMessage({ text });
		messageInput.value = "";
	} catch (error) {
		setStatus(error instanceof Error ? error.message : String(error));
	}
});

leaveButton.addEventListener("click", async () => {
	await leaveRoom();
});

presencePrevButton.addEventListener("click", async () => {
	if (!joinedRoom || presenceOffset === 0) {
		return;
	}

	presenceOffset = Math.max(0, presenceOffset - presencePageSize);
	await refreshPresence();
});

presenceNextButton.addEventListener("click", async () => {
	if (!joinedRoom) {
		return;
	}

	presenceOffset += presencePageSize;
	await refreshPresence();
});

socket.on("connect", () => {
	setStatus("Connected. Join a room to start chatting.");
});

socket.on("disconnect", () => {
	setStatus("Disconnected from the server.");
});

setWorkspaceVisible(false);
setStatus("Connecting to server...");
presencePage.textContent = "Showing 0 members.";
