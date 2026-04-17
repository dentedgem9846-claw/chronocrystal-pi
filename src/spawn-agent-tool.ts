import { Type } from "@mariozechner/pi-ai";
import { defineTool } from "@mariozechner/pi-coding-agent";
import pino from "pino";

import { PiWorker, type PiWorkerEvent } from "./pi-worker.js";
import { resolveWorkspaceDir } from "./wiki.js";

const log = pino({ name: "spawn-agent-tool" });

export interface CreatePiAgentToolsOptions {
	chatId: number;
	logReply(text: string): void;
}

type PiTaskStatus = "running" | "completed" | "failed";

interface PiTaskRecord {
	id: string;
	task: string;
	status: PiTaskStatus;
	startedAt: string;
	updatedAt: string;
	events: PiWorkerEvent[];
	currentTool?: string;
	finalResult?: string;
	error?: string;
}

function formatToolCall(toolName: string, args: Record<string, unknown>): string {
	switch (toolName) {
		case "bash": {
			const command = typeof args.command === "string" ? args.command : "...";
			return `$ ${command.length > 120 ? `${command.slice(0, 120)}...` : command}`;
		}
		case "read": {
			const path = typeof args.path === "string" ? args.path : typeof args.file_path === "string" ? args.file_path : "...";
			return `read ${path}`;
		}
		case "write": {
			const path = typeof args.path === "string" ? args.path : typeof args.file_path === "string" ? args.file_path : "...";
			return `write ${path}`;
		}
		case "edit": {
			const path = typeof args.path === "string" ? args.path : typeof args.file_path === "string" ? args.file_path : "...";
			return `edit ${path}`;
		}
		case "grep": {
			const pattern = typeof args.pattern === "string" ? args.pattern : "";
			const path = typeof args.path === "string" ? args.path : ".";
			return `grep /${pattern}/ in ${path}`;
		}
		case "find": {
			const pattern = typeof args.pattern === "string" ? args.pattern : "*";
			const path = typeof args.path === "string" ? args.path : ".";
			return `find ${pattern} in ${path}`;
		}
		default:
			return `${toolName} ${JSON.stringify(args)}`;
	}
}

function extractAssistantText(event: Record<string, unknown>): string[] {
	const message = event.message;
	if (!message || typeof message !== "object") {
		return [];
	}
	const content = (message as { content?: unknown }).content;
	if (!Array.isArray(content)) {
		return [];
	}
	return content
		.filter((part): part is { type: string; text?: string } => Boolean(part && typeof part === "object" && "type" in part))
		.filter((part) => part.type === "text" && typeof part.text === "string" && part.text.trim().length > 0)
		.map((part) => part.text!.trim());
}

function toolResultPreview(event: Record<string, unknown>): string | undefined {
	const result = event.result;
	if (!result || typeof result !== "object") {
		return undefined;
	}
	const content = (result as { content?: unknown }).content;
	if (!Array.isArray(content)) {
		return undefined;
	}
	const textParts = content
		.filter((part): part is { type: string; text?: string } => Boolean(part && typeof part === "object" && "type" in part))
		.filter((part) => part.type === "text" && typeof part.text === "string" && part.text.trim().length > 0)
		.map((part) => part.text!.trim());
	if (textParts.length === 0) {
		return undefined;
	}
	const joined = textParts.join("\n");
	return joined.length > 240 ? `${joined.slice(0, 240)}...` : joined;
}

function summarizeTask(task: PiTaskRecord | null) {
	if (!task) {
		return null;
	}
	return {
		id: task.id,
		task: task.task,
		status: task.status,
		startedAt: task.startedAt,
		updatedAt: task.updatedAt,
		currentTool: task.currentTool ?? null,
		latestActivity: latestActivity(task),
		finalResult: task.finalResult ?? null,
		error: task.error ?? null,
		eventCount: task.events.length,
	};
}

function trimPreview(text: string, maxChars = 220): string {
	return text.length > maxChars ? `${text.slice(0, maxChars)}...` : text;
}

