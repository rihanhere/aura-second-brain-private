import type { MemoryIntent, MemoryIntentMode } from "./memoryIntentRouter.js";
import type { TemporalContextBundle, TemporalMemoryDebugItem } from "./temporalContextEngine.js";

type GovernedMemory = TemporalMemoryDebugItem & {
  conversationalRelevance: number;
  contaminationRisk: number;
  usefulness: number;
  decision: "selected" | "suppressed";
};

export type MemoryGovernorResult = {
  mode: "normal_companion" | "utility_recall";
  promptContext: string;
  selected: GovernedMemory[];
  suppressed: GovernedMemory[];
  debug: {
    mode: "normal_companion" | "utility_recall";
    selectedCount: number;
    suppressedCount: number;
    activeThread: string;
    entropyLevel: string;
    overallConfidence: number;
    newActiveSession: boolean;
    reasons: string[];
    selected: GovernedMemory[];
    suppressed: GovernedMemory[];
  };
};

function compact(text: string, max = 260) {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= max) return clean;
  return `${clean.slice(0, max - 3).trim()}...`;
}

function normalize(text: string) {
  return text.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();
}

function wordSet(text: string) {
  return new Set(normalize(text).split(" ").filter((word) => word.length > 2));
}

function overlapScore(query: string, text: string) {
  const queryWords = wordSet(query);
  if (!queryWords.size) return 0;
  const haystack = normalize(text);
  let hits = 0;
  for (const word of queryWords) if (haystack.includes(word)) hits += 1;
  return Math.min(1, hits / Math.min(queryWords.size, 8));
}

function topicLooksRelevant(query: string, item: TemporalMemoryDebugItem, activeThread: string) {
  const overlap = overlapScore(query, item.text);
  if (activeThread === "general") return overlap >= 0.55 && item.score >= 0.78;
  if (item.threadId === activeThread) return true;
  if (item.threadId === "general") return overlap >= 0.62 && item.score >= 0.82;
  return overlap >= 0.68 && item.score >= 0.88;
}

function contaminationRisk(query: string, item: TemporalMemoryDebugItem, newActiveSession: boolean) {
  const q = normalize(query);
  const text = normalize(item.text);
  let risk = 0;

  if (newActiveSession && !/\b(remember|recall|before|earlier|continue|last session|what were we talking|pichli|pehle)\b/i.test(query)) {
    risk += 0.28;
  }
  if (/\b(movie|series|netflix|episode|thriller|crime|mystery|show|music)\b/.test(text) && !/\b(movie|series|netflix|episode|thriller|crime|mystery|show|music)\b/.test(q)) {
    risk += 0.32;
  }
  if (/\b(test|testing|debug|build|ipa|vad|stt|tts|crash|fallback|sideloadly|xcode|voice)\b/.test(text) && !/\b(test|testing|debug|build|ipa|vad|stt|tts|crash|fallback|voice|aura|app)\b/.test(q)) {
    risk += 0.26;
  }
  if (/\b(currently|right now|abhi|watching|drinking|eating|sitting|outside|today i am)\b/.test(text) && !/\b(now|right now|abhi|today|continue|same|what were we)\b/.test(q)) {
    risk += 0.24;
  }
  if (/\b(repeat|same thing|loop|fresh answer|repair|stop repeating|bar bar|baar baar)\b/.test(text)) {
    risk += 0.35;
  }
  if (/\b(background noise|music|silence|no speech|inaudible|sounds of)\b/.test(text)) {
    risk += 0.45;
  }

  return Math.min(1, risk);
}

function usefulness(query: string, item: TemporalMemoryDebugItem, temporalContext: TemporalContextBundle) {
  const relevance = overlapScore(query, item.text);
  const threadBonus = item.threadId === temporalContext.activeThread ? 0.16 : item.threadId === "general" ? 0.05 : 0;
  const recencyBonus = item.recencyBucket === "just_now" ? 0.14
    : item.recencyBucket === "earlier_today" || item.recencyBucket === "this_morning" || item.recencyBucket === "this_afternoon" || item.recencyBucket === "tonight" ? 0.1
      : item.recencyBucket === "yesterday" || item.recencyBucket === "this_week" ? 0.05
        : 0;
  const confidenceBonus = temporalContext.confidence.overallConfidence * 0.12;
  return Math.min(1, item.score * 0.45 + relevance * 0.27 + threadBonus + recencyBonus + confidenceBonus);
}

