import { Router } from "express";
import { z } from "zod";
import { getUserId } from "../middleware/auth.js";
import { getClientVoiceSummary, listClientVoiceEvents, saveClientVoiceEvent } from "../services/clientVoiceEvents.js";

export const clientEventsRouter = Router();

const voiceEventSchema = z.object({
  eventType: z.enum([
    "local_stt_success",
    "local_stt_filtered_no_speech",
    "local_tts_prewarm",
    "local_tts_success",
    "local_tts_failed",
    "ios_speech_fallback_used",
    "pocket_tts_prewarm",
    "handsfree_restart",
    "vad_ignored_noise",
    "realtime_stream_started",
    "realtime_stream_completed",
    "realtime_stream_fallback",
    "realtime_stream_cancelled",
    "tts_chunk_synth_started",
    "tts_chunk_synth_success",
    "tts_playback_started",
    "tts_playback_finished",
    "tts_playback_failed",
    "barge_in_triggered",
    "barge_in_ignored"
  ]),
  sttProvider: z.string().nullable().optional(),
  ttsProvider: z.string().nullable().optional(),
  model: z.string().nullable().optional(),
  sherpaInitMs: z.number().nullable().optional(),
  sherpaSynthMs: z.number().nullable().optional(),
  pocketInitMs: z.number().nullable().optional(),
  pocketSynthMs: z.number().nullable().optional(),
  supertonicInitMs: z.number().nullable().optional(),
  supertonicSynthMs: z.number().nullable().optional(),
  supertonicRtf: z.number().nullable().optional(),
  ttsLang: z.string().nullable().optional(),
  voiceStyle: z.string().nullable().optional(),
  playbackStartMs: z.number().nullable().optional(),
  ttsChunkIndex: z.number().nullable().optional(),
  ttsChunkChars: z.number().nullable().optional(),
  playbackRoute: z.string().nullable().optional(),
  bargeInDb: z.number().nullable().optional(),
  bargeInNoiseFloor: z.number().nullable().optional(),
  audioBytes: z.number().nullable().optional(),
  sampleRate: z.number().nullable().optional(),
  channels: z.number().nullable().optional(),
  durationSeconds: z.number().nullable().optional(),
  audioFormat: z.string().nullable().optional(),
  fallbackReason: z.string().nullable().optional(),
  transcriptChars: z.number().nullable().optional(),
  replyChars: z.number().nullable().optional(),
  partialTranscriptCount: z.number().nullable().optional(),
  semanticRevisionCount: z.number().nullable().optional(),
  endpointConfidence: z.number().nullable().optional(),
  firstResponseDeltaMs: z.number().nullable().optional(),
  firstTtsAudioMs: z.number().nullable().optional(),
  streamFallbackReason: z.string().nullable().optional(),
  bargeInCancelMs: z.number().nullable().optional()
});

clientEventsRouter.post("/voice", async (req, res, next) => {
  try {
    const body = voiceEventSchema.parse(req.body);
    const event = await saveClientVoiceEvent({
      userId: getUserId(req),
      ...body
    });
    res.json({ ok: true, event });
  } catch (error) {
    next(error);
  }
});

clientEventsRouter.get("/voice", async (req, res, next) => {
  try {
    const limit = z.coerce.number().min(1).max(500).default(100).parse(req.query.limit ?? 100);
    res.json({ events: await listClientVoiceEvents(limit) });
  } catch (error) {
    next(error);
  }
});

clientEventsRouter.get("/voice/summary", async (req, res, next) => {
  try {
    const limit = z.coerce.number().min(1).max(500).default(250).parse(req.query.limit ?? 250);
    res.json(await getClientVoiceSummary(limit));
  } catch (error) {
    next(error);
  }
});
