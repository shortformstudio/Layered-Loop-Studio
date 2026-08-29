import { Stack } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import React, { useEffect } from "react";
import { Platform } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { ErrorBoundary } from "@/components/ErrorBoundary";
import { LoopProvider } from "@/context/LoopContext";
import { configureApiClient } from "@/constants/api";

configureApiClient();

// Typography: Avenir Next Ultra Thin is a built-in iOS system font —
// no font loading step needed. Android falls back to sans-serif-thin.

SplashScreen.preventAutoHideAsync();

export default function RootLayout() {
  useEffect(() => {
    SplashScreen.hideAsync();
  }, []);

  useEffect(() => {
    if (Platform.OS !== "web") return;
    const style = document.createElement("style");
    style.textContent = `
      *:focus-visible { outline: 2px solid #D4A84B; outline-offset: 2px; }
      *:focus:not(:focus-visible) { outline: none; }
    `;
    document.head.appendChild(style);
    return () => { style.remove(); };
  }, []);

  return (
    <SafeAreaProvider>
      <ErrorBoundary>
        <LoopProvider>
          <GestureHandlerRootView style={{ flex: 1 }}>
            <Stack screenOptions={{ headerShown: false }}>
              <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
            </Stack>
          </GestureHandlerRootView>
        </LoopProvider>
      </ErrorBoundary>
    </SafeAreaProvider>
  );
}
