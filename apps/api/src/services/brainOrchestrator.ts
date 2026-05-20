import { randomUUID } from "node:crypto";
import { env } from "../config/env.js";
import { getRedisClient, getRedisStatus } from "./redisClient.js";

type BrainJobStatus = "queued" | "active" | "completed" | "rejected" | "timed_out" | "failed";

type BrainJob<T> = {
  id: string;
  createdAt: number;
  startedAt?: number;
  status: BrainJobStatus;
  queueTimer?: NodeJS.Timeout;
  activeTimer?: NodeJS.Timeout;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
  task: () => Promise<T>;
};

export class BrainQueueError extends Error {
  constructor(
    message: string,
    readonly code: "brain_queue_full" | "brain_queue_timeout" | "brain_job_timeout"
  ) {
    super(message);
    this.name = "BrainQueueError";
  }
}

const maxActiveJobs = Math.max(1, env.brainMaxConcurrency);
const globalMaxActiveJobs = Math.max(1, env.brainGlobalMaxConcurrency);
const maxQueueDepth = Math.max(1, env.brainQueueMaxDepth);
const queueWaitMs = Math.max(1000, env.brainQueueWaitMs);
const jobTimeoutMs = Math.max(1000, env.brainJobTimeoutMs);
const redisBrainActiveKey = `${env.redisKeyPrefix}:brain:active`;

const queuedJobs: Array<BrainJob<unknown>> = [];
const activeJobs = new Map<string, BrainJob<unknown>>();

const metrics = {
  totalJobs: 0,
  completedJobs: 0,
  rejectedJobs: 0,
  timedOutJobs: 0,
  failedJobs: 0,
  providerFallbackCount: 0,
  maxQueueDepth: 0,
  maxActiveJobs: 0,
  globalSemaphoreAcquired: 0,
  globalSemaphoreWaits: 0,
  globalSemaphoreTimeouts: 0,
  globalSemaphoreUnavailable: 0,
  globalSemaphoreReleaseErrors: 0,
  totalGlobalSlotWaitMs: 0,
  maxGlobalSlotWaitMs: 0,
  totalQueueWaitMs: 0,
  maxQueueWaitMs: 0
};

type GlobalSlot = {
  mode: "redis";
  key: string;
  acquiredAt: number;
};

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function clearJobTimers(job: BrainJob<unknown>) {
  if (job.queueTimer) clearTimeout(job.queueTimer);
  if (job.activeTimer) clearTimeout(job.activeTimer);
}

function removeQueuedJob(jobId: string) {
  const index = queuedJobs.findIndex((job) => job.id === jobId);
  if (index >= 0) return queuedJobs.splice(index, 1)[0];
  return null;
}

function finishJob(job: BrainJob<unknown>, status: BrainJobStatus) {
  clearJobTimers(job);
  job.status = status;
  activeJobs.delete(job.id);
  removeQueuedJob(job.id);

  if (status === "completed") metrics.completedJobs += 1;
  if (status === "rejected") metrics.rejectedJobs += 1;
  if (status === "timed_out") metrics.timedOutJobs += 1;
  if (status === "failed") metrics.failedJobs += 1;

  processQueue();
}

function processQueue() {
  while (activeJobs.size < maxActiveJobs && queuedJobs.length) {
    const job = queuedJobs.shift();
    if (!job || job.status !== "queued") continue;
    void startJob(job);
  }
}

async function acquireGlobalSlot(job: BrainJob<unknown>) {
  if (!env.redisUrl) return null;

  const redis = await getRedisClient();
  if (!redis) {
    metrics.globalSemaphoreUnavailable += 1;
    return null;
  }

  const startedWaitingAt = Date.now();
  const deadline = startedWaitingAt + Math.min(queueWaitMs, jobTimeoutMs);

  while (job.status === "active" && Date.now() < deadline) {
    const activeCount = await redis.incr(redisBrainActiveKey);
    await redis.pExpire(redisBrainActiveKey, jobTimeoutMs + 10_000);

    if (activeCount <= globalMaxActiveJobs) {
      const waitMs = Date.now() - startedWaitingAt;
      metrics.globalSemaphoreAcquired += 1;
      metrics.totalGlobalSlotWaitMs += waitMs;
      metrics.maxGlobalSlotWaitMs = Math.max(metrics.maxGlobalSlotWaitMs, waitMs);
      return { mode: "redis", key: redisBrainActiveKey, acquiredAt: Date.now() } satisfies GlobalSlot;
    }

    await redis.decr(redisBrainActiveKey).catch(() => {
      metrics.globalSemaphoreReleaseErrors += 1;
    });
    metrics.globalSemaphoreWaits += 1;
    await sleep(80 + Math.floor(Math.random() * 120));
  }

  metrics.globalSemaphoreTimeouts += 1;
  throw new BrainQueueError("AURA global brain queue wait timed out.", "brain_queue_timeout");
}

