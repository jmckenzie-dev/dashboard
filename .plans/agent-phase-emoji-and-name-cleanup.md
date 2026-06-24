# Agent Phase Emoji & Name Cleanup

## Goal

1. Show a phase emoji (🧠 thinking, 🔧 tool use, 💬 generating, ⚠️ blocked) that reflects what an OpenCode agent is currently doing, by reading the latest part type from the part stream.
2. Remove the redundant `opencode - ` prefix from session title lines, since all agents in the current UI are OpenCode.

---

## Current State

- **`AgentSession`** (`src/lib/agents/types.ts:43-67`) has no `phase` field. Status gives the coarse lifecycle (`working`/`blocked_*`/`complete`/`idle`/`error`/`retry`) but doesn't distinguish *within* `working`.
- **`analyzeParts`** (`src/lib/status/inference.ts:44-108`) extracts the latest tool part, latest step-finish reason, and error flag — but does **not** track the most recent non-tool part type (`reasoning`/`text`).
- **Both session-fetch paths** (SQLite at `opencode.ts:567` and API at `opencode.ts:431`) normalize parts and call `analyzeParts`, then call `inferOpencodeStatus`. Neither computes a phase.
- **Title line** (`+page.svelte:339,440`) renders `{session.type} - {session.name}` → `opencode - My Session`. The type string is always `'opencode'` and the icon 🤖 already conveys it.
- **`+page.server.ts`** and **SSE endpoint** (`/api/events`) both spread sessions — any new field on `AgentSession` flows to the frontend automatically.

## Phase Inference Source Data

From the `part` table / API message parts, the `type` field is a discriminated union. Relevant values for phase:

| Part Type | Meaning | Phase to Show |
|-----------|---------|---------------|
| `reasoning` | Model is emitting reasoning/thinking tokens | `reasoning` 🧠 |
| `text` | Model is emitting visible text tokens | `generating` 💬 |
| `tool` with `state.status` in `pending`/`running` and tool NOT `submit_plan`/`question` | Agent is executing a tool | `using_tool` 🔧 |
| `tool` with tool=`submit_plan`/`question` OR status is `blocked_*` | Agent is waiting on user | `blocked` ⚠️ |
| None of the above / session is `idle`/`complete` | Nothing active | `idle` (null/no emoji) |

Order matters: within an assistant turn, the typical sequence is `reasoning → tool → text → step-finish`. The **latest** part type (by `time_created`) tells us what's happening right now.

---

## Files Touched

| # | File | Change |
|---|------|--------|
| 1 | `src/lib/status/inference.ts` | Extend `analyzeParts` to track `latestPartType`; add `inferPhase()` function; export `AgentPhase` type |
| 2 | `src/lib/agents/types.ts` | Add `AgentPhase` type union + `phase?: AgentPhase` field to `AgentSession` |
| 3 | `src/lib/agents/opencode.ts` | Call `inferPhase` in both `parsePartData` (SQLite path) and `getSessionsViaAPI` (API path); set `phase` on the session object |
| 4 | `src/routes/+page.svelte` | Add `phase` to frontend `Session` type; add `phaseEmoji()` function; replace `agentIcon()` call with phase-aware icon for `working` sessions; remove type prefix from title line |
| 5 | `src/lib/agents/index.ts` | No changes needed (pass-through) |
| 6 | `src/routes/+page.server.ts` | No changes needed (pass-through) |

---

## Step-by-Step Execution

### Step 1: Extend `analyzeParts` and add `inferPhase` in `inference.ts`

**File:** `src/lib/status/inference.ts`

**1a — Add the phase type** (after the existing imports and before `SessionStatusType`):

```typescript
export type AgentPhase = 'reasoning' | 'generating' | 'using_tool' | 'blocked' | 'idle';
```

**1b — Extend `analyzeParts` return type** to also include the type of the most recent part (any type, not just tool):

```typescript
export function analyzeParts(parts: NormalizedPart[]): {
  latestTool: LatestToolInfo | null;
  latestStepReason: string | null;
  hasError: boolean;
  latestPartType: string | null;         // <-- new
  latestPartIsActiveTool: boolean;       // <-- new: true when latest part is a tool with pending/running status
} {
```

**1c — Inside `analyzeParts`, after sorting `ordered`**, find the most recent part overall:

```typescript
  // Most recent part of any type (for phase inference).
  const latestOverall = ordered[0] ?? null;
  const latestPartType = latestOverall?.type ?? null;
  const latestPartIsActiveTool = latestOverall?.type === 'tool'
    && (latestOverall?.status === 'pending' || latestOverall?.status === 'running');
```

Return these new fields in the result object.

**1d — Add `inferPhase` function:**

