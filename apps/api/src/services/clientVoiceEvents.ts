import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type ClientVoiceEvent = {
  id: string;
  userId: string;
  eventType:
    | "local_stt_success"
    | "local_stt_filtered_no_speech"
    | "local_tts_prewarm"
    | "local_tts_success"
    | "local_tts_failed"
    | "ios_speech_fallback_used"
    | "pocket_tts_prewarm"
    | "handsfree_restart"
    | "vad_ignored_noise"
    | "realtime_stream_started"
    | "realtime_stream_completed"
    | "realtime_stream_fallback"
    | "realtime_stream_cancelled"
    | "tts_chunk_synth_started"
    | "tts_chunk_synth_success"
    | "tts_playback_started"
    | "tts_playback_finished"
    | "tts_playback_failed"
    | "barge_in_triggered"
    | "barge_in_ignored";
  sttProvider?: string | null;
  ttsProvider?: string | null;
  model?: string | null;
  sherpaInitMs?: number | null;
  sherpaSynthMs?: number | null;
  pocketInitMs?: number | null;
  pocketSynthMs?: number | null;
  supertonicInitMs?: number | null;
  supertonicSynthMs?: number | null;
  supertonicRtf?: number | null;
  ttsLang?: string | null;
  voiceStyle?: string | null;
  playbackStartMs?: number | null;
  ttsChunkIndex?: number | null;
  ttsChunkChars?: number | null;
  playbackRoute?: string | null;
  bargeInDb?: number | null;
  bargeInNoiseFloor?: number | null;
  audioBytes?: number | null;
  sampleRate?: number | null;
  channels?: number | null;
  durationSeconds?: number | null;
  audioFormat?: string | null;
  fallbackReason?: string | null;
  transcriptChars?: number | null;
  replyChars?: number | null;
  partialTranscriptCount?: number | null;
  semanticRevisionCount?: number | null;
  endpointConfidence?: number | null;
  firstResponseDeltaMs?: number | null;
  firstTtsAudioMs?: number | null;
  streamFallbackReason?: string | null;
  bargeInCancelMs?: number | null;
  createdAt: string;
};

const apiDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const eventsPath = path.join(apiDir, "data", "aura-client-voice-events.json");
const localEvents: ClientVoiceEvent[] = [];
let loaded = false;

async function loadEvents() {
  if (loaded) return;
  loaded = true;
  try {
    const raw = await fs.readFile(eventsPath, "utf8");
    localEvents.splice(0, localEvents.length, ...(JSON.parse(raw) as ClientVoiceEvent[]));
  } catch {
    // First launch starts with no client voice events.
  }
}

async function persistEvents() {
  await fs.mkdir(path.dirname(eventsPath), { recursive: true });
  await fs.writeFile(eventsPath, JSON.stringify(localEvents.slice(0, 5000), null, 2));
}

export async function saveClientVoiceEvent(event: Omit<ClientVoiceEvent, "id" | "createdAt">) {
  await loadEvents();
  const saved: ClientVoiceEvent = {
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    ...event
  };
  localEvents.unshift(saved);
  await persistEvents();
  console.log("[client-voice]", {
    eventType: saved.eventType,
    sttProvider: saved.sttProvider,
    ttsProvider: saved.ttsProvider,
    sherpaInitMs: saved.sherpaInitMs,
    sherpaSynthMs: saved.sherpaSynthMs,
    pocketInitMs: saved.pocketInitMs,
    pocketSynthMs: saved.pocketSynthMs,
    supertonicInitMs: saved.supertonicInitMs,
    supertonicSynthMs: saved.supertonicSynthMs,
    supertonicRtf: saved.supertonicRtf,
    ttsLang: saved.ttsLang,
    voiceStyle: saved.voiceStyle,
    ttsChunkIndex: saved.ttsChunkIndex,
    ttsChunkChars: saved.ttsChunkChars,
    playbackRoute: saved.playbackRoute,
    bargeInDb: saved.bargeInDb,
    bargeInNoiseFloor: saved.bargeInNoiseFloor,
    audioBytes: saved.audioBytes,
    sampleRate: saved.sampleRate,
    channels: saved.channels,
    durationSeconds: saved.durationSeconds,
    audioFormat: saved.audioFormat,
    fallbackReason: saved.fallbackReason,
    streamFallbackReason: saved.streamFallbackReason,
    firstResponseDeltaMs: saved.firstResponseDeltaMs,
    firstTtsAudioMs: saved.firstTtsAudioMs
  });
  return saved;
}

export async function listClientVoiceEvents(limit = 100) {
  await loadEvents();
  return localEvents.slice(0, limit);
}

export async function getClientVoiceSummary(limit = 250) {
  const events = await listClientVoiceEvents(limit);
  const counts = events.reduce<Record<string, number>>((acc, event) => {
    acc[event.eventType] = (acc[event.eventType] ?? 0) + 1;
    if (event.ttsProvider) acc[`tts:${event.ttsProvider}`] = (acc[`tts:${event.ttsProvider}`] ?? 0) + 1;
    if (event.sttProvider) acc[`stt:${event.sttProvider}`] = (acc[`stt:${event.sttProvider}`] ?? 0) + 1;
    return acc;
  }, {});

  const timingSummary = (values: number[]) => {
    const sorted = values.slice().sort((a, b) => a - b);
    const percentile = (p: number) => {
      if (!sorted.length) return null;
      const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
      return sorted[index];
    };
    return {
      avg: sorted.length ? Math.round(sorted.reduce((sum, value) => sum + value, 0) / sorted.length) : null,
      p50: percentile(50),
      p95: percentile(95),
      max: sorted.length ? sorted[sorted.length - 1] : null
    };
  };
  const sherpaTimes = events
    .filter((event) => typeof event.sherpaSynthMs === "number")
    .map((event) => event.sherpaSynthMs ?? 0);
  const pocketTimes = events
    .filter((event) => typeof event.pocketSynthMs === "number")
    .map((event) => event.pocketSynthMs ?? 0);

  return {
    total: events.length,
    counts,
    sherpaSynthMs: timingSummary(sherpaTimes),
    pocketSynthMs: timingSummary(pocketTimes),
    latest: events.slice(0, 20)
  };
}
