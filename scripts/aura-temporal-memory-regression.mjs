#!/usr/bin/env node

const baseUrl = process.env.AURA_API_URL ?? "http://127.0.0.1:4000";
const userId = `aura-real-sim-user-temporal-regression-${Date.now()}`;
const timezone = process.env.AURA_TEST_TIMEZONE ?? "Asia/Kolkata";
const appSessionId = `temporal-session-${Date.now()}`;

async function capture(content, at, extraHeaders = {}) {
  const response = await fetch(`${baseUrl}/capture`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-user-id": userId,
      "x-aura-skip-voice": "true",
      "x-aura-test-mode": "structure-mock",
      "x-aura-test-created-at": at,
      "x-aura-app-session-id": appSessionId,
      "x-aura-debug-temporal": "true",
      ...extraHeaders
    },
    body: JSON.stringify({ content, inputMode: "text", timezone, skipVoice: true })
  });

  const text = await response.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`Non-JSON response ${response.status}: ${text.slice(0, 300)}`);
  }
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${JSON.stringify(json).slice(0, 600)}`);
  return json;
}

function assert(condition, message, details = {}) {
  if (!condition) {
    const error = new Error(message);
    error.details = details;
    throw error;
  }
}

function hasForcedMemory(reply) {
  return /\b(you told me before|you mentioned earlier|i remember that|as you said)\b/i.test(reply);
}

function hasRepairLoop(reply) {
  return /let me answer that fresh|start fresh|i was looping/i.test(reply);
}

async function main() {
  const day = "2026-05-19";
  const results = [];

  const morningMovie = await capture("I am watching a web series this morning. I like the Manali crime mystery vibe.", `${day}T09:00:00.000+05:30`);
  results.push({ name: "morning_movie", reply: morningMovie.reply, temporal: morningMovie.temporal });

  const morningTired = await capture("I am exhausted today and work feels heavy.", `${day}T09:06:00.000+05:30`);
  results.push({ name: "morning_exhausted", reply: morningTired.reply, temporal: morningTired.temporal });

  const eveningWork = await capture("Actually I feel better now. I am working on AURA memory architecture tonight.", `${day}T21:15:00.000+05:30`);
  results.push({ name: "evening_override", reply: eveningWork.reply, temporal: eveningWork.temporal });
  assert(
    eveningWork.archive?.memoryIntent === "emotional_support" || eveningWork.archive?.memoryIntent === "normal_chat",
    "Evening correction should stay in lightweight current-chat mode, not force utility recall.",
    eveningWork
  );
  assert(!hasForcedMemory(eveningWork.reply), "Evening correction should not force old memory wording.", eveningWork);

  const currentSession = await capture("What were we talking about in this session?", `${day}T21:18:00.000+05:30`);
  results.push({ name: "current_session", reply: currentSession.reply, intent: currentSession.archive?.memoryIntent });
  assert(/web series|exhausted|better|AURA|memory/i.test(currentSession.reply), "Current session summary should use live session turns.", currentSession);

  const repeatComplaint = await capture("You are repeating the same thing again and again, stop doing that.", `${day}T21:20:00.000+05:30`);
  const repeatComplaint2 = await capture("Again you are saying the same line, don't repeat.", `${day}T21:21:00.000+05:30`);
  results.push({ name: "repair_one", reply: repeatComplaint.reply });
  results.push({ name: "repair_two", reply: repeatComplaint2.reply });
  assert(!hasRepairLoop(repeatComplaint.reply), "First repair should not use banned fresh-answer template.", repeatComplaint);
  assert(!hasRepairLoop(repeatComplaint2.reply), "Second repair should not recurse into fresh-answer template.", repeatComplaint2);

  const normalChat = await capture("Reply normally. I just want to continue the memory plan.", `${day}T21:23:00.000+05:30`);
  results.push({ name: "normal_chat_memory_invisible", reply: normalChat.reply, intent: normalChat.archive?.memoryIntent });
  assert(!hasForcedMemory(normalChat.reply), "Normal chat should not force explicit memory language.", normalChat);

  const exactRecall = await capture("What did I say this morning about the web series?", `${day}T21:25:00.000+05:30`);
  results.push({ name: "exact_temporal_recall", reply: exactRecall.reply, intent: exactRecall.archive?.memoryIntent });
  assert(/Manali|crime|mystery|web series/i.test(exactRecall.reply), "Exact recall should still find morning archive detail.", exactRecall);

  const girlfriendSeed = await capture("My girlfriend liked the app idea, but leave that for now.", `${day}T21:27:00.000+05:30`);
  const relationshipRecall = await capture("What do you remember about my girlfriend?", `${day}T21:28:00.000+05:30`);
  results.push({ name: "relationship_seed", reply: girlfriendSeed.reply });
  results.push({ name: "relationship_scoped", reply: relationshipRecall.reply, intent: relationshipRecall.archive?.memoryIntent });
  assert(relationshipRecall.archive?.memoryIntent === "relationship_recall", "Girlfriend question should route to relationship recall.", relationshipRecall);
  assert(!/web series|Manali|exhausted/i.test(relationshipRecall.reply), "Relationship recall should not mix unrelated movie/emotion context.", relationshipRecall);

  console.log(JSON.stringify({
    ok: true,
    baseUrl,
    userId,
    appSessionId,
    results
  }, null, 2));
}

main().catch((error) => {
  console.error(JSON.stringify({
    ok: false,
    message: error.message,
    details: error.details ?? null
  }, null, 2));
  process.exit(1);
});
