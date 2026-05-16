#!/usr/bin/env node
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const BASE_URL = process.env.AURA_API_BASE_URL ?? "http://127.0.0.1:4000";
const OUT_DIR = process.env.AURA_INTERRUPT_OUT_DIR ?? "/tmp/aura-beta-interrupt-storm";
const RUN_ID = process.env.AURA_INTERRUPT_RUN_ID ?? String(Date.now());
const USER_COUNT = Number(process.env.AURA_INTERRUPT_USERS ?? 10);
const REQUEST_TIMEOUT_MS = Number(process.env.AURA_INTERRUPT_TIMEOUT_MS ?? 45_000);
const SAMPLE_MS = Number(process.env.AURA_INTERRUPT_SAMPLE_MS ?? 500);
const TIMEZONE = process.env.AURA_INTERRUPT_TIMEZONE ?? "Asia/Kolkata";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function jitter(min, max) {
  return Math.round(min + Math.random() * (max - min));
}

async function fetchJson(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    const text = await res.text();
    let body = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = { raw: text };
    }
    return { ok: res.ok, status: res.status, body };
  } finally {
    clearTimeout(timeout);
  }
}

async function shell(cmd) {
  try {
    const { stdout } = await execFileAsync("bash", ["-lc", cmd], { timeout: 3000, maxBuffer: 1024 * 1024 });
    return stdout.trim();
  } catch {
    return "";
  }
}

async function backendResourceSample() {
  const pid = (await shell("lsof -tiTCP:4000 -sTCP:LISTEN | head -1")).trim();
  if (!pid) return { pid: null, rssKb: 0, cpu: 0 };
  const raw = await shell(`ps -o rss= -o %cpu= -p ${pid}`);
  const [rssRaw, cpuRaw] = raw.split(/\s+/);
  return {
    pid,
    rssKb: Number(rssRaw ?? 0) || 0,
    cpu: Number(cpuRaw ?? 0) || 0
  };
}

async function pocketProcessCount() {
  const raw = await shell("pgrep -fl 'pocket-tts|uvx|python.*pocket' || true");
  return raw ? raw.split("\n").filter(Boolean).length : 0;
}

async function pocketTempStats() {
  const entries = await fs.readdir(os.tmpdir()).catch(() => []);
  let count = 0;
  let bytes = 0;
  await Promise.all(entries.map(async (entry) => {
    if (!entry.startsWith("aura-pocket-tts-")) return;
    count += 1;
    const fullPath = path.join(os.tmpdir(), entry);
    const sizeRaw = await shell(`du -sk ${JSON.stringify(fullPath)} 2>/dev/null | awk '{print $1}'`);
    bytes += (Number(sizeRaw) || 0) * 1024;
  }));
  return { count, bytes };
}

async function metrics() {
  const result = await fetchJson(`${BASE_URL}/voice/metrics`);
  return result.ok ? result.body : null;
}

function headers(userId, chaos) {
  const result = {
    "content-type": "application/json",
    "x-user-id": userId
  };
  if (chaos) result["x-aura-chaos"] = chaos;
  return result;
}

async function synthesize({ userId, text, priority = "reply", speechSessionId, interruptPrevious = false, staleAfterMs, chaos, label }) {
  const startedAt = Date.now();
  const result = await fetchJson(`${BASE_URL}/voice/synthesize`, {
    method: "POST",
    headers: headers(userId, chaos),
    body: JSON.stringify({
      text,
      priority,
      speechSessionId,
      interruptPrevious,
      staleAfterMs
    })
  });
  return {
    kind: "synthesize",
    label,
    userId,
    priority,
    status: result.status,
    ok: result.ok,
    durationMs: Date.now() - startedAt,
    provider: result.body?.voice?.provider ?? null,
    hasVoice: Boolean(result.body?.voice?.audioBase64),
    body: result.body
  };
}

