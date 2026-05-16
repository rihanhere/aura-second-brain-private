import { StyleSheet, Text, View } from "react-native";
import { colors } from "../theme/colors";

export function SignalPill({ label, tone = "blue" }: { label: string; tone?: "blue" | "green" | "amber" | "red" | "violet" }) {
  const color = colors[tone];
  return (
    <View style={[styles.pill, { borderColor: `${color}55`, backgroundColor: `${color}14` }]}>
      <Text style={[styles.label, { color }]} numberOfLines={1}>
        {label}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  pill: {
    borderRadius: 999,
    borderWidth: 1,
    maxWidth: 160,
    paddingHorizontal: 9,
    paddingVertical: 5
  },
  label: {
    fontSize: 12,
    fontWeight: "700"
  }
});
