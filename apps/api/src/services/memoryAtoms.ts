import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { MemoryAnalysis } from "../types/domain.js";
import type { MemoryIntent } from "./memoryIntentRouter.js";
import { isScaleTestUser } from "./scaleTest.js";

export type MemoryAtomType = "goal" | "preference" | "fact" | "emotion" | "relationship" | "habit" | "task" | "explicit_save";
export type MemoryAtomStatus = "active" | "changed" | "resolved" | "historical";
export type MemoryAtomCognitiveState = "candidate" | "active" | "reinforced" | "stable" | "dormant" | "archived" | "suppressed";
export type MemoryAtomContradictionState = "none" | "contradicted" | "replaced" | "resolved";
export type MemoryAssociationType = "RELATED_TO" | "CAUSES" | "CONTRADICTS" | "SUPPORTS" | "PART_OF" | "RESOLVED_BY" | "ABOUT_PERSON";

export type MemoryAtom = {
  id: string;
  userId: string;
  type: MemoryAtomType;
  text: string;
  entities: string[];
  topics: string[];
  emotion?: string;
  importance: number;
  confidence: number;
  status: MemoryAtomStatus;
  cognitiveState: MemoryAtomCognitiveState;
  lastMentionedAt: string;
  mentionCount: number;
  retrievalCount: number;
  freshnessScore: number;
  salienceScore: number;
  identityImpact: number;
  goalRelevance: number;
  relationshipWeight: number;
  noveltyWeight: number;
  emotionalWeight: number;
  contradictionState: MemoryAtomContradictionState;
  threadId: string;
  activeState: boolean;
  staleAfter: string | null;
  sourceTurnIds: string[];
  createdAt: string;
  updatedAt: string;
};

type StoredMemoryAtom = MemoryAtom & {
  signature: string;
  accessCount: number;
};

type MemoryAtomCandidate = {
  userId: string;
  type: MemoryAtomType;
  text: string;
  entities: string[];
  topics: string[];
  emotion?: string;
  importance: number;
  confidence: number;
};

type MemoryAssociation = {
  id: string;
  userId: string;
  fromAtomId: string;
  toAtomId: string;
  type: MemoryAssociationType;
  strength: number;
  reason: string;
  createdAt: string;
  updatedAt: string;
};

const apiDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const localAtomsPath = path.join(apiDir, "data", "memory-atoms.json");
const localAssociationsPath = path.join(apiDir, "data", "memory-associations.json");
const localAtoms: StoredMemoryAtom[] = [];
const localAssociations: MemoryAssociation[] = [];
const scaleTestAtoms: StoredMemoryAtom[] = [];
const scaleTestAssociations: MemoryAssociation[] = [];
let localLoaded = false;

const relationshipAliases: Record<string, string[]> = {
  girlfriend: ["girlfriend", "gf"],
  boyfriend: ["boyfriend", "bf"],
  dad: ["dad", "father", "papa", "pitaji"],
  mother: ["mother", "mom", "mummy", "mumma", "maa"],
  friend: ["friend", "dost"],
  cofounder: ["cofounder", "co-founder"],
  family: ["family", "ghar wale"],
  boss: ["boss", "manager"],
  team: ["team", "coworker", "colleague"]
};

const emotionTerms: Record<string, string[]> = {
  tired: ["tired", "exhausted", "drained", "sleepy", "thak", "thaka"],
  stressed: ["stress", "stressed", "pressure", "overwhelmed", "pareshan"],
  sad: ["sad", "low", "lonely", "empty", "dukhi"],
  anxious: ["anxious", "worried", "nervous", "scared"],
  angry: ["angry", "frustrated", "irritated", "gussa"],
  excited: ["excited", "pumped", "thrilled"],
  calm: ["calm", "peaceful", "relaxed"],
  motivated: ["motivated", "focused", "disciplined", "productive"]
};

const topicTerms = [
  "aura", "app", "developer", "coding", "vibe coding", "swift", "backend", "memory", "voice", "reminder",
  "sleep", "work", "career", "family", "fitness", "health", "trading", "money", "study", "relationship", "weed", "smoking"
];

