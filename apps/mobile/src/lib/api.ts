import {
  appendCachedConversationTurn,
  appendCachedMemory,
  appendCachedTodo,
  buildLocalInsights,
  cacheMemories,
  cacheReminders,
  cacheTodos,
  getCachedMemories,
  getCachedReminders,
  getCachedTodos,
  getPendingCheckInReminder,
  getSession,
  markReminderCompleted,
  type ApiProviderKeys
} from "./localStore";
import { scheduleAndCacheReminderDraft } from "./reminderScheduler";

declare const process: { env?: Record<string, string | undefined> };

const configuredApiUrl = process.env?.EXPO_PUBLIC_API_URL?.replace(/\/+$/, "");
const LAN_API_URL = "http://192.168.1.7:4000";
const API_URLS = Array.from(
  new Set(
    [
      configuredApiUrl,
      LAN_API_URL
    ].filter(Boolean) as string[]
  )
);

type ApiRequestOptions = RequestInit & {
  timeoutMs?: number;
  providerKeysOverride?: ApiProviderKeys;
};

async function withTimeout<T>(task: (signal: AbortSignal) => Promise<T>, timeoutMs = 25000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await task(controller.signal);
  } finally {
    clearTimeout(timeout);
  }
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

async function request<T>(path: string, options: ApiRequestOptions = {}): Promise<T> {
  const session = await getSession();
  const providerKeys = options.providerKeysOverride;
  const isFormData = typeof FormData !== "undefined" && options.body instanceof FormData;
  const { timeoutMs = 25000, providerKeysOverride: _providerKeysOverride, ...fetchOptions } = options;
  const method = fetchOptions.method ?? "GET";
  const keyHeaders: Record<string, string> = {};
  if (providerKeys?.openRouterKeys.trim()) keyHeaders["x-aura-openrouter-keys"] = providerKeys.openRouterKeys.trim();
  if (providerKeys?.groqKey.trim()) {
    keyHeaders["x-aura-groq-keys"] = providerKeys.groqKey.trim();
    keyHeaders["x-aura-groq-key"] = providerKeys.groqKey.trim();
  }
  if (providerKeys?.geminiKeys.trim()) keyHeaders["x-aura-gemini-keys"] = providerKeys.geminiKeys.trim();
  const headers = {
    ...(isFormData ? {} : { "Content-Type": "application/json" }),
    "x-user-id": session?.userId ?? "guest-beta-user",
    ...keyHeaders,
    ...(fetchOptions.headers ?? {})
  };

  let lastError: unknown;

  for (const apiUrl of API_URLS) {
    const url = `${apiUrl}${path}`;
    const startedAt = Date.now();
    try {
      console.log("[AURA API] request", {
        method,
        url,
        body: isFormData ? "form-data" : typeof fetchOptions.body
      });

      const response = await withTimeout(
        (signal) =>
          fetch(url, {
            ...fetchOptions,
            signal,
            headers
          }),
        timeoutMs
      );

      console.log("[AURA API] response", {
        method,
        url,
        status: response.status,
        durationMs: Date.now() - startedAt
      });

      if (!response.ok) {
        const error = await response.json().catch(() => ({ message: "Request failed" }));
        throw new Error(error.message ?? "Request failed");
      }

      return response.json();
    } catch (error) {
      console.warn("[AURA API] failed", {
        method,
        url,
        durationMs: Date.now() - startedAt,
        message: errorMessage(error)
      });
      lastError = error;
    }
  }

  throw new Error(
    lastError instanceof Error
      ? `${lastError.message}. Tried: ${API_URLS.join(", ")}`
      : `Network request failed. Tried: ${API_URLS.join(", ")}`
  );
}

export function validateProviderKeys(keys: ApiProviderKeys) {
  return request<KeyValidationResult>("/keys/validate", {
    method: "POST",
    body: JSON.stringify({}),
    providerKeysOverride: keys,
    timeoutMs: 35000
  });
}

export function synthesizeVoice(text: string, timeoutMs = 22000) {
  return request<{ voice: AgentVoice | null }>("/voice/synthesize", {
    method: "POST",
    body: JSON.stringify({ text }),
    timeoutMs
  }).catch((error) => {
    console.warn("[AURA voice] reminder synth failed", error instanceof Error ? error.message : error);
    return { voice: null };
  });
}

