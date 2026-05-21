import { Router, type Request } from "express";
import { Readable, Transform } from "node:stream";
import { z } from "zod";
import { env } from "../config/env.js";
import { getUserId } from "../middleware/auth.js";
import { providerOverridesFromRequest } from "../services/providerOverrides.js";
import { getGeminiVoiceStatus, synthesizeGeminiVoiceOnly } from "../services/geminiVoice.js";

export const ttsRouter = Router();

type TtsSession = {
  id: string;
  userId: string;
  text: string;
  provider: "elevenlabs" | "gemini";
  voiceId?: string;
  modelId: string;
  outputFormat: string;
  createdAt: number;
  consumed: boolean;
  voiceRunId?: string | null;
};

const sessions = new Map<string, TtsSession>();
const userRequestTimes = new Map<string, number[]>();
const SESSION_TTL_MS = 2 * 60 * 1000;
let cachedDefaultVoiceId: string | null = null;

const sessionSchema = z.object({
  text: z.string().min(1).max(Math.max(1, env.elevenLabsMaxChars)),
  voiceRunId: z.union([z.string(), z.number()]).nullable().optional(),
  voiceId: z.string().min(1).max(120).optional(),
  modelId: z.string().min(1).max(120).optional(),
  outputFormat: z.string().min(1).max(80).optional()
});

function cleanupSessions() {
  const cutoff = Date.now() - SESSION_TTL_MS;
  for (const [id, session] of sessions) {
    if (session.createdAt < cutoff || session.consumed) sessions.delete(id);
  }
}

function assertRateLimit(userId: string) {
  const now = Date.now();
  const cutoff = now - 60_000;
  const recent = (userRequestTimes.get(userId) ?? []).filter((time) => time > cutoff);
  if (recent.length >= env.elevenLabsMaxRequestsPerMinute) {
    const error = new Error("TTS rate limit reached. Try again in a moment.");
    (error as Error & { statusCode?: number }).statusCode = 429;
    throw error;
  }
  recent.push(now);
  userRequestTimes.set(userId, recent);
}

async function resolveElevenLabsVoiceId(override?: string) {
  if (override?.trim()) return override.trim();
  const voiceId = env.elevenLabsVoiceId.trim();
  if (!env.elevenLabsApiKey.trim()) {
    const error = new Error("ElevenLabs TTS is not configured.");
    (error as Error & { statusCode?: number }).statusCode = 503;
    throw error;
  }
  if (voiceId) return voiceId;
  if (cachedDefaultVoiceId) return cachedDefaultVoiceId;

  const response = await fetch("https://api.elevenlabs.io/v1/voices", {
    headers: { "xi-api-key": env.elevenLabsApiKey }
  });
  if (!response.ok) {
    const details = await response.text().catch(() => "");
    const error = new Error(`ElevenLabs voice lookup failed (${response.status}): ${details.slice(0, 180)}`);
    (error as Error & { statusCode?: number }).statusCode = 503;
    throw error;
  }
  const data = await response.json() as { voices?: Array<{ voice_id?: string; name?: string; category?: string }> };
  const voices = data.voices ?? [];
  const preferredNames = ["adam", "antoni", "josh", "clyde"];
  const selected = voices.find((voice) => preferredNames.includes((voice.name ?? "").toLowerCase()))
    ?? voices.find((voice) => (voice.category ?? "").toLowerCase() === "premade")
    ?? voices[0];
  if (!selected?.voice_id) {
    const error = new Error("No ElevenLabs voices are available for this key.");
    (error as Error & { statusCode?: number }).statusCode = 503;
    throw error;
  }
  cachedDefaultVoiceId = selected.voice_id;
  console.log("[tts-elevenlabs] default_voice_selected", {
    voiceId: selected.voice_id,
    name: selected.name ?? null,
    category: selected.category ?? null
  });
  return selected.voice_id;
}

function elevenLabsUrl(session: TtsSession) {
  if (!session.voiceId) throw new Error("ElevenLabs voice id is missing.");
  const params = new URLSearchParams({
    output_format: session.outputFormat,
    optimize_streaming_latency: String(Math.max(0, Math.min(4, env.elevenLabsOptimizeStreamingLatency)))
  });
  return `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(session.voiceId)}/stream?${params}`;
}

async function fetchElevenLabsStream(session: TtsSession, signal: AbortSignal) {
  const response = await fetch(elevenLabsUrl(session), {
    method: "POST",
    signal,
    headers: {
      "xi-api-key": env.elevenLabsApiKey,
      "Content-Type": "application/json",
      "Accept": "audio/mpeg"
    },
    body: JSON.stringify({
      text: session.text,
      model_id: session.modelId,
      voice_settings: {
        stability: 0.48,
        similarity_boost: 0.72,
        style: 0.0,
        use_speaker_boost: true
      }
    })
  });
  if (!response.ok || !response.body) {
    const details = await response.text().catch(() => "");
    const error = new Error(`ElevenLabs TTS failed (${response.status}): ${details.slice(0, 180)}`);
    (error as Error & { statusCode?: number }).statusCode = response.status || 502;
    throw error;
  }
  return response;
}

