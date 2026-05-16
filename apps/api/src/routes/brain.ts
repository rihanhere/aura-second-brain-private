import { Router } from "express";
import { getBrainOrchestratorMetrics } from "../services/brainOrchestrator.js";

export const brainRouter = Router();

brainRouter.get("/metrics", (_req, res) => {
  res.json(getBrainOrchestratorMetrics());
});
