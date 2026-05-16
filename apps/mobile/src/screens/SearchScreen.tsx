import { Ionicons } from "@expo/vector-icons";
import { useEffect, useState } from "react";
import { FlatList, StyleSheet, Text, TextInput, View } from "react-native";
import { MemoryCard } from "../components/MemoryCard";
import { listMemories, type MemoryItem } from "../lib/api";
import { colors } from "../theme/colors";

export function SearchScreen({ refreshKey }: { refreshKey: number }) {
  const [query, setQuery] = useState("");
  const [memories, setMemories] = useState<MemoryItem[]>([]);

  useEffect(() => {
    listMemories().then((result) => setMemories(result.memories));
  }, [refreshKey]);

  const filtered = query.trim()
    ? memories.filter((memory) => `${memory.summary} ${memory.content} ${(memory.auto_tags ?? []).join(" ")}`.toLowerCase().includes(query.toLowerCase()))
    : memories.slice(0, 8);

  return (
    <View style={styles.screen}>
      <View style={styles.header}>
        <Text style={styles.title}>Search</Text>
        <Text style={styles.subtitle}>Ask memory in plain language. Semantic recall connects here once the backend is live.</Text>
      </View>
      <View style={styles.search}>
        <Ionicons name="search-outline" size={19} color={colors.soft} />
        <TextInput value={query} onChangeText={setQuery} placeholder="What was I stressed about recently?" placeholderTextColor={colors.muted} style={styles.input} />
      </View>
      <FlatList
        data={filtered}
        keyExtractor={(item) => item.id}
        renderItem={({ item }) => <MemoryCard memory={item} />}
        ItemSeparatorComponent={() => <View style={styles.gap} />}
        ListEmptyComponent={<Text style={styles.empty}>No matching memory yet.</Text>}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    gap: 16,
    padding: 20,
    paddingTop: 132
  },
  header: {
    gap: 7
  },
  title: {
    color: colors.text,
    fontSize: 31,
    fontWeight: "800"
  },
  subtitle: {
    color: colors.soft,
    fontSize: 14,
    lineHeight: 21
  },
  search: {
    alignItems: "center",
    backgroundColor: "rgba(239,230,210,0.045)",
    borderColor: "rgba(239,230,210,0.11)",
    borderRadius: 28,
    borderWidth: 1,
    flexDirection: "row",
    gap: 10,
    minHeight: 56,
    paddingHorizontal: 16
  },
  input: {
    color: colors.text,
    flex: 1,
    fontSize: 15
  },
  gap: {
    height: 12
  },
  empty: {
    color: colors.muted,
    paddingTop: 42,
    textAlign: "center"
  }
});
