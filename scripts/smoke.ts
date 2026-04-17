#!/usr/bin/env bun
/**
 * Full smoke test pipeline: deploy to Railway and run production smoke tests.
 *
 * Usage:
 *   bun run scripts/smoke.ts                    # Deploy and run smoke tests
 *   bun run scripts/smoke.ts --check-only       # Only run smoke tests (already deployed)
 *   bun run scripts/smoke.ts --skip-deploy      # Skip deployment, only run smoke tests
 */

import { parseArgs } from "util";
import { exec } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);

const DEFAULT_BASE_URL = "https://chronocrystal-pi-production-db31.up.railway.app";
const HEALTH_PATH = "/health";
const DEPLOY_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
const HEALTH_CHECK_TIMEOUT_MS = 2 * 60 * 1000; // 2 minutes
const POLL_INTERVAL_MS = 5000;

interface SmokeOptions {
  checkOnly: boolean;
  skipDeploy: boolean;
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

async function waitForHealth(baseUrl: string): Promise<boolean> {
  const startTime = Date.now();

  console.log(`Waiting for ${baseUrl}${HEALTH_PATH} to become healthy...`);

  while (Date.now() - startTime < HEALTH_CHECK_TIMEOUT_MS) {
    if (await checkHealth(baseUrl)) {
      console.log("Health check passed!");
      return true;
    }
    await sleep(POLL_INTERVAL_MS);
  }

  console.error(`Health check timed out after ${HEALTH_CHECK_TIMEOUT_MS / 1000} seconds`);
  return false;
}

async function deploy(): Promise<void> {
  console.log("Building project...");
  await execAsync("bun run build", { cwd: process.cwd() });

  console.log("Deploying to Railway...");
  await execAsync("railway up --detach", { timeout: 60000 });

  console.log("Waiting for deployment to start...");
  await sleep(10000); // Give Railway time to start the deployment

  const healthy = await waitForHealth(DEFAULT_BASE_URL);
  if (!healthy) {
    throw new Error("Deployment health check failed");
  }

  console.log("Deployment successful!");
}

async function runSmokeTests(baseUrl: string): Promise<boolean> {
  console.log(`Running production smoke tests against ${baseUrl}...`);

  try {
    const { stdout, stderr } = await execAsync(
      `bun run test/smoke/prod.ts`,
      {
        cwd: process.cwd(),
        env: { ...process.env, SMOKE_PROD_BASE_URL: baseUrl },
        timeout: 300000, // 5 minute timeout for smoke tests
      }
    );

    console.log(stdout);
    if (stderr) {
      console.error(stderr);
    }

    console.log("Smoke tests passed!");
    return true;
  } catch (err: unknown) {
    const error = err as { stdout?: string; stderr?: string };
    console.error("Smoke tests failed:");
    console.error(error.stdout ?? "");
    console.error(error.stderr ?? "");
    return false;
  }
}

async function main() {
  const { values } = parseArgs({
    options: {
      "check-only": { type: "boolean", default: false },
      "skip-deploy": { type: "boolean", default: false },
      "base-url": { type: "string", default: DEFAULT_BASE_URL },
      help: { type: "boolean", default: false },
    },
  });

  const options: SmokeOptions = {
    checkOnly: values["check-only"] ?? false,
    skipDeploy: values["skip-deploy"] ?? false,
    baseUrl: values["base-url"] as string ?? DEFAULT_BASE_URL,
  };

  if (values.help) {
    console.log(`
Smoke Test Pipeline Script

Deploys to Railway and runs production smoke tests.

Options:
  --check-only     Only run smoke tests (assumes already deployed)
  --skip-deploy    Skip deployment, only run smoke tests
  --base-url URL   Override the base URL
  --help           Show this help
    `);
    return;
  }

  let success = true;

  if (!options.checkOnly && !options.skipDeploy) {
    await deploy();
  } else if (options.checkOnly || options.skipDeploy) {
    console.log("Skipping deployment...");
    if (options.checkOnly) {
      const healthy = await waitForHealth(options.baseUrl);
      if (!healthy) {
        console.error("Health check failed");
        process.exit(1);
      }
    }
  }

  success = await runSmokeTests(options.baseUrl);

  if (success) {
    console.log("\n=== SMOKE TEST PIPELINE PASSED ===");
    process.exit(0);
  } else {
    console.error("\n=== SMOKE TEST PIPELINE FAILED ===");
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Smoke test pipeline failed:", err);
  process.exit(1);
});
