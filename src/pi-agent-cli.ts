import {
	createAgentSession,
	createCodingTools,
	DefaultResourceLoader,
	defineTool,
	type AgentSessionEvent,
	SessionManager,
} from "@mariozechner/pi-coding-agent";
import { getModel, Type } from "@mariozechner/pi-ai";
import { resolve } from "node:path";
import pino from "pino";

import {
	getWikiTiddler,
	listWikiTiddlers,
	resolveWorkspaceDir,
	setWikiTiddler,
	WIKI_ROUTE_PREFIX,
} from "./wiki.js";
import { getPiProvider, getPiModelId } from "./config.js";

const log = pino({ name: "pi-agent-cli" });

const PI_CONTEXT_DIR_NAME = "pi-agent";

const FORWARDED_EVENT_TYPES = new Set<AgentSessionEvent["type"]>([
	"agent_start",
	"agent_end",
	"turn_start",
	"turn_end",
	"message_end",
	"tool_execution_start",
	"tool_execution_update",
	"tool_execution_end",
]);

interface SendMessageToolDetails {
	sent: boolean;
	reason?: "empty";
	chars?: number;
	sentCount?: number;
}

interface CliOptions {
	task: string;
}

type PiCliEvent =
	| { type: "session_event"; event: unknown }
	| { type: "outbound_message"; text: string }
	| { type: "done"; result: string }
	| { type: "error"; message: string };

function parseArgs(): CliOptions {
	const args = process.argv.slice(2);
	const options: CliOptions = {
		task: "",
	};

	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--task" && i + 1 < args.length) {
			options.task = args[i + 1]!;
			i++;
		}
	}

	if (!options.task.trim()) {
		throw new Error("Missing required --task argument");
	}

	return options;
}

function emit(event: PiCliEvent): void {
	process.stdout.write(`${JSON.stringify(event)}\n`);
}

function safeSerialize(value: unknown): unknown {
	try {
		return JSON.parse(JSON.stringify(value));
	} catch (error) {
		return {
			serializationError: error instanceof Error ? error.message : String(error),
		};
	}
}

function extractAssistantText(sessionText: string | undefined): string {
	return sessionText?.trim() || "Task completed successfully.";
}

async function main() {
	const options = parseArgs();
	const workspaceDir = await resolveWorkspaceDir();
	const piContextDir = resolve(workspaceDir, PI_CONTEXT_DIR_NAME);
	const resourceLoader = new DefaultResourceLoader({ cwd: piContextDir });
	await resourceLoader.reload();
	const provider = getPiProvider();
	const modelId = getPiModelId();
	const model = getModel(provider as any, modelId as any);

	log.info({ cwd: workspaceDir, piContextDir, provider, modelId }, "starting Pi agent subprocess");

	let sentCount = 0;
	let finalText = "";

	const sendMessageTool = defineTool({
		name: "send_message",
		label: "Send Message",
		description: "Send a SimpleX chat message through the parent process.",
		promptSnippet: "Send a SimpleX message",
		promptGuidelines: [
			"Use this to report progress or ask the user for information.",
			"Prefer short concrete status updates over vague reassurances.",
		],
		parameters: Type.Object({
			text: Type.String({ description: "The message to send." }),
		}),
		async execute(_toolCallId, params): Promise<{
			content: Array<{ type: "text"; text: string }> ;
			details: SendMessageToolDetails;
		}> {
			const text = params.text.trim();
			if (!text) {
				return {
					content: [{ type: "text", text: "No message sent because text was empty." }],
					details: { sent: false, reason: "empty" },
				};
			}

			sentCount += 1;
			emit({ type: "outbound_message", text });

			return {
				content: [{ type: "text", text: `Sent message ${sentCount}.` }],
				details: { sent: true, chars: text.length, sentCount },
			};
		},
	});

	const wikiTools = [
		createListWikiTiddlersTool(),
		createGetWikiTiddlerTool(),
		createSetWikiTiddlerTool(),
	];

	const { session, extensionsResult } = await createAgentSession({
		cwd: workspaceDir,
		tools: createCodingTools(workspaceDir),
		model,
		thinkingLevel: "off",
		resourceLoader,
		sessionManager: SessionManager.inMemory(),
		customTools: [sendMessageTool, ...wikiTools],
	});

	session.subscribe((event) => {
		if (!FORWARDED_EVENT_TYPES.has(event.type)) {
			return;
		}

		if (event.type === "message_end") {
			const message = event.message;
			if (message.role === "assistant") {
				finalText = extractAssistantText(
					message.content
						.filter((part) => part.type === "text")
						.map((part) => (part.type === "text" ? part.text : ""))
						.join("\n")
				);
			}
		}

		emit({ type: "session_event", event: safeSerialize(event) });
	});

	log.info(
		{
			workspaceDir,
			piContextDir,
			extensionsLoaded: extensionsResult.extensions.length,
			extensionsFailed: extensionsResult.errors.length,
		},
		"Pi agent session ready"
	);

	const shutdown = () => {
		log.info("Pi agent shutting down");
		process.exit(1);
	};
	process.on("SIGTERM", shutdown);
	process.on("SIGINT", shutdown);

	try {
		await session.prompt(options.task);
		emit({ type: "done", result: extractAssistantText(finalText || session.getLastAssistantText()) });
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		log.error({ err: message }, "Pi agent failed");
		emit({ type: "error", message });
		process.exit(1);
	}
}