async function cancel({ userId, speechSessionId, label }) {
  const startedAt = Date.now();
  const result = await fetchJson(`${BASE_URL}/voice/cancel`, {
    method: "POST",
    headers: headers(userId),
    body: JSON.stringify({ speechSessionId })
  });
  return {
    kind: "cancel",
    label,
    userId,
    status: result.status,
    ok: result.ok,
    durationMs: Date.now() - startedAt,
    canceled: result.body?.canceled ?? 0
  };
}

async function capture({ userId, content, speechSessionId, chaos, label }) {
  const startedAt = Date.now();
  const result = await fetchJson(`${BASE_URL}/capture`, {
    method: "POST",
    headers: {
      ...headers(userId, chaos),
      "x-aura-speech-session-id": speechSessionId
    },
    body: JSON.stringify({
      content,
      inputMode: "text",
      timezone: TIMEZONE
    })
  });
  return {
    kind: "capture",
    label,
    userId,
    status: result.status,
    ok: result.ok,
    durationMs: Date.now() - startedAt,
    provider: result.body?.voice?.provider ?? null,
    hasVoice: Boolean(result.body?.voice?.audioBase64),
    reply: result.body?.reply ?? "",
    body: result.body
  };
}

async function sampleLoop(samples, stop) {
  while (!stop.done) {
    const [voiceMetrics, resources, pocketCount, temp] = await Promise.all([
      metrics(),
      backendResourceSample(),
      pocketProcessCount(),
      pocketTempStats()
    ]);
    samples.push({
      at: Date.now(),
      voiceMetrics,
      resources,
      pocketProcessCount: pocketCount,
      temp
    });
    await sleep(SAMPLE_MS);
  }
}

async function userStorm(index) {
  const userNumber = index + 1;
  const userId = `aura-beta-interrupt-storm-user-${userNumber}-${RUN_ID}`;
  const sessionId = `storm-session-${userNumber}-${RUN_ID}`;
  const baseDelay = index * 260 + jitter(0, 350);
  await sleep(baseDelay);

  const events = [];
  const longText = `This is a deliberately long AURA conversational reply for interrupt storm user ${userNumber}. Speak calmly about staying grounded while the user interrupts repeatedly. This should be cancellable and must never become stale audio.`;
  const interruptText = `Stop that previous thought for user ${userNumber}. This is the newer speech and should replace the old one.`;
  const reminderText = `Hey Rihan, time to drink water for interrupt storm user ${userNumber}.`;

  const delayed = async (delayMs, fn) => {
    await sleep(delayMs);
    const event = await fn();
    events.push(event);
    return event;
  };

  const tasks = [];

  tasks.push(delayed(0, () => synthesize({
    userId,
    text: longText,
    priority: "reply",
    speechSessionId: sessionId,
    interruptPrevious: true,
    staleAfterMs: 6000,
    chaos: userNumber % 3 === 0 ? "gemini-fail,voice-delay=3000" : "gemini-fail",
    label: "initial_reply"
  })));

  tasks.push(delayed(jitter(650, 1300), () => synthesize({
    userId,
    text: interruptText,
    priority: "reply",
    speechSessionId: sessionId,
    interruptPrevious: true,
    staleAfterMs: 6000,
    chaos: userNumber % 4 === 0 ? "gemini-fail,pocket-fail" : "gemini-fail",
    label: "interrupt_reply"
  })));

  if (userNumber % 2 === 0) {
    tasks.push(delayed(jitter(950, 1500), () => cancel({ userId, speechSessionId: sessionId, label: "explicit_cancel" })));
  }

  tasks.push(delayed(jitter(1200, 2200), () => synthesize({
    userId,
    text: reminderText,
    priority: "reminder",
    speechSessionId: `${sessionId}-reminder`,
    interruptPrevious: false,
    staleAfterMs: 30000,
    chaos: userNumber % 5 === 0 ? "gemini-fail,voice-delay=2000" : "gemini-fail",
    label: "overlap_reminder"
  })));

  if (userNumber <= 3) {
    tasks.push(delayed(jitter(1700, 2600), () => capture({
      userId,
      speechSessionId: sessionId,
      content: `Interrupt storm capture for user ${userNumber}. Reply shortly and do not let old speech continue.`,
      chaos: "gemini-fail",
      label: "capture_reply_path"
    })));
  }

  await Promise.all(tasks);
  return events;
}

