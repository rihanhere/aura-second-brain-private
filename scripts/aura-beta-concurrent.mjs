#!/usr/bin/env node
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const BASE_URL = process.env.AURA_API_BASE_URL ?? "http://127.0.0.1:4000";
const OUT_DIR = process.env.AURA_CONCURRENT_OUT_DIR ?? "/tmp/aura-beta-concurrent";
const AUDIO_DIR = path.join(OUT_DIR, "audio");
const RUN_ID = process.env.AURA_CONCURRENT_RUN_ID ?? String(Date.now());
const USER_COUNT = Number(process.env.AURA_CONCURRENT_USERS ?? 10);
const TIMEZONE = process.env.AURA_CONCURRENT_TIMEZONE ?? "Asia/Kolkata";
const REQUEST_TIMEOUT_MS = Number(process.env.AURA_CONCURRENT_TIMEOUT_MS ?? 60_000);
const MESSAGE_GAP_MIN_MS = Number(process.env.AURA_CONCURRENT_GAP_MIN_MS ?? 260);
const MESSAGE_GAP_MAX_MS = Number(process.env.AURA_CONCURRENT_GAP_MAX_MS ?? 900);
const REQUIRE_BACKEND_VOICE = process.env.AURA_CONCURRENT_REQUIRE_BACKEND_VOICE === "1";

const markerSeeds = [
  "swift lotus alpha",
  "trading moon beta",
  "fitness river gamma",
  "design sun delta",
  "memory star echo",
  "voice cloud nova",
  "backend rose orbit",
  "journal ocean prism",
  "habit stone ember",
  "focus silver pulse"
];

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
    return { status: res.status, ok: res.ok, body };
  } finally {
    clearTimeout(timeout);
  }
}

async function generateVoice(text, fileStem) {
  const out = path.join(AUDIO_DIR, `${fileStem}.wav`);
  await execFileAsync("say", ["-v", "Samantha", "-o", out, "--data-format=LEI16@16000", text], {
    timeout: 25_000,
    maxBuffer: 1024 * 1024
  });
  return out;
}

async function transcribeVoice({ userId, filePath, chaos }) {
  const bytes = await fs.readFile(filePath);
  const form = new FormData();
  form.append("audio", new Blob([bytes], { type: "audio/wav" }), path.basename(filePath));

  const headers = { "x-user-id": userId };
  if (chaos) headers["x-aura-chaos"] = chaos;

  const startedAt = Date.now();
  const result = await fetchJson(`${BASE_URL}/voice/transcribe`, {
    method: "POST",
    headers,
    body: form
  });

  return {
    ...result,
    durationMs: Date.now() - startedAt,
    transcript: result.body?.transcript ?? ""
  };
}

async function capture({ userId, content, inputMode, chaos, testCreatedAt }) {
  const headers = {
    "content-type": "application/json",
    "x-user-id": userId,
    "x-aura-test-created-at": testCreatedAt
  };
  if (chaos) headers["x-aura-chaos"] = chaos;

  const startedAt = Date.now();
  const result = await fetchJson(`${BASE_URL}/capture`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      content,
      inputMode,
      timezone: TIMEZONE
    })
  });

  return {
    ...result,
    durationMs: Date.now() - startedAt
  };
}

function hasBrainQuiet(reply) {
  return /AI connection is quiet|trouble reaching AURA|trouble reaching Aura|couldn.?t connect|unable to reach/i.test(reply ?? "");
}

function hasTimestampDump(reply) {
  return /\b20\d{2}-\d{2}-\d{2}\s+\d{2}:\d{2}\b/.test(reply ?? "") || /^From (today|yesterday|this week|the last)/i.test(reply ?? "");
}

function serializableReminderDraft(reminderDraft) {
  if (!reminderDraft) return "";
  return JSON.stringify(reminderDraft);
}

function includesAny(text, needles) {
  return needles.filter((needle) => markerAppears(text, needle));
}

function markerKey(text) {
  return String(text ?? "")
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]+/g, "");
}

function markerAppears(text, marker) {
  return markerKey(text).includes(markerKey(marker));
}

function makeUsers() {
  return Array.from({ length: USER_COUNT }, (_, index) => {
    const userNumber = index + 1;
    const marker = markerSeeds[index % markerSeeds.length];
    const userId = `aura-beta-concurrent-user-${userNumber}-${RUN_ID}`;
    return {
      userNumber,
      userId,
      marker,
      relationship: userNumber % 2 === 0 ? "girlfriend" : "dad",
      reminderKind: userNumber % 2 === 0 ? "check-in" : "reminder",
      startDelayMs: index * 700 + jitter(0, 450)
    };
  });
}