export async function captureThought(content: string, inputMode: "text" | "voice", timezone: string) {
  const pendingCheckIn = await getPendingCheckInReminder(content);
  const pendingCheckInPayload = pendingCheckIn
    ? {
        id: pendingCheckIn.id,
        title: pendingCheckIn.title,
        promptQuestion: pendingCheckIn.prompt_question ?? null,
        originalText: pendingCheckIn.original_text ?? pendingCheckIn.title,
        scheduledAt: pendingCheckIn.scheduled_at
      }
    : undefined;

  try {
    const result = await request<CaptureResult>("/capture", {
      method: "POST",
      body: JSON.stringify({ content, inputMode, timezone, pendingCheckIn: pendingCheckInPayload })
    });
    await handleCaptureSideEffects(content, inputMode, timezone, result);
    return result;
  } catch {
    const result = createLocalCapture(content, inputMode, timezone, pendingCheckIn);
    const createdAt = new Date().toISOString();
    await appendCachedConversationTurn({
      id: `local-user-turn-${Date.now()}`,
      role: "user",
      content,
      inputMode,
      timezone,
      created_at: createdAt
    });
    await appendCachedConversationTurn({
      id: `local-assistant-turn-${Date.now()}`,
      role: "assistant",
      content: result.reply,
      inputMode: "assistant",
      timezone,
      created_at: new Date(Date.now() + 1).toISOString()
    });
    await handleCaptureSideEffects(content, inputMode, timezone, result);
    return result;
  }
}

async function handleCaptureSideEffects(content: string, _inputMode: "text" | "voice", _timezone: string, result: CaptureResult) {
  if (result.memory) await appendCachedMemory(result.memory);
  if (result.reminderDraft) await scheduleAndCacheReminderDraft(result.reminderDraft, content, result.reminder);
  if (result.checkInResult?.handled) await markReminderCompleted(result.checkInResult.reminderId);
  const todo = todoFromContent(content);
  if (todo) await appendCachedTodo(todo);
}

export async function transcribeVoice(uri: string) {
  const health = await getBackendHealth();
  if (!health.ok) {
    return {
      transcript: "",
      provider: "network",
      model: null,
      available: false,
      message: `Backend unreachable before voice upload: ${String(health.providers.error ?? "unknown error")}`
    };
  }

  const form = new FormData();
  const audioFile = {
    uri,
    name: "aura-voice.m4a",
    type: "audio/m4a"
  };
  console.log("[AURA voice] uploading recording", audioFile);
  form.append("audio", {
    uri,
    name: "aura-voice.m4a",
    type: "audio/m4a"
  } as unknown as Blob);

  return request<{ transcript: string; provider: string; model: string | null; available: boolean; message?: string }>("/voice/transcribe", {
    method: "POST",
    body: form,
    timeoutMs: 35000
  }).catch((error) => ({
    transcript: "",
    provider: "network",
    model: null,
    available: false,
    message: error instanceof Error ? error.message : "Voice transcription is unavailable right now."
  }));
}

export function getBackendHealth() {
  return request<BackendHealth>("/health", { timeoutMs: 8000 }).catch((error) => ({
    ok: false,
    service: "aura-api",
    version: "unknown",
    providers: {
      error: error instanceof Error ? error.message : "Backend unavailable"
    }
  }));
}

export function finalizeMemorySession() {
  return request<{ ok: boolean; memory: MemoryItem | null }>("/memories/session/finalize", {
    method: "POST",
    body: JSON.stringify({}),
    timeoutMs: 20000
  }).catch((error) => {
    console.warn("[AURA memory] session finalize failed", error instanceof Error ? error.message : error);
    return { ok: false, memory: null };
  });
}

export type BackendHealth = {
    ok: boolean;
    service: string;
    version: string;
    providers: Record<string, unknown>;
};

export type KeyValidationResult = {
  ok: boolean;
  message: string;
  providers: {
    openRouter: ProviderValidation;
    groq: ProviderValidation;
    gemini: ProviderValidation;
  };
};

export type ProviderValidation = {
  ok: boolean;
  configured: boolean;
  keyCount?: number;
  validCount?: number;
  message: string;
};

export function listMemories() {
  return request<{ memories: MemoryItem[] }>("/memories")
    .then(async (result) => {
      await cacheMemories(result.memories);
      return result;
    })
    .catch(async () => ({ memories: await getCachedMemories() }));
}

export function listTodos() {
  return request<{ todos: TodoItem[] }>("/todos")
    .then(async (result) => {
      await cacheTodos(result.todos);
      return result;
    })
    .catch(async () => ({ todos: await getCachedTodos() }));
}

