import { complete, getModel, type Context } from "@mariozechner/pi-ai";
import { T, type ChatEvent } from "@simplex-chat/types";
import { ChatClient } from "simplex-chat";
import pino from "pino";
import { constants } from "node:fs";
import { access, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseBotModel } from "../../src/config.js";

const log = pino({ name: "smoke-prod" });

const DEFAULT_PRODUCTION_BASE_URL = "https://chronocrystal-pi-production-db31.up.railway.app";
const DEFAULT_JUDGE_MODEL = "github-copilot/minimax-m2.5";
const SMOKE_PROMPT = "What is 5!? Return only the integer.";
const JUDGE_RUBRIC = "PASS only if the reply clearly states that 5! = 120 and does not contradict itself.";
const SIMPLEX_START_TIMEOUT_MS = 30_000;
const CONTACT_READY_TIMEOUT_MS = 90_000;
const PRE_SEND_IDLE_TIMEOUT_MS = 2_000;
const REPLY_TIMEOUT_MS = 120_000;
const PROCESS_SHUTDOWN_TIMEOUT_MS = 5_000;
const LOCAL_SIMPLEX_HOST = "127.0.0.1";

interface AutomationStatus {
	ok: boolean;
	simplexAddress: string;
	environment: string;
	service: string;
	publicDomain: string;
}

interface JudgeVerdict {
	verdict: "pass" | "fail";
	reasoning: string;
}

class BufferedChatEvents {
	#queue: ChatEvent[] = [];
	#resolvers: Array<(event: ChatEvent | null) => void> = [];
	#error: Error | null = null;
	#closed = false;

	constructor(source: AsyncIterable<ChatEvent>) {
		void this.consume(source);
	}

	private async consume(source: AsyncIterable<ChatEvent>): Promise<void> {
		try {
			for await (const event of source) {
				const resolve = this.#resolvers.shift();
				if (resolve) {
					resolve(event);
					continue;
				}

				this.#queue.push(event);
			}
		} catch (error) {
			this.#error = normalizeError(error);
		} finally {
			this.#closed = true;
			while (this.#resolvers.length > 0) {
				this.#resolvers.shift()?.(null);
			}
		}
	}

