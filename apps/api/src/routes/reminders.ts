import { Router } from "express";
import { z } from "zod";
import { getUserId } from "../middleware/auth.js";
import { syncReminderToGoogleCalendar } from "../services/calendar.js";
import { schedulePushNotification } from "../services/notifications.js";
import { parseNaturalReminder } from "../services/reminderParser.js";
import { deleteReminderRecord, listReminderRecords, saveReminderDraft } from "../services/reminderStore.js";

export const remindersRouter = Router();

remindersRouter.get("/", async (req, res, next) => {
  try {
    const userId = getUserId(req);
    res.json({ reminders: await listReminderRecords(userId) });
  } catch (error) {
    next(error);
  }
});

remindersRouter.post("/", async (req, res, next) => {
  try {
    const body = z.object({
      text: z.string().min(1),
      timezone: z.string().default("UTC"),
      syncCalendar: z.boolean().default(false)
    }).parse(req.body);

    const userId = getUserId(req);
    const parsed = parseNaturalReminder(body.text, body.timezone);
    const reminder = await saveReminderDraft(userId, parsed);
    const notification = await schedulePushNotification(userId, reminder);
    const calendar = body.syncCalendar ? await syncReminderToGoogleCalendar(userId, reminder) : null;

    res.status(201).json({ reminder, notification, calendar });
  } catch (error) {
    next(error);
  }
});

remindersRouter.delete("/:id", async (req, res, next) => {
  try {
    await deleteReminderRecord(getUserId(req), req.params.id);
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});
