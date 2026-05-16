import { env } from "../config/env.js";
import { BrainQueueError, noteBrainProviderFallback, queueBrainRequest } from "./brainOrchestrator.js";
import type { ProviderOverrides } from "./providerOverrides.js";

export type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

const primaryModel = env.openRouterModel;
const fallbackModels = env.openRouterFallbackModels.length ? env.openRouterFallbackModels : ["google/gemini-flash-1.5"];
const disabledUntil = new Map<string, number>();
const nvidiaPrimaryModel = env.nvidiaModel;
const nvidiaFallbackModels = env.nvidiaFallbackModels.length ? env.nvidiaFallbackModels : ["meta/llama-3.3-70b-instruct", "mistralai/mistral-small-4-119b-2603"];
const nvidiaDisabledUntil = new Map<string, number>();
let keyCursor = 0;
let nvidiaKeyCursor = 0;
let geminiEmbeddingCursor = 0;
const genericFallbackPattern = /^(i\s+heard\s+you[.!]?\s*)?(i'?m\s+here\s+with\s+you[.!]?\s*)$/i;

function keys(overrides?: ProviderOverrides) {
  const serverKeys = env.openRouterApiKeys.length ? env.openRouterApiKeys : env.openRouterApiKey ? [env.openRouterApiKey] : [];
  const requestKeys = overrides?.openRouterApiKeys?.length ? overrides.openRouterApiKeys : [];
  return [...new Set([...requestKeys, ...serverKeys].map((key) => key.trim()).filter(Boolean))];
}

function nextKey(overrides?: ProviderOverrides) {
  const available = keys(overrides).filter((key) => (disabledUntil.get(key) ?? 0) < Date.now());
  if (!available.length) return null;
  const key = available[keyCursor % available.length];
  keyCursor += 1;
  return key;
}

function nvidiaKeys() {
  return [...new Set(env.nvidiaApiKeys.map((key) => key.trim()).filter(Boolean))];
}

function nextNvidiaKey() {
  const available = nvidiaKeys().filter((key) => (nvidiaDisabledUntil.get(key) ?? 0) < Date.now());
  if (!available.length) return null;
  const key = available[nvidiaKeyCursor % available.length];
  nvidiaKeyCursor += 1;
  return key;
}

function geminiEmbeddingKeys(overrides?: ProviderOverrides) {
  return overrides?.geminiApiKeys?.length ? overrides.geminiApiKeys : env.geminiApiKeys;
}

function nextGeminiEmbeddingKey(overrides?: ProviderOverrides) {
  const available = geminiEmbeddingKeys(overrides);
  if (!available.length) return null;
  const key = available[geminiEmbeddingCursor % available.length];
  geminiEmbeddingCursor += 1;
  return key;
}

async function withTimeout<T>(task: (signal: AbortSignal) => Promise<T>, timeoutMs = 22000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await task(controller.signal);
  } finally {
    clearTimeout(timeout);
  }
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function lastUserMessage(messages: ChatMessage[]) {
  return [...messages].reverse().find((message) => message.role === "user")?.content.trim() ?? "";
}

function gracefulBrainFallback(messages: ChatMessage[]) {
  const userText = lastUserMessage(messages).toLowerCase();
  if (/\bmobile app\b/i.test(userText)) {
    return "Good. Keep the mobile app idea narrow first: one clean voice flow, memory, reminders, and a simple home screen.";
  }
  if (/\bai tool\b/i.test(userText)) {
    return "That can work too. Pick the version that solves one real daily problem first, then build the smallest useful version.";
  }
  if (/\bfriend\b/i.test(userText)) {
    return "That is a useful signal. What part did your friend like most?";
  }
  if (/\bhello|hi|hey\b/i.test(userText)) {
    return "Hey Rihan. I am here.";
  }
  return "I am with you. Say it one more way and I will help you shape the next step.";
}

async function callOpenRouter(model: string, messages: ChatMessage[], signal: AbortSignal, overrides?: ProviderOverrides) {
  const key = nextKey(overrides);
  if (!key) throw new Error("No OpenRouter key available");

  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    signal,
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://aura-life-journal.local",
      "X-Title": "AURA"
    },
    body: JSON.stringify({
      model,
      temperature: 0.45,
      max_tokens: 220,
      messages
    })
  });

  if (!response.ok) {
    const text = await response.text();
    const providerLimited = /temporarily rate-limited upstream|Provider returned error/i.test(text);
    if ([401, 402, 403].includes(response.status)) disabledUntil.set(key, Date.now() + 5 * 60_000);
    if (response.status === 429 && !providerLimited) disabledUntil.set(key, Date.now() + 20_000);
    throw new Error(`OpenRouter ${response.status}: ${text.slice(0, 240)}`);
  }

  const data = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
  const content = data.choices?.[0]?.message?.content?.trim();
  if (!content) throw new Error(`OpenRouter ${model} returned empty content`);
  if (genericFallbackPattern.test(content)) throw new Error(`OpenRouter ${model} returned generic fallback`);
  return content;
}

