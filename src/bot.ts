/**
 * ChronoCrystal Bot - SimpleX bridge with Pi coding agent.
 *
 * Connects to SimpleX chat network, receives messages, processes them
 * with the Pi coding agent, and replies back.
 */
import { getModel, type Model } from "@mariozechner/pi-ai";
import { type AgentSession, createAgentSession, SessionManager } from "@mariozechner/pi-coding-agent";
import pino from "pino";

import { EMPTY_RESPONSE_REPLY, GENERATION_ERROR_REPLY, parseBotModel } from "./config.js";
import { type BotConfig, SimplexBridge } from "./simplex-bridge.js";

const log = pino({ name: "bot" });
const CHAT_SESSION_TTL_MS = 24 * 60 * 60 * 1000;

interface ChatSessionEntry {
	session: AgentSession;
	lastUsedAt: number;
}

interface TurnCompletionWaiter {
	promise: Promise<string>;
	cancel: () => void;
}

type SessionMessage = AgentSession["messages"][number];

// Exported so the web server can display the bot's SimpleX address
export let botAddress: string | null = null;

export interface BotOptions {
	displayName: string;
	model: string;
	simplexHost: string;
	simplexPort: number;
}

/**
 * Main bot function - connects to SimpleX and processes messages with the agent.
 */
export async function startBot(options: BotOptions): Promise<void> {
	const displayName = options.displayName;
	const modelSpec = options.model;
	const simplexHost = options.simplexHost;
	const simplexPort = options.simplexPort;

	log.info({ displayName, modelSpec, simplexHost, simplexPort }, "starting bot");

	const { provider, modelId } = parseBotModel(modelSpec);
	// @ts-expect-error - dynamic model IDs from providers like openrouter aren't in static types
	const model = getModel(provider, modelId);
	const sessions = new Map<number, ChatSessionEntry>();

	log.info({ provider, modelId }, "model resolved");

	const bridge = new SimplexBridge();
	const botConfig: BotConfig = {
		host: simplexHost,
		port: simplexPort,
		displayName,
	};

	let address: string;
	try {
		address = await bridge.connect(botConfig);
	} catch (err) {
		log.error({ err: err instanceof Error ? err.message : String(err) }, "failed to connect to SimpleX");
		throw err;
	}

	botAddress = address;
	log.info({ address }, "bot ready - waiting for messages");

	try {
		for await (const { chatId, message } of bridge.listen()) {
			log.info({ chatId, message: message.slice(0, 100) }, "processing message");
			pruneExpiredSessions(sessions);

			try {
				const session = await getChatSession(sessions, chatId, model);
				const reply = await processMessage(session, message);
				await sendReplySafely(bridge, chatId, reply, "assistant reply");
			} catch (err) {
				log.error({ chatId, err: err instanceof Error ? err.message : String(err) }, "failed to process message");
				await sendReplySafely(bridge, chatId, GENERATION_ERROR_REPLY, "generation error reply");
			}
		}
	} catch (err) {
		log.error({ err: err instanceof Error ? err.message : String(err) }, "listener error");
		throw err;
	} finally {
		botAddress = null;
		disposeAllSessions(sessions);
		await bridge.disconnect();
	}
}

async function getChatSession(
	sessions: Map<number, ChatSessionEntry>,
	chatId: number,
	model: Model<any>,
): Promise<AgentSession> {
	const existing = sessions.get(chatId);
	const now = Date.now();

	if (existing && now - existing.lastUsedAt <= CHAT_SESSION_TTL_MS) {
		existing.lastUsedAt = now;
		return existing.session;
	}

	if (existing) {
		existing.session.dispose();
		sessions.delete(chatId);
		log.info({ chatId }, "disposed expired chat session");
	}

	const session = await createChatSession(model);
	sessions.set(chatId, { session, lastUsedAt: now });
	log.info({ chatId, sessionId: session.sessionId }, "created chat session");
	return session;
}

async function createChatSession(model: Model<any>): Promise<AgentSession> {
	const { session, extensionsResult } = await createAgentSession({
		model,
		thinkingLevel: "off",
		sessionManager: SessionManager.inMemory(),
	});

	log.info(
		{
			sessionId: session.sessionId,
			extensionsLoaded: extensionsResult.extensions.length,
			extensionsFailed: extensionsResult.errors.length,
		},
		"agent session ready",
	);

	return session;
}

function pruneExpiredSessions(sessions: Map<number, ChatSessionEntry>, now = Date.now()): void {
	for (const [chatId, entry] of sessions) {
		if (now - entry.lastUsedAt <= CHAT_SESSION_TTL_MS) {
			continue;
		}

		entry.session.dispose();
		sessions.delete(chatId);
		log.info({ chatId }, "pruned inactive chat session");
	}
}

function disposeAllSessions(sessions: Map<number, ChatSessionEntry>): void {
	for (const [chatId, entry] of sessions) {
		entry.session.dispose();
		log.info({ chatId }, "disposed chat session");
	}

	sessions.clear();
}

async function sendReplySafely(
	bridge: SimplexBridge,
	chatId: number,
	message: string,
	replyType: string,
): Promise<void> {
	try {
		await bridge.reply(chatId, message);
	} catch (err) {
		log.error({ chatId, replyType, err: err instanceof Error ? err.message : String(err) }, "failed to send reply");
	}
}

/**
 * Extract text content from an assistant message.
 */
export function extractAssistantText(message: SessionMessage): string {
	if (message.role !== "assistant") {
		return "";
	}

	const texts: string[] = [];
	for (const content of message.content) {
		if (content.type === "text" && typeof content.text === "string") {
			texts.push(content.text);
		}
	}

	return texts.join("\n");
}

/**
 * Extract the latest assistant reply emitted after a user turn starts.
 */
export function extractAssistantReply(messages: readonly SessionMessage[], startIndex: number): string {
	let latestReply = "";

	for (const message of messages.slice(startIndex)) {
		if (message.role !== "assistant" || message.stopReason === "aborted") {
			continue;
		}

		const text = extractAssistantText(message).trim();
		if (text) {
			latestReply = text;
		}
	}

	return latestReply;
}

/**
 * Process a user message through the agent and return the assistant response.
 */
async function processMessage(session: AgentSession, userMessage: string): Promise<string> {
	const preview = userMessage.slice(0, 80);
	const startIndex = session.messages.length;
	const waiter = waitForTurnCompletion(session, startIndex);

	log.info({ sessionId: session.sessionId, message: preview }, "sending user message to agent");

	try {
		await session.sendUserMessage(userMessage);
		const reply = (await waiter.promise).trim();
		if (!reply) {
			log.warn({ sessionId: session.sessionId }, "assistant produced no text reply");
			return EMPTY_RESPONSE_REPLY;
		}

		log.info({ sessionId: session.sessionId, chars: reply.length }, "reply ready");
		return reply;
	} catch (err) {
		waiter.cancel();
		throw err;
	}
}

function waitForTurnCompletion(session: AgentSession, startIndex: number): TurnCompletionWaiter {
	let settled = false;
	let unsubscribe = () => {};

	const promise = new Promise<string>((resolve) => {
		const finish = () => {
			if (settled) {
				return;
			}

			settled = true;
			unsubscribe();
			resolve(extractAssistantReply(session.messages, startIndex));
		};

		unsubscribe = session.subscribe((event) => {
			if (event.type === "agent_end") {
				finish();
			}
		});
	});

	return {
		promise,
		cancel: () => {
			if (settled) {
				return;
			}

			settled = true;
			unsubscribe();
		},
	};
}
