import { Ionicons } from "@expo/vector-icons";
import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Animated, KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { AuraWordmark } from "../components/AuraWordmark";
import { validateProviderKeys } from "../lib/api";
import { markApiKeyOnboardingComplete, saveApiProviderKeys, type ApiProviderKeys } from "../lib/localStore";
import { colors } from "../theme/colors";

const emptyKeys: ApiProviderKeys = {
  openRouterKeys: "",
  groqKey: "",
  geminiKeys: ""
};

export function ApiKeyOnboardingScreen({ onComplete }: { onComplete: () => void }) {
  const [keys, setKeys] = useState<ApiProviderKeys>(emptyKeys);
  const [isValidating, setIsValidating] = useState(false);
  const [status, setStatus] = useState("Bring your own OpenRouter, Groq, and Gemini keys. Add as many as you can, separated by commas, so AURA can rotate if one fails.");
  const [providerStatus, setProviderStatus] = useState<Record<string, string>>({});
  const intro = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.timing(intro, {
      toValue: 1,
      duration: 720,
      useNativeDriver: true
    }).start();
  }, [intro]);

  function update(field: keyof ApiProviderKeys, value: string) {
    setKeys((current) => ({ ...current, [field]: value }));
  }

  async function validateAndContinue() {
    const normalized = {
      openRouterKeys: keys.openRouterKeys.trim(),
      groqKey: keys.groqKey.trim(),
      geminiKeys: keys.geminiKeys.trim()
    };

    if (!normalized.openRouterKeys || !normalized.groqKey || !normalized.geminiKeys) {
      setStatus("Add all three provider keys to unlock AURA.");
      return;
    }

    setIsValidating(true);
    setStatus("Validating providers...");
    setProviderStatus({});
    try {
      const result = await validateProviderKeys(normalized);
      setProviderStatus({
        openRouter: result.providers.openRouter.message,
        groq: result.providers.groq.message,
        gemini: result.providers.gemini.message
      });

      if (!result.ok) {
        setStatus(result.message || "One or more providers failed validation.");
        return;
      }

      await saveApiProviderKeys(normalized);
      await markApiKeyOnboardingComplete(true);
      setStatus("Keys validated. Starting AURA...");
      onComplete();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not validate keys. Check backend connection and try again.");
    } finally {
      setIsValidating(false);
    }
  }

  return (
    <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={styles.screen}>
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <Animated.View
          style={{
            opacity: intro,
            transform: [
              {
                translateY: intro.interpolate({
                  inputRange: [0, 1],
                  outputRange: [12, 0]
                })
              }
            ]
          }}
        >
          <AuraWordmark size="large" />
        </Animated.View>
        <View style={styles.orbMark}>
          <View style={styles.orbInner} />
        </View>
        <Text style={styles.title}>Bring AURA online</Text>
        <Text style={styles.copy}>
          Add your keys once. AURA uses them to hear you, think with context, and speak back.
        </Text>

        <View style={styles.form}>
          <KeyField
            label="Soul"
            hint="OpenRouter for AURA's mind"
            placeholder="sk-or-v1-..., sk-or-v1-..."
            value={keys.openRouterKeys}
            onChangeText={(value) => update("openRouterKeys", value)}
          />
          <KeyField
            label="Hearing"
            hint="Groq Whisper for your voice"
            placeholder="gsk_..., gsk_..."
            value={keys.groqKey}
            onChangeText={(value) => update("groqKey", value)}
          />
          <KeyField
            label="Voice"
            hint="Gemini for AURA's voice and memory embeddings"
            placeholder="AIza..., AIza..."
            value={keys.geminiKeys}
            onChangeText={(value) => update("geminiKeys", value)}
          />
        </View>

        <Pressable disabled={isValidating} onPress={validateAndContinue} style={[styles.button, isValidating && styles.buttonDisabled]}>
          {isValidating ? <ActivityIndicator color="#FFFFFF" /> : <Ionicons name="shield-checkmark-outline" size={18} color="#FFFFFF" />}
          <Text style={styles.buttonText}>{isValidating ? "Validating" : "Validate and start"}</Text>
        </Pressable>

        <Text style={styles.status}>{status}</Text>
        {Object.entries(providerStatus).map(([provider, message]) => (
          <Text key={provider} style={styles.providerStatus}>
            {provider}: {message}
          </Text>
        ))}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

function KeyField({
  label,
  hint,
  placeholder,
  value,
  onChangeText
}: {
  label: string;
  hint: string;
  placeholder: string;
  value: string;
  onChangeText: (value: string) => void;
}) {
  return (
    <View style={styles.field}>
      <Text style={styles.label}>{label}</Text>
      <Text style={styles.hint}>{hint}</Text>
      <TextInput
        autoCapitalize="none"
        autoCorrect={false}
        multiline
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={colors.soft}
        style={styles.input}
        value={value}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    backgroundColor: colors.background,
    flex: 1
  },
  content: {
    padding: 24,
    paddingBottom: 34,
    paddingTop: 78
  },
  orbMark: {
    alignItems: "center",
    alignSelf: "center",
    backgroundColor: "rgba(36,91,255,0.08)",
    borderRadius: 34,
    height: 68,
    justifyContent: "center",
    marginTop: 34,
    width: 68
  },
  orbInner: {
    backgroundColor: colors.blue,
    borderRadius: 18,
    height: 36,
    shadowColor: colors.blue,
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.34,
    shadowRadius: 18,
    width: 36
  },
  title: {
    color: colors.text,
    fontSize: 23,
    fontWeight: "800",
    marginTop: 24,
    textAlign: "center"
  },
  copy: {
    color: colors.muted,
    fontSize: 14,
    fontWeight: "600",
    lineHeight: 20,
    marginTop: 10,
    textAlign: "center"
  },
  form: {
    gap: 13,
    marginTop: 28
  },
  field: {
    gap: 7
  },
  label: {
    color: colors.text,
    fontSize: 13,
    fontWeight: "800"
  },
  hint: {
    color: colors.muted,
    fontSize: 12,
    fontWeight: "600",
    marginTop: -4
  },
  input: {
    backgroundColor: "rgba(255,255,255,0.78)",
    borderColor: colors.hairline,
    borderRadius: 18,
    borderWidth: 1,
    color: colors.text,
    fontSize: 13,
    minHeight: 72,
    padding: 13,
    textAlignVertical: "top"
  },
  button: {
    alignItems: "center",
    backgroundColor: colors.blue,
    borderRadius: 18,
    flexDirection: "row",
    gap: 9,
    justifyContent: "center",
    marginTop: 22,
    minHeight: 54
  },
  buttonDisabled: {
    opacity: 0.72
  },
  buttonText: {
    color: "#FFFFFF",
    fontSize: 15,
    fontWeight: "800"
  },
  status: {
    color: colors.muted,
    fontSize: 13,
    fontWeight: "600",
    lineHeight: 19,
    marginTop: 16,
    textAlign: "center"
  },
  providerStatus: {
    color: colors.soft,
    fontSize: 12,
    lineHeight: 18,
    marginTop: 5,
    textAlign: "center"
  }
});
