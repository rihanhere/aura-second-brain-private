import { Ionicons } from "@expo/vector-icons";
import { useEffect, useState } from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import { listInsights, type InsightSummary } from "../lib/api";
import { colors } from "../theme/colors";

export function InsightsScreen({ refreshKey }: { refreshKey: number }) {
  const [insights, setInsights] = useState<InsightSummary | null>(null);

  useEffect(() => {
    listInsights().then((result) => setInsights(result.insights));
  }, [refreshKey]);

  return (
    <ScrollView contentContainerStyle={styles.screen}>
      <View style={styles.headerRow}>
        <Text style={styles.title}>Insights</Text>
        <Ionicons name="calendar-outline" size={24} color={colors.text} style={styles.headerRightIcon} />
      </View>
      <View style={styles.grid}>
        <View style={styles.stat}>
          <Text style={styles.label}>Mood</Text>
          <Text style={styles.value}>{insights?.moodTrend?.includes("emotional") ? "Reflective" : "Calm"}</Text>
        </View>
        <View style={styles.stat}>
          <Text style={styles.label}>Themes</Text>
          <Text style={styles.value}>{insights?.recurringThemes?.length ?? 0}</Text>
        </View>
      </View>
      <View style={styles.panel}>
        <View style={styles.header}>
          <Ionicons name="sparkles-outline" size={19} color={colors.blue} />
          <Text style={styles.panelTitle}>Weekly Reflection</Text>
        </View>
        <Text style={styles.body}>{insights?.weeklyReflection ?? "Capture a few voice entries and AURA will begin to notice patterns."}</Text>
      </View>
      <View style={styles.panel}>
        <View style={styles.header}>
          <Ionicons name="analytics-outline" size={19} color={colors.blue} />
          <Text style={styles.panelTitle}>Top Themes</Text>
        </View>
        {(insights?.recurringThemes ?? []).length ? (
          insights?.recurringThemes.map((theme) => (
            <View key={theme.topic} style={styles.theme}>
              <Text style={styles.themeText}>{theme.topic}</Text>
              <View style={styles.bar}>
                <View style={[styles.fill, { width: `${Math.min(100, theme.count * 22)}%` }]} />
              </View>
            </View>
          ))
        ) : (
          <Text style={styles.body}>No strong recurring theme yet.</Text>
        )}
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: {
    backgroundColor: colors.background,
    gap: 18,
    padding: 22,
    paddingBottom: 70,
    paddingTop: 70
  },
  headerRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    position: "relative"
  },
  headerRightIcon: {
    position: "absolute",
    right: 0
  },
  title: {
    color: colors.text,
    fontSize: 17,
    fontWeight: "800",
  },
  grid: {
    flexDirection: "row",
    gap: 10
  },
  stat: {
    backgroundColor: colors.surface,
    borderColor: colors.hairline,
    borderRadius: 14,
    borderWidth: 1,
    flex: 1,
    padding: 16
  },
  label: {
    color: colors.muted,
    fontSize: 12,
    fontWeight: "800"
  },
  value: {
    color: colors.text,
    fontSize: 22,
    fontWeight: "800",
    marginTop: 8
  },
  panel: {
    backgroundColor: colors.surface,
    borderColor: colors.hairline,
    borderRadius: 14,
    borderWidth: 1,
    gap: 14,
    padding: 16
  },
  header: {
    alignItems: "center",
    flexDirection: "row",
    gap: 9
  },
  panelTitle: {
    color: colors.text,
    fontSize: 15,
    fontWeight: "800"
  },
  body: {
    color: colors.soft,
    fontSize: 14,
    lineHeight: 21
  },
  theme: {
    gap: 8
  },
  themeText: {
    color: colors.text,
    fontSize: 14,
    fontWeight: "700",
    textTransform: "capitalize"
  },
  bar: {
    backgroundColor: "rgba(36,91,255,0.08)",
    borderRadius: 99,
    height: 5,
    overflow: "hidden"
  },
  fill: {
    backgroundColor: colors.blue,
    borderRadius: 99,
    height: 5
  }
});
