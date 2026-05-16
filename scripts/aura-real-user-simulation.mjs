#!/usr/bin/env node
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const BASE_URL = process.env.AURA_API_BASE_URL ?? "http://127.0.0.1:4000";
const OUT_DIR = process.env.AURA_REAL_USER_OUT_DIR ?? "/tmp/aura-real-user-simulation";
const RUN_ID = process.env.AURA_REAL_USER_RUN_ID ?? String(Date.now());
const TIMEZONE = process.env.AURA_REAL_USER_TIMEZONE ?? "Asia/Kolkata";
const REQUEST_TIMEOUT_MS = Number(process.env.AURA_REAL_USER_TIMEOUT_MS ?? 45_000);
const GAP_MIN_MS = Number(process.env.AURA_REAL_USER_GAP_MIN_MS ?? 50);
const GAP_MAX_MS = Number(process.env.AURA_REAL_USER_GAP_MAX_MS ?? 1000);
const USER_RAMP_PER_SECOND = Number(process.env.AURA_REAL_USER_RAMP_USERS_PER_SECOND ?? 50);
const RESOURCE_SAMPLE_MS = Number(process.env.AURA_REAL_USER_RESOURCE_SAMPLE_MS ?? 1000);
const INPUT_COST_PER_M = Number(process.env.AURA_SIM_INPUT_COST_PER_M ?? 0.09);
const OUTPUT_COST_PER_M = Number(process.env.AURA_SIM_OUTPUT_COST_PER_M ?? 1.1);
const REAL_LLM_PROMPT_OVERHEAD_CHARS = Number(process.env.AURA_REAL_USER_PROMPT_OVERHEAD_CHARS ?? 2600);

const latencyBudgets = {
  deterministic: { targetP95: 500, hardP99: 1500, hardMax: 5000 },
  mock_structure: { targetP95: 2000, hardP99: 5000, hardMax: 30000 },
  real_llm_single: { targetP95: 8000, hardP99: 20000, hardMax: 45000 },
  real_llm_load: { targetP95: 15000, hardP99: 30000, hardMax: 45000 },
  structure_1000: { targetP95: 2000, hardP99: 5000, hardMax: 30000 }
};

const stageConfig = {
  single: { users: 1, llmSample: 1, reportName: "single-report", mode: "single", realUsers: 1, llmMaxCalls: Infinity },
  "100": { users: 100, llmSample: 0.05, reportName: "100-users-report", mode: "mixed", realUsers: 15, llmMaxCalls: 600 },
  "1000": { users: 1000, llmSample: 0.02, reportName: "1000-users-report", mode: "structure", realUsers: 0, llmMaxCalls: 0 }
};

const validModes = new Set(["single", "mixed", "structure", "sampled"]);
const validReplayModes = new Set(["off", "read", "write"]);
const validFailureProfiles = new Set(["none", "light", "medium", "heavy"]);

function booleanArg(value, defaultValue = false) {
  if (value === undefined) return defaultValue;
  if (typeof value === "boolean") return value;
  return !/^(false|0|no|off)$/i.test(String(value));
}

function parseArgs() {
  const args = Object.fromEntries(process.argv.slice(2).map((arg) => {
    const normalized = arg.replace(/^--/, "");
    const [key, ...rest] = normalized.split("=");
    return [key, rest.join("=") || "true"];
  }));
  const stage = String(args.stage ?? "single");
  if (!stageConfig[stage]) throw new Error("Use --stage=single, --stage=100, or --stage=1000.");
  const mode = String(args.mode ?? stageConfig[stage].mode);
  if (!validModes.has(mode)) throw new Error("Use --mode=single, mixed, structure, or sampled.");
  const replayCache = String(args["replay-cache"] ?? "off");
  if (!validReplayModes.has(replayCache)) throw new Error("Use --replay-cache=off, read, or write.");
  const failureProfile = String(args["failure-profile"] ?? "none");
  if (!validFailureProfiles.has(failureProfile)) throw new Error("Use --failure-profile=none, light, medium, or heavy.");
  const defaultMaxCalls = mode === "sampled" && stage === "1000" ? 300 : stageConfig[stage].llmMaxCalls;
  return {
    stage,
    mode,
    users: args.users ? Number(args.users) : stageConfig[stage].users,
    llmSample: args["llm-sample"] ? Number(args["llm-sample"]) : stageConfig[stage].llmSample,
    llmMaxCalls: args["llm-max-calls"] ? Number(args["llm-max-calls"]) : defaultMaxCalls,
    realUsers: args["real-users"] ? Number(args["real-users"]) : stageConfig[stage].realUsers,
    criticalOnly: booleanArg(args["critical-only"], mode === "sampled"),
    sampleSeed: String(args["sample-seed"] ?? RUN_ID),
    replayCache,
    replayCacheFile: String(args["replay-cache-file"] ?? path.join(OUT_DIR, "replay-cache.json")),
    allowCacheMissLlm: booleanArg(args["allow-cache-miss-llm"], false),
    failureProfile,
    messages: args.messages ? Number(args.messages) : 40,
    driftSample: args["drift-sample"] === "all" ? Infinity : args["drift-sample"] ? Number(args["drift-sample"]) : Infinity,
    stopOnHardFailure: args["stop-on-hard-failure"] !== "false"
  };
}

function hashString(value) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function seededUnit(seed) {
  return hashString(seed) / 0xffffffff;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function jitter(min, max) {
  return Math.round(min + Math.random() * (max - min));
}

function normalize(text) {
  return String(text ?? "")
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]+/g, "");
}

function appears(text, needle) {
  return normalize(text).includes(normalize(needle));
}

function percentile(values, p) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index];
}

function average(values) {
  return values.length ? Math.round(values.reduce((sum, value) => sum + value, 0) / values.length) : 0;
}

function hasBrainQuiet(reply) {
  return /AI connection is quiet|brain is busy|trouble reaching AURA|couldn.?t connect|unable to reach/i.test(reply ?? "");
}

function hasForcedMemoryPhrase(reply) {
  return /\b(you mentioned|you said|you told me|i remember|as you said|as you told me)\b/i.test(reply ?? "");
}

function tokenEstimate(chars) {
  return Math.max(1, Math.ceil(chars / 4));
}

function estimateCost({ content, reply, useRealLlm }) {
  if (!useRealLlm) {
    return {
      inputTokens: 0,
      outputTokens: 0,
      estimatedCostUsd: 0
    };
  }
  const inputTokens = tokenEstimate(String(content ?? "").length + REAL_LLM_PROMPT_OVERHEAD_CHARS);
  const outputTokens = tokenEstimate(String(reply ?? "").length);
  const estimatedCostUsd = (inputTokens / 1_000_000) * INPUT_COST_PER_M + (outputTokens / 1_000_000) * OUTPUT_COST_PER_M;
  return { inputTokens, outputTokens, estimatedCostUsd };
}

