interface ErrorLike {
	[key: string]: unknown;
	message?: unknown;
	name?: unknown;
	status?: unknown;
	statusCode?: unknown;
	type?: unknown;
	code?: unknown;
	error?: unknown;
	cause?: unknown;
	headers?: unknown;
	response?: unknown;
}

const RATE_LIMIT_PATTERN = /rate[ -]?limit|too many requests|slow_down|too_many_requests|usage_limit_reached|rate_limit_exceeded|max_uses_exceeded/i;
const BILLING_PATTERN = /billing|insufficient[_ -]?quota|out of credits|credit balance|payment required|usage_not_included|quota exceeded|quota exhausted/i;
const AUTH_PATTERN = /authentication|unauthorized|forbidden|permission|invalid api key|missing api key|no api key|requires oauth|use \/login|credential/i;
const OVERLOADED_PATTERN = /overloaded|over capacity|temporarily unavailable|service unavailable/i;
const NETWORK_PATTERN = /network error|fetch failed|connection|econn|enotfound|timed out|timeout|socket hang up|tls/i;
const PROVIDER_PATTERN = /provider|api error|request failed|response failed|status code|cloud code assist api error|codex error/i;
const GENERIC_DETAIL_MAX_CHARS = 220;

export function formatProviderErrorForUser(error: unknown, modelLabel: string): string | null {
	const detail = extractErrorDetail(error);
	const status = extractStatus(error);
	const type = extractMetadataString(error, "type");
	const code = extractMetadataString(error, "code");
	const retryAfterSeconds = extractRetryAfterSeconds(error);
	const haystack = [detail, type, code]
		.filter((value): value is string => Boolean(value))
		.join(" ")
		.toLowerCase();

	if (isAbortError(error, detail)) {
		return null;
	}

	if (status === 429 || RATE_LIMIT_PATTERN.test(haystack)) {
		return [
			`Provider error from ${modelLabel}: rate limited this request.`,
			formatRetryAfter(retryAfterSeconds),
			formatDetail(detail),
		]
			.filter(Boolean)
			.join(" ");
	}

	if (status === 402 || extractMetadataString(error, "type") === "billing_error" || BILLING_PATTERN.test(haystack)) {
		return [
			`Provider error from ${modelLabel}: the account appears out of quota or credits.`,
			formatDetail(detail),
		]
			.filter(Boolean)
			.join(" ");
	}

	if (status === 401 || status === 403 || AUTH_PATTERN.test(haystack)) {
		return [
			`Provider error from ${modelLabel}: authentication or permissions failed.`,
			formatDetail(detail),
		]
			.filter(Boolean)
			.join(" ");
	}

	if (OVERLOADED_PATTERN.test(haystack)) {
		return [
			`Provider error from ${modelLabel}: the provider is overloaded right now.`,
			"Try again shortly.",
			formatDetail(detail),
		]
			.filter(Boolean)
			.join(" ");
	}

	if (NETWORK_PATTERN.test(haystack)) {
		return [
			`Provider error from ${modelLabel}: the connection to the provider failed.`,
			formatDetail(detail),
		]
			.filter(Boolean)
			.join(" ");
	}

	if (status !== null || type || code || PROVIDER_PATTERN.test(haystack)) {
		return [
			`Provider error from ${modelLabel}: request failed.`,
			formatDetail(detail),
		]
			.filter(Boolean)
			.join(" ");
	}

	return null;
}

function isAbortError(error: unknown, detail: string | null): boolean {
	const record = asRecord(error);
	const name = typeof record?.name === "string" ? record.name : null;
	return name === "AbortError" || detail === "Request was aborted";
}

function extractErrorDetail(error: unknown): string | null {
	const candidates = [error, asRecord(error)?.error, asRecord(error)?.cause, asRecord(error)?.response];
	for (const candidate of candidates) {
		const message = sanitizeDetail(readMessage(candidate));
		if (message) {
			return message;
		}
	}
	return null;
}

function readMessage(value: unknown): string | null {
	if (typeof value === "string") {
		return value;
	}
	if (value instanceof Error) {
		return value.message;
	}
	const record = asRecord(value);
	if (!record) {
		return null;
	}
	if (typeof record.message === "string") {
		return record.message;
	}
	const nestedError = asRecord(record.error);
	if (typeof nestedError?.message === "string") {
		return nestedError.message;
	}
	return null;
}

function extractStatus(error: unknown): number | null {
	const candidates = [
		asRecord(error)?.status,
		asRecord(error)?.statusCode,
		asRecord(asRecord(error)?.response)?.status,
		asRecord(asRecord(error)?.error)?.status,
		asRecord(asRecord(error)?.cause)?.status,
	];
	for (const candidate of candidates) {
		if (typeof candidate === "number" && Number.isFinite(candidate)) {
			return candidate;
		}
		if (typeof candidate === "string" && /^\d+$/.test(candidate)) {
			return Number(candidate);
		}
	}
	return null;
}

function extractMetadataString(error: unknown, key: "type" | "code"): string | null {
	const root = asRecord(error);
	const nestedError = asRecord(root?.error);
	const cause = asRecord(root?.cause);
	const candidates = [root?.[key], nestedError?.[key], cause?.[key]];
	for (const candidate of candidates) {
		if (typeof candidate === "string" && candidate.trim().length > 0) {
			return candidate.trim();
		}
	}
	return null;
}

function extractRetryAfterSeconds(error: unknown): number | null {
	const headerSources = [
		asRecord(error)?.headers,
		asRecord(asRecord(error)?.response)?.headers,
		asRecord(asRecord(error)?.cause)?.headers,
	];
	for (const headers of headerSources) {
		const raw = readHeader(headers, "retry-after");
		if (!raw) {
			continue;
		}
		const seconds = Number(raw);
		if (Number.isFinite(seconds) && seconds >= 0) {
			return seconds;
		}
		const retryAt = Date.parse(raw);
		if (!Number.isNaN(retryAt)) {
			return Math.max(0, Math.ceil((retryAt - Date.now()) / 1000));
		}
	}
	return null;
}

function readHeader(value: unknown, name: string): string | null {
	if (!value) {
		return null;
	}
	if (typeof value === "object" && value !== null && "get" in value && typeof (value as { get?: unknown }).get === "function") {
		const result = (value as { get(name: string): unknown }).get(name);
		return typeof result === "string" && result.trim().length > 0 ? result.trim() : null;
	}
	const record = asRecord(value);
	if (!record) {
		return null;
	}
	const direct = record[name] ?? record[name.toLowerCase()] ?? record[name.toUpperCase()];
	return typeof direct === "string" && direct.trim().length > 0 ? direct.trim() : null;
}

function sanitizeDetail(detail: string | null): string | null {
	if (!detail) {
		return null;
	}
	const compact = detail.replace(/\s+/g, " ").trim();
	if (!compact) {
		return null;
	}
	return compact.length > GENERIC_DETAIL_MAX_CHARS ? `${compact.slice(0, GENERIC_DETAIL_MAX_CHARS)}...` : compact;
}

function formatDetail(detail: string | null): string | null {
	if (!detail) {
		return null;
	}
	return `Details: ${detail}`;
}

function formatRetryAfter(retryAfterSeconds: number | null): string | null {
	if (retryAfterSeconds === null) {
		return null;
	}
	if (retryAfterSeconds < 60) {
		return `Retry after about ${retryAfterSeconds}s.`;
	}
	const minutes = Math.ceil(retryAfterSeconds / 60);
	return `Retry after about ${minutes} min.`;
}

function asRecord(value: unknown): ErrorLike | null {
	return value && typeof value === "object" ? (value as ErrorLike) : null;
}
