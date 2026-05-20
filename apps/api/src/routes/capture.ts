import { Router } from "express";
import { z } from "zod";
import { inferAgentTool } from "../services/agentTools.js";
import { analyzeMemory } from "../services/memoryAnalyzer.js";
import { buildCompanionMemoryContext, buildMemoryContext, maybeRefreshWorkingMemory, maybeSummarizeIdleSession, saveMemory } from "../services/memoryStore.js";
import { completeCalmSystemPrompt, createEmbedding, type ChatMessage } from "../services/openRouter.js";
import { providerOverridesFromRequest } from "../services/providerOverrides.js";
import { describeReminderTime, parseNaturalReminder } from "../services/reminderParser.js";
import { saveReminderDraft } from "../services/reminderStore.js";
import { enforceDailyLimit } from "../middleware/usageLimit.js";
import { getUserId } from "../middleware/auth.js";
import { buildArchiveContext, listConversationTurns, saveConversationTurn, sessionIdFor } from "../services/conversationArchive.js";
import { buildCompanionContinuityContext, deriveContinuityFromTurn } from "../services/emotionalContinuity.js";
import { deriveMemoryAtomsFromTurn } from "../services/memoryAtoms.js";
import { classifyMemoryIntent, isMemoryCapabilityQuestion, memoryIntentMode } from "../services/memoryIntentRouter.js";
import { scaleTestModeFromRequest } from "../services/scaleTest.js";
import { queueVoiceSynthesis } from "../services/voiceOrchestrator.js";
import { logProductLearningSignals } from "../services/productLearning.js";
import { guardAssistantReply, recordAssistantReply } from "../services/assistantReplyMemory.js";
import { maybeRunMemoryConsolidation } from "../services/memoryConsolidationEngine.js";
import { buildTemporalContextBundle } from "../services/temporalContextEngine.js";
import { observeUserCognitionSignal } from "../services/userCognitionProfile.js";
import { governMemoryForPrompt } from "../services/memoryGovernor.js";

export const captureRouter = Router();

const captureSchema = z.object({
  content: z.string().min(1).max(4000),
  inputMode: z.enum(["text", "voice"]).default("text"),
  timezone: z.string().default("UTC"),
  languagePreference: z.enum(["auto", "en", "hi", "hinglish"]).default("auto"),
  skipVoice: z.boolean().default(false),
	  pendingCheckIn: z.object({
	    id: z.string(),
	    title: z.string(),
	    promptQuestion: z.string().nullable().optional(),
	    originalText: z.string().optional(),
	    scheduledAt: z.string().optional()
	  }).optional(),
	  appSession: z.object({
	    id: z.string().max(180).optional(),
	    startedAt: z.string().optional(),
	    newActiveSession: z.boolean().optional()
	  }).optional()
	});

