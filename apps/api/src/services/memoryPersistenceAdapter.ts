import { hasSupabase } from "../config/env.js";

export type MemoryPersistenceAdapterName = "local_json" | "supabase_postgres" | "future_scalable";

export interface MemoryPersistenceAdapter {
  name: MemoryPersistenceAdapterName;
  durable: boolean;
  supportsExport: boolean;
  supportsDelete: boolean;
  launchSafe: boolean;
}

export function getMemoryPersistenceAdapter(): MemoryPersistenceAdapter {
  if (hasSupabase) {
    return {
      name: "supabase_postgres",
      durable: true,
      supportsExport: true,
      supportsDelete: true,
      launchSafe: true
    };
  }

  return {
    name: "local_json",
    durable: false,
    supportsExport: true,
    supportsDelete: true,
    launchSafe: false
  };
}

export function memoryPersistenceStatus() {
  const adapter = getMemoryPersistenceAdapter();
  return {
    adapter,
    warning: adapter.launchSafe ? null : "Local JSON is development-only and unsafe for Render production because the filesystem is ephemeral."
  };
}