export function listReminders() {
  return request<{ reminders: ReminderItem[] }>("/reminders")
    .then(async (result) => {
      const cached = await getCachedReminders();
      const merged = mergeReminders(result.reminders, cached);
      await cacheReminders(merged);
      return { reminders: merged };
    })
    .catch(async () => ({ reminders: await getCachedReminders() }));
}

export function listInsights() {
  return request<{ insights: InsightSummary }>("/insights").catch(async () => ({ insights: await buildLocalInsights() }));
}

type CaptureResult = {
  reply: string;
  memory: MemoryItem | null;
  analysis: MemoryAnalysis;
  reminder?: ReminderItem | null;
  reminderDraft: ReminderDraft | null;
  checkInResult?: {
    reminderId: string;
    answer: "yes" | "no" | "unclear" | null;
    handled: boolean;
  } | null;
  voice?: AgentVoice | null;
  archive?: {
    userTurn?: unknown;
    dateRecall?: unknown;
  };
};

function mergeReminders(remote: ReminderItem[], cached: ReminderItem[]) {
  const byId = new Map<string, ReminderItem>();
  for (const reminder of remote) byId.set(reminder.id, reminder);
  for (const reminder of cached) {
    if (!byId.has(reminder.id) || reminder.status === "scheduled" || reminder.status === "asked") {
      byId.set(reminder.id, { ...byId.get(reminder.id), ...reminder });
    }
  }
  return Array.from(byId.values())
    .sort((a, b) => new Date(a.scheduled_at).getTime() - new Date(b.scheduled_at).getTime())
    .slice(0, 80);
}

export type AgentVoice = {
  audioBase64: string;
  mimeType: string;
  provider: string;
  model: string;
  voice: string;
};

export type MemoryAnalysis = {
  summary: string;
  emotionalState: string | null;
  goals: string[];
  actionItems: string[];
  autoTags: string[];
  importance: "low" | "medium" | "critical";
  shouldStore?: boolean;
  explicitSaveIntent?: boolean;
  importantAutoMemory?: boolean;
};

export type MemoryItem = {
  id: string;
  content: string;
  summary: string;
  emotional_state?: string | null;
  recurring_topics?: string[];
  auto_tags?: string[];
  importance?: string;
  memory_layer?: string;
  created_at: string;
};

export type ReminderDraft = {
  type?: "simple_reminder" | "check_in";
  title: string;
  scheduledAt: string;
  recurrenceRule: string | null;
  timezone: string;
  promptQuestion?: string | null;
  originalText?: string;
  notificationBody?: string;
  responseGuidance?: string | null;
};

export type ReminderItem = {
  id: string;
  type?: "simple_reminder" | "check_in";
  title: string;
  scheduled_at: string;
  recurrence_rule?: string | null;
  timezone?: string;
  status: "scheduled" | "asked" | "completed" | "cancelled" | string;
  notification_id?: string | null;
  prompt_question?: string | null;
  original_text?: string | null;
  notification_body?: string | null;
  response_guidance?: string | null;
  last_asked_at?: string | null;
  completed_at?: string | null;
  created_at?: string;
};

export type TodoItem = {
  id: string;
  title: string;
  priority: "low" | "medium" | "high";
  status: "open" | "completed" | "archived";
  due_at?: string | null;
};

export type InsightSummary = {
  moodTrend: string;
  recurringThemes: Array<{ topic: string; count: number }>;
  weeklyReflection: string;
  forgottenGoals: string[];
};

