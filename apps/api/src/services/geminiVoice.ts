import { env, hasGemini } from "../config/env.js";
import { getPocketTtsStatus, synthesizePocketVoice } from "./pocketTts.js";
import type { ProviderOverrides } from "./providerOverrides.js";

type GeminiResponse = {
  candidates?: Array<{
    content?: {
      parts?: Array<{
        inlineData?: {
          data?: string;
          mimeType?: string;
        };
        inline_data?: {
          data?: string;
          mime_type?: string;
        };
      }>;
    };
  }>;
};

export type VoiceSynthesisOptions = {
  signal?: AbortSignal;
  jobId?: string;
};

const disabledUntil = new Map<string, number>();
let keyCursor = 0;

function configuredKeys(overrides?: ProviderOverrides) {
  return overrides?.geminiApiKeys?.length ? overrides.geminiApiKeys : env.geminiApiKeys;
}

function activeKeys(overrides?: ProviderOverrides) {
  return configuredKeys(overrides).filter((key) => (disabledUntil.get(key) ?? 0) < Date.now());
}

function nextGeminiKey(overrides?: ProviderOverrides) {
  const keys = activeKeys(overrides);
  if (!keys.length) return null;
  const key = keys[keyCursor % keys.length];
  keyCursor += 1;
  return key;
}

function keyLabel(key: string, overrides?: ProviderOverrides) {
  const index = configuredKeys(overrides).indexOf(key);
  return index >= 0 ? `key-${index + 1}` : "key-unknown";
}

function shouldCooldown(status: number) {
  return [400, 401, 403, 429].includes(status);
}

function allConfiguredKeysCoolingDown(overrides?: ProviderOverrides) {
  const keys = configuredKeys(overrides);
  return keys.length > 0 && keys.every((key) => (disabledUntil.get(key) ?? 0) >= Date.now());
}

