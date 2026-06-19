import { loadConfig } from '../config';
import type { AgentMessage, AgentStatus } from '../agents/types';

interface CacheEntry {
  summary: string;
  lastMessageCount: number;
  timestamp: number;
  status: AgentStatus | null;
}

// LRU cache with max entries to prevent unbounded memory growth.
const MAX_CACHE_ENTRIES = 100;
const cache = new Map<string, CacheEntry>();

// TTLs vary by session status: idle/complete sessions rarely need refreshing.
const CACHE_TTL_ACTIVE = 120_000;    // 2 min for working/blocked
const CACHE_TTL_IDLE   = 600_000;    // 10 min for idle
const CACHE_TTL_DONE   = 1_800_000;  // 30 min for complete

function cacheTTL(status: AgentStatus | null): number {
  if (status === 'complete') return CACHE_TTL_DONE;
  if (status === 'idle') return CACHE_TTL_IDLE;
  return CACHE_TTL_ACTIVE;
}

function evictIfNeeded(): void {
  while (cache.size >= MAX_CACHE_ENTRIES) {
    // Evict the oldest entry (Map preserves insertion order).
    const oldest = cache.entries().next();
    if (oldest.done) break;
    cache.delete(oldest.value[0]);
  }
}

export async function generateSummary(
  sessionId: string,
  messages: AgentMessage[],
  force = false,
  status?: AgentStatus | null,
): Promise<string> {
  const config = await loadConfig();
  const messageCount = messages.length;
  const cached = cache.get(sessionId);
  
  if (!force && cached) {
    const ttl = status != null ? cacheTTL(status) : CACHE_TTL_ACTIVE;
    const messageThreshold = cached.status === 'complete' ? 10 : 3;
    if (
      messageCount - cached.lastMessageCount < messageThreshold &&
      Date.now() - cached.timestamp < ttl
    ) {
      return cached.summary;
    }
  }
  
  if (messages.length === 0) {
    return 'No activity';
  }
  
  const recentMessages = messages.slice(-8);
  const context = recentMessages
    .map(m => `${m.role}: ${m.content.slice(0, 300)}`)
    .join('\n')
    .slice(0, 2000);
  
  try {
    const response = await fetch(`${config.llm.endpoint}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: config.llm.model,
        max_tokens: config.llm.summaryMaxTokens,
        messages: [
          { role: 'system', content: config.llm.summaryPrompt },
          { role: 'user', content: context }
        ]
      }),
      signal: AbortSignal.timeout(5000)
    });
    
    if (!response.ok) {
      const summary = extractTitleFromMessages(messages);
      evictIfNeeded();
      cache.set(sessionId, {
        summary,
        lastMessageCount: messageCount,
        timestamp: Date.now(),
        status: status ?? null,
      });
      return summary;
    }
    
    const data = await response.json() as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const summary = data.choices?.[0]?.message?.content?.trim() || extractTitleFromMessages(messages);
    
    evictIfNeeded();
    cache.set(sessionId, {
      summary,
      lastMessageCount: messageCount,
      timestamp: Date.now(),
      status: status ?? null,
    });
    
    return summary;
  } catch (error) {
    console.error('Summary generation error:', error);
    const summary = extractTitleFromMessages(messages);
    evictIfNeeded();
    cache.set(sessionId, {
      summary,
      lastMessageCount: messageCount,
      timestamp: Date.now(),
      status: status ?? null,
    });
    return summary;
  }
}

function extractTitleFromMessages(messages: AgentMessage[]): string {
  if (messages.length === 0) return 'Unknown task';
  
  const firstUserMsg = messages.find(m => m.role === 'user');
  if (firstUserMsg) {
    const content = firstUserMsg.content;
    const firstLine = content.split('\n')[0];
    return firstLine.slice(0, 60) + (firstLine.length > 60 ? '...' : '');
  }
  
  return 'Agent session';
}

export function clearCache(sessionId?: string): void {
  if (sessionId) {
    cache.delete(sessionId);
  } else {
    cache.clear();
  }
}
