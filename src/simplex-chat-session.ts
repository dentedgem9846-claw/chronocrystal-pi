import { createAgentSession, defineTool, type AgentSession, SessionManager } from "@mariozechner/pi-coding-agent";
import { getModel, Type } from "@mariozechner/pi-ai";
import pino from "pino";

import { SimplexBridge } from "./simplex-bridge.js";

const log = pino({ name: "simplex-chat-session" });

const MAX_SIMPLEX_MESSAGES_PER_TURN = 8;
const MAX_SIMPLEX_MESSAGE_CHARS = 240;
const FULLER_SIMPLEX_MESSAGE_CHARS = 60;
const SHORT_FOLLOW_UP_MAX_CHARS = 60;
const SIMPLEX_MESSAGE_DELAY_MS = 900;

interface SendMessageToolDetails {
    sent: boolean;
    reason?: "empty" | "too_many_messages" | "too_long" | "follow_up_too_long";
    chars?: number;
    sentCount?: number;
}

export interface ChatSessionState {
    session: AgentSession;
    sentMessages: string[];
}

interface CreateChatSessionOptions {
    chatId: number;
    model: ReturnType<typeof getModel>;
    bridge: SimplexBridge;
}

export async function createChatSession({
    chatId,
    model,
    bridge,
}: CreateChatSessionOptions): Promise<ChatSessionState> {
    const sentMessages: string[] = [];
    let sendQueue = Promise.resolve<void>(undefined);

    const sendMessageTool = createSendMessageTool({
        chatId,
        bridge,
        sentMessages,
        getSendQueue: () => sendQueue,
        setSendQueue: (nextQueue) => {
            sendQueue = nextQueue;
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
        },
        "chat session ready"
    );

    return { session, sentMessages };
}

interface CreateSendMessageToolOptions {
    chatId: number;
    bridge: SimplexBridge;
    sentMessages: string[];
    getSendQueue(): Promise<void>;
    setSendQueue(nextQueue: Promise<void>): void;
}

function createSendMessageTool({
    chatId,
    bridge,
    sentMessages,
    getSendQueue,
    setSendQueue,
}: CreateSendMessageToolOptions) {
    const buildSendMessageResult = (text: string, details: SendMessageToolDetails) => ({
        content: [{ type: "text" as const, text }],
        details,
    });

    return defineTool({
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
                const firstMessageWasFuller = sentMessages[0] !== undefined
                    && sentMessages[0].length >= FULLER_SIMPLEX_MESSAGE_CHARS;
                const alreadySentShortFollowUp = sentMessages
                    .slice(1)
                    .some((message) => message.length <= SHORT_FOLLOW_UP_MAX_CHARS);

                if (!text) {
                    return buildSendMessageResult("No message sent because text was empty.", {
                        sent: false,
                        reason: "empty",
                    });
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

                if (
                    firstMessageWasFuller
                    && sentMessages.length > 0
                    && !alreadySentShortFollowUp
                    && text.length > SHORT_FOLLOW_UP_MAX_CHARS
                ) {
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
                    {
                        chatId,
                        chars: text.length,
                        sentCount: sentMessages.length,
                        delayMs: sentMessages.length > 1 ? SIMPLEX_MESSAGE_DELAY_MS : 0,
                    },
                    "send_message tool sent reply"
                );

                return buildSendMessageResult(`Sent message ${sentMessages.length}.`, {
                    sent: true,
                    chars: text.length,
                    sentCount: sentMessages.length,
                });
            };

            const resultPromise = getSendQueue().then(runSend);
            setSendQueue(resultPromise.then(() => undefined, () => undefined));
            return await resultPromise;
        },
    });
}
