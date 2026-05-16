import { Ionicons } from "@expo/vector-icons";
import { ActivityIndicator, Pressable, StyleSheet, TextInput, View } from "react-native";
import { colors } from "../theme/colors";
import type { VoiceState } from "./IntelligenceOrb";

export function VoiceInputBar({
  value,
  onChangeText,
  onSubmit,
  onVoicePress,
  state,
  loading
}: {
  value: string;
  onChangeText: (value: string) => void;
  onSubmit: () => void;
  onVoicePress: () => void;
  state: VoiceState;
  loading: boolean;
}) {
  const isListening = state === "listening";

  return (
    <View style={styles.bar}>
      <TextInput
        value={value}
        onChangeText={onChangeText}
        placeholder={isListening ? "Listening..." : "Type a message..."}
        placeholderTextColor={colors.muted}
        style={styles.input}
        returnKeyType="send"
        onSubmitEditing={onSubmit}
      />
      <Pressable accessibilityLabel={isListening ? "Stop voice capture" : "Start voice capture"} onPress={onVoicePress} style={[styles.voiceButton, isListening && styles.voiceActive]}>
        {loading ? <ActivityIndicator color={colors.ivory} /> : <Ionicons name={isListening ? "stop" : "pulse"} size={24} color={colors.ivory} />}
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    alignItems: "center",
    backgroundColor: "rgba(10,12,15,0.74)",
    borderColor: "rgba(239,230,210,0.18)",
    borderRadius: 31,
    borderWidth: 1,
    flexDirection: "row",
    gap: 8,
    minHeight: 62,
    paddingLeft: 22,
    paddingRight: 8
  },
  input: {
    color: colors.text,
    flex: 1,
    fontSize: 16,
    minHeight: 52
  },
  voiceButton: {
    alignItems: "center",
    borderRadius: 27,
    height: 54,
    justifyContent: "center",
    width: 54
  },
  voiceActive: {
    backgroundColor: "rgba(239,230,210,0.1)"
  }
});
