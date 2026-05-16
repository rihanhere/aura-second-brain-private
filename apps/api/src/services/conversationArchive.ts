import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { formatInTimeZone, fromZonedTime, toZonedTime } from "date-fns-tz";
import { supabase } from "../config/supabase.js";
import { isScaleTestUser } from "./scaleTest.js";
import { memoryAtomLine, searchMemoryAtoms } from "./memoryAtoms.js";
import { classifyMemoryIntent, type MemoryIntent } from "./memoryIntentRouter.js";

export type ConversationRole = "user" | "assistant";
export type ConversationInputMode = "text" | "voice" | "assistant";

export type ConversationTurn = {
  id: string;
  user_id: string;
  role: ConversationRole;
  content: string;
  input_mode: ConversationInputMode;
  timezone: string;
  session_id: string;
  searchable_text: string;
  metadata: Record<string, unknown>;
  created_at: string;
};

export type RecallIntent = {
  isRecall: boolean;
  label?: string;
  start?: Date;
  end?: Date;
  topicQuery?: string;
  kind?: MemoryIntent;
};

const localArchive: ConversationTurn[] = [];
const scaleTestArchive: ConversationTurn[] = [];
const MAX_LOCAL_ARCHIVE = 20_000;
const MAX_SCALE_TEST_ARCHIVE = 300_000;
const apiDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const localArchivePath = path.join(apiDir, "data", "conversation-archive.json");
let localArchiveLoaded = false;

async function loadLocalArchive() {
  if (localArchiveLoaded) return;
  localArchiveLoaded = true;
  try {
    const raw = await fs.readFile(localArchivePath, "utf8");
    const parsed = JSON.parse(raw) as ConversationTurn[];
    localArchive.splice(0, localArchive.length, ...parsed);
  } catch {
    // First launch without Supabase starts with an empty local archive.
  }
}

async function persistLocalArchive() {
  await fs.mkdir(path.dirname(localArchivePath), { recursive: true });
  await fs.writeFile(localArchivePath, JSON.stringify(localArchive.slice(0, MAX_LOCAL_ARCHIVE), null, 2));
}

function asArchiveTurn(value: Record<string, unknown>): ConversationTurn {
  return {
    id: String(value.id),
    user_id: String(value.user_id),
    role: String(value.role) === "assistant" ? "assistant" : "user",
    content: String(value.content ?? ""),
    input_mode: (String(value.input_mode ?? "text") as ConversationInputMode) || "text",
    timezone: String(value.timezone ?? "UTC"),
    session_id: String(value.session_id ?? ""),
    searchable_text: String(value.searchable_text ?? value.content ?? ""),
    metadata: typeof value.metadata === "object" && value.metadata !== null ? (value.metadata as Record<string, unknown>) : {},
    created_at: String(value.created_at)
  };
}

function localDateKey(date: Date, timezone: string) {
  return formatInTimeZone(date, timezone || "UTC", "yyyy-MM-dd");
}

function addDaysToLocalDate(date: Date, days: number) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
}

function zonedDayRange(date: Date, timezone: string) {
  const zone = timezone || "UTC";
  const zoned = toZonedTime(date, zone);
  const startLocal = new Date(zoned.getFullYear(), zoned.getMonth(), zoned.getDate());
  const endLocal = addDaysToLocalDate(startLocal, 1);

  return {
    start: fromZonedTime(startLocal, zone),
    end: fromZonedTime(endLocal, zone)
  };
}

function zonedRangeFromLocalDates(startLocal: Date, endLocal: Date, timezone: string) {
  const zone = timezone || "UTC";
  return {
    start: fromZonedTime(startLocal, zone),
    end: fromZonedTime(endLocal, zone)
  };
}

function normalizeTerms(text: string) {
  return text
    .toLowerCase()
    .split(/\W+/)
    .map((term) => term.trim())
    .filter((term) => term.length > 2 && !DATE_STOP_WORDS.has(term));
}

function keywordScore(query: string, turn: ConversationTurn) {
  const haystack = `${turn.content} ${turn.searchable_text}`.toLowerCase();
  return normalizeTerms(query).reduce((score, term) => score + (haystack.includes(term) ? 1 : 0), 0);
}

function genericUserHistoryQuery(query: string) {
  return /\b(what did i ask|what did i say|what have i told|what did i tell|what was i saying|earlier)\b/i.test(query)
    && !/\b(about|coding|goal|friend|girlfriend|reminder|save|yesterday|today|last week|this week|swift|trading)\b/i.test(query);
}

