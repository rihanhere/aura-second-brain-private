import { Animated, StyleSheet, Text, View } from "react-native";
import { colors } from "../theme/colors";

export function AuraWordmark({
  animatedOpacity,
  size = "regular"
}: {
  animatedOpacity?: Animated.AnimatedInterpolation<number> | Animated.Value;
  size?: "regular" | "large";
}) {
  const Wrapper = animatedOpacity ? Animated.View : View;

  return (
    <Wrapper style={[styles.wrap, animatedOpacity ? { opacity: animatedOpacity } : null]}>
      <Text style={[styles.logo, size === "large" && styles.logoLarge]}>ΛURΛ</Text>
      <Text style={[styles.subtitle, size === "large" && styles.subtitleLarge]}>Your AI Life Journal</Text>
    </Wrapper>
  );
}

const styles = StyleSheet.create({
  wrap: {
    alignItems: "center"
  },
  logo: {
    color: "rgba(0,0,0,0.92)",
    fontSize: 24,
    fontWeight: "200",
    letterSpacing: 10,
    lineHeight: 28,
    paddingLeft: 10,
  },
  logoLarge: {
    fontSize: 29,
    letterSpacing: 12,
    lineHeight: 34,
    paddingLeft: 12
  },
  subtitle: {
    color: "rgba(73,83,116,0.7)",
    fontSize: 15,
    fontWeight: "500",
    marginTop: 2
  },
  subtitleLarge: {
    fontSize: 16,
    marginTop: 3
  }
});
