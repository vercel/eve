import type { ExpoConfig } from "expo/config";
import { existsSync } from "node:fs";
const googleServicesFile =
  process.env.GOOGLE_SERVICES_JSON ||
  (existsSync("./google-services.json") ? "./google-services.json" : undefined);
const projectId = process.env.EXPO_PUBLIC_EAS_PROJECT_ID;
const config: ExpoConfig = {
  runtimeVersion: { policy: "sdkVersion" },
  icon: "./assets/icon.png",
  name: process.env.EXPO_APP_NAME || "eve Start",
  slug: process.env.EXPO_APP_SLUG || "eve-go",
  scheme: "eve-go",
  version: "0.1.0",
  orientation: "portrait",
  userInterfaceStyle: "dark",
  ios: {
    bundleIdentifier: process.env.EXPO_APP_ID || "com.example.evechat",
    supportsTablet: true,
    infoPlist: { NSAppTransportSecurity: { NSAllowsLocalNetworking: true } },
  },
  android: {
    package: process.env.EXPO_APP_ID || "com.example.evechat",
    googleServicesFile,
  },
  plugins: [
    "expo-font",
    ["expo-build-properties", { android: { usesCleartextTraffic: true } }],
    "expo-secure-store",
    "expo-notifications",
  ],
  extra: {},
};
// Only an Expo/EAS project you own enables updates and native push; none is baked in.
if (projectId) {
  config.updates = { url: "https://u.expo.dev/" + projectId };
  config.extra!.eas = { projectId };
}
if (process.env.EXPO_OWNER) config.owner = process.env.EXPO_OWNER;
export default config;
