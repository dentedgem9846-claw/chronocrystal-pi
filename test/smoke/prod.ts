import { complete, getModel, type Context } from "@mariozechner/pi-ai";
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
	waitForDirectReply,
} from "./simplex-harness.js";

const log = pino({ name: "smoke-prod" });

const DEFAULT_PRODUCTION_BASE_URL = "https://chronocrystal-pi-production-db31.up.railway.app";
const DEFAULT_JUDGE_PROVIDER = "github-copilot";
const DEFAULT_JUDGE_MODEL_ID = "gpt-4.1";
const SMOKE_PROMPT = "What is 5!? Return only the integer.";
const JUDGE_RUBRIC = "PASS only if the reply clearly states that 5! = 120 and does not contradict itself.";

interface JudgeVerdict {
	verdict: "pass" | "fail";
	reasoning: string;
}

await main();

async function main(): Promise<void> {
	try {
		await runSmokeTest();
		log.info("production smoke test passed");
	} catch (error) {
		const failure = normalizeError(error);
		log.error({ err: failure.message }, "production smoke test failed");
		process.exit(1);
	}
}

async function runSmokeTest(): Promise<void> {
	const baseUrl = process.env.SMOKE_PROD_BASE_URL?.trim() || DEFAULT_PRODUCTION_BASE_URL;
	const judgeProvider = process.env.SMOKE_JUDGE_PROVIDER?.trim() || DEFAULT_JUDGE_PROVIDER;
	const judgeModelId = process.env.SMOKE_JUDGE_MODEL_ID?.trim() || DEFAULT_JUDGE_MODEL_ID;
	log.info({ baseUrl, judgeProvider, judgeModelId }, "starting production smoke test");

	await verifyHealth(baseUrl);
	const status = await fetchAutomationStatus(baseUrl);
	log.info({ status }, "fetched production automation status");

	const simplexBinary = await resolveSimplexBinary();
	const tempDir = await mkdtemp(join(tmpdir(), "chronocrystal-smoke-"));
	const dataPrefix = join(tempDir, "simplex");
	const simplexPort = await getFreePort();

	let simplexProcess: Bun.PipedSubprocess | null = null;
	let chatClient: ChatClient | null = null;
	let contactId: number | null = null;
	let testFailed = false;

	try {
		const smokeDisplayName = buildSmokeUserDisplayName();
		simplexProcess = launchSimplex(simplexBinary, dataPrefix, simplexPort, smokeDisplayName);
		chatClient = await connectLocalClient(simplexPort, simplexProcess);
		const events = new BufferedChatEvents(iterateChatEvents(chatClient.msgQ));

		const smokeUser = await ensureActiveUser(chatClient, smokeDisplayName);
		log.info({ userId: smokeUser.userId, simplexPort, displayName: smokeDisplayName }, "temporary SimpleX user ready");

		const connReqType = await chatClient.apiConnectActiveUser(status.simplexAddress);
		log.info({ connReqType, simplexAddress: status.simplexAddress }, "connected to production bot address");

		contactId = await waitForContactReady(events);
		await drainPreSendEvents(events);

		const sentAt = Date.now();
		await chatClient.apiSendTextMessage(T.ChatType.Direct, contactId, SMOKE_PROMPT);
		log.info({ chatId: contactId, prompt: SMOKE_PROMPT }, "smoke prompt sent");

		const reply = await waitForDirectReply(events, contactId, sentAt);
		log.info({ prompt: SMOKE_PROMPT, reply }, "received production bot reply");

		const verdict = await judgeReply(SMOKE_PROMPT, reply, judgeProvider, judgeModelId);
		log.info({ rubric: JUDGE_RUBRIC, verdict }, "judge verdict produced");

		if (verdict.verdict !== "pass") {
			throw new Error(`Smoke judge failed: ${verdict.reasoning}`);
		}
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

async function judgeReply(prompt: string, reply: string, judgeProvider: string, judgeModelId: string): Promise<JudgeVerdict> {
	const model = getModel(judgeProvider as any, judgeModelId as any);
	if (!model) {
		throw new Error(`Judge model not found: ${judgeProvider}/${judgeModelId}`);
	}

	const context: Context = {
		systemPrompt: [
			"You are a strict smoke-test judge.",
			"Return exactly one JSON object and nothing else.",
			'The JSON schema is: {"verdict":"pass"|"fail","reasoning":string}.',
			"Treat transport failures separately: only judge the semantic content of the bot reply you are given.",
		].join(" "),
		messages: [{
			role: "user",
			content: [
				`Prompt: ${prompt}`,
				`Reply: ${reply}`,
				`Rubric: ${JUDGE_RUBRIC}`,
			].join("\n"),
			timestamp: Date.now(),
		}],
	};

	const response = await complete(model, context);
	const rawJudgeReply = getAssistantText(response).trim();
	log.info({ judgeProvider, judgeModelId, rawJudgeReply }, "received judge response");
	return parseJudgeVerdict(rawJudgeReply);
}

function getAssistantText(response: Awaited<ReturnType<typeof complete>>): string {
	return response.content
		.filter((block) => block.type === "text")
		.map((block) => block.text)
		.join("\n")
		.trim();
}

function parseJudgeVerdict(raw: string): JudgeVerdict {
	const match = raw.match(/\{[\s\S]*\}/);
	if (!match) {
		throw new Error(`Judge did not return JSON: ${raw}`);
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(match[0]);
	} catch (error) {
		throw new Error(`Judge returned invalid JSON: ${normalizeError(error).message}`);
	}

	if (!parsed || typeof parsed !== "object") {
		throw new Error(`Judge returned unexpected payload: ${raw}`);
	}

	const candidate = parsed as Record<string, unknown>;
	if ((candidate.verdict !== "pass" && candidate.verdict !== "fail") || typeof candidate.reasoning !== "string") {
		throw new Error(`Judge returned unexpected schema: ${raw}`);
	}

	return {
		verdict: candidate.verdict,
		reasoning: candidate.reasoning,
	};
}
