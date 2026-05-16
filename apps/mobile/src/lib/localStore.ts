import AsyncStorage from "@react-native-async-storage/async-storage";
import * as SecureStore from "expo-secure-store";
import type { InsightSummary, MemoryItem, ReminderItem, TodoItem } from "./api";

const SESSION_KEY = "aura-session";
const MEMORY_CACHE_KEY = "aura-journal-entries";
const CONVERSATION_ARCHIVE_CACHE_KEY = "aura-conversation-archive";
const TODO_CACHE_KEY = "second-brain-local-todos";
const REMINDER_CACHE_KEY = "second-brain-local-reminders";
const API_KEYS_KEY = "aura-user-api-keys";
const API_KEY_ONBOARDING_KEY = "aura-api-key-onboarding-complete";

const emptyApiProviderKeys: ApiProviderKeys = {
  openRouterKeys: "",
  groqKey: "",
  geminiKeys: ""
};

export type LocalSession = {
  mode: "guest" | "email";
  email?: string;
  userId: string;
};

export type ApiProviderKeys = {
  openRouterKeys: string;
  groqKey: string;
  geminiKeys: string;
};

export type LocalConversationTurn = {
  id: string;
  role: "user" | "assistant";
  content: string;
  inputMode: "text" | "voice" | "assistant";
  timezone: string;
  created_at: string;
};

async function secureStoreAvailable() {
  try {
    return await SecureStore.isAvailableAsync();
  } catch {
    return false;
  }
}

function parseApiProviderKeys(raw: string | null): ApiProviderKeys {
  if (!raw) return emptyApiProviderKeys;
  try {
    const parsed = JSON.parse(raw) as Partial<ApiProviderKeys>;
    return {
      openRouterKeys: parsed.openRouterKeys ?? "",
      groqKey: parsed.groqKey ?? "",
      geminiKeys: parsed.geminiKeys ?? ""
    };
  } catch {
    return emptyApiProviderKeys;
  }
}

function hasAllProviderKeys(keys: ApiProviderKeys) {
  return Boolean(keys.openRouterKeys.trim() && keys.groqKey.trim() && keys.geminiKeys.trim());
}

export async function getSession() {
  const raw = await AsyncStorage.getItem(SESSION_KEY);
  return raw ? (JSON.parse(raw) as LocalSession) : null;
}

export async function getOrCreateSession() {
  const session = await getSession();
  if (session) return session;
  const next: LocalSession = {
    mode: "guest",
    userId: `aura-local-${Date.now()}`
  };
  await saveSession(next);
  return next;
}

export async function saveSession(session: LocalSession) {
  await AsyncStorage.setItem(SESSION_KEY, JSON.stringify(session));
}

export async function getApiProviderKeys(): Promise<ApiProviderKeys> {
  if (await secureStoreAvailable()) {
    const secureRaw = await SecureStore.getItemAsync(API_KEYS_KEY);
    if (secureRaw) return parseApiProviderKeys(secureRaw);

    const legacyRaw = await AsyncStorage.getItem(API_KEYS_KEY);
    if (legacyRaw) {
      await SecureStore.setItemAsync(API_KEYS_KEY, legacyRaw);
      await AsyncStorage.removeItem(API_KEYS_KEY).catch(() => undefined);
      return parseApiProviderKeys(legacyRaw);
    }
  }

  return parseApiProviderKeys(await AsyncStorage.getItem(API_KEYS_KEY));
}

export async function saveApiProviderKeys(keys: ApiProviderKeys) {
  const normalized = {
    openRouterKeys: keys.openRouterKeys.trim(),
    groqKey: keys.groqKey.trim(),
    geminiKeys: keys.geminiKeys.trim()
  };
  if (await secureStoreAvailable()) {
    await SecureStore.setItemAsync(API_KEYS_KEY, JSON.stringify(normalized));
    await AsyncStorage.removeItem(API_KEYS_KEY).catch(() => undefined);
    return;
  }
  await AsyncStorage.setItem(API_KEYS_KEY, JSON.stringify(normalized));
}

export async function hasRequiredApiProviderKeys() {
  return hasAllProviderKeys(await getApiProviderKeys());
}

export async function getApiKeyOnboardingComplete() {
  const raw = await AsyncStorage.getItem(API_KEY_ONBOARDING_KEY);
  return raw === "true" && (await hasRequiredApiProviderKeys());
}

export async function markApiKeyOnboardingComplete(complete: boolean) {
  await AsyncStorage.setItem(API_KEY_ONBOARDING_KEY, complete ? "true" : "false");
}