function detectCheckInAnswer(content: string) {
  const normalized = content.toLowerCase().trim();
  if (/^(yes|yeah|yep|haan|ha|haa|still|i am|i'm|yes i am|abhi bhi|kar raha|kar rha|smoking)/i.test(normalized)) {
    return "yes" as const;
  }
  if (/^(no|nope|nah|nahi|nai|not now|i stopped|stopped|band|chhod diya|chod diya)/i.test(normalized)) {
    return "no" as const;
  }
  return "unclear" as const;
}

function reminderReply(reminderDraft: NonNullable<ReturnType<typeof parseNaturalReminder>>) {
  const when = describeReminderTime(reminderDraft.scheduledAt, reminderDraft.timezone);
  const keepOpen = "Please keep AURA open around then so I can speak it to you.";
  if (reminderDraft.type === "check_in") {
    return `Done, Rihan. I'll check in at ${when}. ${keepOpen}`;
  }
  return `Done, Rihan. I'll remind you at ${when}. ${keepOpen}`;
}

function normalizedUtterance(content: string) {
  return content
    .toLowerCase()
    .replace(/\baura\b/g, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function deterministicCommandReply(content: string) {
  const normalized = normalizedUtterance(content);
  if (!normalized) return null;

  if (/^(?:stop talking|stop|wait|pause|ruko|ruk|bas|cancel|chhodo|chod do|choro)\b/i.test(normalized)) {
    return "okay.";
  }

  if (/\b(?:switch|change)\b.{0,30}\bvoice\b/i.test(normalized)
    || /\bvoice\b.{0,30}\b(?:switch|change|male|female)\b/i.test(normalized)
    || /\b(?:male|female)\s+voice\b/i.test(normalized)) {
    return "I can't switch voices from here yet.";
  }

  const openMatch = normalized.match(/^\s*(?:open|launch|start)\s+([a-z][a-z0-9 ]{1,40})\s*$/i);
  if (openMatch?.[1]) {
    const target = openMatch[1].trim().replace(/^(the|my)\s+/i, "");
    if (!target || /^(it|this|that|there)$/i.test(target)) return "What should I open?";
    const displayTarget = target.toLowerCase() === "github"
      ? "GitHub"
      : target.charAt(0).toUpperCase() + target.slice(1);
    if (target.toLowerCase() === "camera") return "I can't open the camera from here yet.";
    return `I can't open ${displayTarget} from here yet.`;
  }

  return null;
}

function deterministicRecentPatternReply(content: string) {
  const normalized = normalizedUtterance(content);
  if (/\b(?:crashed|crash|fell|gir gaya|accident)\b.{0,40}\b(?:bike|scooty|scooter|cycle)\b/i.test(normalized)
    || /\b(?:bike|scooty|scooter|cycle)\b.{0,40}\b(?:crashed|crash|fell|accident)\b/i.test(normalized)) {
    return "again? you good?";
  }

  if (/\bexam\b.{0,40}\b(?:destroyed|killed|ruined|finished|messed)\b/i.test(normalized)
    || /\b(?:destroyed|killed|ruined|finished|messed)\b.{0,40}\bexam\b/i.test(normalized)) {
    return "that bad huh?";
  }

  if (/\b(?:addicted|hooked)\b.{0,40}\b(?:scrolling|reels|shorts|instagram|phone)\b/i.test(normalized)) {
    return "yeah, that happens fast these days.";
  }

  if (/^\s*(?:who am i|who am i\?)\s*$/i.test(content)) {
    return "You're Rihan.";
  }

  if (/\bwhat are you doing\b/i.test(normalized)) {
    return "talking to you.";
  }

  if (/\b(?:i am|i'm|im)\s+going\s+out\b/i.test(normalized)) {
    return "cool, where to?";
  }

  if (/\b(?:i am|i'm|im|feeling|feel)\b.{0,30}\b(?:depressed|sad|low|down)\b/i.test(normalized)) {
    return "That sounds heavy. Want to talk for a minute?";
  }

  return null;
}

function deterministicSmallTalkReply(content: string) {
  const normalized = normalizedUtterance(content);
  if (!normalized) return null;

  if (/^(hmm+|hm+|umm+|uh+|haan|ha|ok|okay|acha|achha|huh)$/i.test(normalized)) {
    return "Yeah?";
  }

  if (/\b(answer normally|reply normally|normal answer|seedha jawab|simple bol|simple answer)\b/i.test(content)) {
    return "Okay. Simple and direct.";
  }

  if (/\b(watching|dekh raha|dekh rha|dekh rahi|starting)\b.{0,80}\b(movie|film|series|show|episode)\b/i.test(content)
    || /\b(movie|film|series|show|episode)\b.{0,80}\b(tonight|aaj|abhi|now|another|new)\b/i.test(content)) {
    return "Oh nice. What movie?";
  }

  if (/\b(crazy|wild|insane|mad|pagal)\b.{0,60}\b(movie|film|series|show|episode)\b/i.test(content)
    || /\b(movie|film|series|show|episode)\b.{0,60}\b(crazy|wild|insane|mad|pagal)\b/i.test(content)) {
    return "What kind of crazy?";
  }

  if (/\b(crazy|wild|insane|mad|pagal)\b.{0,60}\b(game|match|level)\b/i.test(content)) {
    return "What happened?";
  }

  if (/\b(listening to|playing|sun raha|sun rha)\b.{0,80}\b(song|music|track|album)\b/i.test(content)) {
    return "Nice. What are you listening to?";
  }

  if (/\b(i'?m|i am|feeling|feel)\b.{0,40}\b(tired|exhausted|drained|thak|stressed)\b/i.test(content)
    || /\b(tired|exhausted|drained|thak|stressed)\b.{0,40}\b(today|aaj|tonight|abhi|now)\b/i.test(content)) {
    return "Yeah, today sounds draining.";
  }

  if (/^(hi|hello|hey|yo|namaste|namaskar|hii|helo)(?:\s+(?:hi|hello|hey|yo|hii|helo))*$/.test(normalized)) {
    return "Hello, Rihan. I'm listening.";
  }

  if (/\b(are you listening|can you hear me|sun rahe ho|sun rahi ho|listening)\b/i.test(content)) {
    return "Yes, I'm listening. Say whatever is on your mind.";
  }

  if (/\b(what can you do|what are you capable of|tum kya kya kar sakte|kya kar sakte|capable|abilities|features)\b/i.test(content)) {
    return "I can talk with you by voice, remember important moments, recall things by date, set reminders and check-ins, and notice emotional patterns over time without spamming you with memory logs.";
  }

  if (isMemoryCapabilityQuestion(content)) {
    if (/\b(date|dates|timestamp|timestamps|exact|when)\b/i.test(content)) {
      return "Yes. I keep your conversation archive with timestamps, so if you ask for a date or a specific period, I can try to recall it exactly. If I do not have a matching memory, I will say that honestly.";
    }
    return "Yes. I remember important things quietly in the background. If you want something pinned clearly, say “save this”; otherwise I use memory naturally without turning every reply into a log.";
  }

  if (/^\s*(stop|wait|pause|leave that|cancel|ruk|ruko|bas|chhodo|chod do)\b/i.test(content)) {
    return "Okay.";
  }

  return null;
}

function isRepetitionComplaint(content: string) {
  return /\b(don't|dont|do not|stop|why are you|again and again|same thing|repeat(?:ing)?|replay(?:ing)?|bar bar|baar baar|same line|loop)\b.{0,120}\b(same|repeat|again|thing|line|baat|reply|bol|bata)/i.test(content)
    || /\b(same thing|repeat mat|bar bar mat|baar baar mat|ek hi baat|wahi baat)\b/i.test(content);
}

function isUserCorrection(content: string) {
  return /^\s*(no|no no|nah|nahi|nahi nahi|wrong|galat|actually|i mean|what i mean|what i was saying|i said|maine bola|mera matlab|matlab)\b/i.test(content)
    || /\b(not the name|not called|name is|it is called|the name is|i mean|i meant|you misheard|you got.*wrong|you are wrong|galat samjha|galat suna)\b/i.test(content);
}

function deterministicConversationRepairReply(content: string) {
  if (isRepetitionComplaint(content)) {
    return "Okay. I’ll keep it direct.";
  }
  if (isUserCorrection(content)) {
    if (/\b(different|dusra|alag|another)\b.{0,40}\b(series|movie|show|film|episode)\b/i.test(content)) {
      return "Ah okay, got you.";
    }
    if (/^\s*actually\b/i.test(content) && !/\b(wrong|galat|misheard|got.*wrong|not that|not the|repeat|same thing|loop)\b/i.test(content)) {
      return null;
    }
    if (/\b(web series|movie|series|manali|hill station|rain|suspense|thriller|crime|mystery|sony)\b/i.test(content)) {
      return "Ah okay, got you.";
    }
    return "Ah okay, got you.";
  }
  return null;
}

function wantsExactRecallWording(content: string) {
  return /\b(?:exact|exactly|date|time|timestamp|when|what day|which day|archive|history|full|verbatim)\b/i.test(content)
    || /\b(?:kab|kis din|tareekh|tarikh|samay)\b/i.test(content);
}

function stripTimestampPrefix(text: string) {
  return text
    .replace(/^\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\s*/i, "")
    .replace(/^\[[^\]]+\]\s*/i, "")
    .replace(/^User:\s*/i, "")
    .replace(/^AURA:\s*/i, "")
    .replace(/^"|"$/g, "")
    .trim();
}

function polishRecallReply(reply: string, content: string) {
  if (wantsExactRecallWording(content)) return reply;
  const clean = reply.replace(/\s+/g, " ").trim();

  if (/^I don'?t have (?:a )?clear memory/i.test(clean) || /^I can'?t find a clear memory/i.test(clean)) {
    return "I don't have that clearly here.";
  }

  const quoted = clean.match(/"([^"]{4,220})"/);
  if (quoted?.[1]) {
    return `Yeah, you said: "${stripTimestampPrefix(quoted[1])}"`;
  }

  if (/^From .+ you said this/i.test(clean) || /^From .+ I remember this/i.test(clean)) {
    const afterColon = clean.split(/:\s*/).slice(1).join(": ");
    const compact = stripTimestampPrefix(afterColon || clean);
    return compact ? `Yeah, you said: "${compact.slice(0, 220)}"` : "Yeah, we touched on that.";
  }

  if (/^From .+ you said these things/i.test(clean) || /^From .+ I remember these moments/i.test(clean) || /^These are the moments/i.test(clean)) {
    const snippets = [...reply.matchAll(/"([^"]{4,160})"/g)]
      .map((match) => stripTimestampPrefix(match[1]))
      .filter(Boolean)
      .slice(0, 3);
    if (snippets.length) return `Yeah, a few things: ${snippets.join("; ")}.`;
  }

  return clean
    .replace(/^From your recent history,?\s*/i, "")
    .replace(/^From our recent conversation,?\s*/i, "")
    .replace(/^I remember that\s+/i, "Yeah, ")
    .replace(/^About .+?, I remember that\s+/i, "Yeah, ")
    .trim();
}

function voiceTextForReply(reply: string) {
  const clean = reply.replace(/\s+/g, " ").trim();
  if (/^From .+ I remember these moments/i.test(reply) || /^These are the moments/i.test(reply) || /\n- \d{4}-\d{2}-\d{2}/.test(reply)) {
    const firstLine = reply.split("\n")[0]?.replace(/\s+/g, " ").trim();
    return `${firstLine || "I found the memories."} I'm showing the details on screen.`;
  }

  return clean;
}

function asksForMemoryUse(content: string) {
  return /\b(what do you remember|what did i|when did i|recall|remember about|do you remember|have i told|what do you know about me|as i told you|as i said|you know that|you know i|you already know|like i told you|earlier|before|again|still|lately|recently|pattern)\b/i.test(content);
}

function languagePreferenceGuidance(preference: "auto" | "en" | "hi" | "hinglish") {
  if (preference === "en") return "User voice language preference: reply in English unless the user explicitly asks otherwise.";
  if (preference === "hi") return "User voice language preference: reply in Hindi when natural. Use simple Hindi/Hinglish, not overly formal Hindi.";
  if (preference === "hinglish") return "User voice language preference: Hinglish is preferred. Mix Hindi and English naturally like the user.";
  return "User voice language preference: auto. Match the user's current language naturally and obey direct language requests immediately.";
}

function polishCompanionReply(reply: string, content: string, mode: string) {
  if (mode === "utility") return reply;
  const cleaned = reply
    .replace(/\bIt takes courage to[^.!?]*[.!?]?/gi, "")
    .replace(/\bI'?m here to listen and support you[^.!?]*[.!?]?/gi, "")
    .replace(/\bIt'?s important to acknowledge your feelings[^.!?]*[.!?]?/gi, "")
    .replace(/\bYour feelings are valid[^.!?]*[.!?]?/gi, "")
    .replace(/\bIt sounds like you(?:'re| are) going through a lot[^.!?]*[.!?]?/gi, "That sounds heavy.")
    .replace(/\b(?:on|at)\s+\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2}(?::\d{2})?)?\b[^.!?]*[.!?]?/gi, "")
    .replace(/\b(?:from your memory|from memory|memory says|emotional continuity suggests|temporal context suggests)\b[^.!?]*[.!?]?/gi, "")
    .replace(/\bAs you (?:said|mentioned|told me)(?: earlier| before| previously)?,?\s*/gi, "")
    .replace(/\bYou (?:said|mentioned|told me)(?: earlier| before| previously)? that\s+/gi, "")
    .replace(/\bYou (?:said|mentioned|told me)(?: earlier| before| previously)?[^.!?]*[.!?]?/gi, "")
    .replace(/\bI remember(?: that)?\s+/gi, "")
    .replace(/^it seems like you(?:'re| are)\s+/i, "You're ")
    .replace(/^it sounds like you(?:'re| are)\s+/i, "You're ")
    .replace(/^it seems like\s+/i, "")
    .replace(/^it sounds like\s+/i, "")
    .replace(/^you (?:said|mentioned|told me)(?: before| earlier| previously)? that\s+/i, "")
    .trim();
  const sentences = cleaned
    .split(/(?<=[.!?])\s+/)
    .filter((sentence) => !/^\s*(you (?:said|mentioned|told me)|i remember|as you (?:said|mentioned|told me)|from your memory|memory says|emotional continuity suggests)/i.test(sentence));
  return (sentences.join(" ").trim() || cleaned).trim();
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function booleanHeader(value: string | undefined) {
  return /^(1|true|yes)$/i.test(value ?? "");
}

type RuntimeTimeContext = {
  timezone: string;
  utcIso: string;
  localDate: string;
  localTime: string;
  weekday: string;
  daypart: "morning" | "afternoon" | "evening" | "night";
  promptLine: string;
};

function safeDateTimeFormat(date: Date, timezone: string, options: Intl.DateTimeFormatOptions) {
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: timezone || "UTC", ...options }).format(date);
  } catch {
    return new Intl.DateTimeFormat("en-US", { timeZone: "UTC", ...options }).format(date);
  }
}

function localHourFor(date: Date, timezone: string) {
  const formatted = safeDateTimeFormat(date, timezone, {
    hour: "2-digit",
    hourCycle: "h23"
  });
  const hour = Number(formatted.match(/\d{1,2}/)?.[0] ?? "0");
  return Number.isFinite(hour) ? hour : date.getUTCHours();
}

function daypartForHour(hour: number): RuntimeTimeContext["daypart"] {
  if (hour >= 5 && hour < 12) return "morning";
  if (hour >= 12 && hour < 17) return "afternoon";
  if (hour >= 17 && hour < 21) return "evening";
  return "night";
}

function buildRuntimeTimeContext(now: Date, timezone: string): RuntimeTimeContext {
  const zone = timezone || "UTC";
  const localTime = safeDateTimeFormat(now, zone, { hour: "numeric", minute: "2-digit", hour12: true });
  const localDate = safeDateTimeFormat(now, zone, { month: "long", day: "numeric", year: "numeric" });
  const weekday = safeDateTimeFormat(now, zone, { weekday: "long" });
  const daypart = daypartForHour(localHourFor(now, zone));
  return {
    timezone: zone,
    utcIso: now.toISOString(),
    localDate,
    localTime,
    weekday,
    daypart,
    promptLine: `Runtime local time: ${weekday}, ${localDate}, ${localTime} (${daypart}; ${zone}). Use this for all current-time/daypart questions. Do not infer current time from memory.`
  };
}

function targetDaypart(content: string) {
  if (/\b(morning|subah|सुबह)\b/i.test(content)) return "morning" as const;
  if (/\b(afternoon|dopahar|दोपहर)\b/i.test(content)) return "afternoon" as const;
  if (/\b(evening|shaam|sham|शाम)\b/i.test(content)) return "evening" as const;
  if (/\b(night|tonight|raat|rat|रात)\b/i.test(content)) return "night" as const;
  return null;
}

function isCurrentTimeQuestion(content: string) {
  return /\b(what(?:'s| is) the time|what time is it|current time|time right now|time now|abhi kya time|abhi time|kitna baja|kitne baje|kya time)\b/i.test(content)
    || /(अभी|अब).{0,20}(समय|टाइम|बजे)/i.test(content);
}

function isCurrentDayQuestion(content: string) {
  return /\b(what day is today|which day is today|what(?:'s| is) today|today(?:'s)? date|what date is it|aaj kya din|aaj ka din|aaj date|aaj kya date)\b/i.test(content)
    || /(आज).{0,20}(दिन|तारीख|डेट)/i.test(content);
}

function isDaypartQuestion(content: string) {
  return /\b(is it|is this|abhi|kya abhi|right now)\b.{0,30}\b(morning|afternoon|evening|night|subah|dopahar|shaam|sham|raat)\b/i.test(content)
    || /(क्या|अभी).{0,30}(सुबह|दोपहर|शाम|रात)/i.test(content);
}

function isTimeAwareGreeting(content: string) {
  return /^\s*(good\s+(?:morning|afternoon|evening|night)|subah|shubh\s+ratri|शुभ\s+रात्रि)\b/i.test(content);
}

function isHowLongAgoQuestion(content: string) {
  return /\b(how long ago|kitni der pehle|kitna time pehle|kab bola|kab kaha)\b.{0,80}\b(i|maine|mene|mainne|मैंने|मैने|say|said|bola|kaha|बोला|कहा)\b/i.test(content)
    || /\b(how long ago did i say that|how long ago did i tell you that)\b/i.test(content);
}

function relativeTimeLabel(from: Date, to: Date) {
  const diffMs = Math.max(0, to.getTime() - from.getTime());
  const seconds = Math.floor(diffMs / 1000);
  if (seconds < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days} day${days === 1 ? "" : "s"} ago`;
  const months = Math.round(days / 30);
  if (months < 12) return `${months} month${months === 1 ? "" : "s"} ago`;
  const years = Math.round(months / 12);
  return `${years} year${years === 1 ? "" : "s"} ago`;
}

async function deterministicRuntimeTimeReply(
  content: string,
  userId: string,
  sessionId: string,
  excludeTurnId: string | undefined,
  runtimeTime: RuntimeTimeContext,
  now: Date
) {
  if (isCurrentTimeQuestion(content)) {
    return `It's ${runtimeTime.localTime} your local time.`;
  }

  if (isCurrentDayQuestion(content)) {
    return `Today is ${runtimeTime.weekday}, ${runtimeTime.localDate}.`;
  }

  if (isDaypartQuestion(content)) {
    const target = targetDaypart(content);
    if (!target) return `It's ${runtimeTime.daypart} right now.`;
    return target === runtimeTime.daypart
      ? `Yes, it's ${runtimeTime.daypart} right now.`
      : `No, it's ${runtimeTime.daypart} right now.`;
  }

  if (isHowLongAgoQuestion(content)) {
    const turns = await listConversationTurns(userId, 50);
    const previous = turns.find((turn) => turn.role === "user" && turn.session_id === sessionId && turn.id !== excludeTurnId && turn.content.trim())
      ?? turns.find((turn) => turn.role === "user" && turn.id !== excludeTurnId && turn.content.trim());
    if (!previous) return "I do not have a previous thing you said in this session yet.";
    return `You said it ${relativeTimeLabel(new Date(previous.created_at), now)}.`;
  }

  if (isTimeAwareGreeting(content)) {
    if (/\bgood\s+night|shubh\s+ratri|शुभ\s+रात्रि/i.test(content)) {
      return runtimeTime.daypart === "night" || runtimeTime.daypart === "evening"
        ? "Good night. Rest easy."
        : "Good night. Rest well when you get there.";
    }
    if (/\bgood\s+morning|subah|सुबह/i.test(content)) {
      return runtimeTime.daypart === "morning"
        ? "Good morning."
        : `Good morning. It's actually ${runtimeTime.daypart} right now.`;
    }
    if (/\bgood\s+afternoon/i.test(content)) return runtimeTime.daypart === "afternoon" ? "Good afternoon." : `Good afternoon. It's ${runtimeTime.daypart} right now.`;
    if (/\bgood\s+evening/i.test(content)) return runtimeTime.daypart === "evening" ? "Good evening." : `Good evening. It's ${runtimeTime.daypart} right now.`;
  }

  return null;
}

function activeAppSessionIdFromHeader(value: string | undefined, userId: string, timezone: string, createdAt: Date) {
  const clean = (value ?? "").trim().replace(/[^a-zA-Z0-9:_-]/g, "").slice(0, 160);
  if (!clean) return sessionIdFor(userId, timezone, createdAt);
  return `${userId}:${clean}`;
}

function extractScaleMarker(...texts: string[]) {
  for (const text of texts) {
    const match = text.match(/\b[a-z]+-[a-z]+-\d+\b/i);
    if (match) return match[0];
  }
  return null;
}

function isRepeatLastAuraReplyQuestion(content: string) {
  const normalized = content.toLowerCase().trim();
  return /\b(what did you just say|what did you say|say that again|repeat that|repeat what you said|can you repeat)\b/i.test(normalized)
    || /\b(tumne|tune|aapne)\b.{0,50}\b(abhi|just|last)\b.{0,50}\b(kya)\b.{0,20}\b(bola|kaha|said)\b/i.test(normalized)
    || /\b(abhi)\b.{0,40}\b(kya)\b.{0,20}\b(bola|kaha)\b/i.test(normalized);
}

async function repeatLastAuraReply(userId: string) {
  const turns = await listConversationTurns(userId, 20);
  const lastAssistant = turns.find((turn) => turn.role === "assistant" && turn.content.trim().length > 0);
  return lastAssistant
    ? `I just said: ${lastAssistant.content}`
    : "I do not have a previous reply to repeat yet.";
}

async function buildActiveSessionContext(userId: string, sessionId: string, excludeTurnId?: string) {
  const turns = (await listConversationTurns(userId, 80))
    .filter((turn) => turn.session_id === sessionId && turn.id !== excludeTurnId)
    .slice(0, 18)
    .reverse();
  if (!turns.length) return "No previous turns in this active app session.";
  return turns
    .map((turn) => `${turn.role === "assistant" ? "AURA" : "User"}: ${turn.content.replace(/\s+/g, " ").trim().slice(0, 260)}`)
    .join("\n");
}

async function buildRecentChatMessages(userId: string, sessionId: string, excludeTurnId?: string): Promise<ChatMessage[]> {
  const turns = (await listConversationTurns(userId, 80))
    .filter((turn) => turn.session_id === sessionId && turn.id !== excludeTurnId)
    .slice(0, 24)
    .reverse()
    .filter((turn) => turn.content.trim().length > 0)
    .slice(-12);

  return turns.map((turn) => ({
    role: turn.role,
    content: turn.content.replace(/\s+/g, " ").trim().slice(0, 900)
  }));
}

function asksCurrentSessionSummary(content: string) {
  return /\b(what were we talking about|what are we talking about|what was i saying|what did we just discuss|current conversation|this conversation|abhi.*(baat|talk)|kya.*baat.*kar|hum.*kya.*baat)\b/i.test(content);
}

async function deterministicActiveSessionReply(content: string, userId: string, sessionId: string, excludeTurnId?: string, newActiveSession = false) {
  if (!asksCurrentSessionSummary(content)) return null;
  const turns = (await listConversationTurns(userId, 80))
    .filter((turn) => turn.session_id === sessionId && turn.id !== excludeTurnId)
    .slice(0, 12)
    .reverse();
  const userTurns = turns
    .filter((turn) => turn.role === "user")
    .map((turn) => turn.content.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .slice(-5);
  if (!userTurns.length && newActiveSession) return "This is a new session, so I’m not carrying the last live thread as current context. I can look back at the previous session if you ask me to.";
  if (!userTurns.length) return "We have just started this session. Tell me what you want to talk about.";
  const latest = userTurns[userTurns.length - 1];
  const previous = userTurns.slice(0, -1).slice(-3);
  return previous.length
    ? `In this session, we were mainly on: ${previous.join("; ")}. Most recently, you said: ${latest}.`
    : `In this session, you were talking about: ${latest}.`;
}

async function buildActiveSessionGuidance(userId: string, sessionId: string, excludeTurnId?: string) {
  const turns = (await listConversationTurns(userId, 80))
    .filter((turn) => turn.session_id === sessionId && turn.id !== excludeTurnId)
    .slice(0, 24)
    .reverse();
  const correctionTurns = turns
    .filter((turn) => turn.role === "user" && (isUserCorrection(turn.content) || isRepetitionComplaint(turn.content)))
    .slice(-4)
    .map((turn) => turn.content.replace(/\s+/g, " ").trim().slice(0, 220));
  const lastAssistantQuestions = turns
    .filter((turn) => turn.role === "assistant" && /\?\s*$/.test(turn.content.trim()))
    .slice(-3)
    .map((turn) => turn.content.replace(/\s+/g, " ").trim().slice(0, 180));
  const latestUserTopic = [...turns]
    .reverse()
    .find((turn) => turn.role === "user" && turn.content.trim().length > 8)?.content
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 240);

  const parts = [
    correctionTurns.length ? `Recent user corrections/complaints to obey now: ${correctionTurns.join(" / ")}` : "",
    lastAssistantQuestions.length ? `Do not repeat these recent assistant questions: ${lastAssistantQuestions.join(" / ")}` : "",
    latestUserTopic ? `Latest active topic: ${latestUserTopic}` : ""
  ].filter(Boolean);
  return parts.length ? parts.join("\n") : "No special session guidance.";
}

function wordSet(text: string) {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, " ")
      .split(/\s+/)
      .filter((word) => word.length > 3)
  );
}

function similarityRatio(a: string, b: string) {
  const left = wordSet(a);
  const right = wordSet(b);
  if (!left.size || !right.size) return 0;
  let overlap = 0;
  for (const word of left) if (right.has(word)) overlap += 1;
  return overlap / Math.min(left.size, right.size);
}

async function recentAssistantReplies(userId: string, sessionId: string) {
  return (await listConversationTurns(userId, 20))
    .filter((turn) => turn.session_id === sessionId && turn.role === "assistant")
    .slice(0, 4)
    .map((turn) => turn.content.replace(/\s+/g, " ").trim());
}

async function deRepeatCompanionReply(reply: string, content: string, userId: string, sessionId: string, mode: string) {
  if (mode === "utility") return reply;
  if ((/^(?:open|launch|start)\b/i.test(content.trim()) && /\bcan't open\b/i.test(reply))
    || (/\b(?:switch|change)\b.{0,40}\b(?:voice|male|female)\b/i.test(content) && /\bcan't switch voices\b/i.test(reply))) {
    return reply;
  }
  const directCommand = deterministicCommandReply(content);
  if (directCommand) return directCommand;
  const directPattern = deterministicRecentPatternReply(content);
  if (directPattern) return directPattern;
  if (/^\s*(hmm+|hm+|umm+|uh+|haan|ha|ok|okay|acha|achha|huh)\s*\.?$/i.test(content)) {
    return "Yeah?";
  }
  if (/^\s*(stop|wait|pause|leave that|cancel|ruk|ruko|bas|chhodo|chod do)\b/i.test(content)) {
    return "Okay.";
  }
  if (/\b(answer normally|reply normally|normal answer|seedha jawab|simple bol|simple answer)\b/i.test(content)) {
    return "Okay. Simple and direct.";
  }
  if (/\b(no|nahi|wrong|galat|different|dusra|alag)\b.{0,80}\b(series|movie|show|film|episode)\b/i.test(content)) {
    return "Ah okay, got you.";
  }
  const recentReplies = await recentAssistantReplies(userId, sessionId).catch(() => []);
  const repeatsRecent = recentReplies.some((recent) => similarityRatio(reply, recent) >= 0.72);
  const repeatsQuestion = /\?\s*$/.test(reply.trim()) && recentReplies.some((recent) => {
    const recentQuestion = recent.match(/[^.!?]*\?\s*$/)?.[0] ?? "";
    return recentQuestion && similarityRatio(reply, recentQuestion) >= 0.55;
  });
  if (!repeatsRecent && !repeatsQuestion) return reply;

  if (/\b(web series|movie|series|manali|hill station|rain|suspense|thriller|crime|mystery|sony)\b/i.test(content)) {
    return "What kind of vibe is it?";
  }
  if (isRepetitionComplaint(content)) {
    return "Okay. I’ll keep it direct.";
  }
  if (/\b(tired|exhausted|drained|thak|stressed)\b/i.test(content)) {
    return "Yeah, today sounds draining.";
  }
  if (/\b(work|coding|app|aura|developer|startup)\b/i.test(content)) {
    return "What’s the next small step?";
  }
  return "Okay. Simple and direct.";
}

function scaleMockReply(input: {
  userId: string;
  content: string;
  memoryContext: string;
  archiveContext: string;
  recallHint: string;
}) {
  const marker = extractScaleMarker(input.content, input.memoryContext, input.archiveContext, input.recallHint);
  if (/\bwhat do you remember|recall|memory|goal\b/i.test(input.content)) {
    return marker
      ? `Mock recall for ${input.userId}: I found your isolated marker ${marker}.`
      : `Mock recall for ${input.userId}: no isolated marker was found yet.`;
  }
  if (/^\s*(stop|wait|pause|leave that|cancel|ruk|ruko|bas|chhodo|chod do)\b/i.test(input.content)) {
    return `Mock interrupt handled for ${input.userId}.`;
  }
  return marker
    ? `Mock reply for ${input.userId}: isolated marker ${marker}.`
    : `Mock reply for ${input.userId}.`;
}

captureRouter.post("/", enforceDailyLimit, async (req, res, next) => {
  try {
    const body = captureSchema.parse(req.body);
    const userId = getUserId(req);
    const skipVoice = body.skipVoice || booleanHeader(req.header("x-aura-skip-voice"));
    const scaleMode = scaleTestModeFromRequest(req, userId);
    const scaleUseRealLlm = scaleMode === "llm-sample" && booleanHeader(req.header("x-aura-use-real-llm"));
    const useMockBrain = scaleMode === "structure-mock" || (scaleMode === "llm-sample" && !scaleUseRealLlm);
    const skipExternalAi = Boolean(scaleMode);
    const providerOverrides = providerOverridesFromRequest(req);
    const createdAt = providerOverrides.testCreatedAt ? new Date(providerOverrides.testCreatedAt) : new Date();
    const runtimeTime = buildRuntimeTimeContext(createdAt, body.timezone);
    const analysisContent = body.pendingCheckIn
      ? `Self-improvement check-in: ${body.pendingCheckIn.promptQuestion ?? body.pendingCheckIn.title}\nOriginal request: ${body.pendingCheckIn.originalText ?? body.pendingCheckIn.title}\nUser answer: ${body.content}`
      : body.content;
    const analysis = await analyzeMemory(analysisContent);
    if (body.pendingCheckIn) {
      analysis.shouldStore = true;
      analysis.importantAutoMemory = true;
      analysis.importance = "medium";
      analysis.memoryLayer = "episodic";
      analysis.summary = `Check-in response: ${body.pendingCheckIn.promptQuestion ?? body.pendingCheckIn.title} User said: ${body.content}`;
      analysis.autoTags = Array.from(new Set([...analysis.autoTags, "check_in", "self_improvement", "habit"]));
    }
    const toolCall = inferAgentTool(body.content);
    const reminderDraft =
      toolCall.tool === "create_reminder" ? parseNaturalReminder(body.content, body.timezone) : null;
    const repeatLastReply = isRepeatLastAuraReplyQuestion(body.content);
    const currentSessionQuestion = asksCurrentSessionSummary(body.content);
    const preliminaryMemoryIntent = classifyMemoryIntent({
      content: body.content,
      dateRecall: null,
      reminderDraft: reminderDraft && !body.pendingCheckIn ? reminderDraft : null,
      explicitSaveIntent: analysis.explicitSaveIntent
    });
    if (!body.pendingCheckIn && preliminaryMemoryIntent !== "normal_chat" && preliminaryMemoryIntent !== "emotional_support" && preliminaryMemoryIntent !== "explicit_save") {
      analysis.shouldStore = false;
      analysis.importantAutoMemory = false;
    }
    const embedding = analysis.shouldStore && !skipExternalAi ? await createEmbedding(`${analysisContent}\n${analysis.summary}`, providerOverrides) : [];
	    const appSessionId = body.appSession?.id ?? req.header("x-aura-app-session-id");
	    const isNewActiveSession = body.appSession?.newActiveSession === true;
	    const sessionId = activeAppSessionIdFromHeader(appSessionId, userId, body.timezone, createdAt);

    await maybeSummarizeIdleSession(userId).catch((error) => {
      console.warn(`Idle session summary failed: ${error instanceof Error ? error.message : error}`);
    });

    const userTurn = await saveConversationTurn({
      userId,
      role: "user",
      content: body.content,
      inputMode: body.inputMode,
      timezone: body.timezone,
      sessionId,
      createdAt,
	      metadata: {
	        analysis,
	        source: "capture",
	        appSession: body.appSession ?? null,
	        pendingCheckIn: body.pendingCheckIn ?? null
	      }
	    }).catch((error) => {
      console.warn(`Conversation archive user turn failed: ${error instanceof Error ? error.message : error}`);
      return null;
    });

    await observeUserCognitionSignal({
      userId,
      content: body.content,
      timezone: body.timezone,
      createdAt
    }).catch((error) => {
      console.warn(`User cognition profile update failed: ${error instanceof Error ? error.message : error}`);
      return null;
    });

    const memory = analysis.shouldStore
      ? await saveMemory(userId, analysisContent, analysis, embedding).catch((error) => {
          console.warn(`Memory save failed: ${error instanceof Error ? error.message : error}`);
          return null;
        })
      : null;

    const savedReminder = reminderDraft && !body.pendingCheckIn
      ? await saveReminderDraft(userId, reminderDraft).catch((error) => {
          console.warn(`Reminder save failed: ${error instanceof Error ? error.message : error}`);
          return null;
        })
      : null;

    await maybeRefreshWorkingMemory(userId, body.timezone, createdAt).catch((error) => {
      console.warn(`Working memory refresh failed: ${error instanceof Error ? error.message : error}`);
      return null;
    });
    await maybeRunMemoryConsolidation({ userId, sessionId, timezone: body.timezone, now: createdAt }).catch((error) => {
      console.warn(`Temporal memory consolidation failed: ${error instanceof Error ? error.message : error}`);
      return null;
    });

    if (providerOverrides.chaos?.memoryDelayMs) {
      await sleep(providerOverrides.chaos.memoryDelayMs);
    }

    const [memoryContext, companionMemoryContext] = await Promise.all([
      buildMemoryContext(userId, body.content, embedding, 8).catch(() => ""),
      buildCompanionMemoryContext(userId, body.timezone, 10).catch(() => "")
    ]);
	    const skipArchiveForNewLiveSession = Boolean(
	      isNewActiveSession
	      && !asksForMemoryUse(body.content)
	      && !repeatLastReply
	      && !currentSessionQuestion
	      && !(reminderDraft && !body.pendingCheckIn)
	    );
	    const archiveContext = (reminderDraft && !body.pendingCheckIn) || repeatLastReply || currentSessionQuestion || skipArchiveForNewLiveSession
	      ? { recall: { isRecall: false }, context: "", answerHint: "" }
	      : await buildArchiveContext({
          userId,
          query: body.content,
          timezone: body.timezone,
          excludeIds: userTurn ? [userTurn.id] : []
        }).catch(() => ({ recall: { isRecall: false }, context: "", answerHint: "" }));
    const memoryIntent = repeatLastReply
      ? "conversation_history_recall" as const
      : classifyMemoryIntent({
          content: body.content,
          dateRecall: archiveContext.recall,
          reminderDraft: reminderDraft && !body.pendingCheckIn ? reminderDraft : null,
          explicitSaveIntent: analysis.explicitSaveIntent
        });
    const recallMode = memoryIntentMode(memoryIntent);
    const shouldDeriveMemoryAtoms = Boolean(userTurn)
      && (body.pendingCheckIn || memoryIntent === "normal_chat" || memoryIntent === "emotional_support" || memoryIntent === "explicit_save");
    const memoryAtomDerivation = shouldDeriveMemoryAtoms && userTurn
      ? await deriveMemoryAtomsFromTurn({
          userId,
          content: analysisContent,
          analysis,
          sourceTurnId: userTurn.id,
          createdAt
        }).catch((error) => {
          console.warn(`Memory atom derivation failed: ${error instanceof Error ? error.message : error}`);
          return { atoms: 0, associations: 0 };
        })
      : { atoms: 0, associations: 0 };
    const continuityDerivation = userTurn
      ? await deriveContinuityFromTurn({
          userId,
          content: analysisContent,
          timezone: body.timezone,
          sourceTurnId: userTurn.id,
          analysis,
          mode: recallMode,
          reminderDraft: reminderDraft && !body.pendingCheckIn ? reminderDraft : null
        }).catch((error) => {
          console.warn(`Emotional continuity derivation failed: ${error instanceof Error ? error.message : error}`);
          return null;
        })
      : null;
    const companionContinuity = await buildCompanionContinuityContext({
      userId,
      query: body.content,
      mode: recallMode
    }).catch((error) => {
      console.warn(`Companion continuity context failed: ${error instanceof Error ? error.message : error}`);
      return { mode: recallMode, context: "" };
    });
    const activeSessionContext = await buildActiveSessionContext(userId, sessionId, userTurn?.id).catch((error) => {
      console.warn(`Active session context failed: ${error instanceof Error ? error.message : error}`);
      return "No active session context available.";
    });
    const activeSessionGuidance = await buildActiveSessionGuidance(userId, sessionId, userTurn?.id).catch((error) => {
      console.warn(`Active session guidance failed: ${error instanceof Error ? error.message : error}`);
      return "No special session guidance.";
    });
    const temporalContext = await buildTemporalContextBundle({
      userId,
      sessionId,
      content: body.content,
      timezone: body.timezone,
      createdAt,
      memoryIntent,
      recallMode,
      analysis,
      activeSessionContext,
      activeSessionGuidance,
      companionContinuity: companionContinuity.context,
      companionMemoryContext,
      archiveContext: archiveContext.context,
      archiveAnswerHint: archiveContext.answerHint,
      excludeTurnId: userTurn?.id ?? null
    }).catch((error) => {
      console.warn(`Temporal context engine failed: ${error instanceof Error ? error.message : error}`);
      return {
        promptContext: [
          `Working context (highest priority): ${activeSessionContext}`,
          `Correction/stale protection: ${activeSessionGuidance}`,
          companionMemoryContext ? `Companion summaries: ${companionMemoryContext}` : "",
          companionContinuity.context ? `Emotional continuity: ${companionContinuity.context}` : ""
        ].filter(Boolean).join("\n"),
        activeThread: "general",
        energyState: "quiet" as const,
        currentTruth: [],
        correctionGuidance: "",
        staleWarnings: [],
        confidence: {
          memoryConfidence: 0.25,
          temporalConfidence: 0.25,
          threadConfidence: 0.25,
          emotionalConfidence: 0.25,
          overallConfidence: 0.25
        },
        entropy: {
          score: 1,
          level: "high" as const,
          activeThreadCount: 0,
          topicSwitches: 0,
          unresolvedEmotionalStates: 0,
          contradictionCount: 0,
          memoryCompetition: 0,
          repairAttempts: 0,
          contextBudgetPressure: 1
        },
        latency: {
          recentSessionLoadMs: 0,
          memoryScoringMs: 0,
          compressionMs: 0,
          totalMs: 0,
          budgetExceeded: true
        },
        safeDegradationReason: "temporal_context_engine_failed",
        contextTokens: 0,
        debug: {
          activeThread: "general",
          energyState: "quiet" as const,
          selectedMemoryCount: 0,
          buckets: {},
          currentTruth: [],
          staleWarnings: [],
          confidence: {
            memoryConfidence: 0.25,
            temporalConfidence: 0.25,
            threadConfidence: 0.25,
            emotionalConfidence: 0.25,
            overallConfidence: 0.25
          },
          entropy: {
            score: 1,
            level: "high" as const,
            activeThreadCount: 0,
            topicSwitches: 0,
            unresolvedEmotionalStates: 0,
            contradictionCount: 0,
            memoryCompetition: 0,
            repairAttempts: 0,
            contextBudgetPressure: 1
          },
          latency: {
            recentSessionLoadMs: 0,
            memoryScoringMs: 0,
            compressionMs: 0,
            totalMs: 0,
            budgetExceeded: true
          },
          safeDegradationReason: "temporal_context_engine_failed",
          contextTokens: 0,
          trimmedSections: [],
          adaptationConfidence: 0,
          selectedMemories: [],
          suppressedMemories: []
        }
      };
    });

    const memoryGovernor = governMemoryForPrompt({
      content: body.content,
      memoryIntent,
      recallMode,
      temporalContext,
      activeSessionContext,
      activeSessionGuidance,
      archiveContext: archiveContext.context,
      archiveAnswerHint: archiveContext.answerHint,
      newActiveSession: isNewActiveSession,
      analysis: {
        explicitSaveIntent: analysis.explicitSaveIntent,
        importance: analysis.importance,
        emotionalState: analysis.emotionalState
      }
    });

    const deterministicRepeatReply = repeatLastReply
      ? await repeatLastAuraReply(userId).catch(() => "I could not find my last reply clearly.")
      : null;
    const deterministicCommand = !body.pendingCheckIn && !reminderDraft && !deterministicRepeatReply
      ? deterministicCommandReply(body.content)
      : null;
    const deterministicRepairReply = !body.pendingCheckIn && !reminderDraft && !archiveContext.recall.isRecall && !deterministicRepeatReply && !deterministicCommand
      ? deterministicConversationRepairReply(body.content)
      : null;
    const deterministicPatternReply = !body.pendingCheckIn && !reminderDraft && !archiveContext.recall.isRecall && !deterministicRepeatReply && !deterministicCommand
      ? deterministicRecentPatternReply(body.content)
      : null;
    const deterministicReply = !body.pendingCheckIn && !reminderDraft && !archiveContext.recall.isRecall && !deterministicRepeatReply && !deterministicCommand
      ? deterministicSmallTalkReply(body.content)
      : null;
    const deterministicActiveReply = !body.pendingCheckIn && !reminderDraft && !deterministicRepeatReply && !deterministicCommand && !deterministicPatternReply && !deterministicReply
      ? await deterministicActiveSessionReply(body.content, userId, sessionId, userTurn?.id, isNewActiveSession).catch(() => null)
      : null;
    const deterministicTimeReply = !body.pendingCheckIn && !reminderDraft && !deterministicRepeatReply && !deterministicCommand
      ? await deterministicRuntimeTimeReply(body.content, userId, sessionId, userTurn?.id, runtimeTime, createdAt).catch(() => null)
      : null;
    const deterministicRecallReply = !body.pendingCheckIn && !reminderDraft && archiveContext.recall.isRecall && archiveContext.answerHint
      ? polishRecallReply(archiveContext.answerHint, body.content)
      : null;
    const recentChatMessages = await buildRecentChatMessages(userId, sessionId, userTurn?.id).catch(() => []);
    const cleanGenerationMessages: ChatMessage[] = recallMode === "utility"
      ? [
          {
            role: "system",
            content: "You are Aura, a natural voice-first AI assistant. Reply conversationally and concisely."
          },
          ...recentChatMessages,
          {
            role: "user",
            content: [
              body.content,
              deterministicRecallReply ? `Useful recall answer: ${deterministicRecallReply}` : "",
              archiveContext.context && wantsExactRecallWording(body.content) ? `Exact recall context: ${archiveContext.context}` : ""
            ].filter(Boolean).join("\n")
          }
        ]
      : [
          {
            role: "system",
            content: "You are Aura, a natural voice-first AI assistant. Reply conversationally and concisely."
          },
          ...recentChatMessages,
          {
            role: "user",
            content: [
              body.content,
              runtimeTime.promptLine,
              languagePreferenceGuidance(body.languagePreference)
            ].join("\n")
          }
        ];
    const mockReply = useMockBrain
      ? scaleMockReply({
          userId,
          content: body.content,
          memoryContext,
          archiveContext: archiveContext.context,
          recallHint: archiveContext.answerHint
        })
      : null;

    let reply = reminderDraft && !body.pendingCheckIn
      ? reminderReply(reminderDraft)
      : deterministicRepeatReply ?? deterministicCommand ?? deterministicRepairReply ?? deterministicPatternReply ?? deterministicTimeReply ?? deterministicReply ?? deterministicActiveReply ?? deterministicRecallReply ?? mockReply ?? await completeCalmSystemPrompt(cleanGenerationMessages, providerOverrides);

    if (!deterministicRecallReply && !reminderDraft && archiveContext.recall.isRecall && archiveContext.answerHint) {
      reply = polishRecallReply(archiveContext.answerHint, body.content);
    }

    if (analysis.explicitSaveIntent) {
      reply = "got it, i'll remember that.";
    }

    const checkInAnswer = body.pendingCheckIn ? detectCheckInAnswer(body.content) : null;
    const checkInResult = body.pendingCheckIn
      ? {
          reminderId: body.pendingCheckIn.id,
          answer: checkInAnswer,
          handled: checkInAnswer === "yes" || checkInAnswer === "no"
        }
      : null;

    if (body.pendingCheckIn && checkInAnswer === "yes") {
      reply = "You started around the time you asked me to check in. Try not to add more right now. Drink some water, settle in, and do something you actually enjoy while this passes.";
    } else if (body.pendingCheckIn && checkInAnswer === "no") {
      reply = "Good. Keep that promise to yourself for a little longer. Let the urge pass, drink some water, and do something calm for the next few minutes.";
    } else if (body.pendingCheckIn && checkInAnswer === "unclear") {
      reply = "Are you still doing it, yes or no?";
    }

    if (!analysis.explicitSaveIntent && !archiveContext.recall.isRecall) {
      reply = polishCompanionReply(reply, body.content, recallMode);
      if (!deterministicTimeReply) {
        reply = reply.replace(/\b(I\s+)?(saved|save|remembered|stored)\s+(this|that|it|moment|journal entry|memory)[^.!?]*[.!?]?/gi, "").trim() || "Okay.";
        if (!archiveContext.recall.isRecall && /^I remember\.?$/i.test(reply)) {
          reply = "Okay.";
        }
        reply = await deRepeatCompanionReply(reply, body.content, userId, sessionId, recallMode);
        const assistantGuard = await guardAssistantReply({
          userId,
          sessionId,
          userText: body.content,
          reply,
          mode: recallMode
        }).catch((error) => {
          console.warn(`Assistant reply guard failed: ${error instanceof Error ? error.message : error}`);
          return { reply, changed: false, issues: [], repairCooldown: false };
        });
        reply = assistantGuard.reply;
      }
    }

    const assistantTurn = await saveConversationTurn({
      userId,
      role: "assistant",
      content: reply,
      inputMode: "assistant",
      timezone: body.timezone,
      sessionId,
      createdAt,
      metadata: {
	        source: "capture",
	        userTurnId: userTurn?.id ?? null,
	        appSession: body.appSession ?? null,
	        dateRecall: archiveContext.recall,
        recallMode,
        memoryIntent,
        memoryAtomDerivation,
        temporalContext: temporalContext.debug,
        memoryGovernor: memoryGovernor.debug,
        companionContinuity: companionContinuity.context ? true : false,
        checkInResult,
        reminder: savedReminder
      }
    }).catch((error) => {
      console.warn(`Conversation archive assistant turn failed: ${error instanceof Error ? error.message : error}`);
      return null;
    });

    await recordAssistantReply({
      userId,
      sessionId,
      reply,
      createdAt
    }).catch((error) => {
      console.warn(`Assistant reply memory save failed: ${error instanceof Error ? error.message : error}`);
    });

    await logProductLearningSignals({
      userId,
      userText: body.content,
      reply,
      memoryIntent,
      reminderTitle: savedReminder?.title ?? reminderDraft?.title ?? null
    }).catch((error) => {
      console.warn(`Product learning log failed: ${error instanceof Error ? error.message : error}`);
    });

    const spokenReply = voiceTextForReply(reply);
    const wasVoiceShortened = spokenReply !== reply.replace(/\s+/g, " ").trim();
    console.log("[capture] voice text prepared", {
      userId,
      replyLength: reply.length,
      voiceTextLength: spokenReply.length,
      wasShortened: wasVoiceShortened,
      priority: reminderDraft || body.pendingCheckIn ? "reminder" : "reply"
    });

    const voice = skipVoice
      ? null
      : await queueVoiceSynthesis({
          userId,
          text: spokenReply,
          priority: reminderDraft || body.pendingCheckIn ? "reminder" : "reply",
          speechSessionId: req.header("x-aura-speech-session-id") ?? null,
          interruptPrevious: true,
          staleAfterMs: undefined,
          overrides: providerOverrides,
          fast: true
        });

    res.json({
      reply,
      memory,
      analysis,
      toolCall,
      usage: res.locals.usage ?? null,
      reminder: savedReminder,
      reminderDraft,
      checkInResult,
      voice,
      scaleTest: scaleMode ? {
        mode: scaleMode,
        usedRealLlm: !useMockBrain,
        skippedExternalAi: skipExternalAi
      } : null,
      archive: {
        userTurn,
        assistantTurn,
        dateRecall: archiveContext.recall,
        recallMode,
        memoryIntent
      },
      temporal: booleanHeader(req.header("x-aura-debug-temporal")) ? temporalContext.debug : undefined,
      memoryGovernor: booleanHeader(req.header("x-aura-debug-temporal")) ? memoryGovernor.debug : undefined
    });
  } catch (error) {
    next(error);
  }
});
