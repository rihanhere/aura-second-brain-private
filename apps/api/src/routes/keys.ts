import { Router } from "express";
import { validateGeminiEmbeddingKeys, validateOpenRouterKeys } from "../services/openRouter.js";
import { providerOverridesFromRequest } from "../services/providerOverrides.js";
import { validateGroqKeys } from "../services/transcription.js";

export const keysRouter = Router();

keysRouter.post("/validate", async (req, res, next) => {
  try {
    const overrides = providerOverridesFromRequest(req);
    const [openRouter, groq, gemini] = await Promise.all([
      validateOpenRouterKeys(overrides.openRouterApiKeys ?? []),
      validateGroqKeys(overrides.groqApiKeys ?? []),
      validateGeminiEmbeddingKeys(overrides.geminiApiKeys ?? [])
    ]);

    const ok = Boolean(openRouter.ok && groq.ok && gemini.ok);
    res.json({
      ok,
      message: ok ? "All AURA providers are ready." : "One or more AURA providers failed validation.",
      providers: {
        openRouter,
        groq,
        gemini
      }
    });
  } catch (error) {
    next(error);
  }
});
