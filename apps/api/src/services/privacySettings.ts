import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isScaleTestUser } from "./scaleTest.js";

export type PrivacySettings = {
  userId: string;
  privateMode: boolean;
  allowProductImprovement: boolean;
  allowPersonalAdaptation: boolean;
  memoryRetentionDays: number | "forever";
  disableRawConversationReview: boolean;
  updatedAt: string;
};

const apiDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const localPath = path.join(apiDir, "data", "privacy-settings.json");
const localSettings: PrivacySettings[] = [];
const scaleSettings: PrivacySettings[] = [];
let loaded = false;

function defaultSettings(userId: string): PrivacySettings {
  return {
    userId,
    privateMode: false,
    allowProductImprovement: false,
    allowPersonalAdaptation: true,
    memoryRetentionDays: "forever",
    disableRawConversationReview: true,
    updatedAt: new Date().toISOString()
  };
}

async function loadSettings() {
  if (loaded) return;
  loaded = true;
  try {
    const raw = await fs.readFile(localPath, "utf8");
    localSettings.splice(0, localSettings.length, ...(JSON.parse(raw) as PrivacySettings[]));
  } catch {
    // First launch starts with defaults.
  }
}

async function persistSettings() {
  await fs.mkdir(path.dirname(localPath), { recursive: true });
  await fs.writeFile(localPath, JSON.stringify(localSettings.slice(0, 100_000), null, 2));
}

function storeForUser(userId: string) {
  return isScaleTestUser(userId)
    ? { settings: scaleSettings, persist: async () => undefined }
    : { settings: localSettings, persist: persistSettings };
}

export async function getPrivacySettings(userId: string) {
  await loadSettings();
  const store = storeForUser(userId);
  return store.settings.find((item) => item.userId === userId) ?? defaultSettings(userId);
}

export async function updatePrivacySettings(userId: string, patch: Partial<Omit<PrivacySettings, "userId" | "updatedAt">>) {
  await loadSettings();
  const store = storeForUser(userId);
  const existing = store.settings.find((item) => item.userId === userId);
  const next: PrivacySettings = {
    ...(existing ?? defaultSettings(userId)),
    ...patch,
    userId,
    updatedAt: new Date().toISOString()
  };
  const index = store.settings.findIndex((item) => item.userId === userId);
  if (index >= 0) store.settings[index] = next;
  else store.settings.unshift(next);
  await store.persist();
  return next;
}

export function privacyHash(text: string) {
  return crypto.createHash("sha256").update(text).digest("hex").slice(0, 16);
}

export function privacySettingsStatus() {
  return { persistence: "local_file", path: localPath, defaultProductImprovementOptIn: false };
}
