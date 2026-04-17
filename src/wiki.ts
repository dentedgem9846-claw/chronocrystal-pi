import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { resolve } from "node:path";

import pino from "pino";

const log = pino({ name: "wiki" });

export const WIKI_ROUTE_PREFIX = "/wiki";

const APP_ROOT = resolve(import.meta.dir, "..");
const DEFAULT_WIKI_FOLDER_NAME = "kawawiki";
const DEFAULT_WIKI_HOST = "127.0.0.1";
const DEFAULT_WIKI_PORT = 8081;
const DEFAULT_WIKI_SEED_FILE = "KawaWiki.html";
const TIDDLYWIKI_CLI_PATH = resolve(APP_ROOT, "node_modules/.bin/tiddlywiki");
const WIKI_READY_TIMEOUT_MS = 15_000;
const WIKI_READY_RETRY_MS = 250;

let defaultWikiServerPromise: Promise<StartedWikiServer> | null = null;

export interface WikiTiddler {
	title: string;
	text?: string;
	type?: string;
	tags?: string[];
	created?: string;
	creator?: string;
	modified?: string;
	modifier?: string;
}

export interface WikiServerOptions {
	workspaceDir?: string;
	seedHtmlPath?: string;
	wikiDir?: string;
	host?: string;
	port?: number;
	routePrefix?: string;
}

interface ResolvedWikiServerOptions {
	workspaceDir: string;
	seedHtmlPath: string;
	wikiDir: string;
	host: string;
	port: number;
	routePrefix: string;
}

export interface StartedWikiServer {
	baseUrl: string;
	routePrefix: string;
	seedHtmlPath: string;
	wikiDir: string;
	stop(): Promise<void>;
}

export async function resolveWorkspaceDir(cwd = process.cwd()): Promise<string> {
	const currentDir = resolve(cwd);
	if (await pathExists(resolve(currentDir, ".pi/SYSTEM.md"))) {
		return currentDir;
	}

	const dataDir = resolve(currentDir, "data");
	if (await pathExists(resolve(dataDir, ".pi/SYSTEM.md"))) {
		return dataDir;
	}

	return currentDir;
}

export async function ensureDefaultWikiServerStarted(): Promise<StartedWikiServer> {
	if (!defaultWikiServerPromise) {
		defaultWikiServerPromise = startWikiServer().catch((error) => {
			defaultWikiServerPromise = null;
			throw error;
		});
	}

	return await defaultWikiServerPromise;
}

export async function startWikiServer(options: WikiServerOptions = {}): Promise<StartedWikiServer> {
	const resolved = await resolveWikiServerOptions(options);
	await initializeWikiIfNeeded(resolved);

	const args = [
		resolved.wikiDir,
		"--listen",
		`host=${resolved.host}`,
		`port=${resolved.port}`,
		`path-prefix=${resolved.routePrefix}`,
		"use-browser-cache=no",
	];
	const subprocess = Bun.spawn([TIDDLYWIKI_CLI_PATH, ...args], {
		cwd: resolved.workspaceDir,
		stdout: "ignore",
		stderr: "inherit",
	});
	const baseUrl = buildWikiBaseUrl(resolved);

	try {
		await waitForWikiReady(baseUrl);
	} catch (error) {
		try {
			subprocess.kill();
		} catch {
			// ignore cleanup failure during startup error handling
		}
		await subprocess.exited;
		throw error;
	}

	process.on("exit", () => {
		try {
			subprocess.kill();
		} catch {
			// ignore shutdown cleanup errors
		}
	});
	void subprocess.exited.then((exitCode) => {
		if (exitCode !== 0) {
			log.error({ exitCode, wikiDir: resolved.wikiDir }, "tiddlywiki server exited unexpectedly");
		}
	});

	log.info(
		{ baseUrl, seedHtmlPath: resolved.seedHtmlPath, wikiDir: resolved.wikiDir },
		"tiddlywiki server ready"
	);

	return {
		baseUrl,
		routePrefix: resolved.routePrefix,
		seedHtmlPath: resolved.seedHtmlPath,
		wikiDir: resolved.wikiDir,
		async stop() {
			try {
				subprocess.kill();
			} catch {
				// ignore if process is already gone
			}
			await subprocess.exited;
		},
	};
}

