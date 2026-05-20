import { randomUUID } from "node:crypto";
import { env } from "../config/env.js";
import { synthesizeAgentVoice, synthesizeAgentVoiceFast } from "./geminiVoice.js";
import { cleanupStalePocketTempDirs, getPocketTtsRuntimeStatus } from "./pocketTts.js";
import type { ProviderOverrides } from "./providerOverrides.js";

type VoicePayload = Awaited<ReturnType<typeof synthesizeAgentVoice>>;

export type VoicePriority = "reply" | "reminder" | "test";

type VoiceJobStatus = "queued" | "active" | "completed" | "canceled" | "discarded" | "timed_out" | "failed";

type VoiceJob = {
  id: string;
  userId: string;
  speechSessionId: string | null;
  generationId: number;
  text: string;
  priority: VoicePriority;
  staleAfterMs: number;
  createdAt: number;
  startedAt?: number;
  status: VoiceJobStatus;
  overrides?: ProviderOverrides;
  fast: boolean;
  controller: AbortController;
  queueTimer?: NodeJS.Timeout;
  staleTimer?: NodeJS.Timeout;
  activeTimer?: NodeJS.Timeout;
  resolve: (voice: VoicePayload | null) => void;
};

export type QueueVoiceInput = {
  userId: string;
  text: string;
  priority?: VoicePriority;
  speechSessionId?: string | null;
  interruptPrevious?: boolean;
  staleAfterMs?: number;
  overrides?: ProviderOverrides;
  fast?: boolean;
};

const maxActiveJobs = Math.max(1, env.ttsPocketMaxConcurrency);
const maxQueueDepth = Math.max(1, env.ttsQueueMaxDepth);
const queueWaitMs = Math.max(0, env.ttsQueueWaitMs);
const reminderQueueWaitMs = Math.max(0, env.ttsReminderQueueWaitMs);
const jobTimeoutMs = Math.max(1000, env.ttsJobTimeoutMs);

const queuedJobs: VoiceJob[] = [];
const activeJobs = new Map<string, VoiceJob>();
const userGenerations = new Map<string, number>();
let cleanupIntervalStarted = false;

const metrics = {
  totalJobs: 0,
  completedJobs: 0,
  canceledJobs: 0,
  discardedJobs: 0,
  timedOutJobs: 0,
  failedJobs: 0,
  staleCleanupCount: 0,
  timeoutEvictionCount: 0,
  busyNullFallbackCount: 0,
  interruptionCancellationCount: 0,
  cleanedTempDirs: 0,
  maxQueueDepth: 0,
  maxActiveJobs: 0,
  providerCounts: {} as Record<string, number>
};

function priorityRank(priority: VoicePriority) {
  if (priority === "reminder") return 3;
  if (priority === "test") return 2;
  return 1;
}

function defaultStaleAfterMs(priority: VoicePriority) {
  return priority === "reminder" ? env.ttsReminderStaleMs : env.ttsReplyStaleMs;
}

function currentGeneration(userId: string) {
  return userGenerations.get(userId) ?? 0;
}

function bumpGeneration(userId: string) {
  const next = currentGeneration(userId) + 1;
  userGenerations.set(userId, next);
  return next;
}

function removeQueuedJob(jobId: string) {
  const index = queuedJobs.findIndex((job) => job.id === jobId);
  if (index >= 0) return queuedJobs.splice(index, 1)[0];
  return null;
}

function clearJobTimers(job: VoiceJob) {
  if (job.queueTimer) clearTimeout(job.queueTimer);
  if (job.staleTimer) clearTimeout(job.staleTimer);
  if (job.activeTimer) clearTimeout(job.activeTimer);
}

function finishJob(job: VoiceJob, status: VoiceJobStatus, voice: VoicePayload | null) {
  if (job.status === "completed" || job.status === "canceled" || job.status === "discarded" || job.status === "timed_out" || job.status === "failed") {
    return;
  }

  clearJobTimers(job);
  job.status = status;
  activeJobs.delete(job.id);
  removeQueuedJob(job.id);

  if (status === "completed") metrics.completedJobs += 1;
  if (status === "canceled") metrics.canceledJobs += 1;
  if (status === "discarded") metrics.discardedJobs += 1;
  if (status === "timed_out") metrics.timedOutJobs += 1;
  if (status === "failed") metrics.failedJobs += 1;

  const provider = voice?.provider ?? (status === "completed" ? "none" : null);
  if (provider) metrics.providerCounts[provider] = (metrics.providerCounts[provider] ?? 0) + 1;

  job.resolve(voice);
  processQueue();
}

