import * as Haptics from "expo-haptics";
import { useState } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { captureThought } from "../lib/api";
import { playAgentVoice, speakTextWithFailsafe } from "../lib/audio";
import { colors } from "../theme/colors";

export function TypeInsteadScreen({ onCaptured }: { onCaptured: () => void }) {
  const [text, setText] = useState("");
  const [status, setStatus] = useState("Type a thought for AURA.");
  const [loading, setLoading] = useState(false);

  async function submit() {
    const content = text.trim();
    if (!content || loading) return;
    setLoading(true);
    setStatus("Reflecting...");
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    try {
      const result = await captureThought(content, "text", Intl.DateTimeFormat().resolvedOptions().timeZone);
      setText("");
      setStatus(result.reply);
      onCaptured();
      if (result.voice?.audioBase64) await playAgentVoice(result.voice);
      else await speakTextWithFailsafe(result.reply);
    } catch {
      setStatus("Saved locally. AI is unavailable right now.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <View style={styles.screen}>
      <Text style={styles.title}>Type instead</Text>
      <TextInput
        multiline
        onChangeText={setText}
        placeholder="What's on your mind?"
        placeholderTextColor={colors.muted}
        style={styles.input}
        value={text}
      />
      <Pressable onPress={submit} style={[styles.button, (!text.trim() || loading) && styles.disabled]}>
        <Text style={styles.buttonText}>{loading ? "Listening inside..." : "Send to AURA"}</Text>
      </Pressable>
      <Text style={styles.status}>{status}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    backgroundColor: colors.background,
    flex: 1,
    padding: 22,
    paddingTop: 70
  },
  title: {
    color: colors.text,
    fontSize: 17,
    fontWeight: "800",
    marginBottom: 28,
    textAlign: "center"
  },
  input: {
    backgroundColor: colors.surface,
    borderColor: colors.hairline,
    borderRadius: 16,
    borderWidth: 1,
    color: colors.text,
    fontSize: 16,
    minHeight: 180,
    padding: 16,
    textAlignVertical: "top"
  },
  button: {
    alignItems: "center",
    backgroundColor: colors.blue,
    borderRadius: 16,
    marginTop: 16,
    paddingVertical: 15
  },
  disabled: {
    opacity: 0.45
  },
  buttonText: {
    color: "#FFFFFF",
    fontSize: 15,
    fontWeight: "800"
  },
  status: {
    color: colors.soft,
    fontSize: 14,
    lineHeight: 21,
    marginTop: 18,
    textAlign: "center"
  }
});
