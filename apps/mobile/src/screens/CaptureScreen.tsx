import { Audio } from "expo-av";
import * as FileSystem from "expo-file-system";
import * as Haptics from "expo-haptics";
import * as Speech from "expo-speech";
import { useEffect, useRef, useState } from "react";
import { Animated, Pressable, StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import Svg, { Rect } from "react-native-svg";
import { AuraOrb } from "../components/AuraOrb";
import { AuraWordmark } from "../components/AuraWordmark";
import { type VoiceState } from "../components/IntelligenceOrb";
import { captureThought, getBackendHealth, transcribeVoice } from "../lib/api";
import { playAgentVoice, speakTextWithFailsafe, stopAgentAudio } from "../lib/audio";
import { colors } from "../theme/colors";

const AURA_RECORDING_OPTIONS = {
  ...Audio.RecordingOptionsPresets.HIGH_QUALITY,
  android: {
    ...Audio.RecordingOptionsPresets.HIGH_QUALITY.android,
    extension: ".m4a",
    outputFormat: Audio.AndroidOutputFormat.MPEG_4,
    audioEncoder: Audio.AndroidAudioEncoder.AAC,
    sampleRate: 44100,
    numberOfChannels: 1,
    bitRate: 96000
  },
  ios: {
    ...Audio.RecordingOptionsPresets.HIGH_QUALITY.ios,
    extension: ".m4a",
    outputFormat: Audio.IOSOutputFormat.MPEG4AAC,
    audioQuality: Audio.IOSAudioQuality.HIGH,
    sampleRate: 44100,
    numberOfChannels: 1,
    bitRate: 96000
  }
};

function PremiumWhiteBackdrop() {
  return (
    <Svg height="100%" preserveAspectRatio="none" viewBox="0 0 100 100" width="100%">
      <Rect fill={colors.background} height="100" width="100" x="0" y="0" />
    </Svg>
  );
}

export function CaptureScreen({
  foregroundReminder,
  onCaptured,
  onOpenMenu,
  onNavigate,
  onVoiceBusyChange
}: {
  foregroundReminder?: { id: string; text: string; deliveredAt: number } | null;
  onCaptured: () => void;
  onOpenMenu: () => void;
  onNavigate: (route: any) => void;
  onVoiceBusyChange?: (busy: boolean) => void;
}) {
  const [reply, setReply] = useState("Tap anywhere and speak.");
  const [isLoading, setIsLoading] = useState(false);
  const [voiceState, setVoiceState] = useState<VoiceState>("idle");
  const [recording, setRecording] = useState<Audio.Recording | null>(null);
  const [chromeVisible, setChromeVisible] = useState(false);
  const [typingMenuOpen, setTypingMenuOpen] = useState(false);
  const transitionRef = useRef(false);
  const chromeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressRef = useRef(false);
  const voiceRunRef = useRef(0);
  const cancelledVoiceRunRef = useRef<number | null>(null);
  const replyFade = useRef(new Animated.Value(0)).current;

  const visibleReply = reply.trim() && reply !== "Tap anywhere and speak." ? reply.trim() : "";
  const showChrome = chromeVisible || typingMenuOpen;
  const activeStateLabel =
    voiceState === "listening"
      ? "Listening"
      : voiceState === "thinking"
        ? "Thinking"
        : "";
  const showStatus = Boolean(visibleReply || activeStateLabel);

  useEffect(
    () => () => {
      if (chromeTimerRef.current) clearTimeout(chromeTimerRef.current);
    },
    []
  );

  useEffect(() => {
    onVoiceBusyChange?.(voiceState !== "idle" || Boolean(recording) || isLoading);
  }, [isLoading, onVoiceBusyChange, recording, voiceState]);

  useEffect(() => {
    if (chromeVisible) {
      if (chromeTimerRef.current) clearTimeout(chromeTimerRef.current);
      chromeTimerRef.current = setTimeout(() => setChromeVisible(false), 2600);
    }
  }, [chromeVisible]);

  useEffect(() => {
    if (!visibleReply) {
      replyFade.setValue(0);
      return;
    }
    replyFade.setValue(0);
    Animated.timing(replyFade, {
      toValue: 1,
      duration: 520,
      useNativeDriver: true
    }).start();
  }, [replyFade, visibleReply]);

  useEffect(() => {
    if (!foregroundReminder?.text) return;
    setReply(foregroundReminder.text);
    setIsLoading(false);
    setVoiceState("idle");
  }, [foregroundReminder?.deliveredAt, foregroundReminder?.id, foregroundReminder?.text]);

  function revealChrome(fromLongPress = false) {
    if (fromLongPress) longPressRef.current = true;
    setChromeVisible(true);
    if (chromeTimerRef.current) clearTimeout(chromeTimerRef.current);
    if (voiceState === "idle" && !recording && !isLoading) {
      chromeTimerRef.current = setTimeout(() => setChromeVisible(false), 3200);
    }
  }

  function isVoiceRunCancelled(runId: number) {
    return cancelledVoiceRunRef.current === runId;
  }

  function nextVoiceRun() {
    const runId = voiceRunRef.current + 1;
    voiceRunRef.current = runId;
    cancelledVoiceRunRef.current = null;
    return runId;
  }

  async function cancelRecording() {
    const active = recording;
    if (!active || transitionRef.current) return;

    transitionRef.current = true;
    setRecording(null);
    setVoiceState("idle");
    setReply("");
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => undefined);

    try {
      await active.stopAndUnloadAsync();
      await Audio.setAudioModeAsync({ allowsRecordingIOS: false, playsInSilentModeIOS: true });
    } catch {
      // Recording may already be stopped during rapid taps.
    } finally {
      transitionRef.current = false;
    }
  }

  async function cancelThinkingOrSpeaking() {
    cancelledVoiceRunRef.current = voiceRunRef.current;
    setRecording(null);
    setIsLoading(false);
    setVoiceState("idle");
    setReply("");
    Speech.stop();
    await stopAgentAudio();
  }

  async function handleLongPress() {
    longPressRef.current = true;
    if (recording) {
      await cancelRecording();
      return;
    }
    if (voiceState === "thinking" || isLoading || voiceState === "speaking") {
      await cancelThinkingOrSpeaking();
      return;
    }
    revealChrome(true);
  }

  async function speakReply(text: string, voice?: { audioBase64: string; mimeType?: string | null } | null, runId = voiceRunRef.current) {
    if (isVoiceRunCancelled(runId)) return;
    setVoiceState("speaking");
    Speech.stop();
    await stopAgentAudio();
    try {
      if (voice?.audioBase64) {
        await playAgentVoice(voice);
        if (!isVoiceRunCancelled(runId)) setVoiceState("idle");
        return;
      }
      await speakTextWithFailsafe(text);
      if (!isVoiceRunCancelled(runId)) setVoiceState("idle");
    } catch {
      if (!isVoiceRunCancelled(runId)) setVoiceState("idle");
    }
  }

  async function submitVoice(transcript: string, runId: number) {
    const content = transcript.trim();
    if (!content || isLoading) return;

    setIsLoading(true);
    setVoiceState("thinking");
    setReply("");

    try {
      const result = await captureThought(content, "voice", Intl.DateTimeFormat().resolvedOptions().timeZone);
      if (isVoiceRunCancelled(runId)) return;
      setReply(result.reply);
      onCaptured();
      await speakReply(result.reply, result.voice, runId);
    } catch {
      if (isVoiceRunCancelled(runId)) return;
      const fallback = "I saved the moment locally. The AI connection is quiet right now.";
      setReply(fallback);
      await speakReply(fallback, undefined, runId);
    } finally {
      if (!isVoiceRunCancelled(runId)) setIsLoading(false);
    }
  }

  async function stopRecording() {
    if (transitionRef.current) return;
    const active = recording;
    if (!active) return;

    const runId = nextVoiceRun();
    transitionRef.current = true;
    setRecording(null);
    setVoiceState("thinking");
    setReply("");

    try {
      await active.stopAndUnloadAsync();
      const uri = active.getURI();
      if (!uri) throw new Error("No audio URI");
      await Audio.setAudioModeAsync({ allowsRecordingIOS: false, playsInSilentModeIOS: true });

      const info = await FileSystem.getInfoAsync(uri, { size: true });
      const size = info.exists && "size" in info ? info.size ?? 0 : 0;
      console.log("[AURA voice] recording file", { uri, exists: info.exists, size });
      if (!info.exists || size < 1024) {
        throw new Error("The recording was empty. Try holding a little longer and speaking clearly.");
      }

      const health = await getBackendHealth();
      console.log("[AURA voice] backend health", health);
      if (!health.ok) {
        throw new Error(`Backend unreachable: ${String(health.providers.error ?? "unknown network error")}`);
      }

      const result = await transcribeVoice(uri);
      if (isVoiceRunCancelled(runId)) return;
      if (!result.transcript) throw new Error(result.message || "No transcript");
      await submitVoice(result.transcript, runId);
    } catch (error) {
      if (isVoiceRunCancelled(runId)) return;
      const fallback = error instanceof Error && error.message !== "No transcript"
        ? error.message
        : "I could not transcribe that. Try a shorter voice note.";
      setReply(fallback);
      setVoiceState("idle");
    } finally {
      transitionRef.current = false;
    }
  }

  async function startRecording() {
    if (isLoading || transitionRef.current || recording) return;

    transitionRef.current = true;
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    Speech.stop();
    await stopAgentAudio();

    const permission = await Audio.requestPermissionsAsync();
    if (!permission.granted) {
      setReply("Microphone permission is needed for AURA to listen.");
      transitionRef.current = false;
      return;
    }

    try {
      await Audio.setAudioModeAsync({
        allowsRecordingIOS: true,
        playsInSilentModeIOS: true
      });
      const result = await Audio.Recording.createAsync(AURA_RECORDING_OPTIONS);
      setRecording(result.recording);
      setVoiceState("listening");
      setReply("");
    } catch {
      setReply("Voice capture could not start. Try again.");
      setVoiceState("idle");
    } finally {
      transitionRef.current = false;
    }
  }

  async function handlePress() {
    if (voiceState === "thinking" || isLoading) {
      await cancelThinkingOrSpeaking();
      return;
    }
    if (longPressRef.current) {
      longPressRef.current = false;
      return;
    }
    if (transitionRef.current) return;
    if (typingMenuOpen) {
      setTypingMenuOpen(false);
      return;
    }
    if (voiceState === "speaking") {
      await cancelThinkingOrSpeaking();
      return;
    }
    if (recording) {
      await stopRecording();
      return;
    }
    await startRecording();
  }

  return (
    <Pressable delayLongPress={360} onLongPress={handleLongPress} onPress={handlePress} style={styles.screen}>
      <View pointerEvents="none" style={styles.ambientBackdrop}>
        <PremiumWhiteBackdrop />
      </View>
      <View pointerEvents={showChrome ? "auto" : "none"} style={[styles.header, !showChrome && styles.hiddenChrome]}>
        <Pressable
          onPress={(event) => {
            event.stopPropagation();
            onOpenMenu();
          }}
          style={styles.iconButton}
        >
          <Ionicons name="menu" size={28} color={colors.text} />
        </Pressable>
        <View style={styles.brand}>
          <AuraWordmark />
        </View>
        <Pressable
          onPress={(event) => {
            event.stopPropagation();
            revealChrome();
            setTypingMenuOpen((open) => !open);
          }}
          style={styles.iconButton}
        >
          <Ionicons name="create-outline" size={24} color={colors.text} />
        </Pressable>
      </View>
      {typingMenuOpen ? (
        <View style={styles.typingMenu}>
          <Pressable
            onPress={(event) => {
              event.stopPropagation();
              setTypingMenuOpen(false);
              onNavigate("type");
            }}
            style={styles.typingMenuItem}
          >
            <View style={styles.typingIcon}>
              <Ionicons name="keypad-outline" size={21} color={colors.text} />
            </View>
            <View style={styles.typingCopy}>
              <Text style={styles.typingTitle}>Type instead</Text>
              <Text style={styles.typingCaption}>Open keyboard mode</Text>
            </View>
            <Ionicons name="chevron-forward" size={18} color={colors.muted} />
          </Pressable>
        </View>
      ) : null}

      <View style={styles.center}>
        <View style={styles.orbStage}>
          <AuraOrb state={voiceState} />
        </View>
      </View>

      <View pointerEvents="none" style={[styles.statusArea, !showStatus && styles.hiddenChrome]}>
        {visibleReply ? (
          <Animated.Text
            numberOfLines={4}
            style={[
              styles.reply,
              {
                opacity: replyFade,
                transform: [
                  {
                    translateY: replyFade.interpolate({
                      inputRange: [0, 1],
                      outputRange: [8, 0]
                    })
                  }
                ]
              }
            ]}
          >
            {visibleReply}
          </Animated.Text>
        ) : activeStateLabel ? (
          <Text style={styles.state}>{activeStateLabel}</Text>
        ) : null}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  screen: {
    backgroundColor: colors.background,
    flex: 1,
    justifyContent: "center",
    overflow: "hidden"
  },
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-start",
    paddingHorizontal: 24,
    paddingTop: 20,
    position: "absolute",
    top: 0,
    width: "100%",
    zIndex: 10
  },
  hiddenChrome: {
    opacity: 0
  },
  ambientBackdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: colors.background
  },
  iconButton: {
    width: 52,
    height: 52,
    borderRadius: 26,
    backgroundColor: "rgba(250,252,255,0.82)",
    alignItems: "center",
    justifyContent: "center",
    shadowColor: "rgba(18,36,82,0.32)",
    shadowOffset: { width: 0, height: 10 },
    shadowOpacity: 0.1,
    shadowRadius: 22,
    elevation: 5
  },
  typingMenu: {
    backgroundColor: "rgba(248,250,253,0.96)",
    borderColor: colors.hairline,
    borderRadius: 22,
    borderWidth: 1,
    padding: 8,
    position: "absolute",
    right: 22,
    shadowColor: "rgba(18,36,82,0.28)",
    shadowOffset: { width: 0, height: 18 },
    shadowOpacity: 0.12,
    shadowRadius: 30,
    top: 84,
    width: 236,
    zIndex: 20
  },
  typingMenuItem: {
    alignItems: "center",
    borderRadius: 17,
    flexDirection: "row",
    gap: 12,
    minHeight: 62,
    paddingHorizontal: 10
  },
  typingIcon: {
    alignItems: "center",
    backgroundColor: "rgba(7,18,41,0.055)",
    borderRadius: 15,
    height: 38,
    justifyContent: "center",
    width: 38
  },
  typingCopy: {
    flex: 1,
    gap: 3
  },
  typingTitle: {
    color: colors.text,
    fontSize: 14,
    fontWeight: "800"
  },
  typingCaption: {
    color: colors.muted,
    fontSize: 12,
    fontWeight: "600"
  },
  brand: {
    alignItems: "center",
    paddingTop: 3
  },
  center: {
    alignItems: "center",
    flex: 1,
    justifyContent: "center",
    marginTop: -8
  },
  orbStage: {
    alignItems: "center",
    height: 560,
    justifyContent: "center",
    marginTop: -6,
    overflow: "visible",
    width: "100%"
  },
  bottomArea: {
    alignItems: "center",
    paddingBottom: 14,
    paddingHorizontal: 22,
    width: "100%"
  },
  statusArea: {
    alignItems: "center",
    bottom: 68,
    left: 24,
    position: "absolute",
    right: 24,
    zIndex: 4
  },
  state: {
    color: "rgba(7,18,41,0.58)",
    fontSize: 16,
    fontWeight: "500",
    letterSpacing: 0.1,
    lineHeight: 24,
    textAlign: "center",
    textShadowColor: "rgba(255,255,255,0.72)",
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 12
  },
  reply: {
    color: "rgba(7,18,41,0.58)",
    fontSize: 16,
    fontWeight: "500",
    letterSpacing: 0.1,
    lineHeight: 24,
    maxWidth: 340,
    textAlign: "center",
    textShadowColor: "rgba(255,255,255,0.72)",
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 12
  },
  removedControls: {
    display: "none"
  },
  micButtonWrap: {
    width: 96,
    height: 96,
    borderRadius: 48,
    backgroundColor: "rgba(36,91,255,0.09)",
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 22,
    shadowColor: "rgba(36,91,255,0.34)",
    shadowOffset: { width: 0, height: 18 },
    shadowOpacity: 0.22,
    shadowRadius: 26,
    elevation: 7
  },
  micButtonPressed: {
    opacity: 0.7,
    transform: [{ scale: 0.96 }]
  },
  micButtonInner: {
    width: 76,
    height: 76,
    borderRadius: 38,
    backgroundColor: colors.surface,
    alignItems: "center",
    justifyContent: "center",
    shadowColor: "rgba(36,91,255,0.4)",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.2,
    shadowRadius: 18,
    elevation: 5
  },
  infoCard: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: colors.surface,
    borderRadius: 24,
    paddingHorizontal: 18,
    paddingVertical: 14,
    width: "100%",
    marginBottom: 16,
    borderWidth: 1,
    borderColor: colors.hairline,
    shadowColor: "rgba(18,36,82,0.22)",
    shadowOffset: { width: 0, height: 12 },
    shadowOpacity: 0.08,
    shadowRadius: 24,
  },
  sparkleIcon: {
    marginRight: 18
  },
  infoCardText: {
    flex: 1
  },
  infoCardTitle: {
    color: colors.text,
    fontSize: 17,
    fontWeight: "800",
    marginBottom: 5
  },
  infoCardSubtitle: {
    color: colors.muted,
    fontSize: 15,
    fontWeight: "600"
  },
  audioWaveMock: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    marginLeft: 12
  },
  waveBar: {
    width: 4,
    backgroundColor: colors.blue,
    borderRadius: 3,
    opacity: 0.6
  },
  bottomNav: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    backgroundColor: colors.surface,
    borderRadius: 34,
    paddingHorizontal: 20,
    paddingVertical: 12,
    width: "100%",
    shadowColor: "rgba(18,36,82,0.2)",
    shadowOffset: { width: 0, height: 14 },
    shadowOpacity: 0.1,
    shadowRadius: 28,
    elevation: 8,
    borderWidth: 1,
    borderColor: colors.hairline
  },
  navItem: {
    alignItems: "center",
    justifyContent: "center",
    gap: 7,
    minWidth: 54
  },
  activeNavIconBg: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: colors.blue,
    shadowColor: colors.blue,
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.24,
    shadowRadius: 18
  },
  navText: {
    fontSize: 13,
    fontWeight: "800",
    color: colors.muted
  }
});