async function readJsonArray<T>(filePath: string): Promise<T[]> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw) as T[];
  } catch {
    return [];
  }
}

async function loadLocalAtoms() {
  if (localLoaded) return;
  localLoaded = true;
  localAtoms.splice(0, localAtoms.length, ...(await readJsonArray<StoredMemoryAtom>(localAtomsPath)));
  localAssociations.splice(0, localAssociations.length, ...(await readJsonArray<MemoryAssociation>(localAssociationsPath)));
}

async function persistLocalAtoms() {
  await fs.mkdir(path.dirname(localAtomsPath), { recursive: true });
  await Promise.all([
    fs.writeFile(localAtomsPath, JSON.stringify(localAtoms.slice(0, 5000), null, 2)),
    fs.writeFile(localAssociationsPath, JSON.stringify(localAssociations.slice(0, 8000), null, 2))
  ]);
}

function storeForUser(userId: string) {
  return isScaleTestUser(userId)
    ? { atoms: scaleTestAtoms, associations: scaleTestAssociations, persist: async () => undefined }
    : { atoms: localAtoms, associations: localAssociations, persist: persistLocalAtoms };
}

function compactText(text: string, maxLength = 260) {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= maxLength) return clean;
  return `${clean.slice(0, maxLength - 3).trim()}...`;
}

function normalized(text: string) {
  return text.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();
}

function unique(values: string[]) {
  return Array.from(new Set(values.map((value) => normalized(value)).filter(Boolean)));
}

