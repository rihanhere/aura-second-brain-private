import { env, hasGemini, hasGroq, hasOpenRouter, hasRedis, hasSupabase } from "../config/env.js";
import { getBrainOrchestratorMetrics } from "./brainOrchestrator.js";
import { memoryPersistenceStatus } from "./memoryPersistenceAdapter.js";
import { getRedisStatus } from "./redisClient.js";
import { getUsageLedgerStatus } from "./usageLedger.js";

type Check = {
  ok: boolean;
  label: string;
  detail: string;
};

export async function getProductionReadiness() {
  const brain = getBrainOrchestratorMetrics();
  const redis = getRedisStatus();
  const usage = await getUsageLedgerStatus();
  const persistence = memoryPersistenceStatus();
  const productionMode = env.auraEnv === "production";

  const checks: Check[] = [
    {
      ok: hasSupabase,
      label: "persistent_memory",
      detail: hasSupabase ? "Supabase is configured." : "Supabase is not configured; local memory is beta-only."
    },
    {
      ok: persistence.adapter.launchSafe,
      label: "memory_persistence_adapter",
      detail: persistence.adapter.launchSafe
        ? `Launch-safe persistence adapter active: ${persistence.adapter.name}.`
        : `${persistence.adapter.name} is not launch-safe. ${persistence.warning}`
    },
    {
      ok: hasRedis,
      label: "distributed_queue",
      detail: hasRedis ? "Redis URL is configured for global queue/semaphore coordination." : "Redis is not configured; brain queue is in-process only."
    },
    {
      ok: brain.config.globalMaxActiveJobs >= 50,
      label: "day1_brain_concurrency",
      detail: `Global brain concurrency is ${brain.config.globalMaxActiveJobs}; day-1 production target is 50.`
    },
    {
      ok: usage.limit >= 100,
      label: "daily_turn_quota",
      detail: `Daily message limit is ${usage.limit}; launch plan target is 100 user turns/day.`
    },
    {
      ok: hasGroq,
      label: "stt_provider",
      detail: hasGroq ? "Groq transcription keys are configured." : "Groq transcription keys are missing."
    },
    {
      ok: hasOpenRouter || env.nvidiaApiKeys.length > 0,
      label: "brain_provider",
      detail: hasOpenRouter || env.nvidiaApiKeys.length > 0 ? "At least one brain provider is configured." : "No brain provider keys are configured."
    },
    {
      ok: hasGemini || env.pocketTtsEnabled,
      label: "voice_provider",
      detail: hasGemini ? "Gemini voice is configured." : env.pocketTtsEnabled ? "Pocket TTS fallback is enabled." : "No voice provider/fallback is configured."
    }
  ];

  const requiredChecks = productionMode ? checks : checks.filter((check) => check.label !== "day1_brain_concurrency" && check.label !== "distributed_queue" && check.label !== "persistent_memory" && check.label !== "memory_persistence_adapter");
  const ok = requiredChecks.every((check) => check.ok);

  return {
    ok,
    mode: env.auraEnv,
    productionMode,
    launchTarget: {
      globalBrainConcurrency: 50,
      dailyUserTurns: 100,
      publicBackend: "https_required",
      persistence: "supabase_postgres_pgvector",
      queue: "redis_global_semaphore"
    },
	    checks,
	    persistence,
	    redis,
	    usage
	  };
}
