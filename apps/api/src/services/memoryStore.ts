import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { env } from "../config/env.js";
import { supabase } from "../config/supabase.js";
import type { MemoryAnalysis } from "../types/domain.js";
import { conversationTurnsForIdleSummary, type ConversationTurn } from "./conversationArchive.js";
import { isScaleTestUser } from "./scaleTest.js";

const localMemories: Array<Record<string, unknown>> = [];
const scaleTestMemories: Array<Record<string, unknown>> = [];
const VECTOR_DIMENSIONS = env.geminiEmbeddingDimensions;
const SESSION_IDLE_MS = 5 * 60 * 1000;
const MAX_SCALE_TEST_MEMORIES = 250_000;
const apiDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const localMemoryPath = path.join(apiDir, "data", "local-memories.json");
let localMemoriesLoaded = false;

async function loadLocalMemories() {
  if (localMemoriesLoaded) return;
  localMemoriesLoaded = true;
  try {
    const raw = await fs.readFile(localMemoryPath, "utf8");
    const parsed = JSON.parse(raw) as Array<Record<string, unknown>>;
    localMemories.splice(0, localMemories.length, ...parsed);
  } catch {
    // First launch without Supabase starts with an empty local memory file.
  }
}

async function persistLocalMemories() {
  await fs.mkdir(path.dirname(localMemoryPath), { recursive: true });
  await fs.writeFile(localMemoryPath, JSON.stringify(localMemories.slice(0, 500), null, 2));
}

function normalizedEmbedding(embedding: number[]) {
  return embedding.length === VECTOR_DIMENSIONS ? embedding : null;
}

function keywordScore(query: string, memory: Record<string, unknown>) {
  const terms = query
    .toLowerCase()
    .split(/\W+/)
    .filter((term) => term.length > 2);
  const haystack = [
    memory.content,
    memory.summary,
    ...(Array.isArray(memory.auto_tags) ? memory.auto_tags : []),
    ...(Array.isArray(memory.recurring_topics) ? memory.recurring_topics : []),
    ...(Array.isArray(memory.goals) ? memory.goals : [])
  ]
    .join(" ")
    .toLowerCase();

  return terms.reduce((score, term) => score + (haystack.includes(term) ? 1 : 0), 0);
}

export async function saveMemory(userId: string, content: string, analysis: MemoryAnalysis, embedding: number[]) {
  const payload = {
    user_id: userId,
    content,
    summary: analysis.summary,
    emotional_state: analysis.emotionalState,
    goals: analysis.goals,
    action_items: analysis.actionItems,
    important_facts: analysis.importantFacts,
    recurring_topics: analysis.recurringTopics,
    habits: analysis.habits,
    priorities: analysis.priorities,
    auto_tags: analysis.autoTags,
    importance: analysis.importance,
    memory_layer: analysis.memoryLayer,
    embedding: normalizedEmbedding(embedding)
  };

  if (isScaleTestUser(userId)) {
    const memory = { id: crypto.randomUUID(), created_at: new Date().toISOString(), ...payload };
    scaleTestMemories.unshift(memory);
    if (scaleTestMemories.length > MAX_SCALE_TEST_MEMORIES) scaleTestMemories.length = MAX_SCALE_TEST_MEMORIES;
    return memory;
  }

  if (!supabase) {
    await loadLocalMemories();
    const memory = { id: crypto.randomUUID(), created_at: new Date().toISOString(), ...payload };
    localMemories.unshift(memory);
    await persistLocalMemories();
    return memory;
  }

  const { data, error } = await supabase.from("memories").insert(payload).select("*").single();
  if (error) throw error;
  return data;
}

export async function listMemories(userId: string) {
  if (isScaleTestUser(userId)) {
    return scaleTestMemories.filter((memory) => memory.user_id === userId).slice(0, 80);
  }

  if (!supabase) {
    await loadLocalMemories();
    return localMemories.filter((memory) => memory.user_id === userId).slice(0, 80);
  }

  const { data, error } = await supabase
    .from("memories")
    .select("*")
    .eq("user_id", userId)
    .neq("memory_layer", "archived")
    .order("created_at", { ascending: false })
    .limit(80);

  if (error) throw error;
  return data ?? [];
}

