import { Ionicons } from "@expo/vector-icons";
import { useEffect, useState } from "react";
import { FlatList, RefreshControl, StyleSheet, Text, View } from "react-native";
import { listMemories, type MemoryItem } from "../lib/api";
import { cacheMemories, getCachedMemories } from "../lib/localStore";
import { colors } from "../theme/colors";

export function MemoryScreen({ refreshKey }: { refreshKey: number }) {
  const [entries, setEntries] = useState<MemoryItem[]>([]);
  const [isRefreshing, setIsRefreshing] = useState(false);

  async function load() {
    setIsRefreshing(true);
    try {
      const cached = await getCachedMemories();
      if (cached.length) setEntries(cached);
      const result = await listMemories();
      const nextEntries = result.memories.length ? result.memories : cached;
      setEntries(nextEntries);
      if (nextEntries.length) await cacheMemories(nextEntries);
    } finally {
      setIsRefreshing(false);
    }
  }

  useEffect(() => {
    load();
  }, [refreshKey]);

  return (
    <View style={styles.screen}>
      <View style={styles.headerRow}>
        <Text style={styles.title}>Journal</Text>
        <Ionicons name="filter-outline" size={24} color={colors.text} style={styles.headerRightIcon} />
      </View>
      <FlatList
        data={entries}
        keyExtractor={(item) => item.id}
        refreshControl={<RefreshControl refreshing={isRefreshing} onRefresh={load} tintColor={colors.blue} />}
        contentContainerStyle={styles.list}
        renderItem={({ item }) => (
          <View style={styles.card}>
            <View style={styles.meta}>
              <Text style={styles.time}>
                {new Date(item.created_at).toLocaleDateString(undefined, { month: "short", day: "numeric" })} ·{" "}
                {new Date(item.created_at).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}
              </Text>
              <Ionicons name="pulse" size={18} color={colors.blue} />
            </View>
            <Text style={styles.summary}>{item.summary || item.content}</Text>
            {item.emotional_state ? <Text style={styles.tag}>{item.emotional_state}</Text> : null}
          </View>
        )}
        ItemSeparatorComponent={() => <View style={styles.gap} />}
        ListEmptyComponent={<Text style={styles.empty}>Your first voice journal entry will appear here.</Text>}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    backgroundColor: colors.background,
    flex: 1,
    paddingHorizontal: 22,
    paddingTop: 70
  },
  headerRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 26,
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
  list: {
    paddingBottom: 50
  },
  card: {
    backgroundColor: colors.surface,
    borderColor: colors.hairline,
    borderRadius: 14,
    borderWidth: 1,
    padding: 16,
    shadowColor: "#123",
    shadowOpacity: 0.06,
    shadowRadius: 18
  },
  meta: {
    alignItems: "center",
    flexDirection: "row",
    justifyContent: "space-between",
    marginBottom: 10
  },
  time: {
    color: colors.muted,
    fontSize: 12,
    fontWeight: "700"
  },
  summary: {
    color: colors.text,
    fontSize: 15,
    lineHeight: 22
  },
  tag: {
    color: colors.blue,
    fontSize: 12,
    fontWeight: "800",
    marginTop: 12
  },
  gap: {
    height: 12
  },
  empty: {
    color: colors.muted,
    marginTop: 60,
    textAlign: "center"
  }
});
