# AGENTS.md

Guidance for agentic coding assistants working in this repository.

## Project Snapshot

- App: AI Agent Dashboard
- Stack: SvelteKit 2 + Svelte 5 + TypeScript + Vite 6
- Runtime target: Node (via `@sveltejs/adapter-node`)
- Key backend integrations: local agent histories, OpenCode API/SQLite, local config files, basic auth
- Package manager in repo scripts: `npm`
- Optional local launcher script uses `bun`

## Repository Structure

- `src/routes`: SvelteKit pages and API endpoints
- `src/lib/agents`: per-agent session ingestion + message sending
- `src/lib/config.ts`: config load/save/merge and XDG paths
- `src/lib/auth.ts`: basic auth + bcrypt password hash checks
- `src/lib/llm/summarizer.ts`: LLM summary generation with cache/fallbacks
- `src/lib/notifications`: sound + skill hooks on status transitions
- `scripts/`: local shell helpers (`start-dashboard.sh`, cert generation)

## Install And Run

- Install deps: `npm install`
- Dev server: `npm run dev`
- Build production bundle: `npm run build`
- Preview production bundle: `npm run preview`
- Start built server (HTTP): `npm run start`
- Start built server (HTTPS): `npm run start:https`
- Generate local certs: `npm run generate-certs`
- One-shot local startup helper: `bash scripts/start-dashboard.sh`

## Build, Lint, And Test Commands

- Primary project check (type/svelte diagnostics): `npm run check`
- Build verification: `npm run build`
- There is no dedicated linter script (`lint`) configured in `package.json`.
- There is no test runner script (`test`) configured in `package.json`.

## Single-Test Guidance (Important)

- Current state: single-test execution is **not available** because no test framework is configured.
- Evidence:
  - no `test` script in `package.json`
  - no project-level Vitest/Jest/Playwright config files
  - no project test files outside `node_modules`
- If you add Vitest later, use:
  - run all: `npx vitest run`
  - run one file: `npx vitest run src/path/to/file.test.ts`
  - run one test name: `npx vitest run src/path/to/file.test.ts -t "test name"`

## Agent Workflow Expectations

- Prefer `npm run check` and `npm run build` after code changes.
- Always restart the dashboard service after making code or config changes.
- In this project, always run `./restart_dashboard.sh` after any change.
- If changing APIs, verify both route handlers and matching UI consumers.
- Keep edits small and consistent with existing file style.
- Do not introduce new tooling (eslint/prettier/test runner) unless explicitly requested.

## TypeScript And Svelte Standards

- TS config is strict (`"strict": true`).
- Keep exported function signatures explicit when useful for clarity.
- Prefer typed domain models/interfaces in `src/lib/agents/types.ts` style.
- Use Svelte 5 runes patterns already present (`$state`, `$effect`, `$props`).
- Serialize `Date` objects to ISO strings before returning JSON to clients.

## Import Conventions

- Use `import type` for type-only imports.
- In SvelteKit route files, prefer `$lib/...` aliases for internal modules.
- For Node built-ins, use `node:` specifiers (`node:fs`, `node:path`, etc.).
- Keep imports grouped logically:
  - framework/external packages
  - internal `$lib`/relative modules
  - type-only imports can be grouped at top or near related imports

## Formatting Conventions

- Use 2-space indentation.
- Use semicolons.
- Use single quotes for strings.
- Keep trailing commas in multiline arrays/objects/params where natural.
- Keep lines readable; avoid large inline expressions when a helper improves clarity.
- Match existing brace and spacing style in touched files.

## Naming Conventions

- `camelCase`: variables, functions, non-constant values.
- `PascalCase`: interfaces/types.
- `UPPER_SNAKE_CASE`: module-level constants (for config defaults/paths).
- Route and SvelteKit file naming must follow framework conventions (`+page.svelte`, `+server.ts`, etc.).
- Keep status/type unions narrow and explicit (e.g., `'working' | 'blocked' | 'complete' | 'idle'`).

## Error Handling Patterns

- Favor early returns for auth and validation failures.
- API endpoints should return structured JSON errors with status codes.
- Wrap external I/O (`fetch`, fs, child process) in `try/catch` where failure is expected.
- Log concise context for failures (`console.error('Context:', error)`).
- Provide safe fallbacks (e.g., summary fallback when LLM call fails).

## API Route Conventions

- Authenticate first when config has a password hash.
- Use `json(...)` responses for normal API payloads.
- Validate request body shape before acting.
- Return 400 for bad input, 404 for missing resources, 500 for execution failures.
- Keep handler functions short; extract shared logic to `src/lib`.

## Frontend Conventions

- Keep UI state local with Svelte runes unless shared state is necessary.
- Prefer derived display helpers (`formatTime`, `statusClass`, etc.) over in-template logic.
- Preserve mobile behavior (`@media` sections already exist in route styles).
- Reuse global CSS variables in `src/app.css`.

## Security And Safety Notes

- Auth uses HTTP Basic + bcrypt hash stored in config.
- Sanitize uploaded filenames before writing to disk.
- Be careful with shell execution paths and interpolation (`exec`, `execSync`).
- Avoid exposing absolute host paths in client-visible data unless necessary.

## Local Data And Config Paths

- Config dir: `${XDG_CONFIG_HOME:-~/.config}/ai-dashboard`
- Data dir: `${XDG_DATA_HOME:-~/.local/share}/ai-dashboard`
- Dashboard config file: `dashboard.toml`
- TLS certs generated by `scripts/generate-certs.sh`

## Cursor And Copilot Rules

- Checked for Cursor rules: `.cursor/rules/` and `.cursorrules` -> none found.
- Checked for Copilot instructions: `.github/copilot-instructions.md` -> none found.
- If these files are later added, treat them as high-priority repository instructions.

## Quick Pre-PR Checklist For Agents

- Run: `npm run check`
- Run: `npm run build`
- Confirm auth-sensitive routes still gate correctly.
- Confirm Svelte UI still renders dashboard + settings pages.
- Do not claim tests were run; no test suite exists yet unless you add one.

## TODO work
- Items to work on are available in TODO.md
- IMPORTANT: When you complete an item, ALWAYS move it under the # DONE heading with [x] marking it as completed.
- IMPORTANT: When you complete an item, ALWAYS move it under the # DONE heading with [x] marking it as completed.
