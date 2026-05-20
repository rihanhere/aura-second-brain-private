import type { AgentToolCall } from "../types/domain.js";

function isReminderRecallQuestion(content: string) {
  const normalized = content.toLowerCase().trim();
  if (/\b(if today (?:were|was)|suppose today|agar aaj)\b/i.test(normalized)) return true;
  if (/\b(what|when|where|which|who|why|how)\b.*\b(remind|reminder|yaad|save|saved|remember|say)\b/i.test(normalized)) return true;
  if (/\b(what did|what have|did i|have i)\b.*\b(ask|tell|told)\b.*\b(remind|save|saved|remember|say)\b/i.test(normalized)) return true;
  return false;
}

export function inferAgentTool(content: string): AgentToolCall {
  if (/\breply normally\b/i.test(content)) {
    return { tool: "none", confidence: 0, payload: {} };
  }

  if (isReminderRecallQuestion(content)) {
    return { tool: "none", confidence: 0, payload: {} };
  }

  if (/\b(remind me|remind|reminder|remind kar|remind kr|yaad dilana|yaad dila|yaad kara|yaad karana|every \d+|every one|every two|every three|every four|every five|ask me if|ask me (?:in|after)|ask me .+ if|check if|check whether|check in|follow up)\b/i.test(content)) {
    return {
      tool: "create_reminder",
      confidence: 0.78,
      payload: { rawText: content }
    };
  }

  return { tool: "none", confidence: 0, payload: {} };
}