function flowForUser(user) {
  const base = Date.now() - 3 * 24 * 60 * 60 * 1000 + user.userNumber * 60_000;
  const isoAt = (offsetMinutes) => new Date(base + offsetMinutes * 60_000).toISOString();
  const reminderText = user.reminderKind === "check-in"
    ? `Ask me in two minutes if I still care about ${user.marker}.`
    : `Remind me after two minutes to check ${user.marker}.`;

  return [
    {
      id: "normal",
      mode: user.userNumber % 2 === 0 ? "voice" : "text",
      text: `Good morning Aura. I am test user ${user.userNumber}. My private marker is ${user.marker}.`,
      at: isoAt(0),
      expect: { voice: user.userNumber % 2 === 0, noBrainQuiet: true }
    },
    {
      id: "emotional",
      mode: user.userNumber % 3 === 0 ? "voice" : "text",
      text: `I feel tired and stressed today because the ${user.marker} thing is weighing on me. Reply normally, no memory logs.`,
      at: isoAt(4),
      chaos: user.userNumber % 4 === 0 ? "memory-delay=1200,gemini-fail" : user.userNumber === 7 ? "gemini-fail,pocket-fail" : undefined,
      expect: { noTimestampSpam: true, noBrainQuiet: true, voice: user.userNumber % 3 === 0, allowNoVoice: user.userNumber === 7 }
    },
    {
      id: "explicit_save",
      mode: "text",
      text: `Save this, ${user.marker} is my private goal marker and nobody else should ever see it.`,
      at: isoAt(8),
      chaos: user.userNumber % 5 === 0 ? "gemini-fail" : undefined,
      expect: { explicitSaveAck: true, ownMarker: false, noBrainQuiet: true }
    },
    {
      id: "reminder",
      mode: user.userNumber % 2 === 1 ? "voice" : "text",
      text: reminderText,
      at: isoAt(12),
      chaos: user.userNumber % 3 === 0 ? "gemini-fail" : undefined,
      expect: {
        reminder: true,
        checkIn: user.reminderKind === "check-in",
        ownMarkerInDraft: true,
        noBrainQuiet: true,
        voice: user.userNumber % 2 === 1
      }
    },
    {
      id: "recall",
      mode: "text",
      text: "What did I explicitly ask you to save?",
      at: isoAt(16),
      chaos: user.userNumber % 6 === 0 ? "memory-delay=1000" : undefined,
      expect: { recallOwnMarker: true, noBrainQuiet: true }
    }
  ];
}

function evaluate({ user, step, prompt, transcript, transcribeResult, captureResult, forbiddenMarkers }) {
  const misses = [];
  const warnings = [];
  const body = captureResult?.body ?? {};
  const reply = String(body.reply ?? "");
  const reminderDraftText = serializableReminderDraft(body.reminderDraft);
  const searchable = `${reply}\n${reminderDraftText}`;
  const expected = step.expect ?? {};
  const voice = body.voice ?? null;
  const voiceProvider = voice?.provider ?? null;
  const isIntentionalPocketFailure = step.chaos?.includes("pocket-fail");

  const leakedMarkers = includesAny(searchable, forbiddenMarkers);
  if (leakedMarkers.length) {
    misses.push(`CRITICAL cross-user memory leak: ${leakedMarkers.join(", ")}`);
  }

  if (step.mode === "voice" && !String(transcript ?? "").trim()) {
    misses.push("STT transcript empty");
  }
  if (transcribeResult && !transcribeResult.ok) {
    misses.push(`transcribe HTTP ${transcribeResult.status}`);
  }
  if (captureResult && !captureResult.ok) {
    misses.push(`capture HTTP ${captureResult.status}`);
  }
  if (!reply.trim()) {
    misses.push("empty reply");
  }
  if (expected.noBrainQuiet && hasBrainQuiet(reply)) {
    misses.push("unexpected brain quiet fallback");
  }
  if (expected.noTimestampSpam && hasTimestampDump(reply)) {
    misses.push("companion mode dumped timestamps");
  }
  if (expected.explicitSaveAck && !/saved this moment|saved|remember/i.test(reply)) {
    misses.push("explicit save was not acknowledged");
  }
  if (!expected.explicitSaveAck && /\bI (saved|remembered) this moment\b/i.test(reply)) {
    misses.push("normal chat said saved");
  }
  if (expected.reminder && !body.reminderDraft) {
    misses.push("reminder intent did not create reminder draft");
  }
  if (expected.checkIn && body.reminderDraft?.type !== "check_in") {
    misses.push("check-in intent did not create check_in reminder");
  }
  if (expected.ownMarkerInDraft && !markerAppears(reminderDraftText, user.marker)) {
    misses.push("reminder draft does not contain own marker");
  }
  if (expected.recallOwnMarker && !markerAppears(reply, user.marker)) {
    misses.push("recall did not include own private marker");
  }
  if (expected.voice && !voice?.audioBase64 && !expected.allowNoVoice && !isIntentionalPocketFailure) {
    const message = "backend voice unavailable; app fallback needed";
    if (REQUIRE_BACKEND_VOICE) misses.push(message);
    else warnings.push(message);
  }
  if ((captureResult?.durationMs ?? 0) > 25_000) {
    misses.push("capture over 25s timeout risk");
  }
  if ((captureResult?.durationMs ?? 0) > 45_000) {
    misses.push("capture over 45s hard limit");
  }

  return {
    misses,
    warnings,
    leakedMarkers,
    voiceProvider
  };
}

