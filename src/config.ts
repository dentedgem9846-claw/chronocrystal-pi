/**
 * Default values for bot configuration.
 */
export const DEFAULT_BOT_DISPLAY_NAME = "ChronoCrystal";
export const DEFAULT_BOT_PROVIDER = "github-copilot";
export const DEFAULT_BOT_MODEL_ID = "minimax-m2.5";
export const DEFAULT_SIMPLEX_HOST = "127.0.0.1";
export const DEFAULT_SIMPLEX_PORT = 5225;
const DEFAULT_SERVER_PORT = 8080;
export const EMPTY_RESPONSE_REPLY = "Sorry, I couldn't generate a reply.";
export const GENERATION_ERROR_REPLY = "Sorry, I hit an internal error while generating a reply.";
const DEFAULT_PI_AGENT_SCRIPT = "src/pi-agent-cli.ts";
export const DEFAULT_PI_PROVIDER = "github-copilot";
export const DEFAULT_PI_MODEL_ID = "minimax-m2.5";

/**
 * Gets the bot display name from environment or returns default.
 */
export function getBotDisplayName(env = process.env): string {
    return env.BOT_DISPLAY_NAME ?? DEFAULT_BOT_DISPLAY_NAME;
}

/**
 * Gets the bot provider from environment or returns default.
 */
export function getBotProvider(env = process.env): string {
    return env.BOT_PROVIDER ?? DEFAULT_BOT_PROVIDER;
}

/**
 * Gets the bot model ID from environment or returns default.
 */
export function getBotModelId(env = process.env): string {
    return env.BOT_MODEL_ID ?? DEFAULT_BOT_MODEL_ID;
}

function parsePositiveIntegerEnv(name: string, rawValue: string): number {
    const value = Number.parseInt(rawValue, 10);
    if (!Number.isInteger(value) || value <= 0) {
        throw new Error(`Invalid ${name}: ${rawValue}`);
    }

    return value;
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
    return parsePositiveIntegerEnv("SIMPLEX_PORT", env.SIMPLEX_PORT ?? String(DEFAULT_SIMPLEX_PORT));
}

/**
 * Gets the HTTP port from environment or returns default.
 */
export function getServerPort(env = process.env): number {
    return parsePositiveIntegerEnv("PORT", env.PORT ?? String(DEFAULT_SERVER_PORT));
}

/**
 * Gets the Pi agent script path from environment or returns default.
 */
export function getPiAgentScript(env = process.env): string {
    return env.PI_AGENT_SCRIPT ?? DEFAULT_PI_AGENT_SCRIPT;
}

/**
 * Gets the Pi provider from environment or returns default.
 */
export function getPiProvider(env = process.env): string {
    return env.PI_PROVIDER ?? DEFAULT_PI_PROVIDER;
}

/**
 * Gets the Pi model ID from environment or returns default.
 */
export function getPiModelId(env = process.env): string {
    return env.PI_MODEL_ID ?? DEFAULT_PI_MODEL_ID;
}
