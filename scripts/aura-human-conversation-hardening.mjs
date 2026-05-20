const baseUrl = process.env.AURA_TEST_API_URL ?? "http://127.0.0.1:4000";
const runId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
const userId = `aura-scale-stage2-user-human-${runId}`;

async function capture(content, session = "main") {
  const response = await fetch(`${baseUrl.replace(/\/$/, "")}/capture`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-user-id": userId,
      "x-aura-skip-voice": "true",
      "x-aura-test-mode": "structure-mock"
    },
    body: JSON.stringify({
      content,
      inputMode: "text",
      timezone: "Asia/Kolkata",
      skipVoice: true,
      appSession: {
        id: session,
        newActiveSession: false
      }
    })
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`${content} failed with ${response.status}: ${text}`);
  }

  return response.json();
}

function assertReply(name, reply, predicate) {
  if (!predicate(reply)) {
    throw new Error(`${name} failed. Reply: ${JSON.stringify(reply)}`);
  }
}

const forbiddenMeta = /\b(memory intent|recall mode|tool mode|tool draft|archive recall|emotional continuity|memory governor|orchestration)\b/i;
const therapyCadence = /\b(it takes courage|i'?m here to listen and support you|your feelings are valid|acknowledge your feelings)\b/i;

const checks = [
  {
    name: "switch voice",
    input: "switch voice",
    check: (reply) => /^sure\.?$/i.test(reply) && !/movie|film|series/i.test(reply)
  },
  {
    name: "open github",
    input: "open github",
    check: (reply) => /^opening github\.?$/i.test(reply)
  },
  {
    name: "bike crash",
    input: "i crashed my bike again",
    check: (reply) => /again\?\s*you good\??/i.test(reply)
  },
  {
    name: "pause",
    input: "pause",
    check: (reply) => /^okay\.?$/i.test(reply)
  },
  {
    name: "stop talking",
    input: "stop talking",
    check: (reply) => /^okay\.?$/i.test(reply)
  },
  {
    name: "exam casual",
    input: "bro that exam destroyed me",
    check: (reply) => /that bad huh\??/i.test(reply)
  },
  {
    name: "scrolling casual",
    input: "i think im addicted to scrolling",
    check: (reply) => /happens fast/i.test(reply) && !therapyCadence.test(reply)
  },
  {
    name: "depressed not managed",
    input: "im depressed",
    check: (reply) => !therapyCadence.test(reply) && !forbiddenMeta.test(reply)
  },
  {
    name: "movie no memory",
    input: "bro im watching another movie tonight",
    check: (reply) => /what movie/i.test(reply) && !/remember|earlier|archive/i.test(reply)
  }
];

for (const check of checks) {
  const data = await capture(check.input, `scenario-${check.name.replace(/\W+/g, "-")}`);
  const reply = String(data.reply ?? "");
  assertReply(check.name, reply, check.check);
}

await capture("Remember that my startup idea is a voice-first AI companion.", "recall");
const recall = await capture("do you remember my startup idea?", "recall");
assertReply("startup recall", String(recall.reply ?? ""), (reply) =>
  /voice-first ai companion/i.test(reply)
  && !/from your recent history|archive|timestamp|memory intent|recall mode/i.test(reply)
);

console.log(JSON.stringify({
  ok: true,
  baseUrl,
  checks: checks.length + 1,
  userId
}, null, 2));
