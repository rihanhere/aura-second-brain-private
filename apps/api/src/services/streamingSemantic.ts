export type StreamingIntentState =
  | "uncertain"
  | "normal_chat"
  | "instruction"
  | "technical"
  | "emotional_support"
  | "memory_recall"
  | "exact_recall"
  | "reminder"
  | "language_preference"
  | "interruption";

export type EndpointState = "LISTENING" | "LIKELY_CONTINUING" | "SOFT_ENDPOINT" | "HARD_ENDPOINT";

export type EndpointConfidence = {
  state: EndpointState;
  score: number;
  reasons: string[];
};

export type SemanticStabilityScore = {
  score: number;
  revisionCount: number;
  confidence: "low" | "medium" | "high";
  reasons: string[];
};

export type LiveTranscriptWindow = {
  partials: Array<{ text: string; receivedAt: string }>;
  latestText: string;
  startedAt: string;
  updatedAt: string;
};

export type RollingSemanticFrame = {
  type: "semantic_frame";
  transcript: string;
  normalizedTranscript: string;
  intent: StreamingIntentState;
  activeThread: string;
  toneDirection: string;
  languageHint: "auto" | "en" | "hi" | "hinglish";
  endpoint: EndpointConfidence;
  stability: SemanticStabilityScore;
  safeToPlan: boolean;
  safeEarlyTokensAllowed: boolean;
  mustWaitForFinal: boolean;
  revisionCount: number;
  updatedAt: string;
};

const HESITATION_PATTERN = /\b(um+|uh+|hmm+|matlab|like|you know|i mean|actually|basically)\s*$/i;
const CONTINUATION_PATTERN = /\b(and|or|but|because|so|then|ki|ke|toh|agar|if|when|while|with|about|for|from|that)\s*$/i;
const CONTRAST_PATTERN = /\b(but actually|but then|actually|instead|nahi|no wait|wait|not that|i mean|mera matlab|matlab)\b/i;

export function createLiveTranscriptWindow(now = new Date()): LiveTranscriptWindow {
  const iso = now.toISOString();
  return {
    partials: [],
    latestText: "",
    startedAt: iso,
    updatedAt: iso
  };
}

export function pushPartialTranscript(window: LiveTranscriptWindow, text: string, now = new Date()) {
  const clean = normalizeSpacing(text).slice(0, 4000);
  if (!clean) return window;
  const receivedAt = now.toISOString();
  const nextPartials = [...window.partials, { text: clean, receivedAt }].slice(-24);
  return {
    ...window,
    partials: nextPartials,
    latestText: clean,
    updatedAt: receivedAt
  };
}

export function buildRollingSemanticFrame(window: LiveTranscriptWindow, endpointOverride?: Partial<EndpointConfidence>): RollingSemanticFrame {
  const transcript = normalizeSpacing(window.latestText);
  const normalizedTranscript = normalizeForSemantic(transcript);
  const revisionCount = countSemanticRevisions(window.partials.map((partial) => partial.text));
  const endpoint = mergeEndpoint(scoreEndpointConfidence(transcript), endpointOverride);
  const intent = inferStreamingIntent(transcript);
  const activeThread = inferActiveThread(transcript, intent);
  const languageHint = inferLanguageHint(transcript);
  const stability = scoreSemanticStability(transcript, revisionCount, endpoint, intent);
  const mustWaitForFinal = intent === "exact_recall" || intent === "reminder" || intent === "language_preference";

  return {
    type: "semantic_frame",
    transcript,
    normalizedTranscript,
    intent,
    activeThread,
    toneDirection: inferToneDirection(transcript, intent),
    languageHint,
    endpoint,
    stability,
    safeToPlan: Boolean(transcript) && stability.score >= 0.42 && !mustWaitForFinal,
    safeEarlyTokensAllowed: Boolean(transcript) && endpoint.score >= 0.7 && stability.score >= 0.55 && !mustWaitForFinal,
    mustWaitForFinal,
    revisionCount,
    updatedAt: window.updatedAt
  };
}

