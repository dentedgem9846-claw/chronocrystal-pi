# chronocrystal-pi

ChronoCrystal is a SimpleX bot backed by the Pi coding agent. It exposes a small HTTP surface for Railway health checks and a QR page for connecting clients.

## Requirements

- Bun 1.3.12
- A reachable `simplex-chat` server
- Credentials for the configured model provider

## Environment

The bot reads these variables at startup:

- `BOT_DISPLAY_NAME` — defaults to `ChronoCrystal`
- `BOT_MODEL` — defaults to `github-copilot/minimax-m2.5`
- `SIMPLEX_HOST` — defaults to `127.0.0.1`
- `SIMPLEX_PORT` — defaults to `5225`; must be digits only and between `1` and `65535`
- `PORT` / `BUN_HTTP_PORT` — HTTP port for Railway or local hosting; defaults to `8080`

## Local development

Install dependencies:

```bash
bun install
```

Run checks:

```bash
bun run check
bun test
```

Run the bot locally:

```bash
bun run start
```

Build the production binary:

```bash
bun run build
```

## HTTP endpoints

- `GET /health` — returns `503 {"status":"starting"}` until the bot is connected to SimpleX, then `200 {"status":"ok"}`
- `GET /` — embedded dashboard
- `GET /qr` — QR page for the active bot address

## Container image

The Docker build uses:

- `oven/bun:1.3.12` for the build stage
- a checksum-verified `simplex-chat` binary download
- a non-root `debian:bookworm-slim` runtime image

Build locally with:

```bash
docker build -t chronocrystal-pi .
```

## Deployment

GitHub Actions verifies the repository on every push and pull request. Non-`main` pushes can deploy previews to Railway; pushes to `main` deploy production.

See [`DEPLOY.md`](./DEPLOY.md) for the Railway setup, required GitHub secrets and variables, health checks, monitoring, and rollback steps.
