#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";

const BASE_URL = process.env.AURA_API_BASE_URL ?? "http://127.0.0.1:4000";
const OUT_DIR = process.env.AURA_BRAIN_BURST_OUT_DIR ?? "/tmp/aura-beta-brain-burst";
const RUN_ID = process.env.AURA_BRAIN_BURST_RUN_ID ?? String(Date.now());
const USER_COUNT = Number(process.env.AURA_BRAIN_BURST_USERS ?? 10);
const TIMEZONE = process.env.AURA_BRAIN_BURST_TIMEZONE ?? "Asia/Kolkata";
const REQUEST_TIMEOUT_MS = Number(process.env.AURA_BRAIN_BURST_TIMEOUT_MS ?? 45_000);
const DELAYED_REMINDER_MS = Number(process.env.AURA_BRAIN_BURST_DELAYED_REMINDER_MS ?? 15_000);
const MESSAGE_GAP_MIN_MS = Number(process.env.AURA_BRAIN_BURST_GAP_MIN_MS ?? 50);
const MESSAGE_GAP_MAX_MS = Number(process.env.AURA_BRAIN_BURST_GAP_MAX_MS ?? 1000);

const markerSeeds = [
  "swift-lotus-1",
  "trading-moon-2",
  "focus-sun-3",
  "calm-river-4",
  "night-owl-5",
  "design-orbit-6",
  "fitness-cloud-7",
  "journal-prism-8",
  "habit-ember-9",
  "memory-silver-10"
];

const names = ["Aarav", "Zoya", "Kabir", "Mira", "Vihaan", "Ira", "Rayan", "Anaya", "Dev", "Tara"];
const emotions = ["stressed", "excited", "tired", "calm but distracted", "overwhelmed", "hopeful", "restless", "focused", "low energy", "curious"];
const goals = [
  "learn Swift for the AURA iOS app",
  "stay disciplined with trading notes",
  "finish a deep work sprint",
  "keep my nervous system calm",
  "fix my sleep routine",
  "design a minimal premium UI",
  "build fitness consistency",
  "write honest journal entries",
  "reduce bad habits",
  "improve long-term memory recall"
];

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

function includesAnyMarker(text, markers) {
  return markers.filter((marker) => appears(text, marker));
}

