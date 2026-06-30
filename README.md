# AI Agent Dashboard

AI Agent Dashboard is a local web UI for monitoring and nudging multiple CLI coding agents from one place.

It currently supports OpenCode, Claude, Codex, and Gemini sessions, with status detection, short task summaries, and configurable notifications.

## Features

- Unified dashboard for active agent sessions across providers.
- Status tracking (`working`, `blocked`, `complete`, `idle`) with per-agent heuristics.
- Short LLM-generated session summaries with automatic fallback when the LLM is unavailable.
- Send follow-up input to blocked sessions when the transport is available (OpenCode API or PTY).
- Settings UI for LLM endpoint/model, polling interval, notification sounds, and password setup.
- Optional sound and skill notifications when sessions move to `blocked` or `complete`.

## Tech Stack

- SvelteKit 2
- Svelte 5
- TypeScript (strict)
- Vite 6
- Node runtime via `@sveltejs/adapter-node`

## Requirements

- Node.js (recommended: current LTS)
- npm
- Linux is the primary target (process/PTY discovery uses `/proc` and `pgrep`)
- Optional:
  - `openssl` for local TLS certificate generation
  - `paplay`, `pw-play`, or `aplay` for notification sounds on Linux
  - `bun` if you want to use `scripts/start-dashboard.sh`

## Quick Start

```bash
npm install
npm run dev
```

Then open `http://localhost:35001`.

On first run, the app creates config/data directories under your XDG paths.

## Production Run

```bash
npm run build
npm run start
```

## Local HTTPS (self-signed)

```bash
npm run generate-certs
npm run build
npm run start:https
```

Or use the helper script:

```bash
bash scripts/start-dashboard.sh
```

## Configuration

The dashboard reads and writes `dashboard.toml`.

Default locations:

- Config dir: `${XDG_CONFIG_HOME:-~/.config}/ai-dashboard`
- Data dir: `${XDG_DATA_HOME:-~/.local/share}/ai-dashboard`
- Config file: `${XDG_CONFIG_HOME:-~/.config}/ai-dashboard/dashboard.toml`
- Sounds dir: `${XDG_DATA_HOME:-~/.local/share}/ai-dashboard/sounds`
- TLS cert/key defaults:
  - `${XDG_CONFIG_HOME:-~/.config}/ai-dashboard/cert.pem`
  - `${XDG_CONFIG_HOME:-~/.config}/ai-dashboard/key.pem`

Important defaults include:

- Server host/port: `0.0.0.0:35001`
- LLM endpoint/model for summaries
- Agent source paths (OpenCode DB/API, Claude history, Codex history, Gemini config path)

Most runtime settings can be changed in `/settings`.

## Authentication

- Auth is disabled when no password hash is configured.
- Set a password in **Settings -> Security**.
- Auth uses HTTP Basic.
- Default username is `admin` (can be changed in the config file).

## Agent Integrations

- **OpenCode**: prefers OpenCode API (`apiBase`) and falls back to SQLite (`dbPath`) if API is unavailable.
- **Claude**: reads local history JSONL and attempts PTY input for active processes.
- **Codex**: reads local history JSONL and attempts PTY input for active processes.
- **Gemini**: discovers active Gemini CLI processes and allows PTY input when possible.

## API Endpoints

- `GET /api/agents` - list sessions and status counts.
- `GET /api/agents/:id` - session details.
- `POST /api/agents/:id` - send message to session.
- `GET /api/config` - read dashboard settings.
- `PUT /api/config` - update dashboard settings.
- `GET /api/sounds` - list uploaded sound files.
- `POST /api/sounds` - upload a sound file.
- `POST /api/sounds/:filename` - test-play a sound file.
- `GET /api/events` - SSE stream for updates/transitions.
- `GET /api/status/diagnose` - structured dump of dashboard internal state (per-session status inference inputs/outputs, liveness decisions, process inventory) for debugging why a session shows a given status.

All API routes require auth when a password is configured.

## Development

```bash
npm run check
npm run build
```

Notes:

- No dedicated `lint` script is configured.
- No test runner is currently configured in this repository.

## Debugging Session Status

When a session shows an unexpected status (e.g. an `error` session that should be
`idle`/`blocked`, or a session that won't disappear), use the diagnostic dump
script to inspect the exact data the dashboard sees per session:

```bash
npm run dump:sessions                       # all sessions, human-readable
npm run dump:sessions -- --session <substr> # filter by id or title substring
npm run dump:sessions -- --json             # machine-readable (pipe to jq)
npm run dump:sessions -- --no-parts         # omit the raw-parts block
npm run dump:sessions -- --help
```

The script compiles and calls the **real** production session pipeline
(`getOpenCodeSessionsWithDiagnostics` in `src/lib/agents/opencode.ts`) — it does
not reimplement any status/liveness logic. For each session it prints the
identity, API signals, the exact inputs to status inference (`latestTool`,
`hasError`, `latestStepReason`, `sessionStatus`, the `inferenceInput` object),
the inferred status/phase, the liveness candidate + decision, and the recent
normalized parts. Output is also tee'd to `./logs/dump_sessions_<timestamp>.log`.

For example, an `error` session typically shows
`latestTool={tool:'submit_plan'|'question', status:'error', active:false}` with
`hasError=true` — an escaped plan/question prompt terminalizes the tool part to
`error`, and status inference latches `error` regardless of age.

The same per-session inference data is also available over HTTP from the
authenticated `GET /api/status/diagnose` endpoint (useful when you can't shell
into the host running the dashboard).

## Project Layout

- `src/routes` - dashboard pages and API routes
- `src/lib/agents` - per-agent ingestion and message send logic
- `src/lib/config.ts` - config load/save and XDG paths
- `src/lib/auth.ts` - basic auth + bcrypt password checks
- `src/lib/llm/summarizer.ts` - summary generation + fallback cache
- `src/lib/notifications` - sound + skill hooks on status transitions
- `scripts/` - local helper scripts (startup, cert generation, status debugging, tests)
