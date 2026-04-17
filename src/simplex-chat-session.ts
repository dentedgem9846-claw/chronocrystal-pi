import {
	createAgentSession,
	defineTool,
	type AgentSession,
	type AgentToolResult,
	SessionManager,
} from "@mariozechner/pi-coding-agent";
import { getModel, Type } from "@mariozechner/pi-ai";
import pino from "pino";

import { resolveWorkspaceDir } from "./wiki.js";

const log = pino({ name: "simplex-chat-session" });

interface SendMessageToolDetails {
	sent: boolean;
	chars?: number;
	reason?: "empty";
}

export interface ChatSessionState {
	session: AgentSession;
}

interface CreateChatSessionOptions {
	chatId: number;
	model: ReturnType<typeof getModel>;
}

export async function createChatSession({
	chatId,
	model,
}: CreateChatSessionOptions): Promise<ChatSessionState> {
	const workspaceDir = await resolveWorkspaceDir();
	const logReply = (text: string) => {
		log.info({ chatId, chars: text.length }, "agent message logged (not sent to user)");
	};

	const sendMessageTool = createSendMessageTool({
		logReply,
	});

	const { createPiAgentTools } = await import("./spawn-agent-tool.js");
	const { spawnAgentTool, inspectAgentTool } = createPiAgentTools({
		chatId,
		logReply,
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

	return { session };
}

interface CreateSendMessageToolOptions {
	logReply(text: string): void;
}

function createSendMessageTool({ logReply }: CreateSendMessageToolOptions) {
	return defineTool({
		name: "send_message",
		label: "Send Message",
		description: "Log a message for debugging. The user will not see this.",
		promptSnippet: "Log a message for debugging",
		promptGuidelines: [
			"Use this to log progress or context for backend debugging.",
			"The user will NOT see these messages — only the final agent response is shown.",
		],
		parameters: Type.Object({
			text: Type.String({
				description: "The message to log.",
			}),
		}),
		async execute(
			_toolCallId: string,
			params: { text: string }
		): Promise<AgentToolResult<SendMessageToolDetails>> {
			const text = params.text.trim();

			if (!text) {
				const result: AgentToolResult<SendMessageToolDetails> = {
					content: [{ type: "text", text: "No message logged because text was empty." }],
					details: { sent: false, reason: "empty" },
				};
				return result;
			}

			logReply(text);

			const result: AgentToolResult<SendMessageToolDetails> = {
				content: [{ type: "text", text: `Logged message (${text.length} chars).` }],
				details: { sent: true, chars: text.length },
			};
			return result;
		},
	});
}