export async function proxyWikiRequest(request: Request): Promise<Response> {
	const wikiServer = await ensureDefaultWikiServerStarted();
	const wikiBaseUrl = new URL(wikiServer.baseUrl);
	const targetUrl = new URL(request.url);
	const headers = new Headers(request.headers);

	targetUrl.protocol = wikiBaseUrl.protocol;
	targetUrl.hostname = wikiBaseUrl.hostname;
	targetUrl.port = wikiBaseUrl.port;
	headers.delete("host");

	try {
		return await fetch(targetUrl, {
			method: request.method,
			headers,
			body: allowsRequestBody(request.method) ? request.body : undefined,
			redirect: "manual",
		});
	} catch (error) {
		log.error({ err: normalizeError(error).message, targetUrl: targetUrl.toString() }, "wiki proxy failed");
		return new Response("wiki unavailable", {
			status: 502,
			headers: { "Content-Type": "text/plain; charset=utf-8" },
		});
	}
}

export async function listWikiTiddlers(): Promise<WikiTiddler[]> {
	const response = await fetchWiki("recipes/default/tiddlers.json");
	const payload = (await response.json()) as unknown;
	if (!Array.isArray(payload)) {
		throw new Error("TiddlyWiki returned a non-array tiddler list");
	}

	return payload
		.map((entry) => normalizeWikiTiddler(entry))
		.filter((entry): entry is WikiTiddler => entry !== null);
}

export async function getWikiTiddler(title: string): Promise<WikiTiddler | null> {
	const response = await fetchWiki(`recipes/default/tiddlers/${encodeURIComponent(title)}`, {
		allowNotFound: true,
	});
	if (response.status === 404) {
		return null;
	}

	return normalizeWikiTiddler((await response.json()) as unknown);
}

export async function setWikiTiddler(input: {
	title: string;
	text: string;
	tags?: string[];
	type?: string;
}): Promise<WikiTiddler> {
	const title = input.title.trim();
	if (!title) {
		throw new Error("Tiddler title cannot be empty");
	}

	const existing = await getWikiTiddler(title);
	const now = formatTiddlyTimestamp();
	const payload: WikiTiddler = {
		title,
		text: input.text,
		tags: input.tags ?? existing?.tags,
		type: input.type ?? existing?.type ?? "text/vnd.tiddlywiki",
		created: existing?.created ?? now,
		creator: existing?.creator ?? "Kawa",
		modified: now,
		modifier: "Kawa",
	};

	await fetchWiki(`recipes/default/tiddlers/${encodeURIComponent(title)}`, {
		method: "PUT",
		headers: {
			"Content-Type": "application/json",
			"X-Requested-With": "TiddlyWiki",
		},
		body: JSON.stringify(payload),
	});

	return (await getWikiTiddler(title)) ?? payload;
}

async function resolveWikiServerOptions(options: WikiServerOptions): Promise<ResolvedWikiServerOptions> {
	const workspaceDir = resolve(options.workspaceDir ?? (await resolveWorkspaceDir()));
	return {
		workspaceDir,
		seedHtmlPath: resolve(options.seedHtmlPath ?? resolve(workspaceDir, DEFAULT_WIKI_SEED_FILE)),
		wikiDir: resolve(options.wikiDir ?? resolve(workspaceDir, DEFAULT_WIKI_FOLDER_NAME)),
		host: options.host ?? DEFAULT_WIKI_HOST,
		port: options.port ?? DEFAULT_WIKI_PORT,
		routePrefix: normalizeRoutePrefix(options.routePrefix ?? WIKI_ROUTE_PREFIX),
	};
}

async function initializeWikiIfNeeded(options: ResolvedWikiServerOptions): Promise<void> {
	if (await pathExists(resolve(options.wikiDir, "tiddlywiki.info"))) {
		return;
	}

	if (await pathExists(options.wikiDir)) {
		throw new Error(`Wiki directory exists but is not initialized: ${options.wikiDir}`);
	}

	if (!(await pathExists(options.seedHtmlPath))) {
		throw new Error(`Seed TiddlyWiki HTML not found: ${options.seedHtmlPath}`);
	}

	log.info({ seedHtmlPath: options.seedHtmlPath, wikiDir: options.wikiDir }, "initializing wiki from seed html");
	await runTiddlyWikiCommand(["--load", options.seedHtmlPath, "--savewikifolder", options.wikiDir], options.workspaceDir);
}

