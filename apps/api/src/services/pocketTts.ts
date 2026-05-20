import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { env } from "../config/env.js";
import type { ChaosControls } from "./providerOverrides.js";

const execFileAsync = promisify(execFile);
const POCKET_TTS_MAX_CONCURRENCY = Math.max(1, env.ttsPocketMaxConcurrency);
const POCKET_TTS_QUEUE_TIMEOUT_MS = Math.max(0, env.ttsQueueWaitMs);
let activePocketJobs = 0;
const pocketWaiters: Array<() => void> = [];
const activeWorkDirs = new Set<string>();

export type PocketVoiceOptions = {
  signal?: AbortSignal;
  jobId?: string;
};

function wakeNextPocketJob() {
  const next = pocketWaiters.shift();
  if (next) next();
}

async function acquirePocketSlot() {
  if (activePocketJobs < POCKET_TTS_MAX_CONCURRENCY) {
    activePocketJobs += 1;
    return true;
  }

  if (POCKET_TTS_QUEUE_TIMEOUT_MS <= 0) return false;

  return new Promise<boolean>((resolve) => {
    let resolved = false;
    const waiter = () => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timeout);
      activePocketJobs += 1;
      resolve(true);
    };
    const timeout = setTimeout(() => {
      if (resolved) return;
      resolved = true;
      const index = pocketWaiters.indexOf(waiter);
      if (index >= 0) pocketWaiters.splice(index, 1);
      resolve(false);
    }, POCKET_TTS_QUEUE_TIMEOUT_MS);

    pocketWaiters.push(waiter);
  });
}

function releasePocketSlot() {
  activePocketJobs = Math.max(0, activePocketJobs - 1);
  wakeNextPocketJob();
}

function cleanText(text: string) {
  return text.replace(/\s+/g, " ").trim().slice(0, 1200);
}

function extractPcmFromWav(wav: Buffer) {
  if (wav.length < 44 || wav.toString("ascii", 0, 4) !== "RIFF" || wav.toString("ascii", 8, 12) !== "WAVE") {
    return wav;
  }

  let offset = 12;
  while (offset + 8 <= wav.length) {
    const chunkId = wav.toString("ascii", offset, offset + 4);
    const chunkSize = wav.readUInt32LE(offset + 4);
    const dataStart = offset + 8;
    const dataEnd = Math.min(dataStart + chunkSize, wav.length);
    if (chunkId === "data") return wav.subarray(dataStart, dataEnd);
    offset = dataStart + chunkSize + (chunkSize % 2);
  }

  return wav.subarray(44);
}

function sleep(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("Pocket TTS aborted"));
      return;
    }
    const timeout = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timeout);
      reject(new Error("Pocket TTS aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw new Error("Pocket TTS aborted");
}

export async function synthesizePocketVoice(text: string, chaos?: ChaosControls, options: PocketVoiceOptions = {}) {
  if (!env.pocketTtsEnabled || !env.pocketTtsCommand || !env.pocketTtsCommandArgs.length) return null;
  throwIfAborted(options.signal);
  if (chaos?.voiceDelayMs) await sleep(chaos.voiceDelayMs, options.signal);
  if (chaos?.pocketFail) {
    console.warn("[aura-chaos] simulated Pocket TTS failure");
    return null;
  }

  const safeText = cleanText(text);
  if (!safeText) return null;
  throwIfAborted(options.signal);
  const slotAcquired = await acquirePocketSlot();
  if (!slotAcquired) {
    console.warn("[pocket-tts] busy; returning null for app-side fallback", {
      active: activePocketJobs,
      queued: pocketWaiters.length,
      maxConcurrency: POCKET_TTS_MAX_CONCURRENCY,
      queueTimeoutMs: POCKET_TTS_QUEUE_TIMEOUT_MS
    });
    return null;
  }

  const workDir = path.join(os.tmpdir(), `aura-pocket-tts-${randomUUID()}`);
  const outputPath = path.join(workDir, "voice.wav");
  const maxTokens = Math.min(260, Math.max(40, Math.ceil(safeText.length / 4)));

  await mkdir(workDir, { recursive: true });
  activeWorkDirs.add(workDir);
  try {
    throwIfAborted(options.signal);
    const args = [
      ...env.pocketTtsCommandArgs,
      "--text",
      safeText,
      "--output-path",
      outputPath,
      "--language",
      env.pocketTtsLanguage,
      "--device",
      env.pocketTtsDevice,
      "--max-tokens",
      String(maxTokens),
      "--quiet"
    ];
    if (env.pocketTtsVoice) args.push("--voice", env.pocketTtsVoice);

    console.log("[pocket-tts] attempting fallback voice", {
      command: env.pocketTtsCommand,
      jobId: options.jobId,
      language: env.pocketTtsLanguage,
      device: env.pocketTtsDevice,
      originalCharacters: text.replace(/\s+/g, " ").trim().length,
      characters: safeText.length,
      wasTruncated: safeText.length < text.replace(/\s+/g, " ").trim().length,
      maxTokens
    });

    await execFileAsync(env.pocketTtsCommand, args, {
      timeout: env.ttsJobTimeoutMs,
      maxBuffer: 4 * 1024 * 1024,
      windowsHide: true,
      signal: options.signal
    });

    throwIfAborted(options.signal);
    const wav = await readFile(outputPath);
    const pcm = extractPcmFromWav(wav);
    const audioBase64 = pcm.toString("base64");
    console.log("[pocket-tts] success", {
      wavBytes: wav.byteLength,
      pcmBytes: pcm.byteLength,
      timeoutMs: env.ttsJobTimeoutMs
    });

    return {
      audioBase64,
      mimeType: "audio/pcm;rate=24000",
      provider: "pocket-tts",
      model: `kyutai/pocket-tts:${env.pocketTtsLanguage}`,
      voice: env.pocketTtsVoice || "alba"
    };
  } catch (error) {
    console.warn("[pocket-tts] fallback failed", error instanceof Error ? error.message : error);
    return null;
  } finally {
    activeWorkDirs.delete(workDir);
    releasePocketSlot();
    await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

export async function cleanupStalePocketTempDirs(maxAgeMs = env.ttsTempMaxAgeMs) {
  const tmpDir = os.tmpdir();
  let cleaned = 0;
  const entries = await readdir(tmpDir).catch(() => []);
  const cutoff = Date.now() - maxAgeMs;
  await Promise.all(entries.map(async (entry) => {
    if (!entry.startsWith("aura-pocket-tts-")) return;
    const fullPath = path.join(tmpDir, entry);
    if (activeWorkDirs.has(fullPath)) return;
    const info = await stat(fullPath).catch(() => null);
    if (!info || info.mtimeMs > cutoff) return;
    await rm(fullPath, { recursive: true, force: true }).then(() => {
      cleaned += 1;
    }).catch(() => undefined);
  }));
  return cleaned;
}

export function getPocketTtsRuntimeStatus() {
  return {
    activePocketJobs,
    queuedPocketJobs: pocketWaiters.length,
    activeWorkDirs: activeWorkDirs.size
  };
}

export function getPocketTtsStatus() {
  return {
    configured: env.pocketTtsEnabled,
    provider: "pocket-tts",
    command: env.pocketTtsCommand,
    language: env.pocketTtsLanguage,
    device: env.pocketTtsDevice,
    timeoutMs: env.ttsJobTimeoutMs,
    maxConcurrency: POCKET_TTS_MAX_CONCURRENCY,
    queueTimeoutMs: POCKET_TTS_QUEUE_TIMEOUT_MS,
    voice: env.pocketTtsVoice || "alba"
  };
}
