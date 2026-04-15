/**
 * ChronoCrystal - SimpleX bot powered by Pi agent.
 *
 * Entry point and re-exports for the bot application.
 */
import { startBot } from "./bot.js";

import pino from "pino";
import { getBotDisplayName, getBotModel, getSimplexHost, getSimplexPort } from "./config.js";

const log = pino({ name: "chronocrystal" });

try {
    await startBot({
        displayName: getBotDisplayName(),
        model: getBotModel(),
        simplexHost: getSimplexHost(),
        simplexPort: getSimplexPort(),
    })
} catch (err) {
    log.fatal({ err: err instanceof Error ? err.message : String(err) }, "startup failed");
    process.exit(1);
}