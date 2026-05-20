import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { supabase } from "../config/supabase.js";
import { listConversationTurns } from "./conversationArchive.js";
import { listMemoryAtoms } from "./memoryAtoms.js";
import { listMemories } from "./memoryStore.js";
import { listProductLearningEvents } from "./productLearning.js";
import { getPrivacySettings } from "./privacySettings.js";
import { listAssistantReplyMemory } from "./assistantReplyMemory.js";
import { getUserCognitionProfile } from "./userCognitionProfile.js";
import { listTemporalEpisodes } from "./memoryConsolidationEngine.js";

const apiDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const dataDir = path.join(apiDir, "data");

const localJsonFiles = [
  "conversation-archive.json",
  "local-memories.json",
  "memory-atoms.json",
  "memory-associations.json",
  "emotional-signals.json",
  "memory-theme-scores.json",
  "relationship-continuity.json",
  "temporal-episodes.json",
  "assistant-reply-memory.json",
  "aura-product-learning-events.json",
  "privacy-settings.json",
  "user-cognition-profiles.json",
  "daily-usage.json"
];

function belongsToUser(item: unknown, userId: string) {
  if (!item || typeof item !== "object") return false;
  const record = item as Record<string, unknown>;
  return record.user_id === userId || record.userId === userId || record.user === userId || record.id === userId;
}

async function readJsonArray(fileName: string) {
  try {
    const raw = await fs.readFile(path.join(dataDir, fileName), "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export async function exportUserData(userId: string) {
  const [turns, memories, atoms, assistantReplies, productLearning, privacy, cognitionProfile, episodes] = await Promise.all([
    listConversationTurns(userId, 5000).catch(() => []),
    listMemories(userId).catch(() => []),
    listMemoryAtoms(userId, 1000).catch(() => []),
    listAssistantReplyMemory(userId, 500).catch(() => []),
    listProductLearningEvents(2000).catch(() => []),
    getPrivacySettings(userId).catch(() => null),
    getUserCognitionProfile(userId).catch(() => null),
    listTemporalEpisodes(userId, 200).catch(() => [])
  ]);

  return {
    exportedAt: new Date().toISOString(),
    userId,
    privacy,
    cognitionProfile,
    turns,
    memories,
    atoms,
    episodes,
    assistantReplies,
    productLearning: productLearning.filter((event) => event.userId === userId)
  };
}

async function pruneLocalJsonFile(fileName: string, userId: string) {
  const filePath = path.join(dataDir, fileName);
  const rows = await readJsonArray(fileName);
  if (!rows.length) return { fileName, removed: 0 };
  const kept = rows.filter((item) => !belongsToUser(item, userId));
  const removed = rows.length - kept.length;
  if (removed > 0) {
    await fs.writeFile(filePath, JSON.stringify(kept, null, 2));
  }
  return { fileName, removed };
}

async function deleteSupabaseUserData(userId: string) {
  if (!supabase) return [];
  const tables = [
    "conversation_turns",
    "memories",
    "emotional_signals",
    "memory_theme_scores",
    "relationship_continuity"
  ];
  const results = [];
  for (const table of tables) {
    try {
      const { error } = await supabase.from(table).delete().eq("user_id", userId);
      results.push({ table, ok: !error, error: error?.message ?? null });
    } catch (error) {
      results.push({ table, ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return results;
}

export async function deleteUserData(userId: string) {
  const [local, supabaseDeletes] = await Promise.all([
    Promise.all(localJsonFiles.map((fileName) => pruneLocalJsonFile(fileName, userId))),
    deleteSupabaseUserData(userId)
  ]);
  return {
    deletedAt: new Date().toISOString(),
    userId,
    local,
    supabase: supabaseDeletes
  };
}
