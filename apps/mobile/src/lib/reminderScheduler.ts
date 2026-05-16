import * as Notifications from "expo-notifications";
import {
  appendCachedReminder,
  getCachedReminders,
  markReminderAsked,
  markReminderCompleted,
  updateCachedReminder
} from "./localStore";
import type { ReminderDraft, ReminderItem } from "./api";

let notificationHandlerConfigured = false;

export function configureReminderNotifications() {
  if (notificationHandlerConfigured) return;
  notificationHandlerConfigured = true;
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowAlert: false,
      shouldPlaySound: false,
      shouldSetBadge: false
    })
  });
}

async function requestNotificationPermission() {
  const existing = await Notifications.getPermissionsAsync();
  if (existing.status === "granted") return true;
  const requested = await Notifications.requestPermissionsAsync({
    ios: {
      allowAlert: true,
      allowBadge: true,
      allowSound: true
    }
  });
  const allowed = requested.status === "granted";
  console.log("[AURA reminders] notification permission", {
    status: requested.status,
    granted: requested.granted,
    ios: requested.ios
  });
  return allowed;
}

function createReminderId() {
  return `aura-reminder-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function notificationBody(reminder: Pick<ReminderItem, "title" | "type" | "notification_body" | "prompt_question">) {
  if (reminder.notification_body) return reminder.notification_body;
  if (reminder.type === "check_in") return reminder.prompt_question ?? `Rihan, checking in: ${reminder.title}`;
  const clean = reminder.title.replace(/[?.!]+$/g, "");
  if (/^(drink|call|read|take|do|go|check|buy|send|write|finish|start|stop|work|meditate|exercise|walk|eat)\b/i.test(clean)) {
    return `Hey Rihan, time to ${clean}.`;
  }
  return `Hey Rihan, reminder: ${clean}.`;
}

function recurrenceIntervalMs(rule?: string | null) {
  if (!rule) return null;
  const frequency = rule.match(/FREQ=(MINUTELY|HOURLY)/i)?.[1]?.toUpperCase();
  const interval = Number(rule.match(/INTERVAL=(\d+)/i)?.[1] ?? 1);
  if (frequency === "MINUTELY") return interval * 60 * 1000;
  if (frequency === "HOURLY") return interval * 60 * 60 * 1000;
  return null;
}

async function scheduleNotification(reminder: ReminderItem) {
  let due = new Date(reminder.scheduled_at);
  if (!Number.isFinite(due.getTime())) return null;
  if (due.getTime() <= Date.now() + 1000) due = new Date(Date.now() + 2500);
  const allowed = await requestNotificationPermission().catch(() => false);
  if (!allowed) {
    console.warn("[AURA reminders] notification permission denied; reminder saved without background notification", {
      id: reminder.id,
      title: reminder.title,
      scheduledAt: reminder.scheduled_at
    });
    return null;
  }

  const notificationId = await Notifications.scheduleNotificationAsync({
    content: {
      title: "AURA",
      body: notificationBody(reminder),
      sound: "default",
      data: {
        auraReminderId: reminder.id,
        auraReminderType: reminder.type ?? "simple_reminder"
      }
    },
    trigger: {
      type: Notifications.SchedulableTriggerInputTypes.DATE,
      date: due
    }
  }).catch((error) => {
    console.warn("[AURA reminders] notification schedule failed", error instanceof Error ? error.message : error);
    return null;
  });
  console.log("[AURA reminders] scheduled text notification", {
    reminderId: reminder.id,
    notificationId,
    scheduledAt: due.toISOString(),
    body: notificationBody(reminder)
  });
  return notificationId;
}

export async function scheduleAndCacheReminderDraft(draft: ReminderDraft, sourceText: string, existingReminder?: Partial<ReminderItem> | null) {
  configureReminderNotifications();
  const reminder: ReminderItem = {
    id: existingReminder?.id ?? createReminderId(),
    type: existingReminder?.type ?? draft.type ?? "simple_reminder",
    title: existingReminder?.title ?? draft.title,
    scheduled_at: existingReminder?.scheduled_at ?? draft.scheduledAt,
    recurrence_rule: existingReminder?.recurrence_rule ?? draft.recurrenceRule,
    timezone: existingReminder?.timezone ?? draft.timezone,
    status: existingReminder?.status ?? "scheduled",
    notification_id: null,
    prompt_question: existingReminder?.prompt_question ?? draft.promptQuestion ?? null,
    original_text: existingReminder?.original_text ?? draft.originalText ?? sourceText,
    notification_body: existingReminder?.notification_body ?? draft.notificationBody ?? null,
    response_guidance: existingReminder?.response_guidance ?? draft.responseGuidance ?? null,
    created_at: existingReminder?.created_at ?? new Date().toISOString()
  };

  const notificationId = await scheduleNotification(reminder);
  const stored = { ...reminder, notification_id: notificationId };
  await appendCachedReminder(stored);
  return stored;
}

export async function reschedulePendingReminderNotifications() {
  configureReminderNotifications();
  const reminders = await getCachedReminders();
  for (const reminder of reminders) {
    if (reminder.status !== "scheduled" || reminder.notification_id || new Date(reminder.scheduled_at).getTime() <= Date.now()) {
      continue;
    }
    const notificationId = await scheduleNotification(reminder);
    if (notificationId) await updateCachedReminder(reminder.id, { notification_id: notificationId });
  }
}

export async function getDueReminders(now = new Date()) {
  const reminders = await getCachedReminders();
  return reminders
    .filter((reminder) => reminder.status === "scheduled")
    .filter((reminder) => new Date(reminder.scheduled_at).getTime() <= now.getTime())
    .sort((a, b) => new Date(a.scheduled_at).getTime() - new Date(b.scheduled_at).getTime());
}

export function spokenReminderText(reminder: ReminderItem) {
  return notificationBody(reminder);
}

export async function markForegroundReminderDelivered(reminder: ReminderItem) {
  if (reminder.notification_id) {
    await Notifications.cancelScheduledNotificationAsync(reminder.notification_id).catch(() => undefined);
  }
  if (reminder.type === "check_in") {
    await markReminderAsked(reminder.id);
    return;
  }

  const intervalMs = recurrenceIntervalMs(reminder.recurrence_rule);
  if (!intervalMs) {
    await markReminderCompleted(reminder.id);
    return;
  }

  const nextScheduledAt = new Date(Math.max(Date.now() + intervalMs, new Date(reminder.scheduled_at).getTime() + intervalMs)).toISOString();
  const nextReminder = {
    ...reminder,
    scheduled_at: nextScheduledAt,
    notification_id: null,
    status: "scheduled"
  };
  const notificationId = await scheduleNotification(nextReminder);
  await updateCachedReminder(reminder.id, {
    scheduled_at: nextScheduledAt,
    notification_id: notificationId,
    status: "scheduled"
  });
}

export async function markDueNotificationRemindersHandled(now = new Date()) {
  const reminders = await getCachedReminders();
  const dueNotified = reminders.filter((reminder) => {
    if (reminder.status !== "scheduled" || !reminder.notification_id) return false;
    return new Date(reminder.scheduled_at).getTime() <= now.getTime();
  });

  for (const reminder of dueNotified) {
    console.log("[AURA reminders] treating fired background notification as delivered", {
      id: reminder.id,
      scheduledAt: reminder.scheduled_at,
      notificationId: reminder.notification_id
    });
    await markForegroundReminderDelivered(reminder);
  }

  return dueNotified.length;
}
