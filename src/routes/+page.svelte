<script lang="ts">
  import type { PageData } from './$types';
  import { onDestroy, onMount } from 'svelte';

  type Session = {
    id: string;
    parentId?: string;
    type: string;
    name: string;
    summary: string;
    status: 'working' | 'blocked' | 'complete' | 'idle';
    project?: string;
    directory?: string;
    lastActivity: string;
    messages: Array<{ id: string; role: string; content: string; timestamp: string }>;
    canSendInput: boolean;
  };

  type Counts = {
    working: number;
    blocked: number;
    complete: number;
    idle: number;
  };

  let { data }: { data: PageData } = $props();

  let sessions = $state<Session[]>([]);
  let rootSessions = $state<Session[]>([]);
  let childrenByParentId = $state<Record<string, Session[]>>({});
  let counts = $state<Counts>({ working: 0, blocked: 0, complete: 0, idle: 0 });
  let expandedId = $state<string | null>(null);
  let expandedSubagents = $state<Record<string, boolean>>({});
  let inputText = $state<Record<string, string>>({});
  let sending = $state<Record<string, boolean>>({});
  let pollTimer = $state<ReturnType<typeof setInterval> | null>(null);
  let pollInFlight = $state(false);

  function sortByLastActivityDesc(a: Session, b: Session): number {
    return new Date(b.lastActivity).getTime() - new Date(a.lastActivity).getTime();
  }

  function buildSessionTree(allSessions: Session[]): {
    roots: Session[];
    children: Record<string, Session[]>;
  } {
    const byId = new Set(allSessions.map((session) => session.id));
    const roots: Session[] = [];
    const children: Record<string, Session[]> = {};

    for (const session of allSessions) {
      const parentId = session.parentId;
      if (parentId && parentId !== session.id && byId.has(parentId)) {
        if (!children[parentId]) children[parentId] = [];
        children[parentId].push(session);
        continue;
      }

      roots.push(session);
    }

    roots.sort(sortByLastActivityDesc);
    for (const parentId of Object.keys(children)) {
      children[parentId].sort(sortByLastActivityDesc);
    }

    return { roots, children };
  }

  function isCompleteForAtLeastOneMinute(session: Session): boolean {
    if (session.status !== 'complete') return false;
    const completedAt = new Date(session.lastActivity).getTime();
    if (Number.isNaN(completedAt)) return false;
    return Date.now() - completedAt >= 60_000;
  }

  function shouldAutoCollapseSubagents(children: Session[]): boolean {
    if (children.length === 0) return false;
    return children.every((child) => isCompleteForAtLeastOneMinute(child));
  }

  function subagentsExpanded(parentId: string): boolean {
    return expandedSubagents[parentId] ?? true;
  }

  function toggleSubagents(parentId: string) {
    expandedSubagents[parentId] = !subagentsExpanded(parentId);
  }

  function getPollIntervalMs(): number {
    const raw = data.config?.polling?.intervalMs;
    if (typeof raw !== 'number' || Number.isNaN(raw)) return 500;
    return Math.min(10000, Math.max(100, raw));
  }

  $effect(() => {
    sessions = data.sessions as Session[];
    counts = data.counts as Counts;
  });

  $effect(() => {
    const tree = buildSessionTree(sessions);
    rootSessions = tree.roots;
    childrenByParentId = tree.children;

    for (const parentId of Object.keys(tree.children)) {
      if (!(parentId in expandedSubagents)) {
        expandedSubagents[parentId] = true;
      }

      if (shouldAutoCollapseSubagents(tree.children[parentId])) {
        expandedSubagents[parentId] = false;
      }
    }
  });

  onMount(() => {
    pollTimer = setInterval(async () => {
      if (pollInFlight) return;
      pollInFlight = true;

      try {
        const response = await fetch('/api/agents');
        if (!response.ok) return;
        const payload = await response.json();
        sessions = payload.sessions as Session[];
        counts = payload.counts as Counts;
      } catch (error) {
        console.error('poll failed', error);
      } finally {
        pollInFlight = false;
      }
    }, getPollIntervalMs());
  });

  onDestroy(() => {
    if (pollTimer) clearInterval(pollTimer);
  });

  function toggleExpand(id: string) {
    expandedId = expandedId === id ? null : id;
  }

  function formatTime(iso: string): string {
    const d = new Date(iso);
    const diffMin = Math.floor((Date.now() - d.getTime()) / 60000);
    if (diffMin < 1) return 'just now';
    if (diffMin < 60) return `${diffMin}m ago`;
    if (diffMin < 24 * 60) return `${Math.floor(diffMin / 60)}h ago`;
    return d.toLocaleDateString();
  }

  function statusClass(status: Session['status']) {
    if (status === 'working') return 'badge-working';
    if (status === 'blocked') return 'badge-blocked';
    if (status === 'complete') return 'badge-complete';
    return 'badge-idle';
  }

  function statusDot(status: Session['status']) {
    if (status === 'working') return '🔵';
    if (status === 'blocked') return '🔴';
    if (status === 'complete') return '🟢';
    return '⚪';
  }

  function agentIcon(type: string) {
    if (type === 'opencode') return '🤖';
    if (type === 'claude') return '🧠';
    if (type === 'codex') return '💻';
    if (type === 'gemini') return '✨';
    return '🤖';
  }

  async function sendMessage(sessionId: string) {
    const text = (inputText[sessionId] || '').trim();
    if (!text || sending[sessionId]) return;

    sending[sessionId] = true;
    try {
      const res = await fetch(`/api/agents/${sessionId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: text })
      });
      if (res.ok) inputText[sessionId] = '';
    } finally {
      sending[sessionId] = false;
    }
  }
</script>

<svelte:head>
  <title>AI Agent Dashboard</title>
</svelte:head>

<header class="header">
  <h1>AI Agent Dashboard</h1>
  <a href="/settings" class="settings-link">Settings</a>
</header>

<section class="status-bar">
  <span class="badge badge-working">🔵 {counts.working} Working</span>
  <span class="badge badge-blocked">🔴 {counts.blocked} Blocked</span>
  <span class="badge badge-complete">🟢 {counts.complete} Complete</span>
  <span class="badge badge-idle">⚪ {counts.idle} Idle</span>
</section>

<main class="main">
  {#if rootSessions.length === 0}
    <div class="empty">No active sessions found.</div>
  {:else}
    {#each rootSessions as session (session.id)}
      <article class="card" data-status={session.status}>
        <button
          class="card-header"
          type="button"
          onclick={() => toggleExpand(session.id)}
          aria-expanded={expandedId === session.id}
        >
          <span class="triangle">{expandedId === session.id ? '▾' : '▸'}</span>
          <span class="icon">{agentIcon(session.type)}</span>
          <span class="title-group">
            <span class="title-line">{session.type} - {session.name}</span>
            <span class="summary">{session.summary || 'No summary yet'}</span>
          </span>
          <span class="meta">
            <span class={`badge ${statusClass(session.status)}`}>
              {statusDot(session.status)} {session.status}
            </span>
            <span class="time">{formatTime(session.lastActivity)}</span>
          </span>
        </button>

        {#if expandedId === session.id}
          <div class="details">
            {#if session.project}
              <div class="project">Project: {session.project}</div>
            {/if}

            <div class="messages">
              {#each session.messages.slice(-5) as m}
                <div class="message-row">
                  <span class="role">{m.role}:</span>
                  <span>{m.content.slice(0, 220)}{m.content.length > 220 ? '...' : ''}</span>
                </div>
              {/each}
            </div>

            {#if session.status === 'blocked'}
              <div class="input-row">
                <input
                  type="text"
                  placeholder="Reply to this agent"
                  bind:value={inputText[session.id]}
                  onkeydown={(e) => e.key === 'Enter' && sendMessage(session.id)}
                  disabled={!session.canSendInput}
                />
                <button
                  class="btn-primary"
                  type="button"
                  onclick={() => sendMessage(session.id)}
                  disabled={!session.canSendInput || sending[session.id]}
                >
                  {sending[session.id] ? 'Sending...' : 'Send'}
                </button>
              </div>
            {/if}
          </div>
        {/if}
      </article>

      {#if childrenByParentId[session.id]?.length}
        <section class="subagents" data-parent={session.id}>
          <button
            type="button"
            class="subagents-toggle"
            aria-expanded={subagentsExpanded(session.id)}
            onclick={() => toggleSubagents(session.id)}
          >
            <span>{subagentsExpanded(session.id) ? '▾' : '▸'}</span>
            <span>Subagents ({childrenByParentId[session.id].length})</span>
          </button>

          {#if subagentsExpanded(session.id)}
            <div class="subagent-list">
              {#each childrenByParentId[session.id] as child (child.id)}
                <article class="card subagent-card" data-status={child.status}>
                  <button
                    class="card-header"
                    type="button"
                    onclick={() => toggleExpand(child.id)}
                    aria-expanded={expandedId === child.id}
                  >
                    <span class="triangle">{expandedId === child.id ? '▾' : '▸'}</span>
                    <span class="icon">{agentIcon(child.type)}</span>
                    <span class="title-group">
                      <span class="title-line">{child.type} - {child.name}</span>
                      <span class="summary">{child.summary || 'No summary yet'}</span>
                    </span>
                    <span class="meta">
                      <span class={`badge ${statusClass(child.status)}`}>
                        {statusDot(child.status)} {child.status}
                      </span>
                      <span class="time">{formatTime(child.lastActivity)}</span>
                    </span>
                  </button>

                  {#if expandedId === child.id}
                    <div class="details">
                      {#if child.project}
                        <div class="project">Project: {child.project}</div>
                      {/if}

                      <div class="messages">
                        {#each child.messages.slice(-5) as m}
                          <div class="message-row">
                            <span class="role">{m.role}:</span>
                            <span>{m.content.slice(0, 220)}{m.content.length > 220 ? '...' : ''}</span>
                          </div>
                        {/each}
                      </div>

                      {#if child.status === 'blocked'}
                        <div class="input-row">
                          <input
                            type="text"
                            placeholder="Reply to this agent"
                            bind:value={inputText[child.id]}
                            onkeydown={(e) => e.key === 'Enter' && sendMessage(child.id)}
                            disabled={!child.canSendInput}
                          />
                          <button
                            class="btn-primary"
                            type="button"
                            onclick={() => sendMessage(child.id)}
                            disabled={!child.canSendInput || sending[child.id]}
                          >
                            {sending[child.id] ? 'Sending...' : 'Send'}
                          </button>
                        </div>
                      {/if}
                    </div>
                  {/if}
                </article>
              {/each}
            </div>
          {/if}
        </section>
      {/if}
    {/each}
  {/if}
</main>

<style>
  .header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 1rem 1.25rem;
    border-bottom: 1px solid var(--border-color);
    background: var(--bg-secondary);
  }

  .header h1 {
    font-size: 1.1rem;
    font-weight: 600;
  }

  .settings-link {
    color: var(--text-secondary);
  }

  .status-bar {
    display: flex;
    gap: 0.5rem;
    flex-wrap: wrap;
    padding: 0.75rem 1.25rem;
    border-bottom: 1px solid var(--border-color);
    background: var(--bg-tertiary);
  }

  .main {
    padding: 1rem 1.25rem;
  }

  .empty {
    color: var(--text-muted);
    padding: 1rem;
  }

  .card {
    border: 1px solid var(--border-color);
    border-left: 4px solid #4a4a4a;
    border-radius: var(--radius-lg);
    margin-bottom: 0.75rem;
    background: var(--bg-secondary);
    overflow: hidden;
  }

  .subagents {
    margin: -0.2rem 0 0.75rem 1.4rem;
    border-left: 2px solid rgba(255, 255, 255, 0.1);
    padding-left: 0.7rem;
  }

  .subagents-toggle {
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
    margin: 0 0 0.45rem;
    background: transparent;
    border: 0;
    color: var(--text-secondary);
    font-size: 0.78rem;
    padding: 0;
  }

  .subagent-list {
    display: block;
  }

  .subagent-card {
    margin-bottom: 0.55rem;
    opacity: 0.95;
  }

  .subagent-card .title-line {
    font-size: 0.9rem;
  }

  .card[data-status='working'] {
    border-left-color: var(--accent-blue);
  }

  .card[data-status='blocked'] {
    border-left-color: var(--accent-red);
  }

  .card[data-status='complete'] {
    border-left-color: var(--accent-green);
  }

  .card-header {
    width: 100%;
    display: grid;
    grid-template-columns: 1.2rem 1.6rem minmax(0, 1fr) auto;
    gap: 0.6rem;
    align-items: center;
    text-align: left;
    padding: 0.75rem 0.9rem;
    background: transparent;
    border: 0;
    border-radius: 0;
  }

  .card-header:hover {
    background: rgba(255, 255, 255, 0.03);
  }

  .title-group {
    min-width: 0;
    display: flex;
    flex-direction: column;
  }

  .title-line {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    color: var(--text-primary);
    font-size: 0.95rem;
  }

  .summary {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    color: var(--text-secondary);
    font-size: 0.82rem;
  }

  .meta {
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: 0.2rem;
  }

  .time {
    color: var(--text-muted);
    font-size: 0.75rem;
  }

  .details {
    border-top: 1px solid var(--border-color);
    padding: 0.8rem 0.9rem;
    background: rgba(255, 255, 255, 0.01);
  }

  .project {
    color: var(--text-secondary);
    font-size: 0.82rem;
    margin-bottom: 0.65rem;
  }

  .messages {
    border: 1px solid var(--border-color);
    border-radius: var(--radius);
    padding: 0.55rem;
    margin-bottom: 0.7rem;
    background: var(--bg-primary);
  }

  .message-row {
    font-size: 0.82rem;
    color: var(--text-secondary);
    padding: 0.25rem 0;
    border-bottom: 1px dashed rgba(255, 255, 255, 0.08);
  }

  .message-row:last-child {
    border-bottom: 0;
  }

  .role {
    color: var(--text-primary);
    margin-right: 0.35rem;
  }

  .input-row {
    display: flex;
    gap: 0.5rem;
  }

  .input-row input {
    flex: 1;
  }

  @media (max-width: 760px) {
    .subagents {
      margin-left: 0.8rem;
      padding-left: 0.6rem;
    }

    .card-header {
      grid-template-columns: 1.2rem 1.6rem minmax(0, 1fr);
    }

    .meta {
      grid-column: 3;
      flex-direction: row;
      justify-content: space-between;
      margin-top: 0.35rem;
    }
  }
</style>
