import { formatInTimeZone, toZonedTime } from "date-fns-tz";
import type { MemoryAnalysis } from "../types/domain.js";
import type { ConversationTurn } from "./conversationArchive.js";
import { listConversationTurns } from "./conversationArchive.js";
import { compactText, compressContextSectionsWithBudget, estimateTokens, summarizeTurnsForPrompt } from "./contextCompressor.js";
import { listMemoryAtoms } from "./memoryAtoms.js";
import { listMemories } from "./memoryStore.js";
import type { MemoryIntent, MemoryIntentMode } from "./memoryIntentRouter.js";
import { recentAssistantReplyMemory } from "./assistantReplyMemory.js";
import { cognitionProfilePrompt, getUserCognitionProfile } from "./userCognitionProfile.js";

export type RecencyBucket =
  | "just_now"
  | "earlier_today"
  | "this_morning"
  | "this_afternoon"
  | "tonight"
  | "yesterday"
  | "this_week"
  | "recently"
  | "a_while_ago"
  | "months_ago";

export type EnergyState = "playful" | "analytical" | "exhausted" | "emotional" | "excited" | "quiet" | "focused";

export type CognitiveConfidence = {
  memoryConfidence: number;
  temporalConfidence: number;
  threadConfidence: number;
  emotionalConfidence: number;
  overallConfidence: number;
};

export type ConversationEntropy = {
  score: number;
  level: "low" | "medium" | "high";
  activeThreadCount: number;
  topicSwitches: number;
  unresolvedEmotionalStates: number;
  contradictionCount: number;
  memoryCompetition: number;
  repairAttempts: number;
  contextBudgetPressure: number;
};

export type CognitionLatency = {
  recentSessionLoadMs: number;
  memoryScoringMs: number;
  compressionMs: number;
  totalMs: number;
  budgetExceeded: boolean;
};

export type TemporalMemoryDebugItem = {
  source: string;
  text: string;
  threadId: string;
  recencyBucket: RecencyBucket;
  score: number;
  reason?: string;
};

export type TemporalContextBundle = {
  promptContext: string;
  activeThread: string;
  energyState: EnergyState;
  currentTruth: string[];
  correctionGuidance: string;
  staleWarnings: string[];
  confidence: CognitiveConfidence;
  entropy: ConversationEntropy;
  latency: CognitionLatency;
  safeDegradationReason: string | null;
  contextTokens: number;
  debug: {
    activeThread: string;
    energyState: EnergyState;
    selectedMemoryCount: number;
    buckets: Record<string, number>;
    currentTruth: string[];
    staleWarnings: string[];
    confidence: CognitiveConfidence;
    entropy: ConversationEntropy;
    latency: CognitionLatency;
    safeDegradationReason: string | null;
    contextTokens: number;
    trimmedSections: string[];
    adaptationConfidence: number;
    selectedMemories: TemporalMemoryDebugItem[];
    suppressedMemories: TemporalMemoryDebugItem[];
  };
};

type Candidate = {
  source: string;
  text: string;
  createdAt: string;
  updatedAt: string;
  threadId: string;
  recencyBucket: RecencyBucket;
  semanticScore: number;
  recencyScore: number;
  threadScore: number;
  activeScore: number;
  emotionalScore: number;
  salienceScore: number;
  contradictionPenalty: number;
  finalScore: number;
};

const threadTerms: Record<string, string[]> = {
  work: ["work", "job", "office", "boss", "career", "task", "meeting"],
  coding: ["coding", "code", "developer", "swift", "backend", "frontend", "github", "xcode"],
  aura: ["aura", "app", "voice", "memory", "stt", "tts", "assistant", "ipa"],
  relationship: ["girlfriend", "friend", "dad", "father", "mother", "mom", "family", "relationship"],
  sleep: ["sleep", "tired", "exhausted", "night", "morning", "wake", "bed"],
  health: ["water", "weed", "smoke", "health", "fitness", "drink"],
  entertainment: ["movie", "series", "netflix", "show", "thriller", "crime", "music"],
  emotional: ["feel", "sad", "stressed", "low", "confused", "stuck", "angry", "better", "motivation"],
  business: ["startup", "launch", "users", "profit", "cost", "subscription", "scale"]
};

