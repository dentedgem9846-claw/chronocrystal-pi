/**
 * Default values for bot configuration.
 */
export const DEFAULT_BOT_DISPLAY_NAME = "ChronoCrystal";
export const DEFAULT_BOT_MODEL = "openrouter/minimax/minimax-m2.5:free";
export const DEFAULT_SIMPLEX_HOST = "127.0.0.1";
export const DEFAULT_SIMPLEX_PORT = 5225;
export const EMPTY_RESPONSE_REPLY = "Sorry, I couldn't generate a reply.";
export const GENERATION_ERROR_REPLY = "Sorry, I hit an internal error while generating a reply.";

/**
 * Gets the bot display name from environment or returns default.
 */
export function getBotDisplayName(env = process.env): string {
    return env.BOT_DISPLAY_NAME ?? DEFAULT_BOT_DISPLAY_NAME;
}

/**
 * Gets the bot model from environment or returns default.
 */
export function getBotModel(env = process.env): string {
    return env.BOT_MODEL ?? DEFAULT_BOT_MODEL;
}

/**
 * Parses a BOT_MODEL value (e.g., "github-copilot/gpt-4.1") into its provider and model ID components.
 * @param value - A "provider/modelId" string
 * @returns Object with provider and modelId
 * @throws Error if the value is malformed (missing "/", empty provider or modelId)
 * @example parseBotModel("github-copilot/gpt-4.1") // { provider: "github-copilot", modelId: "gpt-4.1" }
 * @example parseBotModel("openrouter/anthropic/claude-3.5-sonnet") // { provider: "openrouter", modelId: "anthropic/claude-3.5-sonnet" }
 */
export function parseBotModel(value: string): { provider: string; modelId: string } {
    const separator = value.indexOf("/");
    if (separator <= 0 || separator === value.length - 1) {
        throw new Error(`Invalid BOT_MODEL: ${value}`);
    }

    return {
        provider: value.slice(0, separator),
        modelId: value.slice(separator + 1),
    };
}

/**
 * Gets the SimpleX host from environment or returns default.
 */
export function getSimplexHost(env = process.env): string {
    return env.SIMPLEX_HOST ?? DEFAULT_SIMPLEX_HOST;
}

/**
 * Gets the SimpleX port from environment or returns default.
 */
export function getSimplexPort(env = process.env): number {
    const rawPort = env.SIMPLEX_PORT ?? String(DEFAULT_SIMPLEX_PORT);
    const port = Number.parseInt(rawPort, 10);
    if (!Number.isInteger(port) || port <= 0) {
        throw new Error(`Invalid SIMPLEX_PORT: ${rawPort}`);
    }

    return port;
}