async function fetchJson(url, options = {}, timeoutMs = REQUEST_TIMEOUT_MS) {
  const controller = new AbortController();
  const startedAt = Date.now();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    const raw = await res.text();
    let body = null;
    try {
      body = raw ? JSON.parse(raw) : null;
    } catch {
      body = { raw };
    }
    return { ok: res.ok, status: res.status, body, durationMs: Date.now() - startedAt };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      body: null,
      error: error instanceof Error ? error.message : String(error),
      durationMs: Date.now() - startedAt
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function getJson(pathname) {
  return fetchJson(`${BASE_URL}${pathname}`, { method: "GET" }, 10_000);
}

async function backendPid() {
  try {
    const { stdout } = await execFileAsync("zsh", ["-lc", "lsof -tiTCP:4000 -sTCP:LISTEN | head -n 1"], { timeout: 5000 });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

async function sampleProcess(pid) {
  if (!pid) return null;
  try {
    const { stdout } = await execFileAsync("ps", ["-p", pid, "-o", "pid=,%cpu=,rss=,command="], { timeout: 5000, maxBuffer: 1024 * 1024 });
    const line = stdout.trim();
    if (!line) return null;
    const parts = line.split(/\s+/);
    return {
      at: new Date().toISOString(),
      pid,
      cpuPercent: Number(parts[1] ?? 0),
      rssMb: Math.round((Number(parts[2] ?? 0) / 1024) * 10) / 10,
      command: parts.slice(3).join(" ")
    };
  } catch {
    return null;
  }
}

function userKind(index, total) {
  const pct = index / Math.max(1, total);
  if (total === 1) return "single";
  if (pct < 0.3) return "beginner";
  if (pct < 0.5) return "emotional";
  if (pct < 0.7) return "chaotic";
  if (pct < 0.9) return "recall_heavy";
  return "reply_normally";
}

function makeUser(index, total, stage) {
  const number = index + 1;
  const kind = userKind(index, total);
  const marker = `real-sim-${stage}-${String(number).padStart(4, "0")}-marker`;
  const friendName = `Friend${number}`;
  const userId = `aura-real-sim-user-${stage}-${number}-${RUN_ID}`;
  const buildTarget = kind === "chaotic" ? "a mobile startup app" : kind === "reply_normally" ? "a minimal AI tool" : "something like AURA";
  const goal = kind === "emotional"
    ? `learn coding even when confidence is low and build ${buildTarget}`
    : `learn coding by building ${buildTarget}`;
  return {
    number,
    kind,
    userId,
    marker,
    friendName,
    goal,
    buildTarget,
    startDelayMs: Math.floor(index / USER_RAMP_PER_SECOND) * 1000 + jitter(0, 1000)
  };
}

function fact(label, needles) {
  return { label, anyOf: Array.isArray(needles) ? needles : [needles] };
}

function exact40(user, baseDate) {
  const day = 24 * 60 * 60 * 1000;
  const at = (sessionDay, minute) => new Date(baseDate + sessionDay * day + minute * 60_000 + user.number * 100).toISOString();
  const common = { forbiddenFacts: [] };
  const goalFacts = [fact("coding", ["coding", "developer"]), fact("build target", [user.buildTarget, "AURA", "mobile", "AI tool"])];
  const interestFacts = [fact("apps not theory", ["apps", "app", "theory"])];
  const friendFacts = [fact("friend liked idea", ["friend", user.friendName, "liked"]), fact("friend coding", ["coding", user.friendName, "friend"])];

  return [
    { id: 1, session: "A", text: `I want to learn coding. My private marker is ${user.marker}.`, expectedIntent: "normal_chat", route: "normal", at: at(0, 1), ...common },
    { id: 2, session: "A", text: "Start from zero please", expectedIntent: "normal_chat", route: "normal", at: at(0, 2), ...common },
    { id: 3, session: "A", text: "I get distracted easily", expectedIntent: "normal_chat", route: "normal", at: at(0, 3), ...common },
    { id: 4, session: "A", text: "I like building apps not reading theory", expectedIntent: "normal_chat", route: "normal", at: at(0, 4), ...common },
    { id: 5, session: "A", text: "Explain simply", expectedIntent: "normal_chat", route: "normal", at: at(0, 5), ...common },
    { id: 6, session: "A", text: `I am trying to build ${user.buildTarget}`, expectedIntent: "normal_chat", route: "normal", at: at(0, 6), ...common },
    { id: 7, session: "A", text: "Keep answers short", expectedIntent: "normal_chat", route: "normal", at: at(0, 7), ...common },
    { id: 8, session: "A", text: "I code in English prompts", expectedIntent: "normal_chat", route: "normal", at: at(0, 8), ...common },
    { id: 9, session: "A", text: "I don't like long explanations", expectedIntent: "normal_chat", route: "normal", at: at(0, 9), ...common },
    { id: 10, session: "A", text: "I am beginner", expectedIntent: "normal_chat", route: "normal", at: at(0, 10), ...common },

    { id: 11, session: "B", text: "I feel stuck", expectedIntent: "emotional_support", route: "normal", at: at(2, 1), ...common },
    { id: 12, session: "B", text: "Coding feels hard", expectedIntent: "normal_chat", route: "normal", at: at(2, 2), ...common },
    { id: 13, session: "B", text: "I think I will quit", expectedIntent: "emotional_support", route: "normal", at: at(2, 3), ...common },
    { id: 14, session: "B", text: "Maybe I am not good", expectedIntent: "emotional_support", route: "normal", at: at(2, 4), ...common },
    { id: 15, session: "B", text: "I am confused again", expectedIntent: "emotional_support", route: "normal", at: at(2, 5), ...common },
    { id: 16, session: "B", text: "Don't motivate me too much", expectedIntent: "normal_chat", route: "normal", at: at(2, 6), ...common },
    { id: 17, session: "B", text: "I just want clarity", expectedIntent: "normal_chat", route: "normal", at: at(2, 7), ...common },
    { id: 18, session: "B", text: "I feel better today", expectedIntent: "emotional_support", route: "normal", at: at(2, 8), ...common },
    { id: 19, session: "B", text: "I coded a bit", expectedIntent: "normal_chat", route: "normal", at: at(2, 9), ...common },
    { id: 20, session: "B", text: "I am back to confused state", expectedIntent: "emotional_support", route: "normal", at: at(2, 10), ...common },

    { id: 21, session: "C", text: "What is my goal?", expectedIntent: "goal_recall", route: "deterministic", at: at(4, 1), requiredFacts: goalFacts },
    { id: 22, session: "C", text: "What did I say before about coding?", expectedIntent: "user_history_recall", route: "deterministic", at: at(4, 2), requiredFacts: [fact("coding history", ["coding", "English prompts", "beginner", "zero"])], userOnly: true },
    { id: 23, session: "C", text: "Do you remember my interest?", expectedIntent: "profile_recall", route: "deterministic", at: at(4, 3), requiredFacts: interestFacts },
    { id: 24, session: "C", text: "What am I building?", expectedIntent: "goal_recall", route: "deterministic", at: at(4, 4), requiredFacts: [fact("building target", [user.buildTarget, "AURA", "mobile", "AI tool"])] },
    { id: 25, session: "C", text: "What did I ask you earlier?", expectedIntent: "user_history_recall", route: "deterministic", at: at(4, 5), requiredFacts: [fact("earlier asks", ["short", "simple", "zero", "clarity"])], userOnly: true },

    { id: 26, session: "D", text: "forget everything", expectedIntent: "normal_chat", route: "normal", at: at(6, 1), ...common },
    { id: 27, session: "D", text: "actually continue", expectedIntent: "normal_chat", route: "normal", at: at(6, 2), ...common },
    { id: 28, session: "D", text: "I want to build startup", expectedIntent: "normal_chat", route: "normal", at: at(6, 3), ...common },
    { id: 29, session: "D", text: "no change topic", expectedIntent: "normal_chat", route: "normal", at: at(6, 4), ...common },
    { id: 30, session: "D", text: "I hate theory again", expectedIntent: "normal_chat", route: "normal", at: at(6, 5), ...common },
    { id: 31, session: "D", text: "reply normally", expectedIntent: "normal_chat", route: "normal", at: at(6, 6), ...common },
    { id: 32, session: "D", text: "just answer fast", expectedIntent: "normal_chat", route: "normal", at: at(6, 7), ...common },
    { id: 33, session: "D", text: "I might switch idea", expectedIntent: "normal_chat", route: "normal", at: at(6, 8), ...common },
    { id: 34, session: "D", text: "I want mobile app", expectedIntent: "normal_chat", route: "normal", at: at(6, 9), ...common },
    { id: 35, session: "D", text: "or maybe AI tool", expectedIntent: "normal_chat", route: "normal", at: at(6, 10), ...common },

    { id: 36, session: "E", text: `I told my friend ${user.friendName} about this`, expectedIntent: "normal_chat", route: "normal", at: at(8, 1), ...common },
    { id: 37, session: "E", text: `my friend ${user.friendName} liked the idea`, expectedIntent: "normal_chat", route: "normal", at: at(8, 2), ...common },
    { id: 38, session: "E", text: `I discussed coding with him`, expectedIntent: "normal_chat", route: "normal", at: at(8, 3), ...common },
    { id: 39, session: "E", text: "what do you remember about my friend?", expectedIntent: "relationship_recall", route: "deterministic", at: at(8, 4), requiredFacts: friendFacts },
    { id: 40, session: "E", text: "summarize me", expectedIntent: "profile_recall", route: "deterministic", at: at(8, 5), requiredFacts: [...goalFacts, ...interestFacts] }
  ];
}

function driftSteps(user, baseDate) {
  const at = (minute) => new Date(baseDate + 10 * 24 * 60 * 60 * 1000 + minute * 60_000 + user.number * 100).toISOString();
  return [
    { id: "drift_goal", session: "drift", text: "What is my goal?", expectedIntent: "goal_recall", route: "deterministic", at: at(1), requiredFacts: [fact("goal", ["coding", "developer", user.buildTarget, "AURA", "mobile", "AI tool"])] },
    { id: "drift_profile", session: "drift", text: "What do you remember about me?", expectedIntent: "profile_recall", route: "deterministic", at: at(2), requiredFacts: [fact("profile goal", ["coding", "developer", user.buildTarget, "AURA", "mobile", "AI tool"])] },
    { id: "drift_friend", session: "drift", text: "What do you remember about my friend?", expectedIntent: "relationship_recall", route: "deterministic", at: at(3), requiredFacts: [fact("friend", ["friend", user.friendName, "liked", "coding"])] },
    { id: "drift_user_history", session: "drift", text: "What did I say earlier about coding?", expectedIntent: "user_history_recall", route: "deterministic", at: at(4), requiredFacts: [fact("coding", ["coding", "prompts", "beginner"])], userOnly: true },
    { id: "drift_patterns", session: "drift", text: "What patterns have you noticed?", expectedIntent: "pattern_recall", route: "deterministic", at: at(5), requiredFacts: [fact("pattern", ["coding", "theory", "confused", "apps", "beginner"])] }
  ];
}

function expectedMessageCount(args) {
  return Math.min(args.messages, 40);
}

function isCriticalLlmStep(step) {
  return ["goal_recall", "pattern_recall", "relationship_recall", "emotional_support"].includes(step.expectedIntent);
}

function selectFullLlmUsers(users, args) {
  if (args.stage === "single" || args.mode === "single") return new Set(users.map((user) => user.userId));
  if (args.mode !== "mixed") return new Set();
  return new Set(
    [...users]
      .sort((a, b) => seededUnit(`${args.sampleSeed}:full-user:${a.userId}`) - seededUnit(`${args.sampleSeed}:full-user:${b.userId}`))
      .slice(0, Math.min(args.realUsers, users.length))
      .map((user) => user.userId)
  );
}

function shouldUseRealLlm(args, user, step, budget) {
  if (step.route === "deterministic") return false;
  if (args.mode === "structure") return false;
  if (budget.realLlmCalls >= args.llmMaxCalls) return false;

  const fullUser = budget.fullLlmUsers.has(user.userId);
  const critical = isCriticalLlmStep(step);
  let eligible = false;

  if (args.stage === "single" || args.mode === "single") {
    eligible = true;
  } else if (args.mode === "mixed") {
    eligible = fullUser || (!args.criticalOnly && critical && seededUnit(`${args.sampleSeed}:critical:${user.userId}:${step.id}`) < args.llmSample);
  } else if (args.mode === "sampled") {
    eligible = (!args.criticalOnly || critical) && seededUnit(`${args.sampleSeed}:sampled:${user.userId}:${step.id}`) < args.llmSample;
  }

  if (!eligible && args.replayCache === "read" && args.allowCacheMissLlm && critical) {
    eligible = seededUnit(`${args.sampleSeed}:cache-miss:${user.userId}:${step.id}`) < args.llmSample;
  }
  if (!eligible) return false;
  budget.realLlmCalls += 1;
  return true;
}

function testModeFor(args, useRealLlm) {
  if (args.mode === "structure") return "structure-mock";
  if (args.stage === "single" || args.mode === "single") return "llm-sample";
  if (useRealLlm) return "llm-sample";
  return args.stage === "1000" ? "structure-mock" : "llm-sample";
}

function routeTypeFor(args, step, useRealLlm) {
  if (step.route === "deterministic") return "deterministic";
  if (useRealLlm) return args.stage === "single" ? "real_llm_single" : "real_llm_load";
  if (args.stage === "1000") return "structure_1000";
  return "mock_structure";
}

function chaosHeaderFor(args, user, step, useRealLlm) {
  if (args.failureProfile === "none") return "";
  const chaos = [];
  const seed = `${args.sampleSeed}:failure:${args.failureProfile}:${user.userId}:${step.id}`;
  const a = seededUnit(`${seed}:a`);
  const b = seededUnit(`${seed}:b`);

  if (args.failureProfile === "light") {
    if (a < 0.05) chaos.push("memory-delay=200");
    if (useRealLlm && b < 0.05) chaos.push("brain-delay=500");
  } else if (args.failureProfile === "medium") {
    if (a < 0.10) chaos.push("memory-delay=500");
    if (useRealLlm && b < 0.10) chaos.push("brain-delay=1500");
    if (useRealLlm && seededUnit(`${seed}:c`) < 0.02) chaos.push("brain-fail");
  } else if (args.failureProfile === "heavy") {
    if (a < 0.15) chaos.push("memory-delay=1000");
    if (useRealLlm && b < 0.15) chaos.push("brain-delay=3000");
    if (useRealLlm && seededUnit(`${seed}:c`) < 0.05) chaos.push("brain-fail");
  }

  return chaos.join(",");
}

async function capture({ args, user, step, useRealLlm }) {
  const headers = {
    "content-type": "application/json",
    "x-user-id": user.userId,
    "x-aura-skip-voice": "true",
    "x-aura-test-mode": testModeFor(args, useRealLlm),
    "x-aura-test-created-at": step.at
  };
  if (useRealLlm) headers["x-aura-use-real-llm"] = "true";
  const chaos = chaosHeaderFor(args, user, step, useRealLlm);
  if (chaos) headers["x-aura-chaos"] = chaos;

  const result = await fetchJson(`${BASE_URL}/capture`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      content: step.text,
      inputMode: "text",
      timezone: TIMEZONE,
      skipVoice: true
    })
  });
  return { ...result, chaos };
}