async function callNvidia(model: string, messages: ChatMessage[], signal: AbortSignal) {
  const key = nextNvidiaKey();
  if (!key) throw new Error("No NVIDIA key available");

  const response = await fetch(`${env.nvidiaBaseUrl.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    signal,
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model,
      temperature: 0.45,
      max_tokens: 220,
      messages
    })
  });

  if (!response.ok) {
    const text = await response.text();
    if ([401, 402, 403].includes(response.status)) nvidiaDisabledUntil.set(key, Date.now() + 5 * 60_000);
    if (response.status === 429) nvidiaDisabledUntil.set(key, Date.now() + 15_000);
    throw new Error(`NVIDIA ${response.status}: ${text.slice(0, 240)}`);
  }

  const data = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
  const content = data.choices?.[0]?.message?.content?.trim();
  if (!content) throw new Error(`NVIDIA ${model} returned empty content`);
  if (genericFallbackPattern.test(content)) throw new Error(`NVIDIA ${model} returned generic fallback`);
  return content;
}

async function validateSingleOpenRouterKey(key: string, signal: AbortSignal) {
  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    signal,
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://aura-life-journal.local",
      "X-Title": "AURA"
    },
    body: JSON.stringify({
      model: primaryModel,
      temperature: 0,
      max_tokens: 4,
      messages: [{ role: "user", content: "Reply OK." }]
    })
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`OpenRouter ${response.status}: ${text.slice(0, 140)}`);
  }
}

async function completeCalmSystemPromptUnqueued(messages: ChatMessage[], overrides?: ProviderOverrides) {
  if (overrides?.chaos?.brainDelayMs) await sleep(overrides.chaos.brainDelayMs);
  if (overrides?.chaos?.brainFail) {
    console.warn("[aura-chaos] simulated brain failure");
    return "I'm having trouble reaching AURA's language brain right now.";
  }

  const nvidiaModelOrder = [nvidiaPrimaryModel, ...nvidiaFallbackModels].filter(Boolean);
  const availableNvidiaKeyCount = nvidiaKeys().length;
  let nvidiaAttempts = 0;
  if (availableNvidiaKeyCount) {
    for (const model of nvidiaModelOrder) {
      if (nvidiaAttempts >= 2) break;
      for (let attempt = 0; attempt < Math.min(availableNvidiaKeyCount, 2 - nvidiaAttempts); attempt += 1) {
        try {
          nvidiaAttempts += 1;
          return await withTimeout((signal) => callNvidia(model, messages, signal), 8000);
        } catch (error) {
          console.warn(error instanceof Error ? error.message : error);
        }
      }
    }
  }

  const modelOrder = [primaryModel, ...fallbackModels].filter(Boolean);
  const availableKeyCount = keys(overrides).length;
  if (!availableKeyCount) return "I'm having trouble reaching AURA's language brain right now.";
  let openRouterAttempts = 0;

  for (const model of modelOrder) {
    if (openRouterAttempts >= 2) break;
    for (let attempt = 0; attempt < Math.min(availableKeyCount, 2 - openRouterAttempts); attempt += 1) {
      try {
        openRouterAttempts += 1;
        return await withTimeout((signal) => callOpenRouter(model, messages, signal, overrides), 8000);
      } catch (error) {
        console.warn(error instanceof Error ? error.message : error);
      }
    }
  }

  noteBrainProviderFallback();
  return gracefulBrainFallback(messages);
}

export async function completeCalmSystemPrompt(messages: ChatMessage[], overrides?: ProviderOverrides) {
  try {
    return await queueBrainRequest(() => completeCalmSystemPromptUnqueued(messages, overrides));
  } catch (error) {
    if (error instanceof BrainQueueError) {
      noteBrainProviderFallback();
      console.warn(`[${error.code}] ${error.message}`);
      return gracefulBrainFallback(messages);
    }
    throw error;
  }
}

function normalizeEmbedding(values: number[]) {
  const dimensions = env.geminiEmbeddingDimensions;
  if (values.length === dimensions) return values;
  if (values.length > dimensions) return values.slice(0, dimensions);
  return [...values, ...Array.from({ length: dimensions - values.length }, () => 0)];
}

async function requestGeminiEmbedding(input: string, key: string, signal: AbortSignal) {
  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${env.geminiEmbeddingModel}:embedContent`, {
    method: "POST",
    signal,
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": key
    },
    body: JSON.stringify({
      model: `models/${env.geminiEmbeddingModel}`,
      taskType: env.geminiEmbeddingModel === "gemini-embedding-001" ? "SEMANTIC_SIMILARITY" : undefined,
      content: {
        parts: [{ text: input.slice(0, 8000) }]
      },
      output_dimensionality: env.geminiEmbeddingDimensions
    })
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Gemini embedding ${response.status}: ${text.slice(0, 180)}`);
  }

  const data = (await response.json()) as { embedding?: { values?: number[] } };
  const values = data.embedding?.values?.filter((value): value is number => typeof value === "number") ?? [];
  if (!values.length) throw new Error("Gemini embedding returned no values");
  return normalizeEmbedding(values);
}

export async function createEmbedding(input: string, overrides?: ProviderOverrides) {
  const attempts = Math.min(geminiEmbeddingKeys(overrides).length, 4);
  if (!attempts) return [];

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const key = nextGeminiEmbeddingKey(overrides);
    if (!key) break;

    try {
      return await withTimeout((signal) => requestGeminiEmbedding(input, key, signal), 12000);
    } catch (error) {
      console.warn("[gemini-embedding] failed", error instanceof Error ? error.message : error);
    }
  }

  return [];
}

export async function validateOpenRouterKeys(apiKeys: string[]) {
  const normalized = apiKeys.map((key) => key.trim()).filter(Boolean);
  if (!normalized.length) {
    return { ok: false, configured: false, keyCount: 0, validCount: 0, message: "OpenRouter key is missing." };
  }

  let validCount = 0;
  let lastError = "";
  for (const key of normalized) {
    try {
      await withTimeout((signal) => validateSingleOpenRouterKey(key, signal), 14000);
      validCount += 1;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
  }

  return {
    ok: validCount > 0,
    configured: true,
    keyCount: normalized.length,
    validCount,
    message: validCount > 0
      ? `OpenRouter ready (${validCount}/${normalized.length} key${normalized.length === 1 ? "" : "s"} usable).`
      : `OpenRouter failed: ${lastError || "no usable keys"}.`
  };
}

export async function validateGeminiEmbeddingKeys(apiKeys: string[]) {
  const normalized = apiKeys.map((key) => key.trim()).filter(Boolean);
  if (!normalized.length) {
    return { ok: false, configured: false, keyCount: 0, validCount: 0, message: "Gemini key is missing." };
  }

  let validCount = 0;
  let lastError = "";
  for (const key of normalized) {
    try {
      await withTimeout((signal) => requestGeminiEmbedding("AURA validation", key, signal), 14000);
      validCount += 1;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
  }

  return {
    ok: validCount > 0,
    configured: true,
    keyCount: normalized.length,
    validCount,
    message: validCount > 0
      ? `Gemini ready (${validCount}/${normalized.length} key${normalized.length === 1 ? "" : "s"} usable).`
      : `Gemini failed: ${lastError || "no usable keys"}.`
  };
}

export function getOpenRouterStatus() {
  const activeNvidiaKeys = nvidiaKeys().filter((key) => (nvidiaDisabledUntil.get(key) ?? 0) < Date.now()).length;
  return {
    configured: keys().length > 0 || nvidiaKeys().length > 0,
    keyCount: keys().length,
    activeKeyCount: keys().filter((key) => (disabledUntil.get(key) ?? 0) < Date.now()).length,
    primaryModel,
    fallbackModels,
    nvidia: {
      configured: nvidiaKeys().length > 0,
      keyCount: nvidiaKeys().length,
      activeKeyCount: activeNvidiaKeys,
      primaryModel: nvidiaPrimaryModel,
      fallbackModels: nvidiaFallbackModels,
      baseUrl: env.nvidiaBaseUrl
    }
  };
}
