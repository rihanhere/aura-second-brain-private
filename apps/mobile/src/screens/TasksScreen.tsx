import { useEffect, useState } from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import { TodoRow } from "../components/TaskRow";
import { listTodos, type TodoItem } from "../lib/api";
import { colors } from "../theme/colors";

export function TasksScreen({ refreshKey }: { refreshKey: number }) {
  const [todos, setTodos] = useState<TodoItem[]>([]);

  useEffect(() => {
    listTodos().then((todoResult) => setTodos(todoResult.todos));
  }, [refreshKey]);

  return (
    <ScrollView contentContainerStyle={styles.screen}>
      <View style={styles.header}>
        <Text style={styles.title}>Tasks</Text>
        <Text style={styles.subtitle}>Action items detected from your memories stay connected to goals.</Text>
      </View>
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Todos</Text>
        {todos.length ? todos.map((todo) => <TodoRow key={todo.id} todo={todo} />) : <Text style={styles.empty}>Todos detected from your thoughts will appear here.</Text>}
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: {
    gap: 20,
    padding: 20,
    paddingBottom: 80,
    paddingTop: 132
  },
  header: {
    gap: 6
  },
  title: {
    color: colors.text,
    fontSize: 28,
    fontWeight: "800"
  },
  subtitle: {
    color: colors.soft,
    fontSize: 14,
    lineHeight: 20
  },
  section: {
    gap: 10
  },
  sectionTitle: {
    color: colors.text,
    fontSize: 18,
    fontWeight: "800"
  },
  empty: {
    color: colors.muted,
    backgroundColor: colors.surface,
    borderColor: colors.hairline,
    borderRadius: 8,
    borderWidth: 1,
    padding: 16
  }
});
