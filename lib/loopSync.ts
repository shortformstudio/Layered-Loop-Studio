import type { Loop } from "@/context/LoopContext";

export type SyncState = "pending" | "synced" | "failed";

/**
 * Sync a loop to the API server in standalone mode.
 */
export async function syncLoopToServer(
  loop: Loop,
  masterDurationMs: number,
  beatsPerLoop: number,
  detectedBpm: number | null | undefined
): Promise<SyncState> {
  // In standalone Aesthetic, loop data is stored in local AsyncStorage
  return "synced";
}

export async function deleteLoopFromServer(id: string): Promise<void> {
  // In standalone Aesthetic, delete is handled in local AsyncStorage
}
