/**
 * ChronoCrystal Bot - SimpleX bridge with Pi coding agent.
 *
 * Connects to SimpleX chat network, receives messages, processes them
 * with the Pi coding agent, and replies back.
 */
import { createAgentSession, defineTool, type AgentSession, SessionManager } from "@mariozechner/pi-coding-agent";
import { getModel, Type } from "@mariozechner/pi-ai";
import pino from "pino";

import { SimplexBridge, type BotConfig } from "./simplex-bridge.js";
import {
    EMPTY_RESPONSE_REPLY,
    GENERATION_ERROR_REPLY,
    parseBotModel,
} from "./config.js";
import { startServer } from "./server.js";

const log = pino({ name: "bot" });

const MAX_SIMPLEX_MESSAGES_PER_TURN = 8;
const MAX_SIMPLEX_MESSAGE_CHARS = 240;
const FULLER_SIMPLEX_MESSAGE_CHARS = 60;
const SHORT_FOLLOW_UP_MAX_CHARS = 60;
const SIMPLEX_MESSAGE_DELAY_MS = 900;

interface ChatSessionState {
    session: AgentSession;
    sentMessages: string[];
}

interface SendMessageToolDetails {
    sent: boolean;
    reason?: "empty" | "too_many_messages" | "too_long" | "follow_up_too_long";
    chars?: number;
    sentCount?: number;
}

export interface BotOptions {
    displayName: string;
    model: string;
    simplexHost: string;
    simplexPort: number;
}

async function createChatSession(
    chatId: number,
    model: ReturnType<typeof getModel>,
    bridge: SimplexBridge,
): Promise<ChatSessionState> {
    const sentMessages: string[] = [];
    let sendQueue = Promise.resolve<void>(undefined);

    const buildSendMessageResult = (text: string, details: SendMessageToolDetails) => ({
        content: [{ type: "text" as const, text }],
        details,
    });

    const sendMessageTool = defineTool({
        name: "send_message",
        label: "Send Message",
        description: "Send the next user-visible SimpleX chat message immediately.",
        promptSnippet: "Send the next user-visible SimpleX message bubble immediately",
        promptGuidelines: [
            "Use send_message for user-visible SimpleX replies.",
            "Choose natural grouping: some replies should be one fuller bubble, others can be several shorter follow-ups.",
            "Do not mechanically split every sentence into its own message.",
            "When the first bubble is already fuller, make the next follow-up noticeably shorter.",
            "Keep each bubble focused on one main idea.",
        ],
        parameters: Type.Object({
            text: Type.String({
                description: "The exact SimpleX message bubble to send. Keep it short and limited to one idea.",
            }),
        }),
        async execute(_toolCallId, params) {
            const runSend = async () => {
                const text = params.text.trim();
                const firstMessageWasFuller = sentMessages[0] !== undefined && sentMessages[0].length >= FULLER_SIMPLEX_MESSAGE_CHARS;
                const alreadySentShortFollowUp = sentMessages.slice(1).some((message) => message.length <= SHORT_FOLLOW_UP_MAX_CHARS);

                if (!text) {
                    return buildSendMessageResult(
                        "No message sent because text was empty.",
                        { sent: false, reason: "empty" }
                    );
                }

                if (sentMessages.length >= MAX_SIMPLEX_MESSAGES_PER_TURN) {
                    return buildSendMessageResult(
                        `No message sent. You already sent ${MAX_SIMPLEX_MESSAGES_PER_TURN} messages this turn; stop sending more.`,
                        { sent: false, reason: "too_many_messages" }
                    );
                }

                if (text.length > MAX_SIMPLEX_MESSAGE_CHARS) {
                    return buildSendMessageResult(
                        `No message sent. Split this into shorter messages under ${MAX_SIMPLEX_MESSAGE_CHARS} characters.`,
                        { sent: false, reason: "too_long", chars: text.length }
                    );
                }

                if (firstMessageWasFuller && sentMessages.length > 0 && !alreadySentShortFollowUp && text.length > SHORT_FOLLOW_UP_MAX_CHARS) {
                    return buildSendMessageResult(
                        `No message sent. After a fuller first bubble, make the next follow-up ${SHORT_FOLLOW_UP_MAX_CHARS} characters or less.`,
                        { sent: false, reason: "follow_up_too_long", chars: text.length }
                    );
                }

                if (sentMessages.length > 0) {
                    await Bun.sleep(SIMPLEX_MESSAGE_DELAY_MS);
                }

                await bridge.reply(chatId, text);
                sentMessages.push(text);

                log.info(
                    { chatId, chars: text.length, sentCount: sentMessages.length, delayMs: sentMessages.length > 1 ? SIMPLEX_MESSAGE_DELAY_MS : 0 },
                    "send_message tool sent reply"
                );

                return buildSendMessageResult(
                    `Sent message ${sentMessages.length}.`,
                    { sent: true, chars: text.length, sentCount: sentMessages.length }
                );
            };

            const resultPromise = sendQueue.then(runSend);
            sendQueue = resultPromise.then(() => undefined, () => undefined);
            return await resultPromise;
        },
    });

    const { session, extensionsResult } = await createAgentSession({
        model,
        thinkingLevel: "off",
        sessionManager: SessionManager.inMemory(),
        customTools: [sendMessageTool],
    });

    log.info(
        {
            chatId,
            extensionsLoaded: extensionsResult.extensions.length,
            extensionsFailed: extensionsResult.errors.length,
            systemPromptPreview: session.agent.state.systemPrompt?.slice(0, 200),
        },
        "chat session ready"
    );

    return { session, sentMessages };
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
                chatSession = await createChatSession(chatId, model, bridge);
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

                if (chatSession.sentMessages.length === 0) {
                    await bridge.reply(chatId, GENERATION_ERROR_REPLY);
                }
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