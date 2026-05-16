import { memo, useEffect, useMemo, useRef } from "react";
import { Animated, Dimensions, StyleSheet, View } from "react-native";
import Svg, { Circle, Defs, Line, RadialGradient, Rect, Stop } from "react-native-svg";
import { colors } from "../theme/colors";

type Quality = "low" | "balanced" | "cinematic";

const QUALITY_COUNTS: Record<Quality, number> = {
  low: 54,
  balanced: 96,
  cinematic: 150
};

function seededNoise(seed: number) {
  const x = Math.sin(seed * 999) * 10000;
  return x - Math.floor(x);
}

export const SpaceBackground = memo(function SpaceBackground({ quality = "balanced", dimmed = false }: { quality?: Quality; dimmed?: boolean }) {
  const drift = useRef(new Animated.Value(0)).current;
  const { width, height } = Dimensions.get("window");
  const starCount = QUALITY_COUNTS[quality];

  const stars = useMemo(
    () =>
      Array.from({ length: starCount }, (_, index) => {
        const x = seededNoise(index + 4) * width;
        const y = seededNoise(index + 91) * height;
        const radius = 0.45 + seededNoise(index + 17) * (quality === "cinematic" ? 1.35 : 1);
        const opacity = 0.2 + seededNoise(index + 31) * 0.75;
        return { x, y, radius, opacity };
      }),
    [height, quality, starCount, width]
  );

  const links = useMemo(
    () =>
      stars
        .filter((_, index) => index % 13 === 0)
        .slice(0, quality === "low" ? 4 : quality === "balanced" ? 8 : 12)
        .map((star, index) => ({ from: star, to: stars[(index * 17 + 9) % stars.length] })),
    [quality, stars]
  );

  useEffect(() => {
    const animation = Animated.loop(
      Animated.sequence([
        Animated.timing(drift, { toValue: 1, duration: 15000, useNativeDriver: true }),
        Animated.timing(drift, { toValue: 0, duration: 15000, useNativeDriver: true })
      ])
    );
    animation.start();
    return () => animation.stop();
  }, [drift]);

  const translateY = drift.interpolate({ inputRange: [0, 1], outputRange: [0, -18] });
  const opacity = dimmed ? 0.38 : 1;

  return (
    <View pointerEvents="none" style={StyleSheet.absoluteFill}>
      <Svg width="100%" height="100%" style={StyleSheet.absoluteFill}>
        <Defs>
          <RadialGradient id="spaceGlow" cx="50%" cy="38%" r="72%">
            <Stop offset="0%" stopColor="#26303A" stopOpacity="0.38" />
            <Stop offset="42%" stopColor="#090A0B" stopOpacity="0.92" />
            <Stop offset="100%" stopColor="#000000" stopOpacity="1" />
          </RadialGradient>
        </Defs>
        <Rect width="100%" height="100%" fill="url(#spaceGlow)" />
      </Svg>
      <Animated.View style={[StyleSheet.absoluteFill, { opacity, transform: [{ translateY }] }]}>
        <Svg width="100%" height="110%">
          {links.map((link, index) => (
            <Line
              key={`link-${index}`}
              x1={link.from.x}
              y1={link.from.y}
              x2={link.to.x}
              y2={link.to.y}
              stroke={colors.ivory}
              strokeOpacity={0.07}
              strokeWidth={0.7}
            />
          ))}
          {stars.map((star, index) => (
            <Circle key={`star-${index}`} cx={star.x} cy={star.y} r={star.radius} fill={colors.ivory} opacity={star.opacity} />
          ))}
        </Svg>
      </Animated.View>
      <View style={styles.vignette} />
    </View>
  );
});

const styles = StyleSheet.create({
  vignette: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(0,0,0,0.14)"
  }
});
