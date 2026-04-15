/**
 * ChronoCrystal Bot - SimpleX bridge with Pi coding agent.
 *
 * Connects to SimpleX chat network, receives messages, processes them
 * with the Pi coding agent, and replies back.
 */
import { createAgentSession, type AgentSession } from "@mariozechner/pi-coding-agent";
import { getModel, type KnownProvider } from "@mariozechner/pi-ai";
import pino from "pino";

import { SimplexBridge, type BotConfig } from "./simplex-bridge.js";
import {
    EMPTY_RESPONSE_REPLY,
    GENERATION_ERROR_REPLY,
    parseBotModel,
} from "./config.js";

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
 * Extract text content from any AgentMessage type.
 */
function extractTextFromMessage(msg: unknown): string {
    const m = msg as Record<string, unknown>;
    const role = m.role as string;
    const content = m.content;

    // Standard messages with content array
    if (Array.isArray(content)) {
        const texts: string[] = [];
        for (const c of content) {
            if (c && typeof c === "object" && (c as Record<string, unknown>).type === "text") {
                const text = (c as Record<string, unknown>).text;
                if (typeof text === "string") {
                    texts.push(text);
                }
            }
        }
        return texts.join("\n");
    }

    // User message with string content
    if (role === "user" && typeof content === "string") {
        return content;
    }

    // Bash execution message
    if (role === "bashExecution") {
        const command = m.command as string ?? "";
        const output = m.output as string ?? "";
        const exitCode = m.exitCode;
        return `\n$ ${command}\n${output}\nexit: ${exitCode}`;
    }

    // Branch/compaction summary
    if (role === "branchSummary" || role === "compactionSummary") {
        return (m.summary as string) ?? "";
    }

    // Custom message with string content
    if (role === "custom" && typeof content === "string") {
        return content;
    }

    return "";
}

/**
 * Process a user message through the agent and return the response.
 */
async function processMessage(session: AgentSession, userMessage: string): Promise<string> {
    const preview = userMessage.slice(0, 80);
    log.info({ message: preview }, "sending user message to agent");

    // Send the user message to the agent
    await session.sendUserMessage(userMessage);

    // Wait for the agent to finish processing
    log.debug("waiting for agent to respond");
    while (session.isStreaming) {
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
    log.debug({ totalMessages: session.messages.length }, "agent finished");

    // Collect ALL text from all messages (assistant, tool results, bash executions, summaries)
    const allTexts: string[] = [];

    for (const msg of session.messages) {
        const text = extractTextFromMessage(msg);
        if (text.trim()) {
            allTexts.push(text);
        }
    }

    log.info({ textCount: allTexts.length }, "collected all message texts");

    if (allTexts.length === 0) {
        log.warn("no text found in messages");
        return EMPTY_RESPONSE_REPLY;
    }

    const fullReply = allTexts.join("\n\n");
    log.info({ chars: fullReply.length }, "reply ready");
    return fullReply;
}