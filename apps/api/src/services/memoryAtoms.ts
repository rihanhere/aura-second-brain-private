import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { MemoryAnalysis } from "../types/domain.js";
import type { MemoryIntent } from "./memoryIntentRouter.js";
import { isScaleTestUser } from "./scaleTest.js";

export type MemoryAtomType = "goal" | "preference" | "fact" | "emotion" | "relationship" | "habit" | "task" | "explicit_save";
export type MemoryAtomStatus = "active" | "changed" | "resolved" | "historical";
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
  sourceTurnIds: string[];
  createdAt: string;
  updatedAt: string;
};

type StoredMemoryAtom = MemoryAtom & {
  signature: string;
  accessCount: number;
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

function importanceNumber(analysis: MemoryAnalysis, type: MemoryAtomType) {
  let score = analysis.importance === "critical" ? 0.95 : analysis.importance === "medium" ? 0.72 : 0.42;
  if (analysis.explicitSaveIntent || type === "explicit_save") score += 0.18;
  if (type === "goal" || type === "relationship") score += 0.08;
  return Math.min(1, score);
}

function signatureFor(atom: Omit<MemoryAtom, "id" | "createdAt" | "updatedAt" | "sourceTurnIds" | "status">) {
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
  const candidates: Array<Omit<MemoryAtom, "id" | "createdAt" | "updatedAt" | "sourceTurnIds" | "status">> = [];

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
  atom: Omit<MemoryAtom, "id" | "createdAt" | "updatedAt" | "sourceTurnIds" | "status">;
  sourceTurnId?: string | null;
  createdAt?: Date;
}) {
  await loadLocalAtoms();
  const store = storeForUser(input.atom.userId);
  const now = (input.createdAt ?? new Date()).toISOString();
  const signature = signatureFor(input.atom);
  const existing = store.atoms.find((atom) => atom.signature === signature);

  if (existing) {
    existing.text = input.atom.text.length > existing.text.length ? input.atom.text : existing.text;
    existing.entities = unique([...existing.entities, ...input.atom.entities]);
    existing.topics = unique([...existing.topics, ...input.atom.topics]);
    existing.emotion = input.atom.emotion ?? existing.emotion;
    existing.importance = Math.max(existing.importance, input.atom.importance);
    existing.confidence = Math.max(existing.confidence, input.atom.confidence);
    existing.status = oppositeEmotion(existing.emotion, input.atom.emotion) ? "changed" : existing.status;
    existing.sourceTurnIds = unique([...existing.sourceTurnIds, input.sourceTurnId ?? ""]).slice(0, 20);
    existing.updatedAt = now;
    existing.accessCount += 1;
    await store.persist();
    return existing;
  }

  const created: StoredMemoryAtom = {
    ...input.atom,
    id: crypto.randomUUID(),
    signature,
    accessCount: 0,
    status: "active",
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
      const score = typeBoost(input.intent, atom) + termScore(input.query, atom) + atom.importance * 4 + atom.confidence * 2 + recency + atom.accessCount * 0.1;
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
    atom.status !== "active" ? `status: ${atom.status}` : ""
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
