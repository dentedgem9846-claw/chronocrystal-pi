# AGENTS.md

## Commands Reference

| Command | Purpose |
|---|---|
| `bun run check` | Type-check and lint |
| `bun run test` | Unit tests |
| `bun run smoke:prod` | Smoke tests against production server |

## Verification

- After any changes: `bun run check`
- After big changes: `bun run smoke:prod` (see `smoketest.md`)

## Code Style

### TypeScript

- **No `any`** unless absolutely necessary.
- **No `ReturnType<>`** — use actual type names or define a named alias.
- **No inline imports** — no `await import("./foo.js")`, no `import("pkg").Type` in type positions. Always use standard top-level imports.
- **`Promise.withResolvers()`** over `new Promise((resolve, reject) => ...)` — cleaner, properly typed.

### Bun API

- **File I/O**: Prefer `Bun.file()` / `Bun.write()` over `node:fs/promises`. `Bun.write` auto-creates parent dirs — no redundant `mkdir` before write.
- **Process execution**: Prefer Bun Shell (`$\`cmd\``) for simple commands, `Bun.spawn` only for long-running/streaming processes.
- **Sleep**: `await Bun.sleep(ms)` instead of `new Promise(resolve => setTimeout(resolve, ms))`.
- **Node imports**: Namespace imports (`import * as fs from "node:fs/promises"`) — no named imports from `node:*`.
- **Anti-patterns**: No `existsSync`/`readFileSync` in async code. No `Buffer.from(await Bun.file(x).arrayBuffer())` — use `fs.readFile`. No existence check before read — use try-catch with `isEnoent`.
- **JSON5/JSONL**: `Bun.JSON5.parse()`, `Bun.JSONL.parse()` instead of external deps or manual split+parse.

### Code Quality

- No emojis in commits, issues, or code.
- No fluff or filler text in comments or prose.
- **NEVER** remove or downgrade code to fix type errors — upgrade deps instead.
- Always ask before removing functionality that appears intentional.
- Do not parallelize. Do not call subagents. Do all the task yourself.

## Testing

- Test the contract, not implementation details.
- No placeholder tests or tautologies (`expect(true).toBe(true)`, `not.toThrow()`).
- No `mock.module()` — it leaks across test files in Bun.
- Tests must be full-suite safe, not just file-local safe.
- Do not add tests for tiny low-risk changes unless they protect a real contract.

## AI-Friendly Codebase

These practices help both AI agents and human reviewers understand the code:

### Keep Files Short and Focused

One responsibility per file. Classes should do one thing. This helps AI provide relevant, targeted suggestions.

### Embrace Predictable Patterns

Consistent structure makes intent obvious. Follow the same patterns across similar files — same method order, same error handling shape, same return types.

### Clear Naming Over Clever Naming

Use descriptive names that explain purpose. No abbreviations (`hndl`, `val`, `proc`), no implicit meaning. The name should tell you what the thing does.

```typescript
// Avoid
hndl(Request $r)

// Prefer
executeUserCreation(request: Request)
```

### Explicit Over Implicit

No hidden side effects. State changes must be obvious and traceable. Avoid methods that silently modify shared state or have invisible dependencies.

### Strategic Documentation

Document "why" not "what". Comments should explain intent, constraints, and context — not restate what the code already says.

```typescript
// Avoid
// Gets the user
function getUser(id: string) {}

// Prefer
/**
 * Retrieves user with profile for GDPR data access compliance.
 * @throws UserNotFoundError when user does not exist
 */
function getUser(id: string): User {}
```

### Embrace Type Safety

Use interfaces and type hints. AI understands data shapes better when types are explicit. Prefer named types over loose objects.

```typescript
// Avoid
function processData($data)  // what shape is $data?

// Prefer
interface ProcessableData { getType(): string }
function processData(data: ProcessableData)
```

## Committing

DO NOT COMMIT unless the user explicitly says to commit.