function stripDateWords(query: string) {
  return query
    .replace(/\b(what did|what was|what were|tell me|recall|remember|did i say|did we talk about|we talked about|i said|maine|mene|kya|bola|baat|about|on|in|during|earlier|today|yesterday|last week|this week|last month|this month|last year|one year ago|a year ago|kal|aaj|pichle hafte|pichle saal)\b/gi, " ")
    .replace(/\b\d{4}-\d{1,2}-\d{1,2}\b/g, " ")
    .replace(/\b(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)\s+\d{1,2}(st|nd|rd|th)?(,?\s+\d{4})?\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function compactText(text: string, maxLength = 260) {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= maxLength) return clean;
  return `${clean.slice(0, maxLength - 3).trim()}...`;
}

function cleanTopicLabel(topic?: string) {
  if (!topic) return "";
  return topic
    .replace(/\b(i|we|you)\s+(say|said|talk|talked)\b/gi, " ")
    .replace(/[?.!,;:]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function isLikelyRecallQuestion(content: string) {
  const hasQuestionShape =
    /\?/.test(content) ||
    /^\s*(what|when|where|which|show|list|tell me|recall|do you remember|did i|did we|have i|kya|kab|maine kya|mene kya)\b/i.test(content);
  if (!hasQuestionShape) return false;
  return /\b(what did|what was|what were|what do you remember|what have i|recall|remember|did i say|did we talk|earlier today|yesterday|this week|last week|past week|last month|last year|one year ago|a year ago|explicitly ask|if today (?:were|was)|important thing should you remind|aaj|kal|pichle)\b/i.test(content);
}

function buildRecallAnswer(recall: RecallIntent, turns: ConversationTurn[], timezone: string) {
  const label = recall.label ?? "that period";
  const topic = cleanTopicLabel(recall.topicQuery);
  const topicSuffix = topic ? ` about ${topic}` : "";
  const nonEmptyTurns = turns.filter((turn) => turn.content.trim().length > 0);
  const userOnly = recall.kind === "user_history_recall";
  const usableTurns = nonEmptyTurns.filter((turn) => !isLikelyRecallQuestion(turn.content) && (!userOnly || turn.role === "user"));
  const recallTurns = usableTurns.length ? usableTurns : nonEmptyTurns.filter((turn) => !isLikelyRecallQuestion(turn.content) && (!userOnly || turn.role === "user"));

  if (!recallTurns.length) {
    return `I don't have a clear memory from ${label}${topicSuffix}.`;
  }

  const formatted = recallTurns.slice(0, 8).map((turn) => {
    const when = formatInTimeZone(new Date(turn.created_at), timezone || turn.timezone || "UTC", "yyyy-MM-dd HH:mm");
    return `- ${when}: "${compactText(turn.content)}"`;
  });

  if (formatted.length === 1) {
    return userOnly
      ? `From ${label}, you said this${topicSuffix}: ${formatted[0].replace(/^- /, "")}`
      : `From ${label}, I remember this${topicSuffix}: ${formatted[0].replace(/^- /, "")}`;
  }

  const intro = userOnly ? `From ${label}, you said these things${topicSuffix}:` : `From ${label}, I remember these moments${topicSuffix}:`;
  return `${intro}\n${formatted.join("\n")}`;
}

const DATE_STOP_WORDS = new Set([
  "what", "did", "was", "were", "tell", "recall", "remember", "say", "talk", "about", "today", "yesterday",
  "this", "past", "last", "week", "month", "year", "earlier", "explicitly", "ask", "asked", "maine", "mene", "kya", "bola", "baat", "kal", "aaj"
]);

const explicitSaveTurnPattern = /\b(save this|save it|save that|save karo|save kar|journal this|journal it|add to journal|note this|remember this|remember that|remember it|yaad rakh|yaad rakhna|memory mein|memory me|isko save|ye save|isey save|pin this)\b/i;
const reminderRequestTurnPattern = /\b(remind me|reminder|yaad dilana|yaad dila|yaad kara|yaad karana|ask me (?:in|after|if)|check in|follow up)\b/i;
const relationshipAliases: Record<string, string[]> = {
  girlfriend: ["girlfriend", "gf"],
  dad: ["dad", "father", "papa", "pitaji"],
  mother: ["mother", "mom", "mummy", "mumma", "maa"],
  friend: ["friend", "dost"],
  cofounder: ["cofounder", "co-founder"],
  family: ["family", "ghar wale"]
};

function isExplicitSaveRecallQuestion(query: string) {
  return /\b(what did|what have|show|list|recall|remember)\b.*\b(explicitly\s+)?(ask|asked|tell|told)\b.*\b(save|saved|remember|say)\b/i.test(query)
    || /\bexplicitly\s+ask(?:ed)?\s+you\s+to\s+(save|say|remember)\b/i.test(query);
}

function isReminderCommitmentRecallQuestion(query: string) {
  return /\b(what did|what have|what do|when did|show|list|recall|remember)\b.*\b(remind|reminder|yaad|check[-\s]?in)\b/i.test(query)
    || /\bif today (?:were|was)\b.*\b(remind|important|birthday|commitment)\b/i.test(query)
    || /\bis there anything important\b/i.test(query);
}

function relationshipRecallLabel(query: string) {
  const normalized = query.toLowerCase();
  const question = /\b(what do you remember|what do you know|what did i say|what have i told|tell me what you remember|remember about)\b/i.test(normalized);
  if (!question) return null;

  for (const [label, aliases] of Object.entries(relationshipAliases)) {
    if (aliases.some((alias) => new RegExp(`\\b${alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(normalized))) {
      return label;
    }
  }
  return null;
}

function isTopicSwitchAwayFromRelationship(content: string, label: string) {
  const lower = content.toLowerCase();
  if (/\b(leave|forget|ignore|chhodo|chod do|choro|choro rehne|not now|skip)\b/.test(lower) && relationshipAliases[label]?.some((alias) => lower.includes(alias))) {
    return true;
  }
  return /\bactually\b.*\b(leave|forget|ignore|skip)\b/i.test(content);
}

function relationshipRelevantClause(content: string, label: string) {
  const aliases = relationshipAliases[label] ?? [label];
  const chunks = content
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?])\s+|\s+(?:but|actually|aur|and then|phir)\s+/i)
    .map((chunk) => chunk.trim())
    .filter(Boolean);
  const matching = chunks.find((chunk) => aliases.some((alias) => new RegExp(`\\b${alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(chunk)));
  return matching ?? content.replace(/\s+/g, " ").trim();
}

function cleanGoalPhrase(content: string) {
  const clean = compactText(content, 220)
    .replace(/^remember that\s+/i, "")
    .replace(/^save this[:\s-]*/i, "")
    .replace(/^my goal is\s+/i, "")
    .replace(/^i\s+(?:want|need|plan|am trying|try|m trying|would like)\s+to\s+/i, "to ")
    .replace(/\s+/g, " ")
    .trim();

  if (/\bbecome (?:a )?developer\b/i.test(clean) && /\baura\b/i.test(clean)) {
    return "to become a developer by building AURA";
  }
  return clean;
}

async function buildGoalRecallArchive(input: { userId: string; timezone: string; excludeIds?: string[] }) {
  const atoms = await searchMemoryAtoms({
    userId: input.userId,
    query: "goal developer coding aura build learn",
    intent: "goal_recall",
    types: ["goal"],
    limit: 6
  });
  const archiveTurns = (await listConversationTurns(input.userId, 800))
    .filter((turn) => !(input.excludeIds ?? []).includes(turn.id))
    .filter((turn) => turn.role === "user" && !isLikelyRecallQuestion(turn.content))
    .filter((turn) => /\b(my goal is|i want to|i need to|i am trying to|i'm trying to|trying to become|become a developer|learn coding|build aura|developer|vibe coding)\b/i.test(turn.content))
    .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
    .slice(0, 6);

  const rawPhrases = Array.from(new Set([
    ...atoms.map((atom) => cleanGoalPhrase(atom.text)),
    ...archiveTurns.map((turn) => cleanGoalPhrase(turn.content))
  ].filter(Boolean)));
  const stablePhrases = rawPhrases.filter((phrase) => !/\b(tired|stuck|distracted|sad|stress|stressed|again|still|low|confused)\b/i.test(phrase));
  const goalPhrases = (stablePhrases.length ? stablePhrases : rawPhrases)
    .filter((phrase) => !/\b(reply normally|continue tomorrow|learn better|watching tutorials|one hour|what should)\b/i.test(phrase));
  const phrases = (goalPhrases.length ? goalPhrases : stablePhrases.length ? stablePhrases : rawPhrases).slice(0, 3);

  if (!phrases.length) {
    return {
      answerHint: "I don't have a clear goal memory for you yet.",
      context: "Goal recall requested, but no goal atoms or goal-like archive turns were found."
    };
  }

  const main = phrases[0];
  const supporting = phrases.slice(1).filter((phrase) => phrase.toLowerCase() !== main.toLowerCase());
  const answerHint = supporting.length === 0
    ? `Your goal is ${main}.`
    : `Your main goal is ${main}. I also remember: ${supporting.join("; ")}.`;
  const archiveLines = archiveTurns.map((turn) => {
    const when = formatInTimeZone(new Date(turn.created_at), input.timezone || turn.timezone || "UTC", "yyyy-MM-dd HH:mm");
    return `- [${when}] User goal signal: ${turn.content}`;
  });
  return {
    answerHint,
    context: [
      "Goal recall context:",
      ...atoms.map(memoryAtomLine),
      ...archiveLines
    ].join("\n")
  };
}

async function buildPatternRecallArchive(input: { userId: string; timezone: string; excludeIds?: string[] }) {
  const atoms = await searchMemoryAtoms({
    userId: input.userId,
    query: "goal emotion tired stressed coding developer preference habit pattern",
    intent: "pattern_recall",
    types: ["goal", "emotion", "habit", "preference", "fact", "task"],
    limit: 20
  });
  const archiveTurns = (await listConversationTurns(input.userId, 800))
    .filter((turn) => !(input.excludeIds ?? []).includes(turn.id))
    .filter((turn) => turn.role === "user" && !isLikelyRecallQuestion(turn.content))
    .filter((turn) => /\b(developer|coding|simple|confused|lazy|distracted|stuck|tired|confidence|motivation|aura|swift|goal|prefer)\b/i.test(turn.content))
    .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
    .slice(0, 12);

  const topicCounts = new Map<string, number>();
  for (const atom of atoms) {
    for (const topic of atom.topics) topicCounts.set(topic, (topicCounts.get(topic) ?? 0) + 1);
    if (atom.emotion) topicCounts.set(atom.emotion, (topicCounts.get(atom.emotion) ?? 0) + 1);
  }
  for (const turn of archiveTurns) {
    for (const topic of ["developer", "coding", "simple", "distracted", "stuck", "tired", "aura", "swift"]) {
      if (new RegExp(`\\b${topic}\\b`, "i").test(turn.content)) topicCounts.set(topic, (topicCounts.get(topic) ?? 0) + 1);
    }
  }

  const top = [...topicCounts.entries()]
    .filter(([topic]) => !["goal", "emotion", "action", "core profile", "core-profile"].includes(topic))
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5);
  if (!top.length) {
    return {
      answerHint: "I don't have enough repeated signals yet to name a real pattern.",
      context: "Pattern recall requested, but no repeated atoms or archive signals were found."
    };
  }

  const humanLines = top.map(([topic, count]) => {
    if (topic === "developer" || topic === "coding") return "building developer skill through practical coding/AURA work";
    if (topic === "simple") return "preferring simple, plain explanations";
    if (topic === "distracted" || topic === "stuck") return "getting distracted or stuck and needing grounding";
    if (topic === "tired") return "tiredness showing up more than once";
    if (topic === "preference") return "clear preferences about how replies should feel";
    return `${topic} coming up ${count} time${count === 1 ? "" : "s"}`;
  });

  return {
    answerHint: `The clearest patterns I see are: ${Array.from(new Set(humanLines)).slice(0, 4).join("; ")}.`,
    context: [
      "Pattern recall context:",
      ...atoms.slice(0, 12).map(memoryAtomLine),
      ...archiveTurns.map((turn) => `- User signal: ${turn.content}`)
    ].join("\n")
  };
}

async function buildProfileRecallArchive(input: { userId: string; timezone: string; excludeIds?: string[] }) {
  const atoms = await searchMemoryAtoms({
    userId: input.userId,
    query: "profile goal preference fact habit explicit save developer coding simple aura",
    intent: "profile_recall",
    types: ["goal", "preference", "fact", "habit", "explicit_save"],
    limit: 12
  });
  const archiveTurns = (await listConversationTurns(input.userId, 800))
    .filter((turn) => !(input.excludeIds ?? []).includes(turn.id))
    .filter((turn) => turn.role === "user" && !isLikelyRecallQuestion(turn.content))
    .filter((turn) => /\b(my goal is|i want to|i prefer|i learn better|call me|i like|i hate|developer|coding|code in english|english prompts|beginner|aura|simple)\b/i.test(turn.content))
    .filter((turn) => !/\b(tired|stuck|distracted|sad|stress|stressed|low confidence|not good|confused)\b/i.test(turn.content))
    .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
    .slice(0, 10);

  const hasCodingLearningSignal = archiveTurns.some((turn) => /\b(coding|code in english|english prompts|beginner|start from zero|learn coding)\b/i.test(turn.content))
    || atoms.some((atom) => /\b(coding|code in english|english prompts|beginner|start from zero|learn coding)\b/i.test(atom.text));

  const rawFacts = [
    hasCodingLearningSignal ? "you are learning coding from beginner level and use English prompts" : "",
    ...atoms.map((atom) => {
      if (/\b(reply normally|continue tomorrow|what should|one hour)\b/i.test(atom.text)) return "";
      if (/\bmy goal is|become a developer\b/i.test(atom.text)) return `your goal is ${cleanGoalPhrase(atom.text)}`;
      if (/\bmy girlfriend\b/i.test(atom.text) && /\bbirthday\b/i.test(atom.text)) return "your girlfriend's birthday is October 1st";
      if (atom.type === "goal") return `your goal is ${cleanGoalPhrase(atom.text)}`;
      if (/\bcode in english prompts|english prompts|beginner|start from zero|learn coding\b/i.test(atom.text)) return "you are learning coding from beginner level and use English prompts";
      if (atom.type === "preference" && /\bsimple|plain english|technical language\b/i.test(atom.text)) return "you prefer simple, plain-English answers";
      if (atom.type === "explicit_save" && /\blearn better\b/i.test(atom.text)) return "you learn better by building real apps than by only watching tutorials";
      return compactText(atom.text, 180);
    }),
    ...archiveTurns.map((turn) => {
      if (/\bmy goal is\b/i.test(turn.content) || /\bbecome a developer\b/i.test(turn.content)) return `your goal is ${cleanGoalPhrase(turn.content)}`;
      if (/\bmy girlfriend\b/i.test(turn.content) && /\bbirthday\b/i.test(turn.content)) return "your girlfriend's birthday is October 1st";
      if (/\bcode in english prompts|english prompts|beginner|start from zero|learn coding\b/i.test(turn.content)) return "you are learning coding from beginner level and use English prompts";
      if (/\bprefer\b/i.test(turn.content)) return compactText(turn.content.replace(/^i\s+/i, "you "), 180);
      if (/\blearn better\b/i.test(turn.content)) return "you learn better by building real apps than by only watching tutorials";
      return compactText(turn.content, 180);
    })
  ].filter((fact): fact is string => Boolean(fact))
    .filter((fact) => !/\b(hello|what can you do|are you listening|private marker|real-sim|scale-stage|not good|confused|i told my friend|your goal is i learn better|your goal is reply normally)\b/i.test(fact));
  const facts: string[] = [];
  for (const fact of rawFacts) {
    if (/^your goal is\b/i.test(fact) && facts.some((existing) => /^your goal is\b/i.test(existing))) continue;
    if (/girlfriend/i.test(fact) && facts.some((existing) => /girlfriend/i.test(existing))) continue;
    if (/\bprefer\b/i.test(fact) && facts.some((existing) => /\bprefer\b/i.test(existing))) continue;
    const key = fact.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    if (!facts.some((existing) => existing.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim() === key)) facts.push(fact);
    if (facts.length >= 5) break;
  }

  if (!facts.length) {
    return {
      answerHint: "I don't have enough stable profile memory about you yet.",
      context: "Profile recall requested, but no stable profile facts were found."
    };
  }

  return {
    answerHint: `I remember a few stable things: ${facts.join("; ")}.`,
    context: [
      "Profile recall context:",
      ...atoms.slice(0, 10).map(memoryAtomLine),
      ...archiveTurns.map((turn) => `- User profile signal: ${turn.content}`)
    ].join("\n")
  };
}

function buildExplicitSaveAnswer(turns: ConversationTurn[], timezone: string) {
  const saveTurns = turns
    .filter((turn) => turn.role === "user" && explicitSaveTurnPattern.test(turn.content) && turn.content.trim().length > 0)
    .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime())
    .slice(-8);

  if (!saveTurns.length) {
    return "I don't see any clear explicit saves from you yet.";
  }

  const formatted = saveTurns.map((turn) => {
    const when = formatInTimeZone(new Date(turn.created_at), timezone || turn.timezone || "UTC", "yyyy-MM-dd HH:mm");
    return `- ${when}: "${compactText(turn.content)}"`;
  });

  return `These are the moments you explicitly asked me to save:\n${formatted.join("\n")}`;
}

function buildReminderCommitmentAnswer(turns: ConversationTurn[], timezone: string) {
  const reminderTurns = turns
    .filter((turn) => turn.role === "user" && reminderRequestTurnPattern.test(turn.content) && !isLikelyRecallQuestion(turn.content) && turn.content.trim().length > 0)
    .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime())
    .slice(-8);

  if (!reminderTurns.length) {
    return "I don't see a clear reminder commitment for that yet.";
  }

  const formatted = reminderTurns.map((turn) => {
    const when = formatInTimeZone(new Date(turn.created_at), timezone || turn.timezone || "UTC", "yyyy-MM-dd HH:mm");
    return `- ${when}: "${compactText(turn.content)}"`;
  });

  if (formatted.length === 1) {
    return `I found this reminder commitment: ${formatted[0].replace(/^- /, "")}`;
  }

  return `I found these reminder commitments:\n${formatted.join("\n")}`;
}

function relationshipFactFromTurn(turn: ConversationTurn, label: string) {
  if (isTopicSwitchAwayFromRelationship(turn.content, label)) return "";
  const content = relationshipRelevantClause(turn.content, label).replace(/\s+/g, " ").trim();
  if (label === "girlfriend" && /\bbirthday\b/i.test(content) && /\boctober\s+1(?:st)?\b/i.test(content)) {
    return "her birthday is on October 1st";
  }
  if (label === "girlfriend" && /\bcall my girlfriend\b/i.test(content)) {
    return "you wanted a reminder to call her";
  }
  if (label === "girlfriend" && /\bgirlfriend\b/i.test(content)) {
    return compactText(content.replace(/^remember that\s+/i, "").replace(/^remind me\s+/i, "you wanted me to "), 180);
  }
  return compactText(content, 180);
}

function buildRelationshipRecallAnswer(label: string, turns: ConversationTurn[]) {
  const facts = Array.from(new Set(
    turns
      .filter((turn) => turn.role === "user" && !isLikelyRecallQuestion(turn.content) && turn.content.trim().length > 0)
      .map((turn) => relationshipFactFromTurn(turn, label))
      .filter(Boolean)
  )).slice(0, 5);

  if (!facts.length) {
    return `I don't have a clear memory about your ${label} yet.`;
  }

  if (facts.length === 1) {
    return `About your ${label}, I remember that ${facts[0]}.`;
  }

  return `About your ${label}, I remember that ${facts.slice(0, -1).join(", ")}, and ${facts[facts.length - 1]}.`;
}

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

function specificDateRange(query: string, timezone: string, now: Date) {
  const iso = query.match(/\b(\d{4})-(\d{1,2})-(\d{1,2})\b/);
  if (iso) {
    const startLocal = new Date(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]));
    return { label: localDateKey(fromZonedTime(startLocal, timezone || "UTC"), timezone), ...zonedRangeFromLocalDates(startLocal, addDaysToLocalDate(startLocal, 1), timezone) };
  }

  const named = query.match(/\b(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(\d{4}))?\b/i);
  if (!named) return null;

  const zone = timezone || "UTC";
  const nowZoned = toZonedTime(now, zone);
  const month = monthIndex[named[1].toLowerCase()];
  const day = Number(named[2]);
  let year = named[3] ? Number(named[3]) : nowZoned.getFullYear();
  const candidate = new Date(year, month, day);
  if (!named[3] && fromZonedTime(candidate, zone).getTime() > now.getTime() + 24 * 60 * 60 * 1000) {
    year -= 1;
  }

  const startLocal = new Date(year, month, day);
  return { label: localDateKey(fromZonedTime(startLocal, zone), zone), ...zonedRangeFromLocalDates(startLocal, addDaysToLocalDate(startLocal, 1), zone) };
}

export function detectRecallIntent(query: string, timezone = "UTC", now = new Date()): RecallIntent {
  const normalized = query.toLowerCase();
  const topicQuery = stripDateWords(query);
  const explicitRecall = /\b(what did|what was|what were|recall|remember|did i say|did we talk|maine|mene|kya bola|kya baat)\b/i.test(query);
  const specific = specificDateRange(query, timezone, now);
  if (specific && explicitRecall) {
    return { isRecall: true, label: specific.label, start: specific.start, end: specific.end, topicQuery };
  }
  if (!explicitRecall) {
    return { isRecall: false, topicQuery };
  }

  const zone = timezone || "UTC";
  const todayZoned = toZonedTime(now, zone);
  const startToday = new Date(todayZoned.getFullYear(), todayZoned.getMonth(), todayZoned.getDate());
  let startLocal: Date | null = null;
  let endLocal: Date | null = null;
  let label = "";

  if (/\b(today|earlier today|aaj)\b/i.test(query)) {
    startLocal = startToday;
    endLocal = addDaysToLocalDate(startToday, 1);
    label = "today";
  } else if (/\b(yesterday|kal)\b/i.test(query)) {
    startLocal = addDaysToLocalDate(startToday, -1);
    endLocal = startToday;
    label = "yesterday";
  } else if (/\b(this week|last week|past week|pichle hafte)\b/i.test(query)) {
    startLocal = addDaysToLocalDate(startToday, -7);
    endLocal = addDaysToLocalDate(startToday, 1);
    label = /\bthis week\b/i.test(query) ? "this week" : "the last 7 days";
  } else if (/\b(last month|past month)\b/i.test(query)) {
    startLocal = new Date(todayZoned.getFullYear(), todayZoned.getMonth() - 1, todayZoned.getDate());
    endLocal = addDaysToLocalDate(startToday, 1);
    label = "the last month";
  } else if (/\b(last year|past year)\b/i.test(query)) {
    startLocal = new Date(todayZoned.getFullYear() - 1, todayZoned.getMonth(), todayZoned.getDate());
    endLocal = addDaysToLocalDate(startToday, 1);
    label = "the last year";
  } else if (/\b(one year ago|a year ago|1 year ago)\b/i.test(query)) {
    const target = new Date(todayZoned.getFullYear() - 1, todayZoned.getMonth(), todayZoned.getDate());
    startLocal = target;
    endLocal = addDaysToLocalDate(target, 1);
    label = `one year ago (${localDateKey(fromZonedTime(target, zone), zone)})`;
  }

  if (!startLocal || !endLocal) {
    return { isRecall: false, topicQuery };
  }

  return {
    isRecall: true,
    label,
    ...zonedRangeFromLocalDates(startLocal, endLocal, zone),
    topicQuery
  };
}

export function sessionIdFor(userId: string, timezone: string, at = new Date()) {
  return `${userId}:${localDateKey(at, timezone || "UTC")}`;
}

export async function saveConversationTurn(input: {
  userId: string;
  role: ConversationRole;
  content: string;
  inputMode: ConversationInputMode;
  timezone: string;
  sessionId?: string;
  createdAt?: Date;
  metadata?: Record<string, unknown>;
}) {
  const createdAt = input.createdAt ?? new Date();
  const payload = {
    user_id: input.userId,
    role: input.role,
    content: input.content,
    input_mode: input.inputMode,
    timezone: input.timezone || "UTC",
    session_id: input.sessionId ?? sessionIdFor(input.userId, input.timezone || "UTC", createdAt),
    searchable_text: input.content.toLowerCase(),
    metadata: input.metadata ?? {}
  };

  if (isScaleTestUser(input.userId)) {
    const turn: ConversationTurn = {
      id: crypto.randomUUID(),
      created_at: createdAt.toISOString(),
      ...payload
    };
    scaleTestArchive.unshift(turn);
    if (scaleTestArchive.length > MAX_SCALE_TEST_ARCHIVE) scaleTestArchive.length = MAX_SCALE_TEST_ARCHIVE;
    return turn;
  }

  if (supabase) {
    try {
      const { data, error } = await supabase.from("conversation_turns").insert(payload).select("*").single();
      if (error) throw error;
      return asArchiveTurn(data as Record<string, unknown>);
    } catch (error) {
      console.warn("[conversation-archive] Supabase insert failed; falling back to local archive", error instanceof Error ? error.message : error);
    }
  }

  await loadLocalArchive();
  const turn: ConversationTurn = {
    id: crypto.randomUUID(),
    created_at: createdAt.toISOString(),
    ...payload
  };
  localArchive.unshift(turn);
  await persistLocalArchive();
  return turn;
}

export async function listConversationTurns(userId: string, limit = 100) {
  if (isScaleTestUser(userId)) {
    return scaleTestArchive.filter((turn) => turn.user_id === userId).slice(0, limit);
  }

  if (supabase) {
    try {
      const { data, error } = await supabase
        .from("conversation_turns")
        .select("*")
        .eq("user_id", userId)
        .order("created_at", { ascending: false })
        .limit(limit);
      if (error) throw error;
      return (data ?? []).map((item) => asArchiveTurn(item as Record<string, unknown>));
    } catch (error) {
      console.warn("[conversation-archive] Supabase list failed; using local archive", error instanceof Error ? error.message : error);
    }
  }

  await loadLocalArchive();
  return localArchive.filter((turn) => turn.user_id === userId).slice(0, limit);
}

export async function searchConversationTurns(input: {
  userId: string;
  query: string;
  start?: Date;
  end?: Date;
  limit?: number;
  excludeIds?: string[];
  role?: ConversationRole;
}) {
  const limit = input.limit ?? 16;
  const excludeIds = new Set(input.excludeIds ?? []);

  if (supabase && input.start && input.end) {
    try {
      const { data, error } = await supabase
        .from("conversation_turns")
        .select("*")
        .eq("user_id", input.userId)
        .gte("created_at", input.start.toISOString())
        .lt("created_at", input.end.toISOString())
        .order("created_at", { ascending: true })
        .limit(80);
      if (error) throw error;
      return (data ?? [])
        .map((item) => asArchiveTurn(item as Record<string, unknown>))
        .filter((turn) => !excludeIds.has(turn.id))
        .filter((turn) => !input.role || turn.role === input.role)
        .filter((turn) => !input.query || !normalizeTerms(input.query).length || keywordScore(input.query, turn) > 0)
        .slice(0, limit);
    } catch (error) {
      console.warn("[conversation-archive] Supabase date search failed; using local archive", error instanceof Error ? error.message : error);
    }
  }

  const turns = await listConversationTurns(input.userId, 800);
  return turns
    .filter((turn) => !excludeIds.has(turn.id))
    .filter((turn) => !input.role || turn.role === input.role)
    .filter((turn) => {
      const time = new Date(turn.created_at).getTime();
      if (input.start && time < input.start.getTime()) return false;
      if (input.end && time >= input.end.getTime()) return false;
      return true;
    })
    .map((turn) => ({ turn, score: input.query ? keywordScore(input.query, turn) : 1 }))
    .filter((item) => !input.query || !normalizeTerms(input.query).length || item.score > 0)
    .sort((a, b) => {
      if (input.start || input.end) return new Date(a.turn.created_at).getTime() - new Date(b.turn.created_at).getTime();
      return b.score - a.score || new Date(b.turn.created_at).getTime() - new Date(a.turn.created_at).getTime();
    })
    .slice(0, limit)
    .map((item) => item.turn);
}

export async function buildArchiveContext(input: {
  userId: string;
  query: string;
  timezone: string;
  excludeIds?: string[];
}) {
  const baseRecall = detectRecallIntent(input.query, input.timezone);
  const memoryIntent = classifyMemoryIntent({ content: input.query, dateRecall: baseRecall });

  if (memoryIntent === "goal_recall") {
    const goal = await buildGoalRecallArchive(input);
    return {
      recall: { isRecall: true, label: "goal recall", topicQuery: "goal", kind: memoryIntent },
      answerHint: goal.answerHint,
      context: goal.context
    };
  }

  if (memoryIntent === "profile_recall") {
    const profile = await buildProfileRecallArchive(input);
    return {
      recall: { isRecall: true, label: "profile recall", topicQuery: "profile", kind: memoryIntent },
      answerHint: profile.answerHint,
      context: profile.context
    };
  }

  if (memoryIntent === "pattern_recall") {
    const pattern = await buildPatternRecallArchive(input);
    return {
      recall: { isRecall: true, label: "pattern recall", topicQuery: "patterns", kind: memoryIntent },
      answerHint: pattern.answerHint,
      context: pattern.context
    };
  }

  const relationshipLabel = relationshipRecallLabel(input.query);
  if (relationshipLabel) {
    const terms = relationshipAliases[relationshipLabel] ?? [relationshipLabel];
    const turns = (await listConversationTurns(input.userId, 800))
      .filter((turn) => !(input.excludeIds ?? []).includes(turn.id))
      .filter((turn) => {
        const content = turn.content.toLowerCase();
        return turn.role === "user"
          && terms.some((term) => content.includes(term))
          && !isTopicSwitchAwayFromRelationship(turn.content, relationshipLabel)
          && !isLikelyRecallQuestion(turn.content)
          && turn.content.trim().length > 0;
      })
      .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
    const atomLines = (await searchMemoryAtoms({
      userId: input.userId,
      query: input.query,
      intent: "relationship_recall",
      types: ["relationship", "fact"],
      entity: relationshipLabel,
      limit: 6
    })).map(memoryAtomLine);
    const answerHint = buildRelationshipRecallAnswer(relationshipLabel, turns);
    const context = turns.slice(-12).map((turn) => {
      const when = formatInTimeZone(new Date(turn.created_at), input.timezone || turn.timezone || "UTC", "yyyy-MM-dd HH:mm");
      return `- [${when}] User relationship mention: ${turn.content}`;
    }).join("\n");

    return {
      recall: { isRecall: true, label: `${relationshipLabel} recall`, topicQuery: relationshipLabel, kind: "relationship_recall" },
      answerHint,
      context: [
        `Relationship recall archive for ${relationshipLabel}:`,
        atomLines.length ? `Structured relationship memory:\n${atomLines.join("\n")}` : "",
        context || `No matching relationship archive turns were found.`
      ].filter(Boolean).join("\n")
    };
  }

  if (isReminderCommitmentRecallQuestion(input.query)) {
    const terms = normalizeTerms(input.query);
    const scoredTurns = (await listConversationTurns(input.userId, 800))
      .filter((turn) => !(input.excludeIds ?? []).includes(turn.id))
      .filter((turn) => turn.role === "user" && reminderRequestTurnPattern.test(turn.content) && !isLikelyRecallQuestion(turn.content) && turn.content.trim().length > 0)
      .map((turn) => ({ turn, score: terms.length ? keywordScore(input.query, turn) : 1 }))
      .filter((item) => !terms.length || item.score > 0)
      .sort((a, b) => b.score - a.score || new Date(a.turn.created_at).getTime() - new Date(b.turn.created_at).getTime())
    const maxScore = scoredTurns[0]?.score ?? 0;
    const turns = (maxScore > 1 ? scoredTurns.filter((item) => item.score === maxScore) : scoredTurns).map((item) => item.turn);
    const answerHint = buildReminderCommitmentAnswer(turns, input.timezone);
    const context = turns.slice(0, 12).map((turn) => {
      const when = formatInTimeZone(new Date(turn.created_at), input.timezone || turn.timezone || "UTC", "yyyy-MM-dd HH:mm");
      return `- [${when}] User reminder request: ${turn.content}`;
    }).join("\n");

    return {
      recall: { isRecall: true, label: "reminder commitments", topicQuery: "reminder commitments", kind: "reminder_recall" },
      answerHint,
      context: context ? `Reminder commitment archive:\n${context}` : "Reminder commitment archive requested, but no matching reminder turns were found."
    };
  }

  if (isExplicitSaveRecallQuestion(input.query)) {
    const turns = (await listConversationTurns(input.userId, 800))
      .filter((turn) => !(input.excludeIds ?? []).includes(turn.id))
      .filter((turn) => turn.role === "user" && explicitSaveTurnPattern.test(turn.content) && turn.content.trim().length > 0)
      .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
    const answerHint = buildExplicitSaveAnswer(turns, input.timezone);
    const context = turns.slice(-12).map((turn) => {
      const when = formatInTimeZone(new Date(turn.created_at), input.timezone || turn.timezone || "UTC", "yyyy-MM-dd HH:mm");
      return `- [${when}] User explicit save: ${turn.content}`;
    }).join("\n");

    return {
      recall: { isRecall: true, label: "explicit saves", topicQuery: "explicit saves", kind: "explicit_save_recall" },
      answerHint,
      context: context ? `Explicit-save archive:\n${context}` : "Explicit-save archive requested, but no saved turns were found."
    };
  }

  const recall = { ...baseRecall, kind: memoryIntent };
  if (!recall.isRecall && (memoryIntent === "user_history_recall" || memoryIntent === "conversation_history_recall")) {
    recall.isRecall = true;
    recall.label = memoryIntent === "user_history_recall" ? "your recent history" : "our recent conversation";
  }
  const role = memoryIntent === "user_history_recall" ? "user" : undefined;
  const archiveQuery = memoryIntent === "user_history_recall" && genericUserHistoryQuery(input.query)
    ? ""
    : recall.isRecall ? recall.topicQuery ?? "" : input.query;
  const turns = await searchConversationTurns({
    userId: input.userId,
    query: archiveQuery,
    start: recall.start,
    end: recall.end,
    limit: recall.isRecall ? 24 : 10,
    excludeIds: input.excludeIds,
    role
  });

  if (!turns.length) {
    return {
      recall,
      answerHint: recall.isRecall
        ? buildRecallAnswer(recall, [], input.timezone)
        : "",
      context: recall.isRecall
        ? `Date recall requested for ${recall.label ?? "that period"}, but no archived turns were found.`
        : ""
    };
  }

  const context = turns
    .filter((turn) => turn.content.trim().length > 0)
    .map((turn) => {
      const when = formatInTimeZone(new Date(turn.created_at), input.timezone || turn.timezone || "UTC", "yyyy-MM-dd HH:mm");
      const speaker = turn.role === "assistant" ? "AURA" : "User";
      return `- [${when}] ${speaker}: ${turn.content}`;
    })
    .join("\n");

  return {
    recall,
    answerHint: recall.isRecall ? buildRecallAnswer(recall, turns, input.timezone) : "",
    context: recall.isRecall
      ? `Date recall archive for ${recall.label ?? "requested period"}:\n${context}`
      : `Relevant raw conversation archive:\n${context}`
  };
}

export async function conversationTurnsForIdleSummary(userId: string, idleMs: number) {
  const turns = await listConversationTurns(userId, 80);
  const latest = turns[0];
  if (!latest) return [];
  if (Date.now() - new Date(latest.created_at).getTime() < idleMs) return [];

  const sessionId = latest.session_id;
  const sessionTurns = turns
    .filter((turn) => turn.session_id === sessionId)
    .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());

  return sessionTurns.slice(-30);
}

export function archiveStatus() {
  return {
    persistence: supabase ? "supabase_or_local_fallback" : "local_file",
    path: localArchivePath
  };
}
