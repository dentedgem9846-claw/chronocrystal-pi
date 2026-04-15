/**
 * ChronoCrystal - SimpleX bot powered by Pi agent.
 *
 * Entry point and re-exports for the bot application.
 */
import { startBot } from "./bot.js";

import pino from "pino";

const log = pino({ name: "chronocrystal" });

try {
    await startBot()
} catch (err) {
    log.fatal({ err: err instanceof Error ? err.message : String(err) }, "startup failed");
    process.exit(1);
}