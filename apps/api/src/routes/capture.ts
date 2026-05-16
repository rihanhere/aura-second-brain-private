import { Router } from "express";
import { z } from "zod";
import { inferAgentTool } from "../services/agentTools.js";
import { analyzeMemory } from "../services/memoryAnalyzer.js";
import { buildMemoryContext, maybeSummarizeIdleSession, saveMemory } from "../services/memoryStore.js";
import { completeCalmSystemPrompt, createEmbedding } from "../services/openRouter.js";
import { providerOverridesFromRequest } from "../services/providerOverrides.js";
import { describeReminderTime, parseNaturalReminder } from "../services/reminderParser.js";
import { saveReminderDraft } from "../services/reminderStore.js";
import { enforceDailyLimit } from "../middleware/usageLimit.js";
import { getUserId } from "../middleware/auth.js";
import { buildArchiveContext, saveConversationTurn, sessionIdFor } from "../services/conversationArchive.js";
import { buildCompanionContinuityContext, deriveContinuityFromTurn } from "../services/emotionalContinuity.js";
import { deriveMemoryAtomsFromTurn } from "../services/memoryAtoms.js";
import { classifyMemoryIntent, memoryIntentMode } from "../services/memoryIntentRouter.js";
import { scaleTestModeFromRequest } from "../services/scaleTest.js";
import { queueVoiceSynthesis } from "../services/voiceOrchestrator.js";

export const captureRouter = Router();

