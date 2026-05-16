#!/usr/bin/env node
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const BASE_URL = process.env.AURA_API_BASE_URL ?? "http://127.0.0.1:4000";
const OUT_DIR = process.env.AURA_SCALE_OUT_DIR ?? "/tmp/aura-beta-scale";
const RUN_ID = process.env.AURA_SCALE_RUN_ID ?? String(Date.now());
const TIMEZONE = process.env.AURA_SCALE_TIMEZONE ?? "Asia/Kolkata";
const REQUEST_TIMEOUT_MS = Number(process.env.AURA_SCALE_TIMEOUT_MS ?? 45_000);
const MESSAGE_GAP_MIN_MS = Number(process.env.AURA_SCALE_GAP_MIN_MS ?? 50);
const MESSAGE_GAP_MAX_MS = Number(process.env.AURA_SCALE_GAP_MAX_MS ?? 1000);
const RAMP_USERS_PER_SECOND = Number(process.env.AURA_SCALE_RAMP_USERS_PER_SECOND ?? 100);
const SAMPLE_RESOURCE_MS = Number(process.env.AURA_SCALE_SAMPLE_RESOURCE_MS ?? 1000);

function parseArgs() {
  const args = Object.fromEntries(process.argv.slice(2).map((arg) => {
    const normalized = arg.replace(/^--/, "");
    const [key, ...rest] = normalized.split("=");
    return [key, rest.join("=") || "true"];
  }));
  return {
    stage: String(args.stage ?? "1"),
    users: args.users ? Number(args.users) : null,
    levels: String(args.levels ?? "100,500,1000")
      .split(",")
      .map((value) => Number(value.trim()))
      .filter((value) => Number.isFinite(value) && value > 0),
    llmSample: Number(args["llm-sample"] ?? args.llmSample ?? 0.03),
    messagesPerUser: Number(args.messages ?? 5)
  };
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

function appears(text, marker) {
  return normalize(text).includes(normalize(marker));
}

function hasBrainQuiet(reply) {
  return /AI connection is quiet|brain is busy|trouble reaching AURA|couldn.?t connect|unable to reach/i.test(reply ?? "");
}

function percentile(values, p) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index];
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
      pid,
      cpuPercent: Number(parts[1] ?? 0),
      rssMb: Math.round((Number(parts[2] ?? 0) / 1024) * 10) / 10,
      command: parts.slice(3).join(" ")
    };
  } catch {
    return null;
  }
}

function makeMarker(index) {
  return `scale-${String(index + 1).padStart(5, "0")}-marker`;
}

function makeUsers({ stage, users, messagesPerUser }) {
  const stagePrefix = stage === "2" ? "aura-scale-stage2-user" : "aura-scale-stage1-user";
  return Array.from({ length: users }, (_, index) => {
    const userNumber = index + 1;
    const marker = makeMarker(index);
    const userId = `${stagePrefix}-${userNumber}-${RUN_ID}`;
    if (!userId.startsWith(stagePrefix)) throw new Error(`Unsafe scale user id: ${userId}`);
    const baseTime = Date.now() - 60 * 60 * 1000 + userNumber * 10_000;
    const isoAt = (offsetMinutes) => new Date(baseTime + offsetMinutes * 60_000).toISOString();
    const allSteps = [
      {
        id: "seed",
        text: `Hello Aura. I am scale user ${userNumber}. My private marker is ${marker}. My goal is to keep ${marker} isolated.`,
        eligibleForLlm: true,
        createdAt: isoAt(0)
      },
      {
        id: "reminder",
        text: `Remind me to drink water in 1 min. My reminder marker is ${marker}.`,
        eligibleForLlm: false,
        createdAt: isoAt(1)
      },
      {
        id: "recall",
        text: "What do you remember about my goal?",
        eligibleForLlm: true,
        createdAt: isoAt(2)
      },
      {
        id: "interrupt",
        text: `Stop wait, send again later. My marker is ${marker}.`,
        eligibleForLlm: false,
        createdAt: isoAt(3)
      },
      {
        id: "chat",
        text: `Quick check, I still care about ${marker} and I want this session separate.`,
        eligibleForLlm: true,
        createdAt: isoAt(4)
      }
    ];
    return {
      userNumber,
      userId,
      marker,
      startDelayMs: Math.floor(index / RAMP_USERS_PER_SECOND) * 1000 + jitter(0, 1000),
      steps: allSteps.slice(0, Math.min(5, Math.max(3, messagesPerUser)))
    };
  });
}

