import { describe, expect, it } from "vitest";
import { renderHook } from "vitest-browser-react";

import { useResizable, useSplitRatio } from "./useResizable";

describe("useResizable", () => {
  it("uses the initial size when nothing is persisted", async () => {
    const key = "test-resizable-empty";
    localStorage.removeItem(key);
    const { result } = await renderHook(() =>
      useResizable({ initial: 200, min: 100, getMax: () => 1000, storageKey: key }),
    );
    expect(result.current.size).toBe(200);
  });

  it("honors a persisted size that is at or above the minimum", async () => {
    const key = "test-resizable-stored";
    localStorage.setItem(key, "300");
    const { result } = await renderHook(() =>
      useResizable({ initial: 200, min: 100, getMax: () => 1000, storageKey: key }),
    );
    expect(result.current.size).toBe(300);
    localStorage.removeItem(key);
  });

  it("falls back to the initial size when the persisted size is below the minimum", async () => {
    const key = "test-resizable-tiny";
    localStorage.setItem(key, "50");
    const { result } = await renderHook(() =>
      useResizable({ initial: 200, min: 100, getMax: () => 1000, storageKey: key }),
    );
    expect(result.current.size).toBe(200);
    localStorage.removeItem(key);
  });

  it("clamps a persisted size down to the current maximum on mount", async () => {
    const key = "test-resizable-clamp";
    localStorage.setItem(key, "800");
    const { result } = await renderHook(() =>
      useResizable({ initial: 200, min: 100, getMax: () => 400, storageKey: key }),
    );
    expect(result.current.size).toBe(400);
    localStorage.removeItem(key);
  });
});

describe("useSplitRatio", () => {
  it("derives leftPx from the initial fraction when nothing is persisted", async () => {
    const key = "test-split-empty";
    localStorage.removeItem(key);
    const { result } = await renderHook(() =>
      useSplitRatio({ initial: 0.5, min: 0.2, max: 0.8, storageKey: key }),
    );
    const expected = Math.round(0.5 * Math.max(0, window.innerWidth - 6));
    expect(result.current.leftPx).toBe(expected);
  });

  it("honors a persisted fraction inside the allowed range", async () => {
    const key = "test-split-stored";
    localStorage.setItem(key, "0.6");
    const { result } = await renderHook(() =>
      useSplitRatio({ initial: 0.5, min: 0.2, max: 0.8, storageKey: key }),
    );
    const expected = Math.round(0.6 * Math.max(0, window.innerWidth - 6));
    expect(result.current.leftPx).toBe(expected);
    localStorage.removeItem(key);
  });

  it("falls back to the initial fraction when the persisted one is out of range", async () => {
    const key = "test-split-oor";
    localStorage.setItem(key, "0.95");
    const { result } = await renderHook(() =>
      useSplitRatio({ initial: 0.5, min: 0.2, max: 0.8, storageKey: key }),
    );
    const expected = Math.round(0.5 * Math.max(0, window.innerWidth - 6));
    expect(result.current.leftPx).toBe(expected);
    localStorage.removeItem(key);
  });
});