function summarizeEvent(event: PiWorkerEvent): string | null {
	switch (event.type) {
		case "outbound_message":
			return `[message] ${trimPreview(event.text)}`;
		case "done":
			return `[done] ${trimPreview(event.result)}`;
		case "error":
			return `[error] ${trimPreview(event.message)}`;
		case "session_event": {
			const sessionEvent = event.event;
			const eventType = typeof sessionEvent.type === "string" ? sessionEvent.type : "unknown";
			if (eventType === "tool_execution_start") {
				const toolName = typeof sessionEvent.toolName === "string" ? sessionEvent.toolName : "unknown";
				const args = sessionEvent.args && typeof sessionEvent.args === "object" ? (sessionEvent.args as Record<string, unknown>) : {};
				return `[tool:start] ${formatToolCall(toolName, args)}`;
			}
			if (eventType === "tool_execution_update") {
				const toolName = typeof sessionEvent.toolName === "string" ? sessionEvent.toolName : "unknown";
				const preview = toolResultPreview(sessionEvent);
				return preview ? `[tool:update] ${toolName}: ${trimPreview(preview)}` : null;
			}
			if (eventType === "tool_execution_end") {
				const toolName = typeof sessionEvent.toolName === "string" ? sessionEvent.toolName : "unknown";
				const preview = toolResultPreview(sessionEvent);
				const prefix = sessionEvent.isError === true ? "[tool:error]" : "[tool:done]";
				return preview ? `${prefix} ${toolName}: ${trimPreview(preview)}` : `${prefix} ${toolName}`;
			}
			if (eventType === "message_end") {
				const texts = extractAssistantText(sessionEvent).filter((text) => text.trim().length > 0);
				if (texts.length === 0) {
					return null;
				}
				return `[assistant] ${trimPreview(texts.join(" | "))}`;
			}
			return null;
		}
	}
}

function summarizeRecentEvents(task: PiTaskRecord | null, limit = 10): string[] {
	if (!task) {
		return [];
	}
	return task.events.map(summarizeEvent).filter((value): value is string => value !== null).slice(-limit);
}

