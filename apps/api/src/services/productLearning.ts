import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { MemoryIntent } from "./memoryIntentRouter.js";
import { getPrivacySettings, privacyHash } from "./privacySettings.js";

type ProductLearningEvent = {
  id: string;
  userId: string;
  issue: string;
  trigger: string;
  actual: string;
  expected: string;
  suggestedFix: string;
  memoryIntent: MemoryIntent;
  createdAt: string;
};

const apiDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const productLearningPath = path.join(apiDir, "data", "aura-product-learning-events.json");
const localEvents: ProductLearningEvent[] = [];
let loaded = false;

async function loadEvents() {
  if (loaded) return;
  loaded = true;
  try {
    const raw = await fs.readFile(productLearningPath, "utf8");
    localEvents.splice(0, localEvents.length, ...(JSON.parse(raw) as ProductLearningEvent[]));
  } catch {
    // First launch starts with no product learning events.
  }
}

async function persistEvents() {
  await fs.mkdir(path.dirname(productLearningPath), { recursive: true });
  await fs.writeFile(productLearningPath, JSON.stringify(localEvents.slice(0, 2000), null, 2));
}

async function saveEvent(event: Omit<ProductLearningEvent, "id" | "createdAt">) {
  await loadEvents();
  const duplicate = localEvents.find((item) =>
    item.issue === event.issue &&
    item.userId === event.userId &&
    item.trigger.toLowerCase() === event.trigger.toLowerCase()
  );
  if (duplicate) return duplicate;

  const saved: ProductLearningEvent = {
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    ...event
  };
  localEvents.unshift(saved);
  await persistEvents();
  return saved;
}

export async function logProductLearningSignals(input: {
  userId: string;
  userText: string;
  reply: string;
  memoryIntent: MemoryIntent;
  reminderTitle?: string | null;
}) {
  const privacy = await getPrivacySettings(input.userId);
  if (!privacy.allowProductImprovement) return [];

  const redactRaw = privacy.privateMode || privacy.disableRawConversationReview;
  const userText = redactRaw ? `[redacted:${privacyHash(input.userText)}]` : input.userText;
  const reply = redactRaw ? `[redacted:${privacyHash(input.reply)}]` : input.reply;
  const reminderTitle = redactRaw && input.reminderTitle ? `[redacted:${privacyHash(input.reminderTitle)}]` : input.reminderTitle;
  const events: ProductLearningEvent[] = [];

  if (/^(you mentioned|you said|i remember|as you said|as you told)/i.test(input.reply.trim())
    && (input.memoryIntent === "normal_chat" || input.memoryIntent === "emotional_support")) {
    events.push(await saveEvent({
      userId: input.userId,
      issue: "memory_overuse_in_companion_mode",
      trigger: userText,
      actual: reply,
      expected: "Use memory silently in normal conversation unless the user explicitly asks for recall.",
      suggestedFix: "Tighten prompt polish and memory context gating for companion mode.",
      memoryIntent: input.memoryIntent
    }));
  }

  if (/\b(did i|have i|kya maine|maine.*bataya|mere bare|mere baare)\b/i.test(input.userText)
    && input.memoryIntent === "normal_chat") {
    events.push(await saveEvent({
      userId: input.userId,
      issue: "possible_recall_router_miss",
      trigger: userText,
      actual: reply,
      expected: "Classify direct user-history/profile questions as recall and answer from archive or quick memory.",
      suggestedFix: "Add this phrase shape to Memory Intent Router V2 regression cases.",
      memoryIntent: input.memoryIntent
    }));
  }

  if (input.reminderTitle && /^(,|tell me one thing|can you|could you|please)/i.test(input.reminderTitle.trim())) {
    events.push(await saveEvent({
      userId: input.userId,
      issue: "reminder_title_cleanup_needed",
      trigger: userText,
      actual: reminderTitle ?? "",
      expected: "Reminder title should be the action only, e.g. drink water.",
      suggestedFix: "Add filler phrase to reminderParser.stripReminderWords.",
      memoryIntent: input.memoryIntent
    }));
  }

  return events;
}

export async function listProductLearningEvents(limit = 80) {
  await loadEvents();
  return localEvents.slice(0, limit);
}
