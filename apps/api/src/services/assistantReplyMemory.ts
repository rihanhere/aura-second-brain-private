import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isScaleTestUser } from "./scaleTest.js";

type AssistantReplyRecord = {
  id: string;
  userId: string;
  sessionId: string;
  reply: string;
  normalized: string;
  opening: string;
  tone: string;
  repair: boolean;
  createdAt: string;
};

export type AssistantReplyGuardResult = {
  reply: string;
  changed: boolean;
  issues: string[];
  repairCooldown: boolean;
};

const apiDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const localPath = path.join(apiDir, "data", "assistant-reply-memory.json");
const localRecords: AssistantReplyRecord[] = [];
const scaleRecords: AssistantReplyRecord[] = [];
let loaded = false;

async function loadRecords() {
  if (loaded) return;
  loaded = true;
  try {
    const raw = await fs.readFile(localPath, "utf8");
    localRecords.splice(0, localRecords.length, ...(JSON.parse(raw) as AssistantReplyRecord[]));
  } catch {
    // First launch has no assistant self-memory.
  }
}

async function persistRecords() {
  await fs.mkdir(path.dirname(localPath), { recursive: true });
  await fs.writeFile(localPath, JSON.stringify(localRecords.slice(0, 4000), null, 2));
}

function storeForUser(userId: string) {
  return isScaleTestUser(userId)
    ? { records: scaleRecords, persist: async () => undefined }
    : { records: localRecords, persist: persistRecords };
}

function normalize(text: string) {
  return text.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();
}

function openingOf(text: string) {
  return normalize(text).split(" ").slice(0, 7).join(" ");
}

function wordSet(text: string) {
  return new Set(normalize(text).split(" ").filter((word) => word.length > 3));
}

function similarity(a: string, b: string) {
  const left = wordSet(a);
  const right = wordSet(b);
  if (!left.size || !right.size) return 0;
  let overlap = 0;
  for (const word of left) if (right.has(word)) overlap += 1;
  return overlap / Math.min(left.size, right.size);
}

function repairPhrase(text: string) {
  return /\b(let me answer|fresh|you're right|you are right|i was looping|i'll stop repeating|i understand|i hear you|that makes sense|you mentioned|you told me|from your memory|emotional continuity|got it)\b/i.test(text);
}

function toneFor(text: string) {
  if (/\?+\s*$/.test(text.trim())) return "question";
  if (/\b(step|do this|try|next)\b/i.test(text)) return "practical";
  if (/\b(tired|stressed|sad|hard|feel|hurt|drained)\b/i.test(text)) return "emotional";
  if (/\b(yes|no|exact|date|remember|recall)\b/i.test(text)) return "utility";
  return "casual";
}

export async function recentAssistantReplyMemory(userId: string, sessionId: string, limit = 15) {
  await loadRecords();
  return storeForUser(userId).records
    .filter((record) => record.userId === userId && record.sessionId === sessionId)
    .slice(0, limit);
}

export async function listAssistantReplyMemory(userId: string, limit = 200) {
  await loadRecords();
  return storeForUser(userId).records
    .filter((record) => record.userId === userId)
    .slice(0, limit);
}

export async function recordAssistantReply(input: {
  userId: string;
  sessionId: string;
  reply: string;
  createdAt?: Date;
}) {
  await loadRecords();
  const store = storeForUser(input.userId);
  const record: AssistantReplyRecord = {
    id: crypto.randomUUID(),
    userId: input.userId,
    sessionId: input.sessionId,
    reply: input.reply,
    normalized: normalize(input.reply),
    opening: openingOf(input.reply),
    tone: toneFor(input.reply),
    repair: repairPhrase(input.reply),
    createdAt: (input.createdAt ?? new Date()).toISOString()
  };
  store.records.unshift(record);
  if (store.records.length > 5000) store.records.length = 5000;
  await store.persist();
  return record;
}