function normalize(text: string) {
  return text.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();
}

function terms(text: string) {
  return normalize(text).split(" ").filter((term) => term.length > 2);
}

function keywordScore(query: string, text: string) {
  const haystack = normalize(text);
  const queryTerms = terms(query);
  if (!queryTerms.length) return 0;
  const hits = queryTerms.filter((term) => haystack.includes(term)).length;
  return Math.min(1, hits / Math.max(1, Math.min(queryTerms.length, 8)));
}

function detectThread(text: string, fallback = "general") {
  return detectThreadSignal(text, fallback).thread;
}

function detectThreadSignal(text: string, fallback = "general") {
  const lower = normalize(text);
  let best = { thread: fallback, hits: 0, confidence: 0.25 };
  for (const [thread, words] of Object.entries(threadTerms)) {
    const hits = words.filter((word) => lower.includes(word)).length;
    if (hits > best.hits) best = { thread, hits, confidence: Math.min(0.95, 0.35 + hits * 0.18) };
  }
  return best;
}

function detectEnergy(text: string, analysis?: MemoryAnalysis | null): EnergyState {
  const lower = normalize(`${text} ${analysis?.emotionalState ?? ""}`);
  if (/\b(joke|funny|lol|haha|play|chill)\b/.test(lower)) return "playful";
  if (/\b(explain|analyze|plan|logic|technical|architecture)\b/.test(lower)) return "analytical";
  if (/\b(tired|exhausted|sleepy|drained|thak)\b/.test(lower)) return "exhausted";
  if (/\b(sad|hurt|low|stressed|anxious|confused|stuck|feel)\b/.test(lower)) return "emotional";
  if (/\b(excited|great|amazing|pumped|happy)\b/.test(lower)) return "excited";
  if (/\b(focus|work|coding|build|task)\b/.test(lower)) return "focused";
  return "quiet";
}

function recencyBucket(date: Date, timezone: string, now: Date): RecencyBucket {
  const ageMs = now.getTime() - date.getTime();
  if (ageMs <= 5 * 60 * 1000) return "just_now";
  const zone = timezone || "UTC";
  const localNow = toZonedTime(now, zone);
  const localDate = toZonedTime(date, zone);
  const dayKey = formatInTimeZone(date, zone, "yyyy-MM-dd");
  const todayKey = formatInTimeZone(now, zone, "yyyy-MM-dd");
  const yesterday = new Date(localNow.getFullYear(), localNow.getMonth(), localNow.getDate() - 1);
  const yesterdayKey = formatInTimeZone(yesterday, zone, "yyyy-MM-dd");

  if (dayKey === todayKey) {
    const hour = localDate.getHours();
    if (hour < 12) return "this_morning";
    if (hour < 17) return "this_afternoon";
    if (hour >= 20) return "tonight";
    return "earlier_today";
  }
  if (dayKey === yesterdayKey) return "yesterday";
  if (ageMs <= 7 * 24 * 60 * 60 * 1000) return "this_week";
  if (ageMs <= 30 * 24 * 60 * 60 * 1000) return "recently";
  if (ageMs <= 180 * 24 * 60 * 60 * 1000) return "a_while_ago";
  return "months_ago";
}

function recencyWeight(bucket: RecencyBucket) {
  return ({
    just_now: 1,
    earlier_today: 0.9,
    this_morning: 0.82,
    this_afternoon: 0.84,
    tonight: 0.88,
    yesterday: 0.7,
    this_week: 0.52,
    recently: 0.36,
    a_while_ago: 0.18,
    months_ago: 0.08
  } satisfies Record<RecencyBucket, number>)[bucket];
}

