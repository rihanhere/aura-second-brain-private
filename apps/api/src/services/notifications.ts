export async function schedulePushNotification(_userId: string, reminder: Record<string, unknown>) {
  return {
    provider: "fcm",
    status: "queued",
    reminderId: reminder.id ?? null
  };
}