```typescript
export function inferPhase(
  status: AgentStatus,
  latestPartType: string | null,
  latestPartIsActiveTool: boolean,
  latestTool: LatestToolInfo | null,
): AgentPhase {
  // Blocked/error/complete/idle statuses are authoritative phase signals.
  if (isBlocked(status) || status === 'error') return 'blocked';
  if (status === 'complete' || status === 'idle') return 'idle';

  // For working/retry sessions, use the latest part type.
  if (latestPartType === 'reasoning') return 'reasoning';
  if (latestPartType === 'text') return 'generating';

  // Active tool execution (the latest part is a tool that's in flight).
  const toolName = latestTool?.tool ?? '';
  const isBlockingTool = toolName === 'submit_plan' || toolName === 'plan_exit' || toolName === 'question';
  if (latestPartIsActiveTool && !isBlockingTool) return 'using_tool';

  // Fallback: check if latestTool is active (this catches cases where
  // a tool part is still running but not the absolute latest part due to
  // ordering quirks).
  if (latestTool?.active && !isBlockingTool) return 'using_tool';

  // Default for working with no clear phase signal.
  return 'idle';
}
```

Note: Since `isBlocked` is not currently exported from `types.ts`, we need to either import it or inline the check. The simplest approach: `inferPhase` lives in `inference.ts` which already imports from `'../agents/types'`, so we can use `isBlocked` there.

Wait — looking at `inference.ts`, it imports `import type { AgentStatus } from '../agents/types';`. It's a type-only import. But `isBlocked` is a runtime function, not a type. Let me check...

Actually, `inferPhase` is a pure function that takes `status: AgentStatus` as input. It doesn't need to import `isBlocked` — it can just check the status string directly:

```typescript
  const blockedPrefixes = ['blocked_permission', 'blocked_question', 'blocked_review', 'blocked', 'error'];
  if (blockedPrefixes.some(p => status.startsWith(p))) return 'blocked';
```

Or simpler: check if status starts with `'blocked'` or equals `'error'`.

### Step 2: Add `AgentPhase` type and field to `types.ts`

**File:** `src/lib/agents/types.ts`

**2a — Add after the `BlockReason` type (line 19):**

```typescript
export type AgentPhase = 'reasoning' | 'generating' | 'using_tool' | 'blocked' | 'idle';
```

**2b — Add `phase?: AgentPhase` to the `AgentSession` interface (after line 60, near `mode`):**

```typescript
  phase?: AgentPhase;
```

### Step 3: Wire `inferPhase` into both session paths in `opencode.ts`

**File:** `src/lib/agents/opencode.ts`

**3a — Update the import** to include `type AgentPhase`, `inferPhase`:

```typescript
import {
  analyzeParts,
  inferOpencodeStatus,
  inferPhase,       // <-- new
  type AgentPhase,  // <-- new
} from '../status/inference';
```

**3b — In `parsePartData`** (`opencode.ts:115` — SQLite path), after the `analyzeParts` call at line 140:

```typescript
  const { latestTool, latestStepReason, hasError, latestPartType, latestPartIsActiveTool } = analyzeParts(normalized);
  // Return these new fields from parsePartData so the caller can use them
```

Update `ParsedPartData` interface (line 63-69) to include the new fields:

```typescript
interface ParsedPartData {
  messages: AgentMessage[];
  latestTool: LatestToolInfo | null;
  latestStepReason: string | null;
  lastPartTime: number | null;
  hasError: boolean;
  latestPartType: string | null;       // <-- new
  latestPartIsActiveTool: boolean;    // <-- new
}
```

Set them at the end of `parsePartData`:

```typescript
  return {
    messages: trimmed,
    latestTool,
    latestStepReason,
    lastPartTime,
    hasError,
    latestPartType,
    latestPartIsActiveTool,
  };
```

**3c — In `getSessionsViaSQLite`** (`opencode.ts:567-649`), after `status` inference (line 616) and before `result.push` (line 625):

```typescript
  const phase = inferPhase(status, parsed.latestPartType, parsed.latestPartIsActiveTool, parsed.latestTool);
```

And add `phase` to the session object:

```typescript
  result.push({
    // ... existing fields ...
    phase,
  });
```

**3d — In `getSessionsViaAPI`** (`opencode.ts:431-565`), after the `analyzeParts` call (line 511):

```typescript
  const analyzed = analyzeParts(normalized);
  latestTool = analyzed.latestTool;
  latestStepReason = analyzed.latestStepReason;
  hasError = analyzed.hasError;
  // New phase inference
  const phase = inferPhase(status, analyzed.latestPartType, analyzed.latestPartIsActiveTool, latestTool);
```

And add `phase` to the session object in the `result.push` (line 541):

```typescript
  result.push({
    // ... existing fields ...
    phase,
  });
```

**Important:** For the API path, `inferPhase` is called *after* `status` is computed. The code currently computes `status` at line 524-533 and pushes at line 541. So add the phase call between those two blocks.