function hasBrainQuiet(reply) {
  return /AI connection is quiet|trouble reaching AURA|trouble reaching Aura|couldn.?t connect|unable to reach/i.test(reply ?? "");
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
    return {
      ok: res.ok,
      status: res.status,
      body,
      durationMs: Date.now() - startedAt
    };
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

async function health() {
  return fetchJson(`${BASE_URL}/health`, { method: "GET" }, 10_000);
}

async function voiceMetrics() {
  return fetchJson(`${BASE_URL}/voice/metrics`, { method: "GET" }, 10_000);
}

async function brainMetrics() {
  return fetchJson(`${BASE_URL}/brain/metrics`, { method: "GET" }, 10_000);
}

async function listReminders(userId) {
  return fetchJson(`${BASE_URL}/reminders`, {
    method: "GET",
    headers: { "x-user-id": userId }
  }, 10_000);
}

async function capture({ user, step }) {
  const headers = {
    "content-type": "application/json",
    "x-user-id": user.userId,
    "x-aura-skip-voice": "true",
    "x-aura-test-created-at": step.createdAt
  };

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

function makeUsers() {
  return Array.from({ length: USER_COUNT }, (_, index) => {
    const userNumber = index + 1;
    const marker = markerSeeds[index % markerSeeds.length];
    const userId = `aura-beta-brain-burst-user-${userNumber}-${RUN_ID}`;
    const goal = `${goals[index % goals.length]} (${marker})`;
    const name = names[index % names.length];
    const emotion = emotions[index % emotions.length];
    const baseTime = Date.now() - 2 * 60 * 60 * 1000 + userNumber * 60_000;
    const isoAt = (offsetMinutes) => new Date(baseTime + offsetMinutes * 60_000).toISOString();

    return {
      userNumber,
      userId,
      name,
      marker,
      goal,
      emotion,
      startDelayMs: jitter(0, 600),
      steps: [
        {
          id: "seed",
          text: `Hello Aura. I am ${name}, beta user ${userNumber}. My private marker is ${marker}. My goal is ${goal}. Keep this isolated from every other user.`,
          createdAt: isoAt(0)
        },
        {
          id: "emotion",
          text: `I feel ${emotion} today because I am thinking about ${marker}. Talk normally and do not dump memory logs.`,
          createdAt: isoAt(1)
        },
        {
          id: "chaotic",
          text: `Sending another quick message. The important thing is ${marker}, and I am trying to stay consistent with my goal.`,
          createdAt: isoAt(2)
        },
        {
          id: "interrupt",
          text: `Stop wait, leave that for a second. Do not mix me up with anyone else. My marker is still ${marker}.`,
          createdAt: isoAt(3)
        },
        {
          id: "reminder",
          text: `Remind me to drink water in 1 min. My reminder marker is ${marker}.`,
          createdAt: isoAt(4)
        },
        {
          id: "recall",
          text: "What do you remember about my goal?",
          createdAt: isoAt(5)
        }
      ]
    };
  });
}

function classifyReminder({ reminderResult, remindersResult, marker }) {
  if (reminderResult.status === 429) return "rejected_due_to_rate_limit";

  const responseReminderText = JSON.stringify({
    reminder: reminderResult.body?.reminder ?? null,
    reminderDraft: reminderResult.body?.reminderDraft ?? null,
    reply: reminderResult.body?.reply ?? ""
  });
  const listedReminderText = JSON.stringify(remindersResult.body?.reminders ?? []);
  const hasReminderInResponse = Boolean(reminderResult.body?.reminder || reminderResult.body?.reminderDraft);
  const hasReminderInList = appears(listedReminderText, marker);

  if ((hasReminderInResponse || hasReminderInList) && reminderResult.durationMs > DELAYED_REMINDER_MS) {
    return "delayed_execution";
  }
  if ((hasReminderInResponse || hasReminderInList) && appears(`${responseReminderText}\n${listedReminderText}`, marker)) {
    return "scheduled_successfully";
  }
  return "failed_unexpectedly";
}

function analyzeUserResults({ user, results, remindersResult, allMarkers }) {
  const forbiddenMarkers = allMarkers.filter((marker) => marker !== user.marker);
  const failures = [];
  const warnings = [];
  const stepMap = new Map(results.map((result) => [result.stepId, result]));

  for (const result of results) {
    const bodyText = JSON.stringify(result.body ?? {});
    const leaked = includesAnyMarker(bodyText, forbiddenMarkers);
    if (leaked.length) {
      failures.push({
        type: "cross_user_leak",
        stepId: result.stepId,
        leakedMarkers: leaked
      });
    }
    if (result.body?.voice !== null && result.body?.voice !== undefined) {
      failures.push({
        type: "voice_not_skipped",
        stepId: result.stepId,
        voice: result.body.voice
      });
    }
    if (result.status === 0) {
      failures.push({
        type: "request_timeout_or_network_error",
        stepId: result.stepId,
        error: result.error
      });
    }
    if (result.status >= 500) {
      failures.push({
        type: "server_error",
        stepId: result.stepId,
        status: result.status
      });
    }
    if (hasBrainQuiet(result.body?.reply)) {
      warnings.push({
        type: "brain_quiet_fallback",
        stepId: result.stepId
      });
    }
  }

  const reminderResult = stepMap.get("reminder");
  const recallResult = stepMap.get("recall");
  const reminderOutcome = reminderResult
    ? classifyReminder({ reminderResult, remindersResult, marker: user.marker })
    : "failed_unexpectedly";

  if (reminderOutcome === "failed_unexpectedly") {
    failures.push({ type: "reminder_failed_unexpectedly", stepId: "reminder" });
  }

  if (recallResult?.status === 429) {
    warnings.push({ type: "recall_rate_limited", stepId: "recall" });
  } else if (recallResult?.ok) {
    const recallText = JSON.stringify(recallResult.body ?? {});
    if (!appears(recallText, user.marker) && !appears(recallText, user.goal)) {
      warnings.push({
        type: "recall_did_not_surface_own_goal_marker",
        stepId: "recall"
      });
    }
  } else {
    failures.push({
      type: "recall_failed",
      stepId: "recall",
      status: recallResult?.status ?? null
    });
  }

  return {
    userId: user.userId,
    marker: user.marker,
    reminderOutcome,
    failures,
    warnings
  };
}

function percentile(values, p) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index];
}

