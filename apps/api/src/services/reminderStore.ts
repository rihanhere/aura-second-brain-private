import { randomUUID } from "crypto";
import { supabase } from "../config/supabase.js";
import type { ReminderDraft } from "../types/domain.js";
import { isScaleTestUser } from "./scaleTest.js";

export type ReminderRecord = {
  id: string;
  user_id: string;
  type?: ReminderDraft["type"];
  title: string;
  scheduled_at: string;
  recurrence_rule: string | null;
  timezone: string;
  status: "scheduled" | "asked" | "completed" | "cancelled" | string;
  prompt_question?: string | null;
  original_text?: string | null;
  notification_body?: string | null;
  response_guidance?: string | null;
  created_at: string;
  updated_at?: string;
};

const localReminders: ReminderRecord[] = [];
const scaleTestReminders: ReminderRecord[] = [];
const MAX_SCALE_TEST_REMINDERS = 120_000;

function fromDraft(userId: string, draft: ReminderDraft): ReminderRecord {
  const now = new Date().toISOString();
  return {
    id: randomUUID(),
    user_id: userId,
    type: draft.type,
    title: draft.title,
    scheduled_at: draft.scheduledAt,
    recurrence_rule: draft.recurrenceRule,
    timezone: draft.timezone,
    status: "scheduled",
    prompt_question: draft.promptQuestion,
    original_text: draft.originalText,
    notification_body: draft.notificationBody,
    response_guidance: draft.responseGuidance,
    created_at: now,
    updated_at: now
  };
}

function supabasePayload(record: ReminderRecord) {
  return {
    user_id: record.user_id,
    title: record.title,
    scheduled_at: record.scheduled_at,
    recurrence_rule: record.recurrence_rule,
    timezone: record.timezone,
    status: record.status
  };
}

export async function listReminderRecords(userId: string) {
  if (isScaleTestUser(userId)) {
    return scaleTestReminders
      .filter((item) => item.user_id === userId)
      .sort((a, b) => new Date(a.scheduled_at).getTime() - new Date(b.scheduled_at).getTime());
  }

  if (!supabase) {
    return localReminders
      .filter((item) => item.user_id === userId)
      .sort((a, b) => new Date(a.scheduled_at).getTime() - new Date(b.scheduled_at).getTime());
  }

  const { data, error } = await supabase
    .from("reminders")
    .select("*")
    .eq("user_id", userId)
    .order("scheduled_at", { ascending: true });
  if (error) throw error;
  return data ?? [];
}

export async function saveReminderDraft(userId: string, draft: ReminderDraft) {
  const localRecord = fromDraft(userId, draft);

  if (isScaleTestUser(userId)) {
    scaleTestReminders.unshift(localRecord);
    if (scaleTestReminders.length > MAX_SCALE_TEST_REMINDERS) scaleTestReminders.length = MAX_SCALE_TEST_REMINDERS;
    return localRecord;
  }

  if (!supabase) {
    localReminders.unshift(localRecord);
    return localRecord;
  }

  const { data, error } = await supabase
    .from("reminders")
    .insert(supabasePayload(localRecord))
    .select("*")
    .single();
  if (error) {
    console.warn(`Supabase reminder save failed, using local reminder store: ${error.message}`);
    localReminders.unshift(localRecord);
    return localRecord;
  }
  return data ?? localRecord;
}

export async function deleteReminderRecord(userId: string, id: string) {
  if (isScaleTestUser(userId)) {
    const index = scaleTestReminders.findIndex((item) => item.id === id && item.user_id === userId);
    if (index >= 0) scaleTestReminders.splice(index, 1);
    return;
  }

  if (!supabase) {
    const index = localReminders.findIndex((item) => item.id === id && item.user_id === userId);
    if (index >= 0) localReminders.splice(index, 1);
    return;
  }

  const { error } = await supabase
    .from("reminders")
    .delete()
    .eq("id", id)
    .eq("user_id", userId);
  if (error) throw error;
}
