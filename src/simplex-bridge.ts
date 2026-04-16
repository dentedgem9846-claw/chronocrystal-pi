import { T } from "@simplex-chat/types";
import pino from "pino";
import { ChatClient } from "simplex-chat";

const log = pino({ name: "simplex-bridge" });

export interface BotConfig {
	host: string;
	port: number;
	displayName: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function formatChatError(chatError: unknown): string {
	if (!isRecord(chatError) || typeof chatError.type !== "string") {
		return "unknown chat error";
	}

	if (chatError.type === "error" && isRecord(chatError.errorType) && typeof chatError.errorType.type === "string") {
		return `error:${chatError.errorType.type}`;
	}

	if (
		chatError.type === "errorAgent" &&
		isRecord(chatError.agentError) &&
		typeof chatError.agentError.type === "string"
	) {
		return `errorAgent:${chatError.agentError.type}`;
	}

	if (
		chatError.type === "errorStore" &&
		isRecord(chatError.storeError) &&
		typeof chatError.storeError.type === "string"
	) {
		return `errorStore:${chatError.storeError.type}`;
	}

	return chatError.type;
}

function assertChatCommandSucceeded(response: unknown, command: string): void {
	if (!isRecord(response) || typeof response.type !== "string") {
		throw new Error(`Unexpected SimpleX response for ${command}`);
	}

	if (response.type === "chatCmdError" || response.type === "chatError") {
		throw new Error(`SimpleX command failed for ${command}: ${formatChatError(response.chatError)}`);
	}
}

type QueueNextResult<T> = { value: T | Promise<T>; done?: false } | { value?: undefined; done: true };

interface QueueIterator<T> {
	next(): Promise<QueueNextResult<T>>;
}

function awaitNextEvent<T>(
	iterator: QueueIterator<T>,
	timeoutMs: number,
): Promise<{ done: true } | { done: false; value: T }> {
	return new Promise((resolve, reject) => {
		const timeout = setTimeout(() => {
			reject(new Error(`No messages received for ${timeoutMs}ms - connection may be stale`));
		}, timeoutMs);

		iterator.next().then(
			async (result) => {
				clearTimeout(timeout);
				if (result.done) {
					resolve({ done: true });
					return;
				}

				resolve({ done: false, value: await result.value });
			},
			(err) => {
				clearTimeout(timeout);
				reject(err);
			},
		);
	});
}

/**
 * Safely extract text from an incoming direct message payload.
 */
export function extractReceivedText(chatItem: T.ChatItem): string | null {
	if (chatItem.content.type !== "rcvMsgContent") {
		return null;
	}

	const msgContent = chatItem.content.msgContent;
	if (!isRecord(msgContent) || msgContent.type !== "text") {
		return null;
	}

	return typeof msgContent.text === "string" ? msgContent.text : null;
}

function hasMalformedReceivedText(chatItem: T.ChatItem): boolean {
	if (chatItem.content.type !== "rcvMsgContent") {
		return false;
	}

	const msgContent = chatItem.content.msgContent;
	return isRecord(msgContent) && msgContent.type === "text" && typeof msgContent.text !== "string";
}

export class SimplexBridge {
	private chatClient: ChatClient | null = null;
	private userId: number | null = null;

	async connect(config: BotConfig): Promise<string> {
		log.info({ host: config.host, port: config.port }, "connecting");

		this.chatClient = await ChatClient.create(`ws://${config.host}:${config.port}`);

		const existingUser = await this.chatClient.apiGetActiveUser();
		if (existingUser) {
			this.userId = existingUser.userId;
			log.info({ userId: this.userId, name: existingUser.profile.displayName }, "user found");
		} else {
			const newUser = await this.chatClient.apiCreateActiveUser({
				displayName: config.displayName,
				fullName: config.displayName,
			});
			this.userId = newUser.userId;
			log.info({ userId: this.userId, displayName: config.displayName }, "user created");
		}

		const address =
			(await this.chatClient.apiGetUserAddress(this.userId)) ??
			(await this.chatClient.apiCreateUserAddress(this.userId));
		log.info({ address }, "bot address ready");

		await this.chatClient.enableAddressAutoAccept(this.userId);
		log.info({ userId: this.userId }, "auto-accept enabled");

		log.info({ userId: this.userId }, "connected");
		return address;
	}