function summarizeDegradation({ events, startedAt, endedAt, voiceBefore, voiceAfter, brainBefore, brainAfter }) {
  const durations = events.map((event) => event.durationMs).filter(Number.isFinite);
  const statuses = events.reduce((acc, event) => {
    acc[event.status] = (acc[event.status] ?? 0) + 1;
    return acc;
  }, {});
  const errors = events.filter((event) => !event.ok);
  const rateLimits = events.filter((event) => event.status === 429);
  const timeouts = events.filter((event) => event.status === 0);
  const serverErrors = events.filter((event) => event.status >= 500);
  const brainQuietEvents = events.filter((event) => hasBrainQuiet(event.body?.reply));
  const eventsByStartOrder = [...events].sort((a, b) => a.startedAt - b.startedAt);
  const midpoint = Math.ceil(eventsByStartOrder.length / 2);
  const firstHalf = eventsByStartOrder.slice(0, midpoint);
  const secondHalf = eventsByStartOrder.slice(midpoint);
  const firstAvg = firstHalf.length ? firstHalf.reduce((sum, event) => sum + event.durationMs, 0) / firstHalf.length : 0;
  const secondAvg = secondHalf.length ? secondHalf.reduce((sum, event) => sum + event.durationMs, 0) / secondHalf.length : 0;
  const voiceBeforeMetrics = voiceBefore.body?.metrics ?? voiceBefore.body ?? {};
  const voiceAfterMetrics = voiceAfter.body?.metrics ?? voiceAfter.body ?? {};
  const brainBeforeMetrics = brainBefore.body ?? {};
  const brainAfterMetrics = brainAfter.body ?? {};
  const voiceQueueMoved = JSON.stringify({
    activeJobs: voiceAfterMetrics.current?.activeJobs ?? voiceAfterMetrics.activeJobs,
    queueDepth: voiceAfterMetrics.current?.queueDepth ?? voiceAfterMetrics.queueDepth
  });
  const brainTotalsBefore = brainBeforeMetrics.totals ?? {};
  const brainTotalsAfter = brainAfterMetrics.totals ?? {};
  const brainCurrentAfter = brainAfterMetrics.current ?? {};
  const brainQueueMaxDepth = Math.max(0, (brainTotalsAfter.maxQueueDepth ?? 0) - (brainTotalsBefore.maxQueueDepth ?? 0));
  const brainCompletedDelta = Math.max(0, (brainTotalsAfter.completedJobs ?? 0) - (brainTotalsBefore.completedJobs ?? 0));
  const brainTimedOutDelta = Math.max(0, (brainTotalsAfter.timedOutJobs ?? 0) - (brainTotalsBefore.timedOutJobs ?? 0));
  const brainRejectedDelta = Math.max(0, (brainTotalsAfter.rejectedJobs ?? 0) - (brainTotalsBefore.rejectedJobs ?? 0));
  const brainProviderFallbackDelta = Math.max(0, (brainTotalsAfter.providerFallbackCount ?? 0) - (brainTotalsBefore.providerFallbackCount ?? 0));

  let shape = "smooth_slowdown";
  if (timeouts.length || serverErrors.length) shape = "random_failures";
  if (rateLimits.length && !timeouts.length && !serverErrors.length) shape = "consistent_429_handling";
  if (brainQuietEvents.length && !timeouts.length && !serverErrors.length) shape = "provider_fallback_degradation";
  if (brainRejectedDelta || brainTimedOutDelta) shape = "brain_queue_overloaded";
  if ((voiceAfterMetrics.current?.queueDepth ?? 0) > (voiceBeforeMetrics.current?.queueDepth ?? 0)) {
    shape = "queue_growth_observed";
  }

  const bottleneckIdentification = (() => {
    if (timeouts.length || serverErrors.length) return "backend_or_network_errors";
    if (brainRejectedDelta || brainTimedOutDelta) return "brain_queue_overload";
    if (rateLimits.length) return "provider_rate_limit";
    if (brainQuietEvents.length) return "llm_provider_timeout_or_empty_response";
    if (Math.max(0, ...durations) > 20_000 || percentile(durations, 95) > 15_000) return "llm_provider_latency";
    return "no_clear_bottleneck_observed";
  })();

  return {
    totalRequests: events.length,
    rps: Number((events.length / Math.max(1, (endedAt - startedAt) / 1000)).toFixed(2)),
    avgLatencyMs: Math.round(durations.reduce((sum, value) => sum + value, 0) / Math.max(1, durations.length)),
    p95LatencyMs: percentile(durations, 95),
    maxLatencyMs: Math.max(0, ...durations),
    firstHalfAvgLatencyMs: Math.round(firstAvg),
    secondHalfAvgLatencyMs: Math.round(secondAvg),
    statusCounts: statuses,
    errorCount: errors.length,
    rateLimitCount: rateLimits.length,
    timeoutCount: timeouts.length,
    serverErrorCount: serverErrors.length,
    brainQuietCount: brainQuietEvents.length,
    brainQueueMaxDepth,
    brainQueueActiveAfter: brainCurrentAfter.activeJobs ?? 0,
    brainQueueDepthAfter: brainCurrentAfter.queueDepth ?? 0,
    brainQueueCompletedDelta: brainCompletedDelta,
    brainQueueTimedOutDelta: brainTimedOutDelta,
    brainQueueRejectedDelta: brainRejectedDelta,
    brainProviderFallbackDelta,
    brainAvgQueueWaitMs: brainTotalsAfter.avgQueueWaitMs ?? 0,
    brainMaxQueueWaitMs: brainTotalsAfter.maxQueueWaitMs ?? 0,
    degradationShape: shape,
    bottleneckIdentification,
    voiceQueueSnapshot: voiceQueueMoved
  };
}

