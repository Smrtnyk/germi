import { describe, expect, it, vi } from "vitest";

import { buildAppWindowActions } from "./appWindowActions";

describe("detached-window palette actions", () => {
  it("keeps Settings and filter creation routed to their own controllers", () => {
    const openSettings = vi.fn();
    const openFilterWindow = vi.fn();
    const actions = buildAppWindowActions({
      settingsReady: true,
      createFilterShortcut: "Ctrl+F",
      openSettings,
      openFilterWindow,
    });

    actions.createFilter.run();
    actions.settings.run();

    expect(actions.createFilter).toMatchObject({
      id: "create-filter",
      shortcut: "Ctrl+F",
    });
    expect(actions.createFilter.disabled).toBeUndefined();
    expect(actions.settings).toMatchObject({ id: "settings", disabled: false });
    expect(openFilterWindow).toHaveBeenCalledOnce();
    expect(openSettings).toHaveBeenCalledOnce();
  });

  it("disables only Settings while its durable state is unavailable", () => {
    const actions = buildAppWindowActions({
      settingsReady: false,
      openSettings: vi.fn(),
      openFilterWindow: vi.fn(),
    });

    expect(actions.settings.disabled).toBe(true);
    expect(actions.createFilter.disabled).toBeUndefined();
  });
});