	async next(timeoutMs: number): Promise<ChatEvent | null> {
		if (this.#error) {
			throw this.#error;
		}

		const queued = this.#queue.shift();
		if (queued) {
			return queued;
		}

		if (this.#closed) {
			throw new Error("SimpleX event stream ended unexpectedly");
		}

		return await new Promise<ChatEvent | null>((resolve, reject) => {
			const finish = (event: ChatEvent | null) => {
				clearTimeout(timer);
				const index = this.#resolvers.indexOf(finish);
				if (index >= 0) {
					this.#resolvers.splice(index, 1);
				}

				if (this.#error) {
					reject(this.#error);
					return;
				}

				if (event === null) {
					if (this.#closed) {
						reject(new Error("SimpleX event stream ended unexpectedly"));
						return;
					}

					resolve(null);
					return;
				}

				resolve(event);
			};

			const timer = setTimeout(() => {
				finish(null);
			}, timeoutMs);

			this.#resolvers.push(finish);
		});
	}
}

async function* iterateChatEvents(source: { next(): Promise<{ value?: ChatEvent | Promise<ChatEvent>; done?: boolean }> }) {
	while (true) {
		const next = await source.next();
		if (next.done) {
			return;
		}

		if (next.value !== undefined) {
			yield await next.value;
		}
	}
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
	const judgeModelSpec = process.env.SMOKE_JUDGE_MODEL?.trim() || DEFAULT_JUDGE_MODEL;
	log.info({ baseUrl, judgeModelSpec }, "starting production smoke test");

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

		let connReqType: string;
		try {
			connReqType = await chatClient.apiConnectActiveUser(status.simplexAddress);
		} catch (error) {
			throw new Error(`Failed to connect to production SimpleX address: ${normalizeError(error).message}`);
		}
		log.info({ connReqType, simplexAddress: status.simplexAddress }, "connected to production bot address");

		contactId = await waitForContactReady(events);
		await drainPreSendEvents(events);

		const sentAt = Date.now();
		await chatClient.apiSendTextMessage(T.ChatType.Direct, contactId, SMOKE_PROMPT);
		log.info({ chatId: contactId, prompt: SMOKE_PROMPT }, "smoke prompt sent");

		const reply = await waitForDirectReply(events, contactId, sentAt);
		log.info({ prompt: SMOKE_PROMPT, reply }, "received production bot reply");

		const verdict = await judgeReply(SMOKE_PROMPT, reply, judgeModelSpec);
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

async function verifyHealth(baseUrl: string): Promise<void> {
	const response = await fetch(new URL("/health", baseUrl));
	const body = await response.text();

	if (!response.ok) {
		throw new Error(`Health check failed with ${response.status}: ${body}`);
	}

	if (body.trim() !== "ok") {
		throw new Error(`Health check returned unexpected body: ${body}`);
	}

	log.info({ healthUrl: new URL("/health", baseUrl).toString(), body: body.trim() }, "health check passed");
}

async function fetchAutomationStatus(baseUrl: string): Promise<AutomationStatus> {
	const response = await fetch(new URL("/automation/status", baseUrl));
	const body = await response.text();

	if (!response.ok) {
		throw new Error(`Automation status failed with ${response.status}: ${body}`);
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(body);
	} catch (error) {
		throw new Error(`Automation status returned invalid JSON: ${normalizeError(error).message}`);
	}

	if (!isAutomationStatus(parsed)) {
		throw new Error(`Automation status returned an unexpected payload: ${body}`);
	}

	if (!parsed.ok) {
		throw new Error(`Automation status reported not ok: ${body}`);
	}

	return parsed;
}

function isAutomationStatus(value: unknown): value is AutomationStatus {
	if (!value || typeof value !== "object") {
		return false;
	}

	const candidate = value as Record<string, unknown>;
	return candidate.ok === true
		&& typeof candidate.simplexAddress === "string"
		&& candidate.simplexAddress.length > 0
		&& typeof candidate.environment === "string"
		&& typeof candidate.service === "string"
		&& typeof candidate.publicDomain === "string";
}

async function resolveSimplexBinary(): Promise<string> {
	const configured = process.env.SIMPLEX_CHAT_BIN?.trim();
	if (configured) {
		if (configured.includes("/")) {
			await access(configured, constants.X_OK);
			return configured;
		}

		const resolvedConfigured = Bun.which(configured);
		if (resolvedConfigured) {
			return resolvedConfigured;
		}

		throw new Error(`SIMPLEX_CHAT_BIN was set but could not be resolved: ${configured}`);
	}

	const resolved = Bun.which("simplex-chat");
	if (resolved) {
		return resolved;
	}

	throw new Error("simplex-chat binary not found on PATH. Install the SimpleX terminal CLI or set SIMPLEX_CHAT_BIN.");
}

async function getFreePort(): Promise<number> {
	return await new Promise<number>((resolve, reject) => {
		const server = createServer();

		server.once("error", reject);
		server.listen(0, LOCAL_SIMPLEX_HOST, () => {
			const address = server.address();
			if (!address || typeof address === "string") {
				server.close(() => {
					reject(new Error("Failed to allocate a local TCP port"));
				});
				return;
			}

			server.close((error) => {
				if (error) {
					reject(error);
					return;
				}

				resolve(address.port);
			});
		});
	});
}

function launchSimplex(binary: string, dataPrefix: string, port: number, displayName: string): Bun.PipedSubprocess {
	log.info({ binary, dataPrefix, port, displayName }, "starting local simplex-chat");
	return Bun.spawn({
		cmd: [binary, "-d", dataPrefix, "-p", String(port), "-y", "--create-bot-display-name", displayName],
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
		lazy: true,
	});
}

async function connectLocalClient(port: number, simplexProcess: Bun.PipedSubprocess): Promise<ChatClient> {
	const serverUrl = `ws://${LOCAL_SIMPLEX_HOST}:${port}`;
	const deadline = Date.now() + SIMPLEX_START_TIMEOUT_MS;
	let lastError: Error | null = null;

	while (Date.now() < deadline) {
		if (simplexProcess.exitCode !== null) {
			const output = await readSubprocessOutput(simplexProcess);
			throw new Error(`simplex-chat exited before the WebSocket API was ready (code ${simplexProcess.exitCode}). stderr: ${output.stderr || "<empty>"}`);
		}

		try {
			const client = await ChatClient.create(serverUrl);
			log.info({ serverUrl }, "connected to local simplex-chat");
			return client;
		} catch (error) {
			lastError = normalizeError(error);
			await Bun.sleep(500);
		}
	}

	throw new Error(`Timed out waiting for local simplex-chat on ${serverUrl}: ${lastError?.message ?? "unknown error"}`);
}

function buildSmokeUserDisplayName(): string {
	return `ChronoCrystalSmoke${Date.now().toString(36)}`;
}

async function ensureActiveUser(chatClient: ChatClient, displayName: string) {
	const activeUser = await chatClient.apiGetActiveUser();
	if (activeUser) {
		return activeUser;
	}

	return await chatClient.apiCreateActiveUser({
		displayName,
		fullName: "ChronoCrystal Production Smoke Test",
	});
}


async function waitForContactReady(events: BufferedChatEvents): Promise<number> {
	while (true) {
		const event = await events.next(CONTACT_READY_TIMEOUT_MS);
		if (!event) {
			throw new Error(`Timed out after ${CONTACT_READY_TIMEOUT_MS}ms waiting for the production contact to become ready`);
		}

		throwOnFailureEvent(event);

		if (event.type === "contactConnecting") {
			log.info({ contactId: event.contact.contactId }, "production contact connecting");
			continue;
		}

		if (event.type === "contactConnected" || event.type === "contactSndReady") {
			log.info({ contactId: event.contact.contactId, eventType: event.type }, "production contact ready");
			return event.contact.contactId;
		}
	}
}

async function drainPreSendEvents(events: BufferedChatEvents): Promise<void> {
	while (true) {
		const event = await events.next(PRE_SEND_IDLE_TIMEOUT_MS);
		if (!event) {
			return;
		}

		throwOnFailureEvent(event);
		log.info({ eventType: event.type }, "draining pre-send SimpleX event");
	}
}

async function waitForDirectReply(events: BufferedChatEvents, contactId: number, sentAt: number): Promise<string> {
	while (true) {
		const event = await events.next(REPLY_TIMEOUT_MS);
		if (!event) {
			throw new Error(`Timed out after ${REPLY_TIMEOUT_MS}ms waiting for a bot reply`);
		}

		throwOnFailureEvent(event);

		if (event.type !== "newChatItems") {
			continue;
		}

		for (const { chatInfo, chatItem } of event.chatItems) {
			if (chatInfo.type !== T.ChatType.Direct || chatInfo.contact.contactId !== contactId) {
				continue;
			}

			if (chatItem.content.type !== "rcvMsgContent" || chatItem.content.msgContent.type !== "text") {
				continue;
			}

			const itemTimestamp = Date.parse(chatItem.meta.itemTs);
			if (Number.isFinite(itemTimestamp) && itemTimestamp < sentAt) {
				log.info({ chatId: contactId, itemTs: chatItem.meta.itemTs }, "ignoring pre-prompt inbound message");
				continue;
			}

			return chatItem.content.msgContent.text.trim();
		}
	}
}

function throwOnFailureEvent(event: ChatEvent): void {
	if (event.type === "messageError") {
		throw new Error(`SimpleX message error: ${event.errorMessage}`);
	}

	if (event.type === "chatError") {
		throw new Error(`SimpleX chat error: ${JSON.stringify(event.chatError)}`);
	}

	if (event.type === "chatErrors") {
		throw new Error(`SimpleX chat errors: ${JSON.stringify(event.chatErrors)}`);
	}
}

async function judgeReply(prompt: string, reply: string, judgeModelSpec: string): Promise<JudgeVerdict> {
	const { provider, modelId } = parseBotModel(judgeModelSpec);
	// @ts-expect-error pi-ai model lookup is runtime-configured from environment.
	const model = getModel(provider, modelId);
	if (!model) {
		throw new Error(`Judge model not found: ${judgeModelSpec}`);
	}

	const context: Context = {
		systemPrompt: [
			"You are a strict smoke-test judge.",
			"Return exactly one JSON object and nothing else.",
			"The JSON schema is: {\"verdict\":\"pass\"|\"fail\",\"reasoning\":string}.",
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
	log.info({ judgeModelSpec, rawJudgeReply }, "received judge response");
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

async function cleanupResources(options: {
	chatClient: ChatClient | null;
	contactId: number | null;
	simplexProcess: Bun.PipedSubprocess | null;
	tempDir: string;
}): Promise<string[]> {
	const errors: string[] = [];

	if (options.chatClient && options.contactId !== null) {
		try {
			await options.chatClient.apiDeleteChat(T.ChatType.Direct, options.contactId, {
				type: "entity",
				notify: false,
			});
			log.info({ chatId: options.contactId }, "deleted temporary direct chat");
		} catch (error) {
			errors.push(`delete chat: ${normalizeError(error).message}`);
		}
	}

	if (options.chatClient) {
		try {
			await options.chatClient.disconnect();
			log.info("disconnected temporary SimpleX client");
		} catch (error) {
			errors.push(`disconnect client: ${normalizeError(error).message}`);
		}
	}

	if (options.simplexProcess) {
		try {
			if (options.simplexProcess.exitCode === null && !options.simplexProcess.killed) {
				options.simplexProcess.kill("SIGTERM");
				await waitForProcessExit(options.simplexProcess, PROCESS_SHUTDOWN_TIMEOUT_MS);
			}
			log.info({ exitCode: options.simplexProcess.exitCode }, "stopped temporary simplex-chat");
		} catch (error) {
			errors.push(`stop simplex-chat: ${normalizeError(error).message}`);
			if (options.simplexProcess.exitCode === null && !options.simplexProcess.killed) {
				try {
					options.simplexProcess.kill("SIGKILL");
					await options.simplexProcess.exited;
				} catch (killError) {
					errors.push(`kill simplex-chat: ${normalizeError(killError).message}`);
				}
			}
		}
	}

	try {
		await rm(options.tempDir, { recursive: true, force: true });
		log.info({ tempDir: options.tempDir }, "removed temporary SimpleX state");
	} catch (error) {
		errors.push(`remove temp dir: ${normalizeError(error).message}`);
	}

	return errors;
}

async function waitForProcessExit(process: Bun.Subprocess<any, any, any>, timeoutMs: number): Promise<void> {
	await Promise.race([
		process.exited.then(() => undefined),
		new Promise<never>((_, reject) => {
			setTimeout(() => reject(new Error(`Timed out waiting ${timeoutMs}ms for simplex-chat to exit`)), timeoutMs);
		}),
	]);
}

async function readSubprocessOutput(process: Bun.PipedSubprocess): Promise<{ stdout: string; stderr: string }> {
	const stdout = process.stdout ? (await process.stdout.text()).trim() : "";
	const stderr = process.stderr ? (await process.stderr.text()).trim() : "";
	return { stdout, stderr };
}

function normalizeError(error: unknown): Error {
	return error instanceof Error ? error : new Error(String(error));
}