function factHit(reply, requirement) {
  return requirement.anyOf.some((needle) => appears(reply, needle));
}

function scoreMemory(event, allMarkers) {
  const reply = String(event.body?.reply ?? "");
  const required = event.step.requiredFacts ?? [];
  const requiredHits = required.filter((item) => factHit(reply, item));
  const requiredMisses = required.filter((item) => !factHit(reply, item));
  const forbiddenMarkers = allMarkers.filter((marker) => marker !== event.user.marker);
  const leakedMarkers = forbiddenMarkers.filter((marker) => appears(JSON.stringify(event.body ?? {}), marker));
  const assistantScopeWrong = Boolean(event.step.userOnly && /\bAURA:|assistant|Mock reply for\b/i.test(reply));
  const forbiddenHits = [
    ...leakedMarkers.map((marker) => `cross-user marker ${marker}`),
    ...(assistantScopeWrong ? ["assistant content in user-only recall"] : [])
  ];
  const points = requiredHits.length - forbiddenHits.length - leakedMarkers.length;
  return {
    requiredCount: required.length,
    requiredHits: requiredHits.map((item) => item.label),
    requiredMisses: requiredMisses.map((item) => item.label),
    forbiddenHits,
    leakedMarkers,
    assistantScopeWrong,
    points
  };
}

