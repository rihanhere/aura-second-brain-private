import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { MemoryAnalysis } from "../types/domain.js";
import { listConversationTurns } from "./conversationArchive.js";
import { saveMemory } from "./memoryStore.js";
import { isScaleTestUser } from "./scaleTest.js";

type Episode = {
  id: string;
  userId: string;
  sessionId: string;
  label: string;
  summary: string;
  threads: string[];
  emotionalTone: string | null;
  salienceScore: number;
  createdAt: string;
  updatedAt: string;
};

const apiDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const localPath = path.join(apiDir, "data", "temporal-episodes.json");
const localEpisodes: Episode[] = [];
const scaleEpisodes: Episode[] = [];
let loaded = false;

async function loadEpisodes() {
  if (loaded) return;
  loaded = true;
  try {
    const raw = await fs.readFile(localPath, "utf8");
    localEpisodes.splice(0, localEpisodes.length, ...(JSON.parse(raw) as Episode[]));
  } catch {
    // First launch has no consolidated episodes.
  }
}

async function persistEpisodes() {
  await fs.mkdir(path.dirname(localPath), { recursive: true });
  await fs.writeFile(localPath, JSON.stringify(localEpisodes.slice(0, 2000), null, 2));
}

function storeForUser(userId: string) {
  return isScaleTestUser(userId)
    ? { episodes: scaleEpisodes, persist: async () => undefined }
    : { episodes: localEpisodes, persist: persistEpisodes };
}

function compact(text: string, max = 480) {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= max) return clean;
  return `${clean.slice(0, max - 3).trim()}...`;
}

function detectThreads(text: string) {
  const lower = text.toLowerCase();
  const threads = [
    /\b(work|job|office|career)\b/.test(lower) ? "work" : "",
    /\b(aura|app|voice|memory|assistant|tts|stt)\b/.test(lower) ? "aura" : "",
    /\b(code|coding|developer|swift|backend)\b/.test(lower) ? "coding" : "",
    /\b(girlfriend|friend|dad|mom|family)\b/.test(lower) ? "relationship" : "",
    /\b(tired|sleep|exhausted|night)\b/.test(lower) ? "sleep" : "",
    /\b(sad|stress|stuck|confused|feel|better)\b/.test(lower) ? "emotional" : ""
  ].filter(Boolean);
  return Array.from(new Set(threads)).slice(0, 5);
}

function detectEmotion(text: string) {
  if (/\b(tired|exhausted|drained)\b/i.test(text)) return "tired";
  if (/\b(stress|stressed|overwhelmed)\b/i.test(text)) return "stressed";
  if (/\b(sad|low|hurt)\b/i.test(text)) return "sad";
  if (/\b(excited|happy|great)\b/i.test(text)) return "excited";
  if (/\b(better|calm|fine)\b/i.test(text)) return "improved";
  return null;
}

function labelFor(date: Date, timezone: string) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: timezone || "UTC",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit"
  }).format(date);
}

export async function maybeRunMemoryConsolidation(input: {
  userId: string;
  sessionId: string;
  timezone: string;
  now?: Date;
}) {
  await loadEpisodes();
  const turns = (await listConversationTurns(input.userId, 80))
    .filter((turn) => turn.session_id === input.sessionId)
    .slice(0, 16)
    .reverse();
  const userTurns = turns.filter((turn) => turn.role === "user");
  if (userTurns.length < 4) return null;

  const store = storeForUser(input.userId);
  const latestExisting = store.episodes.find((episode) => episode.userId === input.userId && episode.sessionId === input.sessionId);
  const latestTurnTime = new Date(userTurns[userTurns.length - 1].created_at).getTime();
  if (latestExisting && new Date(latestExisting.updatedAt).getTime() >= latestTurnTime) return latestExisting;

  const text = userTurns.map((turn) => turn.content).join(" / ");
  const threads = detectThreads(text);
  const emotionalTone = detectEmotion(text);
  const salienceScore = Math.min(1, 0.25 + userTurns.length * 0.04 + (emotionalTone ? 0.25 : 0) + (threads.includes("aura") || threads.includes("relationship") ? 0.2 : 0));
  const now = input.now ?? new Date();
  const episode: Episode = {
    id: latestExisting?.id ?? crypto.randomUUID(),
    userId: input.userId,
    sessionId: input.sessionId,
    label: `Episode around ${labelFor(now, input.timezone)}`,
    summary: compact(`Session episode: ${text}`, 650),
    threads,
    emotionalTone,
    salienceScore,
    createdAt: latestExisting?.createdAt ?? now.toISOString(),
    updatedAt: now.toISOString()
  };

  if (latestExisting) {
    Object.assign(latestExisting, episode);
  } else {
    store.episodes.unshift(episode);
  }
  await store.persist();

  if (salienceScore >= 0.55) {
    const analysis: MemoryAnalysis = {
      summary: episode.summary,
      emotionalState: emotionalTone,
      goals: [],
      actionItems: [],
      importantFacts: [],
      recurringTopics: threads,
      habits: [],
      priorities: [],
      autoTags: ["temporal-episode", "companion-context", `session:${input.sessionId}`],
      importance: salienceScore >= 0.75 ? "critical" : "medium",
      shouldStore: true,
      explicitSaveIntent: false,
      importantAutoMemory: true,
      memoryLayer: "session_summary"
    };
    await saveMemory(input.userId, episode.summary, analysis, []);
  }

  return episode;
}

export async function listTemporalEpisodes(userId: string, limit = 20) {
  await loadEpisodes();
  return storeForUser(userId).episodes.filter((episode) => episode.userId === userId).slice(0, limit);
}
