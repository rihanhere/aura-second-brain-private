import { Ionicons } from "@expo/vector-icons";
import { StyleSheet, Text, View } from "react-native";
import type { LocalSession } from "../lib/localStore";
import { colors } from "../theme/colors";

export function ProfileScreen({ session }: { session: LocalSession }) {
  return (
    <View style={styles.screen}>
      <View style={styles.headerRow}>
        <Text style={styles.title}>You</Text>
        <Ionicons name="pencil-outline" size={24} color={colors.text} style={styles.headerRightIcon} />
      </View>
      <View style={styles.avatar} />
      <Text style={styles.name}>You</Text>
      <Text style={styles.caption}>AI Life Journaler</Text>
      <View style={styles.panel}>
        {[
          ["Your Preferences", "Voice, tone & response style", "settings-outline"],
          ["Your Goals", "What you're working towards", "shield-checkmark-outline"],
          ["Your Stats", "Your journal overview", "stats-chart-outline"]
        ].map(([label, caption, icon]) => (
          <View key={label} style={styles.row}>
            <Ionicons name={icon as keyof typeof Ionicons.glyphMap} size={20} color={colors.blue} />
            <View style={styles.copy}>
              <Text style={styles.label}>{label}</Text>
              <Text style={styles.small}>{caption}</Text>
            </View>
            <Ionicons name="chevron-forward" size={17} color={colors.muted} />
          </View>
        ))}
      </View>
      <Text style={styles.session}>Local profile · {session.userId.slice(-6)}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    alignItems: "center",
    backgroundColor: colors.background,
    flex: 1,
    padding: 22,
    paddingTop: 70
  },
  headerRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    width: "100%",
    position: "relative"
  },
  headerRightIcon: {
    position: "absolute",
    right: 0
  },
  title: {
    color: colors.text,
    fontSize: 17,
    fontWeight: "800"
  },
  avatar: {
    backgroundColor: colors.blue,
    borderRadius: 34,
    height: 68,
    marginTop: 36,
    opacity: 0.84,
    shadowColor: colors.blue,
    shadowOpacity: 0.24,
    shadowRadius: 28,
    width: 68
  },
  name: {
    color: colors.text,
    fontSize: 24,
    fontWeight: "800",
    marginTop: 18
  },
  caption: {
    color: colors.muted,
    fontSize: 13,
    marginTop: 4
  },
  panel: {
    alignSelf: "stretch",
    backgroundColor: colors.surface,
    borderColor: colors.hairline,
    borderRadius: 16,
    borderWidth: 1,
    marginTop: 34,
    overflow: "hidden"
  },
  row: {
    alignItems: "center",
    borderBottomColor: colors.hairline,
    borderBottomWidth: 1,
    flexDirection: "row",
    gap: 13,
    minHeight: 72,
    paddingHorizontal: 18
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
  small: {
    color: colors.muted,
    fontSize: 12
  },
  session: {
    color: colors.muted,
    fontSize: 12,
    marginTop: 18
  }
});
