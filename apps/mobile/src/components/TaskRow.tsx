import { Ionicons } from "@expo/vector-icons";
import { StyleSheet, Text, View } from "react-native";
import type { ReminderItem, TodoItem } from "../lib/api";
import { colors } from "../theme/colors";
import { SignalPill } from "./SignalPill";

export function TodoRow({ todo }: { todo: TodoItem }) {
  return (
    <View style={styles.row}>
      <Ionicons name={todo.status === "completed" ? "checkmark-circle" : "ellipse-outline"} size={22} color={todo.status === "completed" ? colors.green : colors.muted} />
      <View style={styles.copy}>
        <Text style={styles.title}>{todo.title}</Text>
        <SignalPill label={todo.priority} tone={todo.priority === "high" ? "red" : todo.priority === "medium" ? "amber" : "green"} />
      </View>
    </View>
  );
}

export function ReminderRow({ reminder }: { reminder: ReminderItem }) {
  return (
    <View style={styles.row}>
      <Ionicons name={reminder.recurrence_rule ? "repeat" : "alarm"} size={22} color={colors.amber} />
      <View style={styles.copy}>
        <Text style={styles.title}>{reminder.title}</Text>
        <Text style={styles.meta}>{new Date(reminder.scheduled_at).toLocaleString()}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    alignItems: "center",
    backgroundColor: colors.surface,
    borderColor: colors.hairline,
    borderRadius: 8,
    borderWidth: 1,
    flexDirection: "row",
    gap: 12,
    padding: 14
  },
  copy: {
    flex: 1,
    gap: 8
  },
  title: {
    color: colors.text,
    fontSize: 15,
    fontWeight: "700",
    lineHeight: 20
  },
  meta: {
    color: colors.muted,
    fontSize: 12
  }
});
