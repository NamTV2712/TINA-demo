"use client";
import { useEffect, type RefObject } from "react";

/** A modal consumes Escape before the workbench uses it to navigate back. */
export function useMeetingDialogEscape(dialog: RefObject<HTMLDialogElement | null>, opened: boolean) {
  useEffect(() => {
    if (!opened) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || !dialog.current?.open) return;
      event.preventDefault();
      event.stopPropagation();
      dialog.current.close();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [dialog, opened]);
}
