# Production smoke test

This repository includes one operator command for the live Railway production deployment:

```bash
bun run smoke:prod
```

## What it checks

The smoke test runs one end-to-end production check against the live bot:

1. Fetch `GET /health` from the production Railway URL and require the body to be `ok`.
2. Fetch `GET /automation/status` and read the live bot's `simplexAddress`.
3. Start a fresh temporary local `simplex-chat` instance with isolated state.
4. Create or load a fresh temporary local SimpleX identity for that isolated state.
5. Connect that temporary user to the live production bot over SimpleX.
6. Send one real prompt:
   - `What is 5!? Return only the integer.`
7. Capture the raw bot reply.
8. Ask the LLM judge for a `pass` or `fail` verdict.
9. Exit non-zero on any infrastructure, transport, or judge failure.
10. Attempt cleanup even when the run fails.

## Prerequisites

### 1. Production must expose `/automation/status`

The smoke test depends on the production deployment serving:

- `GET /health`
- `GET /automation/status`

If `/automation/status` returns `404`, the running Railway deployment has not been updated to a build that includes the automation status endpoint yet.

### 2. Install the SimpleX terminal CLI locally

The smoke runner starts a local `simplex-chat` process.

Default behavior:
- it looks for `simplex-chat` on `PATH`

Optional override:
- set `SIMPLEX_CHAT_BIN` to an explicit executable path

Official install docs:
- SimpleX CLI: https://simplex.chat/docs/cli.html
- Stable install script: https://raw.githubusercontent.com/simplex-chat/simplex-chat/stable/install.sh

Example override:

```bash
export SIMPLEX_CHAT_BIN="$HOME/.local/bin/simplex-chat"
```

### 3. Provide judge credentials

By default the smoke test uses:

```text
github-copilot/gpt-4.1 
```

That default works with the standard `pi-ai` GitHub Copilot environment variables:

- `GITHUB_TOKEN`
- `GH_TOKEN`
- `COPILOT_GITHUB_TOKEN`

You can override the judge model with `SMOKE_JUDGE_MODEL` if you want to use another supported provider/model pair.

Examples:

```bash
export SMOKE_JUDGE_MODEL=github-copilot/gpt-4.1 
```

## Environment variables

### `SMOKE_PROD_BASE_URL`
Optional.

Defaults to the current Railway production URL:

```text
https://chronocrystal-pi-production-db31.up.railway.app
```

Override it only if production moves to a different public URL.

Example:

```bash
export SMOKE_PROD_BASE_URL=https://chronocrystal-pi-production-db31.up.railway.app
```

### `SMOKE_JUDGE_MODEL`
Optional.

Defaults to:

```text
github-copilot/gpt-4.1
```

Use a different provider/model only if the matching provider credentials are already present in your shell.

### `SIMPLEX_CHAT_BIN`
Optional.

Set this when `simplex-chat` is not already on `PATH`.

## Run it

From the repository root:

```bash
bun run smoke:prod
```

## Expected success behavior

A successful run will:

- confirm `/health` returns `ok`
- read the live bot address from `/automation/status`
- start a temporary local SimpleX instance
- connect to the production bot over SimpleX
- send the real smoke prompt
- log the raw reply
- log the judge verdict
- exit with status `0`

## Troubleshooting

### `/automation/status` returns 404

The running production deployment does not include the automation status endpoint yet. Deploy the current code before retrying the smoke test.

### `simplex-chat binary not found on PATH`

Install the SimpleX terminal CLI or set `SIMPLEX_CHAT_BIN`.

### Judge authentication fails

The selected judge provider is missing credentials in the local shell. Either:

- export the required provider credential for `SMOKE_JUDGE_MODEL`, or
- switch `SMOKE_JUDGE_MODEL` to a provider you already have credentials for

### The smoke run connects but fails the judge

Inspect the logged:

- prompt
- raw reply
- rubric
- judge verdict

Transport failures fail before the judge runs. Judge failures mean the bot replied, but the reply did not satisfy the semantic rubric.

## Related docs

- Railway variables reference: https://docs.railway.com/reference/variables
- Railway public networking: https://docs.railway.com/public-networking
- SimpleX terminal CLI: https://simplex.chat/docs/cli.html