function memoryTime(memory: Record<string, unknown>) {
  return new Date(String(memory.created_at ?? 0)).getTime();
}

function asArray(value: unknown) {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function unique(values: string[]) {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}

function buildSessionSummary(memories: Array<Record<string, unknown>>) {
  const ordered = [...memories].sort((a, b) => memoryTime(a) - memoryTime(b));
  const summaries = ordered.map((memory) => String(memory.summary || memory.content || "")).filter(Boolean);
  const topics = unique(ordered.flatMap((memory) => asArray(memory.recurring_topics))).slice(0, 8);
  const goals = unique(ordered.flatMap((memory) => asArray(memory.goals))).slice(0, 5);
  const emotions = unique(ordered.map((memory) => String(memory.emotional_state || "")).filter(Boolean)).slice(0, 4);

  const headline = summaries.slice(0, 4).join(" / ");
  return {
    summary: headline.length > 260 ? `${headline.slice(0, 257)}...` : headline || "A reflective AURA session.",
    content: [
      `Session summary: ${headline || "A reflective AURA session."}`,
      topics.length ? `Recurring topics: ${topics.join(", ")}` : "",
      emotions.length ? `Emotional signal: ${emotions.join(", ")}` : "",
      goals.length ? `Goals mentioned: ${goals.join(" | ")}` : ""
    ].filter(Boolean).join("\n"),
    topics,
    goals,
    emotions
  };
}

function buildArchiveSessionSummary(turns: ConversationTurn[]) {
  const userTurns = turns.filter((turn) => turn.role === "user");
  const text = userTurns.map((turn) => turn.content).join(" / ");
  const headline = text.length > 280 ? `${text.slice(0, 277)}...` : text || "A reflective AURA conversation.";
  const topics = unique(
    userTurns.flatMap((turn) => turn.content.match(/\b(trading|fitness|work|health|family|money|study|sleep|career|relationship)\b/gi) ?? [])
      .map((topic) => topic.toLowerCase())
  ).slice(0, 8);

  return {
    summary: headline,
    content: [
      `Session summary: ${headline}`,
      topics.length ? `Recurring topics: ${topics.join(", ")}` : "",
      "Archived conversation turns:",
      ...turns.map((turn) => `${turn.role === "assistant" ? "AURA" : "User"}: ${turn.content}`)
    ].filter(Boolean).join("\n"),
    topics
  };
}

export async function maybeSummarizeIdleSession(userId: string) {
  const memories = (await listMemories(userId)) as Array<Record<string, unknown>>;
  const archiveTurns = await conversationTurnsForIdleSummary(userId, SESSION_IDLE_MS).catch(() => []);
  if (archiveTurns.length >= 2) {
    const latestTurn = archiveTurns[archiveTurns.length - 1];
    const latestSummary = memories.find((memory) => asArray(memory.auto_tags).includes("session-summary"));
    if (!latestSummary || memoryTime(latestSummary) < new Date(latestTurn.created_at).getTime()) {
      const archiveSummary = buildArchiveSessionSummary(archiveTurns);
      const analysis: MemoryAnalysis = {
        summary: archiveSummary.summary,
        emotionalState: null,
        goals: [],
        actionItems: [],
        importantFacts: [],
        recurringTopics: archiveSummary.topics,
        habits: [],
        priorities: [],
        autoTags: ["session-summary", "recall", "archive-summary"],
        importance: "medium",
        shouldStore: true,
        explicitSaveIntent: false,
        importantAutoMemory: true,
        memoryLayer: "session_summary"
      };

      return saveMemory(userId, archiveSummary.content, analysis, []);
    }
  }

  const timeline = memories
    .filter((memory) => !asArray(memory.auto_tags).includes("session-summary"))
    .sort((a, b) => memoryTime(b) - memoryTime(a));

  const latest = timeline[0];
  if (!latest) return null;
  if (Date.now() - memoryTime(latest) < SESSION_IDLE_MS) return null;

  const session = [latest];
  for (const candidate of timeline.slice(1, 12)) {
    const previous = session[session.length - 1];
    if (memoryTime(previous) - memoryTime(candidate) > SESSION_IDLE_MS) break;
    session.push(candidate);
  }

  const latestSummary = memories.find((memory) => asArray(memory.auto_tags).includes("session-summary"));
  if (latestSummary && memoryTime(latestSummary) > memoryTime(session[0])) return null;

  const sessionSummary = buildSessionSummary(session);
  const analysis: MemoryAnalysis = {
    summary: sessionSummary.summary,
    emotionalState: sessionSummary.emotions[0] ?? null,
    goals: sessionSummary.goals,
    actionItems: [],
    importantFacts: [],
    recurringTopics: sessionSummary.topics,
    habits: [],
    priorities: [],
    autoTags: ["session-summary", "recall"],
    importance: "medium",
    shouldStore: true,
    explicitSaveIntent: false,
    importantAutoMemory: true,
    memoryLayer: "session_summary"
  };

  return saveMemory(userId, sessionSummary.content, analysis, []);
}

export async function buildMemoryContext(userId: string, query: string, embedding: number[], limit = 8) {
  const [semantic, recent] = await Promise.all([
    searchMemories(userId, query, embedding, limit).catch(() => []),
    listMemories(userId).catch(() => [])
  ]);

  const scored = [...semantic, ...recent]
    .filter((memory, index, all) => index === all.findIndex((candidate) => candidate.id === memory.id))
    .map((memory) => {
      const tags = asArray((memory as Record<string, unknown>).auto_tags);
      const layer = String((memory as Record<string, unknown>).memory_layer ?? "");
      const importance = String((memory as Record<string, unknown>).importance ?? "");
      let score = 0;
      if (tags.includes("session-summary")) score += 4;
      if (layer === "session_summary") score += 4;
      if (layer === "core_profile") score += 5;
      if (layer === "pinned") score += 4;
      if (importance === "critical") score += 3;
      score += Math.max(0, 2 - (Date.now() - memoryTime(memory as Record<string, unknown>)) / (7 * 24 * 60 * 60 * 1000));
      return { memory, score };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ memory }) => memory);

  return scored
    .map((memory) => {
      const tags = asArray((memory as Record<string, unknown>).auto_tags);
      const layer = String((memory as Record<string, unknown>).memory_layer ?? "");
      const prefix = layer === "core_profile" ? "Core profile" : tags.includes("session-summary") || layer === "session_summary" ? "Session" : "Memory";
      const text = String((memory as Record<string, unknown>).summary || (memory as Record<string, unknown>).content || "");
      return `- ${prefix}: ${text}`;
    })
    .join("\n");
}

