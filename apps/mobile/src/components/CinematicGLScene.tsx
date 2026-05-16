import { memo, useCallback, useEffect, useRef, type ComponentType } from "react";
import { AppState, StyleSheet, View } from "react-native";
import type { VoiceState } from "./IntelligenceOrb";

declare const require: (name: string) => { GLView?: ComponentType<any> };

type Quality = "low" | "balanced" | "cinematic";

const QUALITY_SCALE: Record<Quality, number> = {
  low: 0.74,
  balanced: 1,
  cinematic: 1.24
};

const VERTEX_SHADER = `
  attribute vec2 aPosition;
  varying vec2 vUv;

  void main() {
    vUv = aPosition * 0.5 + 0.5;
    gl_Position = vec4(aPosition, 0.0, 1.0);
  }
`;

const FRAGMENT_SHADER = `
  precision highp float;

  uniform float uTime;
  uniform float uEnergy;
  uniform float uQuality;
  uniform vec2 uResolution;
  varying vec2 vUv;

  float hash(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
  }

  float noise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    float a = hash(i);
    float b = hash(i + vec2(1.0, 0.0));
    float c = hash(i + vec2(0.0, 1.0));
    float d = hash(i + vec2(1.0, 1.0));
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(a, b, u.x) + (c - a) * u.y * (1.0 - u.x) + (d - b) * u.x * u.y;
  }

  float fbm(vec2 p) {
    float value = 0.0;
    float amp = 0.5;
    for (int i = 0; i < 5; i++) {
      value += noise(p) * amp;
      p = mat2(1.62, 1.12, -1.12, 1.62) * p + 0.19;
      amp *= 0.52;
    }
    return value;
  }

  float star(vec2 uv, vec2 p, float size, float sparkle) {
    float d = length(uv - p);
    float core = smoothstep(size, 0.0, d);
    float ray = smoothstep(size * 7.0, 0.0, abs(uv.x - p.x)) * smoothstep(size * 0.9, 0.0, abs(uv.y - p.y));
    ray += smoothstep(size * 7.0, 0.0, abs(uv.y - p.y)) * smoothstep(size * 0.9, 0.0, abs(uv.x - p.x));
    return core + ray * 0.12 * sparkle;
  }

  void main() {
    vec2 uv = vUv;
    vec2 p = (uv - 0.5) * vec2(uResolution.x / uResolution.y, 1.0);
    float t = uTime;
    float energy = clamp(uEnergy, 0.0, 1.0);

    vec3 bg = vec3(0.985, 0.992, 1.0);
    vec3 color = bg;

    float vignette = smoothstep(0.92, 0.14, length(p));
    color -= vec3(0.012, 0.018, 0.028) * (1.0 - vignette);

    float stars = 0.0;
    for (int i = 0; i < 34; i++) {
      float fi = float(i);
      vec2 sp = vec2(hash(vec2(fi, 2.1)), hash(vec2(fi, 8.7)));
      sp = (sp - 0.5) * vec2(1.26, 1.05);
      float drift = sin(t * (0.08 + hash(sp) * 0.08) + fi) * 0.014;
      sp += vec2(drift, -drift * 0.6);
      float pulse = 0.42 + 0.58 * sin(t * (0.42 + hash(sp + 3.0)) + fi * 1.7);
      stars += star(p, sp, 0.0028 + hash(sp + 9.0) * 0.0036, pulse);
    }
    color += vec3(0.15, 0.34, 1.0) * stars * 0.16 * uQuality;

    float angle = atan(p.y, p.x);
    float radius = length(p);
    float field = fbm(p * 3.1 + vec2(t * 0.045, -t * 0.035));
    float shellA = 0.255 + sin(angle * 5.0 + t * 0.72) * 0.025 + (field - 0.5) * 0.055 + energy * 0.022;
    float shellB = 0.352 + sin(angle * 8.0 - t * 0.54) * 0.032 + (fbm(p * 4.7 - t * 0.035) - 0.5) * 0.07;

    float core = smoothstep(shellA, 0.0, radius);
    float aura = smoothstep(shellB, shellA * 0.64, radius);
    float veil = smoothstep(shellB + 0.055, shellB - 0.06, radius) * (0.45 + field * 0.55);
    float rim = smoothstep(0.018, 0.0, abs(radius - shellB)) * (0.42 + energy * 0.55);
    float innerRim = smoothstep(0.014, 0.0, abs(radius - shellA)) * 0.35;

    vec2 swirlUv = vec2(radius * 4.8, angle * 1.7 + t * 0.32);
    float swirl = smoothstep(0.48, 0.86, fbm(swirlUv)) * aura;

    vec3 paleBlue = vec3(0.72, 0.86, 1.0);
    vec3 liquidBlue = vec3(0.08, 0.29, 1.0);
    vec3 deepBlue = vec3(0.02, 0.12, 0.92);
    vec3 ivory = vec3(1.0, 0.985, 0.92);

    color = mix(color, paleBlue, veil * 0.48);
    color = mix(color, liquidBlue, aura * 0.58);
    color = mix(color, deepBlue, core * 0.44);
    color += paleBlue * rim * 0.46;
    color += ivory * innerRim * 0.22;
    color += vec3(0.4, 0.64, 1.0) * swirl * 0.26;

    float centerGlow = smoothstep(0.06 + energy * 0.035, 0.0, radius);
    color += ivory * centerGlow * (0.56 + energy * 0.8);
    color += vec3(0.1, 0.36, 1.0) * smoothstep(0.5, 0.0, radius) * 0.1;

    float breath = 0.94 + sin(t * 1.45) * 0.035 + energy * 0.08;
    color *= breath;

    gl_FragColor = vec4(color, 1.0);
  }
`;

