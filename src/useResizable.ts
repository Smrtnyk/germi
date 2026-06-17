import { useCallback, useState, type PointerEvent as ReactPointerEvent } from "react";

interface Options {
  /** Initial column width in px (used when nothing is persisted). */
  initial: number;
  /** Minimum width in px. */
  min: number;
  /** Returns the current maximum width in px (evaluated live during a drag). */
  getMax: () => number;
  /** localStorage key to persist the chosen width. */
  storageKey: string;
}

/**
 * A pointer-driven horizontal resize handle. Returns the current column width
 * and an `onPointerDown` to spread onto a divider element. Window-level move/up
 * listeners keep the drag alive even when the pointer leaves the handle.
 */
export function useResizable({ initial, min, getMax, storageKey }: Options) {
  const [size, setSize] = useState<number>(() => {
    const saved = Number(localStorage.getItem(storageKey));
    return Number.isFinite(saved) && saved >= min ? saved : initial;
  });

  const onPointerDown = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      e.preventDefault();
      const startX = e.clientX;
      const startSize = size;
      let finalSize = startSize;
      document.body.classList.add("resizing");

      const move = (ev: PointerEvent) => {
        const max = Math.max(min, getMax());
        finalSize = Math.min(max, Math.max(min, startSize + (ev.clientX - startX)));
        setSize(finalSize);
      };
      const up = () => {
        document.body.classList.remove("resizing");
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        try {
          localStorage.setItem(storageKey, String(Math.round(finalSize)));
        } catch {
          /* ignore quota / privacy-mode errors */
        }
      };

      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
    },
    [size, min, getMax, storageKey],
  );

  return { size, onPointerDown };
}