export async function searchMemories(userId: string, query: string, embedding: number[], limit = 10) {
  const fallback = async () => {
    const memories = await listMemories(userId);
    return memories
      .map((memory) => ({ memory, score: keywordScore(query, memory as Record<string, unknown>) }))
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((item) => item.memory);
  };

  if (!supabase || embedding.length !== VECTOR_DIMENSIONS) return fallback();

  const { data, error } = await supabase.rpc("match_memories", {
    query_embedding: embedding,
    match_user_id: userId,
    match_count: limit
  });

  if (error) {
    console.warn(`Memory vector search failed: ${error.message}`);
    return fallback();
  }

  return data ?? [];
}

export async function checkMemoryStore() {
  if (!supabase) {
    await loadLocalMemories();
    return {
      configured: false,
      reachable: true,
      persistence: "local_file",
      path: localMemoryPath
    };
  }

  try {
    const { error } = await supabase.from("memories").select("id", { count: "exact", head: true }).limit(1);
    return {
      configured: true,
      reachable: !error,
      persistence: error ? "configured_unreachable" : "persistent",
      error: error?.message
    };
  } catch (error) {
    return {
      configured: true,
      reachable: false,
      persistence: "configured_unreachable",
      error: error instanceof Error ? error.message : "Unknown Supabase error"
    };
  }
}