function isCatastrophicRouterMismatch(expected, actual) {
  if (!actual) return true;
  if (expected === "normal_chat" && ["reminder_recall", "explicit_save_recall", "relationship_recall", "goal_recall"].includes(actual)) return true;
  if (expected === "reminder_recall" && actual !== "reminder_recall") return true;
  if (expected === "relationship_recall" && actual !== "relationship_recall") return true;
  if (expected === "user_history_recall" && actual === "conversation_history_recall") return true;
  return false;
}

function analyzeEvent(event, allMarkers) {
  const reply = String(event.body?.reply ?? "");
  const actualIntent = event.body?.archive?.memoryIntent ?? "unknown";
  const routerMatch = actualIntent === event.step.expectedIntent;
  const routerCatastrophic = !routerMatch && isCatastrophicRouterMismatch(event.step.expectedIntent, actualIntent);
  const memory = scoreMemory(event, allMarkers);
  const issues = [];

  if (!event.ok) issues.push(`http_${event.status}`);
  if (event.status === 0) issues.push("request_timeout");
  if (event.status >= 500) issues.push("server_error");
  if (event.body?.voice !== null && event.body?.voice !== undefined) issues.push("voice_not_skipped");
  if (hasBrainQuiet(reply) && event.useRealLlm) issues.push("brain_quiet");
  if (event.step.expectedIntent === "normal_chat" && hasForcedMemoryPhrase(reply)) issues.push("forced_memory_phrase");
  if (event.step.expectedIntent === "normal_chat" && /\b20\d{2}-\d{2}-\d{2}\b/.test(reply)) issues.push("timestamp_in_normal_chat");
  if (routerCatastrophic) issues.push(`router_catastrophic_${event.step.expectedIntent}_to_${actualIntent}`);
  if (memory.leakedMarkers.length) issues.push("cross_user_leak");
  if (memory.assistantScopeWrong) issues.push("wrong_user_history_scope");
  if (event.step.requiredFacts?.length && memory.requiredMisses.length) issues.push("recall_required_fact_missing");
  if (/remind me|ask me in/i.test(event.step.text) && !event.body?.reminder && !event.body?.reminderDraft) issues.push("reminder_missing");

  return {
    actualIntent,
    routerMatch,
    routerCatastrophic,
    memory,
    issues
  };
}

function summarizeLatency(events) {
  const grouped = new Map();
  for (const event of events) {
    if (!grouped.has(event.routeType)) grouped.set(event.routeType, []);
    grouped.get(event.routeType).push(event.durationMs);
  }
  return Object.fromEntries([...grouped.entries()].map(([routeType, values]) => {
    const budget = latencyBudgets[routeType] ?? latencyBudgets.mock_structure;
    const summary = {
      count: values.length,
      avg: average(values),
      p50: percentile(values, 50),
      p95: percentile(values, 95),
      p99: percentile(values, 99),
      max: Math.max(0, ...values),
      targetP95: budget.targetP95,
      hardP99: budget.hardP99,
      hardMax: budget.hardMax,
      targetPass: percentile(values, 95) <= budget.targetP95,
      hardPass: percentile(values, 99) <= budget.hardP99 && Math.max(0, ...values) <= budget.hardMax
    };
    return [routeType, summary];
  }));
}