function includesTerm(text: string, term: string) {
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|\\W)${escaped}(\\W|$)`, "i").test(text);
}

function detectTopics(content: string, analysis: MemoryAnalysis) {
  const lower = normalized(content);
  return unique([
    ...topicTerms.filter((topic) => lower.includes(topic)),
    ...analysis.recurringTopics,
    ...analysis.autoTags.filter((tag) => tag !== "core-profile" && tag !== "explicit-save")
  ]).slice(0, 8);
}

function detectEntities(content: string) {
  const lower = normalized(content);
  const relationships = Object.entries(relationshipAliases)
    .filter(([, aliases]) => aliases.some((alias) => includesTerm(lower, alias)))
    .map(([label]) => label);
  const named = Array.from(content.matchAll(/\b[A-Z][a-z]{2,}\b/g)).map((match) => match[0]).filter((name) => !["Aura", "AURA", "I"].includes(name));
  return unique([...relationships, ...named]).slice(0, 8);
}

function detectEmotion(content: string, analysis: MemoryAnalysis) {
  const lower = normalized(content);
  for (const [label, terms] of Object.entries(emotionTerms)) {
    if (terms.some((term) => includesTerm(lower, term))) return label;
  }
  return analysis.emotionalState ?? undefined;
}

function threadFor(topics: string[], entities: string[], text: string) {
  const joined = [...topics, ...entities, text].join(" ").toLowerCase();
  if (/\b(aura|app|voice|memory|assistant|tts|stt)\b/.test(joined)) return "aura";
  if (/\b(code|coding|developer|swift|backend|frontend)\b/.test(joined)) return "coding";
  if (/\b(work|job|career|office|boss)\b/.test(joined)) return "work";
  if (/\b(girlfriend|friend|dad|mother|mom|family|relationship)\b/.test(joined)) return "relationship";
  if (/\b(sleep|tired|night|exhausted)\b/.test(joined)) return "sleep";
  if (/\b(stress|sad|confused|stuck|feel|emotion)\b/.test(joined)) return "emotional";
  if (/\b(startup|launch|money|profit|cost|user|subscription)\b/.test(joined)) return "business";
  return topics[0] ?? "general";
}

function salienceFor(input: {
  type: MemoryAtomType;
  importance: number;
  confidence: number;
  emotion?: string;
  topics: string[];
  entities: string[];
  text: string;
}) {
  const text = input.text.toLowerCase();
  const emotionalWeight = input.emotion ? 0.78 : /\b(tired|stress|sad|excited|angry|hurt|love|fear)\b/i.test(text) ? 0.62 : 0.12;
  const identityImpact = /\b(i am|i'm|my goal|freedom|developer|identity|life|future)\b/i.test(text) || input.type === "goal" ? 0.78 : 0.18;
  const goalRelevance = input.type === "goal" || input.topics.includes("goal") || /\b(goal|want to|trying to|build|become)\b/i.test(text) ? 0.86 : 0.18;
  const relationshipWeight = input.type === "relationship" || input.entities.some((entity) => Object.prototype.hasOwnProperty.call(relationshipAliases, entity)) ? 0.82 : 0.1;
  const noveltyWeight = input.confidence >= 0.9 || input.importance >= 0.9 ? 0.7 : 0.35;
  const salienceScore = Math.min(1, input.importance * 0.35 + emotionalWeight * 0.18 + identityImpact * 0.17 + goalRelevance * 0.14 + relationshipWeight * 0.1 + noveltyWeight * 0.06);
  return { salienceScore, emotionalWeight, identityImpact, goalRelevance, relationshipWeight, noveltyWeight };
}

function staleAfterFor(type: MemoryAtomType, createdAt: string) {
  const start = new Date(createdAt);
  const days = type === "emotion" ? 2 : type === "task" ? 7 : type === "habit" ? 45 : type === "goal" || type === "relationship" ? 180 : 30;
  start.setUTCDate(start.getUTCDate() + days);
  return start.toISOString();
}

function importanceNumber(analysis: MemoryAnalysis, type: MemoryAtomType) {
  let score = analysis.importance === "critical" ? 0.95 : analysis.importance === "medium" ? 0.72 : 0.42;
  if (analysis.explicitSaveIntent || type === "explicit_save") score += 0.18;
  if (type === "goal" || type === "relationship") score += 0.08;
  return Math.min(1, score);
}

function signatureFor(atom: MemoryAtomCandidate) {
  const anchor = atom.entities[0] ?? atom.topics[0] ?? normalized(atom.text).split(" ").slice(0, 8).join(" ");
  return `${atom.userId}:${atom.type}:${anchor}`;
}

function cleanGoalText(text: string) {
  const clean = compactText(text, 220)
    .replace(/^remember that\s+/i, "")
    .replace(/^save this[:\s-]*/i, "")
    .replace(/^my goal is\s+/i, "")
    .replace(/^i\s+(?:want|need|plan|am trying|try|m trying|would like)\s+to\s+/i, "to ")
    .replace(/^i\s+am\s+trying\s+to\s+/i, "to ");
  return clean.replace(/\s+/g, " ").trim();
}

function isStableGoalSignal(text: string) {
  if (/\b(reply normally|continue tomorrow|learn better|one hour|what should|tired|stuck|distracted)\b/i.test(text)) return false;
  return /\b(my goal is|i want to become|i need to become|i am trying to|i'm trying to|trying to become|plan to|build aura|become a developer|learn coding|focus on becoming)\b/i.test(text);
}

function candidateAtoms(input: {
  userId: string;
  content: string;
  analysis: MemoryAnalysis;
}) {
  const topics = detectTopics(input.content, input.analysis);
  const entities = detectEntities(input.content);
  const emotion = detectEmotion(input.content, input.analysis);
  const candidates: MemoryAtomCandidate[] = [];

  for (const goal of input.analysis.goals.filter(isStableGoalSignal)) {
    candidates.push({
      userId: input.userId,
      type: "goal",
      text: cleanGoalText(goal),
      entities,
      topics: unique([...topics, "goal"]),
      importance: importanceNumber(input.analysis, "goal"),
      confidence: 0.84
    });
  }

  if (!input.analysis.goals.some(isStableGoalSignal) && isStableGoalSignal(input.content)) {
    candidates.push({
      userId: input.userId,
      type: "goal",
      text: cleanGoalText(input.content),
      entities,
      topics: unique([...topics, "goal"]),
      importance: importanceNumber(input.analysis, "goal"),
      confidence: 0.76
    });
  }

  for (const fact of input.analysis.importantFacts) {
    candidates.push({
      userId: input.userId,
      type: /\b(prefer|like|hate)\b/i.test(fact) ? "preference" : "fact",
      text: compactText(fact),
      entities,
      topics,
      emotion,
      importance: importanceNumber(input.analysis, "fact"),
      confidence: 0.78
    });
  }

  for (const habit of input.analysis.habits) {
    candidates.push({
      userId: input.userId,
      type: "habit",
      text: compactText(habit),
      entities,
      topics,
      emotion,
      importance: importanceNumber(input.analysis, "habit"),
      confidence: 0.72
    });
  }

  for (const task of input.analysis.actionItems) {
    candidates.push({
      userId: input.userId,
      type: "task",
      text: compactText(task),
      entities,
      topics,
      emotion,
      importance: importanceNumber(input.analysis, "task"),
      confidence: 0.72
    });
  }

  if (emotion) {
    candidates.push({
      userId: input.userId,
      type: "emotion",
      text: compactText(input.content, 220),
      entities,
      topics,
      emotion,
      importance: importanceNumber(input.analysis, "emotion"),
      confidence: 0.68
    });
  }

  for (const entity of entities.filter((entity) => Object.prototype.hasOwnProperty.call(relationshipAliases, entity))) {
    candidates.push({
      userId: input.userId,
      type: "relationship",
      text: compactText(input.content, 220),
      entities: [entity],
      topics,
      emotion,
      importance: importanceNumber(input.analysis, "relationship"),
      confidence: 0.7
    });
  }

  if (input.analysis.explicitSaveIntent) {
    candidates.push({
      userId: input.userId,
      type: "explicit_save",
      text: compactText(input.content, 260),
      entities,
      topics,
      emotion,
      importance: 1,
      confidence: 0.95
    });
  }

  return candidates.filter((candidate) => candidate.text.length > 3);
}

function oppositeEmotion(a?: string, b?: string) {
  const positive = new Set(["excited", "calm", "motivated"]);
  const negative = new Set(["tired", "stressed", "sad", "anxious", "angry"]);
  return Boolean(a && b && ((positive.has(a) && negative.has(b)) || (negative.has(a) && positive.has(b))));
}

async function upsertAtom(input: {
  atom: MemoryAtomCandidate;
  sourceTurnId?: string | null;
  createdAt?: Date;
}) {
  await loadLocalAtoms();
  const store = storeForUser(input.atom.userId);
  const now = (input.createdAt ?? new Date()).toISOString();
  const signature = signatureFor(input.atom);
  const existing = store.atoms.find((atom) => atom.signature === signature);

  if (existing) {
    const salience = salienceFor({ ...input.atom, text: input.atom.text });
    existing.text = input.atom.text.length > existing.text.length ? input.atom.text : existing.text;
    existing.entities = unique([...existing.entities, ...input.atom.entities]);
    existing.topics = unique([...existing.topics, ...input.atom.topics]);
    existing.emotion = input.atom.emotion ?? existing.emotion;
    existing.importance = Math.max(existing.importance, input.atom.importance);
    existing.confidence = Math.max(existing.confidence, input.atom.confidence);
    const contradicted = oppositeEmotion(existing.emotion, input.atom.emotion);
    existing.status = contradicted ? "changed" : existing.status;
    existing.cognitiveState = existing.mentionCount >= 4 || existing.retrievalCount >= 3 ? "reinforced" : "active";
    existing.lastMentionedAt = now;
    existing.mentionCount = (existing.mentionCount ?? existing.accessCount ?? 0) + 1;
    existing.freshnessScore = 1;
    existing.salienceScore = Math.max(existing.salienceScore ?? 0, salience.salienceScore);
    existing.identityImpact = Math.max(existing.identityImpact ?? 0, salience.identityImpact);
    existing.goalRelevance = Math.max(existing.goalRelevance ?? 0, salience.goalRelevance);
    existing.relationshipWeight = Math.max(existing.relationshipWeight ?? 0, salience.relationshipWeight);
    existing.noveltyWeight = Math.max(existing.noveltyWeight ?? 0, salience.noveltyWeight);
    existing.emotionalWeight = Math.max(existing.emotionalWeight ?? 0, salience.emotionalWeight);
    existing.contradictionState = contradicted ? "contradicted" : existing.contradictionState ?? "none";
    existing.threadId = existing.threadId ?? threadFor(existing.topics, existing.entities, existing.text);
    existing.activeState = !contradicted;
    existing.staleAfter = staleAfterFor(existing.type, now);
    existing.sourceTurnIds = unique([...existing.sourceTurnIds, input.sourceTurnId ?? ""]).slice(0, 20);
    existing.updatedAt = now;
    existing.accessCount += 1;
    await store.persist();
    return existing;
  }

  const salience = salienceFor({ ...input.atom, text: input.atom.text });
  const created: StoredMemoryAtom = {
    ...input.atom,
    id: crypto.randomUUID(),
    signature,
    accessCount: 0,
    status: "active",
    cognitiveState: salience.salienceScore >= 0.78 ? "reinforced" : "candidate",
    lastMentionedAt: now,
    mentionCount: 1,
    retrievalCount: 0,
    freshnessScore: 1,
    salienceScore: salience.salienceScore,
    identityImpact: salience.identityImpact,
    goalRelevance: salience.goalRelevance,
    relationshipWeight: salience.relationshipWeight,
    noveltyWeight: salience.noveltyWeight,
    emotionalWeight: salience.emotionalWeight,
    contradictionState: "none",
    threadId: threadFor(input.atom.topics, input.atom.entities, input.atom.text),
    activeState: true,
    staleAfter: staleAfterFor(input.atom.type, now),
    sourceTurnIds: input.sourceTurnId ? [input.sourceTurnId] : [],
    createdAt: now,
    updatedAt: now
  };
  store.atoms.unshift(created);
  if (store.atoms.length > 20_000) store.atoms.length = 20_000;
  await store.persist();
  return created;
}

function associationTypeBetween(a: StoredMemoryAtom, b: StoredMemoryAtom): MemoryAssociationType | null {
  if (a.type === "relationship" || b.type === "relationship") {
    const sharedPerson = a.entities.some((entity) => b.entities.includes(entity));
    if (sharedPerson) return "ABOUT_PERSON";
  }
  if (a.type === "emotion" && b.topics.some((topic) => a.topics.includes(topic))) return "RELATED_TO";
  if (a.type === "goal" && b.topics.some((topic) => a.topics.includes(topic))) return "PART_OF";
  if (oppositeEmotion(a.emotion, b.emotion) && a.topics.some((topic) => b.topics.includes(topic))) return "CONTRADICTS";
  if (a.topics.some((topic) => b.topics.includes(topic)) || a.entities.some((entity) => b.entities.includes(entity))) return "RELATED_TO";
  return null;
}

async function linkAtom(atom: StoredMemoryAtom) {
  const store = storeForUser(atom.userId);
  const related = store.atoms
    .filter((candidate) => candidate.userId === atom.userId && candidate.id !== atom.id)
    .slice(0, 80)
    .map((candidate) => ({ candidate, type: associationTypeBetween(atom, candidate) }))
    .filter((item): item is { candidate: StoredMemoryAtom; type: MemoryAssociationType } => Boolean(item.type))
    .slice(0, 8);

  const now = new Date().toISOString();
  for (const item of related) {
    const existing = store.associations.find((edge) => edge.userId === atom.userId && edge.fromAtomId === atom.id && edge.toAtomId === item.candidate.id && edge.type === item.type);
    if (existing) {
      existing.strength = Math.min(1, existing.strength + 0.08);
      existing.updatedAt = now;
      continue;
    }
    store.associations.unshift({
      id: crypto.randomUUID(),
      userId: atom.userId,
      fromAtomId: atom.id,
      toAtomId: item.candidate.id,
      type: item.type,
      strength: item.type === "CONTRADICTS" ? 0.82 : 0.62,
      reason: item.type === "ABOUT_PERSON" ? "shared person" : "shared topic or emotional context",
      createdAt: now,
      updatedAt: now
    });
  }

  if (store.associations.length > 30_000) store.associations.length = 30_000;
  await store.persist();
}

export async function deriveMemoryAtomsFromTurn(input: {
  userId: string;
  content: string;
  analysis: MemoryAnalysis;
  sourceTurnId?: string | null;
  createdAt?: Date;
}) {
  const candidates = candidateAtoms(input);
  if (!candidates.length) return { atoms: 0, associations: 0 };

  const beforeAssociations = storeForUser(input.userId).associations.length;
  const atoms: StoredMemoryAtom[] = [];
  for (const candidate of candidates) {
    const atom = await upsertAtom({ atom: candidate, sourceTurnId: input.sourceTurnId, createdAt: input.createdAt });
    atoms.push(atom);
    await linkAtom(atom);
  }

  const afterAssociations = storeForUser(input.userId).associations.length;
  return { atoms: atoms.length, associations: Math.max(0, afterAssociations - beforeAssociations) };
}

export async function listMemoryAtoms(userId: string, limit = 120) {
  await loadLocalAtoms();
  return storeForUser(userId).atoms.filter((atom) => atom.userId === userId).slice(0, limit);
}

function termScore(query: string, atom: StoredMemoryAtom) {
  const terms = normalized(query).split(" ").filter((term) => term.length > 2);
  const haystack = normalized([atom.text, atom.type, atom.emotion, ...atom.entities, ...atom.topics].filter(Boolean).join(" "));
  return terms.reduce((score, term) => score + (haystack.includes(term) ? 1 : 0), 0);
}

function typeBoost(intent: MemoryIntent, atom: StoredMemoryAtom) {
  if (intent === "goal_recall" && atom.type === "goal") return 8;
  if (intent === "relationship_recall" && atom.type === "relationship") return 8;
  if (intent === "profile_recall" && ["goal", "preference", "fact", "habit", "explicit_save"].includes(atom.type)) return 6;
  if (intent === "pattern_recall" && (atom.type === "emotion" || atom.type === "habit" || atom.type === "goal")) return 5;
  if (intent === "explicit_save_recall" && atom.type === "explicit_save") return 8;
  return 0;
}

export async function searchMemoryAtoms(input: {
  userId: string;
  query: string;
  intent: MemoryIntent;
  types?: MemoryAtomType[];
  entity?: string;
  limit?: number;
}) {
  const atoms = await listMemoryAtoms(input.userId, 300);
  const entity = input.entity ? normalized(input.entity) : null;
  return atoms
    .filter((atom) => !input.types?.length || input.types.includes(atom.type))
    .filter((atom) => !entity || atom.entities.includes(entity))
    .map((atom) => {
      const ageDays = Math.max(0, (Date.now() - new Date(atom.updatedAt).getTime()) / (24 * 60 * 60 * 1000));
      const recency = Math.max(0, 4 - ageDays / 14);
      const stalePenalty = atom.activeState === false || atom.cognitiveState === "suppressed" || atom.cognitiveState === "archived" ? 3 : 0;
      const salience = (atom.salienceScore ?? atom.importance) * 3;
      const reinforcement = (atom.mentionCount ?? 0) * 0.08 + (atom.retrievalCount ?? atom.accessCount ?? 0) * 0.12;
      const score = typeBoost(input.intent, atom) + termScore(input.query, atom) + atom.importance * 3 + atom.confidence * 2 + recency + salience + reinforcement - stalePenalty;
      return { atom, score };
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, input.limit ?? 8)
    .map((item) => item.atom);
}

export function memoryAtomLine(atom: MemoryAtom) {
  const details = [
    atom.type,
    atom.entities.length ? `people/entities: ${atom.entities.join(", ")}` : "",
    atom.topics.length ? `topics: ${atom.topics.join(", ")}` : "",
    atom.emotion ? `emotion: ${atom.emotion}` : "",
    atom.status !== "active" ? `status: ${atom.status}` : "",
    atom.cognitiveState && atom.cognitiveState !== "active" ? `state: ${atom.cognitiveState}` : "",
    atom.threadId ? `thread: ${atom.threadId}` : "",
    typeof atom.salienceScore === "number" ? `salience: ${atom.salienceScore.toFixed(2)}` : ""
  ].filter(Boolean).join("; ");
  return `- ${details}: ${atom.text}`;
}

export function memoryAtomsStatus() {
  return {
    persistence: "local_file",
    paths: {
      atoms: localAtomsPath,
      associations: localAssociationsPath
    }
  };
}