function summarize(samples, events, before, after) {
  const failures = [];
  const httpFailures = events.filter((event) => !event.ok);
  if (httpFailures.length) failures.push(`${httpFailures.length} HTTP failures`);

  const hardTimeouts = events.filter((event) => event.durationMs > REQUEST_TIMEOUT_MS);
  if (hardTimeouts.length) failures.push(`${hardTimeouts.length} requests crossed hard timeout`);

  const lastMetrics = after.voiceMetrics;
  const current = lastMetrics?.current ?? {};
  const totals = lastMetrics?.totals ?? {};
  if ((current.activeJobs ?? 0) !== 0) failures.push(`active voice jobs still running: ${current.activeJobs}`);
  if ((current.queueDepth ?? 0) !== 0) failures.push(`voice queue not empty: ${current.queueDepth}`);
  if (after.pocketProcessCount > before.pocketProcessCount) failures.push(`possible zombie Pocket processes: before ${before.pocketProcessCount}, after ${after.pocketProcessCount}`);
  if (after.temp.count > before.temp.count + 1) failures.push(`Pocket temp dir buildup: before ${before.temp.count}, after ${after.temp.count}`);

  const rssValues = samples.map((sample) => sample.resources.rssKb).filter(Boolean);
  const rssStart = before.resources.rssKb;
  const rssEnd = after.resources.rssKb;
  const rssMax = Math.max(0, ...rssValues);
  if (rssStart && rssEnd && rssEnd - rssStart > 250_000) failures.push(`RSS grew more than 250MB: +${rssEnd - rssStart}KB`);

  const maxQueueDepthObserved = Math.max(0, ...samples.map((sample) => sample.voiceMetrics?.current?.queueDepth ?? 0));
  const maxActiveObserved = Math.max(0, ...samples.map((sample) => sample.voiceMetrics?.current?.activeJobs ?? 0));
  const maxPocketProcesses = Math.max(0, ...samples.map((sample) => sample.pocketProcessCount ?? 0));
  const reminderEvents = events.filter((event) => event.label === "overlap_reminder");
  const slowReminders = reminderEvents.filter((event) => event.durationMs > 20_000);
  if (slowReminders.length) failures.push(`${slowReminders.length} reminders were delayed over 20s`);

  return {
    runId: RUN_ID,
    baseUrl: BASE_URL,
    generatedAt: new Date().toISOString(),
    totalEvents: events.length,
    passed: failures.length === 0,
    failures,
    httpFailures: httpFailures.length,
    avgLatencyMs: Math.round(events.reduce((sum, event) => sum + event.durationMs, 0) / Math.max(1, events.length)),
    maxLatencyMs: Math.max(0, ...events.map((event) => event.durationMs)),
    providerSplit: events.reduce((acc, event) => {
      const key = event.provider ?? "none";
      acc[key] = (acc[key] ?? 0) + 1;
      return acc;
    }, {}),
    nullVoiceCount: events.filter((event) => event.kind !== "cancel" && !event.hasVoice).length,
    cancelEvents: events.filter((event) => event.kind === "cancel").length,
    cancelCount: events.reduce((sum, event) => sum + (event.canceled ?? 0), 0),
    reminderEvents: reminderEvents.length,
    reminderVoiceCount: reminderEvents.filter((event) => event.hasVoice).length,
    slowReminders: slowReminders.length,
    maxQueueDepthObserved,
    maxActiveObserved,
    maxPocketProcesses,
    rssStartKb: rssStart,
    rssEndKb: rssEnd,
    rssMaxKb: rssMax,
    tempBefore: before.temp,
    tempAfter: after.temp,
    beforeMetrics: before.voiceMetrics,
    afterMetrics: after.voiceMetrics,
    totals
  };
}

