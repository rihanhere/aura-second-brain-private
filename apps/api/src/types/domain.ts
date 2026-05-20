export type MemoryLayer =
  | "short_term"
  | "long_term"
  | "pinned"
  | "archived"
  | "core_profile"
  | "episodic"
  | "session_summary"
  | "quick_memory"
  | "recent_memory"
  | "daily_summary"
  | "weekly_summary"
  | "long_term_summary"
  | "product_learning";
export type Importance = "low" | "medium" | "critical";
export type TodoStatus = "open" | "completed" | "archived";

export interface MemoryAnalysis {
  summary: string;
  emotionalState: string | null;
  goals: string[];
  actionItems: string[];
  importantFacts: string[];
  recurringTopics: string[];
  habits: string[];
  priorities: string[];
  autoTags: string[];
  importance: Importance;
  shouldStore: boolean;
  explicitSaveIntent: boolean;
  importantAutoMemory: boolean;
  memoryLayer: MemoryLayer;
}

export interface AgentToolCall {
  tool: "create_reminder" | "create_todo" | "none";
  confidence: number;
  payload: Record<string, unknown>;
}

export interface ReminderDraft {
  type: "simple_reminder" | "check_in";
  title: string;
  scheduledAt: string;
  recurrenceRule: string | null;
  timezone: string;
  promptQuestion: string | null;
  originalText: string;
  notificationBody: string;
  responseGuidance: string | null;
}
