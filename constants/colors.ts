/**
 * Aesthetic colour system — Valkyrie glassmorphic
 *
 * Deep Void     #060d06   — background (green-black)
 * Glass         rgba(255,255,255,0.035) — card surfaces
 * Glass Edge    rgba(255,255,255,0.06) — borders
 *
 * Violet        #a78bfa   — primary accent
 * Cyan          #22d3ee   — secondary accent
 * Rose          #fb7185   — tertiary / record
 *
 * Text Primary  rgba(255,255,255,0.92)
 * Text Secondary rgba(255,255,255,0.5)
 */

const palette = {
  /* Surfaces */
  background:       "#060d06",
  card:             "rgba(255,255,255,0.035)",
  cardAlt:          "rgba(255,255,255,0.025)",
  muted:            "rgba(255,255,255,0.06)",
  border:           "rgba(255,255,255,0.08)",

  /* Text */
  foreground:       "rgba(255,255,255,0.92)",
  mutedForeground:  "rgba(255,255,255,0.5)",
  onDark:           "rgba(255,255,255,0.92)",

  /* Accents */
  primary:          "#a78bfa",
  primaryForeground:"#060d06",
  secondary:        "#22d3ee",
  secondaryForeground: "#060d06",
  accent:           "#fb7185",
  accentForeground: "#060d06",

  /* Recording states */
  armedYellow:      "#a78bfa",
  triggeredGreen:   "#22d3ee",
  recordRed:        "#fb7185",

  /* Waveform */
  waveActive:       "rgba(255,255,255,0.92)",
  waveInactive:     "rgba(255,255,255,0.08)",

  /* Overlays */
  overlay:          "rgba(6,13,6,0.88)",
  overlayLight:     "rgba(255,255,255,0.035)",
};

const colors = {
  light: palette,
  dark:  palette,
  radius: 20,
};

export default colors;
