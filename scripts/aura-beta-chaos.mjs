#!/usr/bin/env node
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(new URL("..", import.meta.url).pathname);
const BASE_URL = process.env.AURA_API_BASE_URL ?? "http://127.0.0.1:4000";
const OUT_DIR = process.env.AURA_BETA_OUT_DIR ?? "/tmp/aura-beta-chaos";
const AUDIO_DIR = path.join(OUT_DIR, "audio");
const USER_ID = process.env.AURA_BETA_USER_ID ?? `aura-beta-chaos-${Date.now()}`;
const TIMEZONE = process.env.AURA_BETA_TIMEZONE ?? "Asia/Kolkata";
const API_DATA_DIR = path.join(ROOT, "apps/api/data");
const REQUEST_TIMEOUT_MS = 45_000;

const dataFiles = {
  archive: path.join(API_DATA_DIR, "conversation-archive.json"),
  memories: path.join(API_DATA_DIR, "local-memories.json"),
  signals: path.join(API_DATA_DIR, "emotional-signals.json")
};

const now = new Date();
const day = 24 * 60 * 60 * 1000;
const at = (daysAgo, hour, minute) => {
  const d = new Date(now.getTime() - daysAgo * day);
  d.setHours(hour, minute, 0, 0);
  return d.toISOString();
};