async function runStep({ user, step, forbiddenMarkers }) {
  const startedAt = Date.now();
  let transcript = step.text;
  let transcribeResult = null;
  let captureResult = null;
  let audioPath = null;

  try {
    if (step.mode === "voice") {
      audioPath = await generateVoice(step.text, `${user.userNumber}-${step.id}-${RUN_ID}`);
      transcribeResult = await transcribeVoice({
        userId: user.userId,
        filePath: audioPath,
        chaos: step.chaos
      });
      transcript = transcribeResult.transcript;
    }

    captureResult = await capture({
      userId: user.userId,
      content: transcript || step.text,
      inputMode: step.mode === "voice" ? "voice" : "text",
      chaos: step.chaos,
      testCreatedAt: step.at
    });

    const evaluated = evaluate({
      user,
      step,
      prompt: step.text,
      transcript,
      transcribeResult,
      captureResult,
      forbiddenMarkers
    });

    return {
      userId: user.userId,
      userNumber: user.userNumber,
      marker: user.marker,
      stepId: step.id,
      mode: step.mode,
      prompt: step.text,
      transcript,
      chaos: step.chaos ?? null,
      transcribeMs: transcribeResult?.durationMs ?? 0,
      captureMs: captureResult.durationMs,
      totalMs: Date.now() - startedAt,
      status: captureResult.status,
      reply: captureResult.body?.reply ?? "",
      reminderDraft: captureResult.body?.reminderDraft ?? null,
      reminder: captureResult.body?.reminder ?? null,
      archive: captureResult.body?.archive ?? null,
      voiceProvider: evaluated.voiceProvider,
      voiceBytesBase64: captureResult.body?.voice?.audioBase64?.length ?? 0,
      leakedMarkers: evaluated.leakedMarkers,
      warnings: evaluated.warnings,
      misses: evaluated.misses
    };
  } catch (error) {
    return {
      userId: user.userId,
      userNumber: user.userNumber,
      marker: user.marker,
      stepId: step.id,
      mode: step.mode,
      prompt: step.text,
      transcript,
      chaos: step.chaos ?? null,
      transcribeMs: transcribeResult?.durationMs ?? 0,
      captureMs: captureResult?.durationMs ?? 0,
      totalMs: Date.now() - startedAt,
      status: captureResult?.status ?? 0,
      reply: captureResult?.body?.reply ?? "",
      reminderDraft: captureResult?.body?.reminderDraft ?? null,
      reminder: captureResult?.body?.reminder ?? null,
      archive: captureResult?.body?.archive ?? null,
      voiceProvider: captureResult?.body?.voice?.provider ?? null,
      voiceBytesBase64: captureResult?.body?.voice?.audioBase64?.length ?? 0,
      leakedMarkers: [],
      warnings: [],
      misses: [`exception: ${error instanceof Error ? error.message : String(error)}`]
    };
  }
}

async function runUser(user, allMarkers) {
  await sleep(user.startDelayMs);
  const forbiddenMarkers = allMarkers.filter((marker) => marker !== user.marker);
  const steps = flowForUser(user);
  const results = [];

  for (const step of steps) {
    const result = await runStep({ user, step, forbiddenMarkers });
    results.push(result);
    console.log(`${result.misses.length ? "FAIL" : "PASS"} user-${user.userNumber} ${step.id} ${result.totalMs}ms voice=${result.voiceProvider ?? "none"} warnings=${result.warnings?.length ?? 0}`);
    await sleep(jitter(MESSAGE_GAP_MIN_MS, MESSAGE_GAP_MAX_MS));
  }

  return results;
}

