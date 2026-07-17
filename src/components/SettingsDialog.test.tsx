import { beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { SettingsDialog } from "./SettingsDialog";
import { DEFAULT_SHORTCUTS } from "../shortcuts";
import type { ProxySettings } from "../types";

const apiMocks = vi.hoisted(() => ({
  getSettingsSections: vi.fn(),
  exportSettings: vi.fn(),
  peekSettingsImport: vi.fn(),
  applySettingsImport: vi.fn(),
}));

vi.mock("../ipc", () => ({ api: apiMocks }));

function settings(): ProxySettings {
  return {
    excludedHosts: ["slack.com"],
    headerColumns: [],
    port: 8080,
    allowRemote: false,
    maxFlows: 5000,
    captureFilter: [],
    autoStartOnLaunch: true,
    responseDelayMs: 0,
    systemProxyHotkey: "",
    highlightColors: {},
  };
}

beforeEach(() => {
  apiMocks.getSettingsSections.mockReset();
  apiMocks.exportSettings.mockReset();
  apiMocks.peekSettingsImport.mockReset();
  apiMocks.applySettingsImport.mockReset();
});

describe("SettingsDialog export ordering", () => {
  it("flushes pending settings before previewing and writing selected sections", async () => {
    const order: string[] = [];
    let releaseWrite = () => {};
    let flushCount = 0;
    const onFlushSettings = vi.fn(() => {
      flushCount += 1;
      order.push(`flush-${flushCount}`);
      if (flushCount === 1) return Promise.resolve();
      return new Promise<void>((resolve) => {
        releaseWrite = resolve;
      });
    });
    apiMocks.getSettingsSections.mockImplementation(() => {
      order.push("sections");
      return Promise.resolve([
        { id: "interception", label: "Host exclusions", detail: "1 excluded host" },
      ]);
    });
    apiMocks.exportSettings.mockImplementation(() => {
      order.push("export");
      return Promise.resolve(true);
    });
    const screen = await render(
      <SettingsDialog
        settings={settings()}
        onChange={vi.fn()}
        onImportApplied={vi.fn()}
        columnOrder={["seq", "method", "url"]}
        onColumnOrderChange={vi.fn()}
        shortcuts={DEFAULT_SHORTCUTS}
        onShortcutsChange={vi.fn()}
        autoLayout="side"
        onAutoLayoutChange={vi.fn()}
        running={false}
        portError={null}
        onCaChanged={vi.fn()}
        onFlushSettings={onFlushSettings}
        onClose={vi.fn()}
      />,
    );

    await screen.getByTitle("Export selected settings to a JSON file").click();
    await expect.element(screen.getByText("1 excluded host")).toBeVisible();
    expect(order).toEqual(["flush-1", "sections"]);

    const confirm = document.querySelector(".sections-modal .btn.primary") as HTMLButtonElement;
    confirm.click();
    expect(apiMocks.exportSettings).not.toHaveBeenCalled();
    releaseWrite();

    await vi.waitFor(() => expect(apiMocks.exportSettings).toHaveBeenCalledWith(["interception"]));
    expect(order).toEqual(["flush-1", "sections", "flush-2", "export"]);
  });
});
