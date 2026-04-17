import {
	createAgentSession,
	createCodingTools,
	defineTool,
	type AgentSession,
	SessionManager,
} from "@mariozechner/pi-coding-agent";
import { getModel, Type } from "@mariozechner/pi-ai";
import pino from "pino";

import { SimplexBridge } from "./simplex-bridge.js";
import {
	getWikiTiddler,
	listWikiTiddlers,
	resolveWorkspaceDir,
	setWikiTiddler,
	WIKI_ROUTE_PREFIX,
} from "./wiki.js";

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
		cwd: workspaceDir,
		tools: createCodingTools(workspaceDir),
		model,
		thinkingLevel: "off",
		sessionManager: SessionManager.inMemory(),
		customTools: [sendMessageTool, createListWikiTiddlersTool(), createGetWikiTiddlerTool(), createSetWikiTiddlerTool()],
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

function createListWikiTiddlersTool() {
	return defineTool({
		name: "list_wiki_tiddlers",
		label: "List Wiki Tiddlers",
		description: "List non-system KawaWiki tiddlers so you can find the right page before reading or editing it.",
		promptSnippet: "List the live KawaWiki tiddlers before editing when you need titles or want to confirm what already exists.",
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
		promptSnippet: "Read the existing KawaWiki tiddler before updating it so you preserve intent and structure.",
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
					description: "Optional MIME/content type. Omit to preserve the current type or default to text/vnd.tiddlywiki.",
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
