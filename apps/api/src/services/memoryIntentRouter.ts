import type { ReminderDraft } from "../types/domain.js";

export type MemoryIntent =
  | "normal_chat"
  | "goal_recall"
  | "user_history_recall"
  | "conversation_history_recall"
  | "pattern_recall"
  | "relationship_recall"
  | "profile_recall"
  | "reminder_recall"
  | "explicit_save"
  | "explicit_save_recall"
  | "emotional_support";

export type MemoryIntentMode = "utility" | "companion";

type DateRecallLike = {
  isRecall: boolean;
};

function hasQuestionShape(content: string) {
  return /\?/.test(content) || /^\s*(what|when|where|which|who|show|list|tell me|recall|remember|do you|did i|did we|have i|kya|kab|kaun|bata|dikhao)\b/i.test(content);
}

function isReminderRecall(content: string) {
  return /\b(what did|what have|what do|when did|show|list|recall|remember)\b.*\b(remind|reminder|yaad|check[-\s]?in|birthday|important today)\b/i.test(content)
    || /\bis there anything important\b/i.test(content);
}

function isExplicitSaveRecall(content: string) {
  return /\b(what did|what have|show|list|recall|remember)\b.*\b(explicitly\s+)?(ask|asked|tell|told)\b.*\b(save|saved|remember)\b/i.test(content)
    || /\bwhat did i explicitly ask you to\b/i.test(content);
}

function isRelationshipRecall(content: string) {
  return /\b(what do you remember|what did i say|what have i told|tell me what you remember|remember about|what do you know)\b.*\b(girlfriend|gf|boyfriend|bf|dad|father|papa|mother|mom|mummy|maa|friend|dost|cofounder|co-founder|family|boss|manager|team)\b/i.test(content);
}

function isGoalRecall(content: string) {
  return /\b(what(?:'s| is| are)?\s+my\s+(?:main\s+)?goals?|what am i (?:trying to )?(?:do|become|build|building|learn)|what do you remember about my goal|what is my direction|mera goal|meri goal|my goal kya|goal kya)\b/i.test(content)
    || /\b(what do you know about me)\b.*\b(goal|developer|career|build|learn)\b/i.test(content);
}

function isPatternRecall(content: string) {
  return /\b(what patterns?|pattern(?:s)? did you notice|what have you noticed|have i seemed|how have i been|emotional pattern|mood pattern|lately about me|recurring)\b/i.test(content);
}

function isProfileRecall(content: string) {
  return /\b(what do you remember about me|what do you know about me|tell me about me|who am i to you|what have you learned about me|do you remember my interests?|what are my interests?|summari[sz]e me)\b/i.test(content);
}

function isUserHistoryRecall(content: string) {
  return /\b(what did i|when did i|did i say|what have i told|what did i tell|what did i ask|maine kya|mene kya|maine kab|mene kab)\b/i.test(content);
}

function isConversationHistoryRecall(content: string) {
  return /\b(what did we talk|what were we talking|what have we talked|what did we discuss|our conversation|conversation history|we talked about|humne kya baat)\b/i.test(content);
}

function hasEmotionalSupportSignal(content: string) {
  return /\b(i feel|i'm feeling|i am feeling|sad|tired|stressed|anxious|angry|low|lonely|overwhelmed|stuck|confused|confidence|compare|comparison|motivation|motivate|quit|not good|thak|pareshan|dukhi|mann|man acha nahi|weird)\b/i.test(content);
}

export function classifyMemoryIntent(input: {
  content: string;
  dateRecall?: DateRecallLike | null;
  reminderDraft?: ReminderDraft | null;
  explicitSaveIntent?: boolean;
}): MemoryIntent {
  const content = input.content.trim();
  if (input.reminderDraft) return "reminder_recall";
  if (input.explicitSaveIntent) return "explicit_save";
  if (isReminderRecall(content)) return "reminder_recall";
  if (isExplicitSaveRecall(content)) return "explicit_save_recall";
  if (isRelationshipRecall(content)) return "relationship_recall";
  if (isGoalRecall(content)) return "goal_recall";
  if (isProfileRecall(content)) return "profile_recall";
  if (isPatternRecall(content)) return "pattern_recall";
  if (isConversationHistoryRecall(content)) return "conversation_history_recall";
  if (isUserHistoryRecall(content)) return "user_history_recall";
  if (input.dateRecall?.isRecall) {
    return /\b(we|our|humne)\b/i.test(content) ? "conversation_history_recall" : "user_history_recall";
  }
  if (hasQuestionShape(content) && /\b(recall|remember|history|archive|timestamp|date[-\s]?wise|what did|when did|did i say|did we talk)\b/i.test(content)) {
    return /\b(we|our|humne)\b/i.test(content) ? "conversation_history_recall" : "user_history_recall";
  }
  if (hasEmotionalSupportSignal(content)) return "emotional_support";
  return "normal_chat";
}

export function memoryIntentMode(intent: MemoryIntent): MemoryIntentMode {
  if (intent === "normal_chat" || intent === "emotional_support") return "companion";
  return "utility";
}

export function shouldUseExplicitRecallLanguage(intent: MemoryIntent) {
  return intent !== "normal_chat" && intent !== "emotional_support";
}
