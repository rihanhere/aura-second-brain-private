import { useEffect, useRef } from "react";
import { Animated, StyleSheet, Text, View } from "react-native";
import { colors } from "../theme/colors";

export function LaunchScreen({ onDone }: { onDone?: () => void }) {
  const progress = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    const animation = Animated.sequence([
      Animated.timing(progress, {
        toValue: 0.72,
        duration: 1300,
        useNativeDriver: true
      }),
      Animated.timing(progress, {
        toValue: 1,
        duration: 850,
        useNativeDriver: true
      })
    ]);

    animation.start(({ finished }) => {
      if (finished) onDone?.();
    });

    return () => animation.stop();
  }, [onDone, progress]);

  const copyOpacity = progress.interpolate({
    inputRange: [0, 0.2, 0.8, 1],
    outputRange: [0, 1, 1, 0]
  });
  const copyTranslate = progress.interpolate({
    inputRange: [0, 0.72, 1],
    outputRange: [10, 0, -6]
  });

  return (
    <View style={styles.screen}>
      <Animated.View style={[styles.copyWrap, { opacity: copyOpacity, transform: [{ translateY: copyTranslate }] }]}>
        <Text style={styles.logo}>ΛURΛ</Text>
        <Text style={styles.waking}>WAKING</Text>
        <Text style={styles.up}>UP</Text>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    alignItems: "center",
    backgroundColor: colors.background,
    flex: 1,
    justifyContent: "center",
    overflow: "hidden"
  },
  copyWrap: {
    alignItems: "center",
    left: 24,
    position: "absolute",
    right: 24,
    top: "41%"
  },
  logo: {
    color: "rgba(0,0,0,0.96)",
    fontSize: 70,
    fontWeight: "200",
    letterSpacing: 23,
    lineHeight: 86,
    paddingLeft: 23,
    textAlign: "center"
  },
  waking: {
    color: "rgba(0,0,0,0.9)",
    fontSize: 31,
    fontWeight: "300",
    letterSpacing: 19,
    lineHeight: 46,
    marginTop: 20,
    paddingLeft: 19,
    textAlign: "center"
  },
  up: {
    color: "rgba(0,0,0,0.9)",
    fontSize: 32,
    fontWeight: "300",
    letterSpacing: 24,
    lineHeight: 46,
    marginTop: 18,
    paddingLeft: 24,
    textAlign: "center"
  }
});
