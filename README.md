# ChronoCrystal

ChronoCrystal is a SimpleX chat bot powered by a Pi coding agent. Users message the bot over SimpleX; ChronoCrystal processes each message with the Kawa agent and delegates complex work to a background Pi subprocess.

## Architecture

```
User --SimpleX--> simplex-chat --WebSocket--> ChronoCrystal
                                                    |
                                          Kawa (main agent session) 
                                          send_message (to SimpleX)
                                          spawn_agent() --> Pi (background subprocess)
                                                           |
                                                           PiWorker
                                                           |
                                              Pi-agent-cli.ts
                                              - coding tools
                                              - wiki tools (list/get/set tiddlers)
                                        
```

### Agents

**Kawa** is the primary agent session. It owns the conversation with the user and decides when to delegate work.

Tools available to Kawa:

| Tool | Description |
|---|---|
| `spawn_agent` | Start a Pi background task for complex coding, wiki, or research work |
| `inspect_agent` | Read the live transcript and tool state of the running Pi task |
| `send_message` | Log a debug message (not sent to the user) |

**Pi** is a background coding agent spawned via `PiWorker`. It runs as a subprocess executing `src/pi-agent-cli.ts`.

Tools available to Pi:

| Tool | Description |
|---|---|
| Coding tools | `bash`, `read`, `write`, `edit`, `grep`, `find`, and more via `@mariozechner/pi-coding-agent` |
| `list_wiki_tiddlers` | List KawaWiki pages by title or tag |
| `get_wiki_tiddler` | Read one KawaWiki tiddler by exact title |
| `set_wiki_tiddler` | Create or update a KawaWiki tiddler |
| `send_message` | Send a SimpleX message directly to the user |

Pi communicates with the parent process via JSON events written to stdout (`PiWorkerEvent` types: `session_event`, `outbound_message`, `done`, `error`). These events are streamed into the Kawa chat session so the user sees tool-level progress in real time.

### Transport

ChronoCrystal connects to a local [simplex-chat](https://github.com/simplex-chat/simplex-chat) instance over WebSocket. The bot creates a SimpleX address and auto-accepts contact requests. Users add the address in their SimpleX client to start a conversation.

### KawaWiki

A server-backed [TiddlyWiki](https://tiddlywiki.com/) instance is started as a child process. The HTTP server proxies requests at `/wiki/*` to it. Pi can read and write wiki pages via its `get_wiki_tiddler` / `set_wiki_tiddler` tools.

### HTTP Server

The HTTP server exposes:

| Route | Description |
|---|---|
| `GET /` | QR code page showing the bot's SimpleX address |
| `GET /health` | Health check — returns `ok` |
| `GET /automation/status` | JSON with SimpleX address and deployment info |
| `GET /wiki/*` | Proxy to KawaWiki (TiddlyWiki) |

## Message Flow

1. User sends a message via SimpleX client.
2. `SimplexBridge` receives the message and yields `{ chatId, message }`.
3. A `ChatSessionState` is created (or retrieved) for the chat ID — each chat has an independent Kawa session.
4. Kawa receives the message via `session.prompt()`.
5. If the task is complex, Kawa calls `spawn_agent` to start Pi in the background.
6. Pi runs as a subprocess (`pi-agent-cli.ts`). Tool calls stream back as JSON events on stdout.
7. Kawa relays Pi events into the chat session so the user sees live progress.
8. When Pi finishes, Kawa sends the final response back over SimpleX.

## Configuration

| Variable | Default | Description |
|---|---|---|
| `BOT_DISPLAY_NAME` | `ChronoCrystal` | SimpleX display name for the bot user |
| `BOT_PROVIDER` | `github-copilot` | AI provider for Kawa |
| `BOT_MODEL_ID` | `minimax-m2.5` | Model ID for Kawa |
| `SIMPLEX_HOST` | `127.0.0.1` | Host where simplex-chat is running |
| `SIMPLEX_PORT` | `5225` | WebSocket port for simplex-chat |
| `PORT` | `8080` | HTTP server port ( Railway sets this dynamically) |
| `PI_PROVIDER` | `github-copilot` | AI provider for Pi |
| `PI_MODEL_ID` | `minimax-m2.5` | Model ID for Pi |

`GITHUB_TOKEN` is required for GitHub Copilot provider access.

## Running Locally

### Prerequisites

- [Bun](https://bun.sh) installed
- [simplex-chat](https://github.com/simplex-chat/simplex-chat) installed and available on `$PATH`

### Setup

1. Start simplex-chat in terminal mode or daemon mode. Daemon mode example:

   ```bash
   simplex-chat --daemon --port 5225
   ```

   For terminal mode (interactive), start it separately and keep it running.

2. Set environment variables:

   ```bash
   export GITHUB_TOKEN=your_token_here
   export BOT_PROVIDER=github-copilot
   export BOT_MODEL_ID=minimax-m2.5
   export PI_PROVIDER=github-copilot
   export PI_MODEL_ID=minimax-m2.5
   export SIMPLEX_HOST=127.0.0.1
   export SIMPLEX_PORT=5225
   ```

3. Install dependencies and start:

   ```bash
   bun install
   bun run start
   ```

4. Open the root page (`http://localhost:8080`) to see the QR code with the bot's SimpleX address. Scan it or copy the address into your SimpleX client to start chatting.

## Deploying

Deployed on Railway using the Railway CLI.

### Deploy

```bash
railway up --verbose
```

If only environment variables changed and code did not:

```bash
railway redeploy --yes
```

### Token Rotation

Before every deploy, verify `GITHUB_TOKEN` is current:

```bash
printf %s "$GITHUB_TOKEN" | railway variable set GITHUB_TOKEN --stdin --skip-deploys
```

Verify the hash matches locally:

```bash
local_hash=$(printf %s "$GITHUB_TOKEN" | sha256sum | cut -d' ' -f1)
railway_hash=$(railway run sh -lc 'printf %s "$GITHUB_TOKEN" | sha256sum | cut -d" " -f1')
```

### Verify

```bash
curl -fsS https://chronocrystal-pi-production-db31.up.railway.app/health
# expected: ok
```

## Testing

```bash
# Type check and lint
bun run check

# Unit tests
bun run test

# Smoke test against production
bun run smoke:prod
```

Set `SMOKE_PROD_BASE_URL` to override the production endpoint during smoke testing.

## References

- [oh-my-pi](https://github.com/can1357/oh-my-pi) — Pi agent harness
- [@mariozechner/pi-mom](https://www.npmjs.com/package/@mariozechner/pi-mom) — Agent personality and memory
- [simplex-chat](https://github.com/simplex-chat/simplex-chat) — Private messenger and transport layer
