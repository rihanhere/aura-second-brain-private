#!/usr/bin/env node

const baseUrl = process.env.AURA_API_URL ?? "http://127.0.0.1:4000";
const timezone = process.env.AURA_TEST_TIMEZONE ?? "Asia/Kolkata";
const sessionId = `cognition-v2-${Date.now()}`;
const scaleUserId = `aura-real-sim-user-cognition-v2-${Date.now()}`;
const privacyUserId = `aura-cognition-v2-privacy-${Date.now()}`;

async function request(path, options = {}) {
  let lastError = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const response = await fetch(`${baseUrl}${path}`, {
      ...options,
      headers: {
        "content-type": "application/json",
        ...(options.headers ?? {})
      }
    }).catch((error) => {
      lastError = error;
      return null;
    });
    if (!response) {
      await new Promise((resolve) => setTimeout(resolve, 750 * attempt));
      continue;
    }
    const text = await response.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      lastError = new Error(`Non-JSON response ${response.status} ${path}: ${text.slice(0, 300)}`);
      if (![429, 502, 503, 504].includes(response.status)) throw lastError;
      await new Promise((resolve) => setTimeout(resolve, 750 * attempt));
      continue;
    }
    if (response.ok) return json;
    const error = new Error(`HTTP ${response.status} ${path}: ${JSON.stringify(json).slice(0, 600)}`);
    error.details = json;
    lastError = error;
    if (![429, 502, 503, 504].includes(response.status)) throw error;
    await new Promise((resolve) => setTimeout(resolve, 750 * attempt));
  }
  throw lastError ?? new Error(`Request failed: ${path}`);
}

async function capture(content, at, userId = scaleUserId) {
  return request("/capture", {
    method: "POST",
    headers: {
      "x-user-id": userId,
      "x-aura-skip-voice": "true",
      "x-aura-test-mode": "structure-mock",
      "x-aura-test-created-at": at,
      "x-aura-app-session-id": sessionId,
      "x-aura-debug-temporal": "true"
    },
    body: JSON.stringify({ content, inputMode: "text", timezone, skipVoice: true })
  });
}

function assert(condition, message, details = {}) {
  if (!condition) {
    const error = new Error(message);
    error.details = details;
    throw error;
  }
}

function hasMetaLeak(reply) {
  return /\b(memory intent|recall mode|tool mode|tool draft|archive recall|emotional continuity|memory governor|cognitive confidence|entropy level|orchestration)\b/i.test(reply);
}

function hasRepairLoop(reply) {
  return /let me answer that fresh|start fresh|i was looping/i.test(reply);
}

async function main() {
  const day = "2026-05-19";
  const results = [];

  const privacy = await request("/memories/privacy", {
    method: "PATCH",
    headers: { "x-user-id": privacyUserId },
    body: JSON.stringify({
      privateMode: true,
      allowProductImprovement: false,
      allowPersonalAdaptation: false,
      memoryRetentionDays: 30,
      disableRawConversationReview: true
    })
  });
  assert(privacy.settings.privateMode === true, "Private mode should be enabled.", privacy);
  assert(privacy.settings.allowProductImprovement === false, "Global product improvement should remain opt-in.", privacy);
  results.push({ name: "privacy_controls", settings: privacy.settings });

  const exportBeforeDelete = await request("/memories/export", {
    headers: { "x-user-id": privacyUserId }
  });
  assert(exportBeforeDelete.data.privacy?.privateMode === true, "Export should include privacy settings.", exportBeforeDelete);
  results.push({ name: "export_controls", hasPrivacy: Boolean(exportBeforeDelete.data.privacy) });

  const deleteResult = await request("/memories/data", {
    method: "DELETE",
    headers: { "x-user-id": privacyUserId },
    body: JSON.stringify({ confirm: "DELETE_MY_AURA_DATA" })
  });
  assert(deleteResult.ok === true, "Delete endpoint should complete.", deleteResult);
  results.push({ name: "delete_controls", deletedAt: deleteResult.result.deletedAt });

  const confident = await capture("Actually I feel better now and I am focused on AURA launch cognition.", `${day}T20:00:00.000+05:30`);
  assert(confident.archive?.memoryIntent === "emotional_support" || confident.archive?.memoryIntent === "normal_chat", "Simplified brain should keep this in lightweight chat mode.", confident);
  assert(!hasMetaLeak(confident.reply), "Simplified brain must not leak cognition/orchestration metadata.", confident);
  assert(confident.voice === null, "Regression must not trigger backend voice.", confident);
  results.push({
    name: "simplified_chat_mode",
    reply: confident.reply,
    intent: confident.archive?.memoryIntent
  });

  const noisyTopics = [
    "Now I am talking about work pressure and deadlines.",
    "Switch topic, my sleep has been weird lately.",
    "Also my girlfriend thing is separate, don't mix it with work.",
    "Now coding again, the backend should be stable.",
    "Actually forget the movie topic, I am focused on launch cost.",
    "I feel slightly stressed but also excited.",
    "What should we do next without repeating repair phrases?"
  ];
  let last;
  for (let index = 0; index < noisyTopics.length; index += 1) {
    last = await capture(noisyTopics[index], `${day}T20:${String(index + 1).padStart(2, "0")}:00.000+05:30`);
    assert(!hasMetaLeak(last.reply), "Mixed-topic replies should not leak cognition/orchestration metadata.", last);
    assert(last.voice === null, "Text regression must not trigger backend voice.", last);
  }
  assert(!hasRepairLoop(last.reply), "Fragmented long session should not fall into repair-loop template.", last);
  results.push({
    name: "mixed_topic_stability",
    finalReply: last.reply,
    finalIntent: last.archive?.memoryIntent
  });

  const health = await request("/health");
  assert(health.providers?.persistence?.adapter, "Health should expose persistence adapter.", health);
  assert(health.providers?.privacy, "Health should expose privacy status.", health);
  results.push({ name: "health_observability", persistence: health.providers.persistence });

  console.log(JSON.stringify({
    ok: true,
    baseUrl,
    scaleUserId,
    privacyUserId,
    sessionId,
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
