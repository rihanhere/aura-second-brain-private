import { Router } from "express";
import { getUserId } from "../middleware/auth.js";
import { getDailyUsageStatus } from "../services/usageLedger.js";

export const usageRouter = Router();

usageRouter.get("/", async (req, res, next) => {
  try {
    res.json({ usage: await getDailyUsageStatus(getUserId(req)) });
  } catch (error) {
    next(error);
  }
});
