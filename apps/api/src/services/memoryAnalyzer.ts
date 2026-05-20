import type { MemoryAnalysis } from "../types/domain.js";
import { hasNegatedMemoryCommand, isMemoryCapabilityQuestion } from "./memoryIntentRouter.js";

const goalWords = ["goal", "want to", "need to", "plan", "build", "learn", "improve", "focus", "trying", "become"];
const stressWords = ["stress", "anxious", "overwhelmed", "tired", "burned", "sad", "angry"];
const positiveWords = ["good", "calm", "excited", "happy", "proud", "motivated"];
const explicitSavePattern = /\b(save this|save it|save that|save karo|save kar|journal this|journal it|jarnel this|jarnal this|journal karo|journal kar|add to journal|note this|remember this|remember that|remember it|yaad rakh|yaad rakhna|memory mein|memory me|isko save|ye save|isey save|pin this)\b/i;

function includesAny(text: string, terms: string[]) {
  return terms.some((term) => text.includes(term));
}

function splitSignals(text: string) {
  return text
    .split(/[.;\n]/)
    .map((part) => part.trim())
    .filter(Boolean)
    .slice(0, 6);
}

export async function analyzeMemory(content: string): Promise<MemoryAnalysis> {
  const normalized = content.toLowerCase();
  const signals = splitSignals(content);
  const hasAction = /\b(remind|todo|to-do|need to|should|must|tomorrow|every|schedule)\b/i.test(content);
  const hasGoal = includesAny(normalized, goalWords);
  const hasEmotion = includesAny(normalized, [...stressWords, ...positiveWords]);
  const importantFacts = signals.filter((signal) => /\b(my|I am|I'm|I have|I work|I live|call me|I prefer|I like|I hate)\b/i.test(signal)).slice(0, 4);
  const hasStableProfileSignal = importantFacts.length > 0 || /\b(remember that|remember this|my name is|call me|i live|i work|i prefer|i like|i hate)\b/i.test(content);
  const explicitSaveIntent = explicitSavePattern.test(content) && !hasNegatedMemoryCommand(content) && !isMemoryCapabilityQuestion(content);
  const importantAutoMemory = !isMemoryCapabilityQuestion(content) && (hasAction || hasGoal || hasEmotion || hasStableProfileSignal || /\b(critical|urgent|deadline|doctor|health|money|family|relationship|work|job|career|trading|fitness|sleep|developer|coding|swift|vibe coding|aura app|aura project|build aura)\b/i.test(content));
  const shouldStore = content.trim().length > 8 && !/^(hi|hello|thanks|ok|okay)$/i.test(content.trim()) && (explicitSaveIntent || importantAutoMemory);

  const emotionalState = includesAny(normalized, stressWords)
    ? "strained"
    : includesAny(normalized, positiveWords)
      ? "positive"
      : null;

  return {
    summary: signals[0] ?? content.slice(0, 120),
    emotionalState,
    goals: hasGoal ? signals.filter((signal) => includesAny(signal.toLowerCase(), goalWords)).slice(0, 3) : [],
    actionItems: hasAction ? signals.filter((signal) => /\b(remind|todo|need|should|must|schedule)\b/i.test(signal)).slice(0, 3) : [],
    importantFacts,
    recurringTopics: Array.from(new Set(content.match(/\b(trading|fitness|work|health|family|money|study|sleep|developer|coding|swift|aura|memory|voice|reminder)\b/gi) ?? [])).map((topic) => topic.toLowerCase()),
    habits: signals.filter((signal) => /\b(every day|daily|weekly|habit|routine|always|often)\b/i.test(signal)).slice(0, 3),
    priorities: signals.filter((signal) => /\b(priority|important|urgent|critical|focus)\b/i.test(signal)).slice(0, 3),
    autoTags: [
      explicitSaveIntent ? "explicit-save" : null,
      hasAction ? "action" : null,
      hasGoal ? "goal" : null,
      hasEmotion ? "emotion" : null,
      hasStableProfileSignal ? "core-profile" : null
    ].filter(Boolean) as string[],
    importance: /\b(critical|urgent|deadline|doctor|health|money|family)\b/i.test(content)
      ? "critical"
      : hasAction || hasGoal || hasEmotion
        ? "medium"
        : "low",
    shouldStore,
    explicitSaveIntent,
    importantAutoMemory,
    memoryLayer: /\b(pin|remember this|important)\b/i.test(content) ? "pinned" : hasStableProfileSignal ? "core_profile" : "episodic"
  };
}