function fallbackCandidates(userText: string, repairCooldown: boolean) {
  const candidates: string[] = [];
  const direct = directCalibratedReply(userText);
  if (direct) candidates.push(direct);
  if (/\b(answer normally|reply normally|normal answer|seedha jawab|simple bol|simple answer)\b/i.test(userText)) {
    candidates.push("Okay. Simple and direct.");
  }
  if (/\b(no|nahi|wrong|galat|different|dusra|alag)\b.{0,80}\b(series|movie|show|film|episode)\b/i.test(userText)) {
    candidates.push("Ah okay, got you.");
  }
  if (/\b(crazy|wild|insane|mad|pagal)\b.{0,80}\b(movie|film|series|show|episode)\b/i.test(userText)
    || /\b(movie|film|series|show|episode)\b.{0,80}\b(crazy|wild|insane|mad|pagal)\b/i.test(userText)) {
    candidates.push("What kind of crazy?");
  }
  if (/\b(watching|dekh raha|dekh rha|dekh rahi|starting)\b.{0,80}\b(movie|film|series|show|episode)\b/i.test(userText)
    || /\b(movie|film|series|show|episode)\b.{0,80}\b(tonight|aaj|abhi|now|another|new)\b/i.test(userText)) {
    candidates.push("Oh nice. What movie?");
  }
  if (/\b(tired|exhausted|drained|thak|stressed)\b/i.test(userText)) {
    candidates.push("Yeah, today sounds draining.");
  }
  if (/^\s*(hmm+|hm+|umm+|uh+|haan|ha|ok|okay|acha|achha|huh)\s*$/i.test(userText)) {
    candidates.push("Yeah?");
  }
  if (/^\s*(stop|wait|pause|leave that|cancel|ruk|ruko|bas|chhodo|chod do)\b/i.test(userText)) {
    candidates.push("Okay.");
  }
  if (repairCooldown) {
    if (/\b(movie|series|show|manali|thriller|crime|mystery)\b/i.test(userText)) {
      candidates.push("What kind of vibe is it?");
    }
    if (/\b(work|coding|app|aura|developer|startup)\b/i.test(userText)) {
      candidates.push("What’s the next small step?");
    }
    if (/\b(tired|stressed|sad|low|confused|stuck)\b/i.test(userText)) {
      candidates.push("What feels most stuck right now?");
    }
  }
  candidates.push(
    "Okay. Simple and direct.",
    "Tell me the main thing.",
    "What part should we focus on?"
  );
  return candidates;
}