async function requestGeminiVoice(text: string, key: string, signal: AbortSignal, overrides?: ProviderOverrides) {
  const prompt = `Read this naturally as Aura. Match the user's language, including Hindi or Hinglish when present. Do not add, skip, explain, or rewrite words. Text:\n\n${text}`;

  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${env.geminiTtsModel}:generateContent`, {
    method: "POST",
    signal,
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": key
    },
    body: JSON.stringify({
      contents: [
        {
          parts: [{ text: prompt }]
        }
      ],
      generationConfig: {
        responseModalities: ["AUDIO"],
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: {
              voiceName: env.geminiTtsVoice
            }
          }
        }
      },
      model: env.geminiTtsModel
    })
  });

  if (!response.ok) {
    const message = await response.text();
    if (shouldCooldown(response.status)) disabledUntil.set(key, Date.now() + 20 * 60 * 1000);
    throw new Error(`Gemini voice ${response.status} on ${keyLabel(key, overrides)}: ${message.slice(0, 260)}`);
  }

  const data = (await response.json()) as GeminiResponse;
  const part = data.candidates?.[0]?.content?.parts?.find((item) => item.inlineData?.data || item.inline_data?.data);
  const audioBase64 = part?.inlineData?.data ?? part?.inline_data?.data;
  const mimeType = part?.inlineData?.mimeType ?? part?.inline_data?.mime_type ?? "audio/pcm;rate=24000";

  if (!audioBase64) throw new Error(`Gemini voice returned no audio on ${keyLabel(key, overrides)}`);

  return {
    audioBase64,
    mimeType,
    provider: "gemini",
    model: env.geminiTtsModel,
    voice: env.geminiTtsVoice,
    key: keyLabel(key, overrides)
  };
}

function childAttemptSignal(parentSignal?: AbortSignal) {
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  parentSignal?.addEventListener("abort", onAbort, { once: true });
  return {
    controller,
    cleanup: () => parentSignal?.removeEventListener("abort", onAbort)
  };
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw new Error("Voice synthesis aborted");
}

export async function synthesizeAgentVoice(text: string, overrides?: ProviderOverrides, options: VoiceSynthesisOptions = {}) {
  throwIfAborted(options.signal);
  if (!overrides?.chaos?.geminiFail && (hasGemini || overrides?.geminiApiKeys?.length) && !allConfiguredKeysCoolingDown(overrides)) {
    const attempts = Math.min(activeKeys(overrides).length, 2);
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const key = nextGeminiKey(overrides);
      if (!key) break;

      const { controller, cleanup } = childAttemptSignal(options.signal);
      const timeout = setTimeout(() => controller.abort(), 4500);
      try {
        throwIfAborted(options.signal);
        const result = await requestGeminiVoice(text, key, controller.signal, overrides);
        console.log("[gemini-tts] success", {
          jobId: options.jobId,
          key: result.key,
          model: result.model,
          voice: result.voice,
          bytesBase64: result.audioBase64.length
        });
        return result;
      } catch (error) {
        console.warn("[gemini-tts] failed", error instanceof Error ? error.message : error);
      } finally {
        clearTimeout(timeout);
        cleanup();
      }
    }

    console.warn("[gemini-tts] all Gemini TTS keys failed or are cooling down");
  }

  if (overrides?.chaos?.geminiFail) console.warn("[aura-chaos] simulated Gemini TTS failure");
  return synthesizePocketVoice(text, overrides?.chaos, options);
}

export async function synthesizeAgentVoiceFast(text: string, overrides?: ProviderOverrides, options: VoiceSynthesisOptions = {}) {
  throwIfAborted(options.signal);
  if (overrides?.chaos?.geminiFail) {
    console.warn("[aura-chaos] simulated fast Gemini TTS failure");
    return synthesizePocketVoice(text, overrides.chaos, options);
  }
  if (allConfiguredKeysCoolingDown(overrides)) return synthesizePocketVoice(text, overrides?.chaos, options);
  const keys = activeKeys(overrides).slice(0, 3);
  if (keys.length) {
    const attempts = keys.map((key) => ({
      key,
      ...childAttemptSignal(options.signal)
    }));
    const timeout = setTimeout(() => {
      for (const attempt of attempts) attempt.controller.abort();
    }, 4500);

    try {
      const promiseAttempts = attempts.map(async (attempt) => {
        const result = await requestGeminiVoice(text, attempt.key, attempt.controller.signal, overrides);
        return { ...result, key: keyLabel(attempt.key, overrides) };
      });
      const result = await Promise.any(promiseAttempts);
      for (const attempt of attempts) attempt.controller.abort();
      console.log("[gemini-tts] fast success", {
        jobId: options.jobId,
        key: result.key,
        model: result.model,
        voice: result.voice,
        bytesBase64: result.audioBase64.length
      });
      return result;
    } catch (error) {
      console.warn("[gemini-tts] fast failed", error instanceof Error ? error.message : error);
    } finally {
      clearTimeout(timeout);
      for (const attempt of attempts) attempt.cleanup();
    }
  }

  return synthesizePocketVoice(text, overrides?.chaos, options);
}

export async function synthesizeGeminiVoiceOnly(text: string, overrides?: ProviderOverrides, options: VoiceSynthesisOptions = {}) {
  throwIfAborted(options.signal);
  if (overrides?.chaos?.geminiFail) {
    throw new Error("Gemini TTS is unavailable for this request.");
  }
  if (allConfiguredKeysCoolingDown(overrides)) {
    throw new Error("All Gemini TTS keys are cooling down.");
  }

  const keys = activeKeys(overrides).slice(0, 3);
  if (!keys.length) {
    throw new Error("Gemini TTS is not configured.");
  }

  const attempts = keys.map((key) => ({
    key,
    ...childAttemptSignal(options.signal)
  }));
  const timeout = setTimeout(() => {
    for (const attempt of attempts) attempt.controller.abort();
  }, 9000);

  try {
    const promiseAttempts = attempts.map(async (attempt) => {
      const result = await requestGeminiVoice(text, attempt.key, attempt.controller.signal, overrides);
      return { ...result, key: keyLabel(attempt.key, overrides) };
    });
    const result = await Promise.any(promiseAttempts);
    for (const attempt of attempts) attempt.controller.abort();
    console.log("[gemini-tts] primary success", {
      jobId: options.jobId,
      key: result.key,
      model: result.model,
      voice: result.voice,
      bytesBase64: result.audioBase64.length
    });
    return result;
  } catch (error) {
    console.warn("[gemini-tts] primary failed", error instanceof Error ? error.message : error);
    throw error;
  } finally {
    clearTimeout(timeout);
    for (const attempt of attempts) attempt.cleanup();
  }
}

export function getGeminiVoiceStatus() {
  return {
    configured: hasGemini,
    keyCount: env.geminiApiKeys.length,
    activeKeyCount: activeKeys().length,
    provider: "gemini",
    model: env.geminiTtsModel,
    voice: env.geminiTtsVoice,
    fallback: getPocketTtsStatus()
  };
}
