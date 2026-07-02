# Code Review: `start_test_dashboard.sh`

## Verdict
**APPROVE** — with non-blocking improvements recommended.

## Summary
- Script is well-structured, readable, and achieves its stated goal cleanly.
- The failure modes (missing deps, build failure, port exhaustion, server crash) all produce clear error messages and non-zero exits.
- `shellcheck`-clean output confirms basic shell hygiene.
- One real edge-case gap in the readiness probe when auth is configured (`--use-prod-config` path). The remaining items are ergonomic nits.

## Blocking findings
None.

## Non-blocking findings

### [Major] Readiness probe fails when auth is configured
**File:** `start_test_dashboard.sh:141-152`

**Why this matters:** The README documents `--use-prod-config` to see live agent sessions. When production auth is configured, `curl -fsS` returns exit code 22 (HTTP 401 Unauthorized), which fails the probe. The TCP-level fallback sits in an `else` branch gated on `command -v curl` — it is NOT reached when curl exists but the server returns non-200. The loop spins for 30s and the script exits with "Server did not become ready within 30 seconds", even though the server is running fine.

**Recommended fix:** Decouple the TCP-listening check from the HTTP-response check so that a TCP accept is sufficient to declare readiness when the HTTP probe returns non-200. A minimal patch:

```bash
if ss -Hltn "sport = :$PORT" 2>/dev/null | grep -q .; then
  # Prefer HTTP probe if curl is available
  if command -v curl &>/dev/null; then
    curl -fsS -o /dev/null "http://127.0.0.1:$PORT/" 2>/dev/null && { ready=true; break; }
  fi
  # Fallback: TCP-level probe (also catches auth-guarded cases)
  node -e "require('net').createConnection($PORT,'127.0.0.1').on('connect',()=>process.exit(0)).on('error',()=>process.exit(1))" 2>/dev/null && { ready=true; break; }
fi
```

---

### [Minor] Unknown arguments are silently ignored
**File:** `start_test_dashboard.sh:96-100`

**Why this matters:** A typo like `--use-prod-configs` (plural) silently uses isolated config instead of failing or warning. The caller gets the opposite of what they intended with no feedback.

**Recommended fix:** Add a catch-all in the argument loop:
```bash
for arg in "$@"; do
  case "$arg" in
    --use-prod-config) USE_PROD_CONFIG=true ;;
    --help|-h) echo "Usage: ..."; exit 0 ;;
    *) echo "Unknown argument: $arg" >&2; exit 1 ;;
  esac
done
```

---

### [Minor] No post-build validation
**File:** `start_test_dashboard.sh:51-53`

**Why this matters:** The script trusts that `npm run build` produces `build/server.js`. If the build output path ever changes (e.g., adapter config tweak), the error from `node build/server.js` will be a cryptic ENOENT rather than a clear "build output missing" message.

**Recommended fix:** Add an existence check after the build step:
```bash
if [ ! -f "$SCRIPT_DIR/build/server.js" ]; then
  echo "ERROR: build/server.js not found after build. Build may have failed." >&2
  exit 1
fi
```

---

### [Minor] No `--help` flag
**File:** `start_test_dashboard.sh`

**Why this matters:** The README documents env-var overrides and flags, but the script itself provides no way to discover them without reading the source or the README.

**Recommended fix:** Wire a `--help` / `-h` handler (see the arg-loop fix above) that prints the supported flags and env vars.

---

### [Nit] `PORT="$PORT"` is redundant
**File:** `start_test_dashboard.sh:123`

`PORT="$PORT" HOST=127.0.0.1 node ...` — `PORT` is already exported by the assignment `PORT=$(pick_port)` on line 91, so the inline re-export is a no-op. Harmless, but removes noise to drop it:
```bash
HOST=127.0.0.1 node "$SCRIPT_DIR/build/server.js" &
```

---

### [Nit] EXIT trap calls `kill` on already-dead process during normal exit
**File:** `start_test_dashboard.sh:185-190`

When the server exits on its own (e.g., crash, or Ctrl-C sends SIGINT which kills the foreground `wait`), the EXIT trap fires and calls `kill "$SERVER_PID"` on a process that's already gone. The `|| true` catches it, but the log line "Stopped test dashboard" could be misleading if the server died on its own.

**Recommended fix:** Check if the server is still alive before logging:
```bash
cleanup() {
  if kill -0 "$SERVER_PID" 2>/dev/null; then
    kill "$SERVER_PID" 2>/dev/null || true
    echo ""
    echo "Stopped test dashboard (pid $SERVER_PID)"
  fi
}
```

---

## Simplicity and design notes (KISS/YAGNI/DRY/SOLID)
- The script is appropriately simple for its purpose — no abstraction layers, no configurability beyond what's needed. Good.
- Placing it at the repo root (rather than alongside the sibling scripts in `scripts/`) is a reasonable discoverability trade-off: it's the primary entry point for ad-hoc testing.
- The decision to keep it HTTP-only (no certs) for test instances is correct — it avoids `start-dashboard.sh`'s cert-generation overhead for throwaway runs.
- Port collision handling with auto-increment + wrap-around is a pragmatic application of YAGNI: it covers the 99.99% case without over-engineering.

## Test gaps
- No unit tests (consistent with the project's current state — no test framework is configured).
- The readiness-probe auth edge case is not covered by any automated validation.
- If a test framework is added later, the port-selection / collision-handling logic is a natural candidate for property-based testing.

## Suggested next steps
1. Apply the readiness-probe fix (auth compatibility) — the only finding that can manifest as a real failure under documented usage.
2. Consider adding the `--help` / unknown-arg guard for better UX.
3. Optionally add the post-build existence check for defensive hardening.