function discardJob(job: VoiceJob, reason: "canceled" | "discarded" | "timed_out") {
  if (job.status === "active") {
    job.controller.abort();
  }
  if (reason === "timed_out") {
    metrics.timeoutEvictionCount += 1;
  }
  if (reason === "discarded") {
    metrics.staleCleanupCount += 1;
    metrics.busyNullFallbackCount += 1;
  }
  finishJob(job, reason, null);
}

function cancelPreviousLowPriorityJobs(userId: string, speechSessionId: string | null) {
  let canceled = 0;
  for (const job of [...queuedJobs, ...activeJobs.values()]) {
    if (job.userId !== userId) continue;
    if (speechSessionId && job.speechSessionId && job.speechSessionId !== speechSessionId) continue;
    if (job.priority === "reminder") continue;
    canceled += 1;
    discardJob(job, "canceled");
  }
  if (canceled) {
    metrics.interruptionCancellationCount += canceled;
  }
  return canceled;
}

function preemptLowPriorityForReminder() {
  let canceled = 0;

  for (const job of [...queuedJobs]) {
    if (job.priority === "reminder") continue;
    canceled += 1;
    discardJob(job, "discarded");
  }

  while (activeJobs.size >= maxActiveJobs) {
    const oldestLowPriority = [...activeJobs.values()]
      .filter((job) => job.priority !== "reminder")
      .sort((a, b) => (a.startedAt ?? a.createdAt) - (b.startedAt ?? b.createdAt))[0];
    if (!oldestLowPriority) break;
    canceled += 1;
    discardJob(oldestLowPriority, "canceled");
  }

  if (canceled) {
    metrics.interruptionCancellationCount += canceled;
    console.log("[voice-orchestrator] reminder preempted low-priority speech", { canceled });
  }
}

function discardOldestLowPriorityQueuedJob() {
  const index = queuedJobs.findIndex((job) => job.priority !== "reminder");
  if (index < 0) return false;
  const [job] = queuedJobs.splice(index, 1);
  discardJob(job, "discarded");
  return true;
}

function enforceBackpressure(newPriority: VoicePriority) {
  while (queuedJobs.length >= maxQueueDepth) {
    if (discardOldestLowPriorityQueuedJob()) continue;
    if (newPriority === "reminder") {
      const oldest = queuedJobs.shift();
      if (oldest) {
        discardJob(oldest, "discarded");
        continue;
      }
    }
    return false;
  }
  return true;
}

function sortQueue() {
  queuedJobs.sort((a, b) => {
    const rankDiff = priorityRank(b.priority) - priorityRank(a.priority);
    return rankDiff || a.createdAt - b.createdAt;
  });
}

function scheduleJobTimers(job: VoiceJob) {
  const priorityQueueWaitMs = job.priority === "reminder" ? reminderQueueWaitMs : queueWaitMs;
  if (priorityQueueWaitMs > 0) {
    job.queueTimer = setTimeout(() => {
      if (job.status !== "queued") return;
      console.warn("[voice-orchestrator] queue wait exceeded; returning null voice", {
        jobId: job.id,
        userId: job.userId,
        priority: job.priority,
        queueWaitMs: priorityQueueWaitMs
      });
      discardJob(job, "discarded");
    }, priorityQueueWaitMs);
  }

  job.staleTimer = setTimeout(() => {
    if (job.status !== "queued" && job.status !== "active") return;
    console.warn("[voice-orchestrator] stale speech evicted", {
      jobId: job.id,
      userId: job.userId,
      priority: job.priority,
      staleAfterMs: job.staleAfterMs
    });
    discardJob(job, job.status === "active" ? "timed_out" : "discarded");
  }, job.staleAfterMs);
}

async function startJob(job: VoiceJob) {
  if (job.status !== "queued") return;
  removeQueuedJob(job.id);
  if (job.queueTimer) clearTimeout(job.queueTimer);
  job.status = "active";
  job.startedAt = Date.now();
  activeJobs.set(job.id, job);
  metrics.maxActiveJobs = Math.max(metrics.maxActiveJobs, activeJobs.size);

  job.activeTimer = setTimeout(() => {
    if (job.status !== "active") return;
    console.warn("[voice-orchestrator] active speech timed out", {
      jobId: job.id,
      userId: job.userId,
      priority: job.priority,
      jobTimeoutMs
    });
    discardJob(job, "timed_out");
  }, jobTimeoutMs);

  try {
    const voice = job.fast
      ? await synthesizeAgentVoiceFast(job.text, job.overrides, { signal: job.controller.signal, jobId: job.id })
      : await synthesizeAgentVoice(job.text, job.overrides, { signal: job.controller.signal, jobId: job.id });

    if (job.status !== "active") return;

    const staleGeneration = job.priority !== "reminder" && job.generationId !== currentGeneration(job.userId);
    if (staleGeneration) {
      console.warn("[voice-orchestrator] stale generated speech discarded", {
        jobId: job.id,
        userId: job.userId,
        jobGeneration: job.generationId,
        currentGeneration: currentGeneration(job.userId)
      });
      metrics.staleCleanupCount += 1;
      finishJob(job, "discarded", null);
      return;
    }

    finishJob(job, "completed", voice);
  } catch (error) {
    if (job.status !== "active") return;
    console.warn("[voice-orchestrator] speech job failed", error instanceof Error ? error.message : error);
    finishJob(job, "failed", null);
  }
}

