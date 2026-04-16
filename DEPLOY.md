# Deployment runbook

## CI/CD overview

The repository uses `.github/workflows/ci.yml`.

Workflow behavior:

- Every push and pull request runs `bun run check`, `bun test`, and `docker build`.
- Pushes to non-`main` branches attempt a Railway preview deploy.
- Pushes to `main` attempt a Railway production deploy, poll the configured health endpoint, and tail Railway logs for 10 minutes.

The workflow uses the official Railway CLI container (`ghcr.io/railwayapp/cli:latest`) and passes the GitHub secret `RAILWAY_API_KEY` into the CLI as `RAILWAY_TOKEN`.

## Required GitHub secret

Create this repository secret before expecting deployments to run:

- `RAILWAY_API_KEY` — a Railway project token scoped to the target environment

Without it, deploy and log-tail jobs exit early with a notice.

## Recommended GitHub repository variables

Set these repository variables to make deploy jobs deterministic:

Shared:

- `RAILWAY_SERVICE` — default Railway service name or ID
- `RAILWAY_PROJECT_ID` — required only when deploying by project ID instead of a linked/default project

Preview:

- `RAILWAY_PREVIEW_SERVICE` — optional override for preview deploys
- `RAILWAY_PREVIEW_ENVIRONMENT` — optional preview environment name; required when `RAILWAY_PROJECT_ID` is set
- `RAILWAY_PREVIEW_HEALTHCHECK_URL` — preview URL ending in `/health` for automated smoke checks

Production:

- `RAILWAY_PRODUCTION_SERVICE` — optional override for production deploys
- `RAILWAY_PRODUCTION_ENVIRONMENT` — optional production environment name; required when `RAILWAY_PROJECT_ID` is set
- `RAILWAY_PRODUCTION_HEALTHCHECK_URL` — production URL ending in `/health` for automated smoke checks

If the Railway project contains multiple services, set the service-specific variables instead of relying on discovery.

## Health checks

`railway.toml` configures:

- `healthcheckPath = "/health"`
- `healthcheckTimeout = 120`

Expected behavior:

- `GET /health` returns `503 {"status":"starting"}` until the bot has connected to SimpleX
- `GET /health` returns `200 {"status":"ok"}` once the bot is ready

Railway health checks originate from `healthcheck.railway.app`. The current app does not filter by hostname, so no additional allowlisting is required.

## Manual verification

Preview or production health:

```bash
curl --fail "$RAILWAY_PREVIEW_HEALTHCHECK_URL"
curl --fail "$RAILWAY_PRODUCTION_HEALTHCHECK_URL"
```

Production logs for 10 minutes:

```bash
timeout 600 railway logs --service "$RAILWAY_SERVICE" --environment "$RAILWAY_PRODUCTION_ENVIRONMENT"
```

If you use the service-specific production variable, substitute `RAILWAY_PRODUCTION_SERVICE`.

The CI workflow treats these patterns as suspicious during the 10-minute tail:

- `fatal`
- `uncaught`
- `listener error`
- `reply failed`
- `live message failed`
- `startup failed`
- `chatCmdError`

## Rollback

Preferred rollback paths:

1. Railway UI: open the service deployment history, choose the previous successful deployment, and use **Rollback**.
2. Git: revert the bad merge on `main` and let CI deploy the reverted code.
3. Railway CLI: use `railway redeploy --service <service>` when you need to restart the latest successful deployment without uploading new code.

Notes:

- Railway UI rollback restores both the previous image and the custom variables associated with that deployment.
- `railway redeploy` does not roll back to an older image; it only re-runs the latest deployment.

## Local preflight before merging

Run the same checks CI expects:

```bash
bun run check
bun test
docker build -t chronocrystal-pi .
```