function summarize(results, users) {
  const failed = results.filter((item) => item.misses.length);
  const latencies = results.map((item) => item.totalMs).filter(Boolean);
  const avg = Math.round(latencies.reduce((sum, value) => sum + value, 0) / Math.max(1, latencies.length));
  const max = Math.max(0, ...latencies);
  const voiceProviders = results.reduce((acc, item) => {
    const key = item.voiceProvider ?? "none";
    acc[key] = (acc[key] ?? 0) + 1;
    return acc;
  }, {});
  const byUser = users.map((user) => {
    const items = results.filter((item) => item.userId === user.userId);
    const userLatencies = items.map((item) => item.totalMs).filter(Boolean);
    return {
      userNumber: user.userNumber,
      userId: user.userId,
      marker: user.marker,
      passed: items.filter((item) => !item.misses.length).length,
      failed: items.filter((item) => item.misses.length).length,
      avgMs: Math.round(userLatencies.reduce((sum, value) => sum + value, 0) / Math.max(1, userLatencies.length)),
      maxMs: Math.max(0, ...userLatencies),
      failures: items.filter((item) => item.misses.length).map((item) => ({ stepId: item.stepId, misses: item.misses }))
    };
  });
  const reminderCases = results.filter((item) => item.stepId === "reminder");
  const recallCases = results.filter((item) => item.stepId === "recall");
  const emotionalCases = results.filter((item) => item.stepId === "emotional");
  const crossUserLeaks = results.filter((item) => item.leakedMarkers.length || item.misses.some((miss) => miss.includes("cross-user")));
  const brainQuietCount = results.filter((item) => hasBrainQuiet(item.reply)).length;
  const warningCount = results.reduce((sum, item) => sum + (item.warnings?.length ?? 0), 0);
  const backendVoiceUnavailable = results.filter((item) => item.warnings?.some((warning) => warning.includes("backend voice unavailable"))).length;

  return {
    runId: RUN_ID,
    baseUrl: BASE_URL,
    generatedAt: new Date().toISOString(),
    totalUsers: users.length,
    totalMessages: results.length,
    passed: results.length - failed.length,
    failed: failed.length,
    score: `${results.length - failed.length}/${results.length}`,
    avgTotalMs: avg,
    maxTotalMs: max,
    over25s: results.filter((item) => item.totalMs > 25_000).length,
    over45s: results.filter((item) => item.totalMs > 45_000).length,
    httpFailures: results.filter((item) => item.status >= 400 || item.status === 0).length,
    voiceProviders,
    warnings: warningCount,
    backendVoiceUnavailable,
    voiceFailures: results.filter((item) => item.misses.some((miss) => miss.includes("backend voice unavailable"))).length,
    reminderQuality: `${reminderCases.filter((item) => !item.misses.some((miss) => /reminder|check-in/i.test(miss))).length}/${reminderCases.length}`,
    recallQuality: `${recallCases.filter((item) => !item.misses.some((miss) => /recall|marker|cross-user/i.test(miss))).length}/${recallCases.length}`,
    emotionalQuality: `${emotionalCases.filter((item) => !item.misses.some((miss) => /timestamp|brain quiet|saved/i.test(miss))).length}/${emotionalCases.length}`,
    brainQuietCount,
    crossUserLeaks: crossUserLeaks.map((item) => ({
      userNumber: item.userNumber,
      stepId: item.stepId,
      leakedMarkers: item.leakedMarkers,
      misses: item.misses
    })),
    byUser,
    failures: failed
  };
}

