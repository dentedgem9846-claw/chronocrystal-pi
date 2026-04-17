import { T } from "@simplex-chat/types";
import { ChatClient } from "simplex-chat";
import pino from "pino";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	buildSmokeUserDisplayName,
	BufferedChatEvents,
	cleanupResources,
	collectDirectReplies,
	connectLocalClient,
	drainPreSendEvents,
	ensureActiveUser,
	fetchAutomationStatus,
	getFreePort,
	iterateChatEvents,
	launchSimplex,
	normalizeError,
	readSubprocessOutput,
	resolveSimplexBinary,
	verifyHealth,
	waitForContactReady,
} from "./simplex-harness.js";

const log = pino({ name: "smoke-pi-subagent" });

const DEFAULT_PRODUCTION_BASE_URL = "https://chronocrystal-pi-production-db31.up.railway.app";
const FIRST_PROMPT = [
	"Use spawn_agent now.",
	"Have Pi inspect the production smoke-test flow in the repo and identify the main files involved.",
	"Do not answer from memory.",
	"Start Pi in the background and let Pi stream progress.",
	"I will ask you for status while Pi is still running.",
].join(" ");
const STATUS_PROMPT = "What is Pi doing right now? Be specific about the current tool or the most recent tool event. Do not guess.";
const FIRST_BURST_TIMEOUT_MS = 45_000;
const SECOND_BURST_TIMEOUT_MS = 45_000;
const BURST_IDLE_TIMEOUT_MS = 4_000;

await main();

async function main(): Promise<void> {
	try {
		await runPiSubagentSmokeTest();
		log.info("pi subagent smoke test passed");
	} catch (error) {
		const failure = normalizeError(error);
		log.error({ err: failure.message }, "pi subagent smoke test failed");
		process.exit(1);
	}
}

async function runPiSubagentSmokeTest(): Promise<void> {
	const baseUrl = process.env.SMOKE_PROD_BASE_URL?.trim() || DEFAULT_PRODUCTION_BASE_URL;
	log.info({ baseUrl }, "starting pi subagent smoke test");

	await verifyHealth(baseUrl);
	const status = await fetchAutomationStatus(baseUrl);
	log.info({ status }, "fetched production automation status");

	const simplexBinary = await resolveSimplexBinary();
	const tempDir = await mkdtemp(join(tmpdir(), "chronocrystal-pi-subagent-"));
	const dataPrefix = join(tempDir, "simplex");
	const simplexPort = await getFreePort();

	let simplexProcess: Bun.PipedSubprocess | null = null;
	let chatClient: ChatClient | null = null;
	let contactId: number | null = null;
	let testFailed = false;

	try {
		const smokeDisplayName = buildSmokeUserDisplayName("ChronoCrystalPiSubagent");
		simplexProcess = launchSimplex(simplexBinary, dataPrefix, simplexPort, smokeDisplayName);
		chatClient = await connectLocalClient(simplexPort, simplexProcess);
		const events = new BufferedChatEvents(iterateChatEvents(chatClient.msgQ));

		const smokeUser = await ensureActiveUser(chatClient, smokeDisplayName);
		log.info({ userId: smokeUser.userId, simplexPort, displayName: smokeDisplayName }, "temporary SimpleX user ready");

		const connReqType = await chatClient.apiConnectActiveUser(status.simplexAddress);
		log.info({ connReqType, simplexAddress: status.simplexAddress }, "connected to production bot address");

		contactId = await waitForContactReady(events);
		await drainPreSendEvents(events);

		const firstSentAt = Date.now();
		await chatClient.apiSendTextMessage(T.ChatType.Direct, contactId, FIRST_PROMPT);
		log.info({ chatId: contactId, prompt: FIRST_PROMPT }, "sent delegation prompt");

		const firstBurst = await collectDirectReplies(events, contactId, firstSentAt, {
			overallTimeoutMs: FIRST_BURST_TIMEOUT_MS,
			idleTimeoutMs: BURST_IDLE_TIMEOUT_MS,
			breakOnMatch: (text) => text.includes("[Pi/tool:start]") || text.includes("[Pi/tool:update]") || text.includes("[Pi/tool:done]"),
		});
		log.info({ firstBurst }, "collected first burst");

		assertPiStarted(firstBurst);
		assertPiProgress(firstBurst);
		assertNoKawaDelegationReply(firstBurst);

		const secondSentAt = Date.now();
		await chatClient.apiSendTextMessage(T.ChatType.Direct, contactId, STATUS_PROMPT);
		log.info({ chatId: contactId, prompt: STATUS_PROMPT }, "sent status prompt");

		const secondBurst = await collectDirectReplies(events, contactId, secondSentAt, {
			overallTimeoutMs: SECOND_BURST_TIMEOUT_MS,
			idleTimeoutMs: BURST_IDLE_TIMEOUT_MS,
			breakOnMatch: (text) => !text.startsWith("[Pi"),
		});
		log.info({ secondBurst }, "collected second burst");

		const kawaStatusReply = secondBurst.find((text) => !text.startsWith("[Pi"));
		if (!kawaStatusReply) {
			throw new Error(`Did not receive a non-Pi status reply from Kawa. Replies: ${JSON.stringify(secondBurst)}`);
		}
		if (!/(tool|read|grep|find|write|edit|bash|latest|current|event|Pi is|Pi's)/i.test(kawaStatusReply)) {
			throw new Error(`Kawa replied without tool-level status: ${kawaStatusReply}`);
		}

		console.log("PI_SUBAGENT_SMOKE_RESULT");
		console.log(JSON.stringify({
			firstPrompt: FIRST_PROMPT,
			firstBurst,
			statusPrompt: STATUS_PROMPT,
			secondBurst,
			kawaStatusReply,
		}, null, 2));
	} catch (error) {
		testFailed = true;
		throw error;
	} finally {
		const cleanupErrors = await cleanupResources({
			chatClient,
			contactId,
			simplexProcess,
			tempDir,
		});
		if (cleanupErrors.length > 0) {
			log.warn({ cleanupErrors }, "cleanup reported errors");
		}
		if (testFailed && simplexProcess) {
			const output = await readSubprocessOutput(simplexProcess);
			if (output.stdout || output.stderr) {
				log.error({ simplexStdout: output.stdout, simplexStderr: output.stderr }, "local simplex-chat output");
			}
		}
	}
}

function assertPiStarted(replies: string[]): void {
	if (!replies.some((text) => text.includes("[Pi] Started task") || text.includes("Started Pi task"))) {
		throw new Error(`Did not observe Pi task start. Replies: ${JSON.stringify(replies)}`);
	}
}

function assertPiProgress(replies: string[]): void {
	if (!replies.some((text) => text.includes("[Pi/tool:start]") || text.includes("[Pi/tool:update]") || text.includes("[Pi/tool:done]"))) {
		throw new Error(`Did not observe Pi tool-level progress. Replies: ${JSON.stringify(replies)}`);
	}
}


function assertNoKawaDelegationReply(replies: string[]): void {
	const nonPiReplies = replies.filter((text) => !text.startsWith("[Pi"));
	if (nonPiReplies.length > 0) {
		throw new Error(`Observed redundant non-Pi delegation replies: ${JSON.stringify(nonPiReplies)}`);
	}
}