function routerConfusion(events) {
  const matrix = {};
  const mismatches = [];
  for (const event of events) {
    const expected = event.step.expectedIntent;
    const actual = event.analysis.actualIntent;
    matrix[expected] ??= {};
    matrix[expected][actual] = (matrix[expected][actual] ?? 0) + 1;
    if (expected !== actual) {
      mismatches.push({
        userId: event.user.userId,
        messageId: event.step.id,
        prompt: event.step.text,
        expected,
        actual,
        catastrophic: event.analysis.routerCatastrophic
      });
    }
  }
  const accuracy = events.length ? (events.length - mismatches.length) / events.length : 1;
  return { matrix, mismatches, accuracy };
}

function memoryCorrectness(events, stage) {
  const recallEvents = events.filter((event) => event.step.requiredFacts?.length);
  const totalRequired = recallEvents.reduce((sum, event) => sum + event.analysis.memory.requiredCount, 0);
  const correctHits = recallEvents.reduce((sum, event) => sum + event.analysis.memory.requiredHits.length, 0);
  const forbiddenHits = recallEvents.reduce((sum, event) => sum + event.analysis.memory.forbiddenHits.length, 0);
  const crossUserLeaks = recallEvents.reduce((sum, event) => sum + event.analysis.memory.leakedMarkers.length, 0);
  const memoryScore = totalRequired ? correctHits / totalRequired : 1;
  const hallucinationPenalty = recallEvents.length ? forbiddenHits / recallEvents.length : 0;
  const finalRecallScore = Math.max(0, memoryScore - hallucinationPenalty);
  const threshold = stage === "single" ? 0.95 : stage === "100" ? 0.9 : 0.85;
  return {
    recallEvents: recallEvents.length,
    totalRequired,
    correctHits,
    forbiddenHits,
    crossUserLeaks,
    memoryScore,
    hallucinationPenalty,
    finalRecallScore,
    threshold,
    pass: finalRecallScore >= threshold && crossUserLeaks === 0
  };
}

function costSummary(events, users, args) {
  const realEvents = events.filter((event) => event.useRealLlm);
  const totalInputTokens = events.reduce((sum, event) => sum + event.cost.inputTokens, 0);
  const totalOutputTokens = events.reduce((sum, event) => sum + event.cost.outputTokens, 0);
  const totalCostUsd = events.reduce((sum, event) => sum + event.cost.estimatedCostUsd, 0);
  const costPerRealRequest = realEvents.length ? totalCostUsd / realEvents.length : 0;
  const observedCostPerUser = users.length ? totalCostUsd / users.length : 0;
  const averageRealRequestCost = costPerRealRequest || ((tokenEstimate(REAL_LLM_PROMPT_OVERHEAD_CHARS) / 1_000_000) * INPUT_COST_PER_M + (80 / 1_000_000) * OUTPUT_COST_PER_M);
  const theoreticalFullLlmCalls = users.length * expectedMessageCount(args);
  const fullReal40Cost = theoreticalFullLlmCalls * averageRealRequestCost;
  const projected100MessagesDailyPerUser = 100 * averageRealRequestCost;
  const savedRealLlmCalls = Math.max(0, theoreticalFullLlmCalls - realEvents.length);
  const savedCostUsd = savedRealLlmCalls * averageRealRequestCost;
  return {
    theoreticalFullLlmCalls,
    realLlmRequests: realEvents.length,
    llmMaxCalls: Number.isFinite(args.llmMaxCalls) ? args.llmMaxCalls : null,
    savedRealLlmCalls,
    realCallPercentOfFull: theoreticalFullLlmCalls ? Number(((realEvents.length / theoreticalFullLlmCalls) * 100).toFixed(2)) : 0,
    totalInputTokens,
    totalOutputTokens,
    observedCostUsd: Number(totalCostUsd.toFixed(6)),
    estimatedSavedCostUsd: Number(savedCostUsd.toFixed(4)),
    costPerRealRequestUsd: Number(costPerRealRequest.toFixed(6)),
    observedCostPerUserUsd: Number(observedCostPerUser.toFixed(6)),
    projectedFullReal40MessageRunUsd: Number(fullReal40Cost.toFixed(4)),
    projected100MessagesPerUserDayUsd: Number(projected100MessagesDailyPerUser.toFixed(4)),
    projected1000UsersMonthUsd: Number((1000 * projected100MessagesDailyPerUser * 30).toFixed(2)),
    worstCaseSpike1000Users40MessagesUsd: Number((1000 * 40 * averageRealRequestCost).toFixed(2)),
    rates: { inputCostPerM: INPUT_COST_PER_M, outputCostPerM: OUTPUT_COST_PER_M }
  };
}

function normalizeReplayText(text, user) {
  return String(text ?? "")
    .replaceAll(user.marker, "<marker>")
    .replaceAll(user.friendName, "<friend>")
    .replaceAll(user.userId, "<user>")
    .replaceAll(user.buildTarget, "<target>");
}

function replayKey(user, step) {
  return [
    user.kind,
    step.id,
    step.expectedIntent,
    normalizeReplayText(step.text, user)
      .toLowerCase()
      .replace(/[^a-z0-9<>]+/g, " ")
      .trim()
  ].join("|");
}

function hydrateReplayText(text, user) {
  return String(text ?? "")
    .replaceAll("<marker>", user.marker)
    .replaceAll("<friend>", user.friendName)
    .replaceAll("<user>", user.userId)
    .replaceAll("<target>", user.buildTarget);
}

async function loadReplayCache(args) {
  if (args.replayCache === "off") return new Map();
  try {
    const raw = await fs.readFile(args.replayCacheFile, "utf8");
    const parsed = JSON.parse(raw);
    return new Map(Object.entries(parsed.entries ?? parsed));
  } catch {
    return new Map();
  }
}

async function writeReplayCache(args, replayCache) {
  if (args.replayCache !== "write") return;
  await fs.mkdir(path.dirname(args.replayCacheFile), { recursive: true });
  const payload = {
    version: 1,
    generatedAt: new Date().toISOString(),
    entries: Object.fromEntries(replayCache.entries())
  };
  await fs.writeFile(args.replayCacheFile, `${JSON.stringify(payload, null, 2)}\n`);
}