function extractCurrentTruth(turns: ConversationTurn[], userText: string) {
  const userTurns = turns.filter((turn) => turn.role === "user").slice(0, 8);
  const truth: string[] = [];
  const currentSignals = [userText, ...userTurns.map((turn) => turn.content)];
  for (const line of currentSignals) {
    if (/\b(now|right now|currently|abhi|aaj|today|tonight)\b/i.test(line) || /^(actually|no|nahi|i mean|matlab)\b/i.test(line.trim())) {
      truth.push(compactText(line, 180));
    }
  }
  return Array.from(new Set(truth)).slice(0, 5);
}

function staleWarningsFromTruth(currentTruth: string[]) {
  const joined = currentTruth.join(" ").toLowerCase();
  const warnings: string[] = [];
  if (/\b(feel better|better now|good now|calm now|fine now)\b/.test(joined)) {
    warnings.push("Do not frame the user as currently exhausted/sad/stuck unless the latest message says so.");
  }
  if (/\b(working now|work now|coding now|focus now)\b/.test(joined)) {
    warnings.push("Treat older movie/chill context as historical; current focus is work/coding.");
  }
  if (/\b(not that|wrong|galat|i mean|matlab|actually)\b/.test(joined)) {
    warnings.push("A recent correction exists. Current correction overrides older memory wording.");
  }
  return warnings;
}

function candidateFromMemory(memory: Record<string, unknown>, query: string, activeThread: string, timezone: string, now: Date): Candidate {
  const text = String(memory.summary || memory.content || "");
  const createdAt = String(memory.created_at ?? now.toISOString());
  const updatedAt = String(memory.updated_at ?? createdAt);
  const layer = String(memory.memory_layer ?? "");
  const tags = Array.isArray(memory.auto_tags) ? memory.auto_tags.map(String) : [];
  const threadId = detectThread(`${text} ${tags.join(" ")}`, "general");
  const bucket = recencyBucket(new Date(updatedAt), timezone, now);
  const semanticScore = keywordScore(query, text);
  const recencyScore = recencyWeight(bucket);
  const threadScore = threadId === activeThread ? 1 : threadId === "general" ? 0.35 : 0.05;
  const activeScore = layer === "quick_memory" ? 1 : layer === "recent_memory" ? 0.82 : layer === "daily_summary" ? 0.65 : layer === "weekly_summary" ? 0.45 : layer === "long_term_summary" ? 0.35 : layer === "core_profile" ? 0.55 : 0.2;
  const emotionalScore = /\b(tired|stress|sad|excited|calm|motivated|confused|stuck)\b/i.test(text) ? 0.65 : 0.15;
  const importance = String(memory.importance ?? "") === "critical" ? 1 : String(memory.importance ?? "") === "medium" ? 0.65 : 0.3;
  const salienceScore = Math.max(importance, emotionalScore, activeScore * 0.7);
  const contradictionPenalty = tags.includes("product-learning") || layer === "archived" ? 0.6 : 0;
  const finalScore = semanticScore * 0.35 + recencyScore * 0.25 + threadScore * 0.2 + activeScore * 0.15 + emotionalScore * 0.05 + salienceScore * 0.1 - contradictionPenalty;
  return { source: `memory:${layer || "unknown"}`, text, createdAt, updatedAt, threadId, recencyBucket: bucket, semanticScore, recencyScore, threadScore, activeScore, emotionalScore, salienceScore, contradictionPenalty, finalScore };
}

