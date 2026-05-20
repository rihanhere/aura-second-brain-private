import { addDays, addHours, addMinutes, set } from "date-fns";
import { formatInTimeZone, fromZonedTime, toZonedTime } from "date-fns-tz";
import type { ReminderDraft } from "../types/domain.js";

const monthIndex: Record<string, number> = {
  january: 0,
  jan: 0,
  february: 1,
  feb: 1,
  march: 2,
  mar: 2,
  april: 3,
  apr: 3,
  may: 4,
  june: 5,
  jun: 5,
  july: 6,
  jul: 6,
  august: 7,
  aug: 7,
  september: 8,
  sept: 8,
  sep: 8,
  october: 9,
  oct: 9,
  november: 10,
  nov: 10,
  december: 11,
  dec: 11
};

function cleanSpaces(text: string) {
  return text.replace(/\s+/g, " ").trim();
}

const numberWords: Record<string, number> = {
  one: 1,
  ek: 1,
  first: 1,
  two: 2,
  do: 2,
  three: 3,
  teen: 3,
  four: 4,
  char: 4,
  chaar: 4,
  five: 5,
  paanch: 5,
  panch: 5,
  six: 6,
  che: 6,
  chhe: 6,
  seven: 7,
  saat: 7,
  eight: 8,
  aath: 8,
  nine: 9,
  nau: 9,
  ten: 10,
  das: 10,
  fifteen: 15,
  pandrah: 15,
  twenty: 20,
  bees: 20,
  thirty: 30,
  tees: 30,
  forty: 40,
  chalis: 40,
  fortyfive: 45,
  "forty-five": 45,
  paitalis: 45,
  sixty: 60,
  saath: 60
};

const amountPattern = "(\\d+|one|two|three|four|five|six|seven|eight|nine|ten|fifteen|twenty|thirty|forty|forty-five|fortyfive|sixty|ek|do|teen|char|chaar|paanch|panch|che|chhe|saat|aath|nau|das|pandrah|bees|tees|chalis|paitalis|saath)";

function parseAmount(value: string) {
  const normalized = value.toLowerCase().trim();
  return Number(normalized) || numberWords[normalized] || null;
}

function stripReminderWords(text: string) {
  return cleanSpaces(
    text
      .replace(/\b(tell me one thing|one thing|ek baat|ek cheez|by the way|btw|actually)\b/gi, " ")
      .replace(/\b(can you|could you|will you|would you|can u|could u)\b/gi, " ")
      .replace(/\b(please|pls)\b/gi, " ")
      .replace(/\b(mujhe|mere ko|me to)\b/gi, " ")
      .replace(/\b(remind me|remind|remember to|make me remember|mujhe remind|remind karna|remind kar|remind kr|yaad dilana|yaad dila dena|yaad dila|yaad kara dena|yaad kara|yaad karana)\b/gi, " ")
      .replace(new RegExp(`\\bevery\\s+${amountPattern}\\s*(minutes?|mins?|hours?|hrs?)\\b`, "gi"), " ")
      .replace(/\b(to|that|about)\b\s*/i, " ")
      .replace(new RegExp(`\\b(in|after)\\s+${amountPattern}\\s*(minutes?|mins?|hours?|hrs?)\\b`, "gi"), " ")
      .replace(new RegExp(`\\b${amountPattern}\\s*(minutes?|mins?|hours?|hrs?)\\s*(ke\\s*)?(baad|bad|later)\\b`, "gi"), " ")
      .replace(/\btomorrow\s+at\s+\d{1,2}(?::|\.)?\d{0,2}\s*(am|pm)?\b/gi, " ")
      .replace(/\bat\s+\d{1,2}(?::|\.)?\d{0,2}\s*(am|pm)?\b/gi, " ")
      .replace(/\bon\s+\d{1,2}(st|nd|rd|th)?\s+(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)\b/gi, " ")
      .replace(/\b(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)\s+\d{1,2}(st|nd|rd|th)?\b/gi, " ")
      .replace(/^(?:to|that|about)\s+/i, " ")
      .replace(/^(?:can|could|will|would|should)\s+(?:you|u)\s+/i, " ")
      .replace(/^(?:you|u)\s+/i, " ")
      .replace(/^[,;:\-\s]+/g, " ")
      .replace(/[?.!]+$/g, "")
  );
}

