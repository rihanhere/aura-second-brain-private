import type { Request } from "express";
import { isScaleTestUser } from "./scaleTest.js";

export type ProviderOverrides = {
  openRouterApiKeys?: string[];
  groqApiKey?: string;
  groqApiKeys?: string[];
  geminiApiKeys?: string[];
  testCreatedAt?: string;
  chaos?: ChaosControls;
};

export type ChaosControls = {
  enabled: boolean;
  brainFail?: boolean;
  brainDelayMs?: number;
  memoryDelayMs?: number;
  geminiFail?: boolean;
  pocketFail?: boolean;
  voiceDelayMs?: number;
  sttEmpty?: boolean;
  sttDelayMs?: number;
};

function splitKeys(value: string | undefined) {
  return (value ?? "")
    .split(",")
    .map((key) => key.trim())
    .filter(Boolean);
}

function firstHeader(req: Request, name: string) {
  const value = req.header(name);
  return Array.isArray(value) ? value[0] : value;
}

function boundedMs(value: string | undefined, maxMs: number) {
  const parsed = Number(value ?? 0);
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  return Math.min(Math.round(parsed), maxMs);
}

function isBetaTestUser(userId: string | undefined) {
  return Boolean(
    userId?.startsWith("aura-beta-chaos-") ||
    userId?.startsWith("aura-beta-concurrent-") ||
    userId?.startsWith("aura-beta-interrupt-storm-") ||
    userId?.startsWith("aura-beta-brain-burst-") ||
    isScaleTestUser(userId)
  );
}

function parseChaosHeader(value: string | undefined, userId: string | undefined): ChaosControls | undefined {
  if (!value || !isBetaTestUser(userId)) return undefined;

  const controls: ChaosControls = { enabled: true };
  for (const rawToken of value.split(",")) {
    const [rawKey, rawValue] = rawToken.split("=");
    const key = rawKey.trim().toLowerCase();
    const tokenValue = rawValue?.trim();
    if (!key) continue;

    if (key === "brain-fail") controls.brainFail = true;
    if (key === "brain-delay") controls.brainDelayMs = boundedMs(tokenValue, 8000);
    if (key === "memory-delay") controls.memoryDelayMs = boundedMs(tokenValue, 8000);
    if (key === "gemini-fail") controls.geminiFail = true;
    if (key === "pocket-fail") controls.pocketFail = true;
    if (key === "voice-delay") controls.voiceDelayMs = boundedMs(tokenValue, 8000);
    if (key === "stt-empty") controls.sttEmpty = true;
    if (key === "stt-delay") controls.sttDelayMs = boundedMs(tokenValue, 8000);
  }

  return controls;
}

export function providerOverridesFromRequest(req: Request): ProviderOverrides {
  const userId = firstHeader(req, "x-user-id");
  const testCreatedAt = firstHeader(req, "x-aura-test-created-at");
  const openRouterApiKeys = splitKeys(firstHeader(req, "x-aura-openrouter-keys"));
  const geminiApiKeys = splitKeys(firstHeader(req, "x-aura-gemini-keys"));
  const groqApiKeys = [
    ...splitKeys(firstHeader(req, "x-aura-groq-keys")),
    ...splitKeys(firstHeader(req, "x-aura-groq-key"))
  ];

  return {
    openRouterApiKeys: openRouterApiKeys.length ? openRouterApiKeys : undefined,
    geminiApiKeys: geminiApiKeys.length ? geminiApiKeys : undefined,
    groqApiKeys: groqApiKeys.length ? groqApiKeys : undefined,
    groqApiKey: groqApiKeys[0] || undefined,
    testCreatedAt: isBetaTestUser(userId) && testCreatedAt && !Number.isNaN(new Date(testCreatedAt).getTime()) ? testCreatedAt : undefined,
    chaos: parseChaosHeader(firstHeader(req, "x-aura-chaos"), userId)
  };
}
