import { createClient } from "redis";
import { env, hasRedis } from "../config/env.js";

type RedisClient = ReturnType<typeof createClient>;

let clientPromise: Promise<RedisClient | null> | null = null;
let lastError: string | null = null;
let connectedAt: string | null = null;

export async function getRedisClient() {
  if (!hasRedis) return null;

  if (!clientPromise) {
    const client = createClient({ url: env.redisUrl });
    client.on("error", (error) => {
      lastError = error instanceof Error ? error.message : String(error);
      console.warn("[redis] client error", lastError);
    });

    clientPromise = client.connect()
      .then(() => {
        connectedAt = new Date().toISOString();
        lastError = null;
        return client;
      })
      .catch((error) => {
        lastError = error instanceof Error ? error.message : String(error);
        connectedAt = null;
        clientPromise = null;
        console.warn("[redis] connection failed", lastError);
        return null;
      });
  }

  return clientPromise;
}

export function getRedisStatus() {
  return {
    configured: hasRedis,
    reachable: Boolean(connectedAt && !lastError),
    connectedAt,
    lastError,
    keyPrefix: env.redisKeyPrefix
  };
}