function classify(item: TemporalMemoryDebugItem, input: {
  content: string;
  temporalContext: TemporalContextBundle;
  newActiveSession: boolean;
  recallMode: MemoryIntentMode;
}) {
  const conversationalRelevance = overlapScore(input.content, item.text);
  const risk = contaminationRisk(input.content, item, input.newActiveSession);
  const useful = usefulness(input.content, item, input.temporalContext);
  const sameThreadEnough = topicLooksRelevant(input.content, item, input.temporalContext.activeThread);
  const entropyPenalty = input.temporalContext.entropy.level === "high" ? 0.16 : input.temporalContext.entropy.level === "medium" ? 0.08 : 0;
  const highConfidence = input.temporalContext.confidence.overallConfidence >= 0.68;
  const lowEntropy = input.temporalContext.entropy.level === "low";
  const threshold = input.recallMode === "utility" ? 0.34 : input.newActiveSession ? 0.9 : 0.74;
  const score = useful - risk - entropyPenalty;
  const selected = input.recallMode === "utility"
    ? score >= threshold && risk < 0.72
    : highConfidence && lowEntropy && score >= threshold && risk < 0.22 && sameThreadEnough;

  return {
    ...item,
    conversationalRelevance: Number(conversationalRelevance.toFixed(3)),
    contaminationRisk: Number(risk.toFixed(3)),
    usefulness: Number(useful.toFixed(3)),
    score: Number(item.score.toFixed(3)),
    decision: selected ? "selected" as const : "suppressed" as const,
    reason: selected ? undefined : suppressionReason(item, risk, useful, sameThreadEnough, input.temporalContext.entropy.level, input.newActiveSession)
  };
}

function suppressionReason(
  item: TemporalMemoryDebugItem,
  risk: number,
  useful: number,
  sameThreadEnough: boolean,
  entropyLevel: string,
  newActiveSession: boolean
) {
  if (newActiveSession && risk >= 0.25) return "new_session_historical_only";
  if (risk >= 0.38) return "contamination_risk";
  if (!sameThreadEnough) return `different_thread:${item.threadId}`;
  if (entropyLevel === "high") return "high_entropy_simplified";
  if (useful < 0.58) return "low_conversational_usefulness";
  return item.reason ?? "governor_suppressed";
}

function analysisSummary(input: {
  memoryIntent: MemoryIntent;
  recallMode: MemoryIntentMode;
  explicitSaveIntent?: boolean;
  importance?: string;
  emotionalState?: string | null;
}) {
  return JSON.stringify({
    memoryIntent: input.memoryIntent,
    recallMode: input.recallMode,
    explicitSaveIntent: Boolean(input.explicitSaveIntent),
    importance: input.importance ?? null,
    emotionalState: input.emotionalState ?? null
  });
}

