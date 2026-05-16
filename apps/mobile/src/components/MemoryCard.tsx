import { Ionicons } from "@expo/vector-icons";
import { StyleSheet, Text, View } from "react-native";
import type { MemoryItem } from "../lib/api";
import { colors } from "../theme/colors";
import { SignalPill } from "./SignalPill";

export function MemoryCard({ memory }: { memory: MemoryItem }) {
  const created = memory.created_at ? new Date(memory.created_at).toLocaleDateString() : "Now";
  const tags = memory.auto_tags ?? [];

  return (
    <View style={styles.card}>
      <View style={styles.header}>
        <View style={styles.titleRow}>
          <Ionicons name={memory.memory_layer === "pinned" ? "pin" : "ellipse"} size={14} color={colors.amber} />
          <Text style={styles.summary} numberOfLines={2}>
            {memory.summary || memory.content}
          </Text>
        </View>
        <Text style={styles.date}>{created}</Text>
      </View>
      <Text style={styles.content} numberOfLines={3}>
        {memory.content}
      </Text>
      <View style={styles.tags}>
        {tags.slice(0, 3).map((tag) => (
          <SignalPill key={tag} label={tag} tone={tag === "emotion" ? "violet" : tag === "goal" ? "green" : "blue"} />
        ))}
        {memory.importance ? <SignalPill label={memory.importance} tone={memory.importance === "critical" ? "red" : "amber"} /> : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.surface,
    borderColor: colors.hairline,
    borderRadius: 8,
    borderWidth: 1,
    gap: 12,
    padding: 16
  },
  header: {
    gap: 8
  },
  titleRow: {
    alignItems: "center",
    flexDirection: "row",
    gap: 8
  },
  summary: {
    color: colors.text,
    flex: 1,
    fontSize: 16,
    fontWeight: "700",
    lineHeight: 21
  },
  date: {
    color: colors.muted,
    fontSize: 12
  },
  content: {
    color: colors.soft,
    fontSize: 14,
    lineHeight: 20
  },
  tags: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8
  }
});
