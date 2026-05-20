import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { supabase } from "../config/supabase.js";
import type { MemoryAnalysis, ReminderDraft } from "../types/domain.js";
import type { RecallIntent } from "./conversationArchive.js";
import { classifyMemoryIntent, memoryIntentMode } from "./memoryIntentRouter.js";

type ContinuityMode = "utility" | "companion";
type ThemeType = "emotion" | "topic" | "person" | "goal";
type Polarity = "positive" | "negative" | "mixed" | "neutral";

type EmotionalSignal = {
  id: string;
  user_id: string;
  label: string;
  confidence: number;
  intensity: number;
  topic: string | null;
  source_turn_id: string | null;
  timezone: string;
  created_at: string;
};

type ThemeScore = {
  id: string;
  user_id: string;
  theme: string;
  theme_type: ThemeType;
  mention_count: number;
  intensity_total: number;
  latest_intensity: number;
  current_polarity: Polarity;
  previous_polarity: Polarity | null;
  unresolved: boolean;
  related_people: string[];
  related_topics: string[];
  summary: string;
  first_seen_at: string;
  last_seen_at: string;
  last_surfaced_at: string | null;
  updated_at: string;
};

type RelationshipRecord = {
  id: string;
  user_id: string;
  label: string;
  aliases: string[];
  mention_count: number;
  emotional_tone: string | null;
  related_topics: string[];
  last_mentioned_at: string;
  last_surfaced_at: string | null;
  summary: string;
  updated_at: string;
};

const apiDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const localSignalsPath = path.join(apiDir, "data", "emotional-signals.json");
const localThemesPath = path.join(apiDir, "data", "memory-theme-scores.json");
const localRelationshipsPath = path.join(apiDir, "data", "relationship-continuity.json");
const localSignals: EmotionalSignal[] = [];
const localThemes: ThemeScore[] = [];
const localRelationships: RelationshipRecord[] = [];
let localLoaded = false;

const emotionRules = [
  { label: "tired", terms: ["tired", "exhausted", "drained", "sleepy", "no energy", "fatigued", "thak", "thaka"], polarity: "negative" as Polarity },
  { label: "stressed", terms: ["stress", "stressed", "pressure", "tense", "overloaded", "overwhelmed", "pareshan"], polarity: "negative" as Polarity },
  { label: "sad", terms: ["sad", "low", "down", "lonely", "empty", "hurt", "dukhi"], polarity: "negative" as Polarity },
  { label: "anxious", terms: ["anxious", "anxiety", "worried", "scared", "panic", "nervous"], polarity: "negative" as Polarity },
  { label: "angry", terms: ["angry", "mad", "frustrated", "irritated", "annoyed", "gussa"], polarity: "negative" as Polarity },
  { label: "excited", terms: ["excited", "pumped", "thrilled", "can't wait"], polarity: "positive" as Polarity },
  { label: "calm", terms: ["calm", "peaceful", "relaxed", "settled"], polarity: "positive" as Polarity },
  { label: "motivated", terms: ["motivated", "focused", "disciplined", "proud", "productive"], polarity: "positive" as Polarity }
];

const topicRules = [
  "sleep", "work", "career", "family", "fitness", "health", "trading", "money", "study", "relationship",
  "weed", "smoking", "project", "swift", "app", "backend", "voice", "memory"
];

const relationshipRules = [
  { label: "dad", aliases: ["dad", "father", "papa", "pitaji"] },
  { label: "mother", aliases: ["mother", "mom", "mummy", "mumma", "maa"] },
  { label: "girlfriend", aliases: ["girlfriend", "gf"] },
  { label: "boyfriend", aliases: ["boyfriend", "bf"] },
  { label: "friend", aliases: ["friend", "dost"] },
  { label: "cofounder", aliases: ["cofounder", "co-founder", "founder"] },
  { label: "boss", aliases: ["boss", "manager"] },
  { label: "team", aliases: ["team", "coworker", "colleague"] },
  { label: "family", aliases: ["family", "ghar wale"] }
];

async function readJsonArray<T>(filePath: string): Promise<T[]> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw) as T[];
  } catch {
    return [];
  }
}

