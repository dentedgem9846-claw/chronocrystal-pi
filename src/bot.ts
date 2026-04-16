/**
 * ChronoCrystal Bot - SimpleX bridge with Pi coding agent.
 *
 * Connects to SimpleX chat network, receives messages, processes them
 * with the Pi coding agent, and replies back.
 */
import { getModel } from "@mariozechner/pi-ai";
import pino from "pino";

import { createChatSession, type ChatSessionState } from "./simplex-chat-session.js";
import { SimplexBridge, type BotConfig } from "./simplex-bridge.js";
import {
    EMPTY_RESPONSE_REPLY,
    GENERATION_ERROR_REPLY,
    parseBotModel,
} from "./config.js";
import { startServer } from "./server.js";

const log = pino({ name: "bot" });


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

    log.info(
        { displayName, modelSpec, simplexHost, simplexPort },
        "starting bot"
    );

    const { provider, modelId } = parseBotModel(modelSpec);
    // @ts-expect-error - dynamic model IDs from providers like openrouter aren't in static types
    const model = getModel(provider, modelId);

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
                log.error(
                    { chatId, err: err instanceof Error ? err.message : String(err) },
                    "failed to process message"
                );

                await bridge.reply(chatId, GENERATION_ERROR_REPLY);
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
 * the model did not already send one or more messages through the send_message tool.
 */
async function processMessage(chatSession: ChatSessionState, userMessage: string): Promise<string | null> {
    const preview = userMessage.slice(0, 80);
    log.info({ message: preview }, "sending user message to agent");

    chatSession.sentMessages.length = 0;
    await chatSession.session.prompt(userMessage);

    if (chatSession.sentMessages.length > 0) {
        log.info({ sentCount: chatSession.sentMessages.length }, "reply already sent via send_message tool");
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