import { StatusBar } from "expo-status-bar";
import { useCallback, useEffect, useRef, useState } from "react";
import * as Speech from "expo-speech";
import * as Haptics from "expo-haptics";
import { AppState, SafeAreaView, StyleSheet, View, Pressable } from "react-native";
import { DrawerMenu, type AppRoute } from "./components/DrawerMenu";
import { finalizeMemorySession, synthesizeVoice } from "./lib/api";
import { playAgentVoice, speakTextWithFailsafe } from "./lib/audio";
import { getOrCreateSession, type LocalSession } from "./lib/localStore";
import {
  configureReminderNotifications,
  getDueReminders,
  markDueNotificationRemindersHandled,
  markForegroundReminderDelivered,
  reschedulePendingReminderNotifications,
  spokenReminderText
} from "./lib/reminderScheduler";
import { CaptureScreen } from "./screens/CaptureScreen";
import { InsightsScreen } from "./screens/InsightsScreen";
import { LaunchScreen } from "./screens/LaunchScreen";
import { MemoryScreen } from "./screens/MemoryScreen";
import { ProfileScreen } from "./screens/ProfileScreen";
import { RemindersScreen } from "./screens/RemindersScreen";
import { SettingsScreen } from "./screens/SettingsScreen";
import { TypeInsteadScreen } from "./screens/TypeInsteadScreen";
import { Ionicons } from "@expo/vector-icons";
import { colors } from "./theme/colors";

const MEMORY_IDLE_FINALIZE_MS = 5 * 60 * 1000;
const REMINDER_GEMINI_TIMEOUT_MS = 9000;
const REMINDER_MAX_VOICE_WAIT_MS = 59000;
const VOICE_BUSY_STALE_MS = 20 * 1000;

type ForegroundReminderNotice = {
  id: string;
  text: string;
  deliveredAt: number;
};

function reminderVoiceWaitMs(scheduledAt: string) {
  const scheduledTime = new Date(scheduledAt).getTime();
  if (!Number.isFinite(scheduledTime)) return REMINDER_GEMINI_TIMEOUT_MS;
  const endOfScheduledMinute = scheduledTime - (scheduledTime % 60000) + 59999;
  const remainingInMinute = endOfScheduledMinute - Date.now();
  return Math.max(0, Math.min(REMINDER_MAX_VOICE_WAIT_MS, remainingInMinute));
}