async function loadLocalContinuity() {
  if (localLoaded) return;
  localLoaded = true;
  localSignals.splice(0, localSignals.length, ...(await readJsonArray<EmotionalSignal>(localSignalsPath)));
  localThemes.splice(0, localThemes.length, ...(await readJsonArray<ThemeScore>(localThemesPath)));
  localRelationships.splice(0, localRelationships.length, ...(await readJsonArray<RelationshipRecord>(localRelationshipsPath)));
}

async function writeJsonArray(filePath: string, value: unknown[]) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(value, null, 2));
}

async function persistLocalContinuity() {
  await Promise.all([
    writeJsonArray(localSignalsPath, localSignals.slice(0, 5000)),
    writeJsonArray(localThemesPath, localThemes.slice(0, 1000)),
    writeJsonArray(localRelationshipsPath, localRelationships.slice(0, 1000))
  ]);
}

function includesTerm(text: string, term: string) {
  return text.includes(term) || new RegExp(`\\b${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(text);
}

function unique(values: string[]) {
  return Array.from(new Set(values.map((value) => value.trim().toLowerCase()).filter(Boolean)));
}

function detectIntensity(text: string, label: string) {
  let intensity = 2;
  if (/\b(very|really|so|too|extremely|bahut|bohot|bht)\b/i.test(text)) intensity += 1;
  if (/\b(always|again|still|every day|daily|all week|lately|recently)\b/i.test(text)) intensity += 1;
  if (label === "overwhelmed" || /\b(can't|cannot|unable|break|broken)\b/i.test(text)) intensity += 1;
  return Math.min(5, intensity);
}

function detectEmotions(content: string) {
  const lower = content.toLowerCase();
  return emotionRules
    .filter((rule) => rule.terms.some((term) => includesTerm(lower, term)))
    .map((rule) => ({
      label: rule.label,
      polarity: rule.polarity,
      confidence: 0.62 + Math.min(0.25, rule.terms.filter((term) => includesTerm(lower, term)).length * 0.08),
      intensity: detectIntensity(lower, rule.label)
    }));
}

function detectTopics(content: string, analysis: MemoryAnalysis) {
  const lower = content.toLowerCase();
  const topics = topicRules.filter((topic) => includesTerm(lower, topic));
  return unique([...topics, ...analysis.recurringTopics]);
}

function detectRelationships(content: string) {
  const lower = content.toLowerCase();
  return relationshipRules.filter((person) => person.aliases.some((alias) => includesTerm(lower, alias)));
}

function detectPolarity(content: string, emotions: Array<{ polarity: Polarity }>): Polarity {
  const lower = content.toLowerCase();
  const positive = /\b(love|like|excited|happy|proud|good|better|calm|motivated)\b/i.test(lower) || emotions.some((item) => item.polarity === "positive");
  const negative = /\b(hate|tired|sad|angry|stressed|worried|bad|worse|overwhelmed|done with)\b/i.test(lower) || emotions.some((item) => item.polarity === "negative");
  if (positive && negative) return "mixed";
  if (positive) return "positive";
  if (negative) return "negative";
  return "neutral";
}

function topicSummary(theme: string, count: number, polarity: Polarity, themeType: ThemeType) {
  if (themeType === "emotion") return `${theme} has appeared ${count} time${count === 1 ? "" : "s"} recently.`;
  if (themeType === "person") return `${theme} has come up ${count} time${count === 1 ? "" : "s"} in recent conversations.`;
  const mood = polarity === "mixed" ? "with mixed feelings" : polarity === "negative" ? "with some strain" : polarity === "positive" ? "positively" : "as a recurring theme";
  return `${theme} has come up ${count} time${count === 1 ? "" : "s"} ${mood}.`;
}

function mergePolarity(previous: Polarity, next: Polarity): Polarity {
  if (previous === next) return next;
  if (previous === "neutral") return next;
  if (next === "neutral") return previous;
  return "mixed";
}

async function saveSignal(signal: EmotionalSignal) {
  if (supabase) {
    try {
      const { error } = await supabase.from("emotional_signals").insert({
        user_id: signal.user_id,
        label: signal.label,
        confidence: signal.confidence,
        intensity: signal.intensity,
        topic: signal.topic,
        source_turn_id: signal.source_turn_id,
        timezone: signal.timezone
      });
      if (!error) return;
      console.warn(`[emotional-continuity] Supabase signal insert failed; using local fallback: ${error.message}`);
    } catch (error) {
      console.warn("[emotional-continuity] Supabase signal insert failed; using local fallback", error instanceof Error ? error.message : error);
    }
  }

  await loadLocalContinuity();
  localSignals.unshift(signal);
  await persistLocalContinuity();
}

async function upsertTheme(input: {
  userId: string;
  theme: string;
  themeType: ThemeType;
  intensity: number;
  polarity: Polarity;
  people?: string[];
  topics?: string[];
  at: string;
}) {
  await loadLocalContinuity();
  const existing = localThemes.find((item) => item.user_id === input.userId && item.theme === input.theme && item.theme_type === input.themeType);
  const record: ThemeScore = existing
    ? {
        ...existing,
        mention_count: existing.mention_count + 1,
        intensity_total: existing.intensity_total + input.intensity,
        latest_intensity: input.intensity,
        previous_polarity: existing.current_polarity,
        current_polarity: mergePolarity(existing.current_polarity, input.polarity),
        unresolved: existing.unresolved || input.polarity === "negative",
        related_people: unique([...existing.related_people, ...(input.people ?? [])]),
        related_topics: unique([...existing.related_topics, ...(input.topics ?? [])]),
        last_seen_at: input.at,
        updated_at: input.at
      }
    : {
        id: crypto.randomUUID(),
        user_id: input.userId,
        theme: input.theme,
        theme_type: input.themeType,
        mention_count: 1,
        intensity_total: input.intensity,
        latest_intensity: input.intensity,
        current_polarity: input.polarity,
        previous_polarity: null,
        unresolved: input.polarity === "negative",
        related_people: unique(input.people ?? []),
        related_topics: unique(input.topics ?? []),
        summary: "",
        first_seen_at: input.at,
        last_seen_at: input.at,
        last_surfaced_at: null,
        updated_at: input.at
      };
  record.summary = topicSummary(record.theme, record.mention_count, record.current_polarity, record.theme_type);

  if (existing) Object.assign(existing, record);
  else localThemes.unshift(record);
  await persistLocalContinuity();

  if (supabase) {
    try {
      await supabase.from("memory_theme_scores").upsert({
        user_id: record.user_id,
        theme: record.theme,
        theme_type: record.theme_type,
        mention_count: record.mention_count,
        intensity_total: record.intensity_total,
        latest_intensity: record.latest_intensity,
        current_polarity: record.current_polarity,
        previous_polarity: record.previous_polarity,
        unresolved: record.unresolved,
        related_people: record.related_people,
        related_topics: record.related_topics,
        summary: record.summary,
        first_seen_at: record.first_seen_at,
        last_seen_at: record.last_seen_at,
        last_surfaced_at: record.last_surfaced_at,
        updated_at: record.updated_at
      }, { onConflict: "user_id,theme,theme_type" });
    } catch (error) {
      console.warn("[emotional-continuity] Supabase theme upsert failed", error instanceof Error ? error.message : error);
    }
  }

  return record;
}

async function upsertRelationship(input: {
  userId: string;
  label: string;
  aliases: string[];
  tone: string | null;
  topics: string[];
  at: string;
}) {
  await loadLocalContinuity();
  const existing = localRelationships.find((item) => item.user_id === input.userId && item.label === input.label);
  const record: RelationshipRecord = existing
    ? {
        ...existing,
        aliases: unique([...existing.aliases, ...input.aliases]),
        mention_count: existing.mention_count + 1,
        emotional_tone: input.tone ?? existing.emotional_tone,
        related_topics: unique([...existing.related_topics, ...input.topics]),
        last_mentioned_at: input.at,
        updated_at: input.at
      }
    : {
        id: crypto.randomUUID(),
        user_id: input.userId,
        label: input.label,
        aliases: unique(input.aliases),
        mention_count: 1,
        emotional_tone: input.tone,
        related_topics: unique(input.topics),
        last_mentioned_at: input.at,
        last_surfaced_at: null,
        summary: "",
        updated_at: input.at
      };
  record.summary = `${record.label} has come up ${record.mention_count} time${record.mention_count === 1 ? "" : "s"}${record.emotional_tone ? ` with a ${record.emotional_tone} tone` : ""}.`;

  if (existing) Object.assign(existing, record);
  else localRelationships.unshift(record);
  await persistLocalContinuity();

  if (supabase) {
    try {
      await supabase.from("relationship_continuity").upsert({
        user_id: record.user_id,
        label: record.label,
        aliases: record.aliases,
        mention_count: record.mention_count,
        emotional_tone: record.emotional_tone,
        related_topics: record.related_topics,
        last_mentioned_at: record.last_mentioned_at,
        last_surfaced_at: record.last_surfaced_at,
        summary: record.summary,
        updated_at: record.updated_at
      }, { onConflict: "user_id,label" });
    } catch (error) {
      console.warn("[emotional-continuity] Supabase relationship upsert failed", error instanceof Error ? error.message : error);
    }
  }

  return record;
}

export function decideRecallMode(input: {
  content: string;
  dateRecall: RecallIntent;
  reminderDraft: ReminderDraft | null;
  explicitSaveIntent: boolean;
}): ContinuityMode {
  return memoryIntentMode(classifyMemoryIntent(input));
}

export async function deriveContinuityFromTurn(input: {
  userId: string;
  content: string;
  timezone: string;
  sourceTurnId?: string | null;
  analysis: MemoryAnalysis;
  mode: ContinuityMode;
  reminderDraft: ReminderDraft | null;
}) {
  if (input.mode === "utility" && input.reminderDraft) return { signals: 0, themes: 0, relationships: 0 };
  if (input.mode === "utility" && /\b(what did|when did|show history|archive|timestamp)\b/i.test(input.content)) {
    return { signals: 0, themes: 0, relationships: 0 };
  }

  const emotions = detectEmotions(input.content);
  const topics = detectTopics(input.content, input.analysis);
  const relationships = detectRelationships(input.content);
  const polarity = detectPolarity(input.content, emotions);
  const now = new Date().toISOString();
  const primaryTopic = topics[0] ?? null;

  for (const emotion of emotions) {
    await saveSignal({
      id: crypto.randomUUID(),
      user_id: input.userId,
      label: emotion.label,
      confidence: emotion.confidence,
      intensity: emotion.intensity,
      topic: primaryTopic,
      source_turn_id: input.sourceTurnId ?? null,
      timezone: input.timezone,
      created_at: now
    });
    await upsertTheme({
      userId: input.userId,
      theme: emotion.label,
      themeType: "emotion",
      intensity: emotion.intensity,
      polarity: emotion.polarity,
      people: relationships.map((person) => person.label),
      topics,
      at: now
    });
  }

  for (const topic of topics) {
    await upsertTheme({
      userId: input.userId,
      theme: topic,
      themeType: input.analysis.goals.some((goal) => goal.toLowerCase().includes(topic)) ? "goal" : "topic",
      intensity: emotions[0]?.intensity ?? 1,
      polarity,
      people: relationships.map((person) => person.label),
      topics,
      at: now
    });
  }

  for (const person of relationships) {
    await upsertTheme({
      userId: input.userId,
      theme: person.label,
      themeType: "person",
      intensity: emotions[0]?.intensity ?? 1,
      polarity,
      people: [person.label],
      topics,
      at: now
    });
    await upsertRelationship({
      userId: input.userId,
      label: person.label,
      aliases: person.aliases,
      tone: emotions[0]?.label ?? null,
      topics,
      at: now
    });
  }

  return { signals: emotions.length, themes: emotions.length + topics.length + relationships.length, relationships: relationships.length };
}

async function listThemeScores(userId: string) {
  await loadLocalContinuity();
  let themes = localThemes.filter((theme) => theme.user_id === userId);

  if (supabase) {
    try {
      const { data, error } = await supabase
        .from("memory_theme_scores")
        .select("*")
        .eq("user_id", userId)
        .order("last_seen_at", { ascending: false })
        .limit(80);
      if (!error && data) themes = data as ThemeScore[];
    } catch (error) {
      console.warn("[emotional-continuity] Supabase theme list failed", error instanceof Error ? error.message : error);
    }
  }

  return themes;
}

async function listRelationships(userId: string) {
  await loadLocalContinuity();
  let relationships = localRelationships.filter((person) => person.user_id === userId);

  if (supabase) {
    try {
      const { data, error } = await supabase
        .from("relationship_continuity")
        .select("*")
        .eq("user_id", userId)
        .order("last_mentioned_at", { ascending: false })
        .limit(40);
      if (!error && data) relationships = data as RelationshipRecord[];
    } catch (error) {
      console.warn("[emotional-continuity] Supabase relationship list failed", error instanceof Error ? error.message : error);
    }
  }

  return relationships;
}

async function markSurfaced(input: { themes: ThemeScore[]; relationships: RelationshipRecord[] }) {
  if (!input.themes.length && !input.relationships.length) return;
  const surfacedAt = new Date().toISOString();
  await loadLocalContinuity();

  for (const theme of input.themes) {
    const local = localThemes.find((item) => item.user_id === theme.user_id && item.theme === theme.theme && item.theme_type === theme.theme_type);
    if (local) local.last_surfaced_at = surfacedAt;
  }

  for (const relationship of input.relationships) {
    const local = localRelationships.find((item) => item.user_id === relationship.user_id && item.label === relationship.label);
    if (local) local.last_surfaced_at = surfacedAt;
  }

  await persistLocalContinuity();

  const client = supabase;
  if (client) {
    await Promise.all([
      ...input.themes.map((theme) =>
        client
          .from("memory_theme_scores")
          .update({ last_surfaced_at: surfacedAt })
          .eq("user_id", theme.user_id)
          .eq("theme", theme.theme)
          .eq("theme_type", theme.theme_type)
          .then(({ error }) => {
            if (error) console.warn(`[emotional-continuity] theme cooldown update failed: ${error.message}`);
          })
      ),
      ...input.relationships.map((relationship) =>
        client
          .from("relationship_continuity")
          .update({ last_surfaced_at: surfacedAt })
          .eq("user_id", relationship.user_id)
          .eq("label", relationship.label)
          .then(({ error }) => {
            if (error) console.warn(`[emotional-continuity] relationship cooldown update failed: ${error.message}`);
          })
      )
    ]);
  }
}

function daysAgo(iso: string) {
  return (Date.now() - new Date(iso).getTime()) / (24 * 60 * 60 * 1000);
}

function queryTerms(query: string) {
  return query.toLowerCase().split(/\W+/).filter((term) => term.length > 2);
}

function hasContinuityCue(query: string) {
  return /\b(again|still|lately|recently|these days|all week|every day|daily|same|pattern|keeps happening|as i said|as i told|you know|remember|recall|before|earlier|pichle|aajkal|roz)\b/i.test(query);
}

function hasEmotionCue(query: string) {
  return emotionRules.some((rule) => rule.terms.some((term) => includesTerm(query.toLowerCase(), term)));
}

function shouldSurface(theme: ThemeScore, query: string) {
  const terms = queryTerms(query);
  const matchesQuery =
    terms.includes(theme.theme) ||
    theme.related_topics.some((topic) => terms.includes(topic)) ||
    theme.related_people.some((person) => terms.includes(person));
  const recent = daysAgo(theme.last_seen_at) <= 30;
  const cooldownClear = !theme.last_surfaced_at || daysAgo(theme.last_surfaced_at) >= 1;
  const cue = hasContinuityCue(query);
  const averageIntensity = theme.intensity_total / Math.max(1, theme.mention_count);

  if (!recent || !cooldownClear) return false;

  if (theme.theme_type === "emotion") {
    const repeatedThisWeek = theme.mention_count >= 3 && daysAgo(theme.last_seen_at) <= 7;
    const repeatedThisMonth = theme.mention_count >= 5 && daysAgo(theme.last_seen_at) <= 30;
    const intenseAndRepeated = theme.mention_count >= 2 && averageIntensity >= 3.5;
    return (matchesQuery || cue || hasEmotionCue(query)) && (repeatedThisWeek || repeatedThisMonth || intenseAndRepeated);
  }

  if (theme.theme_type === "person") {
    return cue && matchesQuery && theme.mention_count >= 3;
  }

  return cue && matchesQuery && theme.mention_count >= 3;
}

function naturalThemeLine(theme: ThemeScore) {
  if (theme.theme_type === "emotion") {
    if (theme.theme === "tired") return "User has seemed worn out lately; mention this gently only if it helps.";
    if (theme.theme === "stressed" || theme.theme === "overwhelmed") return "Stress/pressure has shown up more than once; respond calmly without over-analyzing.";
    if (theme.current_polarity === "positive") return `${theme.theme} has been a recent positive emotional thread.`;
    return `${theme.theme} has appeared recently; treat it as soft context, not a diagnosis.`;
  }
  if (theme.theme_type === "person") {
    const tone = theme.current_polarity === "negative" ? "with some strain" : theme.current_polarity === "positive" ? "positively" : "as recurring context";
    return `${theme.theme} has come up ${tone}; do not bring this up unless directly relevant.`;
  }
  if (theme.current_polarity === "mixed") return `${theme.theme} has mixed or evolving feelings attached to it.`;
  return `${theme.theme} is a recurring life theme.`;
}

function relationshipLine(person: RelationshipRecord) {
  const tone = person.emotional_tone ? ` often around ${person.emotional_tone}` : "";
  return `${person.label} is a recurring person${tone}; use naturally and sparingly.`;
}

export async function buildCompanionContinuityContext(input: {
  userId: string;
  query: string;
  mode: ContinuityMode;
}) {
  if (input.mode === "utility") {
    return {
      mode: input.mode,
      context: "Utility recall mode: use deterministic archive/reminder/save behavior. Do not add emotional pattern commentary unless the user asks."
    };
  }

  const [themes, relationships] = await Promise.all([
    listThemeScores(input.userId),
    listRelationships(input.userId)
  ]);

  const selectedThemes = themes
    .filter((theme) => shouldSurface(theme, input.query))
    .sort((a, b) => {
      const aScore = a.mention_count + a.intensity_total / 2 + Math.max(0, 7 - daysAgo(a.last_seen_at));
      const bScore = b.mention_count + b.intensity_total / 2 + Math.max(0, 7 - daysAgo(b.last_seen_at));
      return bScore - aScore;
    })
    .slice(0, 4);

  const selectedRelationships = relationships
    .filter((person) => {
      const terms = queryTerms(input.query);
      const matchesQuery = terms.includes(person.label) || person.aliases.some((alias) => terms.includes(alias));
      const cooldownClear = !person.last_surfaced_at || daysAgo(person.last_surfaced_at) >= 1;
      return person.mention_count >= 3 && daysAgo(person.last_mentioned_at) <= 45 && cooldownClear && hasContinuityCue(input.query) && matchesQuery;
    })
    .slice(0, 2);

  const lines = [
    ...selectedThemes.map(naturalThemeLine),
    ...selectedRelationships.map(relationshipLine)
  ];

  if (!lines.length) {
    return {
      mode: input.mode,
      context: "No strong emotional continuity pattern should be surfaced. Reply naturally from the current message."
    };
  }

  await markSurfaced({ themes: selectedThemes, relationships: selectedRelationships }).catch((error) => {
    console.warn("[emotional-continuity] cooldown update failed", error instanceof Error ? error.message : error);
  });

  return {
    mode: input.mode,
    context: [
      "Use this only as quiet companion context. Do not dump timestamps. Do not say you are analyzing memory.",
      ...lines.map((line) => `- ${line}`)
    ].join("\n")
  };
}

export function continuityStatus() {
  return {
    persistence: supabase ? "supabase_or_local_fallback" : "local_file",
    paths: {
      emotionalSignals: localSignalsPath,
      themeScores: localThemesPath,
      relationships: localRelationshipsPath
    }
  };
}
