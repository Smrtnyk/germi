import { describe, expect, it, vi } from "vitest";

import { closeMainWindowWithEditors, closeScriptsEditorWindow } from "./scriptsClose";

describe("closeScriptsEditorWindow", () => {
  it("keeps the window alive when its pending scripts cannot be saved", async () => {
    const destroy = vi.fn(async () => {});

    await expect(
      closeScriptsEditorWindow(() => Promise.reject(new Error("disk full")), destroy),
    ).resolves.toBe(false);
    expect(destroy).not.toHaveBeenCalled();
  });

  it("destroys only after a successful flush", async () => {
    const order: string[] = [];
    const closed = await closeScriptsEditorWindow(
      () => {
        order.push("flush");
        return Promise.resolve();
      },
      () => {
        order.push("destroy");
        return Promise.resolve();
      },
    );

    expect(closed).toBe(true);
    expect(order).toEqual(["flush", "destroy"]);
  });

  it("reports a failed window destruction", async () => {
    const destroy = vi.fn(() => Promise.reject(new Error("window manager refused")));

    await expect(closeScriptsEditorWindow(() => Promise.resolve(), destroy)).resolves.toBe(false);
    expect(destroy).toHaveBeenCalledOnce();
  });
});

describe("closeMainWindowWithEditors", () => {
  it("flushes every editor before destroying the main window", async () => {
    const order: string[] = [];

    await closeMainWindowWithEditors(
      () => {
        order.push("detached scripts");
        return Promise.resolve();
      },
      () => {
        order.push("detached rules");
        return Promise.resolve();
      },
      () => {
        order.push("rule");
        return Promise.resolve();
      },
      () => {
        order.push("settings");
        return Promise.resolve();
      },
      () => {
        order.push("docked");
        return Promise.resolve();
      },
      () => {
        order.push("destroy");
        return Promise.resolve();
      },
    );

    expect(order).toEqual([
      "detached scripts",
      "detached rules",
      "rule",
      "settings",
      "docked",
      "destroy",
    ]);
  });

  it("does not destroy when either editor cannot save", async () => {
    const docked = vi.fn(async () => {});
    const destroy = vi.fn(async () => {});

    await expect(
      closeMainWindowWithEditors(
        () => Promise.reject(new Error("detached disk full")),
        () => Promise.resolve(),
        () => Promise.resolve(),
        () => Promise.resolve(),
        docked,
        destroy,
      ),
    ).rejects.toThrow("detached disk full");
    expect(docked).not.toHaveBeenCalled();
    expect(destroy).not.toHaveBeenCalled();

    await expect(
      closeMainWindowWithEditors(
        () => Promise.resolve(),
        () => Promise.resolve(),
        () => Promise.reject(new Error("rule database is read-only")),
        () => Promise.resolve(),
        docked,
        destroy,
      ),
    ).rejects.toThrow("rule database is read-only");
    expect(docked).not.toHaveBeenCalled();
    expect(destroy).not.toHaveBeenCalled();

    await expect(
      closeMainWindowWithEditors(
        () => Promise.resolve(),
        () => Promise.resolve(),
        () => Promise.resolve(),
        () => Promise.resolve(),
        () => Promise.reject(new Error("docked disk full")),
        destroy,
      ),
    ).rejects.toThrow("docked disk full");
    expect(destroy).not.toHaveBeenCalled();
  });
});
