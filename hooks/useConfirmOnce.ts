import { useCallback, useRef } from "react";

/**
 * Single-flight commit helper — 300ms debounce + in-flight flag.
 * Prevents double-tap duplicate commits on confirm/discard/keep buttons.
 * (G19 fix across TrimEditor, EnvelopeDock, TimelineBrowser.)
 *
 * Usage:
 *   const confirmOnce = useConfirmOnce(() => { ... });
 *   <Button onPress={confirmOnce} />
 */
export function useConfirmOnce<T extends (...args: never[]) => void>(
  cb: T,
  delayMs = 300
): T {
  const inFlight = useRef(false);
  const wrapped = useCallback(
    (...args: Parameters<T>) => {
      if (inFlight.current) return;
      inFlight.current = true;
      cb(...args);
      setTimeout(() => {
        inFlight.current = false;
      }, delayMs);
    },
    [cb, delayMs]
  );
  return wrapped as T;
}
