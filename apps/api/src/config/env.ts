import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

const configDir = path.dirname(fileURLToPath(import.meta.url));
const apiDir = path.resolve(configDir, "..", "..");
dotenv.config({ path: path.join(apiDir, ".env") });
dotenv.config();

export const env = {
  auraEnv: process.env.AURA_ENV ?? process.env.NODE_ENV ?? "beta",
  port: Number(process.env.PORT ?? 4000),
  host: process.env.HOST ?? "0.0.0.0",
  appOrigin: process.env.APP_ORIGIN ?? "*",
  redisUrl: process.env.REDIS_URL ?? "",
  redisKeyPrefix: process.env.REDIS_KEY_PREFIX ?? "aura",
  supabaseUrl: process.env.SUPABASE_URL ?? "",
  supabaseServiceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY ?? "",
  openRouterApiKey: process.env.OPENROUTER_API_KEY ?? "",
  openRouterApiKeys: (process.env.OPENROUTER_API_KEYS ?? process.env.OPENROUTER_API_KEY ?? "")
    .split(",")
    .map((key) => key.trim())
    .filter(Boolean),
  openRouterModel: process.env.OPENROUTER_MODEL ?? "z-ai/glm-4.5-air",
  openRouterFallbackModels: (process.env.OPENROUTER_FALLBACK_MODELS ?? "google/gemini-flash-1.5")
    .split(",")
    .map((model) => model.trim())
    .filter(Boolean),
  nvidiaApiKeys: (process.env.NVIDIA_API_KEYS ?? process.env.NVIDIA_API_KEY ?? process.env.NVAPI_API_KEYS ?? "")
    .split(",")
    .map((key) => key.trim())
    .filter(Boolean),
  nvidiaBaseUrl: process.env.NVIDIA_BASE_URL ?? "https://integrate.api.nvidia.com/v1",
  nvidiaModel: process.env.NVIDIA_MODEL || "meta/llama-3.3-70b-instruct",
  nvidiaFallbackModels: (process.env.NVIDIA_FALLBACK_MODELS || "mistralai/mistral-small-4-119b-2603,meta/llama-3.1-8b-instruct")
    .split(",")
    .map((model) => model.trim())
    .filter(Boolean),
  embeddingModel: process.env.EMBEDDING_MODEL ?? "openai/text-embedding-3-small",
  groqApiKey: process.env.GROQ_API_KEY ?? "",
  groqApiKeys: (process.env.GROQ_API_KEYS ?? process.env.GROQ_API_KEY ?? "")
    .split(",")
    .map((key) => key.trim())
    .filter(Boolean),
  groqTranscriptionModel: process.env.GROQ_TRANSCRIPTION_MODEL ?? "whisper-large-v3-turbo",
  geminiApiKey: process.env.GEMINI_API_KEY ?? "",
  geminiApiKeys: (process.env.GEMINI_API_KEYS ?? process.env.GEMINI_API_KEY ?? "")
    .split(",")
    .map((key) => key.trim())
    .filter(Boolean),
  geminiTtsModel: process.env.GEMINI_TTS_MODEL ?? "gemini-2.5-flash-preview-tts",
  geminiTtsVoice: process.env.GEMINI_TTS_VOICE ?? "Sulafat",
  elevenLabsApiKey: process.env.ELEVENLABS_API_KEY ?? "",
  elevenLabsVoiceId: process.env.ELEVENLABS_VOICE_ID ?? "",
  elevenLabsModelId: process.env.ELEVENLABS_MODEL_ID ?? "eleven_flash_v2_5",
  elevenLabsOutputFormat: process.env.ELEVENLABS_OUTPUT_FORMAT ?? "mp3_44100_128",
  elevenLabsOptimizeStreamingLatency: Number(process.env.ELEVENLABS_OPTIMIZE_STREAMING_LATENCY ?? 3),
  elevenLabsTtsTimeoutMs: Number(process.env.ELEVENLABS_TTS_TIMEOUT_MS ?? 25000),
  elevenLabsMaxChars: Number(process.env.ELEVENLABS_MAX_CHARS ?? 1800),
  elevenLabsMaxRequestsPerMinute: Number(process.env.ELEVENLABS_MAX_REQUESTS_PER_MINUTE ?? 30),
  pocketTtsEnabled: process.env.POCKET_TTS_ENABLED !== "false",
  pocketTtsCommand: process.env.POCKET_TTS_COMMAND ?? "uvx",
  pocketTtsCommandArgs: (process.env.POCKET_TTS_COMMAND_ARGS ?? "pocket-tts,generate")
    .split(",")
    .map((arg) => arg.trim())
    .filter(Boolean),
  pocketTtsLanguage: process.env.POCKET_TTS_LANGUAGE ?? "english",
  pocketTtsVoice: process.env.POCKET_TTS_VOICE ?? "",
  pocketTtsDevice: process.env.POCKET_TTS_DEVICE ?? "cpu",
  pocketTtsTimeoutMs: Number(process.env.POCKET_TTS_TIMEOUT_MS ?? 8500),
  ttsPocketMaxConcurrency: Number(process.env.TTS_POCKET_MAX_CONCURRENCY ?? process.env.POCKET_TTS_MAX_CONCURRENCY ?? 2),
  ttsQueueMaxDepth: Number(process.env.TTS_QUEUE_MAX_DEPTH ?? 25),
  ttsQueueWaitMs: Number(process.env.TTS_QUEUE_WAIT_MS ?? 8000),
  ttsReminderQueueWaitMs: Number(process.env.TTS_REMINDER_QUEUE_WAIT_MS ?? 12000),
  ttsReplyStaleMs: Number(process.env.TTS_REPLY_STALE_MS ?? 22000),
  ttsReminderStaleMs: Number(process.env.TTS_REMINDER_STALE_MS ?? 30000),
  ttsJobTimeoutMs: Number(process.env.TTS_JOB_TIMEOUT_MS ?? process.env.POCKET_TTS_TIMEOUT_MS ?? 18000),
  ttsTempMaxAgeMs: Number(process.env.TTS_TEMP_MAX_AGE_MS ?? 60_000),
  brainMaxConcurrency: Number(process.env.BRAIN_MAX_CONCURRENCY ?? 5),
  brainGlobalMaxConcurrency: Number(process.env.BRAIN_GLOBAL_MAX_CONCURRENCY ?? process.env.BRAIN_MAX_CONCURRENCY ?? 5),
  brainQueueMaxDepth: Number(process.env.BRAIN_QUEUE_MAX_DEPTH ?? 40),
  brainQueueWaitMs: Number(process.env.BRAIN_QUEUE_WAIT_MS ?? 18_000),
  brainJobTimeoutMs: Number(process.env.BRAIN_JOB_TIMEOUT_MS ?? 20_000),
  geminiEmbeddingModel: process.env.GEMINI_EMBEDDING_MODEL ?? "gemini-embedding-001",
  geminiEmbeddingDimensions: Number(process.env.GEMINI_EMBEDDING_DIMENSIONS ?? 1536),
  betaDailyMessageLimit: Number(process.env.BETA_DAILY_MESSAGE_LIMIT ?? process.env.DAILY_MESSAGE_LIMIT ?? 15),
  dailyMessageLimit: Number(process.env.DAILY_MESSAGE_LIMIT ?? process.env.BETA_DAILY_MESSAGE_LIMIT ?? 100),
  auraStreamingStt: process.env.AURA_STREAMING_STT !== "false",
  auraStreamingResponse: process.env.AURA_STREAMING_RESPONSE !== "false",
  auraStreamingTtsExperimental: process.env.AURA_STREAMING_TTS_EXPERIMENTAL !== "false",
  auraPredictiveEndpointing: process.env.AURA_PREDICTIVE_ENDPOINTING !== "false"
};

export const hasSupabase = Boolean(env.supabaseUrl && env.supabaseServiceRoleKey);
export const hasRedis = Boolean(env.redisUrl);
export const hasOpenRouter = Boolean(env.openRouterApiKeys.length);
export const hasGroq = Boolean(env.groqApiKeys.length);
export const hasGemini = Boolean(env.geminiApiKeys.length);