function candidateFromAtom(atom: Record<string, unknown>, query: string, activeThread: string, timezone: string, now: Date): Candidate {
  const text = String(atom.text ?? "");
  const createdAt = String(atom.createdAt ?? atom.created_at ?? now.toISOString());
  const updatedAt = String(atom.lastMentionedAt ?? atom.updatedAt ?? createdAt);
  const threadId = String(atom.threadId ?? detectThread(`${text} ${(atom.topics as string[] | undefined)?.join(" ") ?? ""}`, "general"));
  const bucket = recencyBucket(new Date(updatedAt), timezone, now);
  const semanticScore = keywordScore(query, text);
  const recencyScore = recencyWeight(bucket);
  const threadScore = threadId === activeThread ? 1 : threadId === "general" ? 0.3 : 0.05;
  const activeScore = atom.activeState === false || atom.status === "historical" ? 0.15 : 0.75;
  const emotionalScore = typeof atom.emotion === "string" ? 0.75 : 0.15;
  const salienceScore = Number(atom.salienceScore ?? atom.importance ?? 0.35);
  const contradictionPenalty = atom.contradictionState === "contradicted" || atom.status === "changed" ? 0.45 : atom.status === "resolved" ? 0.25 : 0;
  const finalScore = semanticScore * 0.35 + recencyScore * 0.25 + threadScore * 0.2 + activeScore * 0.15 + emotionalScore * 0.05 + salienceScore * 0.1 - contradictionPenalty;
  return { source: `atom:${String(atom.type ?? "memory")}`, text, createdAt, updatedAt, threadId, recencyBucket: bucket, semanticScore, recencyScore, threadScore, activeScore, emotionalScore, salienceScore, contradictionPenalty, finalScore };
}

function temporalLanguageGuidance(bucket: RecencyBucket) {
  if (bucket === "just_now") return "If needed, refer to this as just now.";
  if (bucket === "this_morning") return "If needed, say this morning.";
  if (bucket === "this_afternoon") return "If needed, say this afternoon.";
  if (bucket === "tonight") return "If needed, say tonight.";
  if (bucket === "yesterday") return "If needed, say yesterday.";
  if (bucket === "this_week") return "If needed, say this week or lately.";
  return "Avoid exact timing unless user asks.";
}

function candidateDebug(candidate: Candidate, reason?: string): TemporalMemoryDebugItem {
  return {
    source: candidate.source,
    text: compactText(candidate.text, 260),
    threadId: candidate.threadId,
    recencyBucket: candidate.recencyBucket,
    score: Number(candidate.finalScore.toFixed(3)),
    ...(reason ? { reason } : {})
  };
}

function confidenceGuidance(confidence: CognitiveConfidence, mode: MemoryIntentMode) {
  if (mode === "utility") return "Utility recall mode: exact archive facts may be stated precisely when present.";
  if (confidence.overallConfidence >= 0.75) {
    return "Confidence is high: use temporal continuity naturally, without proving memory.";
  }
  if (confidence.overallConfidence >= 0.48) {
    return "Confidence is medium: use soft language like 'seems', 'around', 'lately', or 'I think' if referencing memory.";
  }
  return "Confidence is low: do not state memory as fact. Let uncertain memory only shape tone, or say you can search deeper if the user wants.";
}

function scoreConfidence(input: {
  candidates: Candidate[];
  currentTruth: string[];
  staleWarnings: string[];
  threadSignal: { thread: string; hits: number; confidence: number };
  energyState: EnergyState;
  analysis: MemoryAnalysis;
  entropyScore: number;
  recallMode: MemoryIntentMode;
}): CognitiveConfidence {
  const top = input.candidates[0]?.finalScore ?? 0;
  const memoryConfidence = input.candidates.length ? Math.max(0.25, Math.min(0.95, top)) : 0.25;
  const temporalConfidence = Math.min(0.95, 0.38 + input.currentTruth.length * 0.12 + input.staleWarnings.length * 0.1 + (input.candidates.some((item) => item.recencyBucket !== "months_ago") ? 0.12 : 0));
  const threadConfidence = input.threadSignal.confidence;
  const emotionalConfidence = input.analysis.emotionalState || input.energyState === "emotional" || input.energyState === "exhausted"
    ? 0.72
    : input.energyState === "quiet" ? 0.42 : 0.58;
  const entropyPenalty = Math.min(0.25, input.entropyScore * 0.25);
  const exactBoost = input.recallMode === "utility" ? 0.08 : 0;
  const overallConfidence = Math.max(0.1, Math.min(0.95, (memoryConfidence + temporalConfidence + threadConfidence + emotionalConfidence) / 4 + exactBoost - entropyPenalty));
  return { memoryConfidence, temporalConfidence, threadConfidence, emotionalConfidence, overallConfidence };
}