function createListWikiTiddlersTool() {
	return defineTool({
		name: "list_wiki_tiddlers",
		label: "List Wiki Tiddlers",
		description: "List non-system KawaWiki tiddlers so you can find the right page before reading or editing it.",
		promptSnippet:
			"List the live KawaWiki tiddlers before editing when you need titles or want to confirm what already exists.",
		promptGuidelines: [
			"Use this before creating a new tiddler when you are not sure whether a page already exists.",
			"Filter by a short search string when the user names a topic loosely.",
			"Prefer editing an existing relevant tiddler over creating near-duplicates.",
		],
		parameters: Type.Object({
			search: Type.Optional(
				Type.String({
					description: "Optional case-insensitive substring to match against tiddler titles and tags.",
				})
			),
			limit: Type.Optional(
				Type.Number({
					description: "Maximum number of results to return. Defaults to 20, max 25.",
					minimum: 1,
					maximum: 25,
				})
			),
		}),
		async execute(_toolCallId, params) {
			const search = params.search?.trim().toLocaleLowerCase();
			const limit = clampWikiResultLimit(params.limit);
			const tiddlers = await listWikiTiddlers();
			const matches = tiddlers.filter((tiddler) => matchesWikiSearch(tiddler, search));
			const results = matches.slice(0, limit).map((tiddler) => ({
				title: tiddler.title,
				tags: tiddler.tags ?? [],
				type: tiddler.type ?? "text/vnd.tiddlywiki",
				modified: tiddler.modified,
			}));

			return {
				content: [
					{
						type: "text" as const,
						text: JSON.stringify(
							{
								search: search ?? null,
								route: WIKI_ROUTE_PREFIX,
								totalMatches: matches.length,
								returned: results.length,
								tiddlers: results,
							},
							null,
							2
						),
					},
				],
				details: { totalMatches: matches.length, returned: results.length },
			};
		},
	});
}

function createGetWikiTiddlerTool() {
	return defineTool({
		name: "get_wiki_tiddler",
		label: "Get Wiki Tiddler",
		description: "Read one KawaWiki tiddler, including its full text, by exact title.",
		promptSnippet:
			"Read the existing KawaWiki tiddler before updating it so you preserve intent and structure.",
		promptGuidelines: [
			"Always read a tiddler before editing it unless you are intentionally creating a brand new title.",
			"Use the exact title returned by list_wiki_tiddlers.",
		],
		parameters: Type.Object({
			title: Type.String({ description: "Exact tiddler title to read." }),
		}),
		async execute(_toolCallId, params) {
			const title = params.title.trim();
			if (!title) {
				return {
					content: [{ type: "text" as const, text: "Tiddler title cannot be empty." }],
					details: { found: false, title: "" },
				};
			}

			const tiddler = await getWikiTiddler(title);
			if (!tiddler) {
				return {
					content: [{ type: "text" as const, text: `Tiddler not found: ${title}` }],
					details: { found: false, title },
				};
			}

			return {
				content: [{ type: "text" as const, text: JSON.stringify(tiddler, null, 2) }],
				details: { found: true, title },
			};
		},
	});
}

function createSetWikiTiddlerTool() {
	return defineTool({
		name: "set_wiki_tiddler",
		label: "Set Wiki Tiddler",
		description: "Create or update a KawaWiki tiddler in the live server-backed wiki.",
		promptSnippet: "Save a KawaWiki tiddler after you have confirmed the right title and content.",
		promptGuidelines: [
			"Prefer updating an existing relevant tiddler unless the user clearly wants a new page.",
			"Keep tags stable unless the user asked to recategorize the page.",
			"Do not save placeholder text. Write the full intended tiddler body.",
		],
		parameters: Type.Object({
			title: Type.String({ description: "Exact tiddler title to create or update." }),
			text: Type.String({ description: "Complete tiddler body text to save." }),
			tags: Type.Optional(
				Type.Array(Type.String({ description: "Tag name" }), {
					description: "Optional full tag list. Omit this to preserve existing tags on updates.",
				})
			),
			type: Type.Optional(
				Type.String({
					description:
						"Optional MIME/content type. Omit to preserve the current type or default to text/vnd.tiddlywiki.",
				})
			),
		}),
		async execute(_toolCallId, params) {
			const savedTiddler = await setWikiTiddler({
				title: params.title,
				text: params.text,
				tags: params.tags,
				type: params.type,
			});

			return {
				content: [
					{
						type: "text" as const,
						text: JSON.stringify(
							{
								route: WIKI_ROUTE_PREFIX,
								saved: true,
								tiddler: savedTiddler,
							},
							null,
							2
						),
					},
				],
				details: { saved: true, title: savedTiddler.title },
			};
		},
	});
}

function clampWikiResultLimit(value: number | undefined): number {
	if (value === undefined || Number.isNaN(value)) {
		return 20;
	}
	return Math.min(Math.max(Math.trunc(value), 1), 25);
}

function matchesWikiSearch(
	tiddler: { title: string; tags?: string[] },
	search: string | undefined
): boolean {
	if (!search) {
		return true;
	}
	if (tiddler.title.toLocaleLowerCase().includes(search)) {
		return true;
	}
	return (tiddler.tags ?? []).some((tag) => tag.toLocaleLowerCase().includes(search));
}

void main();
