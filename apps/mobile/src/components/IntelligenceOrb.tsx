import { memo, useEffect, useRef } from "react";
import { Animated, Easing, StyleSheet, View } from "react-native";
import Svg, { Circle, Defs, Ellipse, G, Line, RadialGradient, Stop } from "react-native-svg";
import { colors } from "../theme/colors";

export type VoiceState = "idle" | "listening" | "thinking" | "speaking" | "error";

const AnimatedView = Animated.createAnimatedComponent(View);

export const IntelligenceOrb = memo(function IntelligenceOrb({ state }: { state: VoiceState }) {
  const breathe = useRef(new Animated.Value(0)).current;
  const rotate = useRef(new Animated.Value(0)).current;
  const pulse = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    const breathing = Animated.loop(
      Animated.sequence([
        Animated.timing(breathe, { toValue: 1, duration: 2800, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
        Animated.timing(breathe, { toValue: 0, duration: 2800, easing: Easing.inOut(Easing.quad), useNativeDriver: true })
      ])
    );
    const rotation = Animated.loop(Animated.timing(rotate, { toValue: 1, duration: 18000, easing: Easing.linear, useNativeDriver: true }));
    const pulsing = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 1, duration: state === "speaking" ? 680 : 1350, useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 0, duration: state === "speaking" ? 680 : 1350, useNativeDriver: true })
      ])
    );

    breathing.start();
    rotation.start();
    pulsing.start();
    return () => {
      breathing.stop();
      rotation.stop();
      pulsing.stop();
    };
  }, [breathe, pulse, rotate, state]);

  const scale = breathe.interpolate({ inputRange: [0, 1], outputRange: [0.97, state === "listening" ? 1.08 : 1.03] });
  const pulseScale = pulse.interpolate({ inputRange: [0, 1], outputRange: [0.95, state === "speaking" ? 1.16 : 1.06] });
  const rotateZ = rotate.interpolate({ inputRange: [0, 1], outputRange: ["0deg", "360deg"] });
  const glowOpacity = state === "listening" ? 0.74 : state === "thinking" ? 0.6 : state === "speaking" ? 0.82 : 0.5;

  return (
    <View style={styles.wrap}>
      <AnimatedView style={[styles.outerGlow, { opacity: glowOpacity, transform: [{ scale: pulseScale }] }]} />
      <AnimatedView style={[styles.orb, { transform: [{ scale }] }]}>
        <AnimatedView style={[styles.orbits, { transform: [{ rotateZ }] }]}>
          <Svg width="260" height="260" viewBox="0 0 260 260">
            <Defs>
              <RadialGradient id="core" cx="50%" cy="50%" r="50%">
                <Stop offset="0%" stopColor="#FFFFFF" stopOpacity="1" />
                <Stop offset="15%" stopColor={colors.ivory} stopOpacity="0.96" />
                <Stop offset="50%" stopColor="#AEBCCA" stopOpacity="0.28" />
                <Stop offset="100%" stopColor="#0A0D10" stopOpacity="0" />
              </RadialGradient>
            </Defs>
            <Circle cx="130" cy="130" r="102" fill="transparent" stroke={colors.ivory} strokeOpacity="0.12" strokeWidth="1" />
            <Circle cx="130" cy="130" r="70" fill="transparent" stroke={colors.ivory} strokeOpacity="0.18" strokeWidth="1" />
            <G opacity="0.9">
              <Ellipse cx="130" cy="130" rx="112" ry="38" stroke={colors.ivory} strokeOpacity="0.42" strokeWidth="1.1" fill="transparent" />
              <Ellipse cx="130" cy="130" rx="112" ry="38" stroke={colors.ivory} strokeOpacity="0.24" strokeWidth="1" fill="transparent" transform="rotate(58 130 130)" />
              <Ellipse cx="130" cy="130" rx="112" ry="38" stroke={colors.ivory} strokeOpacity="0.22" strokeWidth="1" fill="transparent" transform="rotate(-54 130 130)" />
            </G>
            {Array.from({ length: 10 }, (_, index) => {
              const angle = (Math.PI * 2 * index) / 10;
              const x = 130 + Math.cos(angle) * (76 + (index % 3) * 16);
              const y = 130 + Math.sin(angle) * (76 + (index % 3) * 16);
              return <Circle key={index} cx={x} cy={y} r={index % 4 === 0 ? 2.1 : 1.25} fill={colors.ivory} opacity={0.54} />;
            })}
            <Line x1="130" y1="47" x2="130" y2="213" stroke={colors.ivory} strokeOpacity="0.08" />
            <Line x1="47" y1="130" x2="213" y2="130" stroke={colors.ivory} strokeOpacity="0.08" />
            <Circle cx="130" cy="130" r="43" fill="url(#core)" />
            <Circle cx="130" cy="130" r={state === "speaking" ? 8 : 6} fill="#FFFFFF" opacity="0.95" />
          </Svg>
        </AnimatedView>
      </AnimatedView>
    </View>
  );
});

const styles = StyleSheet.create({
  wrap: {
    alignItems: "center",
    height: 310,
    justifyContent: "center",
    width: 310
  },
  outerGlow: {
    backgroundColor: "rgba(239,246,255,0.13)",
    borderRadius: 150,
    height: 300,
    position: "absolute",
    width: 300
  },
  orb: {
    alignItems: "center",
    height: 260,
    justifyContent: "center",
    width: 260
  },
  orbits: {
    height: 260,
    width: 260
  }
});
