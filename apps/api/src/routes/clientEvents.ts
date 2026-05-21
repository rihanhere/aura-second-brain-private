import { Router } from "express";
import { z } from "zod";
import { getUserId } from "../middleware/auth.js";
import { getClientVoiceSummary, listClientVoiceEvents, saveClientVoiceEvent } from "../services/clientVoiceEvents.js";

export const clientEventsRouter = Router();

const voiceEventSchema = z.object({
  eventType: z.enum([
    "local_stt_success",
    "local_stt_filtered_no_speech",
    "validation_voice_turn_request",
    "validation_voice_turn_started",
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
    "reply_text_visible",
    "tts_chunk_synth_started",
    "tts_chunk_synth_success",
    "tts_audio_ready",
    "tts_playback_started",
    "tts_playback_finished",
    "tts_cancelled",
    "tts_playback_failed",
    "barge_in_monitor_scheduled",
    "barge_in_native_started",
    "barge_in_monitor_started",
    "barge_in_triggered",
    "barge_in_ignored",
    "barge_in_listening_restart_requested",
    "barge_in_listening_restarted",
    "barge_in_listening_restart_failed",
    "barge_in_audio_stopped"
  ]),
  voiceRunId: z.number().nullable().optional(),
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
  turnElapsedMs: z.number().nullable().optional(),
  replyTextVisibleMs: z.number().nullable().optional(),
  ttsSynthStartMs: z.number().nullable().optional(),
  ttsSynthDoneMs: z.number().nullable().optional(),
  ttsAudioReadyMs: z.number().nullable().optional(),
  ttsFileIoMs: z.number().nullable().optional(),
  ttsExpoLoadMs: z.number().nullable().optional(),
  ttsAudioModeMs: z.number().nullable().optional(),
  ttsPlayAsyncMs: z.number().nullable().optional(),
  ttsStopExistingAudioMs: z.number().nullable().optional(),
  ttsPlaybackStartMs: z.number().nullable().optional(),
  ttsFirstAudibleEstimateMs: z.number().nullable().optional(),
  ttsPlaybackFinishMs: z.number().nullable().optional(),
  ttsGapMs: z.number().nullable().optional(),
  audioStopMs: z.number().nullable().optional(),
  ttsChunkIndex: z.number().nullable().optional(),
  ttsChunkChars: z.number().nullable().optional(),
  playbackRoute: z.string().nullable().optional(),
  routeBeforePlayback: z.string().nullable().optional(),
  routeAfterPlaybackStart: z.string().nullable().optional(),
  routeAfterBargeInStart: z.string().nullable().optional(),
  bargeInDb: z.number().nullable().optional(),
  bargeInNoiseFloor: z.number().nullable().optional(),
  bargeInThresholdDb: z.number().nullable().optional(),
  bargeInSpeechMs: z.number().nullable().optional(),
  bargeInArmDelayMs: z.number().nullable().optional(),
  supertonicAudioReadyMs: z.number().nullable().optional(),
  supertonicFileWriteMs: z.number().nullable().optional(),
  supertonicWasInitialized: z.boolean().nullable().optional(),
  supertonicWarmupComplete: z.boolean().nullable().optional(),
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