function createLocalCapture(content: string, inputMode: "text" | "voice", timezone: string, pendingCheckIn?: ReminderItem | null): CaptureResult {
  const lower = content.toLowerCase();
  const isReminder = /\b(remind|tomorrow|every|alarm|schedule|ask me if|check if|check in|follow up)\b/.test(lower);
  const isTodo = /\b(todo|task|need to|should|must)\b/.test(lower);
  const isGoal = /\b(goal|want|build|learn|improve|focus|plan)\b/.test(lower);
  const checkInAnswer = pendingCheckIn ? localCheckInAnswer(content) : null;
  const explicitSaveIntent = /\b(save this|save it|save karo|save kar|journal this|add to journal|note this|remember this|remember that|yaad rakh|yaad rakhna|memory mein|memory me|isko save|ye save)\b/i.test(content);
  const emotionalState = /\b(stress|anxious|tired|sad|angry|overwhelmed)\b/.test(lower)
    ? "strained"
    : /\b(calm|happy|good|excited|proud|motivated)\b/.test(lower)
      ? "steady"
      : null;
  const importantAutoMemory = isReminder || isTodo || isGoal || Boolean(emotionalState) || /\b(my|i am|i'm|i have|i work|i live|i prefer|i like|i hate|health|money|family|trading|fitness|sleep)\b/i.test(content);
  const shouldStore = explicitSaveIntent || importantAutoMemory;
  const topics = Array.from(new Set(content.match(/\b(trading|fitness|health|money|work|study|sleep|family)\b/gi) ?? [])).map((topic) =>
    topic.toLowerCase()
  );

  const analysis: MemoryAnalysis = {
    summary: content.length > 96 ? `${content.slice(0, 93)}...` : content,
    emotionalState,
    goals: isGoal ? [content] : [],
    actionItems: isTodo || isReminder ? [content] : [],
    autoTags: [
      "thought",
      inputMode === "voice" ? "voice_log" : null,
      isGoal ? "goal" : null,
      isTodo ? "task" : null,
      isReminder ? "reminder" : null,
      emotionalState ? "emotion" : null
    ].filter(Boolean) as string[],
    importance: /\b(urgent|critical|deadline|doctor|health|money)\b/.test(lower) ? "critical" : isGoal || isTodo || isReminder || explicitSaveIntent ? "medium" : "low",
    shouldStore,
    explicitSaveIntent,
    importantAutoMemory
  };

  return {
    reply: pendingCheckIn && checkInAnswer === "yes"
      ? "You started around the time you asked me to check in. Try not to add more right now. Drink some water, settle in, and do something you actually enjoy while this passes."
      : pendingCheckIn && checkInAnswer === "no"
        ? "Good. Keep that promise to yourself for a little longer. Let the urge pass, drink some water, and do something calm for the next few minutes."
        : pendingCheckIn
          ? "I hear you. Are you still doing it, yes or no?"
          : explicitSaveIntent
            ? "I heard you. I saved this moment."
            : isReminder
              ? "Done. I'll remind you."
              : "I'm having trouble reaching AURA's brain right now, but I'm still here with you.",
    memory: shouldStore
      ? {
          id: `local-${Date.now()}`,
          content: inputMode === "voice" ? `[Voice] ${content}` : content,
          summary: analysis.summary,
          emotional_state: emotionalState,
          recurring_topics: topics,
          auto_tags: analysis.autoTags,
          importance: analysis.importance,
          memory_layer: analysis.importance === "critical" ? "pinned" : analysis.autoTags.includes("goal") ? "core_profile" : "episodic",
          created_at: new Date().toISOString()
        }
      : null,
    analysis,
    reminderDraft: isReminder
      ? {
          type: /\b(ask me if|check if|check in|follow up)\b/i.test(content) ? "check_in" : "simple_reminder",
          title: content.replace(/remind me( to)?/i, "").trim(),
          scheduledAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
          recurrenceRule: lower.includes("every") ? "recurring" : null,
          timezone,
          promptQuestion: /\b(smoking weed|weed)\b/i.test(content) ? "Rihan, are you still smoking weed?" : null,
          originalText: content,
          notificationBody: /\b(smoking weed|weed)\b/i.test(content) ? "Rihan, are you still smoking weed?" : `Hey Rihan, time to ${content.replace(/remind me( to)?/i, "").trim()}.`,
          responseGuidance: null
        }
      : null,
    checkInResult: pendingCheckIn
      ? {
          reminderId: pendingCheckIn.id,
          answer: checkInAnswer,
          handled: checkInAnswer === "yes" || checkInAnswer === "no"
        }
      : null
  };
}

function localCheckInAnswer(content: string) {
  const normalized = content.toLowerCase().trim();
  if (/^(yes|yeah|yep|haan|ha|haa|still|i am|i'm|yes i am|abhi bhi|kar raha|kar rha|smoking)/i.test(normalized)) return "yes" as const;
  if (/^(no|nope|nah|nahi|nai|not now|i stopped|stopped|band|chhod diya|chod diya)/i.test(normalized)) return "no" as const;
  return "unclear" as const;
}

function todoFromContent(content: string): TodoItem | null {
  if (!/\b(todo|task|need to|should|must)\b/i.test(content)) return null;
  return {
    id: `local-todo-${Date.now()}`,
    title: content.replace(/^todo:?\s*/i, "").trim(),
    priority: /\b(urgent|critical|important)\b/i.test(content) ? "high" : "medium",
    status: "open"
  };
}