const captureSchema = z.object({
  content: z.string().min(1).max(4000),
  inputMode: z.enum(["text", "voice"]).default("text"),
  timezone: z.string().default("UTC"),
  skipVoice: z.boolean().default(false),
  pendingCheckIn: z.object({
    id: z.string(),
    title: z.string(),
    promptQuestion: z.string().nullable().optional(),
    originalText: z.string().optional(),
    scheduledAt: z.string().optional()
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

function deterministicSmallTalkReply(content: string) {
  const normalized = normalizedUtterance(content);
  if (!normalized) return null;

  if (/^(hi|hello|hey|yo|namaste|namaskar|hii|helo)$/.test(normalized)) {
    return "Hello, Rihan. I'm listening.";
  }

  if (/\b(are you listening|can you hear me|sun rahe ho|sun rahi ho|listening)\b/i.test(content)) {
    return "Yes, I'm listening. Say whatever is on your mind.";
  }

  if (/\b(what can you do|what are you capable of|tum kya kya kar sakte|kya kar sakte|capable|abilities|features)\b/i.test(content)) {
    return "I can talk with you by voice, remember important moments, recall things by date, set reminders and check-ins, and notice emotional patterns over time without spamming you with memory logs.";
  }

  if (/^\s*(stop|wait|pause|leave that|cancel|ruk|ruko|bas|chhodo|chod do)\b/i.test(content)) {
    return "Okay. I paused that. Tell me what you want to do next.";
  }

  return null;
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

function promptMemoryContext(mode: string, content: string, memoryContext: string) {
  if (mode === "utility") return memoryContext || "No smart memories yet.";
  if (asksForMemoryUse(content)) {
    return memoryContext
      ? `Quietly useful memory context. Use naturally; do not cite it like a log:\n${memoryContext}`
      : "No smart memories yet.";
  }
  return "Hidden for this normal companion turn. Reply to the current message first; do not prove memory.";
}

function promptArchiveContext(mode: string, archiveContext: string) {
  if (mode === "utility") return archiveContext || "No relevant raw archive turns.";
  return "Hidden for companion mode. Do not use timestamped archive or say the user mentioned something before unless they ask for recall.";
}

function promptArchiveDraft(mode: string, answerHint: string) {
  if (mode === "utility") return answerHint || "No deterministic recall draft.";
  return "No recall draft; this is normal conversation.";
}

function polishCompanionReply(reply: string, content: string, mode: string) {
  if (mode === "utility") return reply;
  const cleaned = reply
    .replace(/\bAs you (?:said|mentioned|told me)(?: earlier| before| previously)?,?\s*/gi, "")
    .replace(/\bYou (?:said|mentioned|told me)(?: earlier| before| previously)? that\s+/gi, "")
    .replace(/\bI remember(?: that)?\s+/gi, "")
    .replace(/^it seems like you(?:'re| are)\s+/i, "You're ")
    .replace(/^it sounds like you(?:'re| are)\s+/i, "You're ")
    .replace(/^it seems like\s+/i, "")
    .replace(/^it sounds like\s+/i, "")
    .replace(/^you (?:said|mentioned|told me)(?: before| earlier| previously)? that\s+/i, "")
    .trim();
  const sentences = cleaned
    .split(/(?<=[.!?])\s+/)
    .filter((sentence) => !/^\s*(you (?:said|mentioned|told me)|i remember|as you (?:said|mentioned|told me))/i.test(sentence));
  return (sentences.join(" ").trim() || cleaned).trim();
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function booleanHeader(value: string | undefined) {
  return /^(1|true|yes)$/i.test(value ?? "");
}

function extractScaleMarker(...texts: string[]) {
  for (const text of texts) {
    const match = text.match(/\b[a-z]+-[a-z]+-\d+\b/i);
    if (match) return match[0];
  }
  return null;
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
    const sessionId = sessionIdFor(userId, body.timezone, createdAt);

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
        pendingCheckIn: body.pendingCheckIn ?? null
      }
    }).catch((error) => {
      console.warn(`Conversation archive user turn failed: ${error instanceof Error ? error.message : error}`);
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

    if (providerOverrides.chaos?.memoryDelayMs) {
      await sleep(providerOverrides.chaos.memoryDelayMs);
    }

    const memoryContext = await buildMemoryContext(userId, body.content, embedding, 8).catch(() => "");
    const archiveContext = reminderDraft && !body.pendingCheckIn
      ? { recall: { isRecall: false }, context: "", answerHint: "" }
      : await buildArchiveContext({
          userId,
          query: body.content,
          timezone: body.timezone,
          excludeIds: userTurn ? [userTurn.id] : []
        }).catch(() => ({ recall: { isRecall: false }, context: "", answerHint: "" }));
    const memoryIntent = classifyMemoryIntent({
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

    const deterministicReply = !body.pendingCheckIn && !reminderDraft && !archiveContext.recall.isRecall
      ? deterministicSmallTalkReply(body.content)
      : null;
    const deterministicRecallReply = !body.pendingCheckIn && !reminderDraft && archiveContext.recall.isRecall && archiveContext.answerHint
      ? archiveContext.answerHint
      : null;
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
      : deterministicReply ?? deterministicRecallReply ?? mockReply ?? await completeCalmSystemPrompt([
          {
            role: "system",
            content:
              [
                "You are AURA, a premium AI life journal and companion. You are not a generic chatbot.",
                "Reply briefly, warmly, and contextually. For normal companion chat, use 1-3 short sentences and stay under about 450 characters unless the user explicitly asks for detail. No bullet lists unless necessary. Do not use emoji.",
                "Answer the user's actual words. For greetings, greet naturally. For capability questions, explain concrete AURA abilities. Do not use generic filler like 'I heard you, I am here with you' unless the user is clearly distressed.",
                "Default to a normal human reply. Do not perform memory. In companion mode, avoid opening with 'It seems like', 'It sounds like', 'You said', 'You mentioned', 'You told me', or 'I remember'.",
                "AURA saves raw conversation silently in the background. Never say something was saved during normal conversation.",
                "Only say you saved/remembered something when explicitSaveIntent is true.",
	                "If dateRecall is true, answer from the raw archive context with dates. If the archive has no matches, say honestly that you do not have a memory from that period.",
	                "If recallMode is companion, memory is quiet background only. Answer the current message first. Do not cite memories, old turns, timestamps, or the fact that the user mentioned something before. Even with repeated patterns, phrase it naturally instead of proving recall.",
                "When memory is useful inside another answer, weave it naturally without naming the source. Good: 'That fits the direction you are building toward.' Bad: 'You said before you are building an app.'",
	                "For goals like becoming a developer, learning coding, or vibe coding, respond with practical encouragement and next steps. Do not force old AURA app context unless the user asks.",
	                "Avoid generic motivational filler like 'dedication and persistence'. Prefer one concrete next step or one grounded question.",
                "If recallMode is utility, prioritize deterministic archive/reminder/save behavior over emotional commentary.",
                "Never diagnose the user. Say patterns softly, like 'you've seemed worn out lately', not clinical labels.",
                "If pendingCheckIn is present, answer like a calm self-improvement companion. Be supportive, practical, and non-shaming."
              ].join(" ")
          },
          {
	            role: "user",
	            content: `User said: ${body.content}\nCurrent time: ${new Date().toISOString()} (${body.timezone})\nPending check-in: ${JSON.stringify(body.pendingCheckIn ?? null)}\nMemory intent: ${memoryIntent}\nRecall mode: ${recallMode}\nCompanion continuity context:\n${companionContinuity.context || "No companion continuity context."}\nSmart memory context:\n${promptMemoryContext(recallMode, body.content, memoryContext)}\nExact archive context:\n${promptArchiveContext(recallMode, archiveContext.context)}\nDate recall: ${JSON.stringify(archiveContext.recall)}\nArchive recall draft:\n${promptArchiveDraft(recallMode, archiveContext.answerHint)}\nAnalysis: ${JSON.stringify(analysis)}\nMemory atoms derived this turn: ${JSON.stringify(memoryAtomDerivation)}\nEmotional continuity derived this turn: ${JSON.stringify(continuityDerivation)}\nTool draft: ${JSON.stringify(toolCall)}`
          }
        ], providerOverrides);

    if (!deterministicRecallReply && !reminderDraft && archiveContext.recall.isRecall && archiveContext.answerHint) {
      reply = archiveContext.answerHint;
    }

    if (analysis.explicitSaveIntent) {
      reply = "I heard you. I saved this moment.";
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
      reply = "I hear you. Are you still doing it, yes or no?";
    }

    if (!analysis.explicitSaveIntent && !archiveContext.recall.isRecall) {
      reply = polishCompanionReply(reply, body.content, recallMode);
      reply = reply.replace(/\b(I\s+)?(saved|save|remembered|stored)\s+(this|that|it|moment|journal entry|memory)[^.!?]*[.!?]?/gi, "").trim() || "I hear you.";
      if (!archiveContext.recall.isRecall && /^I remember\.?$/i.test(reply)) {
        reply = "I hear you.";
      }
    }

    await saveConversationTurn({
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
        dateRecall: archiveContext.recall,
        recallMode,
        memoryIntent,
        memoryAtomDerivation,
        companionContinuity: companionContinuity.context ? true : false,
        checkInResult,
        reminder: savedReminder
      }
    }).catch((error) => {
      console.warn(`Conversation archive assistant turn failed: ${error instanceof Error ? error.message : error}`);
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
        dateRecall: archiveContext.recall,
        recallMode,
        memoryIntent
      }
    });
  } catch (error) {
    next(error);
  }
});
