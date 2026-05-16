import { Ionicons } from "@expo/vector-icons";
import { useState } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { saveSession, type LocalSession } from "../lib/localStore";
import { colors } from "../theme/colors";

export function AuthScreen({ onReady }: { onReady: (session: LocalSession) => void }) {
  const [email, setEmail] = useState("");

  async function continueAsGuest() {
    const session: LocalSession = { mode: "guest", userId: "guest-beta-user" };
    await saveSession(session);
    onReady(session);
  }

  async function continueWithEmail() {
    const trimmed = email.trim().toLowerCase();
    if (!trimmed) return;
    const session: LocalSession = { mode: "email", email: trimmed, userId: trimmed };
    await saveSession(session);
    onReady(session);
  }

  return (
    <View style={styles.screen}>
      <View style={styles.mark}>
        <Ionicons name="layers-outline" size={26} color={colors.ivory} />
      </View>
      <View style={styles.header}>
        <Text style={styles.kicker}>Second Brain AI</Text>
        <Text style={styles.title}>A private place for what your mind keeps repeating.</Text>
        <Text style={styles.subtitle}>Start in guest mode. Your captures work locally even before the cloud brain is connected.</Text>
      </View>
      <View style={styles.form}>
        <TextInput value={email} onChangeText={setEmail} placeholder="Email address for persistent memory" placeholderTextColor={colors.muted} keyboardType="email-address" autoCapitalize="none" style={styles.input} />
        <Pressable onPress={continueWithEmail} style={styles.primary}>
          <Ionicons name="mail" size={18} color={colors.background} />
          <Text style={styles.primaryText}>Continue</Text>
        </Pressable>
        <Pressable onPress={continueAsGuest} style={styles.secondary}>
          <Ionicons name="person-circle-outline" size={19} color={colors.text} />
          <Text style={styles.secondaryText}>Guest beta access</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    backgroundColor: colors.background,
    flex: 1,
    gap: 22,
    justifyContent: "center",
    padding: 24
  },
  mark: {
    alignItems: "center",
    backgroundColor: colors.panel,
    borderColor: colors.hairline,
    borderRadius: 8,
    borderWidth: 1,
    height: 58,
    justifyContent: "center",
    width: 58
  },
  header: {
    gap: 10
  },
  kicker: {
    color: colors.amber,
    fontSize: 13,
    fontWeight: "800",
    textTransform: "uppercase"
  },
  title: {
    color: colors.text,
    fontSize: 31,
    fontWeight: "800",
    lineHeight: 37
  },
  subtitle: {
    color: colors.soft,
    fontSize: 16,
    lineHeight: 23
  },
  form: {
    gap: 12
  },
  input: {
    backgroundColor: colors.panel,
    borderColor: colors.hairline,
    borderRadius: 8,
    borderWidth: 1,
    color: colors.text,
    fontSize: 16,
    minHeight: 52,
    paddingHorizontal: 14
  },
  primary: {
    alignItems: "center",
    backgroundColor: colors.ivory,
    borderRadius: 8,
    flexDirection: "row",
    gap: 8,
    justifyContent: "center",
    minHeight: 52
  },
  primaryText: {
    color: colors.ink,
    fontSize: 15,
    fontWeight: "800"
  },
  secondary: {
    alignItems: "center",
    backgroundColor: colors.panelElevated,
    borderColor: colors.hairline,
    borderRadius: 8,
    borderWidth: 1,
    flexDirection: "row",
    gap: 8,
    justifyContent: "center",
    minHeight: 52
  },
  secondaryText: {
    color: colors.text,
    fontSize: 15,
    fontWeight: "800"
  }
});