async function runTiddlyWikiCommand(args: string[], cwd: string): Promise<void> {
	const subprocess = Bun.spawn([TIDDLYWIKI_CLI_PATH, ...args], {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
	});
	const [exitCode, stdout, stderr] = await Promise.all([
		subprocess.exited,
		streamToText(subprocess.stdout),
		streamToText(subprocess.stderr),
	]);

	if (exitCode !== 0) {
		throw new Error(
			`TiddlyWiki command failed (${exitCode}): ${[stderr.trim(), stdout.trim()].filter(Boolean).join("\n") || args.join(" ")}`
		);
	}
}

async function waitForWikiReady(baseUrl: string): Promise<void> {
	const deadline = Date.now() + WIKI_READY_TIMEOUT_MS;
	let lastError: Error | null = null;
	const statusUrl = new URL("status", baseUrl);

	while (Date.now() < deadline) {
		try {
			const response = await fetch(statusUrl, { signal: AbortSignal.timeout(WIKI_READY_RETRY_MS) });
			if (response.ok) {
				return;
			}
			lastError = new Error(`Unexpected wiki status response: ${response.status}`);
		} catch (error) {
			lastError = normalizeError(error);
		}
		await Bun.sleep(WIKI_READY_RETRY_MS);
	}

	throw new Error(`TiddlyWiki server did not become ready at ${statusUrl}: ${lastError?.message ?? "unknown error"}`);
}

async function fetchWiki(
	path: string,
	options: RequestInit & { allowNotFound?: boolean } = {}
): Promise<Response> {
	const { allowNotFound = false, ...requestInit } = options;
	const wikiServer = await ensureDefaultWikiServerStarted();
	const response = await fetch(new URL(path, wikiServer.baseUrl), requestInit);
	if (allowNotFound && response.status === 404) {
		return response;
	}
	if (!response.ok) {
		const body = await response.text();
		throw new Error(`TiddlyWiki request failed with ${response.status}: ${body}`);
	}
	return response;
}

function normalizeWikiTiddler(value: unknown): WikiTiddler | null {
	if (!value || typeof value !== "object") {
		return null;
	}

	const record = value as Record<string, unknown>;
	if (typeof record.title !== "string") {
		return null;
	}

	return {
		title: record.title,
		text: typeof record.text === "string" ? record.text : undefined,
		type: typeof record.type === "string" ? record.type : undefined,
		tags: normalizeTags(record.tags),
		created: typeof record.created === "string" ? record.created : undefined,
		creator: typeof record.creator === "string" ? record.creator : undefined,
		modified: typeof record.modified === "string" ? record.modified : undefined,
		modifier: typeof record.modifier === "string" ? record.modifier : undefined,
	};
}

function normalizeTags(value: unknown): string[] | undefined {
	if (Array.isArray(value)) {
		return value.filter((entry): entry is string => typeof entry === "string");
	}
	if (typeof value === "string") {
		return value.split(" ").map((entry) => entry.trim()).filter(Boolean);
	}
	return undefined;
}

function normalizeRoutePrefix(value: string): string {
	if (value === "/") {
		return value;
	}
	const withLeadingSlash = value.startsWith("/") ? value : `/${value}`;
	return withLeadingSlash.endsWith("/") ? withLeadingSlash.slice(0, -1) : withLeadingSlash;
}

function buildWikiBaseUrl(options: ResolvedWikiServerOptions): string {
	return `http://${options.host}:${options.port}${options.routePrefix}/`;
}

function allowsRequestBody(method: string): boolean {
	return method !== "GET" && method !== "HEAD";
}

function formatTiddlyTimestamp(date = new Date()): string {
	const year = date.getUTCFullYear().toString().padStart(4, "0");
	const month = String(date.getUTCMonth() + 1).padStart(2, "0");
	const day = String(date.getUTCDate()).padStart(2, "0");
	const hours = String(date.getUTCHours()).padStart(2, "0");
	const minutes = String(date.getUTCMinutes()).padStart(2, "0");
	const seconds = String(date.getUTCSeconds()).padStart(2, "0");
	const milliseconds = String(date.getUTCMilliseconds()).padStart(3, "0");
	return `${year}${month}${day}${hours}${minutes}${seconds}${milliseconds}`;
}

async function pathExists(path: string): Promise<boolean> {
	try {
		await access(path, constants.F_OK);
		return true;
	} catch {
		return false;
	}
}

async function streamToText(stream: ReadableStream<Uint8Array> | null | undefined): Promise<string> {
	if (!stream) {
		return "";
	}
	return await new Response(stream).text();
}

function normalizeError(error: unknown): Error {
	return error instanceof Error ? error : new Error(String(error));
}
