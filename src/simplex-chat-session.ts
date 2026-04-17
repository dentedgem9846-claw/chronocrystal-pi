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

const MAX_SIMPLEX_MESSAGES_PER_TURN = 8;
const MAX_SIMPLEX_MESSAGE_CHARS = 240;
const FULLER_SIMPLEX_MESSAGE_CHARS = 60;
const SHORT_FOLLOW_UP_MAX_CHARS = 60;
const SIMPLEX_MESSAGE_DELAY_MS = 900;
const MAX_WIKI_LIST_RESULTS = 25;

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
					description: `Maximum number of results to return. Defaults to 20, max ${MAX_WIKI_LIST_RESULTS}.`,
					minimum: 1,
					maximum: MAX_WIKI_LIST_RESULTS,
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
					details: { found: false, title: "" }
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
			"Prefer updating an existing tiddler unless the user clearly wants a new page.",
			"Keep tags stable unless the user asked to change categorization.",
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

	return Math.min(Math.max(Math.trunc(value), 1), MAX_WIKI_LIST_RESULTS);
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