function shouldUseRealLlm(stage, step, llmSample) {
  return stage === "2" && step.eligibleForLlm && Math.random() < llmSample;
}

async function capture({ stage, user, step, useRealLlm }) {
  const headers = {
    "content-type": "application/json",
    "x-user-id": user.userId,
    "x-aura-skip-voice": "true",
    "x-aura-test-mode": stage === "2" ? "llm-sample" : "structure-mock",
    "x-aura-test-created-at": step.createdAt
  };
  if (useRealLlm) headers["x-aura-use-real-llm"] = "true";

  return fetchJson(`${BASE_URL}/capture`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      content: step.text,
      inputMode: "text",
      timezone: TIMEZONE,
      skipVoice: true
    })
  });
}

function analyzeEvent(event, allMarkers) {
  const bodyText = JSON.stringify(event.body ?? {});
  const forbidden = allMarkers.filter((marker) => marker !== event.marker);
  const leakedMarkers = forbidden.filter((marker) => appears(bodyText, marker));
  const voiceMoved = event.body?.voice !== null && event.body?.voice !== undefined;
  const reminderMissing = event.stepId === "reminder" && event.ok && !event.body?.reminder && !event.body?.reminderDraft;
  const ownRecallMissing = event.stepId === "recall" && event.ok && !appears(bodyText, event.marker);
  return {
    leakedMarkers,
    voiceMoved,
    reminderMissing,
    ownRecallMissing,
    brainQuiet: hasBrainQuiet(event.body?.reply)
  };
}