async function runStep({ args, user, step, allMarkers, budget, replayCache }) {
  const cacheKey = replayKey(user, step);
  const cached = args.replayCache === "read" ? replayCache.get(cacheKey) : null;
  const useRealLlm = shouldUseRealLlm(args, user, step, budget);
  const routeType = routeTypeFor(args, step, useRealLlm);
  const startedAt = Date.now();
  const result = await capture({ args, user, step, useRealLlm });
  const body = result.body ?? {};
  let replay = { mode: args.replayCache, hit: false, key: cacheKey };
  if (!useRealLlm && cached?.reply) {
    body.reply = hydrateReplayText(cached.reply, user);
    replay.hit = true;
  }
  const cost = estimateCost({ content: step.text, reply: body.reply ?? "", useRealLlm });
  const event = {
    user: { userId: user.userId, number: user.number, kind: user.kind, marker: user.marker, friendName: user.friendName },
    step,
    routeType,
    useRealLlm,
    startedAt,
    endedAt: Date.now(),
    durationMs: result.durationMs,
    ok: result.ok,
    status: result.status,
    error: result.error ?? null,
    chaos: result.chaos ?? "",
    replay,
    body: {
      reply: body.reply ?? "",
      voice: body.voice ?? null,
      reminder: body.reminder ?? null,
      reminderDraft: body.reminderDraft ?? null,
      archive: body.archive ?? null,
      scaleTest: body.scaleTest ?? null
    },
    cost
  };
  event.analysis = analyzeEvent(event, allMarkers);
  if (args.replayCache === "write" && event.ok) {
    replayCache.set(cacheKey, {
      reply: normalizeReplayText(event.body.reply, user),
      actualIntent: event.analysis.actualIntent,
      routeType,
      useRealLlm,
      status: event.status
    });
  }
  return event;
}

async function runUser({ args, user, baseDate, allMarkers, budget, replayCache }) {
  await sleep(user.startDelayMs);
  const steps = exact40(user, baseDate).slice(0, expectedMessageCount(args));
  const events = [];
  for (const step of steps) {
    await sleep(args.stage === "single" ? 0 : jitter(GAP_MIN_MS, GAP_MAX_MS));
    events.push(await runStep({ args, user, step, allMarkers, budget, replayCache }));
  }
  return events;
}

async function runDriftPass({ args, users, baseDate, allMarkers, replayCache }) {
  const selected = users.slice(0, Math.min(users.length, args.driftSample));
  const events = [];
  const driftBudget = { realLlmCalls: 0, fullLlmUsers: new Set() };
  const tasks = selected.map(async (user) => {
    for (const step of driftSteps(user, baseDate)) {
      events.push(await runStep({ args: { ...args, mode: "structure", llmSample: 0, llmMaxCalls: 0 }, user, step, allMarkers, budget: driftBudget, replayCache }));
    }
  });
  await Promise.all(tasks);
  return events.sort((a, b) => a.startedAt - b.startedAt);
}

function classifyDegradation({ events, latency, brainAfterTotals, brainBeforeTotals, costs, llmMaxCalls }) {
  const failures = events.filter((event) => event.status === 0 || event.status >= 500).length;
  const brainQuiet = events.filter((event) => event.analysis.issues.includes("brain_quiet")).length;
  const queueDepthDelta = Math.max(0, (brainAfterTotals.maxQueueDepth ?? 0) - (brainBeforeTotals.maxQueueDepth ?? 0));
  const timeoutDelta = Math.max(0, (brainAfterTotals.timedOutJobs ?? 0) - (brainBeforeTotals.timedOutJobs ?? 0));
  const rejectedDelta = Math.max(0, (brainAfterTotals.rejectedJobs ?? 0) - (brainBeforeTotals.rejectedJobs ?? 0));
  const hardLatencyFailures = Object.values(latency).filter((item) => !item.hardPass).length;

  if (events.some((event) => event.analysis.issues.includes("cross_user_leak"))) return "cross-user leak";
  if (Number.isFinite(llmMaxCalls) && costs.realLlmRequests > llmMaxCalls) return "llm cap exceeded";
  if (queueDepthDelta > 40 || rejectedDelta > 0) return "queue explosion";
  if (failures > Math.max(3, events.length * 0.02)) return "random failure storm";
  if (timeoutDelta > 0 || hardLatencyFailures > 0) return "hard timeout pressure";
  if (brainQuiet > 0) return "consistent controlled fallback";
  if (Object.values(latency).some((item) => !item.targetPass && item.hardPass)) return "smooth slowdown";
  return "stable";
}

