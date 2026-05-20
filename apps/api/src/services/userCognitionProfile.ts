import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getPrivacySettings } from "./privacySettings.js";
import { isScaleTestUser } from "./scaleTest.js";

export type UserCognitionProfile = {
  userId: string;
  replyStyle: "short" | "balanced" | "detailed";
  tonePreference: "calm" | "playful" | "analytical" | "direct";
  languagePattern: string[];
  energyPattern: string[];
  interruptionPattern: string;
  activeHours: number[];
  recurringThemes: string[];
  relationshipBoundaries: string[];
  confidence: number;
  updatedAt: string;
};

const apiDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const localPath = path.join(apiDir, "data", "user-cognition-profiles.json");
const localProfiles: UserCognitionProfile[] = [];
const scaleProfiles: UserCognitionProfile[] = [];
let loaded = false;

function defaultProfile(userId: string): UserCognitionProfile {
  return {
    userId,
    replyStyle: "balanced",
    tonePreference: "calm",
    languagePattern: [],
    energyPattern: [],
    interruptionPattern: "normal",
    activeHours: [],
    recurringThemes: [],
    relationshipBoundaries: [],
    confidence: 0.25,
    updatedAt: new Date().toISOString()
  };
}

async function loadProfiles() {
  if (loaded) return;
  loaded = true;
  try {
    const raw = await fs.readFile(localPath, "utf8");
    localProfiles.splice(0, localProfiles.length, ...(JSON.parse(raw) as UserCognitionProfile[]));
  } catch {
    // First launch has no per-user cognition profile.
  }
}

async function persistProfiles() {
  await fs.mkdir(path.dirname(localPath), { recursive: true });
  await fs.writeFile(localPath, JSON.stringify(localProfiles.slice(0, 100_000), null, 2));
}

function storeForUser(userId: string) {
  return isScaleTestUser(userId)
    ? { profiles: scaleProfiles, persist: async () => undefined }
    : { profiles: localProfiles, persist: persistProfiles };
}

function unique(values: string[], limit = 12) {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean))).slice(0, limit);
}

function detectLanguage(content: string) {
  const langs: string[] = [];
  if (/[\u0900-\u097F]/.test(content)) langs.push("hi");
  if (/\b(hai|haan|nahi|kya|kaise|matlab|abhi|bhai|karna|bolo|ruko)\b/i.test(content)) langs.push("hinglish");
  if (/[a-z]/i.test(content)) langs.push("en");
  return langs.length ? langs : ["unknown"];
}

function detectThemes(content: string) {
  const lower = content.toLowerCase();
  return [
    /\b(aura|app|voice|memory|assistant)\b/.test(lower) ? "aura" : "",
    /\b(code|coding|developer|swift|backend)\b/.test(lower) ? "coding" : "",
    /\b(work|startup|launch|profit|cost|user)\b/.test(lower) ? "work-business" : "",
    /\b(girlfriend|friend|family|dad|mom)\b/.test(lower) ? "relationships" : "",
    /\b(tired|sleep|stress|sad|confused|stuck)\b/.test(lower) ? "emotional-energy" : ""
  ].filter(Boolean);
}

function detectEnergy(content: string) {
  const lower = content.toLowerCase();
  if (/\b(fast|quick|short|simple|jaldi)\b/.test(lower)) return "fast-direct";
  if (/\b(explain|analyze|architecture|plan|technical)\b/.test(lower)) return "analytical";
  if (/\b(tired|sad|stress|low|stuck)\b/.test(lower)) return "low-energy";
  if (/\b(haha|lol|fun|play)\b/.test(lower)) return "playful";
  return "neutral";
}

function nextReplyStyle(current: UserCognitionProfile["replyStyle"], content: string) {
  if (/\b(short|simple|fast|brief|not long|seedha|jaldi)\b/i.test(content)) return "short";
  if (/\b(detail|deep|full|proper|explain fully)\b/i.test(content)) return "detailed";
  return current;
}

function nextTone(current: UserCognitionProfile["tonePreference"], content: string) {
  if (/\b(technical|analyze|architecture|logic)\b/i.test(content)) return "analytical";
  if (/\b(normal|direct|seedha|straight)\b/i.test(content)) return "direct";
  if (/\b(fun|joke|playful|haha|lol)\b/i.test(content)) return "playful";
  return current;
}

function localHour(date: Date, timezone: string) {
  const value = new Intl.DateTimeFormat("en-US", { timeZone: timezone || "UTC", hour: "numeric", hour12: false }).format(date);
  return Number(value);
}

export async function getUserCognitionProfile(userId: string) {
  await loadProfiles();
  const store = storeForUser(userId);
  return store.profiles.find((item) => item.userId === userId) ?? defaultProfile(userId);
}

export async function observeUserCognitionSignal(input: {
  userId: string;
  content: string;
  timezone: string;
  createdAt?: Date;
}) {
  const privacy = await getPrivacySettings(input.userId);
  if (!privacy.allowPersonalAdaptation || privacy.privateMode) return getUserCognitionProfile(input.userId);

  await loadProfiles();
  const store = storeForUser(input.userId);
  const current = store.profiles.find((item) => item.userId === input.userId) ?? defaultProfile(input.userId);
  const hour = localHour(input.createdAt ?? new Date(), input.timezone);
  const interruptionPattern = /\b(stop|wait|ruko|hold on|cancel|leave that|ek second)\b/i.test(input.content)
    ? "frequent_interrupt"
    : current.interruptionPattern;
  const next: UserCognitionProfile = {
    ...current,
    replyStyle: nextReplyStyle(current.replyStyle, input.content),
    tonePreference: nextTone(current.tonePreference, input.content),
    languagePattern: unique([...detectLanguage(input.content), ...current.languagePattern], 8),
    energyPattern: unique([detectEnergy(input.content), ...current.energyPattern], 8),
    interruptionPattern,
    activeHours: unique([String(hour), ...current.activeHours.map(String)], 12).map(Number),
    recurringThemes: unique([...detectThemes(input.content), ...current.recurringThemes], 12),
    relationshipBoundaries: /\b(creepy|too much|don't mention|dont mention|private)\b/i.test(input.content)
      ? unique(["avoid_over_recall", ...current.relationshipBoundaries], 8)
      : current.relationshipBoundaries,
    confidence: Math.min(0.95, current.confidence + 0.03),
    updatedAt: new Date().toISOString()
  };
  const index = store.profiles.findIndex((item) => item.userId === input.userId);
  if (index >= 0) store.profiles[index] = next;
  else store.profiles.unshift(next);
  await store.persist();
  return next;
}

export function cognitionProfilePrompt(profile: UserCognitionProfile) {
  return [
    `Reply style preference: ${profile.replyStyle}.`,
    `Tone preference: ${profile.tonePreference}.`,
    profile.languagePattern.length ? `Language pattern: ${profile.languagePattern.join(", ")}.` : "",
    profile.energyPattern.length ? `Energy rhythm: ${profile.energyPattern.join(", ")}.` : "",
    profile.interruptionPattern !== "normal" ? `Interruption pattern: ${profile.interruptionPattern}.` : "",
    profile.recurringThemes.length ? `Recurring themes: ${profile.recurringThemes.join(", ")}.` : "",
    profile.relationshipBoundaries.length ? `Relationship boundaries: ${profile.relationshipBoundaries.join(", ")}.` : "",
    `Adaptation confidence: ${profile.confidence.toFixed(2)}.`
  ].filter(Boolean).join(" ");
}

export function userCognitionProfileStatus() {
  return { persistence: "local_file", path: localPath };
}