function entropyLevel(score: number): ConversationEntropy["level"] {
  if (score >= 0.72) return "high";
  if (score >= 0.45) return "medium";
  return "low";
}

function scoreEntropy(input: {
  sessionTurns: ConversationTurn[];
  candidates: Candidate[];
  staleWarnings: string[];
  assistantReplies: Array<{ repair: boolean }>;
  estimatedTokensBeforeCompression: number;
}) {
  const userTurns = input.sessionTurns.filter((turn) => turn.role === "user").slice(-10);
  const threads = userTurns.map((turn) => detectThread(turn.content, "general"));
  const activeThreadCount = new Set(threads.filter((thread) => thread !== "general")).size;
  const topicSwitches = threads.reduce((count, thread, index) => index > 0 && thread !== threads[index - 1] ? count + 1 : count, 0);
  const unresolvedEmotionalStates = userTurns.filter((turn) => /\b(tired|sad|stressed|angry|low|stuck|confused|hurt)\b/i.test(turn.content)).length;
  const contradictionCount = input.staleWarnings.length + input.candidates.filter((candidate) => candidate.contradictionPenalty > 0).length;
  const topScore = input.candidates[0]?.finalScore ?? 0;
  const memoryCompetition = input.candidates.filter((candidate) => topScore > 0 && topScore - candidate.finalScore <= 0.08).length;
  const repairAttempts = input.assistantReplies.filter((reply) => reply.repair).length;
  const contextBudgetPressure = Math.min(1, input.estimatedTokensBeforeCompression / 1800);
  const score = Math.min(1,
    activeThreadCount * 0.09 +
    topicSwitches * 0.07 +
    unresolvedEmotionalStates * 0.05 +
    contradictionCount * 0.08 +
    memoryCompetition * 0.06 +
    repairAttempts * 0.08 +
    contextBudgetPressure * 0.18
  );
  return {
    score,
    level: entropyLevel(score),
    activeThreadCount,
    topicSwitches,
    unresolvedEmotionalStates,
    contradictionCount,
    memoryCompetition,
    repairAttempts,
    contextBudgetPressure
  } satisfies ConversationEntropy;
}