export default function App() {
  const [activeRoute, setActiveRoute] = useState<AppRoute>("home");
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [session, setSession] = useState<LocalSession | null>(null);
  const [launchDone, setLaunchDone] = useState(false);
  const [voiceBusy, setVoiceBusy] = useState(false);
  const [foregroundReminder, setForegroundReminder] = useState<ForegroundReminderNotice | null>(null);
  const idleFinalizeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastCaptureAtRef = useRef<number | null>(null);
  const appStateRef = useRef(AppState.currentState);
  const reminderSpeakingRef = useRef(false);
  const voiceBusyRef = useRef(false);
  const voiceBusySinceRef = useRef<number | null>(null);

  const finalizeIdleMemory = useCallback(async () => {
    const lastCaptureAt = lastCaptureAtRef.current;
    if (!lastCaptureAt || Date.now() - lastCaptureAt < MEMORY_IDLE_FINALIZE_MS) return;
    lastCaptureAtRef.current = null;
    const result = await finalizeMemorySession();
    if (result.memory) setRefreshKey((key) => key + 1);
  }, []);

  useEffect(() => {
    getOrCreateSession().then(setSession);
    configureReminderNotifications();
    void (async () => {
      const handled = await markDueNotificationRemindersHandled().catch(() => 0);
      if (handled) setRefreshKey((key) => key + 1);
      await reschedulePendingReminderNotifications();
    })();
  }, []);

  useEffect(() => {
    voiceBusyRef.current = voiceBusy;
    voiceBusySinceRef.current = voiceBusy ? voiceBusySinceRef.current ?? Date.now() : null;
  }, [voiceBusy]);

  useEffect(
    () => () => {
      if (idleFinalizeTimerRef.current) clearTimeout(idleFinalizeTimerRef.current);
    },
    []
  );

  const processDueReminders = useCallback(async () => {
    const busyForMs = voiceBusySinceRef.current ? Date.now() - voiceBusySinceRef.current : 0;
    const voiceBusyIsStale = voiceBusyRef.current && busyForMs > VOICE_BUSY_STALE_MS;
    if (voiceBusyIsStale) {
      console.warn("[AURA reminders] clearing stale voice busy state", { busyForMs });
      voiceBusyRef.current = false;
      voiceBusySinceRef.current = null;
    }
    if (appStateRef.current !== "active" || reminderSpeakingRef.current || (voiceBusyRef.current && !voiceBusyIsStale)) return;
    const [nextReminder] = await getDueReminders();
    if (!nextReminder) return;

    reminderSpeakingRef.current = true;
    try {
      const text = spokenReminderText(nextReminder);
      console.log("[AURA reminders] due foreground reminder", {
        id: nextReminder.id,
        type: nextReminder.type,
        scheduledAt: nextReminder.scheduled_at
      });
      const voiceWaitMs = reminderVoiceWaitMs(nextReminder.scheduled_at);
      console.log("[AURA reminders] preparing voice before visible reminder", { id: nextReminder.id, voiceWaitMs });
      const synthesized = await synthesizeVoice(text, voiceWaitMs);
      setActiveRoute("home");
      setDrawerOpen(false);
      setForegroundReminder({ id: nextReminder.id, text, deliveredAt: Date.now() });
      console.log("[AURA reminders] visible reminder text set with voice start", { id: nextReminder.id, text });
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => undefined);
      if (synthesized.voice?.audioBase64) {
        console.log("[AURA reminders] playing prepared reminder voice", {
          provider: synthesized.voice.provider,
          model: synthesized.voice.model
        });
        Speech.stop();
        await playAgentVoice(synthesized.voice);
      } else {
        console.warn("[AURA reminders] backend voice unavailable by minute deadline; using iOS speech fallback");
        await speakTextWithFailsafe(text);
      }
      await markForegroundReminderDelivered(nextReminder);
      console.log("[AURA reminders] foreground reminder delivered", { id: nextReminder.id });
      setRefreshKey((key) => key + 1);
    } finally {
      reminderSpeakingRef.current = false;
      setTimeout(() => {
        void processDueReminders();
      }, 750);
    }
  }, []);

  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      const previousState = appStateRef.current;
      appStateRef.current = state;
      if (state === "active") {
        void (async () => {
          void finalizeIdleMemory();
          if (previousState !== "active") {
            const handled = await markDueNotificationRemindersHandled().catch(() => 0);
            if (handled) setRefreshKey((key) => key + 1);
          }
          await reschedulePendingReminderNotifications();
          setTimeout(() => {
            void processDueReminders();
          }, previousState !== "active" ? 450 : 0);
        })();
      }
    });
    return () => subscription.remove();
  }, [finalizeIdleMemory, processDueReminders]);

  useEffect(() => {
    const interval = setInterval(() => {
      void processDueReminders();
    }, 1000);
    return () => clearInterval(interval);
  }, [processDueReminders]);

  useEffect(() => {
    if (!voiceBusy) void processDueReminders();
  }, [processDueReminders, voiceBusy]);

  function scheduleIdleFinalize() {
    if (idleFinalizeTimerRef.current) clearTimeout(idleFinalizeTimerRef.current);
    idleFinalizeTimerRef.current = setTimeout(() => {
      void finalizeIdleMemory();
    }, MEMORY_IDLE_FINALIZE_MS + 1200);
  }

  function markCaptured() {
    lastCaptureAtRef.current = Date.now();
    scheduleIdleFinalize();
    setRefreshKey((key) => key + 1);
  }

  function navigate(route: AppRoute) {
    setActiveRoute(route);
    setDrawerOpen(false);
  }

  if (!launchDone || !session) {
    return <LaunchScreen onDone={() => setLaunchDone(true)} />;
  }

  return (
    <SafeAreaView style={styles.safeArea}>
      <StatusBar style="dark" />
      <View style={styles.app}>
        {activeRoute !== "home" ? (
          <View style={styles.menuButton}>
            <Pressable onPress={() => setActiveRoute("home")} hitSlop={10} style={styles.backButton}>
              <Ionicons name="chevron-back" size={28} color={colors.text} />
            </Pressable>
          </View>
        ) : null}
        <View style={styles.content}>
          {activeRoute === "home" ? (
            <CaptureScreen
              foregroundReminder={foregroundReminder}
              onCaptured={markCaptured}
              onOpenMenu={() => setDrawerOpen(true)}
              onNavigate={navigate}
              onVoiceBusyChange={setVoiceBusy}
            />
          ) : null}
          {activeRoute === "journal" ? <MemoryScreen refreshKey={refreshKey} /> : null}
          {activeRoute === "reminders" ? <RemindersScreen refreshKey={refreshKey} /> : null}
          {activeRoute === "insights" ? <InsightsScreen refreshKey={refreshKey} /> : null}
          {activeRoute === "you" ? <ProfileScreen session={session} /> : null}
          {activeRoute === "settings" ? <SettingsScreen /> : null}
          {activeRoute === "type" ? <TypeInsteadScreen onCaptured={markCaptured} /> : null}
        </View>
        {drawerOpen ? <DrawerMenu activeRoute={activeRoute} onNavigate={navigate} onClose={() => setDrawerOpen(false)} /> : null}
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    backgroundColor: colors.background,
    flex: 1
  },
  app: {
    backgroundColor: colors.background,
    flex: 1
  },
  content: {
    flex: 1
  },
  menuButton: {
    left: 22,
    position: "absolute",
    top: 22,
    zIndex: 5
  },
  backButton: {
    padding: 4,
  }
});
