import Constants from "expo-constants";

export const API_PORT = 11969;

function resolveHost(): string {
  const hostUri = Constants.expoConfig?.hostUri;
  const host = hostUri?.split(":")[0];
  return host && host.length > 0 ? host : "127.0.0.1";
}

export function configureApiClient(): void {
  // Standalone aesthetic prototype — no backend wired
}
