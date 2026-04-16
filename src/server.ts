import QRCode from "qrcode";
import pino from "pino";

import { getServerPort } from "./config.js";

const log = pino({ name: "server" });

function escapeHtml(value: string): string {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#39;");
}

function buildAutomationStatus(address: string, requestUrl: URL, env = process.env) {
	return {
		ok: true,
		simplexAddress: address,
		environment: env.RAILWAY_ENVIRONMENT_NAME ?? "local",
		service: env.RAILWAY_SERVICE_NAME ?? "chronocrystal-pi",
		publicDomain: env.RAILWAY_PUBLIC_DOMAIN ?? requestUrl.hostname,
	};
}

export async function startServer(address: string): Promise<void> {
	const port = getServerPort();
	const qrSvg = await QRCode.toString(address, { type: "svg" });
	const escapedAddress = escapeHtml(address);
	const html = `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="utf-8">
	<meta name="viewport" content="width=device-width, initial-scale=1">
	<title>ChronoCrystal</title>
	<style>
		body {
			font-family: system-ui, sans-serif;
			max-width: 40rem;
			margin: 0 auto;
			padding: 2rem 1rem;
			text-align: center;
		}

		main {
			display: grid;
			gap: 1rem;
		}

		address {
			font-style: normal;
			word-break: break-all;
		}

		svg {
			max-width: 20rem;
			height: auto;
			margin: 0 auto;
		}
	</style>
</head>
<body>
	<main>
		<h1>ChronoCrystal</h1>
		<p>Scan the QR code or copy the SimpleX chat address below.</p>
		${qrSvg}
		<address>${escapedAddress}</address>
	</main>
</body>
</html>`;

	const server = Bun.serve({
		port,
		fetch(request) {
			const url = new URL(request.url);

			if (request.method === "GET" && url.pathname === "/health") {
				return new Response("ok", {
					status: 200,
					headers: { "Content-Type": "text/plain; charset=utf-8" },
				});
			}

			if (request.method === "GET" && url.pathname === "/automation/status") {
				return Response.json(buildAutomationStatus(address, url), {
					status: 200,
					headers: { "Cache-Control": "no-store" },
				});
			}


			if (request.method === "GET" && url.pathname === "/") {
				return new Response(html, {
					status: 200,
					headers: { "Content-Type": "text/html; charset=utf-8" },
				});
			}

			return new Response("not found", {
				status: 404,
				headers: { "Content-Type": "text/plain; charset=utf-8" },
			});
		},
	});

	log.info({ port: server.port }, "http server started");
}
