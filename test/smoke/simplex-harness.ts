import { T, type ChatEvent } from "@simplex-chat/types";
import { ChatClient } from "simplex-chat";
import { constants } from "node:fs";
import { access, rm } from "node:fs/promises";
import { createServer } from "node:net";

export const SIMPLEX_START_TIMEOUT_MS = 30_000;
export const CONTACT_READY_TIMEOUT_MS = 90_000;
export const PRE_SEND_IDLE_TIMEOUT_MS = 2_000;
export const REPLY_TIMEOUT_MS = 120_000;
export const PROCESS_SHUTDOWN_TIMEOUT_MS = 5_000;
export const LOCAL_SIMPLEX_HOST = "127.0.0.1";

export interface AutomationStatus {
	ok: boolean;
	simplexAddress: string;
	environment: string;
	service: string;
	publicDomain: string;
}

export class BufferedChatEvents {
	#queue: ChatEvent[] = [];
	#resolvers: Array<(event: ChatEvent | null) => void> = [];
	#error: Error | null = null;
	#closed = false;

	constructor(source: AsyncIterable<ChatEvent>) {
		void this.consume(source);
	}

	private async consume(source: AsyncIterable<ChatEvent>): Promise<void> {
		try {
			for await (const event of source) {
				const resolve = this.#resolvers.shift();
				if (resolve) {
					resolve(event);
					continue;
				}
				this.#queue.push(event);
			}
		} catch (error) {
			this.#error = normalizeError(error);
		} finally {
			this.#closed = true;
			while (this.#resolvers.length > 0) {
				this.#resolvers.shift()?.(null);
			}
		}
	}

