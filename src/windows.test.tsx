import { beforeEach, expect, it, vi } from "vitest";

import { applyAppearance } from "./theme";
import { openOrFocusWindow } from "./windows";

const windowMocks = vi.hoisted(() => ({
  created: [] as { label: string; options: { url?: string } }[],
  destroyed: [] as string[],
  lookup: null as Promise<null> | null,
}));

vi.mock("@tauri-apps/api/webviewWindow", () => ({
  WebviewWindow: class {
    private readonly label: string;

    static getByLabel() {
      return windowMocks.lookup ?? Promise.resolve(null);
    }

    constructor(label: string, options: { url?: string }) {
      this.label = label;
      windowMocks.created.push({ label, options });
    }

    once(event: string, handler: (event: { payload: null }) => void) {
      if (event === "tauri://created") queueMicrotask(() => handler({ payload: null }));
      return Promise.resolve(vi.fn());
    }

    destroy() {
      windowMocks.destroyed.push(this.label);
      return Promise.resolve();
    }
  },
}));

beforeEach(() => {
  windowMocks.created = [];
  windowMocks.destroyed = [];
  windowMocks.lookup = null;
  applyAppearance("dark", {});
});

it("passes the current resolved theme into a new app window's pre-paint URL", async () => {
  applyAppearance("light", {});

  await openOrFocusWindow("compare", { url: "/?view=compare" });

  expect(windowMocks.created).toEqual([
    { label: "compare", options: { url: "/?view=compare&theme=light" } },
  ]);
});

it("does not inspect or bind a just-created webview before its client is ready", async () => {
  await expect(openOrFocusWindow("filter-builder", { url: "/?filter=1" })).resolves.toBe("created");

  expect(windowMocks.created).toHaveLength(1);
  expect(windowMocks.destroyed).toEqual([]);
});

it("does not create after an aborted native lookup eventually returns", async () => {
  let finishLookup!: (value: null) => void;
  windowMocks.lookup = new Promise((resolve) => {
    finishLookup = resolve;
  });
  const controller = new AbortController();
  const opened = openOrFocusWindow("filter-builder", { url: "/?filter=1" }, controller.signal);

  controller.abort();
  finishLookup(null);

  await expect(opened).rejects.toMatchObject({ name: "AbortError" });
  expect(windowMocks.created).toEqual([]);
});
