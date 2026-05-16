import { env, hasGroq } from "../config/env.js";

const disabledUntil = new Map<string, number>();
let groqCursor = 0;

function configuredGroqKeys(overrideApiKeys?: string[] | string) {
  const overrides = Array.isArray(overrideApiKeys)
    ? overrideApiKeys
    : (overrideApiKeys ?? "")
        .split(",")
        .map((key) => key.trim())
        .filter(Boolean);
  return overrides.length ? overrides : env.groqApiKeys;
}

function activeGroqKeys(overrideApiKeys?: string[] | string) {
  return configuredGroqKeys(overrideApiKeys).filter((key) => (disabledUntil.get(key) ?? 0) < Date.now());
}

function nextGroqKey(overrideApiKeys?: string[] | string) {
  const keys = activeGroqKeys(overrideApiKeys);
  if (!keys.length) return null;
  const key = keys[groqCursor % keys.length];
  groqCursor += 1;
  return key;
}

function keyLabel(key: string, overrideApiKeys?: string[] | string) {
  const index = configuredGroqKeys(overrideApiKeys).indexOf(key);
  return index >= 0 ? `key-${index + 1}` : "key-unknown";
}

function shouldCooldown(status: number) {
  return [401, 402, 403, 429].includes(status);
}

function buildTranscriptionForm(file: Express.Multer.File) {
  const form = new FormData();
  const audioBytes = new Uint8Array(file.buffer);
  form.append("model", env.groqTranscriptionModel);
  form.append("temperature", "0");
  form.append("response_format", "json");
  form.append("file", new Blob([audioBytes], { type: file.mimetype || "audio/m4a" }), file.originalname || "voice.m4a");
  return form;
}

async function transcribeWithKey(file: Express.Multer.File, apiKey: string, signal: AbortSignal) {
  const response = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
    method: "POST",
    signal,
    headers: {
      Authorization: `Bearer ${apiKey}`
    },
    body: buildTranscriptionForm(file)
  });

  if (!response.ok) {
    const text = await response.text();
    if (shouldCooldown(response.status)) disabledUntil.set(apiKey, Date.now() + 90_000);
    throw new Error(`Groq transcription ${response.status}: ${text.slice(0, 180)}`);
  }

  const data = (await response.json()) as { text?: string };
  return data.text?.trim() ?? "";
}

export async function transcribeAudio(file: Express.Multer.File, overrideApiKeys?: string[] | string) {
  if (!activeGroqKeys(overrideApiKeys).length && !hasGroq) {
    return {
      transcript: "",
      provider: "local",
      model: null,
      available: false,
      message: "Groq Whisper is not configured on the backend."
    };
  }

  const attempts = Math.min(configuredGroqKeys(overrideApiKeys).length, 8);
  let lastError = "";
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const apiKey = nextGroqKey(overrideApiKeys);
    if (!apiKey) break;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20_000);
    try {
      const transcript = await transcribeWithKey(file, apiKey, controller.signal);
      console.log("[groq-whisper] success", {
        key: keyLabel(apiKey, overrideApiKeys),
        model: env.groqTranscriptionModel,
        transcriptLength: transcript.length
      });
      return {
        transcript,
        provider: "groq",
        model: env.groqTranscriptionModel,
        available: true
      };
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      console.warn("[groq-whisper] failed", keyLabel(apiKey, overrideApiKeys), lastError);
    } finally {
      clearTimeout(timeout);
    }
  }

  return {
    transcript: "",
    provider: "groq",
    model: env.groqTranscriptionModel,
    available: false,
    message: lastError.includes("AbortError")
      ? "Voice transcription timed out. Please try a shorter clip."
      : "Voice transcription failed across available Groq keys. Add another key or try again."
  };
}

async function validateSingleGroqKey(key: string, signal: AbortSignal) {
  const response = await fetch("https://api.groq.com/openai/v1/models", {
    method: "GET",
    signal,
    headers: {
      Authorization: `Bearer ${key}`
    }
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Groq ${response.status}: ${text.slice(0, 140)}`);
  }
}

export async function validateGroqKeys(apiKeys: string[] | string | undefined) {
  const keys = configuredGroqKeys(apiKeys).filter(Boolean);
  if (!keys.length) {
    return { ok: false, configured: false, keyCount: 0, validCount: 0, message: "Groq key is missing." };
  }

  let validCount = 0;
  let lastError = "";
  for (const key of keys) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12000);
    try {
      await validateSingleGroqKey(key, controller.signal);
      validCount += 1;
    } catch (error) {
      lastError = error instanceof Error && error.name === "AbortError"
        ? "Groq validation timed out."
        : error instanceof Error ? error.message : String(error);
    } finally {
      clearTimeout(timeout);
    }
  }

  return {
    ok: validCount > 0,
    configured: true,
    keyCount: keys.length,
    validCount,
    message: validCount > 0
      ? `Groq ready (${validCount}/${keys.length} key${keys.length === 1 ? "" : "s"} usable).`
      : `Groq failed: ${lastError || "no usable keys"}.`
  };
}

export function getTranscriptionStatus() {
  return {
    configured: hasGroq,
    keyCount: env.groqApiKeys.length,
    activeKeyCount: activeGroqKeys().length,
    provider: "groq",
    model: env.groqTranscriptionModel
  };
}