function titleFromReminder(text: string) {
  const title = stripReminderWords(text);
  return title || "check in";
}

function parseRelative(text: string, now: Date) {
  const afterFirst = text.match(new RegExp(`\\b(?:in|after)\\s+${amountPattern}\\s*(minutes?|mins?|hours?|hrs?)\\b`, "i"));
  const afterSecond = text.match(new RegExp(`\\b${amountPattern}\\s*(minutes?|mins?|hours?|hrs?)\\s*(?:ke\\s*)?(?:baad|bad|later)\\b`, "i"));
  const match = afterFirst ?? afterSecond;
  if (!match) return null;

  const amount = parseAmount(match[1]);
  if (!amount) return null;
  const unit = match[2].toLowerCase();
  return unit.startsWith("hour") || unit.startsWith("hr") ? addHours(now, amount) : addMinutes(now, amount);
}

function parseEvery(text: string, now: Date) {
  const every = text.match(new RegExp(`\\bevery\\s+${amountPattern}\\s*(minutes?|mins?|hours?|hrs?)\\b`, "i"));
  if (!every) return null;

  const amount = parseAmount(every[1]);
  if (!amount) return null;
  const unit = every[2].toLowerCase();
  const scheduledAt = unit.startsWith("hour") || unit.startsWith("hr") ? addHours(now, amount) : addMinutes(now, amount);
  const frequency = unit.startsWith("hour") || unit.startsWith("hr") ? "HOURLY" : "MINUTELY";
  return {
    scheduledAt,
    recurrenceRule: `FREQ=${frequency};INTERVAL=${amount}`
  };
}

function parseClock(text: string, timezone: string, now: Date) {
  const zone = timezone || "UTC";
  const tomorrowAt = text.match(/\btomorrow\s+at\s+(\d{1,2})(?:(?::|\.)(\d{2}))?\s*(am|pm)?\b/i);
  const atTime = text.match(/\bat\s+(\d{1,2})(?:(?::|\.)(\d{2}))?\s*(am|pm)?\b/i);
  const match = tomorrowAt ?? atTime;
  if (!match) return null;

  let hour = Number(match[1]);
  const minute = Number(match[2] ?? 0);
  const meridiem = match[3]?.toLowerCase();
  if (meridiem === "pm" && hour < 12) hour += 12;
  if (meridiem === "am" && hour === 12) hour = 0;

  const nowZoned = toZonedTime(now, zone);
  const base = tomorrowAt ? addDays(nowZoned, 1) : nowZoned;
  let local = set(base, { hours: hour, minutes: minute, seconds: 0, milliseconds: 0 });
  let scheduledAt = fromZonedTime(local, zone);
  if (!tomorrowAt && scheduledAt.getTime() <= now.getTime()) {
    local = addDays(local, 1);
    scheduledAt = fromZonedTime(local, zone);
  }
  return scheduledAt;
}

function parseDateOnly(text: string, timezone: string, now: Date) {
  const zone = timezone || "UTC";
  const numericFirst = text.match(/\b(?:on\s+)?(\d{1,2})(?:st|nd|rd|th)?\s+(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)(?:\s+(\d{4}))?\b/i);
  const monthFirst = text.match(/\b(?:on\s+)?(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(\d{4}))?\b/i);
  const match = numericFirst ?? monthFirst;
  if (!match) return null;

  const day = numericFirst ? Number(match[1]) : Number(match[2]);
  const monthName = numericFirst ? match[2] : match[1];
  const month = monthIndex[monthName.toLowerCase()];
  const nowZoned = toZonedTime(now, zone);
  let year = Number(numericFirst ? match[3] : match[3]) || nowZoned.getFullYear();
  let local = new Date(year, month, day, 9, 0, 0, 0);
  let scheduledAt = fromZonedTime(local, zone);
  if (!(numericFirst ? match[3] : match[3]) && scheduledAt.getTime() <= now.getTime()) {
    year += 1;
    local = new Date(year, month, day, 9, 0, 0, 0);
    scheduledAt = fromZonedTime(local, zone);
  }

  return scheduledAt;
}