export function scoreEndpointConfidence(transcript: string): EndpointConfidence {
  const clean = normalizeSpacing(transcript);
  const reasons: string[] = [];
  let score = 0.18;

  if (clean.length >= 14) {
    score += 0.16;
    reasons.push("enough_text");
  }
  if (clean.length >= 42) {
    score += 0.14;
    reasons.push("complete_phrase_length");
  }
  if (/[.!?।]$/.test(clean)) {
    score += 0.22;
    reasons.push("terminal_punctuation");
  }
  if (/\b(done|that's it|bas|enough|ho gaya|send it)\b/i.test(clean)) {
    score += 0.2;
    reasons.push("explicit_done");
  }
  if (HESITATION_PATTERN.test(clean)) {
    score -= 0.18;
    reasons.push("trailing_hesitation");
  }
  if (CONTINUATION_PATTERN.test(clean)) {
    score -= 0.2;
    reasons.push("continuation_word");
  }
  if (CONTRAST_PATTERN.test(clean)) {
    score -= 0.08;
    reasons.push("meaning_revision_possible");
  }

  const clipped = clamp(score);
  return {
    state: clipped >= 0.82 ? "HARD_ENDPOINT" : clipped >= 0.62 ? "SOFT_ENDPOINT" : clipped >= 0.36 ? "LIKELY_CONTINUING" : "LISTENING",
    score: clipped,
    reasons
  };
}

export function chunkReplyForStreaming(reply: string) {
  const normalized = normalizeSpacing(reply);
  const phrases = normalized
    .match(/[^,;:!?।.]+[,;:!?।.]?/g)
    ?.map((item) => item.trim())
    .filter(Boolean) ?? [];
  const chunks: string[] = [];
  let current = "";
  const maxChunkChars = 60;

  for (const phrase of phrases.length ? phrases : [normalized]) {
    const candidate = `${current} ${phrase}`.trim();
    if (candidate.length <= maxChunkChars) {
      current = candidate;
      continue;
    }
    if (current) chunks.push(current);
    if (phrase.length <= maxChunkChars) {
      current = phrase;
      continue;
    }
    const words = phrase.split(/\s+/).filter(Boolean);
    current = "";
    for (const word of words) {
      const wordCandidate = `${current} ${word}`.trim();
      if (wordCandidate.length <= maxChunkChars) {
        current = wordCandidate;
      } else {
        if (current) chunks.push(current);
        current = word;
      }
    }
  }
  if (current) chunks.push(current);

  return chunks.length ? chunks.slice(0, 12) : [normalized].filter(Boolean);
}

function mergeEndpoint(base: EndpointConfidence, override?: Partial<EndpointConfidence>): EndpointConfidence {
  if (!override) return base;
  return {
    state: override.state ?? base.state,
    score: typeof override.score === "number" ? clamp(override.score) : base.score,
    reasons: [...base.reasons, ...(override.reasons ?? ["client_endpoint_update"])]
  };
}

function scoreSemanticStability(
  transcript: string,
  revisionCount: number,
  endpoint: EndpointConfidence,
  intent: StreamingIntentState
): SemanticStabilityScore {
  const reasons: string[] = [];
  let score = 0.18;
  const words = normalizeSpacing(transcript).split(/\s+/).filter(Boolean);
  if (words.length >= 4) {
    score += 0.18;
    reasons.push("enough_words");
  }
  if (words.length >= 9) {
    score += 0.16;
    reasons.push("topic_visible");
  }
  if (endpoint.score >= 0.62) {
    score += 0.18;
    reasons.push("endpoint_stable");
  }
  if (intent !== "uncertain") {
    score += 0.14;
    reasons.push("intent_detected");
  }
  if (revisionCount > 1) {
    score -= Math.min(0.18, revisionCount * 0.04);
    reasons.push("semantic_revisions");
  }
  if (CONTRAST_PATTERN.test(transcript)) {
    score -= 0.08;
    reasons.push("contrast_or_correction");
  }
  const clipped = clamp(score);
  return {
    score: clipped,
    revisionCount,
    confidence: clipped >= 0.72 ? "high" : clipped >= 0.48 ? "medium" : "low",
    reasons
  };
}

function inferStreamingIntent(text: string): StreamingIntentState {
  const lower = text.toLowerCase();
  if (/^\s*(stop|wait|pause|cancel|ruko|ruk|bas|hold on|ek second)\b/i.test(text)) return "interruption";
  if (/\b(remind me|reminder|alarm|yaad dilana|yaad dila|after \d+|in \d+ minutes|tomorrow)\b/i.test(text)) return "reminder";
  if (/\b(when did i|what date|exact date|exactly when|timestamp|kab bola|kab kaha)\b/i.test(text)) return "exact_recall";
  if (/\b(do you remember|did i tell|what do you know about me|kya tumhe yaad|yaad hai|remember about)\b/i.test(text)) return "memory_recall";
  if (/\b(speak english|english only|hindi mein|hinglish|reply in)\b/i.test(text) || /हिंदी/.test(text)) return "language_preference";
  if (/\b(code|backend|frontend|app|build|bug|deploy|api|server|tts|stt|vad|memory system)\b/i.test(text)) return "technical";
  if (/\b(sad|tired|anxious|stress|overwhelmed|lonely|hurt|angry|scared|thak|pareshan|dukhi)\b/i.test(text)) return "emotional_support";
  if (/\b(should|make|fix|do this|implement|change|plan|help me)\b/i.test(text)) return "instruction";
  return normalizeSpacing(text).length > 8 ? "normal_chat" : "uncertain";
}

function inferActiveThread(text: string, intent: StreamingIntentState) {
  const lower = text.toLowerCase();
  if (intent === "reminder") return "reminders";
  if (intent === "memory_recall" || intent === "exact_recall") return "memory";
  if (/\b(aura|stt|tts|vad|voice|app|backend|server|code|build|deploy|api)\b/i.test(lower)) return "aura_build";
  if (/\b(work|job|business|startup|office|client)\b/i.test(lower)) return "work";
  if (/\b(girlfriend|friend|family|relationship|mom|dad|bhai)\b/i.test(lower)) return "relationships";
  if (/\b(sleep|water|health|gym|fitness|weed|smoke|drink)\b/i.test(lower)) return "health";
  if (/\b(movie|series|song|music|game)\b/i.test(lower)) return "media";
  if (intent === "emotional_support") return "emotional_state";
  return "general";
}

function inferToneDirection(text: string, intent: StreamingIntentState) {
  if (intent === "emotional_support") return "calm_grounded";
  if (intent === "technical" || intent === "instruction") return "direct_practical";
  if (intent === "reminder" || intent === "exact_recall") return "precise_brief";
  if (/\b(lol|haha|funny|mast|nice)\b/i.test(text)) return "light";
  return "conversational";
}

function inferLanguageHint(text: string): "auto" | "en" | "hi" | "hinglish" {
  if (/[\u0900-\u097F]/.test(text)) return "hi";
  const lower = text.toLowerCase();
  const hindiRomanWords = lower.match(/\b(haan|nahi|kya|kaise|matlab|abhi|thik|theek|bolo|karna|chahiye|mera|tum|aap|kyu|hai|tha)\b/g)?.length ?? 0;
  const englishWords = lower.match(/\b(the|is|are|what|why|how|can|should|app|voice|memory|work|now)\b/g)?.length ?? 0;
  if (hindiRomanWords >= 2 && englishWords >= 1) return "hinglish";
  if (hindiRomanWords >= 3) return "hinglish";
  return "en";
}

function countSemanticRevisions(partials: string[]) {
  let revisions = 0;
  for (let index = 1; index < partials.length; index += 1) {
    const previous = normalizeForSemantic(partials[index - 1] ?? "");
    const current = normalizeForSemantic(partials[index] ?? "");
    if (!previous || !current) continue;
    if (current.includes(previous)) continue;
    const previousWords = new Set(previous.split(/\s+/).filter(Boolean));
    const currentWords = new Set(current.split(/\s+/).filter(Boolean));
    const overlap = [...previousWords].filter((word) => currentWords.has(word)).length;
    const ratio = overlap / Math.max(1, previousWords.size);
    if (ratio < 0.58 || CONTRAST_PATTERN.test(current)) revisions += 1;
  }
  return revisions;
}

function normalizeSpacing(text: string) {
  return text.replace(/\s+/g, " ").trim();
}

function normalizeForSemantic(text: string) {
  return normalizeSpacing(text)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .trim();
}

function clamp(value: number) {
  return Math.max(0, Math.min(1, Number(value.toFixed(3))));
}