function summarizeRun({ stage, users, events, startedAt, endedAt, healthBefore, healthAfter, brainBefore, brainAfter, voiceBefore, voiceAfter, resourceSamples }) {
  const durations = events.map((event) => event.durationMs).filter(Number.isFinite);
  const statusCounts = events.reduce((acc, event) => {
    acc[event.status] = (acc[event.status] ?? 0) + 1;
    return acc;
  }, {});
  const crossUserLeaks = events.filter((event) => event.analysis.leakedMarkers.length);
  const reminderFailures = events.filter((event) => event.analysis.reminderMissing);
  const voiceMoved = events.filter((event) => event.analysis.voiceMoved);
  const brainQuiet = events.filter((event) => event.analysis.brainQuiet);
  const recallWarnings = events.filter((event) => event.analysis.ownRecallMissing);
  const selectedLlmEvents = events.filter((event) => event.useRealLlm);
  const brainBeforeTotals = brainBefore.body?.totals ?? {};
  const brainAfterTotals = brainAfter.body?.totals ?? {};
  const voiceBeforeTotals = voiceBefore.body?.totals ?? {};
  const voiceAfterTotals = voiceAfter.body?.totals ?? {};
  const rssValues = resourceSamples.map((sample) => sample?.rssMb).filter((value) => Number.isFinite(value));
  const cpuValues = resourceSamples.map((sample) => sample?.cpuPercent).filter((value) => Number.isFinite(value));
  const brainActiveLimitExceeded = (brainAfter.body?.totals?.maxActiveJobs ?? 0) > 5;
  const pass = Boolean(
    healthBefore.ok &&
    healthAfter.ok &&
    crossUserLeaks.length === 0 &&
    reminderFailures.length === 0 &&
    voiceMoved.length === 0 &&
    !brainActiveLimitExceeded &&
    !events.some((event) => event.status >= 500 || event.status === 0)
  );

  return {
    stage,
    users,
    totalRequests: events.length,
    pass,
    rps: Number((events.length / Math.max(1, (endedAt - startedAt) / 1000)).toFixed(2)),
    avgLatencyMs: Math.round(durations.reduce((sum, value) => sum + value, 0) / Math.max(1, durations.length)),
    p95LatencyMs: percentile(durations, 95),
    maxLatencyMs: Math.max(0, ...durations),
    statusCounts,
    rateLimitCount: statusCounts[429] ?? 0,
    serverErrorCount: events.filter((event) => event.status >= 500).length,
    timeoutCount: events.filter((event) => event.status === 0).length,
    crossUserLeakCount: crossUserLeaks.length,
    reminderFailureCount: reminderFailures.length,
    recallWarningCount: recallWarnings.length,
    voiceMovedCount: voiceMoved.length,
    selectedLlmCount: selectedLlmEvents.length,
    brainQuietCount: brainQuiet.length,
    brainMaxActiveJobs: brainAfter.body?.totals?.maxActiveJobs ?? 0,
    brainMaxQueueDepthDelta: Math.max(0, (brainAfterTotals.maxQueueDepth ?? 0) - (brainBeforeTotals.maxQueueDepth ?? 0)),
    brainRejectedDelta: Math.max(0, (brainAfterTotals.rejectedJobs ?? 0) - (brainBeforeTotals.rejectedJobs ?? 0)),
    brainTimedOutDelta: Math.max(0, (brainAfterTotals.timedOutJobs ?? 0) - (brainBeforeTotals.timedOutJobs ?? 0)),
    brainProviderFallbackDelta: Math.max(0, (brainAfterTotals.providerFallbackCount ?? 0) - (brainBeforeTotals.providerFallbackCount ?? 0)),
    voiceTotalJobDelta: Math.max(0, (voiceAfterTotals.totalJobs ?? 0) - (voiceBeforeTotals.totalJobs ?? 0)),
    maxRssMb: rssValues.length ? Math.max(...rssValues) : null,
    minRssMb: rssValues.length ? Math.min(...rssValues) : null,
    maxCpuPercent: cpuValues.length ? Math.max(...cpuValues) : null,
    bottleneck: (() => {
      if (events.some((event) => event.status === 0)) return "client_or_backend_connection";
      if (events.some((event) => event.status >= 500)) return "backend_server_error";
      if (crossUserLeaks.length) return "memory_isolation";
      if (reminderFailures.length) return "reminder_store";
      if (brainActiveLimitExceeded) return "brain_queue_limit_broken";
      if (stage === "2" && brainQuiet.length) return "llm_provider_fallback";
      if (Math.max(0, ...durations) > 30_000) return "latency";
      if (rssValues.length && Math.max(...rssValues) - Math.min(...rssValues) > 800) return "memory_growth";
      return "none_observed";
    })()
  };
}

