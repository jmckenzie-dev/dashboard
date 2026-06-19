Performance optimization: polling, SSE, summary caching

Root cause: 500ms polling triggered 4 agent backends (each with execSync
subprocesses, SQLite queries, file reads) and LLM summary generation for
every session on every tick — ~20 LLM calls/sec with 10 sessions.

Changes:
- Polling interval default changed to 3000ms (6x reduction)
- Frontend switched from setInterval(fetch) to EventSource SSE,
  eliminating duplicate HTTP polling
- Non-OpenCode agent backends (Claude, Codex, Gemini) disabled to
  remove ~10 execSync calls per tick
- Summary cache converted to Map-based LRU (max 100 entries) with
  differentiated TTLs: 2min active, 10min idle, 30min complete
- API/SSE endpoints skip generateSummary for idle/complete sessions
- Messages truncated server-side (last 5, 220 chars) to reduce payload
- previousStatus map bounded to 200 entries with LRU eviction
- Frontend state (expandedSubagents, inputText) pruned on session
  changes to prevent unbounded growth

Verified: npm run check (0 errors), npm run build (passes)