function compileShader(gl: any, type: number, source: string) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    throw new Error(gl.getShaderInfoLog(shader) || "Shader compile failed");
  }
  return shader;
}

function createProgram(gl: any) {
  const program = gl.createProgram();
  gl.attachShader(program, compileShader(gl, gl.VERTEX_SHADER, VERTEX_SHADER));
  gl.attachShader(program, compileShader(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    throw new Error(gl.getProgramInfoLog(program) || "Shader link failed");
  }
  return program;
}

export const CinematicGLScene = memo(function CinematicGLScene({
  state,
  quality = "cinematic",
  onReady,
  onError
}: {
  state: VoiceState;
  quality?: Quality;
  onReady?: () => void;
  onError?: () => void;
}) {
  const stateRef = useRef(state);
  const frameRef = useRef<number | null>(null);
  const activeRef = useRef(true);
  const readyRef = useRef(false);

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  useEffect(() => {
    const sub = AppState.addEventListener("change", (nextState) => {
      activeRef.current = nextState === "active";
    });
    return () => sub.remove();
  }, []);

  const onContextCreate = useCallback(
    async (gl: any) => {
      try {
        const program = createProgram(gl);
        const buffer = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);

        const position = gl.getAttribLocation(program, "aPosition");
        const uTime = gl.getUniformLocation(program, "uTime");
        const uEnergy = gl.getUniformLocation(program, "uEnergy");
        const uQuality = gl.getUniformLocation(program, "uQuality");
        const uResolution = gl.getUniformLocation(program, "uResolution");

        gl.useProgram(program);
        gl.enableVertexAttribArray(position);
        gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
        gl.disable(gl.DEPTH_TEST);

        let energy = 0.16;
        const start = Date.now();

        const render = () => {
          if (!activeRef.current) {
            frameRef.current = requestAnimationFrame(render);
            return;
          }

          const target =
            stateRef.current === "listening"
              ? 0.62
              : stateRef.current === "thinking"
                ? 0.48
                : stateRef.current === "speaking"
                  ? 0.74
                  : stateRef.current === "error"
                    ? 0.28
                    : 0.18;
          energy += (target - energy) * 0.055;

          gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
          gl.clearColor(0.985, 0.992, 1, 1);
          gl.clear(gl.COLOR_BUFFER_BIT);
          gl.useProgram(program);
          gl.uniform1f(uTime, (Date.now() - start) / 1000);
          gl.uniform1f(uEnergy, energy);
          gl.uniform1f(uQuality, QUALITY_SCALE[quality]);
          gl.uniform2f(uResolution, gl.drawingBufferWidth, gl.drawingBufferHeight);
          gl.drawArrays(gl.TRIANGLES, 0, 6);
          gl.endFrameEXP();

          if (!readyRef.current) {
            readyRef.current = true;
            onReady?.();
          }

          frameRef.current = requestAnimationFrame(render);
        };

        render();
      } catch {
        onError?.();
      }
    },
    [onError, onReady, quality]
  );

  useEffect(
    () => () => {
      if (frameRef.current) cancelAnimationFrame(frameRef.current);
    },
    []
  );

  let GLView: ComponentType<any> | null = null;
  try {
    GLView = require("expo-gl").GLView ?? null;
  } catch {
    GLView = null;
  }

  if (!GLView) {
    return <View pointerEvents="none" style={StyleSheet.absoluteFill} />;
  }

  return <GLView pointerEvents="none" onContextCreate={onContextCreate} style={StyleSheet.absoluteFill} />;
});
