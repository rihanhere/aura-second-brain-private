import { Ionicons } from "@expo/vector-icons";
import { StyleSheet, Text, View } from "react-native";
import { colors } from "../theme/colors";

const rows: Array<[string, string, keyof typeof Ionicons.glyphMap]> = [
  ["Voice & Audio", "Groq Whisper + Gemini voice", "volume-medium-outline"],
  ["Memory & Privacy", "Local-first journal storage", "file-tray-full-outline"],
  ["AI Model", "OpenRouter key rotation", "sparkles-outline"],
  ["Appearance", "AURA white / blue orb", "color-palette-outline"],
  ["API Diagnostics", "Graceful retries enabled", "pulse-outline"]
];

export function SettingsScreen() {
  return (
    <View style={styles.screen}>
      <Text style={styles.title}>Settings</Text>
      <View style={styles.section}>
        {rows.map(([label, caption, icon]) => (
          <View key={label} style={styles.row}>
            <Ionicons name={icon} size={20} color={colors.blue} />
            <View style={styles.copy}>
              <Text style={styles.label}>{label}</Text>
              <Text style={styles.caption}>{caption}</Text>
            </View>
            <Ionicons name="chevron-forward" size={17} color={colors.muted} />
          </View>
        ))}
      </View>
      <Text style={styles.version}>AURA V1 · local-first beta</Text>
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
  section: {
    backgroundColor: colors.surface,
    borderColor: colors.hairline,
    borderRadius: 16,
    borderWidth: 1,
    overflow: "hidden"
  },
  row: {
    alignItems: "center",
    borderBottomColor: colors.hairline,
    borderBottomWidth: 1,
    flexDirection: "row",
    gap: 13,
    minHeight: 68,
    paddingHorizontal: 16
  },
  copy: {
    flex: 1,
    gap: 4
  },
  label: {
    color: colors.text,
    fontSize: 14,
    fontWeight: "800"
  },
  caption: {
    color: colors.muted,
    fontSize: 12
  },
  version: {
    color: colors.muted,
    fontSize: 12,
    marginTop: 18,
    textAlign: "center"
  }
});
