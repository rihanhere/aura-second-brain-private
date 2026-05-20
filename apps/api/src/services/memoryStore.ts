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
const QUICK_MEMORY_REFRESH_TURNS = 4;
const DAILY_MEMORY_REFRESH_TURNS = 3;
const WEEKLY_MEMORY_REFRESH_DAILY_SUMMARIES = 2;
const LONG_MEMORY_REFRESH_WEEKLY_SUMMARIES = 1;
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

function turnContent(turns: ConversationTurn[]) {
  return turns
    .filter((turn) => turn.role === "user")
    .map((turn) => turn.content.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

function isExplicitMemoryLine(line: string) {
  return /\b(save this|remember this|journal this|note this|pin this|don't forget|do not forget|yaad rakh|yaad rakhna)\b/i.test(line);
}

function isMemoryPromotionNoise(line: string) {
  const lower = line.toLowerCase();
  if (/^\s*(hmm+|hm+|umm+|uh+|haan|ha|ok|okay|acha|achha|huh|nice|cool)\s*\.?$/i.test(line)) return true;
  if (/\[(?:music|sound|silence|noise|inaudible|background)[^\]]*\]/i.test(line)) return true;
  if (/\b(background noise|no speech|can't hear|can you hear|are you listening|hello aura|hi aura|mic test|voice test)\b/i.test(line)) return true;
  if (/\b(repeat|same thing|same line|loop|repair|bar bar|baar baar|again and again|fresh answer)\b/i.test(line)) return true;
  if (/\b(answer normally|reply normally|normal answer|seedha jawab|simple bol|simple answer)\b/i.test(line)) return true;
  if (/\b(did i ever mention|did i tell|have i told|do you remember|what do you remember|what do you know about me|what were we talking|what was i saying|recall|remember about)\b/i.test(line)
    && !isExplicitMemoryLine(line)) {
    return true;
  }
  if (/\b(debug|regression|sideloadly|ipa|xcode|crash log|fallback|preflight|vad|stt|tts|supertonic|pockettts|whisperkit|streaming|endpoint|barge.?in|build log)\b/i.test(line)
    && !/\b(my goal|product goal|launch goal|users?|customer|roadmap|architecture|business|moat|i am building|i'm building|we are building|building aura|developing aura|voice assistant)\b/i.test(line)) {
    return true;
  }
  if (/\b(movie|web series|series|netflix|episode|actor|thriller|crime|mystery|show|music|song|track|album|game|match|level)\b/i.test(line)
    && !/\b(i like|i love|i prefer|favorite|favourite|my taste|i usually|always|often|pattern|save this|remember this|goal)\b/i.test(line)) {
    return true;
  }
  if (/\b(tired|exhausted|drained|stressed|sad|low|angry|upset|burnt out|burned out|thak|pareshan)\b/i.test(line)
    && !/\b(lately|recently|often|usually|always|pattern|every day|every night|again|still|trying to|want to|need to|save this|remember this|yaad rakh)\b/i.test(line)) {
    return true;
  }
  if (/\b(beer|wine|whiskey|whisky|vodka|alcohol|drink brand)\b/i.test(lower) && !isExplicitMemoryLine(line)) return true;
  if (/^\s*(stop|wait|pause|ruko|ruk|bas|cancel|leave that|chhodo|chod do)\b/i.test(line)) return true;
  return false;
}

function isDurableSummaryLine(line: string) {
  if (isExplicitMemoryLine(line)) return true;
  if (isMemoryPromotionNoise(line)) return false;
  return /\b(my name is|call me|i am building|i'm building|i am developing|working on aura|building aura|voice assistant|ai assistant|my goal|i want to|i need to|i am trying to|trying to|i prefer|i like|i love|favorite|favourite|my taste|reply|language|english only|hindi mein|hinglish|girlfriend|friend|family|dad|mother|mom|sleep|water|weed|smoke|fitness|health|developer|coding|swift|backend|frontend|startup|launch|users)\b/i.test(line);
}

function firstMatch(lines: string[], patterns: RegExp[]) {
  return lines.find((line) => patterns.some((pattern) => pattern.test(line))) ?? "";
}

function compactLine(text: string, maxLength = 170) {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= maxLength) return clean;
  return `${clean.slice(0, maxLength - 3).trim()}...`;
}

function extractQuickFacts(turns: ConversationTurn[]) {
  const lines = turnContent(turns).filter(isDurableSummaryLine);
  const facts: string[] = [];

  const name = firstMatch(lines, [/\b(call me|my name is|i am|i'm)\s+[A-Z][a-z]{2,}/i]);
  if (name) facts.push(compactLine(name.replace(/^.*?\b(call me|my name is)\b/i, "User name signal:"), 150));

  const aura = firstMatch(lines, [/\b(building|developing|created|working on)\b.{0,80}\b(aura|ai assistant|voice assistant|app)\b/i, /\b(aura app|ai assistant|voice assistant)\b/i]);
  if (aura) facts.push(`User is building/developing ${/\baura\b/i.test(aura) ? "AURA" : "an AI/voice assistant app"}.`);

  const developer = firstMatch(lines, [/\b(developer|coding|code|swift|website|apps?|vibe coding)\b/i]);
  if (developer) facts.push("User cares about coding/developer growth.");

  const replyStyle = firstMatch(lines, [/\b(short|simple|plain english|don't like long|keep answers short|reply normally|fast)\b/i]);
  if (replyStyle) facts.push("User prefers simple, direct, not-too-long replies.");

  const habit = firstMatch(lines, [/\b(smoke|weed|water|productive|productivity|sleep)\b/i]);
  if (habit) facts.push(compactLine(`Recent self-improvement context: ${habit}`, 180));

  const relationship = firstMatch(lines, [/\b(girlfriend|friend|dad|father|mother|mom|family|team|cofounder)\b/i]);
  if (relationship) facts.push(compactLine(`Relationship context: ${relationship}`, 180));

  return unique(facts).slice(0, 8);
}

function localDay(date: Date, timezone = "UTC") {
  return new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}

function localWeekKey(date: Date, timezone = "UTC") {
  const dayKey = localDay(date, timezone);
  const utc = new Date(`${dayKey}T00:00:00.000Z`);
  const day = utc.getUTCDay();
  const offset = day === 0 ? 6 : day - 1;
  utc.setUTCDate(utc.getUTCDate() - offset);
  return localDay(utc, "UTC");
}

function hasTag(memory: Record<string, unknown>, tag: string) {
  return asArray(memory.auto_tags).includes(tag);
}

function tagValue(memory: Record<string, unknown>, prefix: string) {
  return asArray(memory.auto_tags)
    .find((tag) => tag.startsWith(prefix))
    ?.slice(prefix.length);
}

function memoryLayer(memory: Record<string, unknown>) {
  return String(memory.memory_layer ?? "");
}

function recentSummaryFromTurns(turns: ConversationTurn[], timezone: string, referenceDate = new Date()) {
  const now = referenceDate.getTime();
  const todayKey = localDay(referenceDate, timezone);
  const yesterdayKey = localDay(new Date(now - 24 * 60 * 60 * 1000), timezone);
  const userTurns = turns.filter((turn) => turn.role === "user");
  const today = userTurns.filter((turn) => localDay(new Date(turn.created_at), timezone) === todayKey).slice(0, 10);
  const yesterday = userTurns.filter((turn) => localDay(new Date(turn.created_at), timezone) === yesterdayKey).slice(0, 10);
  const week = userTurns.filter((turn) => now - new Date(turn.created_at).getTime() <= 7 * 24 * 60 * 60 * 1000).slice(0, 20);

  const todayLines = turnContent(today).filter((line) => !isMemoryPromotionNoise(line));
  const yesterdayLines = turnContent(yesterday).filter((line) => !isMemoryPromotionNoise(line));
  const todayLine = todayLines.length ? `Today: ${todayLines.slice(0, 3).map((line) => compactLine(line, 90)).join(" / ")}` : "";
  const yesterdayLine = yesterdayLines.length ? `Yesterday: ${yesterdayLines.slice(0, 3).map((line) => compactLine(line, 90)).join(" / ")}` : "";
  const weekFacts = extractQuickFacts(week);
  return [todayLine, yesterdayLine, weekFacts.length ? `This week signals: ${weekFacts.join(" ")}` : ""].filter(Boolean).join("\n");
}

function buildDailySummary(turns: ConversationTurn[], timezone: string, targetDay: string) {
  const userTurns = turns
    .filter((turn) => turn.role === "user")
    .filter((turn) => localDay(new Date(turn.created_at), timezone) === targetDay)
    .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
  if (!userTurns.length) return null;

  const lines = turnContent(userTurns).filter((line) => !isMemoryPromotionNoise(line));
  const facts = extractQuickFacts(userTurns);
  const topics = unique(
    userTurns.flatMap((turn) => turn.content.match(/\b(aura|coding|developer|voice|memory|reminder|sleep|water|weed|friend|girlfriend|work|startup|app)\b/gi) ?? [])
      .map((topic) => topic.toLowerCase())
  ).slice(0, 8);
  const headlineSource = lines.length ? lines : facts;
  const headline = headlineSource.slice(-5).map((line) => compactLine(line, 110)).join(" / ");
  const summary = [
    `Daily ${targetDay}: ${headline || "User had a short AURA session."}`,
    facts.length ? `Stable signals: ${facts.join(" ")}` : "",
    topics.length ? `Topics: ${topics.join(", ")}` : ""
  ].filter(Boolean).join("\n");

  return {
    summary: compactLine(summary, 520),
    content: [
      `Daily companion summary for ${targetDay}.`,
      summary,
      "Raw user lines for deep recall remain in the conversation archive, not here."
    ].join("\n"),
    topics
  };
}

function buildWeeklySummary(turns: ConversationTurn[], timezone: string, referenceDate: Date) {
  const weekKey = localWeekKey(referenceDate, timezone);
  const now = referenceDate.getTime();
  const userTurns = turns
    .filter((turn) => turn.role === "user")
    .filter((turn) => now - new Date(turn.created_at).getTime() <= 7 * 24 * 60 * 60 * 1000)
    .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
  if (userTurns.length < 3) return null;

  const facts = extractQuickFacts(userTurns);
  const byDay = new Map<string, string[]>();
  for (const turn of userTurns) {
    if (isMemoryPromotionNoise(turn.content)) continue;
    const key = localDay(new Date(turn.created_at), timezone);
    const items = byDay.get(key) ?? [];
    items.push(compactLine(turn.content, 90));
    byDay.set(key, items);
  }
  const dayLines = Array.from(byDay.entries())
    .slice(-7)
    .map(([day, items]) => `${day}: ${items.slice(-2).join(" / ")}`);
  const summary = [
    `Weekly companion summary starting ${weekKey}.`,
    facts.length ? `What AURA should quietly know: ${facts.join(" ")}` : "",
    dayLines.length ? `Week flow: ${dayLines.join(" | ")}` : ""
  ].filter(Boolean).join("\n");

  return {
    weekKey,
    summary: compactLine(summary, 700),
    content: [
      summary,
      "Use this for natural continuity. Use raw archive only when the user asks exact recall."
    ].join("\n")
  };
}

function buildLongTermSummary(memories: Array<Record<string, unknown>>) {
  const candidates = memories
    .filter((memory) => ["weekly_summary", "daily_summary", "quick_memory", "core_profile"].includes(memoryLayer(memory)))
    .filter((memory) => {
      const text = String(memory.summary || memory.content || "");
      return !isMemoryPromotionNoise(text);
    })
    .sort((a, b) => memoryTime(b) - memoryTime(a))
    .slice(0, 18);
  if (!candidates.length) return null;

  const quick = candidates.filter((memory) => memoryLayer(memory) === "quick_memory").slice(0, 3);
  const profile = candidates.filter((memory) => memoryLayer(memory) === "core_profile").slice(0, 5);
  const weekly = candidates.filter((memory) => memoryLayer(memory) === "weekly_summary").slice(0, 4);
  const daily = candidates.filter((memory) => memoryLayer(memory) === "daily_summary").slice(0, 4);

  const sections = [
    profile.length ? `Core profile: ${profile.map((memory) => String(memory.summary || memory.content || "")).join(" ")}` : "",
    quick.length ? `Quick identity: ${quick.map((memory) => String(memory.summary || memory.content || "")).join(" ")}` : "",
    weekly.length ? `Longer patterns: ${weekly.map((memory) => String(memory.summary || memory.content || "")).join(" ")}` : "",
    daily.length ? `Recent anchors: ${daily.map((memory) => String(memory.summary || memory.content || "")).join(" ")}` : ""
  ].filter(Boolean);

  const summary = compactLine(sections.join("\n"), 900);
  return {
    summary,
    content: [
      "Long-term companion memory summary.",
      summary,
      "This is a compressed normal-conversation layer. Exact dates and raw quotes remain in Deep Archive."
    ].join("\n")
  };
}

async function saveSyntheticMemory(input: {
  userId: string;
  content: string;
  summary: string;
  layer: MemoryAnalysis["memoryLayer"];
  tags: string[];
  topics?: string[];
  importance?: MemoryAnalysis["importance"];
}) {
  const analysis: MemoryAnalysis = {
    summary: input.summary,
    emotionalState: null,
    goals: input.topics?.includes("goal") ? [input.summary] : [],
    actionItems: [],
    importantFacts: [],
    recurringTopics: input.topics ?? [],
    habits: [],
    priorities: [],
    autoTags: input.tags,
    importance: input.importance ?? "medium",
    shouldStore: true,
    explicitSaveIntent: false,
    importantAutoMemory: true,
    memoryLayer: input.layer
  };
  return saveMemory(input.userId, input.content, analysis, []);
}

export async function maybeRefreshWorkingMemory(userId: string, timezone = "UTC", referenceDate = new Date()) {
  const [turns, memories] = await Promise.all([
    conversationTurnsForWorkingMemory(userId),
    listMemories(userId).catch(() => [])
  ]);
  const userTurns = turns.filter((turn) => turn.role === "user");
  if (userTurns.length < 2) return null;

  const latestUserTurn = userTurns[0];
  const latestQuick = (memories as Array<Record<string, unknown>>).find((memory) => asArray(memory.auto_tags).includes("quick-memory"));
  const turnsSinceQuick = latestQuick
    ? userTurns.filter((turn) => new Date(turn.created_at).getTime() > memoryTime(latestQuick)).length
    : userTurns.length;
  if (latestQuick && turnsSinceQuick < QUICK_MEMORY_REFRESH_TURNS) return null;

  const facts = extractQuickFacts(turns);
  const durableLines = turnContent(userTurns.slice(0, 8)).filter(isDurableSummaryLine);
  const quickSummary = facts.length ? facts.join(" ") : durableLines.length ? `Recent durable signals: ${durableLines.slice(0, 3).map((line) => compactLine(line, 90)).join(" / ")}` : "";
  const recentSummary = recentSummaryFromTurns(turns, timezone, referenceDate);

  const quick = quickSummary
    ? await saveSyntheticMemory({
        userId,
        content: `Quick Memory:\n${quickSummary}`,
        summary: quickSummary,
        layer: "quick_memory",
        tags: ["quick-memory", "companion-context"],
        topics: ["quick-memory"]
      })
    : null;
  const recent = recentSummary
    ? await saveSyntheticMemory({
        userId,
        content: `Recent Memory:\n${recentSummary}`,
        summary: recentSummary,
        layer: "recent_memory",
        tags: ["recent-memory", "companion-context"],
        topics: ["recent-memory"]
      })
    : null;

  const targetDay = localDay(referenceDate, timezone);
  const dayTag = `day:${targetDay}`;
  const latestDaily = (memories as Array<Record<string, unknown>>)
    .find((memory) => hasTag(memory, "daily-summary") && hasTag(memory, dayTag));
  const dayUserTurns = userTurns.filter((turn) => localDay(new Date(turn.created_at), timezone) === targetDay);
  const dailyTurnsSinceSummary = latestDaily
    ? dayUserTurns.filter((turn) => new Date(turn.created_at).getTime() > memoryTime(latestDaily)).length
    : dayUserTurns.length;
  const dailyDraft = dailyTurnsSinceSummary >= DAILY_MEMORY_REFRESH_TURNS
    ? buildDailySummary(turns, timezone, targetDay)
    : null;
  const daily = dailyDraft
    ? await saveSyntheticMemory({
        userId,
        content: dailyDraft.content,
        summary: dailyDraft.summary,
        layer: "daily_summary",
        tags: ["daily-summary", "companion-context", dayTag],
        topics: ["daily-summary", ...dailyDraft.topics]
      })
    : null;

  const weekKey = localWeekKey(referenceDate, timezone);
  const weekTag = `week:${weekKey}`;
  const latestWeekly = (memories as Array<Record<string, unknown>>)
    .find((memory) => hasTag(memory, "weekly-summary") && hasTag(memory, weekTag));
  const dailySummariesThisWeek = (memories as Array<Record<string, unknown>>)
    .filter((memory) => hasTag(memory, "daily-summary"))
    .filter((memory) => {
      const value = tagValue(memory, "day:");
      return typeof value === "string" && value >= weekKey;
    });
  if (daily) dailySummariesThisWeek.unshift(daily as Record<string, unknown>);
  const weeklyNeedsRefresh = !latestWeekly
    ? dailySummariesThisWeek.length >= WEEKLY_MEMORY_REFRESH_DAILY_SUMMARIES || userTurns.length >= 8
    : dailySummariesThisWeek.some((memory) => memoryTime(memory) > memoryTime(latestWeekly));
  const weeklyDraft = weeklyNeedsRefresh ? buildWeeklySummary(turns, timezone, referenceDate) : null;
  const weekly = weeklyDraft
    ? await saveSyntheticMemory({
        userId,
        content: weeklyDraft.content,
        summary: weeklyDraft.summary,
        layer: "weekly_summary",
        tags: ["weekly-summary", "companion-context", weekTag],
        topics: ["weekly-summary"]
      })
    : null;

  const memorySnapshot = [...(memories as Array<Record<string, unknown>>)];
  if (daily) memorySnapshot.unshift(daily as Record<string, unknown>);
  if (weekly) memorySnapshot.unshift(weekly as Record<string, unknown>);
  const latestLong = memorySnapshot.find((memory) => hasTag(memory, "long-term-summary"));
  const weeklySummaries = memorySnapshot.filter((memory) => memoryLayer(memory) === "weekly_summary");
  const longNeedsRefresh = !latestLong
    ? weeklySummaries.length >= LONG_MEMORY_REFRESH_WEEKLY_SUMMARIES || userTurns.length >= 10
    : weeklySummaries.some((memory) => memoryTime(memory) > memoryTime(latestLong));
  const longDraft = longNeedsRefresh ? buildLongTermSummary(memorySnapshot) : null;
  const longTerm = longDraft
    ? await saveSyntheticMemory({
        userId,
        content: longDraft.content,
        summary: longDraft.summary,
        layer: "long_term_summary",
        tags: ["long-term-summary", "companion-context"],
        topics: ["long-term-summary"],
        importance: "medium"
      })
    : null;

  return { quick, recent, daily, weekly, longTerm };
}

async function conversationTurnsForWorkingMemory(userId: string) {
  const { listConversationTurns } = await import("./conversationArchive.js");
  return listConversationTurns(userId, 120);
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
      if (tags.includes("quick-memory")) score += 10;
      if (tags.includes("recent-memory")) score += 7;
      if (layer === "quick_memory") score += 10;
      if (layer === "recent_memory") score += 7;
      if (tags.includes("daily-summary") || layer === "daily_summary") score += 6;
      if (tags.includes("weekly-summary") || layer === "weekly_summary") score += 5;
      if (tags.includes("long-term-summary") || layer === "long_term_summary") score += 4;
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
      const prefix = layer === "quick_memory" || tags.includes("quick-memory")
        ? "Quick memory"
        : layer === "recent_memory" || tags.includes("recent-memory")
          ? "Recent memory"
          : layer === "daily_summary" || tags.includes("daily-summary")
            ? "Daily summary"
            : layer === "weekly_summary" || tags.includes("weekly-summary")
              ? "Weekly summary"
              : layer === "long_term_summary" || tags.includes("long-term-summary")
                ? "Long-term summary"
                : layer === "core_profile"
                  ? "Core profile"
                  : tags.includes("session-summary") || layer === "session_summary"
                    ? "Session"
                    : "Memory";
      const text = String((memory as Record<string, unknown>).summary || (memory as Record<string, unknown>).content || "");
      return `- ${prefix}: ${text}`;
    })
    .join("\n");
}

export async function buildCompanionMemoryContext(userId: string, timezone = "UTC", limit = 10) {
  const memories = (await listMemories(userId).catch(() => [])) as Array<Record<string, unknown>>;
  const companionLayers = new Set(["quick_memory", "recent_memory", "daily_summary", "weekly_summary", "long_term_summary", "core_profile", "pinned"]);
  const layerWeight: Record<string, number> = {
    quick_memory: 100,
    core_profile: 90,
    recent_memory: 80,
    daily_summary: 70,
    weekly_summary: 60,
    long_term_summary: 50,
    pinned: 45
  };

  const scored = memories
    .filter((memory) => companionLayers.has(memoryLayer(memory)) || hasTag(memory, "companion-context"))
    .filter((memory) => !hasTag(memory, "product-learning"))
    .map((memory) => {
      const layer = memoryLayer(memory);
      const day = tagValue(memory, "day:");
      const week = tagValue(memory, "week:");
      let score = layerWeight[layer] ?? (hasTag(memory, "companion-context") ? 35 : 0);
      if (day && day === localDay(new Date(), timezone)) score += 8;
      if (week && week === localWeekKey(new Date(), timezone)) score += 6;
      if (String(memory.importance ?? "") === "critical") score += 5;
      score += Math.max(0, 4 - (Date.now() - memoryTime(memory)) / (14 * 24 * 60 * 60 * 1000));
      return { memory, score };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ memory }) => memory);

  return scored
    .map((memory) => {
      const layer = memoryLayer(memory);
      const prefix = layer === "quick_memory"
        ? "Quick"
        : layer === "recent_memory"
          ? "Recent"
          : layer === "daily_summary"
            ? "Daily"
            : layer === "weekly_summary"
              ? "Weekly"
              : layer === "long_term_summary"
                ? "Long-term"
                : layer === "core_profile"
                  ? "Core"
                  : "Pinned";
      const text = String(memory.summary || memory.content || "").replace(/\s+/g, " ").trim();
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
