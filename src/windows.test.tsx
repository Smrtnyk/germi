import { beforeEach, expect, it, vi } from "vitest";

import { applyAppearance } from "./theme";
import { openOrFocusWindow } from "./windows";

const windowMocks = vi.hoisted(() => ({
  created: [] as { label: string; options: { url?: string } }[],
}));

vi.mock("@tauri-apps/api/webviewWindow", () => ({
  WebviewWindow: class {
    static getByLabel() {
      return Promise.resolve(null);
    }

    constructor(label: string, options: { url?: string }) {
      windowMocks.created.push({ label, options });
    }

    once(event: string, handler: (event: { payload: null }) => void) {
      if (event === "tauri://created") queueMicrotask(() => handler({ payload: null }));
      return Promise.resolve(vi.fn());
    }
  },
}));

beforeEach(() => {
  windowMocks.created = [];
  applyAppearance("dark", {});
});

it("passes the current resolved theme into a new app window's pre-paint URL", async () => {
  applyAppearance("light", {});

  await openOrFocusWindow("compare", { url: "/?view=compare" });

  expect(windowMocks.created).toEqual([
    { label: "compare", options: { url: "/?view=compare&theme=light" } },
  ]);
});
