import { describe, expect, it } from "vitest";

import type { SettingsDialogDraft } from "./settingsDraft";
import { reconcileSettingsDraft } from "./settingsReconciliation";
import { DEFAULT_SHORTCUTS } from "./shortcuts";
import type { ProxySettings } from "./types";

function settings(overrides: Partial<ProxySettings> = {}): ProxySettings {
  return {
    excludedHosts: [],
    headerColumns: [],
    port: 8080,
    allowRemote: false,
    maxFlows: 5000,
    captureFilter: [],
    autoStartOnLaunch: true,
    responseDelayMs: 0,
    systemProxyHotkey: "",
    theme: "system",
    highlightColors: {},
    ...overrides,
  };
}

function draft(settingsValue: ProxySettings): SettingsDialogDraft {
  return {
    settings: settingsValue,
    columnOrder: ["seq", "method"],
    shortcuts: DEFAULT_SHORTCUTS,
    autoLayout: "side",
    activeSection: "connections",
  };
}

describe("modeless Settings reconciliation", () => {
  it("merges independent child and main fields onto the newest authoritative state", () => {
    const baseline = draft(settings());
    const edited = {
      ...baseline,
      settings: { ...baseline.settings, responseDelayMs: 500 },
      activeSection: "throttling",
    };
    const current = draft(
      settings({
        port: 9090,
        excludedHosts: ["main.example"],
      }),
    );

    expect(reconcileSettingsDraft(baseline, edited, current)).toEqual({
      ok: true,
      draft: {
        ...current,
        settings: {
          ...current.settings,
          responseDelayMs: 500,
        },
        activeSection: "throttling",
      },
    });
  });

  it("rejects a same-field overlap instead of choosing either side", () => {
    const baseline = draft(settings());
    const edited = { ...baseline, settings: { ...baseline.settings, port: 9090 } };
    const current = draft(settings({ port: 7070, excludedHosts: ["main.example"] }));

    expect(reconcileSettingsDraft(baseline, edited, current)).toEqual({
      ok: false,
      conflicts: ["settings.port"],
    });
  });

  it("merges independent keys in record settings while detecting a shared-key conflict", () => {
    const baseline = draft(settings({ highlightColors: { selected: "saved" } }));
    const edited = draft(
      settings({ highlightColors: { selected: "child", rowMatch: "child-only" } }),
    );
    const current = draft(
      settings({ highlightColors: { selected: "main", rowMock: "main-only" } }),
    );

    expect(reconcileSettingsDraft(baseline, edited, current)).toEqual({
      ok: false,
      conflicts: ["settings.highlightColors.selected"],
    });
  });
});
