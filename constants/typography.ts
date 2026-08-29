import { Platform } from "react-native";

/**
 * Aesthetic typography — ultra-light editorial
 *
 * iOS:     Avenir Next (system font, always available)
 * Android: Best-match system equivalents
 */
export const font = {
  thin:   Platform.OS === "ios" ? "AvenirNext-UltraLight" : "sans-serif-thin",
  light:  Platform.OS === "ios" ? "AvenirNext-Regular"    : "sans-serif-light",
  medium: Platform.OS === "ios" ? "AvenirNext-Medium"     : "sans-serif-medium",
  demi:   Platform.OS === "ios" ? "AvenirNext-DemiBold"   : "sans-serif-medium",
  mono:   Platform.OS === "ios" ? "Menlo"                 : "monospace",
};

/** Generous tracking for editorial feel */
export const tracking = {
  wide:   2.0,
  normal: 0.6,
  tight: -0.2,
};
