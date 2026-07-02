---
submitted-at: "2026-07-02T12:33:34.959Z"
title: "Start a Test Dashboard on a Random Port"
auto-captured: true
---
# Start a Test Dashboard on a Random Port

## Goal

Goal: Add a single entry-point shell script (`start_test_dashboard.sh`) that builds the current branch's code and launches a **test** dashboard on a randomized free port (>=50001), then prints a ctrl+clickable URL so the user can inspect changes before merging.

## Current State

- `package.json` scripts:
  - `dev` -> `vite dev --host 0.0.0.0 --port 35001` (hardcoded port)
  - `build` -> `vite build`
  - `start` -> `node build/server.js` (SvelteKit adapter-node; reads `process.env.PORT`, default 3000)
  - `start:https` -> `node scripts/server-https.js` (reads `env('PORT','35001')`)
- `scripts/start-dashboard.sh`: existing helper that installs deps, generates certs, builds, and runs `npm run start:https` on the fixed port 35001. No port negotiation.
- `restart_dashboard.sh`: rebuilds the **production** podman image and restarts the systemd service. Not relevant for test runs.
- `src/lib/config.ts`: config/data resolved via `XDG_CONFIG_HOME` / `XDG_DATA_HOME` (defaults `~/.config/ai-dashboard`, `~/.local/share/ai-dashboard`).
- `vite.config.ts`: hardcoded `server.port`/`preview.port` = 35001 (dev/preview only; does not affect `npm run start`).
- Tooling available: `node`, `npm`, `ss` (iproute), `bash`.

## Assumptions

- adapter-node's `build/server.js` honors `PORT` env var (SvelteKit documented behavior; same mechanism already used by `scripts/server-https.js` via `env('PORT', ...)`).
- HTTP (not HTTPS) is acceptable for a local, short-lived test instance. This avoids requiring cert generation and matches `npm run start`.
- The user wants to test the **built** artifact (faithful to production) rather than the vite dev server.
- Isolating config/data by default is preferable; the user can opt into the real production config to see live agent sessions.

## Recommended Plan

Create one new file: `start_test_dashboard.sh` at the project root. No source/config changes required.

### Step 1 — Create `start_test_dashboard.sh`

A bash script (`set -euo pipefail`) at repo root. Behavior:

1. **Resolve project dir** via `BASH_SOURCE` (mirror `scripts/start-dashboard.sh` pattern, but live at root).
2. **Log setup** (repo style): `mkdir -p "$SCRIPT_DIR/logs"`, then
   `exec > >(tee -a "$LOG_FILE") 2>&1` where
   `LOG_FILE="$SCRIPT_DIR/logs/start_test_dashboard_$(date +%Y%m%d_%H%M%S).log"`.
3. **Print a banner** with:
   - current git branch (`git -C "$SCRIPT_DIR" rev-parse --abbrev-ref HEAD`, fallback `<unknown>`)
   - short commit SHA (`git -C "$SCRIPT_DIR" rev-parse --short HEAD`)
   - worktree path
4. **Dependency check**:
   - ensure `node`, `npm`, `ss` exist; exit 1 with a clear message if missing.
5. **Ensure deps**: if `node_modules/` is missing, run `npm install`.
6. **Build**: run `npm run build` (fails fast on TS/vite errors). This is the pre-merge verification step.
7. **Port selection** — `pick_port()`:
   - base = random in `[50001..59999]` via `shuf -i 50001-59999 -n 1` if available, else `$RANDOM` scaled.
   - probe with `ss -Hltn sport = :<p>`: a port is free if nothing listens on it (v4 or v6).
   - on collision, increment (wrap at 60000 back to 50001); cap attempts at 200; exit 1 with diagnostic if none free.
   - allow override via `TEST_DASHBOARD_PORT=<n>` env (still validated for freeness; if in use, fall through to auto-pick unless caller set `TEST_DASHBOARD_PORT_STRICT=1`).
8. **Config/data isolation** (default):
   - `TEST_HOME="$SCRIPT_DIR/tmp/test-dashboard"`
   - export `XDG_CONFIG_HOME="$TEST_HOME/config"`
   - export `XDG_DATA_HOME="$TEST_HOME/data"`
   - `mkdir -p` both.
   - Opt out with `--use-prod-config` flag or `TEST_DASHBOARD_USE_PROD_CONFIG=1` env -> leave `XDG_*` untouched (so the test instance sees real agent sessions and existing auth). Print a warning when this mode is active because settings writes will hit the real config.
9. **Start server**:
   - `PORT="$port" HOST=127.0.0.1 node "$SCRIPT_DIR/build/server.js" &`
   - capture `SERVER_PID=$!`.
   - adapter-node binds `0.0.0.0` by default; we additionally pass `HOST=127.0.0.1` (adapter-node honors `HOST`); if `HOST` is ignored, binding 0.0.0.0 on a random high port is still acceptable for local testing.
