import { Ionicons } from "@expo/vector-icons";
import { useEffect, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { validateProviderKeys } from "../lib/api";
import { getApiProviderKeys, markApiKeyOnboardingComplete, saveApiProviderKeys, type ApiProviderKeys } from "../lib/localStore";
import { colors } from "../theme/colors";

const emptyKeys: ApiProviderKeys = {
  openRouterKeys: "",
  groqKey: "",
  geminiKeys: ""
};

export function ApiKeysScreen() {
  const [keys, setKeys] = useState<ApiProviderKeys>(emptyKeys);
  const [isValidating, setIsValidating] = useState(false);
  const [status, setStatus] = useState("Saved only on this iPhone. Add multiple keys per provider with commas for rotation.");
  const [providerStatus, setProviderStatus] = useState<Record<string, string>>({});

  useEffect(() => {
    getApiProviderKeys().then(setKeys);
  }, []);

  async function save() {
    setIsValidating(true);
    setStatus("Validating providers...");
    setProviderStatus({});
    try {
      const result = await validateProviderKeys(keys);
      setProviderStatus({
        openRouter: result.providers.openRouter.message,
        groq: result.providers.groq.message,
        gemini: result.providers.gemini.message
      });
      if (!result.ok) {
        setStatus(result.message || "One or more providers failed validation.");
        return;
      }
      await saveApiProviderKeys(keys);
      await markApiKeyOnboardingComplete(true);
      setStatus("Saved. New requests will use these keys first.");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not validate keys. Check backend connection and try again.");
    } finally {
      setIsValidating(false);
    }
  }

  function update(field: keyof ApiProviderKeys, value: string) {
    setKeys((current) => ({ ...current, [field]: value }));
  }

  return (
    <View style={styles.screen}>
      <Text style={styles.title}>API Keys</Text>
      <Text style={styles.note}>Use comma-separated keys for OpenRouter, Groq, and Gemini rotation.</Text>

      <View style={styles.form}>
        <KeyField
          label="OpenRouter"
          placeholder="sk-or-v1-..., sk-or-v1-..."
          value={keys.openRouterKeys}
          onChangeText={(value) => update("openRouterKeys", value)}
        />
        <KeyField
          label="Groq Whisper"
          placeholder="gsk_..., gsk_..."
          value={keys.groqKey}
          onChangeText={(value) => update("groqKey", value)}
        />
        <KeyField
          label="Gemini Voice"
          placeholder="AIza..., AIza..."
          value={keys.geminiKeys}
          onChangeText={(value) => update("geminiKeys", value)}
        />
      </View>

      <Pressable disabled={isValidating} onPress={save} style={[styles.button, isValidating && styles.buttonDisabled]}>
        {isValidating ? <ActivityIndicator color="#FFFFFF" /> : <Ionicons name="lock-closed-outline" size={18} color="#FFFFFF" />}
        <Text style={styles.buttonText}>{isValidating ? "Validating" : "Validate and save"}</Text>
      </Pressable>
      <Text style={styles.status}>{status}</Text>
      {Object.entries(providerStatus).map(([provider, message]) => (
        <Text key={provider} style={styles.providerStatus}>
          {provider}: {message}
        </Text>
      ))}
    </View>
  );
}

function KeyField({
  label,
  placeholder,
  value,
  onChangeText
}: {
  label: string;
  placeholder: string;
  value: string;
  onChangeText: (value: string) => void;
}) {
  return (
    <View style={styles.field}>
      <Text style={styles.label}>{label}</Text>
      <TextInput
        autoCapitalize="none"
        autoCorrect={false}
        multiline
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={colors.muted}
        secureTextEntry={false}
        style={styles.input}
        value={value}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    backgroundColor: colors.background,
    flex: 1,
    padding: 22,
    paddingTop: 70
  },
  title: {
    color: colors.text,
    fontSize: 17,
    fontWeight: "800",
    marginBottom: 8,
    textAlign: "center"
  },
  note: {
    color: colors.muted,
    fontSize: 13,
    lineHeight: 19,
    marginBottom: 20,
    textAlign: "center"
  },
  form: {
    gap: 14
  },
  field: {
    gap: 8
  },
  label: {
    color: colors.text,
    fontSize: 13,
    fontWeight: "800"
  },
  input: {
    backgroundColor: colors.surface,
    borderColor: colors.hairline,
    borderRadius: 16,
    borderWidth: 1,
    color: colors.text,
    fontSize: 13,
    minHeight: 74,
    padding: 13,
    textAlignVertical: "top"
  },
  button: {
    alignItems: "center",
    backgroundColor: colors.blue,
    borderRadius: 16,
    flexDirection: "row",
    gap: 8,
    justifyContent: "center",
    marginTop: 18,
    paddingVertical: 15
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
    color: colors.soft,
    fontSize: 13,
    lineHeight: 19,
    marginTop: 14,
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