export async function buildTemporalContextBundle(input: {
  userId: string;
  sessionId: string;
  content: string;
  timezone: string;
  createdAt: Date;
  memoryIntent: MemoryIntent;
  recallMode: MemoryIntentMode;
  analysis: MemoryAnalysis;
  activeSessionContext: string;
  activeSessionGuidance: string;
  companionContinuity: string;
  companionMemoryContext: string;
  archiveContext: string;
  archiveAnswerHint: string;
  excludeTurnId?: string | null;
}) {
  const startedAt = Date.now();
  const loadStartedAt = Date.now();
  const [turns, memories, atoms, assistantReplies, cognitionProfile] = await Promise.all([
    listConversationTurns(input.userId, 80).catch(() => []),
    listMemories(input.userId).catch(() => []),
    listMemoryAtoms(input.userId, 180).catch(() => []),
    recentAssistantReplyMemory(input.userId, input.sessionId, 8).catch(() => []),
    getUserCognitionProfile(input.userId).catch(() => null)
  ]);
  const recentSessionLoadMs = Date.now() - loadStartedAt;

  const sessionTurns = turns
    .filter((turn) => turn.session_id === input.sessionId && turn.id !== input.excludeTurnId)
    .slice(0, 20)
    .reverse();
  const currentThreadSignal = detectThreadSignal(input.content, "general");
  const sessionThreadSignal = detectThreadSignal(sessionTurns.slice(-4).map((turn) => turn.content).join(" "), "general");
  const threadSignal = currentThreadSignal.thread !== "general" ? currentThreadSignal : sessionThreadSignal;
  const activeThread = threadSignal.thread;
  const energyState = detectEnergy(`${input.content} ${sessionTurns.slice(-3).map((turn) => turn.content).join(" ")}`, input.analysis);
  const currentTruth = extractCurrentTruth(turns, input.content);
  const staleWarnings = staleWarningsFromTruth(currentTruth);
  const scoringStartedAt = Date.now();
  const rawCandidates = [
    ...(memories as Array<Record<string, unknown>>).map((memory) => candidateFromMemory(memory, input.content, activeThread, input.timezone, input.createdAt)),
    ...(atoms as Array<Record<string, unknown>>).map((atom) => candidateFromAtom(atom, input.content, activeThread, input.timezone, input.createdAt))
  ]
    .filter((candidate) => candidate.text.trim().length > 0)
    .sort((a, b) => b.finalScore - a.finalScore);
  const allCandidates = rawCandidates
    .filter((candidate) => input.recallMode === "utility" || candidate.finalScore >= 0.32);
  const memoryScoringMs = Date.now() - scoringStartedAt;

  const estimatedTokensBeforeCompression = estimateTokens([
    summarizeTurnsForPrompt(sessionTurns, 10),
    input.companionMemoryContext,
    input.companionContinuity,
    allCandidates.slice(0, 10).map((candidate) => candidate.text).join(" ")
  ].join("\n"));
  const entropy = scoreEntropy({
    sessionTurns,
    candidates: allCandidates,
    staleWarnings,
    assistantReplies,
    estimatedTokensBeforeCompression
  });
  const entropyDegraded = input.recallMode === "companion" && entropy.level === "high";
  const candidates = allCandidates.slice(0, entropyDegraded ? 2 : input.recallMode === "utility" ? 10 : 6);
  const candidateKeys = new Set(candidates.map((candidate) => `${candidate.source}|${candidate.text}|${candidate.updatedAt}`));
  const selectedMemories = candidates.map((candidate) => candidateDebug(candidate));
  const suppressedMemories = rawCandidates
    .filter((candidate) => !candidateKeys.has(`${candidate.source}|${candidate.text}|${candidate.updatedAt}`))
    .slice(0, 16)
    .map((candidate) => candidateDebug(
      candidate,
      input.recallMode !== "utility" && candidate.finalScore < 0.32
        ? "below_companion_threshold"
        : entropyDegraded
          ? "high_entropy_trimmed"
          : "lower_ranked"
    ));
  const confidence = scoreConfidence({
    candidates,
    currentTruth,
    staleWarnings,
    threadSignal,
    energyState,
    analysis: input.analysis,
    entropyScore: entropy.score,
    recallMode: input.recallMode
  });

  const buckets = candidates.reduce<Record<string, number>>((acc, candidate) => {
    acc[candidate.recencyBucket] = (acc[candidate.recencyBucket] ?? 0) + 1;
    return acc;
  }, {});

  const selectedMemoryLines = candidates.map((candidate) =>
    `- ${candidate.source}; thread=${candidate.threadId}; ${candidate.recencyBucket}; score=${candidate.finalScore.toFixed(2)}: ${compactText(candidate.text, 220)} (${temporalLanguageGuidance(candidate.recencyBucket)})`
  ).join("\n");

  const repairPhrases = assistantReplies
    .map((reply) => reply.opening)
    .filter(Boolean)
    .slice(0, 5)
    .join(" / ");

  const compressionStartedAt = Date.now();
  const safeDegradationReason = entropyDegraded ? "high_conversation_entropy" : null;
  const compression = compressContextSectionsWithBudget([
    { label: "Working context (highest priority)", content: summarizeTurnsForPrompt(sessionTurns, 10) || "No earlier turns in this app session.", priority: 100, maxChars: 1100 },
    { label: "Current truth overrides", content: currentTruth.join(" / "), priority: 95, maxChars: 520 },
    { label: "Current topic thread", content: `${activeThread}; energy=${energyState}`, priority: 92, maxChars: 120 },
    { label: "Cognitive confidence", content: `${confidenceGuidance(confidence, input.recallMode)} Confidence=${confidence.overallConfidence.toFixed(2)} memory=${confidence.memoryConfidence.toFixed(2)} temporal=${confidence.temporalConfidence.toFixed(2)} thread=${confidence.threadConfidence.toFixed(2)} emotional=${confidence.emotionalConfidence.toFixed(2)}`, priority: 91, maxChars: 420 },
    { label: "Conversation entropy", content: `level=${entropy.level}; score=${entropy.score.toFixed(2)}; ${safeDegradationReason ? `safe degradation active: ${safeDegradationReason}` : "normal context selection"}`, priority: 90, maxChars: 280 },
    { label: "Correction/stale protection", content: [...staleWarnings, input.activeSessionGuidance].filter(Boolean).join(" "), priority: 90, maxChars: 700 },
    { label: "Per-user adaptation", content: cognitionProfile ? cognitionProfilePrompt(cognitionProfile) : "", priority: 88, maxChars: 480 },
    { label: "Competing selected memories", content: selectedMemoryLines, priority: input.recallMode === "utility" ? 86 : 68, maxChars: input.recallMode === "utility" ? 1200 : 820 },
    { label: "Companion summaries", content: entropyDegraded ? "" : input.companionMemoryContext, priority: 64, maxChars: 780 },
    { label: "Emotional continuity", content: entropyDegraded ? "" : input.companionContinuity, priority: 58, maxChars: 620 },
    { label: "Recent assistant openings to avoid", content: repairPhrases, priority: 54, maxChars: 260 },
    { label: "Deep archive", content: input.recallMode === "utility" ? input.archiveContext : "", priority: 46, maxChars: 1000 },
    { label: "Archive deterministic draft", content: input.recallMode === "utility" ? input.archiveAnswerHint : "", priority: 44, maxChars: 700 }
  ], input.recallMode === "utility" ? 2200 : 1800);
  const compressionMs = Date.now() - compressionStartedAt;
  const totalMs = Date.now() - startedAt;
  const latency = {
    recentSessionLoadMs,
    memoryScoringMs,
    compressionMs,
    totalMs,
    budgetExceeded: recentSessionLoadMs > 150 || memoryScoringMs > 200 || compressionMs > 100 || totalMs > 800
  } satisfies CognitionLatency;

  console.log("[temporal-cognition]", {
    userId: input.userId,
    activeThread,
    energyState,
    confidence,
    entropy,
    selectedMemoryCount: candidates.length,
    contextTokens: compression.stats.estimatedTokens,
    trimmedSections: compression.stats.trimmedSections,
    safeDegradationReason,
    latency
  });

  return {
    promptContext: compression.text,
    activeThread,
    energyState,
    currentTruth,
    correctionGuidance: staleWarnings.join(" "),
    staleWarnings,
    confidence,
    entropy,
    latency,
    safeDegradationReason,
    contextTokens: compression.stats.estimatedTokens,
    debug: {
      activeThread,
      energyState,
      selectedMemoryCount: candidates.length,
      buckets,
      currentTruth,
      staleWarnings,
      confidence,
      entropy,
      latency,
      safeDegradationReason,
	  contextTokens: compression.stats.estimatedTokens,
	  trimmedSections: compression.stats.trimmedSections,
	  adaptationConfidence: cognitionProfile?.confidence ?? 0,
	  selectedMemories,
	  suppressedMemories
	  }
  } satisfies TemporalContextBundle;
}