export async function getCachedMemories() {
  const raw = await AsyncStorage.getItem(MEMORY_CACHE_KEY);
  return raw ? (JSON.parse(raw) as MemoryItem[]) : [];
}

export async function cacheMemories(memories: MemoryItem[]) {
  await AsyncStorage.setItem(MEMORY_CACHE_KEY, JSON.stringify(memories.slice(0, 80)));
}

export async function appendCachedMemory(memory: MemoryItem) {
  const current = await getCachedMemories();
  await cacheMemories([memory, ...current.filter((item) => item.id !== memory.id)]);
}

export async function getCachedConversationArchive() {
  const raw = await AsyncStorage.getItem(CONVERSATION_ARCHIVE_CACHE_KEY);
  return raw ? (JSON.parse(raw) as LocalConversationTurn[]) : [];
}

export async function appendCachedConversationTurn(turn: LocalConversationTurn) {
  const current = await getCachedConversationArchive();
  await AsyncStorage.setItem(
    CONVERSATION_ARCHIVE_CACHE_KEY,
    JSON.stringify([turn, ...current.filter((item) => item.id !== turn.id)].slice(0, 1200))
  );
}

export async function getCachedTodos() {
  const raw = await AsyncStorage.getItem(TODO_CACHE_KEY);
  return raw ? (JSON.parse(raw) as TodoItem[]) : [];
}

export async function cacheTodos(todos: TodoItem[]) {
  await AsyncStorage.setItem(TODO_CACHE_KEY, JSON.stringify(todos.slice(0, 80)));
}

export async function appendCachedTodo(todo: TodoItem) {
  const current = await getCachedTodos();
  await cacheTodos([todo, ...current.filter((item) => item.id !== todo.id)]);
}

export async function getCachedReminders() {
  const raw = await AsyncStorage.getItem(REMINDER_CACHE_KEY);
  return raw ? (JSON.parse(raw) as ReminderItem[]) : [];
}

export async function cacheReminders(reminders: ReminderItem[]) {
  await AsyncStorage.setItem(REMINDER_CACHE_KEY, JSON.stringify(reminders.slice(0, 80)));
}

export async function appendCachedReminder(reminder: ReminderItem) {
  const current = await getCachedReminders();
  await cacheReminders([reminder, ...current.filter((item) => item.id !== reminder.id)]);
}

export async function updateCachedReminder(id: string, patch: Partial<ReminderItem>) {
  const current = await getCachedReminders();
  await cacheReminders(current.map((item) => (item.id === id ? { ...item, ...patch } : item)));
}

export async function getPendingCheckInReminder(answerText?: string) {
  if (answerText && !/^(yes|yeah|yep|haan|ha|haa|no|nope|nah|nahi|nai|not now|i stopped|stopped|still|i am|i'm|abhi bhi|kar raha|kar rha|smoking)/i.test(answerText.trim())) {
    return null;
  }
  const current = await getCachedReminders();
  return current
    .filter((item) => item.type === "check_in" && item.status === "asked")
    .sort((a, b) => new Date(b.last_asked_at ?? b.scheduled_at).getTime() - new Date(a.last_asked_at ?? a.scheduled_at).getTime())[0] ?? null;
}

export async function markReminderAsked(id: string) {
  await updateCachedReminder(id, {
    status: "asked",
    last_asked_at: new Date().toISOString()
  });
}

export async function markReminderCompleted(id: string) {
  await updateCachedReminder(id, {
    status: "completed",
    completed_at: new Date().toISOString()
  });
}

export async function buildLocalInsights(): Promise<InsightSummary> {
  const memories = await getCachedMemories();
  const topicCounts = new Map<string, number>();
  let emotionCount = 0;

  for (const memory of memories) {
    for (const topic of memory.recurring_topics ?? []) {
      topicCounts.set(topic, (topicCounts.get(topic) ?? 0) + 1);
    }
    if (memory.emotional_state) emotionCount += 1;
  }

  const recurringThemes = Array.from(topicCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([topic, count]) => ({ topic, count }));

  return {
    moodTrend: emotionCount > 2 ? "Your recent notes carry a visible emotional thread." : "No strong mood shift yet. Keep capturing lightly.",
    recurringThemes,
    weeklyReflection: recurringThemes.length
      ? `You are circling back to ${recurringThemes.map((theme) => theme.topic).join(", ")}.`
      : "Patterns will appear once a few more memories accumulate.",
    forgottenGoals: memories.filter((memory) => memory.auto_tags?.includes("goal")).slice(0, 3).map((memory) => memory.summary)
  };
}