### Step 4: Update the frontend

**File:** `src/routes/+page.svelte`

**4a — Add `phase` to the `Session` type** (after line 18, near `mode`):

```typescript
    phase?: string;
```

**4b — Add a `phaseEmoji` function** (alongside `agentIcon`, after line 247):

```typescript
  function phaseEmoji(phase: string | undefined): string {
    if (phase === 'reasoning') return '🧠';
    if (phase === 'using_tool') return '🔧';
    if (phase === 'generating') return '💬';
    if (phase === 'blocked') return '⚠️';
    return ''; // idle or unknown — show nothing, let the type icon handle it
  }
```

**4c — Replace the static `agentIcon` with a phase-aware icon** inside the card templates.

Change line 337 (root sessions) — replace:
```svelte
<span class="icon">{agentIcon(session.type)}</span>
```
with:
```svelte
<span class="icon">
  {#if (session.status === 'working' || session.status === 'retry') && session.phase && session.phase !== 'idle'}
    {phaseEmoji(session.phase)}
  {:else if session.status === 'blocked_permission' || session.status === 'blocked_question' || session.status === 'blocked_review' || session.status === 'blocked'}
    ⚠️
  {:else}
    {agentIcon(session.type)}
  {/if}
</span>
```

Similarly for line 438 (child sessions) — same replacement.

**4d — Remove the `session.type - ` prefix from the title line.**

Change line 339:
```svelte
<span class="title-line">{session.type} - {session.name}</span>
```
to:
```svelte
<span class="title-line">{session.name}</span>
```

Same for line 440 (child sessions).

### Step 5: Verify data flow

- `+page.server.ts` already spreads all `AgentSession` fields via explicit mapping — `phase` will flow through because it's in the return object.
- SSE endpoint `/api/events` pushes `session` objects directly — `phase` flows through automatically.
- No changes needed in `index.ts`, `+page.server.ts`, or the SSE endpoint.

---

## Validation Plan

1. **`npm run check`** — TypeScript/Svelte diagnostics must pass with no new errors.
2. **`npm run build`** — Production build must succeed.
3. **Visual inspection** (dev server): Open the dashboard, observe an active session:
   - When agent is reasoning → icon shows 🧠
   - When agent is executing a tool → icon shows 🔧
   - When agent is generating text → icon shows 💬
   - When agent is blocked → icon shows ⚠️
   - When agent is idle/complete → icon shows 🤖
   - Title line shows `Session Name` not `opencode - Session Name`
4. **Edge case: no parts** — A session with no parts should show 🤖 and no phase.
5. **Edge case: retry** — `retry` status should be treated like `working` for phase purposes (show phase emoji).
6. **Edge case: error** — `error` status maps to `blocked` phase → ⚠️ (but ❌ badge already visible).
7. **SSE update** — Phase should update in real-time as new parts arrive via the SSE event stream.
8. **Responsive** — The icon column width is fixed (`1.6rem`); verify all emoji fit without layout shift.

---

## Risks and Mitigations

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| **Stale phase** — The last part type reflects what the agent *did*, not what it's currently *doing* (race condition) | Medium | Acceptable for a polling model. Phase will update on each poll tick (every ~5-15s). The emoji is a hint, not a guaranteed real-time indicator. |
| **Part ordering ambiguity** — Tool parts and reasoning/text parts can arrive out of order | Low | `analyzeParts` already sorts by `time_created DESC`. Time is the authoritative ordering. |
| **`parsePartData` doesn't know the final status** — SQLite path computes phase before `inferOpencodeStatus` is called | Low | The phase inference in the SQLite path happens during session construction. We compute phase after `inferOpencodeStatus` gives us the status, so we have full context. |
| **Emoji layout shift** — Different emoji have different visual widths | Low | The icon column is `1.6rem` wide with `text-align: center` essentially (grid layout). Emoji render consistently at the same character width. Test on Chrome/Firefox. |
| **Phase flickering** — Rapid transitions between phases during fast turns | Low | Polling interval smooths this out. Each poll shows the latest snapshot. |

## Design Decisions (Confirmed)

- **Blocked phase**: ⚠️ replaces 🤖 for all `blocked_*` and `error` statuses. Complements the existing status dot (🔴🟠🟡).
- **Retry treatment**: `retry` is treated like `working` for phase display — shows the current phase emoji.
- **Reasoning priority**: When both a `reasoning` part and active tool are present, 🧠 wins over 🔧. The most recent output type is the best signal.

---

## Future Considerations

- If non-OpenCode agents are re-enabled, `phase` would only apply to OpenCode (they have no part-based phase inference). The `agentIcon` fallback handles this gracefully.
- The `phase` field could be extended later to support more granular states if opencode adds them.
- For real-time phase updates, the agent could listen to the SSE `/api/events` stream — but the current polling model is sufficient for the dashboard's use case.