ttsRouter.get("/status", (_req, res) => {
  const gemini = getGeminiVoiceStatus();
  res.json({
    ok: true,
    provider: "gemini",
    configured: gemini.configured,
    modelId: gemini.model,
    voice: gemini.voice,
    outputFormat: "wav_pcm_24000",
    maxChars: env.elevenLabsMaxChars
  });
});

ttsRouter.get("/orca/config", (_req, res) => {
  const voice = env.orcaDefaultVoice.toLowerCase().startsWith("f") ? "female" : "male";
  res.setHeader("Cache-Control", "no-store");
  res.json({
    ok: true,
    provider: "orca",
    configured: Boolean(env.picovoiceAccessKey.trim()),
    accessKey: env.picovoiceAccessKey.trim() || null,
    voice,
    modelFile: voice === "female" ? "orca_params_en_female.pv" : "orca_params_en_male.pv",
    sampleRate: null
  });
});

ttsRouter.post("/gemini/session", async (req, res, next) => {
  try {
    cleanupSessions();
    const body = sessionSchema.parse(req.body);
    const userId = getUserId(req);
    assertRateLimit(userId);
    const id = crypto.randomUUID();
    const session: TtsSession = {
      id,
      userId,
      provider: "gemini",
      text: body.text.replace(/\s+/g, " ").trim(),
      modelId: env.geminiTtsModel,
      outputFormat: "wav_pcm_24000",
      createdAt: Date.now(),
      consumed: false,
      voiceRunId: body.voiceRunId == null ? null : String(body.voiceRunId)
    };
    sessions.set(id, session);
    console.log("[tts-gemini] session_created", {
      userId,
      sessionId: id,
      voiceRunId: session.voiceRunId,
      chars: session.text.length,
      modelId: session.modelId,
      voice: env.geminiTtsVoice
    });
    res.json({
      provider: "gemini",
      model: session.modelId,
      mimeType: "audio/wav",
      streamId: id,
      audioUrl: `/tts/gemini/session/${id}/audio`,
      expiresInMs: SESSION_TTL_MS
    });
  } catch (error) {
    next(error);
  }
});

ttsRouter.post("/gemini/stream", async (req, res, next) => {
  try {
    const body = sessionSchema.parse(req.body);
    const userId = getUserId(req);
    assertRateLimit(userId);
    const session: TtsSession = {
      id: `direct-${crypto.randomUUID()}`,
      userId,
      provider: "gemini",
      text: body.text.replace(/\s+/g, " ").trim(),
      modelId: env.geminiTtsModel,
      outputFormat: "wav_pcm_24000",
      createdAt: Date.now(),
      consumed: true,
      voiceRunId: body.voiceRunId == null ? null : String(body.voiceRunId)
    };
    await sendGeminiAudio(session, req, res);
  } catch (error) {
    next(error);
  }
});

ttsRouter.get("/gemini/session/:id/audio", async (req, res, next) => {
  try {
    cleanupSessions();
    const session = sessions.get(req.params.id);
    if (!session || session.consumed || session.provider !== "gemini") {
      res.status(404).json({ message: "TTS stream expired." });
      return;
    }
    session.consumed = true;
    sessions.delete(session.id);
    await sendGeminiAudio(session, req, res);
  } catch (error) {
    next(error);
  }
});

ttsRouter.post("/elevenlabs/session", async (req, res, next) => {
  try {
    cleanupSessions();
    const body = sessionSchema.parse(req.body);
    const userId = getUserId(req);
    assertRateLimit(userId);
    const voiceId = await resolveElevenLabsVoiceId(body.voiceId);
    const modelId = body.modelId?.trim() || env.elevenLabsModelId;
    const outputFormat = body.outputFormat?.trim() || env.elevenLabsOutputFormat;
    const id = crypto.randomUUID();
    const session: TtsSession = {
      id,
      userId,
      provider: "elevenlabs",
      text: body.text.replace(/\s+/g, " ").trim(),
      voiceId,
      modelId,
      outputFormat,
      createdAt: Date.now(),
      consumed: false,
      voiceRunId: body.voiceRunId == null ? null : String(body.voiceRunId)
    };
    sessions.set(id, session);
    console.log("[tts-elevenlabs] session_created", {
      userId,
      sessionId: id,
      voiceRunId: session.voiceRunId,
      chars: session.text.length,
      modelId,
      outputFormat
    });
    res.json({
      provider: "elevenlabs",
      model: modelId,
      mimeType: "audio/mpeg",
      streamId: id,
      audioUrl: `/tts/elevenlabs/session/${id}/audio`,
      expiresInMs: SESSION_TTL_MS
    });
  } catch (error) {
    next(error);
  }
});

ttsRouter.post("/elevenlabs/stream", async (req, res, next) => {
  try {
    const body = sessionSchema.parse(req.body);
    const userId = getUserId(req);
    assertRateLimit(userId);
    const session: TtsSession = {
      id: `direct-${crypto.randomUUID()}`,
      userId,
      provider: "elevenlabs",
      text: body.text.replace(/\s+/g, " ").trim(),
      voiceId: await resolveElevenLabsVoiceId(body.voiceId),
      modelId: body.modelId?.trim() || env.elevenLabsModelId,
      outputFormat: body.outputFormat?.trim() || env.elevenLabsOutputFormat,
      createdAt: Date.now(),
      consumed: true,
      voiceRunId: body.voiceRunId == null ? null : String(body.voiceRunId)
    };
    await pipeElevenLabsAudio(session, req, res);
  } catch (error) {
    next(error);
  }
});