async function runOne({ stage, users: userCount, llmSample, messagesPerUser }) {
  const startedAt = Date.now();
  const pid = await backendPid();
  const resourceSamples = [];
  let sampling = true;
  const sampler = setInterval(() => {
    void sampleProcess(pid).then((sample) => {
      if (sampling && sample) resourceSamples.push({ at: new Date().toISOString(), ...sample });
    });
  }, SAMPLE_RESOURCE_MS);
  sampler.unref?.();

  const healthBefore = await getJson("/health");
  const brainBefore = await getJson("/brain/metrics");
  const voiceBefore = await getJson("/voice/metrics");
  const generatedUsers = makeUsers({ stage, users: userCount, messagesPerUser });
  const allMarkers = generatedUsers.map((user) => user.marker);
  const events = [];

  console.log(`[scale] stage=${stage} users=${userCount} requests=${generatedUsers.reduce((sum, user) => sum + user.steps.length, 0)} llmSample=${llmSample}`);

  const tasks = [];
  for (const user of generatedUsers) {
    if (!user.userId.startsWith(stage === "2" ? "aura-scale-stage2-user-" : "aura-scale-stage1-user-")) {
      throw new Error(`Unsafe user id generated: ${user.userId}`);
    }

    tasks.push((async () => {
      await sleep(user.startDelayMs);
      for (const step of user.steps) {
        await sleep(jitter(MESSAGE_GAP_MIN_MS, MESSAGE_GAP_MAX_MS));
        const useRealLlm = shouldUseRealLlm(stage, step, llmSample);
        const requestStartedAt = Date.now();
        const result = await capture({ stage, user, step, useRealLlm });
        const event = {
          userId: user.userId,
          userNumber: user.userNumber,
          marker: user.marker,
          stepId: step.id,
          useRealLlm,
          startedAt: requestStartedAt,
          endedAt: Date.now(),
          durationMs: result.durationMs,
          ok: result.ok,
          status: result.status,
          error: result.error ?? null,
          body: {
            reply: result.body?.reply ?? "",
            voice: result.body?.voice ?? null,
            reminder: result.body?.reminder ?? null,
            reminderDraft: result.body?.reminderDraft ?? null,
            scaleTest: result.body?.scaleTest ?? null,
            archive: result.body?.archive ? {
              dateRecall: result.body.archive.dateRecall,
              recallMode: result.body.archive.recallMode,
              sessionId: result.body.archive.userTurn?.session_id
            } : null
          }
        };
        event.analysis = analyzeEvent(event, allMarkers);
        events.push(event);
      }
    })());
  }

  await Promise.all(tasks);
  sampling = false;
  clearInterval(sampler);
  resourceSamples.push(await sampleProcess(pid));

  const healthAfter = await getJson("/health");
  const brainAfter = await getJson("/brain/metrics");
  const voiceAfter = await getJson("/voice/metrics");
  const endedAt = Date.now();
  events.sort((a, b) => a.startedAt - b.startedAt);

  const summary = summarizeRun({
    stage,
    users: userCount,
    events,
    startedAt,
    endedAt,
    healthBefore,
    healthAfter,
    brainBefore,
    brainAfter,
    voiceBefore,
    voiceAfter,
    resourceSamples
  });

  return {
    ...summary,
    startedAt: new Date(startedAt).toISOString(),
    endedAt: new Date(endedAt).toISOString(),
    durationMs: endedAt - startedAt,
    healthBefore: healthBefore.body,
    healthAfter: healthAfter.body,
    brainBefore: brainBefore.body,
    brainAfter: brainAfter.body,
    voiceBefore: voiceBefore.body,
    voiceAfter: voiceAfter.body,
    resourceSamples,
    failures: events
      .filter((event) => event.analysis.leakedMarkers.length || event.analysis.reminderMissing || event.analysis.voiceMoved || event.status >= 500 || event.status === 0)
      .slice(0, 200),
    warnings: events
      .filter((event) => event.analysis.ownRecallMissing || event.analysis.brainQuiet || event.status === 429)
      .slice(0, 200),
    sampleEvents: events.slice(0, 100)
  };
}

function nextStageAllowed(results) {
  const last = results[results.length - 1];
  return last?.pass === true;
}

function recommendation(results) {
  const passed = results.filter((result) => result.pass);
  const maxPassedStage1 = Math.max(0, ...passed.filter((result) => result.stage === "1").map((result) => result.users));
  const stage2 = [...results].reverse().find((result) => result.stage === "2");
  if (maxPassedStage1 === 0 && stage2?.pass) return `Stage 2 passed at ${stage2.users} users with sampled LLM. Run Stage 1 levels in the same command for a combined structure recommendation.`;
  if (stage2 && !stage2.pass) return `Structure passed up to ${maxPassedStage1} users, but Stage 2 LLM sampling needs tuning before beta expansion.`;
  if (stage2?.pass) return `Structure passed up to ${maxPassedStage1} users and Stage 2 passed at ${stage2.users} users with sampled LLM.`;
  return `Structure passed up to ${maxPassedStage1} users. Run Stage 2 sampled LLM next.`;
}

