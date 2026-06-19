import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";

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

  // Clamp on mount and on every window resize, so a width persisted in a larger
  // window can't squeeze the other pane (or overflow) when reopened smaller.
  const getMaxRef = useRef(getMax);
  getMaxRef.current = getMax;
  useEffect(() => {
    const clamp = () =>
      setSize((s) => {
        const max = Math.max(min, getMaxRef.current());
        return Math.min(max, Math.max(min, s));
      });
    clamp();
    window.addEventListener("resize", clamp);
    return () => window.removeEventListener("resize", clamp);
  }, [min]);

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
        final = Math.min(max, Math.max(min, (ev.clientX - rect.left) / rect.width));
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