function processQueue() {
  sortQueue();
  while (activeJobs.size < maxActiveJobs && queuedJobs.length) {
    const next = queuedJobs[0];
    void startJob(next);
  }
}

export async function queueVoiceSynthesis(input: QueueVoiceInput) {
  const priority = input.priority ?? "reply";
  const speechSessionId = input.speechSessionId ?? null;
  const generationId = input.interruptPrevious === false ? currentGeneration(input.userId) : bumpGeneration(input.userId);

  if (priority === "reminder") {
    preemptLowPriorityForReminder();
  }

  if (input.interruptPrevious !== false) {
    cancelPreviousLowPriorityJobs(input.userId, speechSessionId);
  }

  if (!enforceBackpressure(priority)) {
    metrics.busyNullFallbackCount += 1;
    console.warn("[voice-orchestrator] queue full; returning null voice", {
      userId: input.userId,
      priority,
      queueDepth: queuedJobs.length,
      maxQueueDepth
    });
    return null;
  }

  return new Promise<VoicePayload | null>((resolve) => {
    const job: VoiceJob = {
      id: randomUUID(),
      userId: input.userId,
      speechSessionId,
      generationId,
      text: input.text,
      priority,
      staleAfterMs: Math.max(1000, input.staleAfterMs ?? defaultStaleAfterMs(priority)),
      createdAt: Date.now(),
      status: "queued",
      overrides: input.overrides,
      fast: input.fast ?? false,
      controller: new AbortController(),
      resolve
    };

    metrics.totalJobs += 1;
    queuedJobs.push(job);
    metrics.maxQueueDepth = Math.max(metrics.maxQueueDepth, queuedJobs.length);
    scheduleJobTimers(job);
    processQueue();
  });
}

export function cancelVoiceJobs(input: { userId: string; speechSessionId?: string | null }) {
  let canceled = 0;
  for (const job of [...queuedJobs, ...activeJobs.values()]) {
    if (job.userId !== input.userId) continue;
    if (input.speechSessionId && job.speechSessionId !== input.speechSessionId) continue;
    canceled += 1;
    discardJob(job, "canceled");
  }
  if (canceled) metrics.interruptionCancellationCount += canceled;
  return canceled;
}

export function getVoiceOrchestratorMetrics() {
  return {
    config: {
      maxActiveJobs,
      maxQueueDepth,
      queueWaitMs,
      reminderQueueWaitMs,
      replyStaleMs: env.ttsReplyStaleMs,
      reminderStaleMs: env.ttsReminderStaleMs,
      jobTimeoutMs
    },
    current: {
      activeJobs: activeJobs.size,
      queueDepth: queuedJobs.length,
      queuedByPriority: queuedJobs.reduce<Record<string, number>>((acc, job) => {
        acc[job.priority] = (acc[job.priority] ?? 0) + 1;
        return acc;
      }, {}),
      activeByPriority: [...activeJobs.values()].reduce<Record<string, number>>((acc, job) => {
        acc[job.priority] = (acc[job.priority] ?? 0) + 1;
        return acc;
      }, {}),
      pocket: getPocketTtsRuntimeStatus()
    },
    totals: { ...metrics }
  };
}

export async function runVoiceTempCleanup() {
  const cleaned = await cleanupStalePocketTempDirs(env.ttsTempMaxAgeMs);
  metrics.cleanedTempDirs += cleaned;
  return cleaned;
}

export function startVoiceOrchestratorCleanup() {
  if (cleanupIntervalStarted) return;
  cleanupIntervalStarted = true;
  void runVoiceTempCleanup();
  const interval = setInterval(() => {
    void runVoiceTempCleanup();
  }, Math.max(30_000, Math.floor(env.ttsTempMaxAgeMs / 2)));
  interval.unref?.();
}