export function governMemoryForPrompt(input: {
  content: string;
  memoryIntent: MemoryIntent;
  recallMode: MemoryIntentMode;
  temporalContext: TemporalContextBundle;
  activeSessionContext: string;
  activeSessionGuidance: string;
  archiveContext: string;
  archiveAnswerHint: string;
  newActiveSession: boolean;
  analysis?: {
    explicitSaveIntent?: boolean;
    importance?: string;
    emotionalState?: string | null;
  };
}): MemoryGovernorResult {
  const mode = input.recallMode === "utility" ? "utility_recall" : "normal_companion";
  const rawSelected = input.temporalContext.debug.selectedMemories ?? [];
  const rawSuppressed = input.temporalContext.debug.suppressedMemories ?? [];
  const judged = [...rawSelected, ...rawSuppressed]
    .map((item) => classify(item, input))
    .sort((a, b) => {
      const left = a.usefulness - a.contaminationRisk;
      const right = b.usefulness - b.contaminationRisk;
      return right - left;
    });

  const selectedLimit = mode === "utility_recall"
    ? 8
    : input.newActiveSession || input.temporalContext.entropy.level !== "low" || input.temporalContext.confidence.overallConfidence < 0.68
      ? 0
      : 1;
  const selected = judged
    .filter((item) => item.decision === "selected")
    .slice(0, selectedLimit);
  const selectedKeys = new Set(selected.map((item) => `${item.source}|${item.text}|${item.score}`));
  const suppressed = judged
    .filter((item) => !selectedKeys.has(`${item.source}|${item.text}|${item.score}`))
    .map((item) => ({ ...item, decision: "suppressed" as const, reason: item.reason ?? "lower_ranked_after_governor" }))
    .slice(0, 18);

  const reasons = [
    input.newActiveSession ? "new_active_session: older sessions are historical only unless requested" : "",
    input.temporalContext.entropy.level === "high" ? "high_entropy: simplified to live context" : "",
    input.temporalContext.confidence.overallConfidence < 0.48 ? "low_confidence: memory softened/suppressed" : "",
    selected.length === 0 && mode === "normal_companion" ? "no_memory_injected_for_normal_chat" : ""
  ].filter(Boolean);

  const selectedHints = selected.map((item) =>
    `- ${compact(item.text, 190)} (thread=${item.threadId}; confidence=${Math.min(0.95, input.temporalContext.confidence.overallConfidence).toFixed(2)}; use softly)`
  );

  const promptContext = mode === "utility_recall"
    ? [
        "Memory governor mode: exact/utility recall.",
        "Use raw archive only for the explicit recall task. If there is no exact match, say that honestly.",
        `Active session:\n${compact(input.activeSessionContext, 900)}`,
        `Temporal state: thread=${input.temporalContext.activeThread}; energy=${input.temporalContext.energyState}; confidence=${input.temporalContext.confidence.overallConfidence.toFixed(2)}; entropy=${input.temporalContext.entropy.level}`,
        selectedHints.length ? `Selected memory candidates:\n${selectedHints.join("\n")}` : "Selected memory candidates: none.",
        input.archiveAnswerHint ? `Deterministic archive draft:\n${compact(input.archiveAnswerHint, 700)}` : "",
        input.archiveContext ? `Raw archive context:\n${compact(input.archiveContext, 1200)}` : "",
        `Analysis summary: ${analysisSummary({ ...input.analysis, memoryIntent: input.memoryIntent, recallMode: input.recallMode })}`
      ].filter(Boolean).join("\n")
    : [
        "Memory governor mode: normal companion.",
        "Use only this governor context for memory. Do not infer extra memories from hidden/archive systems.",
        input.newActiveSession
          ? "This is a fresh active app session. Older sessions are historical background only; do not continue them unless the user asks."
          : "Stay anchored in the active app session first.",
        `Active session:\n${compact(input.activeSessionContext, 1000)}`,
        input.activeSessionGuidance ? `Current correction/session guidance: ${compact(input.activeSessionGuidance, 480)}` : "",
        `Temporal state: thread=${input.temporalContext.activeThread}; energy=${input.temporalContext.energyState}; confidence=${input.temporalContext.confidence.overallConfidence.toFixed(2)}; entropy=${input.temporalContext.entropy.level}`,
        input.temporalContext.currentTruth.length ? `Current truth overrides: ${input.temporalContext.currentTruth.map((line) => compact(line, 130)).join(" / ")}` : "",
        input.temporalContext.staleWarnings.length ? `Stale-context suppressions: ${input.temporalContext.staleWarnings.join(" ")}` : "",
        selectedHints.length ? `Quiet memory hints, optional and invisible:\n${selectedHints.join("\n")}` : "Quiet memory hints: none. Answer from current message/session only.",
        `Analysis summary: ${analysisSummary({ ...input.analysis, memoryIntent: input.memoryIntent, recallMode: input.recallMode })}`
      ].filter(Boolean).join("\n");

  return {
    mode,
    promptContext,
    selected,
    suppressed,
    debug: {
      mode,
      selectedCount: selected.length,
      suppressedCount: suppressed.length,
      activeThread: input.temporalContext.activeThread,
      entropyLevel: input.temporalContext.entropy.level,
      overallConfidence: input.temporalContext.confidence.overallConfidence,
      newActiveSession: input.newActiveSession,
      reasons,
      selected,
      suppressed
    }
  };
}
