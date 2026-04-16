# Deployment

This application is deployed to Railway with the Railway CLI.

## Current Railway target

- Project: `chronocrystal-pi-new`
- Environment: `production`
- Service: `chronocrystal-pi`
- Build config: `railway.json` uses the repository `Dockerfile`
- Health check: `GET /health`

## Prerequisites

- Railway CLI installed
- Logged into Railway
- Repository linked to the correct project/service
- A valid `GITHUB_TOKEN` available in the local shell environment before every deploy

Check the current link:

```bash
railway whoami
railway status
```

## Critical token rule

Always check `GITHUB_TOKEN` before deploying.

The GitHub token can be rotated at any time. Do not assume the Railway variable is still current just because a previous deploy worked.

Before every deploy:

1. Confirm the local shell has the new token.
2. Update the Railway `GITHUB_TOKEN` variable from the local environment.
3. Redeploy or deploy again so the running container picks up the new token.

Recommended update command:

```bash
printf %s "$GITHUB_TOKEN" | railway variable set GITHUB_TOKEN --stdin --skip-deploys
```

Optional verification without printing the secret itself:

```bash
local_hash=$(printf %s "$GITHUB_TOKEN" | sha256sum | cut -d' ' -f1)
railway_hash=$(railway run sh -lc 'printf %s "$GITHUB_TOKEN" | sha256sum | cut -d" " -f1')
printf 'LOCAL_HASH %s\n' "$local_hash"
printf 'RAILWAY_HASH %s\n' "$railway_hash"
```

The hashes must match.

## Deploy

Run a deploy from the repository root:

```bash
railway up --verbose
```

If only environment variables changed and code did not, redeploy the latest build:

```bash
railway redeploy --yes
```

## Verify

Check deployment status:

```bash
railway deployment list
```

Inspect logs if needed:

```bash
railway logs --build --latest
railway logs --deployment --latest
```

Verify the public service:

```bash
curl -fsS https://chronocrystal-pi-production-db31.up.railway.app/health
```

Expected result:

```text
ok
```

The root page should also load and display the current SimpleX address QR page.

## Notes specific to this app

- The app must listen on Railway's injected `PORT` environment variable.
- Local fallback remains `8080`.
- Railway still mounts the persistent volume at `/app/state`.
- The entrypoint refreshes `/app/state/data` from the image's `/app/data-seed` on startup, then runs the Bun app with cwd `/app/state/data` so Pi auto-discovers `.pi/SYSTEM.md` there.
- SimpleX state is stored separately at `/app/state/simplex`.
- The container entrypoint starts `simplex-chat`, waits for it to become ready, then starts the Bun app.
