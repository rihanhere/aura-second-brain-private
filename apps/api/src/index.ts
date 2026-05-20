import cors from "cors";
import express, { type ErrorRequestHandler } from "express";
import helmet from "helmet";
import { createServer } from "node:http";
import { env } from "./config/env.js";
import { brainRouter } from "./routes/brain.js";
import { attachUser } from "./middleware/auth.js";
import { captureRouter } from "./routes/capture.js";
import { clientEventsRouter } from "./routes/clientEvents.js";
import { insightsRouter } from "./routes/insights.js";
import { keysRouter } from "./routes/keys.js";
import { memoriesRouter } from "./routes/memories.js";
import { remindersRouter } from "./routes/reminders.js";
import { todosRouter } from "./routes/todos.js";
import { usageRouter } from "./routes/usage.js";
import { voiceRouter } from "./routes/voice.js";
import { getGeminiVoiceStatus } from "./services/geminiVoice.js";
import { archiveStatus } from "./services/conversationArchive.js";
import { continuityStatus } from "./services/emotionalContinuity.js";
import { memoryAtomsStatus } from "./services/memoryAtoms.js";
import { checkMemoryStore } from "./services/memoryStore.js";
import { getOpenRouterStatus } from "./services/openRouter.js";
import { getProductionReadiness } from "./services/productionReadiness.js";
import { getTranscriptionStatus } from "./services/transcription.js";
import { getBrainOrchestratorMetrics } from "./services/brainOrchestrator.js";
import { getVoiceOrchestratorMetrics, startVoiceOrchestratorCleanup } from "./services/voiceOrchestrator.js";
import { assistantReplyMemoryStatus } from "./services/assistantReplyMemory.js";
import { memoryPersistenceStatus } from "./services/memoryPersistenceAdapter.js";
import { privacySettingsStatus } from "./services/privacySettings.js";
import { userCognitionProfileStatus } from "./services/userCognitionProfile.js";
import { reminderStoreStatus } from "./services/reminderStore.js";
import { getRealtimeConversationMetrics, setupRealtimeConversationServer } from "./services/realtimeConversation.js";

const app = express();

app.use(helmet());
app.use(cors({
  origin: env.appOrigin === "*" ? true : env.appOrigin,
  methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "x-user-id", "x-aura-openrouter-keys", "x-aura-groq-key", "x-aura-groq-keys", "x-aura-gemini-keys", "x-aura-chaos", "x-aura-test-created-at", "x-aura-speech-session-id", "x-aura-skip-voice", "x-aura-test-mode", "x-aura-use-real-llm", "x-aura-app-session-id", "x-aura-debug-temporal", "x-aura-private-mode"],
  optionsSuccessStatus: 204
}));
app.use(express.json({ limit: "1mb" }));
app.use(attachUser);

app.use((req, res, next) => {
  const startedAt = Date.now();
  res.on("finish", () => {
    console.log("[request]", {
      method: req.method,
      path: req.originalUrl,
      status: res.statusCode,
      durationMs: Date.now() - startedAt,
      remoteAddress: req.ip,
      userAgent: req.headers["user-agent"]
    });
  });
  next();
});

app.get("/health", async (_req, res) => {
  const memory = await checkMemoryStore();
  const production = await getProductionReadiness();
  res.json({
    ok: true,
    service: "aura-api",
    version: "0.1.0",
    production,
    providers: {
      ai: getOpenRouterStatus(),
      brainOrchestrator: getBrainOrchestratorMetrics(),
      transcription: getTranscriptionStatus(),
      voice: getGeminiVoiceStatus(),
      voiceOrchestrator: getVoiceOrchestratorMetrics(),
      memory,
	      archive: archiveStatus(),
	      memoryAtoms: memoryAtomsStatus(),
	      emotionalContinuity: continuityStatus(),
	      assistantReplyMemory: assistantReplyMemoryStatus(),
	      reminders: reminderStoreStatus(),
	      privacy: privacySettingsStatus(),
	      userCognitionProfile: userCognitionProfileStatus(),
	      persistence: memoryPersistenceStatus(),
	      realtime: getRealtimeConversationMetrics()
	    }
	  });
	});

app.use("/brain", brainRouter);
app.use("/capture", captureRouter);
app.use("/client-events", clientEventsRouter);
app.use("/keys", keysRouter);
app.use("/memories", memoriesRouter);
app.use("/reminders", remindersRouter);
app.use("/todos", todosRouter);
app.use("/insights", insightsRouter);
app.use("/usage", usageRouter);
app.use("/voice", voiceRouter);

const errorHandler: ErrorRequestHandler = (error, _req, res, _next) => {
  console.error(error);
  res.status(error.statusCode ?? 500).json({
    message: error.message ?? "Something went quiet in the system. Try again."
  });
};

app.use(errorHandler);

startVoiceOrchestratorCleanup();

const server = createServer(app);
setupRealtimeConversationServer(server);

server.listen(env.port, env.host, () => {
  console.log(`AURA API listening on ${env.host}:${env.port}`);
});
