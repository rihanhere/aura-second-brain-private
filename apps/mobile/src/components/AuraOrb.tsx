import React, { memo, useEffect, useRef } from "react";
import { Animated, Easing, StyleSheet, Text, View } from "react-native";
import type { VoiceState } from "./IntelligenceOrb";

function AuraLogoPresence({ state }: { state: VoiceState }) {
  const pulse = useRef(new Animated.Value(0)).current;
  const drift = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    const pulseLoop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, {
          toValue: 1,
          duration: state === "idle" ? 5200 : 3200,
          easing: Easing.inOut(Easing.sin),
          useNativeDriver: true
        }),
        Animated.timing(pulse, {
          toValue: 0,
          duration: state === "idle" ? 5600 : 3400,
          easing: Easing.inOut(Easing.sin),
          useNativeDriver: true
        })
      ])
    );
    const driftLoop = Animated.loop(
      Animated.sequence([
        Animated.timing(drift, {
          toValue: 1,
          duration: 6800,
          easing: Easing.inOut(Easing.sin),
          useNativeDriver: true
        }),
        Animated.timing(drift, {
          toValue: 0,
          duration: 7200,
          easing: Easing.inOut(Easing.sin),
          useNativeDriver: true
        })
      ])
    );

    pulseLoop.start();
    driftLoop.start();
    return () => {
      pulseLoop.stop();
      driftLoop.stop();
    };
  }, [drift, pulse, state]);

  const scale = pulse.interpolate({
    inputRange: [0, 1],
    outputRange: [0.992, state === "idle" ? 1.012 : 1.026]
  });
  const translateY = drift.interpolate({
    inputRange: [0, 1],
    outputRange: [-5, 7]
  });
  const opacity = pulse.interpolate({
    inputRange: [0, 1],
    outputRange: [0.9, 1]
  });

  return (
    <Animated.View pointerEvents="none" style={styles.presence}>
      <Animated.View
        style={[
          styles.motion,
          {
            opacity,
            transform: [{ translateY }, { scale }]
          }
        ]}
      >
        <View style={styles.halo} />
        <Text style={styles.logo}>ΛURΛ</Text>
      </Animated.View>
    </Animated.View>
  );
}

export const AuraOrb = memo(function AuraOrb({ state }: { state: VoiceState }) {
  useEffect(() => {
    console.log("[AURA orb] mounted logo-only presence");
  }, []);

  return (
    <View style={styles.container}>
      <AuraLogoPresence state={state} />
    </View>
  );
});

const styles = StyleSheet.create({
  container: {
    alignItems: "center",
    height: 480,
    justifyContent: "center",
    overflow: "visible",
    width: 480
  },
  presence: {
    ...StyleSheet.absoluteFillObject,
    alignItems: "center",
    justifyContent: "center"
  },
  motion: {
    alignItems: "center",
    justifyContent: "center"
  },
  logo: {
    color: "rgba(28,28,30,0.62)",
    fontSize: 54,
    fontWeight: "200",
    letterSpacing: 18,
    lineHeight: 68,
    paddingLeft: 18,
    textAlign: "center"
  },
  halo: {
    borderColor: "rgba(28,28,30,0.018)",
    borderRadius: 160,
    borderWidth: 1,
    height: 320,
    position: "absolute",
    width: 320
  }
});