function directCalibratedReply(userText: string) {
  if (/\b(?:switch|change)\b.{0,30}\bvoice\b/i.test(userText)
    || /\bvoice\b.{0,30}\b(?:switch|change|male|female)\b/i.test(userText)) {
    return "sure.";
  }
  const openMatch = userText.toLowerCase().trim().match(/^\s*(?:open|launch|start)\s+([a-z][a-z0-9 ]{1,40})\s*$/i);
  if (openMatch?.[1]) {
    const target = ["github", "camera", "safari", "google", "chatgpt", "settings", "calendar", "notes", "mail", "messages", "whatsapp", "youtube"]
      .find((candidate) => new RegExp(`\\b${candidate}\\b`, "i").test(openMatch[1]));
    if (target) return `opening ${target}.`;
  }
  if (/\b(?:crashed|crash|fell|gir gaya|accident)\b.{0,40}\b(?:bike|scooty|scooter|cycle)\b/i.test(userText)
    || /\b(?:bike|scooty|scooter|cycle)\b.{0,40}\b(?:crashed|crash|fell|accident)\b/i.test(userText)) {
    return "again? you good?";
  }
  if (/\bexam\b.{0,40}\b(?:destroyed|killed|ruined|finished|messed)\b/i.test(userText)
    || /\b(?:destroyed|killed|ruined|finished|messed)\b.{0,40}\bexam\b/i.test(userText)) {
    return "that bad huh?";
  }
  if (/\b(?:addicted|hooked)\b.{0,40}\b(?:scrolling|reels|shorts|instagram|phone)\b/i.test(userText)) {
    return "yeah, that happens fast these days.";
  }
  if (/\b(?:i am|i'm|im|feeling|feel)\b.{0,30}\b(?:depressed|sad|low|down)\b/i.test(userText)) {
    return "That sounds heavy. Want to talk for a minute?";
  }
  if (/\bwhat are you doing\b/i.test(userText)) {
    return "talking to you.";
  }
  return null;
}

function conversationalFallback(userText: string, repairCooldown: boolean, recent: AssistantReplyRecord[]) {
  const candidates = fallbackCandidates(userText, repairCooldown);
  return candidates.find((candidate) => {
    const candidateOpening = openingOf(candidate);
    const candidateNormalized = normalize(candidate);
    return !recent.some((record) => record.opening === candidateOpening || similarity(candidateNormalized, record.normalized) >= 0.62);
  }) ?? "Okay. Simple and direct.";
}

export async function guardAssistantReply(input: {
  userId: string;
  sessionId: string;
  userText: string;
  reply: string;
  mode: string;
}) {
  if (input.mode === "utility") {
    return { reply: input.reply, changed: false, issues: [], repairCooldown: false } satisfies AssistantReplyGuardResult;
  }

  const direct = directCalibratedReply(input.userText);
  if (direct) {
    return {
      reply: direct,
      changed: input.reply.trim() !== direct,
      issues: input.reply.trim() === direct ? [] : ["direct_calibration_override"],
      repairCooldown: false
    } satisfies AssistantReplyGuardResult;
  }

  if (/\b(answer normally|reply normally|normal answer|seedha jawab|simple bol|simple answer)\b/i.test(input.userText)) {
    return {
      reply: "Okay. Simple and direct.",
      changed: input.reply.trim() !== "Okay. Simple and direct.",
      issues: input.reply.trim() === "Okay. Simple and direct." ? [] : ["direct_style_override"],
      repairCooldown: false
    } satisfies AssistantReplyGuardResult;
  }

  if (/^\s*(hmm+|hm+|umm+|uh+|haan|ha|ok|okay|acha|achha|huh)\s*\.?$/i.test(input.userText)) {
    return {
      reply: "Yeah?",
      changed: input.reply.trim() !== "Yeah?",
      issues: input.reply.trim() === "Yeah?" ? [] : ["low_content_override"],
      repairCooldown: false
    } satisfies AssistantReplyGuardResult;
  }

  if (/^\s*(stop|wait|pause|leave that|cancel|ruk|ruko|bas|chhodo|chod do)\b/i.test(input.userText)) {
    return {
      reply: "Okay.",
      changed: input.reply.trim() !== "Okay.",
      issues: input.reply.trim() === "Okay." ? [] : ["interrupt_override"],
      repairCooldown: false
    } satisfies AssistantReplyGuardResult;
  }

  if (/\b(no|nahi|wrong|galat|different|dusra|alag)\b.{0,80}\b(series|movie|show|film|episode)\b/i.test(input.userText)) {
    return {
      reply: "Ah okay, got you.",
      changed: input.reply.trim() !== "Ah okay, got you.",
      issues: input.reply.trim() === "Ah okay, got you." ? [] : ["correction_override"],
      repairCooldown: false
    } satisfies AssistantReplyGuardResult;
  }

  const recent = await recentAssistantReplyMemory(input.userId, input.sessionId, 15);
  const issues: string[] = [];
  const normalizedReply = normalize(input.reply);
  const opening = openingOf(input.reply);
  const repairCooldown = recent.filter((record) => record.repair).length >= 1;

  if (repairCooldown && repairPhrase(input.reply)) issues.push("repair_cooldown");
  if (recent.some((record) => record.opening && record.opening === opening)) issues.push("repeated_opening");
  if (recent.some((record) => similarity(normalizedReply, record.normalized) >= 0.72)) issues.push("semantic_repeat");
  if (/let me answer that fresh|start fresh|i was looping/i.test(input.reply)) issues.push("repair_template_loop");
  if (/\b(i remember|you (?:said|mentioned|told me)(?: earlier| before| previously)?|as you (?:said|mentioned|told me)|from your memory|memory says|emotional continuity suggests|temporal context suggests)\b/i.test(input.reply)) {
    issues.push("normal_chat_memory_flex");
  }
  if (/\b\d{4}-\d{2}-\d{2}\b|\b\d{1,2}:\d{2}\b/.test(input.reply)) {
    issues.push("normal_chat_timestamp_flex");
  }
  if (/^(i hear you|i understand|you're right|you are right|got it)[,.]/i.test(input.reply.trim()) && recent.some((record) => /^(i hear you|i understand|you're right|you are right|got it)[,.]/i.test(record.reply.trim()))) {
    issues.push("validation_repeat");
  }

  if (!issues.length) {
    return { reply: input.reply, changed: false, issues, repairCooldown } satisfies AssistantReplyGuardResult;
  }

  return {
    reply: conversationalFallback(input.userText, repairCooldown, recent),
    changed: true,
    issues,
    repairCooldown
  } satisfies AssistantReplyGuardResult;
}

export function assistantReplyMemoryStatus() {
  return { persistence: "local_file", path: localPath };
}