async function main() {
  const args = parseArgs();
  await fs.mkdir(OUT_DIR, { recursive: true });

  const runs = [];
  if (args.stage === "1" && args.users) {
    runs.push({ stage: "1", users: args.users });
  } else if (args.stage === "1") {
    for (const users of args.levels) runs.push({ stage: "1", users });
  } else if (args.stage === "2") {
    runs.push({ stage: "2", users: args.users ?? 1000 });
  } else if (args.stage === "both") {
    for (const users of args.levels) runs.push({ stage: "1", users });
    runs.push({ stage: "2", users: args.users ?? args.levels[args.levels.length - 1] ?? 1000 });
  } else {
    throw new Error("Use --stage=1, --stage=2, or --stage=both.");
  }

  const results = [];
  for (const run of runs) {
    if (results.length && !nextStageAllowed(results)) {
      console.warn("[scale] stopping ramp because previous level did not pass");
      break;
    }
    const result = await runOne({
      stage: run.stage,
      users: run.users,
      llmSample: args.llmSample,
      messagesPerUser: args.messagesPerUser
    });
    results.push(result);
    console.log(`[scale] stage=${result.stage} users=${result.users} pass=${result.pass} rps=${result.rps} avg=${result.avgLatencyMs}ms p95=${result.p95LatencyMs}ms bottleneck=${result.bottleneck}`);
  }

  const report = {
    runId: RUN_ID,
    baseUrl: BASE_URL,
    args,
    results,
    recommendation: recommendation(results),
    generatedAt: new Date().toISOString()
  };

  const summary = [
    "# AURA Backend Scale Report",
    "",
    `Run ID: ${RUN_ID}`,
    `Base URL: ${BASE_URL}`,
    `Recommendation: ${report.recommendation}`,
    "",
    "## Results",
    ...results.map((result) => [
      `- Stage ${result.stage}, users=${result.users}, pass=${result.pass}`,
      `  requests=${result.totalRequests}, rps=${result.rps}, avg=${result.avgLatencyMs}ms, p95=${result.p95LatencyMs}ms, max=${result.maxLatencyMs}ms`,
      `  leaks=${result.crossUserLeakCount}, remindersFailed=${result.reminderFailureCount}, voiceJobs=${result.voiceTotalJobDelta}`,
      `  llmSelected=${result.selectedLlmCount}, brainMaxActive=${result.brainMaxActiveJobs}, brainQueueDepth=${result.brainMaxQueueDepthDelta}, brainFallback=${result.brainProviderFallbackDelta}`,
      `  rss=${result.minRssMb ?? "n/a"}-${result.maxRssMb ?? "n/a"}MB, cpuMax=${result.maxCpuPercent ?? "n/a"}%, bottleneck=${result.bottleneck}`
    ].join("\n")),
    "",
    "## Safety Notes",
    "- Scale users are isolated in test-only in-memory stores.",
    "- Stage 1 uses mock brain and skips external AI providers.",
    "- Voice/STT/TTS are disabled through skipVoice and verified by voice job delta."
  ].join("\n");

  await fs.writeFile(path.join(OUT_DIR, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  await fs.writeFile(path.join(OUT_DIR, "summary.md"), `${summary}\n`);

  console.log(summary);
  console.log(`[scale] wrote ${path.join(OUT_DIR, "report.json")}`);
  console.log(`[scale] wrote ${path.join(OUT_DIR, "summary.md")}`);

  process.exitCode = results.every((result) => result.pass) ? 0 : 1;
}

main().catch((error) => {
  console.error("[scale] fatal", error);
  process.exitCode = 1;
});
