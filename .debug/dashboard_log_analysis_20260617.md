# Dashboard Log Analysis — 2026-06-17

## Investigation Summary

Reviewed 40+ log files from `logs/`, the running container process, the
dashboard API, and the source code. The dashboard is **running and healthy**
with some historical issues and a few active concerns worth noting.

---

## Current State (Good)

| Aspect | Status |
|---|---|
| **Service** | Running in Podman container (`ai-agent-dashboard`) |
| **Container ID** | `0aa80dd8a25ff34fd566f84d46b685a2f266e1629b5de363b1a78e94d7d12e84` |
| **PID** | 683398 (node build/index.js inside container) |
| **Uptime** | Started 2026-06-17 15:27:49 (~8 hours) |
| **Port** | 35001, listening on all interfaces |
| **API** | HTTP 200 at `http://127.0.0.1:35001/api/agents` |
| **Agent sessions** | 3 tracked (1 working, 2 complete) |
| **svelte-check** | 0 errors, 0 warnings |
| **Build** | Successful (170 SSR + 160 client modules) |
| **Property tests** | Passed |

---

## Historical Issues (Resolved)

### 1. Container build failure — missing `static/` directory
- **Log**: `restart_dashboard_20260616_215416.log:228`
- **Error**:
  ```
  Error: building at STEP "COPY --from=builder /app/static ./static":
  copier: stat: "/app/static": no such file or directory
  ```
- **Root cause**: The `static/` directory didn't exist in the project root.
  The Containerfile tried to `COPY --from=builder /app/static ./static` but
  the builder stage hadn't created it.
- **Fix**: Added `mkdir -p static && npm run build` in the Containerfile
  builder stage (STEP 6/6). Visible in all subsequent successful builds.

### 2. Podman not found in PATH
- **Logs**: `restart_dashboard_20260616_215148.log:84`,
  `restart_dashboard_20260616_215214.log:84`
- **Error**: `./restart_dashboard.sh: line 32: podman: command not found`
- **Root cause**: Script was run from a directory/environment where `podman`
  wasn't in PATH. The `distrobox-host-exec` fallback also failed.
- **Fix**: The script has a `distrobox-host-exec` fallback, but it only works
  when run inside a distrobox container. When run directly on the host,
  `podman` must be in PATH.

### 3. npm dependency warnings (container build)
- **Log**: `restart_dashboard_20260616_215416.log:99-111`
- **Warnings**:
  - `npm warn deprecated prebuild-install@7.1.3: No longer maintained`
  - `8 vulnerabilities (1 low, 2 moderate, 5 high)` in builder stage
  - `New major version of npm available! 10.9.8 -> 11.17.0`
- **Status**: The runtime stage (`npm ci --omit=dev --omit=optional`) shows
  `found 0 vulnerabilities`, so the runtime image is clean. The builder stage
  vulnerabilities are from dev dependencies and don't affect the running
  service.

---

## Active Concerns

### 1. High CPU Usage — **Should investigate**
- **Evidence**: `ps aux` shows PID 683398 using **27.8% CPU** with **132+
  minutes of cumulative CPU time** over ~8 hours of uptime.
- **Context**: This is a SvelteKit SSR app with 500ms polling. 27.8% CPU is
  high for a dashboard that should mostly be idle between polls.
- **Hypothesis**: The 500ms polling interval (see config below) combined with
  the OpenCode SQLite queries and SSE event stream could be causing excessive
  CPU. Each poll cycle reads the OpenCode SQLite DB, fetches messages, and
  broadcasts via SSE.
- **Config evidence** (`dashboard.toml`):
  ```toml
  [polling]
  intervalMs = 500
  ```
- **Recommendation**: Consider increasing the polling interval to 2000-5000ms
  and/or adding a cooldown when no active sessions exist.

### 2. No Password Authentication — **Security concern**
- **Evidence** (`dashboard.toml`):
  ```toml
  [auth]
  username = "admin"
  passwordHash = ""
  ```
- **Impact**: The dashboard is exposed on port 35001 with TLS configured but
  **no password protection**. Anyone who can reach the port can access the
  dashboard without authentication.
- **Recommendation**: Set a bcrypt password hash in the config.

### 3. Known Issues in TODO.md
- "Debug inability to send messages to agents from interface" — this is a
  known bug that affects the core "send message" feature.
- "Updating is very slow; want to get to 1 second polling updates" — ironic
  given the 500ms polling interval; the slowness may be in the UI rendering
  or API response time rather than polling frequency.
- Several feature requests and enhancements listed.

### 4. Source-Level Error Handling Patterns
The codebase uses `console.error()` / `console.warn()` extensively for error
handling. These go to stdout/stderr in the container, which routes to
journald. Key error paths that could fire during normal operation:

| File | Error/Warn | When |
|---|---|---|
| `opencode.ts:259` | `OpenCode status fetch failed` | OpenCode API unreachable |
| `opencode.ts:303` | `OpenCode blocking-request fetch failed` | Permission/question fetch fails |
| `opencode.ts:451` | `OpenCode message fetch failed for ...` | Per-session message fetch fails |
| `opencode.ts:574` | `OpenCode SQLite error` | DB query failure |
| `opencode.ts:637` | `OpenCode SQLite directory lookup error` | Session directory lookup fails |
| `events/+server.ts:38` | `SSE poll error` | SSE event stream poll fails |
| `summarizer.ts:77` | `Summary generation error` | LLM summary call fails |
| `notifications/index.ts:84` | `Sound file not found` | Notification sound missing |
| `notifications/index.ts:108` | `Skill file not found` | Notification skill missing |

These are all caught and logged gracefully — none would crash the service.

---

## Conclusion

**The dashboard is healthy.** No active errors or crashes were found. The
service builds cleanly, starts successfully, and responds to API requests.

**Two items worth addressing:**
1. **High CPU usage (27.8%)** — likely from 500ms polling. Consider
   increasing `polling.intervalMs` or adding adaptive polling.
2. **Missing password hash** — the dashboard is exposed without
   authentication despite TLS being configured.