function markdownReport(summary, results) {
  const topSlow = [...results].sort((a, b) => b.totalMs - a.totalMs).slice(0, 12);
  const lines = [
    "# AURA 10-User / 50-Message Concurrency Beta",
    "",
    `Run: \`${summary.runId}\``,
    `Base URL: \`${summary.baseUrl}\``,
    "",
    "## Score",
    `- Passed: ${summary.passed}/${summary.totalMessages}`,
    `- Failed: ${summary.failed}/${summary.totalMessages}`,
    `- Users: ${summary.totalUsers}`,
    `- Avg total latency: ${summary.avgTotalMs} ms`,
    `- Max total latency: ${summary.maxTotalMs} ms`,
    `- Over 25s timeout risk: ${summary.over25s}`,
    `- Over 45s hard limit: ${summary.over45s}`,
    `- HTTP failures: ${summary.httpFailures}`,
    `- Brain quiet count: ${summary.brainQuietCount}`,
    `- Backend voice unavailable warnings: ${summary.backendVoiceUnavailable}`,
    `- Strict backend voice failures: ${summary.voiceFailures}`,
    `- Voice providers: ${JSON.stringify(summary.voiceProviders)}`,
    `- Reminder quality: ${summary.reminderQuality}`,
    `- Recall quality: ${summary.recallQuality}`,
    `- Emotional continuity quality: ${summary.emotionalQuality}`,
    "",
    "## Cross-User Memory Leakage"
  ];

  if (!summary.crossUserLeaks.length) {
    lines.push("- None detected. No fake user's private marker appeared in another fake user's response or reminder draft.");
  } else {
    for (const leak of summary.crossUserLeaks) {
      lines.push(`- CRITICAL user-${leak.userNumber} ${leak.stepId}: ${leak.misses.join("; ")}`);
    }
  }

  lines.push(
    "",
    "## Per-User Results",
    "| User | Marker | Passed | Failed | Avg ms | Max ms |",
    "| --- | --- | ---: | ---: | ---: | ---: |"
  );
  for (const user of summary.byUser) {
    lines.push(`| ${user.userNumber} | \`${user.marker}\` | ${user.passed} | ${user.failed} | ${user.avgMs} | ${user.maxMs} |`);
  }

  lines.push("", "## Top Slow Requests");
  for (const item of topSlow) {
    lines.push(`- user-${item.userNumber} ${item.stepId}: ${item.totalMs}ms (STT ${item.transcribeMs}ms, capture ${item.captureMs}ms), voice ${item.voiceProvider ?? "none"}, misses ${item.misses.join("; ") || "none"}`);
  }

  lines.push("", "## Failures");
  if (!summary.failures.length) {
    lines.push("- None. This run passed all automated concurrency checks.");
  } else {
    for (const item of summary.failures) {
      lines.push(
        "",
        `### user-${item.userNumber} ${item.stepId}`,
        `- Marker: \`${item.marker}\``,
        `- Misses: ${item.misses.join("; ")}`,
        `- Warnings: ${(item.warnings ?? []).join("; ") || "none"}`,
        `- Total: ${item.totalMs}ms`,
        `- Chaos: ${item.chaos ?? "none"}`,
        `- Prompt: ${item.prompt}`,
        `- Transcript: ${item.transcript}`,
        `- Reply: ${String(item.reply).slice(0, 900)}`,
        `- Reminder draft: ${serializableReminderDraft(item.reminderDraft).slice(0, 700) || "none"}`
      );
    }
  }

  lines.push(
    "",
    "## Recommended Fixes",
    "- If any cross-user leak appears, stop production work and inspect user_id filtering in archive, memories, reminders, and emotional continuity.",
    "- If reminder quality drops, inspect reminder parser and saveReminderDraft under concurrent local-file writes.",
    "- If recall misses own markers, inspect explicit-save archive retrieval and local JSON write ordering.",
    "- If many requests cross 25s, reduce voice wait time further or return text before voice finishes in the mobile app.",
    "- If Pocket TTS dominates latency under load, add a backend voice queue/cache before higher-user beta."
  );

  return `${lines.join("\n")}\n`;
}

async function main() {
  await fs.mkdir(AUDIO_DIR, { recursive: true });
  const health = await fetchJson(`${BASE_URL}/health`);
  if (!health.ok) {
    throw new Error(`Backend health failed at ${BASE_URL}/health (${health.status})`);
  }

  const users = makeUsers();
  const markers = users.map((user) => user.marker);

  console.log(`[AURA beta concurrent] run=${RUN_ID}`);
  console.log(`[AURA beta concurrent] base=${BASE_URL}`);
  console.log(`[AURA beta concurrent] users=${users.length}, messages=${users.length * 5}`);

  const nestedResults = await Promise.all(users.map((user) => runUser(user, markers)));
  const results = nestedResults.flat().sort((a, b) => a.userNumber - b.userNumber || a.stepId.localeCompare(b.stepId));
  const summary = summarize(results, users);
  const report = { summary, results };

  await fs.writeFile(path.join(OUT_DIR, "report.json"), JSON.stringify(report, null, 2));
  await fs.writeFile(path.join(OUT_DIR, "summary.md"), markdownReport(summary, results));

  console.log(`[AURA beta concurrent] score=${summary.score} avg=${summary.avgTotalMs}ms max=${summary.maxTotalMs}ms`);
  console.log(`[AURA beta concurrent] cross-user-leaks=${summary.crossUserLeaks.length}`);
  console.log(`[AURA beta concurrent] report=${path.join(OUT_DIR, "report.json")}`);
  console.log(`[AURA beta concurrent] summary=${path.join(OUT_DIR, "summary.md")}`);

  if (summary.failed) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