	async next(timeoutMs: number): Promise<ChatEvent | null> {
		if (this.#error) {
			throw this.#error;
		}

		const queued = this.#queue.shift();
		if (queued) {
			return queued;
		}

		if (this.#closed) {
			throw new Error("SimpleX event stream ended unexpectedly");
		}

		return await new Promise<ChatEvent | null>((resolve, reject) => {
			const finish = (event: ChatEvent | null) => {
				clearTimeout(timer);
				const index = this.#resolvers.indexOf(finish);
				if (index >= 0) {
					this.#resolvers.splice(index, 1);
				}

				if (this.#error) {
					reject(this.#error);
					return;
				}

				if (event === null) {
					if (this.#closed) {
						reject(new Error("SimpleX event stream ended unexpectedly"));
						return;
					}
					resolve(null);
					return;
				}

				resolve(event);
			};

			const timer = setTimeout(() => finish(null), timeoutMs);
			this.#resolvers.push(finish);
		});
	}
}

export async function* iterateChatEvents(source: {
	next(): Promise<{ value?: ChatEvent | Promise<ChatEvent>; done?: boolean }>;
}) {
	while (true) {
		const next = await source.next();
		if (next.done) {
			return;
		}
		if (next.value !== undefined) {
			yield await next.value;
		}
	}
}

export async function verifyHealth(baseUrl: string): Promise<void> {
	const response = await fetch(new URL("/health", baseUrl));
	const body = await response.text();

	if (!response.ok) {
		throw new Error(`Health check failed with ${response.status}: ${body}`);
	}
	if (body.trim() !== "ok") {
		throw new Error(`Health check returned unexpected body: ${body}`);
	}
}

export async function fetchAutomationStatus(baseUrl: string): Promise<AutomationStatus> {
	const response = await fetch(new URL("/automation/status", baseUrl));
	const body = await response.text();
	if (!response.ok) {
		throw new Error(`Automation status failed with ${response.status}: ${body}`);
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(body);
	} catch (error) {
		throw new Error(`Automation status returned invalid JSON: ${normalizeError(error).message}`);
	}

	if (!isAutomationStatus(parsed)) {
		throw new Error(`Automation status returned an unexpected payload: ${body}`);
	}
	if (!parsed.ok) {
		throw new Error(`Automation status reported not ok: ${body}`);
	}
	return parsed;
}

export function isAutomationStatus(value: unknown): value is AutomationStatus {
	if (!value || typeof value !== "object") {
		return false;
	}
	const candidate = value as Record<string, unknown>;
	return candidate.ok === true
		&& typeof candidate.simplexAddress === "string"
		&& candidate.simplexAddress.length > 0
		&& typeof candidate.environment === "string"
		&& typeof candidate.service === "string"
		&& typeof candidate.publicDomain === "string";
}

export async function resolveSimplexBinary(): Promise<string> {
	const configured = process.env.SIMPLEX_CHAT_BIN?.trim();
	if (configured) {
		if (configured.includes("/")) {
			await access(configured, constants.X_OK);
			return configured;
		}

		const resolvedConfigured = Bun.which(configured);
		if (resolvedConfigured) {
			return resolvedConfigured;
		}
		throw new Error(`SIMPLEX_CHAT_BIN was set but could not be resolved: ${configured}`);
	}

	const resolved = Bun.which("simplex-chat");
	if (resolved) {
		return resolved;
	}
	throw new Error("simplex-chat binary not found on PATH. Install the SimpleX terminal CLI or set SIMPLEX_CHAT_BIN.");
}

export async function getFreePort(): Promise<number> {
	return await new Promise<number>((resolve, reject) => {
		const server = createServer();
		server.once("error", reject);
		server.listen(0, LOCAL_SIMPLEX_HOST, () => {
			const address = server.address();
			if (!address || typeof address === "string") {
				server.close(() => {
					reject(new Error("Failed to allocate a local TCP port"));
				});
				return;
			}

			server.close((error) => {
				if (error) {
					reject(error);
					return;
				}
				resolve(address.port);
			});
		});
	});
}

export function launchSimplex(binary: string, dataPrefix: string, port: number, displayName: string): Bun.PipedSubprocess {
	return Bun.spawn({
		cmd: [binary, "-d", dataPrefix, "-p", String(port), "-y", "--create-bot-display-name", displayName],
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
		lazy: true,
	});
}

export async function connectLocalClient(port: number, simplexProcess: Bun.PipedSubprocess): Promise<ChatClient> {
	const serverUrl = `ws://${LOCAL_SIMPLEX_HOST}:${port}`;
	const deadline = Date.now() + SIMPLEX_START_TIMEOUT_MS;
	let lastError: Error | null = null;

	while (Date.now() < deadline) {
		if (simplexProcess.exitCode !== null) {
			const output = await readSubprocessOutput(simplexProcess);
			throw new Error(`simplex-chat exited before the WebSocket API was ready (code ${simplexProcess.exitCode}). stderr: ${output.stderr || "<empty>"}`);
		}
		try {
			return await ChatClient.create(serverUrl);
		} catch (error) {
			lastError = normalizeError(error);
			await Bun.sleep(500);
		}
	}

	throw new Error(`Timed out waiting for local simplex-chat on ${serverUrl}: ${lastError?.message ?? "unknown error"}`);
}

export function buildSmokeUserDisplayName(prefix = "ChronoCrystalSmoke"): string {
	return `${prefix}${Date.now().toString(36)}`;
}

export async function ensureActiveUser(chatClient: ChatClient, displayName: string) {
	const activeUser = await chatClient.apiGetActiveUser();
	if (activeUser) {
		return activeUser;
	}
	return await chatClient.apiCreateActiveUser({
		displayName,
		fullName: "ChronoCrystal Production Smoke Test",
	});
}

export async function waitForContactReady(events: BufferedChatEvents): Promise<number> {
	while (true) {
		const event = await events.next(CONTACT_READY_TIMEOUT_MS);
		if (!event) {
			throw new Error(`Timed out after ${CONTACT_READY_TIMEOUT_MS}ms waiting for the production contact to become ready`);
		}
		throwOnFailureEvent(event);
		if (event.type === "contactConnected" || event.type === "contactSndReady") {
			return event.contact.contactId;
		}
	}
}

export async function drainPreSendEvents(events: BufferedChatEvents): Promise<void> {
	while (true) {
		const event = await events.next(PRE_SEND_IDLE_TIMEOUT_MS);
		if (!event) {
			return;
		}
		throwOnFailureEvent(event);
	}
}

export async function waitForDirectReply(events: BufferedChatEvents, contactId: number, sentAt: number): Promise<string> {
	while (true) {
		const event = await events.next(REPLY_TIMEOUT_MS);
		if (!event) {
			throw new Error(`Timed out after ${REPLY_TIMEOUT_MS}ms waiting for a bot reply`);
		}
		throwOnFailureEvent(event);
		if (event.type !== "newChatItems") {
			continue;
		}

		for (const { chatInfo, chatItem } of event.chatItems) {
			if (chatInfo.type !== T.ChatType.Direct || chatInfo.contact.contactId !== contactId) {
				continue;
			}
			if (chatItem.content.type !== "rcvMsgContent" || chatItem.content.msgContent.type !== "text") {
				continue;
			}
			const itemTimestamp = Date.parse(chatItem.meta.itemTs);
			if (Number.isFinite(itemTimestamp) && itemTimestamp < sentAt) {
				continue;
			}
			return chatItem.content.msgContent.text.trim();
		}
	}
}

export async function collectDirectReplies(
	events: BufferedChatEvents,
	contactId: number,
	sentAt: number,
	options: { overallTimeoutMs: number; idleTimeoutMs: number; breakOnMatch?: (text: string) => boolean },
): Promise<string[]> {
	const replies: string[] = [];
	const deadline = Date.now() + options.overallTimeoutMs;
	let matchedBreak = false;

	while (Date.now() < deadline) {
		const timeout = replies.length > 0 ? options.idleTimeoutMs : Math.max(1, deadline - Date.now());
		const event = await events.next(timeout);
		if (!event) {
			if (replies.length > 0) {
				return replies;
			}
			continue;
		}
		throwOnFailureEvent(event);
		if (event.type !== "newChatItems") {
			continue;
		}

		for (const { chatInfo, chatItem } of event.chatItems) {
			if (chatInfo.type !== T.ChatType.Direct || chatInfo.contact.contactId !== contactId) {
				continue;
			}
			if (chatItem.content.type !== "rcvMsgContent" || chatItem.content.msgContent.type !== "text") {
				continue;
			}
			const itemTimestamp = Date.parse(chatItem.meta.itemTs);
			if (Number.isFinite(itemTimestamp) && itemTimestamp < sentAt) {
				continue;
			}
			const text = chatItem.content.msgContent.text.trim();
			replies.push(text);
			if (options.breakOnMatch?.(text)) {
				matchedBreak = true;
			}
		}

		if (matchedBreak) {
			const maybeMore = await events.next(options.idleTimeoutMs);
			if (!maybeMore) {
				return replies;
			}
			throwOnFailureEvent(maybeMore);
			if (maybeMore.type === "newChatItems") {
				for (const { chatInfo, chatItem } of maybeMore.chatItems) {
					if (chatInfo.type !== T.ChatType.Direct || chatInfo.contact.contactId !== contactId) {
						continue;
					}
					if (chatItem.content.type !== "rcvMsgContent" || chatItem.content.msgContent.type !== "text") {
						continue;
					}
					const itemTimestamp = Date.parse(chatItem.meta.itemTs);
					if (Number.isFinite(itemTimestamp) && itemTimestamp < sentAt) {
						continue;
					}
					replies.push(chatItem.content.msgContent.text.trim());
				}
			}
			return replies;
		}
	}

	return replies;
}

export function throwOnFailureEvent(event: ChatEvent): void {
	if (event.type === "messageError") {
		throw new Error(`SimpleX message error: ${event.errorMessage}`);
	}
	if (event.type === "chatError") {
		throw new Error(`SimpleX chat error: ${JSON.stringify(event.chatError)}`);
	}
	if (event.type === "chatErrors") {
		throw new Error(`SimpleX chat errors: ${JSON.stringify(event.chatErrors)}`);
	}
}

export async function cleanupResources(options: {
	chatClient: ChatClient | null;
	contactId: number | null;
	simplexProcess: Bun.PipedSubprocess | null;
	tempDir: string;
}): Promise<string[]> {
	const errors: string[] = [];

	if (options.chatClient && options.contactId !== null) {
		try {
			await options.chatClient.apiDeleteChat(T.ChatType.Direct, options.contactId, {
				type: "entity",
				notify: false,
			});
		} catch (error) {
			errors.push(`delete chat: ${normalizeError(error).message}`);
		}
	}

	if (options.chatClient) {
		try {
			await options.chatClient.disconnect();
		} catch (error) {
			errors.push(`disconnect client: ${normalizeError(error).message}`);
		}
	}

	if (options.simplexProcess) {
		try {
			if (options.simplexProcess.exitCode === null && !options.simplexProcess.killed) {
				options.simplexProcess.kill("SIGTERM");
				await waitForProcessExit(options.simplexProcess, PROCESS_SHUTDOWN_TIMEOUT_MS);
			}
		} catch (error) {
			errors.push(`stop simplex-chat: ${normalizeError(error).message}`);
			if (options.simplexProcess.exitCode === null && !options.simplexProcess.killed) {
				try {
					options.simplexProcess.kill("SIGKILL");
					await options.simplexProcess.exited;
				} catch (killError) {
					errors.push(`kill simplex-chat: ${normalizeError(killError).message}`);
				}
			}
		}
	}

	try {
		await rm(options.tempDir, { recursive: true, force: true });
	} catch (error) {
		errors.push(`remove temp dir: ${normalizeError(error).message}`);
	}

	return errors;
}

export async function waitForProcessExit(process: Bun.Subprocess<any, any, any>, timeoutMs: number): Promise<void> {
	await Promise.race([
		process.exited.then(() => undefined),
		new Promise<never>((_, reject) => {
			setTimeout(() => reject(new Error(`Timed out waiting ${timeoutMs}ms for simplex-chat to exit`)), timeoutMs);
		}),
	]);
}

export async function readSubprocessOutput(process: Bun.PipedSubprocess): Promise<{ stdout: string; stderr: string }> {
	const stdout = process.stdout ? (await process.stdout.text()).trim() : "";
	const stderr = process.stderr ? (await process.stderr.text()).trim() : "";
	return { stdout, stderr };
}

export function normalizeError(error: unknown): Error {
	return error instanceof Error ? error : new Error(String(error));
}
