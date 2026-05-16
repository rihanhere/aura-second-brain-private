import { useEffect, useState } from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import { ReminderRow } from "../components/TaskRow";
import { listReminders, type ReminderItem } from "../lib/api";
import { colors } from "../theme/colors";

export function RemindersScreen({ refreshKey }: { refreshKey: number }) {
  const [reminders, setReminders] = useState<ReminderItem[]>([]);

  useEffect(() => {
    listReminders().then((result) => setReminders(result.reminders));
  }, [refreshKey]);

  return (
    <ScrollView contentContainerStyle={styles.screen}>
      <View style={styles.header}>
        <Text style={styles.title}>Reminders</Text>
        <Text style={styles.subtitle}>Voice-created prompts for things your future self should not have to hold.</Text>
      </View>
      <View style={styles.section}>
        {reminders.length ? reminders.map((reminder) => <ReminderRow key={reminder.id} reminder={reminder} />) : <Text style={styles.empty}>Say “remind me...” on Home. Keep AURA open around the reminder time so it can speak.</Text>}
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
  section: {
    gap: 10
  },
  empty: {
    backgroundColor: "rgba(239,230,210,0.045)",
    borderColor: "rgba(239,230,210,0.1)",
    borderRadius: 18,
    borderWidth: 1,
    color: colors.muted,
    lineHeight: 21,
    padding: 16
  }
});