function safeUsersRecommendation({ userAnalyses, metrics }) {
  const hardFailures = userAnalyses.flatMap((user) => user.failures).filter((failure) => failure.type !== "request_timeout_or_network_error");
  if (userAnalyses.some((user) => user.failures.some((failure) => failure.type === "cross_user_leak"))) {
    return "0 production beta users until cross-user isolation is fixed.";
  }
  if (metrics.brainQueueTimedOutDelta || metrics.brainQueueRejectedDelta) {
    return "3-5 simultaneously active beta users until brain queue overload is reduced.";
  }
  if (metrics.brainQuietCount > 0) {
    return "3-5 simultaneously active beta users until LLM provider fallback/timeout behavior is improved.";
  }
  if (metrics.rateLimitCount > 0 || metrics.maxLatencyMs > 25_000) {
    return "5-7 simultaneously active beta users on the current shared provider pool, then retest.";
  }
  if (hardFailures.length) {
    return "Keep to personal/private beta until unexpected failures are fixed.";
  }
  return "10 simultaneously active beta users looked acceptable in this local burst test.";
}

async function run() {
  const startedAt = Date.now();
  await fs.mkdir(OUT_DIR, { recursive: true });

  const healthBefore = await health();
  const voiceBefore = await voiceMetrics();
  const brainBefore = await brainMetrics();
  const users = makeUsers();
  const allMarkers = users.map((user) => user.marker);
  const events = [];

  console.log(`[brain-burst] starting ${users.length} users / ${users.length * 6} capture requests against ${BASE_URL}`);

  const tasks = [];
  for (const user of users) {
    let cumulativeDelay = user.startDelayMs;
    for (const step of user.steps) {
      cumulativeDelay += jitter(MESSAGE_GAP_MIN_MS, MESSAGE_GAP_MAX_MS);
      const scheduledDelayMs = cumulativeDelay;
      tasks.push((async () => {
        await sleep(scheduledDelayMs);
        const requestStartedAt = Date.now();
        const result = await capture({ user, step });
        const event = {
          userId: user.userId,
          userNumber: user.userNumber,
          marker: user.marker,
          stepId: step.id,
          prompt: step.text,
          startedAt: requestStartedAt,
          endedAt: Date.now(),
          ok: result.ok,
          status: result.status,
          durationMs: result.durationMs,
          error: result.error ?? null,
          body: result.body
        };
        events.push(event);
        console.log("[brain-burst]", {
          user: user.userNumber,
          step: step.id,
          status: event.status,
          durationMs: event.durationMs
        });
      })());
    }
  }

  await Promise.all(tasks);

  const reminderResults = new Map();
  for (const user of users) {
    reminderResults.set(user.userId, await listReminders(user.userId));
  }

  const healthAfter = await health();
  const voiceAfter = await voiceMetrics();
  const brainAfter = await brainMetrics();
  const endedAt = Date.now();
  events.sort((a, b) => a.startedAt - b.startedAt);

  const userAnalyses = users.map((user) => analyzeUserResults({
    user,
    results: events.filter((event) => event.userId === user.userId),
    remindersResult: reminderResults.get(user.userId),
    allMarkers
  }));
  const metrics = summarizeDegradation({ events, startedAt, endedAt, voiceBefore, voiceAfter, brainBefore, brainAfter });
  const crossUserLeaks = userAnalyses.flatMap((user) => user.failures.filter((failure) => failure.type === "cross_user_leak"));
  const reminderOutcomes = userAnalyses.reduce((acc, user) => {
    acc[user.reminderOutcome] = (acc[user.reminderOutcome] ?? 0) + 1;
    return acc;
  }, {});
  const unexpectedFailures = userAnalyses.flatMap((user) => user.failures);
  const pass = crossUserLeaks.length === 0 &&
    !unexpectedFailures.some((failure) => failure.type === "server_error" || failure.type === "voice_not_skipped" || failure.type === "reminder_failed_unexpectedly" || failure.type === "request_timeout_or_network_error") &&
    healthAfter.ok;

  const report = {
    runId: RUN_ID,
    baseUrl: BASE_URL,
    startedAt: new Date(startedAt).toISOString(),
    endedAt: new Date(endedAt).toISOString(),
    durationMs: endedAt - startedAt,
    pass,
    healthBefore: healthBefore.body,
    healthAfter: healthAfter.body,
    voiceBefore: voiceBefore.body,
    voiceAfter: voiceAfter.body,
    brainBefore: brainBefore.body,
    brainAfter: brainAfter.body,
    metrics,
    reminderOutcomes,
    safeConcurrencyRecommendation: safeUsersRecommendation({ userAnalyses, metrics }),
    userAnalyses,
    events,
    remindersByUser: Object.fromEntries([...reminderResults.entries()].map(([userId, result]) => [userId, result.body?.reminders ?? []]))
  };

  const summary = [
    "# AURA Backend Brain Burst Report",
    "",
    `Run ID: ${RUN_ID}`,
    `Base URL: ${BASE_URL}`,
    `Pass: ${pass ? "YES" : "NO"}`,
    `Total requests: ${metrics.totalRequests}`,
    `RPS: ${metrics.rps}`,
    `Average latency: ${metrics.avgLatencyMs}ms`,
    `P95 latency: ${metrics.p95LatencyMs}ms`,
    `Max latency: ${metrics.maxLatencyMs}ms`,
    `Status counts: ${JSON.stringify(metrics.statusCounts)}`,
    `Rate limits: ${metrics.rateLimitCount}`,
    `Timeouts/network errors: ${metrics.timeoutCount}`,
    `Server errors: ${metrics.serverErrorCount}`,
    `Brain quiet fallbacks: ${metrics.brainQuietCount}`,
    `Brain queue max depth: ${metrics.brainQueueMaxDepth}`,
    `Brain queue timeouts: ${metrics.brainQueueTimedOutDelta}`,
    `Brain queue rejected: ${metrics.brainQueueRejectedDelta}`,
    `Brain provider fallbacks: ${metrics.brainProviderFallbackDelta}`,
    `Brain max queue wait: ${metrics.brainMaxQueueWaitMs}ms`,
    `Degradation shape: ${metrics.degradationShape}`,
    `Bottleneck: ${metrics.bottleneckIdentification}`,
    `Reminder outcomes: ${JSON.stringify(reminderOutcomes)}`,
    `Cross-user leaks: ${crossUserLeaks.length}`,
    `Safe concurrency recommendation: ${report.safeConcurrencyRecommendation}`,
    "",
    "## User Results",
    ...userAnalyses.map((user) => `- ${user.userId}: reminder=${user.reminderOutcome}, failures=${user.failures.length}, warnings=${user.warnings.length}`),
    "",
    "## Notes",
    "- STT/TTS/audio were intentionally disabled.",
    "- Any 429 is classified as provider-pool pressure, not a crash.",
    "- Cross-user leakage is a catastrophic failure even if all HTTP responses are 200."
  ].join("\n");

  await fs.writeFile(path.join(OUT_DIR, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  await fs.writeFile(path.join(OUT_DIR, "summary.md"), `${summary}\n`);

  console.log(summary);
  console.log(`[brain-burst] wrote ${path.join(OUT_DIR, "report.json")}`);
  console.log(`[brain-burst] wrote ${path.join(OUT_DIR, "summary.md")}`);

  process.exitCode = pass ? 0 : 1;
}

run().catch((error) => {
  console.error("[brain-burst] fatal", error);
  process.exitCode = 1;
});
