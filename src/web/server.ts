/**
 * Web Server - HTTP server with health check and QR code generation.
 */

import pino from "pino";
import QRCode from "qrcode";
import { botAddress } from "../bot.js";
import { EMBEDDED_DASHBOARD_HTML } from "./generated-dashboard.js";

const dashboardHtml = EMBEDDED_DASHBOARD_HTML;

const log = pino({ name: "web" });

const PORT = Number.parseInt(process.env.BUN_HTTP_PORT ?? "8080", 10) || 8080;

/**
 * Health check endpoint.
 */
function handleHealth(): Response {
	if (!botAddress) {
		return new Response(JSON.stringify({ status: "starting" }), {
			status: 503,
			headers: { "Content-Type": "application/json" },
		});
	}

	return new Response(JSON.stringify({ status: "ok" }), {
		status: 200,
		headers: { "Content-Type": "application/json" },
	});
}

/**
 * Serve the dashboard HTML.
 */
function handleDashboard(): Response {
	return new Response(dashboardHtml, {
		status: 200,
		headers: { "Content-Type": "text/html" },
	});
}

/**
 * Parse URL and route to appropriate handler.
 */
async function route(req: Request): Promise<Response> {
	const url = new URL(req.url);
	const path = url.pathname;
	const method = req.method;

	// Health check
	if (path === "/health" && method === "GET") {
		return handleHealth();
	}

	// Dashboard
	if (path === "/" && method === "GET") {
		return handleDashboard();
	}

	// QR code page showing SimpleX address for scanning
	if (path === "/qr" && method === "GET") {
		return await handleQrCode();
	}

	// 404 for unknown paths
	return new Response(JSON.stringify({ error: "Not Found" }), {
		status: 404,
		headers: { "Content-Type": "application/json" },
	});
}

/**
 * Generate QR code page with bot address.
 */
async function handleQrCode(): Promise<Response> {
	if (!botAddress) {
		return new Response(JSON.stringify({ error: "Bot address not ready yet" }), {
			status: 503,
			headers: { "Content-Type": "application/json" },
		});
	}

	// Generate QR code as PNG
	const qrCodeDataUrl = await QRCode.toDataURL(botAddress, {
		width: 300,
		margin: 2,
		color: {
			dark: "#000000",
			light: "#FFFFFF",
		},
	});

	const html = `<!DOCTYPE html>
<html>
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>ChronoCrystal - Scan to Connect</title>
    <style>
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            min-height: 100vh;
            margin: 0;
            background: #1a1a2e;
            color: #eee;
        }
        .container {
            text-align: center;
            padding: 2rem;
        }
        h1 {
            margin: 0 0 0.5rem 0;
            color: #fff;
        }
        .subtitle {
            color: #888;
            margin-bottom: 1.5rem;
        }
        .qr-code {
            background: white;
            padding: 1rem;
            border-radius: 8px;
            display: inline-block;
        }
        .qr-code img {
            display: block;
        }
        .address {
            margin-top: 1.5rem;
            padding: 1rem;
            background: #16213e;
            border-radius: 8px;
            font-family: monospace;
            font-size: 0.9rem;
            word-break: break-all;
            max-width: 400px;
            margin-left: auto;
            margin-right: auto;
        }
        .address-label {
            color: #888;
            font-size: 0.8rem;
            margin-bottom: 0.5rem;
        }
    </style>
</head>
<body>
    <div class="container">
        <h1>ChronoCrystal</h1>
        <p class="subtitle">Scan to connect to the bot</p>
        <div class="qr-code">
            <img src="${qrCodeDataUrl}" alt="QR Code" width="300" height="300">
        </div>
        <div class="address">
            <div class="address-label">Or copy this address:</div>
            ${botAddress}
        </div>
    </div>
</body>
</html>`;

	return new Response(html, {
		status: 200,
		headers: { "Content-Type": "text/html" },
	});
}

/**
 * Start the HTTP server.
 */
export function startHttpServer(): void {
	Bun.serve({
		port: PORT,
		fetch(req) {
			return route(req);
		},
	});

	log.info({ port: PORT }, "HTTP server started");
}

// Start server if run directly
if (import.meta.main) {
	startHttpServer();
}
