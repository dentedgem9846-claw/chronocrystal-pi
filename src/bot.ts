/**
 * ChronoCrystal Bot - SimpleX bridge with Pi coding agent.
 *
 * Connects to SimpleX chat network, receives messages, processes them
 * with the Pi coding agent, and replies back.
 */
import { getModel } from "@mariozechner/pi-ai";
import type { KnownProvider } from "@mariozechner/pi-ai";
import pino from "pino";

import { createChatSession, type ChatSessionState } from "./simplex-chat-session.js";
import { SimplexBridge, type BotConfig } from "./simplex-bridge.js";
import {
    EMPTY_RESPONSE_REPLY,
    GENERATION_ERROR_REPLY,
} from "./config.js";
import { formatProviderErrorForUser } from "./provider-error.js";
import { startServer } from "./server.js";

const log = pino({ name: "bot" });


export interface BotOptions {
    displayName: string;
    provider: string;
    modelId: string;
    simplexHost: string;
    simplexPort: number;
}


/**
 * Main bot function - connects to SimpleX and processes messages with the agent.
 */
export async function startBot(options: BotOptions): Promise<void> {
    const displayName = options.displayName;
    const provider = options.provider;
    const modelId = options.modelId;
    const simplexHost = options.simplexHost;
    const simplexPort = options.simplexPort;

    log.info(
        { displayName, provider, modelId, simplexHost, simplexPort },
        "starting bot"
    );

    // OpenRouter accepts arbitrary third-party model IDs not in the static registry.
    const model = getModel(provider as KnownProvider, modelId as never);

    if (!model) {
        throw new Error(`Model not found: ${provider}/${modelId}`);
    }

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
        log.error(
            { err: err instanceof Error ? err.message : String(err) },
            "failed to connect to SimpleX"
        );
        throw err;
    }

    const chatSessions = new Map<number, ChatSessionState>();

    log.info({ address }, "bot ready - waiting for messages");

    await startServer(address);

    try {
        for await (const { chatId, message } of bridge.listen()) {
            log.info({ chatId, message: message.slice(0, 100) }, "processing message");

            let chatSession = chatSessions.get(chatId);
            if (!chatSession) {
                log.info({ chatId }, "creating chat session");
                chatSession = await createChatSession({ chatId, model, bridge });
                chatSessions.set(chatId, chatSession);
            }

            try {
                const reply = await processMessage(chatSession, message);
                if (reply) {
                    await bridge.reply(chatId, reply);
                }
            } catch (err) {
                const providerReply = formatProviderErrorForUser(err, `${provider}/${modelId}`);
                log.error(
                    {
                        chatId,
                        provider,
                        modelId,
                        err: err instanceof Error ? err.message : String(err),
                        providerReply,
                    },
                    "failed to process message"
                );

                await bridge.reply(chatId, providerReply ?? GENERATION_ERROR_REPLY);
            }
        }
    } catch (err) {
        log.error(
            { err: err instanceof Error ? err.message : String(err) },
            "listener error"
        );
        throw err;
    } finally {
        await bridge.disconnect();
    }
}

/**
 * Process a user message through the agent and return a fallback assistant response when
 * no tool already produced one or more user-visible replies for this turn.
 */
async function processMessage(chatSession: ChatSessionState, userMessage: string): Promise<string | null> {
    const preview = userMessage.slice(0, 80);
    log.info({ message: preview }, "sending user message to agent");

    chatSession.sentMessages.length = 0;
    await chatSession.session.prompt(userMessage);
    await chatSession.getPendingReplies();

    if (chatSession.sentMessages.length > 0) {
        log.info({ sentCount: chatSession.sentMessages.length }, "reply already sent via tool");
        return null;
    }

    const reply = chatSession.session.getLastAssistantText()?.trim();
    if (!reply) {
        log.warn("no assistant text found in last response");
        return EMPTY_RESPONSE_REPLY;
    }

    log.info({ chars: reply.length }, "reply ready");
    return reply;
}