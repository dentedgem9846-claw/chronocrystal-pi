import {
	createAgentSession,
	defineTool,
	type AgentSession,
	SessionManager,
} from "@mariozechner/pi-coding-agent";
import { getModel, Type } from "@mariozechner/pi-ai";
import pino from "pino";

import { SimplexBridge } from "./simplex-bridge.js";
import { resolveWorkspaceDir } from "./wiki.js";

const log = pino({ name: "simplex-chat-session" });

const SIMPLEX_MESSAGE_DELAY_MS = 900;

interface SendMessageToolDetails {
	sent: boolean;
	reason?: "empty";
	chars?: number;
	sentCount?: number;
}

export interface ChatSessionState {
	session: AgentSession;
	sentMessages: string[];
	getPendingReplies(): Promise<void>;
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
	const workspaceDir = await resolveWorkspaceDir();

	const enqueueReply = (text: string) => {
		const resultPromise = sendQueue.then(async () => {
			if (sentMessages.length > 0) {
				await Bun.sleep(SIMPLEX_MESSAGE_DELAY_MS);
			}

			await bridge.reply(chatId, text);
			sentMessages.push(text);
		});
		sendQueue = resultPromise.then(() => undefined, () => undefined);
		return resultPromise;
	};

	const sendMessageTool = createSendMessageTool({
		chatId,
		sentMessages,
		enqueueReply,
	});

	const { createPiAgentTools } = await import("./spawn-agent-tool.js");
	const { spawnAgentTool, inspectAgentTool } = createPiAgentTools({
		chatId,
		enqueueReply,
	});

	// Kawa stays limited to messaging, delegation, and Pi task inspection.
	const { session, extensionsResult } = await createAgentSession({
		cwd: workspaceDir,
		tools: [],
		model,
		thinkingLevel: "off",
		sessionManager: SessionManager.inMemory(),
		customTools: [sendMessageTool, spawnAgentTool, inspectAgentTool],
	});

	log.info(
		{
			chatId,
			workspaceDir,
			extensionsLoaded: extensionsResult.extensions.length,
			extensionsFailed: extensionsResult.errors.length,
		},
		"chat session ready"
	);

	return { session, sentMessages, getPendingReplies: () => sendQueue };
}

interface CreateSendMessageToolOptions {
	chatId: number;
	sentMessages: string[];
	enqueueReply(text: string): Promise<void>;
}

function createSendMessageTool({
	chatId,
	sentMessages,
	enqueueReply,
}: CreateSendMessageToolOptions) {
	const buildSendMessageResult = (text: string, details: SendMessageToolDetails) => ({
		content: [{ type: "text" as const, text }],
		details,
	});

	return defineTool({
		name: "send_message",
		label: "Send Message",
		description: "Send a SimpleX chat message.",
		promptSnippet: "Send a SimpleX message",
		promptGuidelines: [
			"Send whatever message best fits the moment — long or short.",
			"Send multiple messages when you want to.",
			"Trust your instincts about what feels right.",
		],
		parameters: Type.Object({
			text: Type.String({
				description: "The message to send.",
			}),
		}),
		async execute(_toolCallId, params) {
			const runSend = async () => {
				const text = params.text.trim();

				if (!text) {
					return buildSendMessageResult("No message sent because text was empty.", {
						sent: false,
						reason: "empty",
					});
				}

				await enqueueReply(text);

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

			return await runSend();
		},
	});
}