const cases = [
  { id: "morning_hello", phase: "Daily morning", mode: "voice", text: "Good morning Aura.", at: at(6, 8, 0), expect: { voice: true } },
  { id: "sleep_late", phase: "Daily morning", mode: "voice", text: "I slept late again and I feel tired today.", at: at(6, 8, 4), expect: { noTimestampSpam: true, voice: true } },
  { id: "water_reminder", phase: "Daily morning", mode: "voice", text: "Remind me to drink water after two minutes.", at: at(6, 8, 8), expect: { reminder: true, voice: true } },
  { id: "swift_goal", phase: "Foundation memory", mode: "voice", text: "My goal this month is to learn Swift and ship Aura properly.", at: at(6, 9, 0), expect: { voice: true } },
  { id: "girlfriend_birthday", phase: "Foundation memory", mode: "voice", text: "Remember that my girlfriend birthday is on October 1st and it is very important to me.", at: at(6, 9, 5), expect: { explicitSaveAck: true, voice: true } },
  { id: "work_stress", phase: "Foundation memory", mode: "voice", text: "I am stressed about work because I am trying to do too many things at once.", at: at(6, 9, 12), expect: { noTimestampSpam: true, voice: true } },
  { id: "afternoon_interrupt_one", phase: "Human chaos", mode: "text", text: "Wait wait stop, leave that thought.", at: at(4, 14, 0), expect: { noTimestampSpam: true } },
  { id: "afternoon_interrupt_two", phase: "Human chaos", mode: "text", text: "Actually you know what I mean, right?", at: at(4, 14, 0), expect: { noTimestampSpam: true } },
  { id: "messy_hinglish", phase: "Human chaos", mode: "voice", text: "Aura, mujhe normal Hinglish mein reply karo, aaj mood thoda off hai.", at: at(4, 14, 8), expect: { noTimestampSpam: true, voice: true } },
  { id: "vague_emotion", phase: "Emotional realism", mode: "voice", text: "Today felt weird. I do not know why I am irritated.", at: at(4, 20, 30), expect: { noTimestampSpam: true, voice: true } },
  { id: "normal_talk", phase: "Emotional realism", mode: "voice", text: "I am tired again today, just talk to me normally.", at: at(3, 22, 0), expect: { noTimestampSpam: true, voice: true } },
  { id: "topic_switch", phase: "Human chaos", mode: "text", text: "Bro leave the emotional thing, what can you do if I keep using you every day?", at: at(3, 22, 6), expect: { voice: true } },
  { id: "explicit_save_1", phase: "Explicit saves", mode: "voice", text: "Save this, I want Aura memory to feel mind blowing after one year.", at: at(1, 10, 0), expect: { explicitSaveAck: true, voice: true } },
  { id: "explicit_save_2", phase: "Explicit saves", mode: "voice", text: "Remember this, I want to wake up earlier this week.", at: at(1, 10, 4), expect: { explicitSaveAck: true, voice: true } },
  { id: "call_girlfriend", phase: "Reminder reality", mode: "voice", text: "Remind me tomorrow to call my girlfriend.", at: at(1, 10, 8), expect: { reminder: true, voice: true } },
  { id: "october_birthday_reminder", phase: "Reminder reality", mode: "voice", text: "Remind me on October 1st that it is my girlfriend birthday.", at: at(1, 10, 12), expect: { reminder: true, voice: true } },
  { id: "weed_checkin", phase: "Check-in", mode: "voice", text: "Ask me in one minute if I am still smoking weed.", at: at(1, 10, 16), expect: { reminder: true, checkIn: true, voice: true } },
  { id: "checkin_yes", phase: "Check-in", mode: "text", text: "Yes I am still smoking.", at: at(1, 10, 18), pendingCheckIn: true, expect: { supportiveCheckIn: true, voice: true } },
  { id: "recall_yesterday", phase: "Exact recall", mode: "voice", text: "What did I say yesterday?", at: at(0, 9, 0), expect: { dateRecall: true, timestamps: true, voice: true } },
  { id: "recall_swift_week", phase: "Exact recall", mode: "voice", text: "What did I say this week about Swift?", at: at(0, 9, 4), expect: { dateRecall: true, voice: true } },
  { id: "recall_girlfriend", phase: "Relationship recall", mode: "voice", text: "What do you remember about my girlfriend?", at: at(0, 9, 8), expect: { girlfriend: true, voice: true } },
  { id: "recall_october", phase: "Reminder recall", mode: "voice", text: "What did I ask you to remind me about October 1st?", at: at(0, 9, 12), expect: { reminderRecall: true, noNewReminder: true, voice: true } },
  { id: "hypothetical_october", phase: "Reminder recall", mode: "text", text: "If today were October 1st, what important thing should you remind me about?", at: at(0, 9, 16), expect: { reminderRecall: true, noNewReminder: true, voice: true } },
  { id: "recall_explicit_saves", phase: "Exact recall", mode: "voice", text: "What did I explicitly ask you to save?", at: at(0, 9, 20), expect: { explicitSaveRecall: true, voice: true } },
  { id: "emotion_pattern", phase: "Emotional continuity", mode: "voice", text: "Have I seemed tired lately?", at: at(0, 9, 24), expect: { noTimestampSpam: true, voice: true } },
  { id: "partial_stt_direct", phase: "Failure flow", mode: "text", text: "bro leave that... wait actually I mean the memory thing", at: at(0, 9, 28), expect: { noTimestampSpam: true, voice: true } },
  { id: "empty_stt", phase: "Failure flow", mode: "voice", text: "This audio should be ignored by simulated empty transcription.", at: at(0, 9, 32), chaos: "stt-empty", expect: { emptyTranscript: true } },
  { id: "memory_delay", phase: "Failure flow", mode: "text", text: "Tell me something calm without dumping my memory.", at: at(0, 9, 36), chaos: "memory-delay=2500,gemini-fail", expect: { noTimestampSpam: true, voice: true, pocket: true } },
  { id: "brain_fail", phase: "Failure flow", mode: "text", text: "Hello Aura, can you still respond gracefully if the brain fails?", at: at(0, 9, 40), chaos: "brain-fail,gemini-fail", expect: { gracefulBrainFailure: true } },
  { id: "pocket_fallback", phase: "Failure flow", mode: "text", text: "Say a short reminder style line with Gemini failing so Pocket TTS should speak.", at: at(0, 9, 44), chaos: "gemini-fail", expect: { voice: true, pocket: true } },
  { id: "all_voice_fail", phase: "Failure flow", mode: "text", text: "If all backend voice fails, still give me text and do not freeze.", at: at(0, 9, 48), chaos: "gemini-fail,pocket-fail", expect: { textOnlyGraceful: true } },
  { id: "rapid_1", phase: "Rapid fire", mode: "text", text: "Rapid one: I am checking if you get stuck.", at: at(0, 9, 52), rapidGroup: "rapid", expect: { noTimestampSpam: true } },
  { id: "rapid_2", phase: "Rapid fire", mode: "text", text: "Rapid two: change topic to fitness.", at: at(0, 9, 52), rapidGroup: "rapid", expect: { noTimestampSpam: true } },
  { id: "rapid_3", phase: "Rapid fire", mode: "text", text: "Rapid three: now remember I care about clean voice flow.", at: at(0, 9, 52), rapidGroup: "rapid", expect: { noTimestampSpam: true } },
  { id: "rapid_4", phase: "Rapid fire", mode: "text", text: "Rapid four: are you listening?", at: at(0, 9, 52), rapidGroup: "rapid", expect: { noTimestampSpam: true } }
];