function parseScheduledAt(text: string, timezone: string, now: Date) {
  const every = parseEvery(text, now);
  if (every) return every;
  const relative = parseRelative(text, now);
  if (relative) return { scheduledAt: relative, recurrenceRule: null };
  const clock = parseClock(text, timezone, now);
  if (clock) return { scheduledAt: clock, recurrenceRule: null };
  const dateOnly = parseDateOnly(text, timezone, now);
  if (dateOnly) return { scheduledAt: dateOnly, recurrenceRule: null };
  return { scheduledAt: addHours(now, 1), recurrenceRule: null };
}

function extractCheckInQuestion(text: string) {
  const delayedAsk = text.match(new RegExp(`\\bask me\\s+(?:in|after)\\s+${amountPattern}\\s*(?:minutes?|mins?|hours?|hrs?)\\s+if\\s+(.+)$`, "i"));
  const delayedAskSecond = text.match(new RegExp(`\\bask me\\s+${amountPattern}\\s*(?:minutes?|mins?|hours?|hrs?)\\s*(?:ke\\s*)?(?:baad|bad|later)\\s+if\\s+(.+)$`, "i"));
  const check = text.match(new RegExp(`\\b(?:ask me if|check if|check whether|check in(?: with me)?(?: about)?|follow up(?: with me)?(?: about)?)\\s+(.+?)(?:\\s+\\b(?:in|after)\\b\\s+${amountPattern}|\\s+${amountPattern}\\s*(?:minutes?|mins?|hours?|hrs?)\\s*(?:ke\\s*)?(?:baad|bad|later)|\\s+tomorrow|\\s+at\\s+\\d|\\s+on\\s+\\d|$)`, "i"));
  const raw = cleanSpaces(
    delayedAsk?.[delayedAsk.length - 1] ??
    delayedAskSecond?.[delayedAskSecond.length - 1] ??
    check?.[1] ??
    titleFromReminder(text)
  );
  const normalized = raw
    .replace(/^i\s+am\b/i, "you are")
    .replace(/^i'm\b/i, "you are")
    .replace(/^i\b/i, "you")
    .replace(/\bstill\b/i, "still")
    .replace(/[?.!]+$/g, "");

  if (/smoking weed|smoke weed|weed|high/i.test(raw)) return "Rihan, are you still smoking weed?";
  if (/^\bare you\b/i.test(normalized)) return `${normalized.replace(/[?.!]+$/g, "")}?`;
  if (/^\byou\b/i.test(normalized)) return `Rihan, are ${normalized.replace(/^you\b/i, "you").replace(/[?.!]+$/g, "")}?`;
  return `Rihan, should I check in about ${normalized}?`;
}

function isCheckIn(text: string) {
  return /\b(ask me if|ask me (?:in|after)|ask me .+ if|check if|check whether|check in|follow up)\b/i.test(text);
}

function notificationBodyFor(title: string, type: ReminderDraft["type"], question: string | null) {
  if (type === "check_in") return question ?? `Rihan, checking in: ${title}`;
  const clean = title.replace(/[?.!]+$/g, "");
  if (/^time to\b/i.test(clean)) return `Hey Rihan, ${clean}.`;
  if (/^(drink|call|read|take|do|go|check|buy|send|write|finish|start|stop|work|meditate|exercise|walk|eat)\b/i.test(clean)) {
    return `Hey Rihan, time to ${clean}.`;
  }
  return `Hey Rihan, reminder: ${clean}.`;
}

export function parseNaturalReminder(text: string, timezone: string): ReminderDraft {
  const now = new Date();
  const parsed = parseScheduledAt(text, timezone, now);
  const type: ReminderDraft["type"] = isCheckIn(text) ? "check_in" : "simple_reminder";
  const title = titleFromReminder(text);
  const promptQuestion = type === "check_in" ? extractCheckInQuestion(text) : null;
  const notificationBody = notificationBodyFor(title, type, promptQuestion);

  return {
    type,
    title,
    scheduledAt: parsed.scheduledAt.toISOString(),
    recurrenceRule: parsed.recurrenceRule,
    timezone,
    promptQuestion,
    originalText: text,
    notificationBody,
    responseGuidance: type === "check_in"
      ? "Respond supportively and harm-reduction focused. Do not shame the user."
      : null
  };
}

export function describeReminderTime(scheduledAt: string, timezone: string) {
  return formatInTimeZone(new Date(scheduledAt), timezone || "UTC", "yyyy-MM-dd HH:mm");
}
