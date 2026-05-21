#!/usr/bin/env node

const baseUrl = process.env.AURA_API_URL ?? "http://127.0.0.1:4000";
const userId = `aura-perfect-assistant-${Date.now()}`;
const timezone = process.env.AURA_TEST_TIMEZONE ?? "Asia/Kolkata";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function capture(content, options = {}) {
  let lastError = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}/capture`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-user-id": userId,
          "x-aura-skip-voice": "true",
          ...(options.createdAt ? { "x-aura-test-created-at": options.createdAt } : {})
        },
        body: JSON.stringify({ content, inputMode: "text", timezone, skipVoice: true })
      });
      const text = await response.text();
      const json = text ? JSON.parse(text) : null;
      if (response.ok && json) return json;
      lastError = new Error(`HTTP ${response.status}: ${text.slice(0, 500)}`);
      if (![429, 502, 503, 504].includes(response.status)) throw lastError;
    } catch (error) {
      lastError = error;
      if (attempt === 3) break;
    }
    await sleep(750 * attempt);
  }
  throw lastError ?? new Error("capture_failed");
}

function assert(condition, message, details) {
  if (!condition) {
    console.error(JSON.stringify({ ok: false, message, details }, null, 2));
    process.exit(1);
  }
}

const results = [];

results.push(await capture("Call me Rihan. I am building AURA, an AI voice assistant app."));
results.push(await capture("I prefer short simple replies, not long explanations."));
results.push(await capture("I want AURA to control browser, send messages, and remember me forever."));
results.push(await capture("I am trying to smoke less weed and drink more water."));

const appRecall = await capture("Did I tell you that I am developing an app?");
results.push(appRecall);
assert(/yes/i.test(appRecall.reply) && /app|AURA|assistant/i.test(appRecall.reply), "Direct app recall should answer yes with the matched fact.", appRecall);
assert(!/From your recent history/i.test(appRecall.reply), "Direct recall should not dump long history.", appRecall);

const hindiRecall = await capture("क्या मैंने तुम्हें पहले बताया था कि मैं एक ऐप पे काम कर रहा हूँ?");
results.push(hindiRecall);
assert(/हाँ|yes|बताया|app|ऐप|AURA/i.test(hindiRecall.reply), "Hindi direct recall should answer from user history.", hindiRecall);

const profile = await capture("तुम्हें मेरे बारे में क्या पता है?");
results.push(profile);
assert(/AURA|app|assistant|short|simple|Rihan|coding|developer/i.test(profile.reply), "Profile recall should use quick/core memory.", profile);

const journal = await capture("Jarnel this, I am developing the beta stage of AURA as much as I can.");
results.push(journal);
assert(journal.analysis?.explicitSaveIntent === true, "Jarnel/journal typo should trigger explicit save.", journal);

const quickFollowup = await capture("Reply normally, what should I focus on next?");
results.push(quickFollowup);
assert(!/you mentioned|i remember|from your recent history/i.test(quickFollowup.reply), "Normal chat should not expose memory machinery.", quickFollowup);

const naturalMemoryTurn = await capture("I want AURA to feel natural in normal conversation and only search deep memory when I ask exact recall.");
results.push(naturalMemoryTurn);

const memoryList = await fetch(`${baseUrl}/memories`, {
  headers: { "x-user-id": userId }
}).then((response) => response.json());
const layers = new Set((memoryList.memories ?? []).map((memory) => memory.memory_layer));
const explicitSavedMemory = (memoryList.memories ?? []).find((memory) =>
  /beta stage of AURA|developing the beta stage/i.test(`${memory.content ?? ""} ${memory.summary ?? ""}`)
  || (memory.auto_tags ?? []).includes("explicit-save")
);
assert(explicitSavedMemory, "Explicit save should create a durable memory.", memoryList);

const passiveLayers = ["quick_memory", "recent_memory", "daily_summary", "weekly_summary", "long_term_summary"];
const passiveLayersCreated = passiveLayers.filter((layer) => layers.has(layer));
assert(
  passiveLayersCreated.length === 0,
  "Simplified brain should not create passive memory layers from normal conversation.",
  { passiveLayersCreated, memories: memoryList.memories }
);

const learning = await fetch(`${baseUrl}/memories/product-learning?limit=20`, {
  headers: { "x-user-id": userId }
}).then((response) => response.json());

console.log(JSON.stringify({
  ok: true,
  baseUrl,
  userId,
  checks: {
    directAppRecall: appRecall.reply,
    hindiRecall: hindiRecall.reply,
    profileRecall: profile.reply,
    journalSaved: journal.analysis?.explicitSaveIntent,
    memoryLayers: Array.from(layers).sort(),
    explicitSavedMemory: explicitSavedMemory?.summary ?? explicitSavedMemory?.content ?? null,
    productLearningEvents: learning.events?.length ?? 0
  }
}, null, 2));
