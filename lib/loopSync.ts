import type { Loop } from "@/context/LoopContext";

// Standalone aesthetic prototype — no backend wired.
// These stubs keep the import chain alive without the workspace package.

export async function syncLoopToServer(
  _loop: Loop,
  _masterDurationMs: number,
  _beatsPerLoop: number,
  _detectedBpm: number | null | undefined
): Promise<void> {
  // no-op — standalone prototype
}

export async function deleteLoopFromServer(_id: string): Promise<void> {
  // no-op — standalone prototype
}
