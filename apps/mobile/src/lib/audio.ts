import { Audio, InterruptionModeAndroid, InterruptionModeIOS } from "expo-av";
import * as FileSystem from "expo-file-system";
import * as Speech from "expo-speech";

let currentSound: Audio.Sound | null = null;
let preferredFallbackVoice: string | null | undefined;

export async function preparePlaybackAudioMode() {
  await Audio.setAudioModeAsync({
    allowsRecordingIOS: false,
    interruptionModeIOS: InterruptionModeIOS.DoNotMix,
    playsInSilentModeIOS: true,
    staysActiveInBackground: false,
    interruptionModeAndroid: InterruptionModeAndroid.DoNotMix,
    shouldDuckAndroid: false,
    playThroughEarpieceAndroid: false
  });
}

function base64ToBytes(base64: string) {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const clean = base64.replace(/=+$/, "");
  const bytes: number[] = [];

  for (let index = 0; index < clean.length; index += 4) {
    const chunk =
      (chars.indexOf(clean[index]) << 18) |
      (chars.indexOf(clean[index + 1]) << 12) |
      ((chars.indexOf(clean[index + 2]) || 0) << 6) |
      (chars.indexOf(clean[index + 3]) || 0);

    bytes.push((chunk >> 16) & 255);
    if (clean[index + 2]) bytes.push((chunk >> 8) & 255);
    if (clean[index + 3]) bytes.push(chunk & 255);
  }

  return bytes;
}

function bytesToBase64(bytes: number[]) {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let output = "";

  for (let index = 0; index < bytes.length; index += 3) {
    const a = bytes[index];
    const b = bytes[index + 1] ?? 0;
    const c = bytes[index + 2] ?? 0;
    const triplet = (a << 16) | (b << 8) | c;
    output += chars[(triplet >> 18) & 63];
    output += chars[(triplet >> 12) & 63];
    output += index + 1 < bytes.length ? chars[(triplet >> 6) & 63] : "=";
    output += index + 2 < bytes.length ? chars[triplet & 63] : "=";
  }

  return output;
}

function wavHeader(dataLength: number, sampleRate = 24000, channels = 1, bitsPerSample = 16) {
  const byteRate = (sampleRate * channels * bitsPerSample) / 8;
  const blockAlign = (channels * bitsPerSample) / 8;
  const buffer = new ArrayBuffer(44);
  const view = new DataView(buffer);
  const write = (offset: number, value: string) => {
    for (let index = 0; index < value.length; index += 1) view.setUint8(offset + index, value.charCodeAt(index));
  };

  write(0, "RIFF");
  view.setUint32(4, 36 + dataLength, true);
  write(8, "WAVE");
  write(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);
  write(36, "data");
  view.setUint32(40, dataLength, true);

  return Array.from(new Uint8Array(buffer));
}

function isWavAudio(bytes: number[]) {
  return (
    bytes.length > 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x41 &&
    bytes[10] === 0x56 &&
    bytes[11] === 0x45
  );
}

export async function playPcmBase64(audioBase64: string) {
  await stopAgentAudio();
  const audioBytes = base64ToBytes(audioBase64);
  const wavBytes = isWavAudio(audioBytes) ? audioBytes : [...wavHeader(audioBytes.length), ...audioBytes];
  const uri = `${FileSystem.cacheDirectory ?? ""}aura-agent-voice.wav`;
  await FileSystem.writeAsStringAsync(uri, bytesToBase64(wavBytes), {
    encoding: FileSystem.EncodingType.Base64
  });

  await preparePlaybackAudioMode();

  const sound = new Audio.Sound();
  currentSound = sound;
  await sound.loadAsync({ uri }, { shouldPlay: true, volume: 1 });
  await new Promise<void>((resolve) => {
    let resolved = false;
    const finish = () => {
      if (resolved) return;
      resolved = true;
      if (currentSound === sound) currentSound = null;
      sound.unloadAsync().catch(() => undefined);
      resolve();
    };

    sound.setOnPlaybackStatusUpdate((status) => {
      if (!status.isLoaded) {
        finish();
        return;
      }
      if (status.didJustFinish) finish();
    });
  });
}

