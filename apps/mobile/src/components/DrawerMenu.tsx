import { Ionicons } from "@expo/vector-icons";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { colors } from "../theme/colors";

export type AppRoute = "home" | "journal" | "reminders" | "insights" | "you" | "settings" | "type";

const menuItems: Array<{ route: AppRoute; label: string; caption: string; icon: keyof typeof Ionicons.glyphMap }> = [
  { route: "journal", label: "Journal", caption: "Your thoughts & conversations", icon: "book-outline" },
  { route: "reminders", label: "Reminders", caption: "AURA will bring it back on time", icon: "notifications-outline" },
  { route: "insights", label: "Insights", caption: "Patterns & reflections", icon: "stats-chart-outline" },
  { route: "you", label: "You", caption: "Your profile & preferences", icon: "person-outline" },
  { route: "settings", label: "Settings", caption: "App settings & preferences", icon: "settings-outline" }
];

export function DrawerMenu({
  activeRoute,
  onNavigate,
  onClose
}: {
  activeRoute: AppRoute;
  onNavigate: (route: AppRoute) => void;
  onClose: () => void;
}) {
  return (
    <View style={[StyleSheet.absoluteFill, { zIndex: 100 }]}>
      <Pressable style={styles.scrim} onPress={onClose}>
        <View style={styles.closeButton}>
          <Ionicons name="close" size={26} color="rgba(28,28,30,0.72)" />
        </View>
      </Pressable>
      <View style={styles.drawer}>
        <View pointerEvents="none" style={styles.watermarkWrap}>
          <Text style={styles.watermark}>ΛURΛ</Text>
        </View>
        <View style={styles.brand}>
          <Text style={styles.logo}>ΛURΛ</Text>
          <Text style={styles.caption}>Your AI Life Journal</Text>
        </View>
        <View style={styles.list}>
          {menuItems.map((item, index) => {
            const active = item.route === activeRoute;
            return (
              <View key={item.route}>
                {index === 3 ? <View style={styles.divider} /> : null}
                <Pressable
                  onPress={() => onNavigate(item.route)}
                  style={[styles.item, active && styles.activeItem]}
                  accessibilityRole="button"
                  accessibilityLabel={item.label}
                >
                  <View style={styles.iconWrap}>
                    <Ionicons name={item.icon} size={22} color="rgba(28,28,30,0.62)" />
                  </View>
                  <View style={styles.itemCopy}>
                    <Text style={styles.itemText}>{item.label}</Text>
                    <Text style={styles.itemCaption}>{item.caption}</Text>
                  </View>
                  <Ionicons name="chevron-forward" size={18} color="rgba(28,28,30,0.34)" />
                </Pressable>
              </View>
            );
          })}
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  scrim: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(248,250,253,0.72)"
  },
  closeButton: {
    left: 22,
    padding: 8,
    position: "absolute",
    top: 22
  },
  drawer: {
    backgroundColor: "rgba(248,250,253,0.88)",
    borderColor: "rgba(28,28,30,0.055)",
    borderRadius: 34,
    borderWidth: 1,
    bottom: 30,
    shadowColor: "#667085",
    shadowOffset: { width: 0, height: 24 },
    shadowOpacity: 0.11,
    shadowRadius: 58,
    overflow: "hidden",
    paddingHorizontal: 28,
    paddingTop: 52,
    position: "absolute",
    right: 18,
    top: 58,
    width: "82%"
  },
  watermarkWrap: {
    bottom: "43%",
    left: 0,
    position: "absolute",
    right: 0,
  },
  watermark: {
    color: "rgba(28,28,30,0.026)",
    fontSize: 62,
    fontWeight: "200",
    letterSpacing: 20,
    paddingLeft: 20,
    textAlign: "center"
  },
  brand: {
    alignItems: "center",
    marginBottom: 40
  },
  logo: {
    color: "rgba(28,28,30,0.74)",
    fontSize: 22,
    fontWeight: "200",
    letterSpacing: 11,
    lineHeight: 26,
    paddingLeft: 11
  },
  caption: {
    color: "rgba(28,28,30,0.42)",
    fontSize: 12,
    fontWeight: "600",
    marginTop: 5
  },
  list: {
    gap: 10
  },
  divider: {
    backgroundColor: "rgba(28,28,30,0.07)",
    height: 1,
    marginBottom: 16,
    marginTop: 18
  },
  item: {
    alignItems: "center",
    borderRadius: 24,
    flexDirection: "row",
    gap: 18,
    minHeight: 72,
    paddingHorizontal: 10,
    paddingVertical: 4
  },
  activeItem: {
    backgroundColor: "rgba(28,28,30,0.035)"
  },
  iconWrap: {
    alignItems: "center",
    backgroundColor: "rgba(255,255,255,0.62)",
    borderColor: "rgba(28,28,30,0.045)",
    borderRadius: 20,
    borderWidth: 1,
    height: 44,
    justifyContent: "center",
    shadowColor: "#667085",
    shadowOffset: { width: 0, height: 10 },
    shadowOpacity: 0.05,
    shadowRadius: 18,
    width: 44
  },
  itemCopy: {
    flex: 1,
    gap: 4
  },
  itemText: {
    color: "rgba(7,18,41,0.9)",
    fontSize: 16,
    fontWeight: "700"
  },
  itemCaption: {
    color: "rgba(7,18,41,0.42)",
    fontSize: 13,
    fontWeight: "600"
  }
});
