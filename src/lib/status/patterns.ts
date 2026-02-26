import type { AgentType, AgentStatus } from '../agents/types';

export interface StatusPattern {
  blocked: RegExp[];
  complete: RegExp[];
  working: RegExp[];
}

const BLOCKED_PATTERNS: Record<AgentType, RegExp[]> = {
  opencode: [
    /waiting for (user|input|confirmation|response)/i,
    /please (confirm|select|choose|provide|enter)/i,
    /\?.*\[y\/n\]/i,
    /permission required/i,
    /awaiting (approval|confirmation|input)/i,
    /(approve|approval) this/i,
    /needs (your|user) (approval|confirmation)/i,
    /would you like/i,
    /should i/i,
    /which (option|file|approach)/i
  ],
  claude: [
    /Claude is waiting/i,
    /Please (confirm|provide|enter|select)/i,
    /Permission needed/i,
    /awaiting (your )?approval/i,
    /(approve|approval) this/i,
    /I need (your|more) (input|information|confirmation)/i,
    /Would you like me to/i,
    /Should I (proceed|continue)/i,
    /\?\s*$/m
  ],
  codex: [
    /waiting for (user|input)/i,
    /please (confirm|select)/i,
    /permission required/i,
    /awaiting (your )?approval/i,
    /\?\s*$/m
  ],
  gemini: [
    /waiting for (user|input)/i,
    /please (confirm|select)/i,
    /permission required/i,
    /awaiting (your )?approval/i,
    /\?\s*$/m
  ]
};

const COMPLETE_PATTERNS: Record<AgentType, RegExp[]> = {
  opencode: [
    /task (completed|finished|done|complete)/i,
    /no further actions/i,
    /successfully (completed|finished)/i,
    /all done/i,
    /finished in \d+/i
  ],
  claude: [
    /task (completed|finished|done|complete)/i,
    /I('ve| have) (completed|finished)/i,
    /all done/i,
    /successfully completed/i
  ],
  codex: [
    /task (completed|finished|done|complete)/i,
    /successfully completed/i,
    /all done/i
  ],
  gemini: [
    /task (completed|finished|done|complete)/i,
    /successfully completed/i,
    /all done/i
  ]
};

const WORKING_PATTERNS: Record<AgentType, RegExp[]> = {
  opencode: [
    /thinking/i,
    /processing/i,
    /running (tool|command)/i,
    /executing/i,
    /analyzing/i,
    /reading file/i,
    /writing to/i,
    /searching/i,
    /building/i
  ],
  claude: [
    /thinking/i,
    /processing/i,
    /let me/i,
    /I'll/i,
    /I will/i,
    /analyzing/i,
    /searching/i
  ],
  codex: [
    /thinking/i,
    /processing/i,
    /analyzing/i
  ],
  gemini: [
    /thinking/i,
    /processing/i,
    /analyzing/i
  ]
};

export function classifyStatus(
  agentType: AgentType,
  recentContent: string,
  lastActivityMs: number
): AgentStatus {
  const content = recentContent.slice(-2000);
  
  const blockedPatterns = BLOCKED_PATTERNS[agentType] || [];
  const completePatterns = COMPLETE_PATTERNS[agentType] || [];
  const workingPatterns = WORKING_PATTERNS[agentType] || [];
  
  for (const pattern of blockedPatterns) {
    if (pattern.test(content)) {
      return 'blocked';
    }
  }
  
  for (const pattern of completePatterns) {
    if (pattern.test(content)) {
      return 'complete';
    }
  }
  
  if (lastActivityMs < 60000) {
    for (const pattern of workingPatterns) {
      if (pattern.test(content)) {
        return 'working';
      }
    }
    return 'working';
  }
  
  return 'idle';
}

export function getPatterns(agentType: AgentType): StatusPattern {
  return {
    blocked: BLOCKED_PATTERNS[agentType] || [],
    complete: COMPLETE_PATTERNS[agentType] || [],
    working: WORKING_PATTERNS[agentType] || []
  };
}
