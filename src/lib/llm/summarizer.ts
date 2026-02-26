import { loadConfig } from '../config';
import type { AgentMessage } from '../agents/types';

interface SummaryCache {
  [sessionId: string]: {
    summary: string;
    lastMessageCount: number;
    timestamp: number;
  };
}

const cache: SummaryCache = {};

export async function generateSummary(
  sessionId: string,
  messages: AgentMessage[],
  force = false
): Promise<string> {
  const config = await loadConfig();
  const messageCount = messages.length;
  const cached = cache[sessionId];
  
  if (!force && cached && 
      messageCount - cached.lastMessageCount < 3 &&
      Date.now() - cached.timestamp < 120000) {
    return cached.summary;
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
      cache[sessionId] = {
        summary,
        lastMessageCount: messageCount,
        timestamp: Date.now()
      };
      return summary;
    }
    
    const data = await response.json() as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const summary = data.choices?.[0]?.message?.content?.trim() || extractTitleFromMessages(messages);
    
    cache[sessionId] = {
      summary,
      lastMessageCount: messageCount,
      timestamp: Date.now()
    };
    
    return summary;
  } catch (error) {
    console.error('Summary generation error:', error);
    const summary = extractTitleFromMessages(messages);
    cache[sessionId] = {
      summary,
      lastMessageCount: messageCount,
      timestamp: Date.now()
    };
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
    delete cache[sessionId];
  } else {
    Object.keys(cache).forEach(key => delete cache[key]);
  }
}
