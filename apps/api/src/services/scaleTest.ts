import type { Request } from "express";

export type ScaleTestMode = "structure-mock" | "llm-sample";

const scalePrefixes = ["aura-scale-stage1-user-", "aura-scale-stage2-user-", "aura-real-sim-user-"];

export function isScaleTestUser(userId: string | undefined) {
  return Boolean(userId && scalePrefixes.some((prefix) => userId.startsWith(prefix)));
}

export function scaleTestModeFromRequest(req: Request, userId: string): ScaleTestMode | null {
  const raw = req.header("x-aura-test-mode")?.trim();
  if (!raw) return null;

  if (!isScaleTestUser(userId)) {
    const error = new Error("Scale test mode is only allowed for isolated scale-test users.");
    (error as Error & { statusCode?: number }).statusCode = 400;
    throw error;
  }

  if (raw === "structure-mock" || raw === "llm-sample") return raw;

  const error = new Error("Invalid AURA scale test mode.");
  (error as Error & { statusCode?: number }).statusCode = 400;
  throw error;
}