function latestActivity(task: PiTaskRecord | null): string | null {
	const recent = summarizeRecentEvents(task, 1);
	return recent[0] ?? null;
}

	export function createPiAgentTools({ chatId, logReply }: CreatePiAgentToolsOptions) {
	let latestTask: PiTaskRecord | null = null;
	const taskHistory: PiTaskRecord[] = [];

	const logAnnouncement = (text: string) => {
		logReply(text);
	};

	const recordEvent = (task: PiTaskRecord, event: PiWorkerEvent) => {
		task.updatedAt = new Date().toISOString();
		task.events.push(event);

		switch (event.type) {
			case "outbound_message":
				logAnnouncement(`[Pi] ${event.text}`);
				return;
			case "done":
				task.status = "completed";
				task.finalResult = event.result;
				task.currentTool = undefined;
				logAnnouncement(`[Pi] Finished: ${event.result}`);
				return;
			case "error":
				task.status = "failed";
				task.error = event.message;
				task.currentTool = undefined;
				logAnnouncement(`[Pi/error] ${event.message}`);
				return;
			case "session_event": {
				const sessionEvent = event.event;
				const eventType = typeof sessionEvent.type === "string" ? sessionEvent.type : "unknown";
				if (eventType === "tool_execution_start") {
					const toolName = typeof sessionEvent.toolName === "string" ? sessionEvent.toolName : "unknown";
					const args = sessionEvent.args && typeof sessionEvent.args === "object" ? (sessionEvent.args as Record<string, unknown>) : {};
					task.currentTool = toolName;
					logAnnouncement(`[Pi/tool:start] ${formatToolCall(toolName, args)}`);
					return;
				}
				if (eventType === "tool_execution_update") {
					const toolName = typeof sessionEvent.toolName === "string" ? sessionEvent.toolName : task.currentTool ?? "unknown";
					const preview = toolResultPreview(sessionEvent);
					if (preview) {
						logAnnouncement(`[Pi/tool:update] ${toolName}: ${preview}`);
					}
					return;
				}
				if (eventType === "tool_execution_end") {
					const toolName = typeof sessionEvent.toolName === "string" ? sessionEvent.toolName : task.currentTool ?? "unknown";
					const isError = sessionEvent.isError === true;
					const preview = toolResultPreview(sessionEvent);
					task.currentTool = undefined;
					logAnnouncement(
						isError
							? `[Pi/tool:error] ${toolName}${preview ? `: ${preview}` : ""}`
							: `[Pi/tool:done] ${toolName}${preview ? `: ${preview}` : ""}`
					);
					return;
				}
				if (eventType === "message_end") {
					for (const text of extractAssistantText(sessionEvent)) {
						logAnnouncement(`[Pi/assistant] ${text}`);
					}
				}
			}
		}
	};

	const spawnAgentTool = defineTool({
		name: "spawn_agent",
		label: "Spawn Expert Agent",
		description:
			"Start Pi in the background for complex coding, wiki, or research work. Pi will stream tool-level progress directly into chat.",
		promptSnippet: "Delegate complex work to Pi in the background",
		promptGuidelines: [
			"Use this for multi-step coding or wiki work that would distract from the main conversation.",
			"Do not call this again while Pi is already running unless the user explicitly wants to replace the current task.",
			"Pi already announces task start in chat. After calling this, do not send a separate acknowledgement unless the user explicitly asked for commentary.",
		],
		parameters: Type.Object({
			task: Type.String({ description: "Precise delegated task for Pi." }),
		}),
		async execute(_toolCallId, params) {
			if (latestTask?.status === "running") {
				return {
					content: [
						{
							type: "text" as const,
							text: `Pi is already working on task ${latestTask.id}. Use inspect_agent to read its live transcript before starting something else.`,
						},
					],
					details: { started: false, taskId: latestTask.id, status: latestTask.status },
				};
			}

			const workspaceDir = await resolveWorkspaceDir();
			const task: PiTaskRecord = {
				id: `pi-${taskHistory.length + 1}`,
				task: params.task,
				status: "running",
				startedAt: new Date().toISOString(),
				updatedAt: new Date().toISOString(),
				events: [],
			};
			latestTask = task;
			taskHistory.unshift(task);
			if (taskHistory.length > 5) {
				taskHistory.length = 5;
			}

			logAnnouncement(`[Pi] Started task ${task.id}. I’ll stream every tool call and error here.`);

			const worker = new PiWorker({
				cwd: workspaceDir,
				onEvent: (event) => recordEvent(task, event),
			});

			void worker.run(params.task).catch((error) => {
				const message = error instanceof Error ? error.message : String(error);
				if (task.status === "running") {
					recordEvent(task, { type: "error", message });
				}
				log.error({ chatId, taskId: task.id, err: message }, "Pi worker failed");
			});

			return {
				content: [
					{
						type: "text" as const,
						text: `Started Pi task ${task.id} in the background. Use inspect_agent whenever you need the full transcript or current tool state.`,
					},
				],
				details: { started: true, taskId: task.id, status: task.status },
			};
		},
	});

	const inspectAgentTool = defineTool({
		name: "inspect_agent",
		label: "Inspect Agent",
		description:
			"Inspect Pi’s latest task, including live status, tool calls, tool results, assistant messages, and errors.",
		promptSnippet: "Inspect Pi task status and transcript",
		promptGuidelines: [
			"Use this whenever the user asks what Pi is doing or whether it is stuck.",
			"Read the full event log before summarizing; do not guess.",
			"Answer from the current tool or most recent event in the inspection payload, and keep the status update concise.",
		],
		parameters: Type.Object({}),
		async execute() {
			const payload = {
				activeTask: latestTask ? {
					...summarizeTask(latestTask),
					recentEvents: summarizeRecentEvents(latestTask),
				} : null,
				recentTasks: taskHistory.map(summarizeTask),
			};

			return {
				content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
				details: {
					hasActiveTask: latestTask !== null,
					activeStatus: latestTask?.status ?? null,
					recentCount: taskHistory.length,
				},
			};
		},
	});

	return { spawnAgentTool, inspectAgentTool };
}