export async function playAgentVoice(voice: { audioBase64: string; mimeType?: string | null }) {
  const mimeType = voice.mimeType?.toLowerCase() ?? "";
  if (!mimeType.includes("wav")) {
    await playPcmBase64(voice.audioBase64);
    return;
  }

  await stopAgentAudio();
  const uri = `${FileSystem.cacheDirectory ?? ""}aura-agent-voice.wav`;
  await FileSystem.writeAsStringAsync(uri, voice.audioBase64, {
    encoding: FileSystem.EncodingType.Base64
  });

  await preparePlaybackAudioMode();

  const sound = new Audio.Sound();
  currentSound = sound;
  await sound.loadAsync({ uri }, { shouldPlay: true, volume: 1 });
  await new Promise<void>((resolve) => {
    let resolved = false;
    const finish = () => {
      if (resolved) return;
      resolved = true;
      if (currentSound === sound) currentSound = null;
      sound.unloadAsync().catch(() => undefined);
      resolve();
    };

    sound.setOnPlaybackStatusUpdate((status) => {
      if (!status.isLoaded) {
        finish();
        return;
      }
      if (status.didJustFinish) finish();
    });
  });
}

function estimateSpeechTimeoutMs(text: string) {
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  return Math.min(30000, Math.max(5000, words * 520 + 2500));
}

async function getPreferredFallbackVoice() {
  if (preferredFallbackVoice !== undefined) return preferredFallbackVoice;
  try {
    const voices = await Speech.getAvailableVoicesAsync();
    const preferredLanguages = ["en-IN", "en-US", "hi-IN"];
    const selected =
      preferredLanguages
        .map((language) => voices.find((voice) => voice.language?.toLowerCase() === language.toLowerCase()))
        .find(Boolean) ??
      voices.find((voice) => voice.language?.toLowerCase().startsWith("en")) ??
      voices.find((voice) => voice.language?.toLowerCase().startsWith("hi"));

    preferredFallbackVoice = selected?.identifier ?? null;
    console.log("[AURA speech] fallback voice selected", {
      voice: selected?.identifier ?? null,
      language: selected?.language ?? null,
      name: selected?.name ?? null
    });
  } catch (error) {
    preferredFallbackVoice = null;
    console.warn("[AURA speech] fallback voice lookup failed", error instanceof Error ? error.message : error);
  }
  return preferredFallbackVoice;
}

export async function speakTextWithFailsafe(text: string, options: Speech.SpeechOptions = {}) {
  await preparePlaybackAudioMode();
  const voice = options.voice ?? (await getPreferredFallbackVoice()) ?? undefined;

  return new Promise<void>((resolve) => {
    let resolved = false;
    const timeout = setTimeout(() => {
      finish("timeout");
    }, estimateSpeechTimeoutMs(text));

    const finish = (reason: string) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timeout);
      console.log("[AURA speech] finished", { reason, characters: text.length });
      resolve();
    };

    Speech.stop();
    setTimeout(() => {
      Speech.speak(text, {
      language: options.language ?? "en-IN",
      pitch: 1.02,
      rate: 1.08,
      volume: 1,
      voice,
      ...options,
      onDone: () => {
        options.onDone?.();
        finish("done");
      },
      onStopped: () => {
        options.onStopped?.();
        finish("stopped");
      },
      onError: (error) => {
        options.onError?.(error);
        finish("error");
      }
    });
    }, 120);
  });
}

export async function stopAgentAudio() {
  const sound = currentSound;
  currentSound = null;
  if (!sound) return;
  try {
    await sound.stopAsync();
  } catch {
    // Already stopped.
  }
  try {
    await sound.unloadAsync();
  } catch {
    // Already unloaded.
  }
}
