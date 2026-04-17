#!/usr/bin/env bun
/**
 * Railway deployment script with health check verification.
 *
 * Usage:
 *   bun run scripts/deploy.ts                 # Deploy and wait for health
 *   bun run scripts/deploy.ts --check-only    # Only check health without deploy
 *   bun run scripts/deploy.ts --timeout 120   # Custom timeout in seconds
 */

import { parseArgs } from "util";
import { exec } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);

const DEFAULT_BASE_URL = "https://chronocrystal-pi-production-db31.up.railway.app";
const HEALTH_PATH = "/health";
const POLL_INTERVAL_MS = 5000;

interface DeployOptions {
  checkOnly: boolean;
  timeout: number;
  baseUrl: string;
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function checkHealth(baseUrl: string): Promise<boolean> {
  try {
    const response = await fetch(`${baseUrl}${HEALTH_PATH}`);
    return response.ok;
  } catch {
    return false;
  }
}

async function waitForHealth(baseUrl: string, timeoutSeconds: number): Promise<boolean> {
  const startTime = Date.now();
  const timeoutMs = timeoutSeconds * 1000;

  console.log(`Waiting for ${baseUrl}${HEALTH_PATH} to become healthy...`);

  while (Date.now() - startTime < timeoutMs) {
    if (await checkHealth(baseUrl)) {
      console.log("Health check passed!");
      return true;
    }
    await sleep(POLL_INTERVAL_MS);
  }

  console.error(`Health check timed out after ${timeoutSeconds} seconds`);
  return false;
}

async function getRailwayDeploymentUrl(): Promise<string | null> {
  try {
    const { stdout } = await execAsync("railway status --json", { timeout: 30000 });
    const status = JSON.parse(stdout);
    return status.deployment?.url ?? null;
  } catch {
    return null;
  }
}

async function deploy(): Promise<void> {
  console.log("Building project...");
  await execAsync("bun run build", { cwd: process.cwd() });

  console.log("Deploying to Railway...");
  const { stdout } = await execAsync("railway up --detach", { timeout: 120000 });
  console.log("Deployment triggered:", stdout.trim());

  console.log("Waiting for deployment to complete...");
  await execAsync("railway logs --follow", { timeout: 300000 });
}

async function main() {
  const { values } = parseArgs({
    options: {
      "check-only": { type: "boolean", default: false },
      timeout: { type: "string", default: "120" },
      "base-url": { type: "string", default: DEFAULT_BASE_URL },
      help: { type: "boolean", default: false },
    },
  });

  const options: DeployOptions = {
    checkOnly: values["check-only"] ?? false,
    timeout: parseInt(values.timeout as string, 10),
    baseUrl: values["base-url"] as string ?? DEFAULT_BASE_URL,
  };

  if (values.help) {
    console.log(`
Railway Deploy Script

Options:
  --check-only     Only check health without deploying
  --timeout N      Timeout in seconds (default: 120)
  --base-url URL   Override the base URL to check
  --help           Show this help
    `);
    return;
  }

  if (!options.checkOnly) {
    await deploy();
  }

  const healthy = await waitForHealth(options.baseUrl, options.timeout);

  if (healthy) {
    console.log(`\nDeployment successful: ${options.baseUrl}`);
    process.exit(0);
  } else {
    console.error("\nDeployment health check failed");
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Deploy script failed:", err);
  process.exit(1);
});