async function releaseGlobalSlot(slot: GlobalSlot | null) {
  if (!slot) return;
  const redis = await getRedisClient();
  if (!redis) return;

  try {
    const value = await redis.decr(slot.key);
    if (value <= 0) await redis.del(slot.key);
  } catch (error) {
    metrics.globalSemaphoreReleaseErrors += 1;
    console.warn("[brain-orchestrator] failed to release global brain slot", error instanceof Error ? error.message : error);
  }
}

async function startJob(job: BrainJob<unknown>) {
  if (job.status !== "queued") return;
  clearJobTimers(job);
  job.status = "active";
  job.startedAt = Date.now();
  activeJobs.set(job.id, job);
  metrics.maxActiveJobs = Math.max(metrics.maxActiveJobs, activeJobs.size);

  const queueWait = job.startedAt - job.createdAt;
  metrics.totalQueueWaitMs += queueWait;
  metrics.maxQueueWaitMs = Math.max(metrics.maxQueueWaitMs, queueWait);

  job.activeTimer = setTimeout(() => {
    if (job.status !== "active") return;
    console.warn("[brain-orchestrator] brain job timed out", {
      jobId: job.id,
      jobTimeoutMs
    });
    finishJob(job, "timed_out");
    job.reject(new BrainQueueError("AURA brain job timed out.", "brain_job_timeout"));
  }, jobTimeoutMs);

  let globalSlot: GlobalSlot | null = null;
  try {
    globalSlot = await acquireGlobalSlot(job);
    const result = await job.task();
    if (job.status !== "active") return;
    finishJob(job, "completed");
    job.resolve(result);
  } catch (error) {
    if (job.status !== "active") return;
    finishJob(job, "failed");
    job.reject(error instanceof Error ? error : new Error(String(error)));
  } finally {
    await releaseGlobalSlot(globalSlot);
  }
}

export async function queueBrainRequest<T>(task: () => Promise<T>) {
  if (queuedJobs.length >= maxQueueDepth) {
    metrics.rejectedJobs += 1;
    console.warn("[brain-orchestrator] queue full; rejecting brain job", {
      queueDepth: queuedJobs.length,
      maxQueueDepth
    });
    throw new BrainQueueError("AURA brain queue is full.", "brain_queue_full");
  }

  return new Promise<T>((resolve, reject) => {
    const job: BrainJob<T> = {
      id: randomUUID(),
      createdAt: Date.now(),
      status: "queued",
      resolve,
      reject,
      task
    };

    metrics.totalJobs += 1;
    queuedJobs.push(job as BrainJob<unknown>);
    metrics.maxQueueDepth = Math.max(metrics.maxQueueDepth, queuedJobs.length);

    job.queueTimer = setTimeout(() => {
      if (job.status !== "queued") return;
      console.warn("[brain-orchestrator] queue wait timed out", {
        jobId: job.id,
        queueWaitMs
      });
      finishJob(job as BrainJob<unknown>, "timed_out");
      reject(new BrainQueueError("AURA brain queue wait timed out.", "brain_queue_timeout"));
    }, queueWaitMs);

    processQueue();
  });
}

export function noteBrainProviderFallback() {
  metrics.providerFallbackCount += 1;
}

export function getBrainOrchestratorMetrics() {
  return {
    config: {
      maxActiveJobs,
      globalMaxActiveJobs,
      maxQueueDepth,
      queueWaitMs,
      jobTimeoutMs,
      globalSemaphore: env.redisUrl ? "redis" : "in_process",
      redis: getRedisStatus()
    },
    current: {
      activeJobs: activeJobs.size,
      queueDepth: queuedJobs.length
    },
    totals: {
      ...metrics,
      avgQueueWaitMs: metrics.completedJobs ? Math.round(metrics.totalQueueWaitMs / metrics.completedJobs) : 0,
      avgGlobalSlotWaitMs: metrics.globalSemaphoreAcquired ? Math.round(metrics.totalGlobalSlotWaitMs / metrics.globalSemaphoreAcquired) : 0
    }
  };
}