async function main() {
  const args = parseArgs();
  await fs.mkdir(OUT_DIR, { recursive: true });
  const config = stageConfig[args.stage];
  const reportStem = config.reportName;
  const startedAt = Date.now();
  const baseDate = startedAt - 12 * 24 * 60 * 60 * 1000;
  const pid = await backendPid();
  const resourceSamples = [];
  let sampling = true;
  const sampler = setInterval(() => {
    void sampleProcess(pid).then((sample) => {
      if (sampling && sample) resourceSamples.push(sample);
    });
  }, RESOURCE_SAMPLE_MS);
  sampler.unref?.();

  const [healthBefore, brainBefore, voiceBefore] = await Promise.all([
    getJson("/health"),
    getJson("/brain/metrics"),
    getJson("/voice/metrics")
  ]);

  const users = Array.from({ length: args.users }, (_, index) => makeUser(index, args.users, args.stage));
  const allMarkers = users.map((user) => user.marker);
  const replayCache = await loadReplayCache(args);
  const fullLlmUsers = selectFullLlmUsers(users, args);
  const budget = { realLlmCalls: 0, fullLlmUsers };
  console.log(`[real-user] stage=${args.stage} mode=${args.mode} users=${args.users} messages=${expectedMessageCount(args)} llmSample=${args.llmSample} llmMaxCalls=${args.llmMaxCalls}`);

  const userTasks = users.map((user) => runUser({ args, user, baseDate, allMarkers, budget, replayCache }));
  const eventGroups = await Promise.all(userTasks);
  let events = eventGroups.flat().sort((a, b) => a.startedAt - b.startedAt);
  const mainHardFailures = events.filter((event) => event.analysis.issues.some((issue) => ["cross_user_leak", "server_error", "request_timeout", "voice_not_skipped"].includes(issue)));

  let driftEvents = [];
  if ((args.stage === "100" || args.stage === "1000" || args.stage === "single") && (!mainHardFailures.length || !args.stopOnHardFailure)) {
    console.log(`[real-user] drift pass users=${Math.min(users.length, args.driftSample)}`);
    driftEvents = await runDriftPass({ args, users, baseDate, allMarkers, replayCache });
  }
  events = [...events, ...driftEvents].sort((a, b) => a.startedAt - b.startedAt);

  sampling = false;
  clearInterval(sampler);
  resourceSamples.push(await sampleProcess(pid));

  const [healthAfter, brainAfter, voiceAfter] = await Promise.all([
    getJson("/health"),
    getJson("/brain/metrics"),
    getJson("/voice/metrics")
  ]);

  const endedAt = Date.now();
  const latency = summarizeLatency(events);
  const confusion = routerConfusion(events);
  const memory = memoryCorrectness(events, args.stage);
  const costs = costSummary(events, users, args);
  const hardFailures = events.filter((event) => event.analysis.issues.length);
  const crossUserLeakCount = events.reduce((sum, event) => sum + event.analysis.memory.leakedMarkers.length, 0);
  const driftRecallEvents = driftEvents.filter((event) => event.step.requiredFacts?.length);
  const driftBadEvents = driftEvents.filter((event) => event.analysis.issues.includes("cross_user_leak") || event.analysis.memory.requiredMisses.length || event.analysis.memory.forbiddenHits.length);
  const driftRate = driftRecallEvents.length ? driftBadEvents.length / driftRecallEvents.length : 0;
  const driftThreshold = args.stage === "1000" ? 0.05 : args.stage === "100" ? 0.02 : 0;
  const brainBeforeTotals = brainBefore.body?.totals ?? {};
  const brainAfterTotals = brainAfter.body?.totals ?? {};
  const voiceBeforeTotals = voiceBefore.body?.totals ?? {};
  const voiceAfterTotals = voiceAfter.body?.totals ?? {};
  const rssValues = resourceSamples.map((sample) => sample?.rssMb).filter(Number.isFinite);
  const cpuValues = resourceSamples.map((sample) => sample?.cpuPercent).filter(Number.isFinite);
  const latencyHardPass = Object.values(latency).every((item) => item.hardPass);
  const routerThreshold = args.stage === "single" ? 0.95 : args.stage === "100" ? 0.92 : 0.85;
  const naturalnessScore = Math.max(0, 10 - events.filter((event) => event.analysis.issues.includes("forced_memory_phrase") || event.analysis.issues.includes("timestamp_in_normal_chat")).length);

  const pass = Boolean(
    healthBefore.ok &&
    healthAfter.ok &&
    crossUserLeakCount === 0 &&
    memory.pass &&
    confusion.accuracy >= routerThreshold &&
    latencyHardPass &&
    (args.stage === "single" ? naturalnessScore >= 8.5 : true) &&
    (args.stage === "100" || args.stage === "1000" ? driftRate <= driftThreshold : true) &&
    !events.some((event) => event.status >= 500 || event.status === 0) &&
    costs.realLlmRequests <= args.llmMaxCalls &&
    Math.max(0, (voiceAfterTotals.totalJobs ?? 0) - (voiceBeforeTotals.totalJobs ?? 0)) === 0
  );

  const replayHits = events.filter((event) => event.replay?.hit).length;
  const replayEligible = events.filter((event) => !event.useRealLlm).length;
  const chaosEvents = events.filter((event) => event.chaos || event.status === 0 || event.analysis.issues.includes("brain_quiet")).length;
  const degradationShape = classifyDegradation({ events, latency, brainAfterTotals, brainBeforeTotals, costs, llmMaxCalls: args.llmMaxCalls });

  const report = {
    runId: RUN_ID,
    baseUrl: BASE_URL,
    args,
    pass,
    generatedAt: new Date().toISOString(),
    durationMs: endedAt - startedAt,
    users: users.map((user) => ({ userId: user.userId, kind: user.kind, marker: user.marker, friendName: user.friendName, goal: user.goal })),
    totals: {
      requests: events.length,
      mainRequests: events.length - driftEvents.length,
      driftRequests: driftEvents.length,
      crossUserLeakCount,
      hardFailureCount: hardFailures.length,
      brainQuietCount: events.filter((event) => event.analysis.issues.includes("brain_quiet")).length,
      routerAccuracy: confusion.accuracy,
      recallScore: memory.finalRecallScore,
      driftRate,
      naturalnessScore,
      fullLlmUsers: fullLlmUsers.size,
      realLlmCapExceeded: costs.realLlmRequests > args.llmMaxCalls,
      degradationShape
    },
    latency,
    routerConfusion: confusion,
    memoryCorrectness: memory,
    drift: {
      testedUsers: new Set(driftEvents.map((event) => event.user.userId)).size,
      recallEvents: driftRecallEvents.length,
      badEvents: driftBadEvents.length,
      driftRate,
      threshold: driftThreshold,
      pass: args.stage === "single" ? true : driftRate <= driftThreshold && crossUserLeakCount === 0
    },
    cost: costs,
    replay: {
      mode: args.replayCache,
      cacheFile: args.replayCacheFile,
      entries: replayCache.size,
      eligibleEvents: replayEligible,
      hits: replayHits,
      misses: Math.max(0, replayEligible - replayHits)
    },
    failureInjection: {
      profile: args.failureProfile,
      affectedEvents: chaosEvents,
      categories: degradationShape
    },
    queue: {
      brainBefore: brainBefore.body,
      brainAfter: brainAfter.body,
      voiceBefore: voiceBefore.body,
      voiceAfter: voiceAfter.body,
      brainMaxQueueDepthDelta: Math.max(0, (brainAfterTotals.maxQueueDepth ?? 0) - (brainBeforeTotals.maxQueueDepth ?? 0)),
      brainTimedOutDelta: Math.max(0, (brainAfterTotals.timedOutJobs ?? 0) - (brainBeforeTotals.timedOutJobs ?? 0)),
      brainRejectedDelta: Math.max(0, (brainAfterTotals.rejectedJobs ?? 0) - (brainBeforeTotals.rejectedJobs ?? 0)),
      voiceJobDelta: Math.max(0, (voiceAfterTotals.totalJobs ?? 0) - (voiceBeforeTotals.totalJobs ?? 0))
    },
    scalePressure: {
      estimatedArchiveTurnWrites: events.length * 2,
      reminderRequests: events.filter((event) => /remind me|ask me in/i.test(event.step.text)).length,
      remindersScheduled: events.filter((event) => event.body?.reminder || event.body?.reminderDraft).length,
      redisConfigured: Boolean(healthAfter.body?.production?.redis?.configured ?? brainAfter.body?.config?.redis?.configured),
      brainQueueDepthAfter: brainAfter.body?.current?.queueDepth ?? null,
      brainActiveJobsAfter: brainAfter.body?.current?.activeJobs ?? null
    },
    resources: {
      samples: resourceSamples,
      minRssMb: rssValues.length ? Math.min(...rssValues) : null,
      maxRssMb: rssValues.length ? Math.max(...rssValues) : null,
      maxCpuPercent: cpuValues.length ? Math.max(...cpuValues) : null
    },
    failures: hardFailures.slice(0, 300).map((event) => ({
      userId: event.user.userId,
      messageId: event.step.id,
      prompt: event.step.text,
      reply: event.body.reply,
      expectedIntent: event.step.expectedIntent,
      actualIntent: event.analysis.actualIntent,
      routeType: event.routeType,
      status: event.status,
      durationMs: event.durationMs,
      issues: event.analysis.issues,
      memory: event.analysis.memory,
      fixSuggestion: fixSuggestion(event)
    })),
    sampleEvents: events.slice(0, 120)
  };

  const summary = renderSummary(report);
  await fs.writeFile(path.join(OUT_DIR, `${reportStem}.json`), `${JSON.stringify(report, null, 2)}\n`);
  await fs.writeFile(path.join(OUT_DIR, `${reportStem}.md`), `${summary}\n`);
  await writeReplayCache(args, replayCache);
  console.log(summary);
  console.log(`[real-user] wrote ${path.join(OUT_DIR, `${reportStem}.json`)}`);
  console.log(`[real-user] wrote ${path.join(OUT_DIR, `${reportStem}.md`)}`);
  process.exitCode = pass ? 0 : 1;
}

