import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { clamp } from "es-toolkit";

interface Options {
  /** Initial size in px (used when nothing is persisted). */
  initial: number;
  /** Minimum size in px. */
  min: number;
  /** Returns the current maximum size in px (evaluated live during a drag). */
  getMax: () => number;
  /** localStorage key to persist the chosen size. */
  storageKey: string;
  /** Drag axis: "x" resizes width (default), "y" resizes height. */
  axis?: "x" | "y";
}

/**
 * A pointer-driven resize handle (horizontal by default, vertical with
 * `axis: "y"`). Returns the current size and an `onPointerDown` to spread onto a
 * divider element. Window-level move/up listeners keep the drag alive even when
 * the pointer leaves the handle.
 */
export function useResizable({ initial, min, getMax, storageKey, axis = "x" }: Options) {
  const [size, setSize] = useState<number>(() => {
    const saved = Number(localStorage.getItem(storageKey));
    return Number.isFinite(saved) && saved >= min ? saved : initial;
  });

  // Clamp on mount and on every window resize, so a width persisted in a larger
  // window can't squeeze the other pane (or overflow) when reopened smaller.
  const getMaxRef = useRef(getMax);
  getMaxRef.current = getMax;
  useEffect(() => {
    const clampSize = () => setSize((s) => clamp(s, min, Math.max(min, getMaxRef.current())));
    clampSize();
    window.addEventListener("resize", clampSize);
    return () => window.removeEventListener("resize", clampSize);
  }, [min]);

  const onPointerDown = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      e.preventDefault();
      const vertical = axis === "y";
      const startPos = vertical ? e.clientY : e.clientX;
      const startSize = size;
      let finalSize = startSize;
      document.body.classList.add("resizing");
      if (vertical) document.body.classList.add("resizing-v");

      const move = (ev: PointerEvent) => {
        const max = Math.max(min, getMax());
        const pos = vertical ? ev.clientY : ev.clientX;
        finalSize = clamp(startSize + (pos - startPos), min, max);
        setSize(finalSize);
      };
      const up = () => {
        document.body.classList.remove("resizing", "resizing-v");
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
    [size, min, getMax, storageKey, axis],
  );

  return { size, onPointerDown };
}

interface SplitOptions {
  /** Initial left fraction (0..1) used when nothing is persisted. */
  initial: number;
  /** Minimum / maximum left fraction, so neither pane can vanish. */
  min: number;
  max: number;
  /** localStorage key to persist the chosen fraction. */
  storageKey: string;
}

/**
 * Ratio-based splitter for a two-pane grid: both panes are `fr` tracks, so
 * resizing the window grows them together instead of one pane staying fixed
 * while the other absorbs all the slack. The divider must be a direct child of
 * the grid — its parent's width sets the scale. Returns the left fraction.
 */
export function useSplitRatio({ initial, min, max, storageKey }: SplitOptions) {
  const [frac, setFrac] = useState<number>(() => {
    const saved = Number(localStorage.getItem(storageKey));
    return Number.isFinite(saved) && saved >= min && saved <= max ? saved : initial;
  });
  const [winW, setWinW] = useState<number>(() => window.innerWidth);
  useEffect(() => {
    const onResize = () => setWinW(window.innerWidth);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const onPointerDown = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      e.preventDefault();
      const grid = e.currentTarget.parentElement;
      if (!grid) return;
      const rect = grid.getBoundingClientRect();
      let final = frac;
      document.body.classList.add("resizing");

      const move = (ev: PointerEvent) => {
        final = clamp((ev.clientX - rect.left) / rect.width, min, max);
        setFrac(final);
      };
      const up = () => {
        document.body.classList.remove("resizing");
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        try {
          localStorage.setItem(storageKey, String(final));
        } catch {
          /* ignore quota / privacy-mode errors */
        }
      };

      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
    },
    [frac, min, max, storageKey],
  );

  const leftPx = Math.round(frac * Math.max(0, winW - 6));
  return { leftPx, onPointerDown };
}