function markdown(summary, events) {
  const slow = [...events].sort((a, b) => b.durationMs - a.durationMs).slice(0, 12);
  return [
    "# AURA TTS Interrupt Storm Beta",
    "",
    `Run: \`${summary.runId}\``,
    `Base URL: \`${summary.baseUrl}\``,
    "",
    "## Score",
    `- Passed: ${summary.passed ? "yes" : "no"}`,
    `- Failures: ${summary.failures.length ? summary.failures.join("; ") : "none"}`,
    `- Events: ${summary.totalEvents}`,
    `- Avg latency: ${summary.avgLatencyMs} ms`,
    `- Max latency: ${summary.maxLatencyMs} ms`,
    `- HTTP failures: ${summary.httpFailures}`,
    `- Provider split: ${JSON.stringify(summary.providerSplit)}`,
    `- Null voice / app fallback count: ${summary.nullVoiceCount}`,
    `- Cancel endpoint events: ${summary.cancelEvents}`,
    `- Jobs canceled by backend: ${summary.cancelCount}`,
    `- Reminder voice: ${summary.reminderVoiceCount}/${summary.reminderEvents}`,
    "",
    "## Queue And Process Health",
    `- Max queue depth observed: ${summary.maxQueueDepthObserved}`,
    `- Max active jobs observed: ${summary.maxActiveObserved}`,
    `- Max Pocket/uvx/python process count: ${summary.maxPocketProcesses}`,
    `- RSS start/end/max: ${summary.rssStartKb}KB / ${summary.rssEndKb}KB / ${summary.rssMaxKb}KB`,
    `- Temp dirs before/after: ${summary.tempBefore.count} / ${summary.tempAfter.count}`,
    `- Orchestrator totals: ${JSON.stringify(summary.afterMetrics?.totals ?? {})}`,
    "",
    "## Top Slow Events",
    ...slow.map((event) => `- ${event.userId} ${event.label}: ${event.durationMs}ms, kind=${event.kind}, priority=${event.priority ?? "n/a"}, provider=${event.provider ?? "none"}, voice=${event.hasVoice ? "yes" : "no"}, canceled=${event.canceled ?? 0}`),
    "",
    "## Interpretation",
    "- `voice: none` is acceptable for interrupted or overloaded reply speech because the mobile app should use the loud iOS fallback.",
    "- Reminder voice should either return backend audio or fail quickly enough for app fallback; it should not sit behind stale reply speech.",
    "- Any active job, queue, process, or temp-dir growth after the settle window is a real lifecycle bug."
  ].join("\n") + "\n";
}

async function main() {
  await fs.mkdir(OUT_DIR, { recursive: true });
  const health = await fetchJson(`${BASE_URL}/health`);
  if (!health.ok) throw new Error(`Backend health failed at ${BASE_URL}/health`);

  const before = {
    voiceMetrics: await metrics(),
    resources: await backendResourceSample(),
    pocketProcessCount: await pocketProcessCount(),
    temp: await pocketTempStats()
  };

  const samples = [];
  const stop = { done: false };
  const sampler = sampleLoop(samples, stop);
  const nestedEvents = await Promise.all(Array.from({ length: USER_COUNT }, (_, index) => userStorm(index)));
  await sleep(4000);
  stop.done = true;
  await sampler;

  const after = {
    voiceMetrics: await metrics(),
    resources: await backendResourceSample(),
    pocketProcessCount: await pocketProcessCount(),
    temp: await pocketTempStats()
  };
  const events = nestedEvents.flat();
  const summary = summarize(samples, events, before, after);

  await fs.writeFile(path.join(OUT_DIR, "report.json"), JSON.stringify({ summary, events, samples }, null, 2));
  await fs.writeFile(path.join(OUT_DIR, "summary.md"), markdown(summary, events));

  console.log(`[AURA interrupt storm] passed=${summary.passed} avg=${summary.avgLatencyMs}ms max=${summary.maxLatencyMs}ms`);
  console.log(`[AURA interrupt storm] failures=${summary.failures.join("; ") || "none"}`);
  console.log(`[AURA interrupt storm] report=${path.join(OUT_DIR, "report.json")}`);
  console.log(`[AURA interrupt storm] summary=${path.join(OUT_DIR, "summary.md")}`);
  if (!summary.passed) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
