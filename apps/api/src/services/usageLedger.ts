import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { env } from "../config/env.js";
import { supabase } from "../config/supabase.js";
import { isScaleTestUser } from "./scaleTest.js";

export type UsageIncrementResult = {
  allowed: boolean;
  used: number;
  limit: number;
  remaining: number;
  resetAt: string;
  source: "supabase" | "local_file" | "test_bypass";
};

type LocalUsageRecord = {
  user_id: string;
  usage_day: string;
  message_count: number;
  updated_at: string;
};

const apiDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const localUsagePath = path.join(apiDir, "data", "daily-usage.json");
const localDailyUsage = new Map<string, LocalUsageRecord>();
let localUsageLoaded = false;

function usageDay(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

function resetAtForDay(day: string) {
  return new Date(`${day}T00:00:00.000Z`).getTime() + 24 * 60 * 60 * 1000;
}

function usageKey(userId: string, day: string) {
  return `${userId}:${day}`;
}

function currentLimit() {
  return Math.max(1, env.dailyMessageLimit);
}

async function loadLocalUsage() {
  if (localUsageLoaded) return;
  localUsageLoaded = true;
  try {
    const raw = await fs.readFile(localUsagePath, "utf8");
    const records = JSON.parse(raw) as LocalUsageRecord[];
    for (const record of records) {
      if (!record.user_id || !record.usage_day) continue;
      localDailyUsage.set(usageKey(record.user_id, record.usage_day), record);
    }
  } catch {
    // Local-only development starts without a usage ledger file.
  }
}

async function persistLocalUsage() {
  const today = usageDay();
  const records = Array.from(localDailyUsage.values())
    .filter((record) => record.usage_day >= today)
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
    .slice(0, 20_000);
  await fs.mkdir(path.dirname(localUsagePath), { recursive: true });
  await fs.writeFile(localUsagePath, JSON.stringify(records, null, 2));
}

function shapeResult(input: {
  allowed: boolean;
  used: number;
  limit: number;
  day: string;
  source: UsageIncrementResult["source"];
}): UsageIncrementResult {
  return {
    allowed: input.allowed,
    used: input.used,
    limit: input.limit,
    remaining: Math.max(0, input.limit - input.used),
    resetAt: new Date(resetAtForDay(input.day)).toISOString(),
    source: input.source
  };
}

export async function incrementDailyUsage(userId: string) {
  const limit = currentLimit();
  const day = usageDay();

  if (isScaleTestUser(userId)) {
    return shapeResult({ allowed: true, used: 0, limit, day, source: "test_bypass" });
  }

  if (supabase) {
    const { data, error } = await supabase.rpc("increment_daily_usage", {
      target_user_id: userId,
      target_day: day,
      max_count: limit
    });

    if (!error) {
      const used = Number(data?.used ?? 0);
      return shapeResult({ allowed: Boolean(data?.allowed), used, limit, day, source: "supabase" });
    }

    console.warn("[usage-ledger] Supabase usage increment failed; falling back to local ledger", error.message);
  }

  await loadLocalUsage();
  const key = usageKey(userId, day);
  const current = localDailyUsage.get(key) ?? {
    user_id: userId,
    usage_day: day,
    message_count: 0,
    updated_at: new Date().toISOString()
  };

  if (current.message_count >= limit) {
    return shapeResult({ allowed: false, used: current.message_count, limit, day, source: "local_file" });
  }

  current.message_count += 1;
  current.updated_at = new Date().toISOString();
  localDailyUsage.set(key, current);
  await persistLocalUsage();
  return shapeResult({ allowed: true, used: current.message_count, limit, day, source: "local_file" });
}

export async function getDailyUsageStatus(userId: string) {
  const limit = currentLimit();
  const day = usageDay();

  if (isScaleTestUser(userId)) {
    return shapeResult({ allowed: true, used: 0, limit, day, source: "test_bypass" });
  }

  if (supabase) {
    const { data, error } = await supabase
      .from("daily_usage")
      .select("message_count")
      .eq("user_id", userId)
      .eq("usage_day", day)
      .maybeSingle();

    if (!error) {
      const used = Number(data?.message_count ?? 0);
      return shapeResult({ allowed: used < limit, used, limit, day, source: "supabase" });
    }

    console.warn("[usage-ledger] Supabase usage status failed; using local ledger", error.message);
  }

  await loadLocalUsage();
  const used = localDailyUsage.get(usageKey(userId, day))?.message_count ?? 0;
  return shapeResult({ allowed: used < limit, used, limit, day, source: "local_file" });
}

export async function getUsageLedgerStatus() {
  const status = {
    limit: currentLimit(),
    persistence: supabase ? "supabase_or_local_fallback" : "local_file",
    localPath: localUsagePath
  };
  return status;
}
