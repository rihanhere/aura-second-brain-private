import { Router } from "express";
import { getUserId } from "../middleware/auth.js";
import { createLightweightInsights } from "../services/insights.js";
import { listMemories } from "../services/memoryStore.js";

export const insightsRouter = Router();

insightsRouter.get("/", async (req, res, next) => {
  try {
    const memories = await listMemories(getUserId(req));
    res.json({ insights: createLightweightInsights(memories as Array<Record<string, unknown>>) });
  } catch (error) {
    next(error);
  }
});
