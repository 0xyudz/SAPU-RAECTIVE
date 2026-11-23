"use client";

import { useEffect } from "react";

/**
 * Blocks tab close/reload while burner keys are the only copy of something valuable.
 *
 * The vault is a module-scoped `Map`: a reload destroys it, and there is no recovery
 * path because a burner address cannot be turned back into a key. The browser will
 * show its own generic "changes you made may not be saved" prompt; we cannot supply
 * custom text, so the wording here only documents *why* the guard is armed.
 *
 * This is deliberately not a nag: it is armed only while the loss would actually cost
 * something, which is when a key is held AND that burner is armed or funded. A tab
 * full of empty burners closes silently.
 */
export function useUnsavedKeyGuard(active: boolean): void {
  useEffect(() => {
    if (!active || typeof window === "undefined") return;

    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      // Modern browsers ignore custom text and show their own prompt; returning a
      // value is still required for older engines to trigger it at all.
      event.preventDefault();
      event.returnValue = "";
      return "";
    };

    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [active]);
}
