/**
 * ChronoCrystal - SimpleX bot powered by Pi agent.
 *
 * Entry point and re-exports for the bot application.
 */

import pino from "pino";
import { startBot } from "./bot.js";
import { getBotDisplayName, getBotModel, getSimplexHost, getSimplexPort } from "./config.js";
import { startHttpServer } from "./web/server.js";

const log = pino({ name: "chronocrystal" });

async function main() {
	startHttpServer();

	await startBot({
		displayName: getBotDisplayName(),
		model: getBotModel(),
		simplexHost: getSimplexHost(),
		simplexPort: getSimplexPort(),
	});

	throw new Error("bot stopped unexpectedly");
}

main().catch((err) => {
	log.fatal({ err: err instanceof Error ? err.message : String(err) }, "startup failed");
	process.exit(1);
});
