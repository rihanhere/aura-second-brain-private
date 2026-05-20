import type { NextFunction, Request, Response } from "express";
import { getUserId } from "./auth.js";
import { incrementDailyUsage } from "../services/usageLedger.js";

export async function enforceDailyLimit(req: Request, res: Response, next: NextFunction) {
  try {
    const usage = await incrementDailyUsage(getUserId(req));
    res.locals.usage = usage;

    if (!usage.allowed) {
      return res.status(429).json({
        message: "Daily message limit reached. Your memory is safe; new AI reflections unlock tomorrow.",
        limit: usage.limit,
        used: usage.used,
        remaining: usage.remaining,
        resetAt: usage.resetAt
      });
    }

    return next();
  } catch (error) {
    return next(error);
  }
}