	async *listen(timeoutMs = 300000): AsyncGenerator<{ chatId: number; message: string }, void, unknown> {
		if (!this.chatClient) {
			throw new Error("Not connected to simplex-chat");
		}

		log.info({ timeoutMs }, "listen started");
		const iterator = this.chatClient.msgQ[Symbol.asyncIterator]();

		try {
			while (true) {
				if (!this.chatClient.connected) {
					throw new Error("SimpleX connection closed");
				}

				const nextEvent = await awaitNextEvent(iterator, timeoutMs).catch((err: unknown) => {
					log.error(
						{ timeoutMs, err: err instanceof Error ? err.message : String(err) },
						"timeout or stream failure while waiting for events",
					);
					throw err;
				});

				if (nextEvent.done) {
					throw new Error("SimpleX event stream ended");
				}

				const event = nextEvent.value;
				log.debug({ eventType: event.type }, "event received");

				if (event.type === "contactConnected") {
					log.info(
						{ contactId: event.contact.contactId, displayName: event.contact.profile.displayName },
						"contact connected - sending welcome",
					);

					try {
						await this.reply(event.contact.contactId, `Welcome, ${event.contact.profile.displayName}!`);
						log.info({ contactId: event.contact.contactId }, "welcome sent");
					} catch (err) {
						log.error(
							{ contactId: event.contact.contactId, err: err instanceof Error ? err.message : String(err) },
							"welcome reply failed",
						);
					}

					continue;
				}

				if (event.type !== "newChatItems") {
					continue;
				}

				log.debug({ itemCount: event.chatItems.length }, "new chat items");

				for (const { chatInfo, chatItem } of event.chatItems) {
					if (chatInfo.type !== T.ChatType.Direct) {
						log.debug({ chatType: chatInfo.type }, "skipping non-direct chat");
						continue;
					}

					const text = extractReceivedText(chatItem);
					if (text === null) {
						if (hasMalformedReceivedText(chatItem)) {
							log.warn({ chatId: chatInfo.contact.contactId }, "skipping malformed text payload");
						} else {
							log.debug({ contentType: chatItem.content.type }, "skipping non-text content");
						}
						continue;
					}

					const preview = text.slice(0, 80);
					log.info({ chatId: chatInfo.contact.contactId, preview }, "message received - yielding");
					yield { chatId: chatInfo.contact.contactId, message: text };
				}
			}
		} finally {
			log.info("listen ended");
		}
	}

	async reply(chatId: number, message: string): Promise<void> {
		if (!this.chatClient || !this.userId) {
			throw new Error("Not connected to simplex-chat");
		}
		try {
			await this.chatClient.apiSendTextMessage(T.ChatType.Direct, chatId, message);
			log.info({ chatId, chars: message.length }, "reply sent");
		} catch (err) {
			log.error({ chatId, err: err instanceof Error ? err.message : String(err) }, "reply failed");
			throw err;
		}
	}

	/**
	 * Send a live message (shows in real-time as user types).
	 * Uses the raw API to access liveMessage parameter.
	 */
	async sendLiveMessage(chatId: number, message: string): Promise<void> {
		if (!this.chatClient || !this.userId) {
			throw new Error("Not connected to simplex-chat");
		}

		const chatRef = `direct=${chatId}`;
		const composedMessages = JSON.stringify([{ msgContent: { type: "text", text: message }, mentions: {} }]);
		const cmd = `/_send ${chatRef} live=on json ${composedMessages}`;

		log.debug({ chatId, chars: message.length, cmdPreview: cmd.slice(0, 100) }, "sending live message");

		try {
			const response = await this.chatClient.sendChatCmd(cmd);
			assertChatCommandSucceeded(response, cmd);
			log.info({ chatId, chars: message.length }, "live message sent");
		} catch (err) {
			log.error({ chatId, err: err instanceof Error ? err.message : String(err) }, "live message failed");
			throw err;
		}
	}

	async disconnect(): Promise<void> {
		if (!this.chatClient) {
			return;
		}

		try {
			await this.chatClient.disconnect();
		} finally {
			this.chatClient = null;
			this.userId = null;
			log.info({}, "disconnected");
		}
	}
}