10. **Wait for readiness**:
    - poll up to ~30s: confirm listener via `ss -Hltn sport = :<port>`, then optional `curl -fsS -o /dev/null http://127.0.0.1:<port>/` (fall back to `node -e` TCP probe if curl absent). Treat any HTTP response (incl. 401) as "up".
    - on timeout: kill `SERVER_PID`, tail the log, exit 1.
11. **Print result**:
    - blank line, then a clearly clickable line:
      `echo "Test dashboard ready: http://127.0.0.1:${port}"` (terminals ctrl+click bare URLs).
    - also print: branch/commit, PID, log file path, XDG mode (isolated vs prod), and how to stop (`kill $SERVER_PID` or Ctrl-C).
12. **Foreground + cleanup**:
    - `trap 'kill "$SERVER_PID" 2>/dev/null || true; echo "Stopped test dashboard (pid $SERVER_PID)"' INT TERM EXIT`
    - `wait "$SERVER_PID"` so the script stays in the foreground and Ctrl-C tears the server down cleanly (logs preserved).

### Step 2 — Make it executable

`chmod +x start_test_dashboard.sh`.

### Step 3 — Document in README

Add a short "Test Dashboard" subsection under `## Development` in `README.md` describing usage, defaults, and the `--use-prod-config` opt-in. ~10 lines.

### Step 4 — Track work (repo convention)

Per AGENTS.md, move the relevant TODO entry to DONE and write a `worklog/` summary once implemented.

## Validation Plan

After implementation, run from a clean checkout on a feature branch:

1. **Static**: `bash -n start_test_dashboard.sh` (syntax check).
2. **ShellCheck** (if available): `shellcheck start_test_dashboard.sh` — expect clean or only style SC notes.
3. **Real run**:
   - `./start_test_dashboard.sh` in one terminal; confirm:
     - banner shows correct branch + SHA
     - log file created under `./logs/`
     - a free port >=50001 is chosen and printed as `http://127.0.0.1:<port>`
     - `curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:<port>/` returns 200/302/401 (any HTTP response)
     - `ss -Hltn sport = :<port>` shows the listener while running
   - Ctrl-C the script; confirm the listener is gone and the log mentions "Stopped".
4. **Port collision**: start one instance, note its port `P`, then run
   `TEST_DASHBOARD_PORT=$P ./start_test_dashboard.sh` and confirm it picks a **different** free port (auto-fallback) rather than failing.
5. **Strict collision**: `TEST_DASHBOARD_PORT=$P TEST_DASHBOARD_PORT_STRICT=1 ./start_test_dashboard.sh` should exit non-zero with a clear "port in use" message.
6. **Prod-config opt-in**: `./start_test_dashboard.sh --use-prod-config` should NOT set `XDG_*`; confirm the instance sees existing sessions and the banner warns about this mode.
7. **Existing checks unaffected**: `npm run check` and `npm run build` still pass unmodified (no source touched).
8. **Production service untouched**: confirm `systemctl --user status ai-agent-dashboard.service` is not restarted and port 35001 is unaffected.

Pass criteria: all of the above produce the expected result. The script must not modify any source, package.json, or production config when run with defaults.

## Risks and Mitigations

- **adapter-node ignores `HOST` env**: minor; binding 0.0.0.0 on a random high port is still local-only in practice. Print `http://127.0.0.1:<port>` regardless; the URL works either way.
- **Port race**: another process grabs the port between `ss` check and server bind. Mitigation: rely on the server's own `EADDRINUSE` handling; if `node build/server.js` exits non-zero during the readiness wait, detect it, re-run `pick_port`, and retry once.
- **`$RANDOM` modulo bias / `shuf` absent**: low impact (skews starting port only). Accept either; freeness check correctness does not depend on uniformity.
- **Config isolation surprises the user** (empty dashboard, no auth): default is isolated AND the banner explains how to switch (`--use-prod-config`); README documents both.
- **Long-running build blocks the user**: acceptable; build is the point of pre-merge verification. Print progress lines (`Building...`) so the user sees activity.
- **Trapped EXIT kills the server even on success**: intended (foreground tool). The `kill` is idempotent and guarded.

## Open Questions

1. HTTP vs HTTPS for the test instance — plan assumes HTTP (simpler, no certs). Confirm OK, or should we reuse existing XDG certs via `npm run start:https`?
2. Default config mode: isolated vs production. Plan defaults to **isolated** with `--use-prod-config` opt-in. If you'd prefer the test instance to see real agent sessions by default, swap the default (one-line change).
3. Should the script run `npm run check` before building (slower but catches type errors pre-launch)? Plan currently only runs `npm run build`; `check` can be added behind a `--check` flag if desired.
