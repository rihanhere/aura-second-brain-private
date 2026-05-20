export async function syncReminderToGoogleCalendar(_userId: string, reminder: Record<string, unknown>) {
  return {
    provider: "google_calendar",
    status: "pending_credentials",
    externalId: reminder.id ?? null
  };
}