async function readJsonArray(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch {
    return [];
  }
}

async function writeJsonArray(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(value, null, 2));
}

async function snapshotIds(userId) {
  const result = {};
  for (const [key, file] of Object.entries(dataFiles)) {
    const items = await readJsonArray(file);
    result[key] = new Set(items.filter((item) => item.user_id === userId).map((item) => item.id));
  }
  return result;
}

async function retimeNewRecords(userId, before, iso) {
  for (const [key, file] of Object.entries(dataFiles)) {
    const items = await readJsonArray(file);
    let changed = false;
    for (const item of items) {
      if (item.user_id !== userId || before[key]?.has(item.id)) continue;
      if ("created_at" in item) {
        item.created_at = iso;
        changed = true;
      }
    }
    if (changed) await writeJsonArray(file, items);
  }
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

async function generateVoice(text, id) {
  const out = path.join(AUDIO_DIR, `${id}.wav`);
  await execFileAsync("say", ["-v", "Samantha", "-o", out, "--data-format=LEI16@16000", text], {
    timeout: 20_000,
    maxBuffer: 1024 * 1024
  });
  return out;
}

function headers(extra = {}) {
  return {
    "content-type": "application/json",
    "x-user-id": USER_ID,
    ...extra
  };
}

async function transcribeVoice(filePath, chaos) {
  const bytes = await fs.readFile(filePath);
  const form = new FormData();
  form.append("audio", new Blob([bytes], { type: "audio/wav" }), path.basename(filePath));
  const requestHeaders = { "x-user-id": USER_ID };
  if (chaos) requestHeaders["x-aura-chaos"] = chaos;
  const startedAt = Date.now();
  const result = await fetchJson(`${BASE_URL}/voice/transcribe`, {
    method: "POST",
    headers: requestHeaders,
    body: form
  });
  return { ...result, durationMs: Date.now() - startedAt };
}

async function capture(content, inputMode, chaos, pendingCheckIn, createdAt) {
  const startedAt = Date.now();
  const body = {
    content,
    inputMode,
    timezone: TIMEZONE
  };
  if (pendingCheckIn) {
    body.pendingCheckIn = {
      id: `check-${USER_ID}`,
      title: "Ask if still smoking weed",
      promptQuestion: "Rihan, are you still smoking weed?",
      originalText: "Ask me in one minute if I am still smoking weed.",
      scheduledAt: new Date().toISOString()
    };
  }

  const extra = {};
  if (chaos) extra["x-aura-chaos"] = chaos;
  if (createdAt) extra["x-aura-test-created-at"] = createdAt;
  const result = await fetchJson(`${BASE_URL}/capture`, {
    method: "POST",
    headers: headers(extra),
    body: JSON.stringify(body)
  });
  return { ...result, durationMs: Date.now() - startedAt };
}

function hasBrainQuiet(reply) {
  return /AI connection is quiet|trouble reaching AURA|trouble reaching Aura|couldn.?t connect|unable to reach/i.test(reply ?? "");
}

function hasTimestampDump(reply) {
  return /\b20\d{2}-\d{2}-\d{2}\s+\d{2}:\d{2}\b/.test(reply ?? "") || /^From (today|yesterday|this week|the last)/i.test(reply ?? "");
}

function evaluate(item, transcript, captureResult, transcribeResult) {
  const misses = [];
  const body = captureResult?.body ?? {};
  const reply = String(body.reply ?? "");
  const expect = item.expect ?? {};
  const voiceProvider = body.voice?.provider ?? null;
  const intentionallyBrainFailed = item.chaos?.includes("brain-fail");

  if (item.mode === "voice" && !expect.emptyTranscript && !String(transcript ?? "").trim()) misses.push("STT transcript empty");
  if (expect.emptyTranscript && String(transcript ?? "").trim()) misses.push("simulated empty STT did not return empty transcript");
  if (!expect.emptyTranscript && !reply.trim()) misses.push("empty reply");
  if (!intentionallyBrainFailed && hasBrainQuiet(reply)) misses.push("brain quiet fallback appeared unexpectedly");
  if (expect.gracefulBrainFailure && !hasBrainQuiet(reply)) misses.push("brain failure did not surface graceful fallback");
  if (expect.reminder && !body.reminderDraft) misses.push("reminder intent did not create reminder draft");
  if (expect.checkIn && body.reminderDraft?.type !== "check_in") misses.push("check-in intent did not create check_in reminder");
  if (expect.noNewReminder && body.reminderDraft) misses.push("recall question created a new reminder");
  if (expect.dateRecall && !body.archive?.dateRecall?.isRecall) misses.push("date recall not detected");
  if (expect.timestamps && !hasTimestampDump(reply)) misses.push("exact recall did not surface timestamps");
  if (expect.noTimestampSpam && hasTimestampDump(reply)) misses.push("companion mode dumped timestamps");
  if (expect.explicitSaveAck && !/saved this moment|saved|remember/i.test(reply)) misses.push("explicit save was not acknowledged");
  if (!expect.explicitSaveAck && !expect.explicitSaveRecall && /\bI (saved|remembered) this moment\b/i.test(reply)) misses.push("normal chat said saved");
  if (expect.explicitSaveRecall && !/explicitly asked me to save|Save this|Remember this/i.test(reply)) misses.push("explicit save recall weak");
  if (expect.reminderRecall && !/October 1|girlfriend|birthday/i.test(reply)) misses.push("reminder commitment recall weak");
  if (expect.girlfriend && !/girlfriend|birthday|October 1/i.test(reply)) misses.push("girlfriend continuity weak");
  if (expect.supportiveCheckIn && !/water|urge|still|doing|stop|calm|enjoy/i.test(reply)) misses.push("check-in response not supportive/practical");
  if (expect.voice && !body.voice?.audioBase64) misses.push("no voice audio");
  if (expect.pocket && voiceProvider !== "pocket-tts") misses.push(`expected Pocket TTS, got ${voiceProvider ?? "none"}`);
  if (expect.textOnlyGraceful && !reply.trim()) misses.push("voice failure did not preserve text reply");
  if ((captureResult?.durationMs ?? 0) > 25_000) misses.push("capture over 25s timeout risk");
  if (transcribeResult && !transcribeResult.ok) misses.push(`transcribe HTTP ${transcribeResult.status}`);
  if (captureResult && !captureResult.ok) misses.push(`capture HTTP ${captureResult.status}`);

  return misses;
}

async function runCase(item) {
  const before = await snapshotIds(USER_ID);
  let transcript = item.text;
  let transcribeResult = null;
  let audioPath = null;

  try {
    if (item.mode === "voice") {
      audioPath = await generateVoice(item.text, item.id);
      transcribeResult = await transcribeVoice(audioPath, item.chaos);
      transcript = transcribeResult.body?.transcript ?? "";
      if (item.expect?.emptyTranscript) {
        await retimeNewRecords(USER_ID, before, item.at);
        return {
          id: item.id,
          phase: item.phase,
          prompt: item.text,
          transcript,
          transcribeMs: transcribeResult.durationMs,
          captureMs: 0,
          totalMs: transcribeResult.durationMs,
          reply: "",
          voiceProvider: null,
          reminderDraft: null,
          chaos: item.chaos ?? null,
          misses: evaluate(item, transcript, null, transcribeResult)
        };
      }
    }

    const captureResult = await capture(transcript || item.text, item.mode === "voice" ? "voice" : "text", item.chaos, item.pendingCheckIn, item.at);
    await retimeNewRecords(USER_ID, before, item.at);
    const misses = evaluate(item, transcript, captureResult, transcribeResult);
    return {
      id: item.id,
      phase: item.phase,
      prompt: item.text,
      transcript,
      transcribeMs: transcribeResult?.durationMs ?? 0,
      captureMs: captureResult.durationMs,
      totalMs: (transcribeResult?.durationMs ?? 0) + captureResult.durationMs,
      reply: captureResult.body?.reply ?? "",
      voiceProvider: captureResult.body?.voice?.provider ?? null,
      voiceBytesBase64: captureResult.body?.voice?.audioBase64?.length ?? 0,
      reminderDraft: captureResult.body?.reminderDraft ?? null,
      archive: captureResult.body?.archive ?? null,
      chaos: item.chaos ?? null,
      misses
    };
  } catch (error) {
    return {
      id: item.id,
      phase: item.phase,
      prompt: item.text,
      transcript,
      transcribeMs: transcribeResult?.durationMs ?? 0,
      captureMs: 0,
      totalMs: transcribeResult?.durationMs ?? 0,
      reply: "",
      voiceProvider: null,
      reminderDraft: null,
      chaos: item.chaos ?? null,
      misses: [`exception: ${error instanceof Error ? error.message : String(error)}`]
    };
  }
}

function groupRapidCases() {
  const result = [];
  const usedRapid = new Set();
  for (const item of cases) {
    if (!item.rapidGroup) {
      result.push(item);
      continue;
    }
    if (usedRapid.has(item.rapidGroup)) continue;
    usedRapid.add(item.rapidGroup);
    result.push(cases.filter((candidate) => candidate.rapidGroup === item.rapidGroup));
  }
  return result;
}

function summarize(results) {
  const flat = results.flat();
  const failed = flat.filter((item) => item.misses.length);
  const voiceProviders = flat.reduce((acc, item) => {
    const key = item.voiceProvider ?? "none";
    acc[key] = (acc[key] ?? 0) + 1;
    return acc;
  }, {});
  const latencies = flat.map((item) => item.totalMs).filter(Boolean);
  const avg = Math.round(latencies.reduce((sum, value) => sum + value, 0) / Math.max(1, latencies.length));
  const max = Math.max(0, ...latencies);
  const reminderCases = flat.filter((item) => /remind|Ask me/i.test(item.prompt));
  const reminderFailures = reminderCases.filter((item) => item.misses.some((miss) => /reminder|check-in/i.test(miss)));
  const recallCases = flat.filter((item) => /what did|what do you remember|Have I seemed|If today/i.test(item.prompt));
  const recallFailures = recallCases.filter((item) => item.misses.some((miss) => /recall|timestamp|continuity|girlfriend|commitment|save/i.test(miss)));
  const emotionalCases = flat.filter((item) => /tired|weird|irritated|mood|normally|emotion/i.test(`${item.prompt} ${item.phase}`));
  const emotionalFailures = emotionalCases.filter((item) => item.misses.some((miss) => /timestamp|brain quiet|empty|saved/i.test(miss)));

  return {
    userId: USER_ID,
    baseUrl: BASE_URL,
    generatedAt: new Date().toISOString(),
    total: flat.length,
    passed: flat.length - failed.length,
    failed: failed.length,
    score: `${flat.length - failed.length}/${flat.length}`,
    avgTotalMs: avg,
    maxTotalMs: max,
    over25s: flat.filter((item) => item.totalMs > 25_000).length,
    voiceProviders,
    reminderQuality: `${reminderCases.length - reminderFailures.length}/${reminderCases.length}`,
    recallQuality: `${recallCases.length - recallFailures.length}/${recallCases.length}`,
    emotionalQuality: `${emotionalCases.length - emotionalFailures.length}/${emotionalCases.length}`,
    failures: failed
  };
}

function markdownReport(summary, results) {
  const topSlow = [...results.flat()].sort((a, b) => b.totalMs - a.totalMs).slice(0, 8);
  const lines = [
    "# AURA Backend-Only Real User Beta Simulation",
    "",
    `Run: \`${summary.userId}\``,
    `Base URL: \`${summary.baseUrl}\``,
    "",
    "## Score",
    `- Passed: ${summary.passed}/${summary.total}`,
    `- Failed: ${summary.failed}/${summary.total}`,
    `- Avg total latency: ${summary.avgTotalMs} ms`,
    `- Max total latency: ${summary.maxTotalMs} ms`,
    `- Over 25s timeout risk: ${summary.over25s}`,
    `- Voice providers: ${JSON.stringify(summary.voiceProviders)}`,
    `- Reminder quality: ${summary.reminderQuality}`,
    `- Recall quality: ${summary.recallQuality}`,
    `- Emotional continuity quality: ${summary.emotionalQuality}`,
    "",
    "## Top Slow Requests",
    ...topSlow.map((item) => `- ${item.id}: ${item.totalMs}ms (STT ${item.transcribeMs}ms, capture ${item.captureMs}ms), voice ${item.voiceProvider ?? "none"}, misses ${item.misses.join("; ") || "none"}`),
    "",
    "## Failures"
  ];

  if (!summary.failures.length) {
    lines.push("- None. This run passed all automated checks.");
  } else {
    for (const item of summary.failures) {
      lines.push(
        "",
        `### ${item.id}`,
        `- Phase: ${item.phase}`,
        `- Misses: ${item.misses.join("; ")}`,
        `- Total: ${item.totalMs}ms`,
        `- Prompt: ${item.prompt}`,
        `- Transcript: ${item.transcript}`,
        `- Reply: ${String(item.reply).slice(0, 900)}`
      );
    }
  }

  lines.push(
    "",
    "## Recommended Fixes",
    "- Treat failures in this report as beta blockers only if they affect normal non-chaos cases.",
    "- If brain failure cases fail gracefully, no product fix is needed; they prove fallback behavior.",
    "- If companion mode dumps timestamps, tighten recall gating/prompt restraint.",
    "- If reminder recall creates reminders, tighten intent precedence again.",
    "- If Pocket TTS is missing in non-chaos cases, inspect `/voice/synthesize` and `pocket-tts` logs."
  );

  return `${lines.join("\n")}\n`;
}

async function main() {
  await fs.mkdir(AUDIO_DIR, { recursive: true });
  const health = await fetchJson(`${BASE_URL}/health`);
  if (!health.ok) {
    throw new Error(`Backend health failed at ${BASE_URL}/health (${health.status})`);
  }

  console.log(`[AURA beta chaos] user=${USER_ID}`);
  console.log(`[AURA beta chaos] base=${BASE_URL}`);

  const grouped = groupRapidCases();
  const results = [];
  for (const item of grouped) {
    if (Array.isArray(item)) {
      console.log(`[rapid] ${item.map((entry) => entry.id).join(", ")}`);
      const groupResults = await Promise.all(item.map((entry) => runCase(entry)));
      groupResults.forEach((entry) => console.log(`${entry.misses.length ? "FAIL" : "PASS"} ${entry.id} ${entry.totalMs}ms`));
      results.push(groupResults);
    } else {
      const result = await runCase(item);
      console.log(`${result.misses.length ? "FAIL" : "PASS"} ${result.id} ${result.totalMs}ms`);
      results.push([result]);
    }
  }

  const summary = summarize(results);
  const report = { summary, results: results.flat() };
  await fs.writeFile(path.join(OUT_DIR, "report.json"), JSON.stringify(report, null, 2));
  await fs.writeFile(path.join(OUT_DIR, "summary.md"), markdownReport(summary, results));

  console.log(`[AURA beta chaos] score=${summary.score} avg=${summary.avgTotalMs}ms max=${summary.maxTotalMs}ms`);
  console.log(`[AURA beta chaos] report=${path.join(OUT_DIR, "report.json")}`);
  console.log(`[AURA beta chaos] summary=${path.join(OUT_DIR, "summary.md")}`);
  if (summary.failed) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