function fixSuggestion(event) {
  if (event.analysis.issues.includes("cross_user_leak")) return "Check test-user isolation and retrieval filters by user_id.";
  if (event.analysis.issues.some((issue) => issue.startsWith("router_catastrophic"))) return "Tune MemoryIntentRouter rules for this prompt shape.";
  if (event.analysis.memory.requiredMisses.length) return "Tune memory atom extraction/retrieval scoring or add deterministic recall handling for this intent.";
  if (event.analysis.issues.includes("forced_memory_phrase")) return "Tighten companion-mode prompt/post-processing memory restraint.";
  if (event.analysis.issues.includes("reminder_missing")) return "Reminder intent did not persist; check agentTools/reminderParser.";
  if (event.status >= 500 || event.status === 0) return "Inspect backend logs and queue/provider timeouts.";
  return "Review prompt, intent, and retrieval context for this case.";
}

function renderSummary(report) {
  const latencyLines = Object.entries(report.latency).map(([route, item]) =>
    `| ${route} | ${item.count} | ${item.avg} | ${item.p50} | ${item.p95} | ${item.p99} | ${item.max} | ${item.hardPass ? "PASS" : "FAIL"} |`
  );
  const matrixLines = Object.entries(report.routerConfusion.matrix).flatMap(([expected, actuals]) =>
    Object.entries(actuals).map(([actual, count]) => `| ${expected} | ${actual} | ${count} |`)
  );
  const topFailures = report.failures.slice(0, 20).map((failure) =>
    `- ${failure.prompt} -> ${failure.issues.join(", ")} | expected=${failure.expectedIntent}, actual=${failure.actualIntent} | ${failure.fixSuggestion}`
  );

  return [
    "# AURA Real User Simulation Report",
    "",
    `Run ID: ${report.runId}`,
    `Stage: ${report.args.stage}`,
    `Mode: ${report.args.mode}`,
    `Pass: ${report.pass}`,
    `Requests: ${report.totals.requests}`,
    "",
    "## Headline Metrics",
    `- Router accuracy: ${(report.totals.routerAccuracy * 100).toFixed(2)}%`,
    `- Recall score: ${(report.totals.recallScore * 100).toFixed(2)}%`,
    `- Drift rate: ${(report.totals.driftRate * 100).toFixed(2)}%`,
    `- Cross-user leaks: ${report.totals.crossUserLeakCount}`,
    `- Hard failures: ${report.totals.hardFailureCount}`,
    `- Naturalness score: ${report.totals.naturalnessScore}/10`,
    `- Degradation shape: ${report.totals.degradationShape}`,
    "",
    "## Latency Budget",
    "| Route | Count | Avg ms | p50 | p95 | p99 | Max | Hard |",
    "|---|---:|---:|---:|---:|---:|---:|---|",
    ...latencyLines,
    "",
    "## Router Confusion Matrix",
    "| Expected | Actual | Count |",
    "|---|---|---:|",
    ...matrixLines,
    "",
    "## Memory Correctness",
    `- Required facts: ${report.memoryCorrectness.totalRequired}`,
    `- Correct hits: ${report.memoryCorrectness.correctHits}`,
    `- Forbidden hits: ${report.memoryCorrectness.forbiddenHits}`,
    `- Final score: ${(report.memoryCorrectness.finalRecallScore * 100).toFixed(2)}%`,
    "",
    "## Cost Estimate",
    `- Theoretical full LLM calls: ${report.cost.theoreticalFullLlmCalls}`,
    `- Real LLM requests: ${report.cost.realLlmRequests}`,
    `- LLM call cap: ${report.cost.llmMaxCalls ?? "unlimited"}`,
    `- Real call share: ${report.cost.realCallPercentOfFull}%`,
    `- Saved real calls: ${report.cost.savedRealLlmCalls}`,
    `- Estimated saved cost: $${report.cost.estimatedSavedCostUsd}`,
    `- Observed cost: $${report.cost.observedCostUsd}`,
    `- Cost per real request: $${report.cost.costPerRealRequestUsd}`,
    `- Projected 1000 users/month at 100 msgs/day: $${report.cost.projected1000UsersMonthUsd}`,
    `- Worst-case 1000-user 40-message spike: $${report.cost.worstCaseSpike1000Users40MessagesUsd}`,
    "",
    "## Queue And Voice Safety",
    `- Brain max queue depth delta: ${report.queue.brainMaxQueueDepthDelta}`,
    `- Brain timed out delta: ${report.queue.brainTimedOutDelta}`,
    `- Brain rejected delta: ${report.queue.brainRejectedDelta}`,
    `- Voice job delta: ${report.queue.voiceJobDelta}`,
    "",
    "## Replay And Failure Injection",
    `- Replay mode: ${report.replay.mode}`,
    `- Replay hits/misses: ${report.replay.hits}/${report.replay.misses}`,
    `- Replay cache entries: ${report.replay.entries}`,
    `- Failure profile: ${report.failureInjection.profile}`,
    `- Failure-affected events: ${report.failureInjection.affectedEvents}`,
    "",
    "## Scale Pressure",
    `- Estimated archive turn writes: ${report.scalePressure.estimatedArchiveTurnWrites}`,
    `- Reminder requests/scheduled: ${report.scalePressure.reminderRequests}/${report.scalePressure.remindersScheduled}`,
    `- Redis configured: ${report.scalePressure.redisConfigured}`,
    `- Brain active/queue after: ${report.scalePressure.brainActiveJobsAfter}/${report.scalePressure.brainQueueDepthAfter}`,
    "",
    "## Top Failures",
    ...(topFailures.length ? topFailures : ["- None"]),
    ""
  ].join("\n");
}

main().catch((error) => {
  console.error("[real-user] fatal", error);
  process.exitCode = 1;
});
