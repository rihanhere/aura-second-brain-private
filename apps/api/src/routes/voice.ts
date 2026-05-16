import { Router } from "express";
import multer from "multer";
import { z } from "zod";
import { transcribeAudio } from "../services/transcription.js";
import { providerOverridesFromRequest } from "../services/providerOverrides.js";
import { getUserId } from "../middleware/auth.js";
import { cancelVoiceJobs, getVoiceOrchestratorMetrics, queueVoiceSynthesis } from "../services/voiceOrchestrator.js";

export const voiceRouter = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 18 * 1024 * 1024
  }
});

voiceRouter.post("/transcribe", upload.single("audio"), async (req, res, next) => {
  try {
    const overrides = providerOverridesFromRequest(req);
    console.log("[voice/transcribe] request", {
      hasFile: Boolean(req.file),
      contentType: req.headers["content-type"],
      userAgent: req.headers["user-agent"],
      size: req.file?.size,
      mimetype: req.file?.mimetype,
      originalname: req.file?.originalname
    });

    if (!req.file) {
      return res.status(400).json({ message: "Audio file is required." });
    }

    if (overrides.chaos?.sttDelayMs) {
      await new Promise((resolve) => setTimeout(resolve, overrides.chaos?.sttDelayMs));
    }
    if (overrides.chaos?.sttEmpty) {
      console.warn("[aura-chaos] simulated empty STT transcript");
      return res.json({
        transcript: "",
        provider: "chaos",
        model: null,
        available: true,
        message: "Simulated empty transcription."
      });
    }

    const result = await transcribeAudio(req.file, overrides.groqApiKeys);
    console.log("[voice/transcribe] result", {
      available: result.available,
      provider: result.provider,
      model: result.model,
      transcriptLength: result.transcript.length,
      message: result.message
    });
    res.json(result);
  } catch (error) {
    next(error);
  }
});

voiceRouter.post("/synthesize", async (req, res, next) => {
  try {
    const body = z.object({
      text: z.string().min(1).max(1000),
      priority: z.enum(["reply", "reminder", "test"]).optional(),
      speechSessionId: z.string().min(1).max(200).optional(),
      interruptPrevious: z.boolean().optional(),
      staleAfterMs: z.number().int().positive().max(120_000).optional()
    }).parse(req.body);
    const overrides = providerOverridesFromRequest(req);
    const voice = await queueVoiceSynthesis({
      userId: getUserId(req),
      text: body.text,
      priority: body.priority ?? "reply",
      speechSessionId: body.speechSessionId ?? req.header("x-aura-speech-session-id") ?? null,
      interruptPrevious: body.interruptPrevious ?? false,
      staleAfterMs: body.staleAfterMs,
      overrides,
      fast: true
    }).catch((error) => {
      console.warn("[voice/synthesize] Gemini voice failed", error instanceof Error ? error.message : error);
      return null;
    });
    res.json({ voice });
  } catch (error) {
    next(error);
  }
});

voiceRouter.get("/metrics", (_req, res) => {
  res.json(getVoiceOrchestratorMetrics());
});

voiceRouter.post("/cancel", (req, res, next) => {
  try {
    const body = z.object({
      userId: z.string().min(1).max(200).optional(),
      speechSessionId: z.string().min(1).max(200).optional()
    }).parse(req.body ?? {});
    const canceled = cancelVoiceJobs({
      userId: body.userId ?? getUserId(req),
      speechSessionId: body.speechSessionId ?? req.header("x-aura-speech-session-id") ?? null
    });
    res.json({ ok: true, canceled });
  } catch (error) {
    next(error);
  }
});
