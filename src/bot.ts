/**
 * ChronoCrystal Bot - SimpleX bridge with Pi coding agent.
 *
 * Connects to SimpleX chat network, receives messages, processes them
 * with the Pi coding agent, and replies back.
 */
import { createAgentSession, type AgentSession, SessionManager } from "@mariozechner/pi-coding-agent";
import { getModel, type KnownProvider } from "@mariozechner/pi-ai";
import pino from "pino";

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

    // Parse model spec (e.g., "openrouter/minimax/minimax-m2.5:free")
    // The pi-ai types don't include all dynamic models from openrouter, so we need to cast
    const { provider, modelId } = parseBotModel(modelSpec);
    // @ts-expect-error - dynamic model IDs from providers like openrouter aren't in static types
    const model = getModel(provider, modelId);

    log.info({ provider, modelId }, "model resolved");

    // Create agent session
    log.info("creating agent session");
    const { session: agentSession, extensionsResult } = await createAgentSession({
        model,
        thinkingLevel: "off",
        sessionManager: SessionManager.inMemory(),
        // No session persistence for bot mode - each conversation is fresh
    });
    log.info(
        {
            extensionsLoaded: extensionsResult.extensions.length,
            extensionsFailed: extensionsResult.errors.length,
        },
        "agent session ready"
    );

    // Connect to SimpleX
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

    log.info({ address }, "bot ready - waiting for messages");

	await startServer(address);

    // Process incoming messages
    try {
        for await (const { chatId, message } of bridge.listen()) {
            log.info({ chatId, message: message.slice(0, 100) }, "processing message");

            try {
                const reply = await processMessage(agentSession, message);
                await bridge.reply(chatId, reply);
            } catch (err) {
                log.error(
                    { chatId, err: err instanceof Error ? err.message: String(err) },
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
 * Process a user message through the agent and return the assistant response.
 */
async function processMessage(session: AgentSession, userMessage: string): Promise<string> {
    const preview = userMessage.slice(0, 80);
    log.info({ message: preview }, "sending user message to agent");

    await session.prompt(userMessage);

    const reply = session.getLastAssistantText()?.trim();
    if (!reply) {
        log.warn("no assistant text found in last response");
        return EMPTY_RESPONSE_REPLY;
    }

    log.info({ chars: reply.length }, "reply ready");
    return reply;
}