ttsRouter.get("/elevenlabs/session/:id/audio", async (req, res, next) => {
  try {
    cleanupSessions();
    const session = sessions.get(req.params.id);
    if (!session || session.consumed || session.provider !== "elevenlabs") {
      res.status(404).json({ message: "TTS stream expired." });
      return;
    }
    session.consumed = true;
    sessions.delete(session.id);
    await pipeElevenLabsAudio(session, req, res);
  } catch (error) {
    next(error);
  }
});

async function pipeElevenLabsAudio(session: TtsSession, req: { on: (event: string, listener: () => void) => unknown }, res: import("express").Response) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), env.elevenLabsTtsTimeoutMs);
  req.on("close", () => controller.abort());
  const startedAt = Date.now();
  const upstream = await fetchElevenLabsStream(session, controller.signal);
  let firstByteLogged = false;
  const firstByteProbe = new Transform({
    transform(chunk, _encoding, callback) {
      if (!firstByteLogged) {
        firstByteLogged = true;
        console.log("[tts-elevenlabs] first_provider_byte", {
          userId: session.userId,
          sessionId: session.id,
          voiceRunId: session.voiceRunId,
          ms: Date.now() - startedAt,
          bytes: chunk.length
        });
      }
      callback(null, chunk);
    }
  });

  res.setHeader("Content-Type", upstream.headers.get("content-type") ?? "audio/mpeg");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Aura-TTS-Provider", "elevenlabs");
  res.setHeader("X-Aura-TTS-Model", session.modelId);
  res.setHeader("X-Aura-TTS-Started-At", new Date(startedAt).toISOString());

  console.log("[tts-elevenlabs] stream_started", {
    userId: session.userId,
    sessionId: session.id,
    voiceRunId: session.voiceRunId,
    chars: session.text.length
  });

  await new Promise<void>((resolve, reject) => {
    const nodeStream = Readable.fromWeb(upstream.body as unknown as import("node:stream/web").ReadableStream);
    nodeStream.on("error", reject);
    firstByteProbe.on("error", reject);
    res.on("error", reject);
    res.on("close", resolve);
    res.on("finish", resolve);
    nodeStream.pipe(firstByteProbe).pipe(res);
  }).finally(() => {
    clearTimeout(timeout);
    console.log("[tts-elevenlabs] stream_finished", {
      userId: session.userId,
      sessionId: session.id,
      voiceRunId: session.voiceRunId,
      durationMs: Date.now() - startedAt,
      firstByteLogged
    });
  });
}

function sampleRateFromMime(mimeType?: string | null) {
  const match = /rate=(\d+)/i.exec(mimeType ?? "");
  return match ? Number(match[1]) : 24000;
}

function pcmToWav(pcm: Buffer, sampleRate = 24000, channels = 1, bitsPerSample = 16) {
  const byteRate = sampleRate * channels * (bitsPerSample / 8);
  const blockAlign = channels * (bitsPerSample / 8);
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

async function sendGeminiAudio(session: TtsSession, req: Request, res: import("express").Response) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  res.on("close", () => {
    if (!res.writableEnded) controller.abort();
  });
  const startedAt = Date.now();

  try {
    console.log("[tts-gemini] stream_started", {
      userId: session.userId,
      sessionId: session.id,
      voiceRunId: session.voiceRunId,
      chars: session.text.length
    });
    const result = await synthesizeGeminiVoiceOnly(session.text, providerOverridesFromRequest(req), {
      signal: controller.signal,
      jobId: session.id
    });
    const pcm = Buffer.from(result.audioBase64, "base64");
    const sampleRate = sampleRateFromMime(result.mimeType);
    const audio = result.mimeType?.includes("wav") ? pcm : pcmToWav(pcm, sampleRate);

    res.setHeader("Content-Type", "audio/wav");
    res.setHeader("Content-Length", String(audio.length));
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Aura-TTS-Provider", "gemini");
    res.setHeader("X-Aura-TTS-Model", result.model);
    res.setHeader("X-Aura-TTS-Voice", result.voice);
    res.setHeader("X-Aura-TTS-Started-At", new Date(startedAt).toISOString());
    console.log("[tts-gemini] first_provider_audio", {
      userId: session.userId,
      sessionId: session.id,
      voiceRunId: session.voiceRunId,
      ms: Date.now() - startedAt,
      pcmBytes: pcm.length,
      wavBytes: audio.length,
      sampleRate
    });
    res.end(audio);
  } finally {
    clearTimeout(timeout);
    console.log("[tts-gemini] stream_finished", {
      userId: session.userId,
      sessionId: session.id,
      voiceRunId: session.voiceRunId,
      durationMs: Date.now() - startedAt
    });
  }
}
