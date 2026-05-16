import { Ionicons } from "@expo/vector-icons";
import { Pressable, StyleSheet } from "react-native";
import { colors } from "../theme/colors";

export function MenuButton({ onPress, close = false }: { onPress: () => void; close?: boolean }) {
  return (
    <Pressable
      accessibilityLabel={close ? "Close menu" : "Open menu"}
      onPress={(event) => {
        event.stopPropagation();
        onPress();
      }}
      style={styles.button}
    >
      <Ionicons name={close ? "close" : "menu"} size={23} color={colors.text} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: {
    alignItems: "center",
    backgroundColor: "rgba(255,255,255,0.72)",
    borderColor: "rgba(18,36,82,0.1)",
    borderRadius: 20,
    borderWidth: 1,
    height: 42,
    justifyContent: "center",
    width: 42
  }
});
