# start_test_dashboard.sh

Created `start_test_dashboard.sh` — a single-entry-point shell script that builds
the current branch's code and launches a test dashboard on a randomized free port
(>=50001), then prints a ctrl+clickable URL.

## What was created

- `start_test_dashboard.sh` at repo root (chmod +x)
- `README.md` updated with "Test Dashboard" subsection under Development
- `TODO.md` updated

## Key design decisions

- **HTTP not HTTPS**: avoids cert generation for short-lived test instances.
- **Isolated config/data by default**: `tmp/test-dashboard/` under the worktree;
  `--use-prod-config` opt-in to see real agent sessions.
- **`ss`-based port probing**: uses `ss -Hltn sport = :<port>` to check freeness,
  with `shuf` for random base port (falls back to `$RANDOM`).
- **adapter-node `HOST` env**: passed as `HOST=127.0.0.1`; if ignored by
  adapter-node, binding 0.0.0.0 on a random high port is still acceptable.
- **Port collision handling**: auto-increment on collision (200 attempts), with
  `TEST_DASHBOARD_PORT` override and `TEST_DASHBOARD_PORT_STRICT=1` strict mode.
- **Readiness probe handles auth**: curl without `-f` succeeds on any HTTP
  response (200, 401, etc.), with TCP-level fallback when curl is absent.

## Review findings addressed

Two review passes via code-review-principal:

### Pass 1 findings (all fixed):
- Readiness probe failed with auth (curl -fsS rejects 401) → switched to
  `curl -sS` without `-f`, TCP fallback for transport failures
- Unknown arguments silently ignored → added catch-all case with error
- No post-build validation → added `[ -f build/server.js ]` check
- No `--help` flag → added `-h`/`--help` with usage text
- `PORT="$PORT"` redundancy → simplified

### Pass 2 findings (all fixed):
- Double argument-parsing loop → consolidated into single pass
- Cleanup handler double-fires on Ctrl-C → added `_cleaned` guard flag
- `pick_port` uses `exit 1` instead of `return 1` → changed to `return 1`,
  caller uses `|| exit 1`
- `git` not in dependency check → added to `missing_deps` array

## Verification

- `bash -n start_test_dashboard.sh` — syntax clean
- `shellcheck start_test_dashboard.sh` — clean (0 issues)
- `npm run check` — pre-existing EROFS failure (unrelated to changes)
- `npm run build` — pre-existing EROFS failure (unrelated to changes)
