import { useState } from "react";
import { userEvent } from "vitest/browser";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import "../styles.css";
import { applyAppearance } from "../theme";
import { DEFAULT_SHORTCUTS } from "../shortcuts";
import { persistSettingsDialogDraft, type SettingsDialogDraft } from "../settingsDraft";
import type { ProxySettings, Theme } from "../types";
import { SettingsDialog } from "./SettingsDialog";

const apiMocks = vi.hoisted(() => ({
  getSettingsSections: vi.fn(),
  exportSettings: vi.fn(),
  peekSettingsImport: vi.fn(),
  applySettingsImport: vi.fn(),
}));

vi.mock("../ipc", () => ({ api: apiMocks }));

function settings(overrides: Partial<ProxySettings> = {}): ProxySettings {
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
    theme: "dark",
    highlightColors: {},
    ...overrides,
  };
}

function mockPreferredScheme(initial: Theme) {
  const original = window.matchMedia.bind(window);
  let matches = initial === "dark";
  const listeners = new Set<(event: MediaQueryListEvent) => void>();
  const query = {
    get matches() {
      return matches;
    },
    media: "(prefers-color-scheme: dark)",
    onchange: null,
    addEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) =>
      listeners.add(listener),
    removeEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) =>
      listeners.delete(listener),
  } as unknown as MediaQueryList;
  const spy = vi
    .spyOn(window, "matchMedia")
    .mockImplementation((media) => (media === query.media ? query : original(media)));
  return {
    set(theme: Theme) {
      matches = theme === "dark";
      const event = { matches, media: query.media } as MediaQueryListEvent;
      for (const listener of listeners) listener(event);
    },
    restore() {
      applyAppearance("dark", {});
      spy.mockRestore();
    },
  };
}

function props(overrides: Partial<Parameters<typeof SettingsDialog>[0]> = {}) {
  return {
    settings: settings(),
    onImportApplied: vi.fn(),
    columnOrder: ["seq", "method", "url"],
    shortcuts: DEFAULT_SHORTCUTS,
    autoLayout: "side" as const,
    running: false,
    portError: null,
    onCaChanged: vi.fn(),
    onFlushSettings: vi.fn(() => Promise.resolve()),
    onSave: vi.fn(() => Promise.resolve()),
    onClose: vi.fn(),
    ...overrides,
  };
}

function Harness({
  persist = vi.fn(),
  initialSettings = settings(),
}: {
  persist?: (draft: SettingsDialogDraft) => Promise<void>;
  initialSettings?: ProxySettings;
}) {
  const [open, setOpen] = useState(true);
  const [savedSettings, setSavedSettings] = useState(initialSettings);
  const [savedOrder, setSavedOrder] = useState(["seq", "method", "url"]);
  const [savedShortcuts, setSavedShortcuts] = useState(DEFAULT_SHORTCUTS);
  const [savedLayout, setSavedLayout] = useState<"side" | "stacked">("side");

  async function save(draft: SettingsDialogDraft) {
    await persistSettingsDialogDraft(localStorage, draft, () => persist(draft));
    setSavedSettings(draft.settings);
    setSavedOrder(draft.columnOrder);
    setSavedShortcuts(draft.shortcuts);
    setSavedLayout(draft.autoLayout);
    setOpen(false);
  }

  return (
    <>
      {!open && <button onClick={() => setOpen(true)}>Open settings</button>}
      {open && (
        <SettingsDialog
          {...props({
            settings: savedSettings,
            columnOrder: savedOrder,
            shortcuts: savedShortcuts,
            autoLayout: savedLayout,
            onSave: save,
            onClose: () => setOpen(false),
          })}
        />
      )}
    </>
  );
}

type BrowserScreen = Awaited<ReturnType<typeof render>>;

function clickBackdrop(selector: string) {
  const dialog = document.querySelector(selector) as HTMLDialogElement | null;
  if (!dialog) throw new Error(`Missing dialog: ${selector}`);
  const rect = dialog.getBoundingClientRect();
  dialog.dispatchEvent(
    new MouseEvent("click", {
      bubbles: true,
      clientX: rect.left - 1,
      clientY: rect.top - 1,
    }),
  );
}

function shownColumnRow(label: string): HTMLLIElement {
  const rows = document.querySelectorAll<HTMLLIElement>('ul[aria-label="Shown columns"] > li');
  const match = [...rows].find(
    (item) => item.querySelector(".col-name")?.textContent?.trim() === label,
  );
  if (!match) throw new Error(`Column row is missing: ${label}`);
  return match;
}

function dragColumnBefore(sourceLabel: string, targetLabel: string) {
  const source = shownColumnRow(sourceLabel);
  const target = shownColumnRow(targetLabel);
  const handle = source.querySelector<HTMLElement>(".col-drag-handle");
  if (!handle) throw new Error("Column drag handle is missing");
  const dataTransfer = new DataTransfer();
  handle.dispatchEvent(
    new DragEvent("dragstart", { bubbles: true, cancelable: true, dataTransfer }),
  );
  const clientY = target.getBoundingClientRect().top + 1;
  target.dispatchEvent(
    new DragEvent("dragover", {
      bubbles: true,
      cancelable: true,
      dataTransfer,
      clientY,
    }),
  );
  target.dispatchEvent(
    new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer, clientY }),
  );
  handle.dispatchEvent(
    new DragEvent("dragend", { bubbles: true, cancelable: true, dataTransfer, clientY }),
  );
}

async function setSelectedRowColor(screen: BrowserScreen, value: string) {
  await screen.getByRole("button", { name: "Selected row color" }).click();
  const picker = screen.getByRole("dialog", { name: "Selected row color" });
  await screen.getByLabelText("Hex").fill(value);
  await picker.getByRole("button", { name: "Apply" }).click();
}

async function expectSelectedRowColor(screen: BrowserScreen, value: string) {
  await screen.getByRole("button", { name: "Selected row color" }).click();
  const picker = screen.getByRole("dialog", { name: "Selected row color" });
  await expect.element(screen.getByLabelText("Hex")).toHaveValue(value);
  await picker.getByRole("button", { name: "Cancel" }).click();
}

async function stagePortAppearanceAndLayout(screen: BrowserScreen) {
  await screen.getByRole("button", { name: "Connections" }).click();
  await screen.getByRole("spinbutton").fill("9090");
  await userEvent.tab();
  await screen.getByRole("button", { name: "Appearance" }).click();
  await screen.getByRole("button", { name: "Light" }).click();
  await setSelectedRowColor(screen, "#ff000080");
  await screen.getByRole("button", { name: "Autoresponder" }).click();
  await screen.getByRole("button", { name: "Stacked" }).click();
}

async function expectStagedPortAppearanceAndLayout(screen: BrowserScreen) {
  await screen.getByRole("button", { name: "Connections" }).click();
  await expect.element(screen.getByRole("spinbutton")).toHaveValue(9090);
  await screen.getByRole("button", { name: "Appearance" }).click();
  await expect.element(screen.getByRole("button", { name: "Light" })).toHaveClass("on");
  expect(document.documentElement.dataset.theme).toBe("light");
  await expectSelectedRowColor(screen, "#ff000080");
  expect(document.documentElement.style.getPropertyValue("--sel-bg")).toBe("#ff000080");
  await screen.getByRole("button", { name: "Autoresponder" }).click();
  await expect.element(screen.getByRole("button", { name: "Stacked" })).toHaveClass("active");
}

async function expectSavedDefaults(screen: BrowserScreen) {
  await screen.getByRole("button", { name: "Connections" }).click();
  await expect.element(screen.getByRole("spinbutton")).toHaveValue(8080);
  await screen.getByRole("button", { name: "Appearance" }).click();
  await expect.element(screen.getByRole("button", { name: "Dark" })).toHaveClass("on");
  expect(document.documentElement.dataset.theme).toBe("dark");
  await expectSelectedRowColor(screen, "#173a36ff");
  await screen.getByRole("button", { name: "Autoresponder" }).click();
  await expect.element(screen.getByRole("button", { name: "Side by side" })).toHaveClass("active");
}

beforeEach(() => {
  apiMocks.getSettingsSections.mockReset();
  apiMocks.exportSettings.mockReset();
  apiMocks.peekSettingsImport.mockReset();
  apiMocks.applySettingsImport.mockReset();
  localStorage.clear();
  localStorage.setItem("germi.autoLayout", "side");
  localStorage.setItem("germi.settingsSection", "connections");
  applyAppearance("dark", {});
});

describe("SettingsDialog", () => {
  it("keeps System highlight previews and drafts reactive, then restores durable appearance", async () => {
    const scheme = mockPreferredScheme("dark");
    try {
      const durable = settings({ theme: "system" });
      applyAppearance(durable.theme, durable.highlightColors);
      const screen = await render(<Harness initialSettings={durable} />);
      await screen.getByRole("button", { name: "Appearance" }).click();

      await screen.getByRole("button", { name: "Selected row color" }).click();
      const picker = screen.getByRole("dialog", { name: "Selected row color" });
      await screen.getByLabelText("Hex").fill("#ffffff80");
      expect(document.documentElement.style.getPropertyValue("--sel-bg")).toBe("#ffffff80");

      scheme.set("light");
      expect(document.documentElement.dataset.theme).toBe("light");
      expect(document.documentElement.style.getPropertyValue("--sel-bg")).toBe("#ffffff80");
      expect(document.documentElement.style.getPropertyValue("--sel-fg")).toBe("#000000");

      await picker.getByRole("button", { name: "Cancel" }).click();
      expect(document.documentElement.style.getPropertyValue("--sel-bg")).toBe("");
      expect(document.documentElement.style.getPropertyValue("--sel-fg")).toBe("");
      expect(getComputedStyle(document.documentElement).getPropertyValue("--sel-bg").trim()).toBe(
        "#c9eee8",
      );

      await screen.getByRole("button", { name: "Selected row color" }).click();
      const appliedPicker = screen.getByRole("dialog", { name: "Selected row color" });
      await screen.getByLabelText("Hex").fill("#ffffff80");
      await appliedPicker.getByRole("button", { name: "Apply" }).click();
      expect(document.documentElement.style.getPropertyValue("--sel-bg")).toBe("#ffffff80");

      scheme.set("dark");
      expect(document.documentElement.dataset.theme).toBe("dark");
      expect(document.documentElement.style.getPropertyValue("--sel-bg")).toBe("#ffffff80");
      expect(document.documentElement.style.getPropertyValue("--sel-fg")).toBe("");

      scheme.set("light");
      expect(document.documentElement.style.getPropertyValue("--sel-bg")).toBe("#ffffff80");
      expect(document.documentElement.style.getPropertyValue("--sel-fg")).toBe("#000000");

      await screen.getByRole("button", { name: "Cancel" }).click();
      await expect.element(screen.getByRole("button", { name: "Open settings" })).toBeVisible();
      expect(document.documentElement.dataset.theme).toBe("light");
      expect(document.documentElement.style.getPropertyValue("--sel-bg")).toBe("");
      expect(document.documentElement.style.getPropertyValue("--sel-fg")).toBe("");
      expect(getComputedStyle(document.documentElement).getPropertyValue("--sel-bg").trim()).toBe(
        "#c9eee8",
      );
    } finally {
      scheme.restore();
    }
  });

  it("flushes pending settings before previewing and writing selected export sections", async () => {
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
    const screen = await render(<SettingsDialog {...props({ onFlushSettings })} />);

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

  it("closes directly on Escape when Settings is clean", async () => {
    const screen = await render(<Harness />);

    await userEvent.keyboard("{Escape}");

    await expect.element(screen.getByRole("button", { name: "Open settings" })).toBeVisible();
    await expect
      .element(screen.getByRole("dialog", { name: "Discard unsaved changes?" }))
      .not.toBeInTheDocument();
  });

  it("keeps every dirty Escape draft and restores exact focus with Keep editing", async () => {
    const persist = vi.fn(() => Promise.resolve());
    const screen = await render(<Harness persist={persist} />);

    await stagePortAppearanceAndLayout(screen);
    await screen.getByRole("button", { name: "Appearance" }).click();
    const returnFocus = screen.getByRole("button", { name: "Selected row color" });
    returnFocus.element().focus();
    await expect.element(returnFocus).toHaveFocus();

    await userEvent.keyboard("{Escape}");

    await expect
      .element(screen.getByRole("dialog", { name: "Discard unsaved changes?" }))
      .toBeVisible();
    expect(document.documentElement.style.getPropertyValue("--sel-bg")).toBe("#ff000080");
    expect(localStorage.getItem("germi.autoLayout")).toBe("side");
    expect(localStorage.getItem("germi.settingsSection")).toBe("connections");
    expect(persist).not.toHaveBeenCalled();
    await screen.getByRole("button", { name: "Keep editing" }).click();

    await expect
      .element(screen.getByRole("dialog", { name: "Discard unsaved changes?" }))
      .not.toBeInTheDocument();
    await expect.element(returnFocus).toHaveFocus();
    await expectStagedPortAppearanceAndLayout(screen);
    expect(localStorage.getItem("germi.autoLayout")).toBe("side");
    expect(persist).not.toHaveBeenCalled();
  });

  it("discards every dirty Escape draft only after explicit confirmation", async () => {
    const persist = vi.fn(() => Promise.resolve());
    const screen = await render(<Harness persist={persist} />);

    await stagePortAppearanceAndLayout(screen);
    await userEvent.keyboard("{Escape}");

    await expect
      .element(screen.getByRole("dialog", { name: "Discard unsaved changes?" }))
      .toBeVisible();
    expect(document.documentElement.style.getPropertyValue("--sel-bg")).toBe("#ff000080");
    expect(localStorage.getItem("germi.autoLayout")).toBe("side");
    expect(persist).not.toHaveBeenCalled();
    await screen.getByRole("button", { name: "Discard changes" }).click();

    await expect.element(screen.getByRole("button", { name: "Open settings" })).toBeVisible();
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(document.documentElement.style.getPropertyValue("--sel-bg")).toBe("");
    expect(localStorage.getItem("germi.autoLayout")).toBe("side");
    expect(persist).not.toHaveBeenCalled();

    await screen.getByRole("button", { name: "Open settings" }).click();
    await expectSavedDefaults(screen);
  });

  it("keeps every staged value intact when the Settings backdrop is clicked", async () => {
    const persist = vi.fn(() => Promise.resolve());
    const screen = await render(<Harness persist={persist} />);

    await stagePortAppearanceAndLayout(screen);
    const settingsDialog = screen.getByRole("dialog", { name: "Settings" });
    await expect.element(settingsDialog).toHaveAttribute("closedby", "closerequest");

    clickBackdrop("dialog.settings-modal");

    await expect.element(settingsDialog).toBeVisible();
    await expectStagedPortAppearanceAndLayout(screen);
    expect(localStorage.getItem("germi.autoLayout")).toBe("side");
    expect(persist).not.toHaveBeenCalled();
  });

  it("keeps the same dirty draft and returns focus when X chooses Keep editing", async () => {
    const persist = vi.fn(() => Promise.resolve());
    const screen = await render(<Harness persist={persist} />);

    await stagePortAppearanceAndLayout(screen);
    const closeSettings = screen.getByRole("button", { name: "Close settings" });
    await closeSettings.click();

    await expect
      .element(screen.getByRole("dialog", { name: "Discard unsaved changes?" }))
      .toBeVisible();
    await expect.element(screen.getByRole("button", { name: "Discard changes" })).toBeVisible();
    await screen.getByRole("button", { name: "Keep editing" }).click();

    await expect
      .element(screen.getByRole("dialog", { name: "Discard unsaved changes?" }))
      .not.toBeInTheDocument();
    await expect.element(closeSettings).toHaveFocus();
    await expectStagedPortAppearanceAndLayout(screen);
    expect(localStorage.getItem("germi.autoLayout")).toBe("side");
    expect(persist).not.toHaveBeenCalled();
  });

  it("discards every staged value only after dirty X confirms Discard changes", async () => {
    const persist = vi.fn(() => Promise.resolve());
    const screen = await render(<Harness persist={persist} />);

    await stagePortAppearanceAndLayout(screen);
    await screen.getByRole("button", { name: "Close settings" }).click();

    await expect
      .element(screen.getByRole("dialog", { name: "Discard unsaved changes?" }))
      .toBeVisible();
    expect(document.documentElement.style.getPropertyValue("--sel-bg")).toBe("#ff000080");
    expect(localStorage.getItem("germi.autoLayout")).toBe("side");
    await screen.getByRole("button", { name: "Discard changes" }).click();

    await expect.element(screen.getByRole("button", { name: "Open settings" })).toBeVisible();
    expect(document.documentElement.style.getPropertyValue("--sel-bg")).toBe("");
    expect(localStorage.getItem("germi.autoLayout")).toBe("side");
    expect(persist).not.toHaveBeenCalled();

    await screen.getByRole("button", { name: "Open settings" }).click();
    await expectSavedDefaults(screen);
  });

  it("routes confirmation backdrop and Escape without losing the dirty Settings draft", async () => {
    const screen = await render(<Harness />);

    await screen.getByRole("spinbutton").fill("9090");
    await userEvent.tab();
    const returnFocus = screen.getByRole("spinbutton");
    await returnFocus.click();
    await userEvent.keyboard("{Escape}");

    clickBackdrop("dialog.confirm-modal");
    await expect
      .element(screen.getByRole("dialog", { name: "Discard unsaved changes?" }))
      .toBeVisible();
    await userEvent.keyboard("{Escape}");

    await expect
      .element(screen.getByRole("dialog", { name: "Discard unsaved changes?" }))
      .not.toBeInTheDocument();
    await expect.element(returnFocus).toHaveFocus();
    await expect.element(screen.getByRole("spinbutton")).toHaveValue(9090);

    await userEvent.keyboard("{Escape}");
    await expect
      .element(screen.getByRole("dialog", { name: "Discard unsaved changes?" }))
      .toBeVisible();
    await expect.element(screen.getByRole("dialog", { name: "Settings" })).toBeVisible();
    await screen.getByRole("button", { name: "Keep editing" }).click();
    await expect.element(returnFocus).toHaveFocus();
    await expect.element(screen.getByRole("spinbutton")).toHaveValue(9090);
  });

  it("closes directly from a clean X without asking for confirmation", async () => {
    const screen = await render(<Harness />);

    await screen.getByRole("button", { name: "Close settings" }).click();

    await expect.element(screen.getByRole("button", { name: "Open settings" })).toBeVisible();
    await expect
      .element(screen.getByRole("dialog", { name: "Discard unsaved changes?" }))
      .not.toBeInTheDocument();
  });

  it("keeps explicit Cancel as a direct discard without close-request confirmation", async () => {
    const persist = vi.fn(() => Promise.resolve());
    const screen = await render(<Harness persist={persist} />);

    await stagePortAppearanceAndLayout(screen);
    await screen.getByRole("button", { name: "Cancel" }).click();

    await expect.element(screen.getByRole("button", { name: "Open settings" })).toBeVisible();
    await expect
      .element(screen.getByRole("dialog", { name: "Discard unsaved changes?" }))
      .not.toBeInTheDocument();
    expect(document.documentElement.style.getPropertyValue("--sel-bg")).toBe("");
    expect(localStorage.getItem("germi.autoLayout")).toBe("side");
    expect(persist).not.toHaveBeenCalled();
  });

  it("commits appearance and local-option drafts on Save and reopens them", async () => {
    const persist = vi.fn(() => Promise.resolve());
    const screen = await render(<Harness persist={persist} />);

    await stagePortAppearanceAndLayout(screen);
    await screen.getByRole("button", { name: "Save" }).click();

    await expect.element(screen.getByRole("button", { name: "Open settings" })).toBeVisible();
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(persist).toHaveBeenCalledOnce();
    expect(localStorage.getItem("germi.autoLayout")).toBe("stacked");
    expect(localStorage.getItem("germi.settingsSection")).toBe("autoresponder");
    expect(document.documentElement.style.getPropertyValue("--sel-bg")).toBe("#ff000080");

    await screen.getByRole("button", { name: "Open settings" }).click();
    await expect.element(screen.getByRole("button", { name: "Stacked" })).toHaveClass("active");
    await screen.getByRole("button", { name: "Appearance" }).click();
    await expect.element(screen.getByRole("button", { name: "Light" })).toHaveClass("on");
    await expectSelectedRowColor(screen, "#ff000080");
    await screen.getByRole("button", { name: "Connections" }).click();
    await expect.element(screen.getByRole("spinbutton")).toHaveValue(9090);
  });

  it("persists a dragged column order only when Settings is saved", async () => {
    const persist = vi.fn((_draft: SettingsDialogDraft) => Promise.resolve());
    const initial = ["seq", "method", "url"];
    localStorage.setItem("germi.settingsSection", "columns");
    localStorage.setItem("germi.columns", JSON.stringify(initial));
    const screen = await render(<Harness persist={persist} />);

    dragColumnBefore("URL", "#");
    await vi.waitFor(() =>
      expect(
        [...document.querySelectorAll(".col-name")].map((element) => element.textContent),
      ).toEqual(["URL", "#", "Method"]),
    );
    expect(localStorage.getItem("germi.columns")).toBe(JSON.stringify(initial));
    expect(persist).not.toHaveBeenCalled();

    await screen.getByRole("button", { name: "Save" }).click();

    await expect.element(screen.getByRole("button", { name: "Open settings" })).toBeVisible();
    expect(localStorage.getItem("germi.columns")).toBe(JSON.stringify(["url", "seq", "method"]));
    expect(persist).toHaveBeenCalledOnce();
    expect(persist.mock.calls[0][0].columnOrder).toEqual(["url", "seq", "method"]);

    await screen.getByRole("button", { name: "Open settings" }).click();
    expect(
      [...document.querySelectorAll(".col-name")].map((element) => element.textContent),
    ).toEqual(["URL", "#", "Method"]);
  });

  it("keeps a failed Save open, reports the error, and rolls local options back", async () => {
    const screen = await render(
      <Harness persist={() => Promise.reject(new Error("settings.json is read-only"))} />,
    );

    await screen.getByRole("button", { name: "Appearance" }).click();
    await screen.getByRole("button", { name: "Light" }).click();
    await screen.getByRole("button", { name: "Autoresponder" }).click();
    await screen.getByRole("button", { name: "Stacked" }).click();
    await screen.getByRole("button", { name: "Save" }).click();

    await expect.element(screen.getByRole("dialog", { name: "Settings" })).toBeVisible();
    await expect.element(screen.getByRole("alert")).toHaveTextContent("settings.json is read-only");
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(localStorage.getItem("germi.autoLayout")).toBe("side");
    expect(localStorage.getItem("germi.settingsSection")).toBe("connections");

    await screen.getByRole("button", { name: "Cancel" }).click();
    expect(document.documentElement.dataset.theme).toBe("dark");
  });

  it("applies imports immediately without saving unrelated local drafts", async () => {
    const imported = settings({ excludedHosts: ["example.com"], theme: "light" });
    const onImportApplied = vi.fn();
    const onSave = vi.fn(() => Promise.resolve());
    apiMocks.peekSettingsImport.mockResolvedValue([
      { id: "interception", label: "Host exclusions", detail: "1 excluded host" },
    ]);
    apiMocks.applySettingsImport.mockResolvedValue(imported);
    const screen = await render(<SettingsDialog {...props({ onImportApplied, onSave })} />);

    await screen.getByRole("spinbutton").fill("9090");
    await userEvent.tab();
    await screen.getByRole("button", { name: "Autoresponder" }).click();
    await screen.getByRole("button", { name: "Stacked" }).click();
    await screen.getByTitle(/Import settings from a JSON file/).click();
    await expect
      .element(screen.getByText(/Import applies the checked settings immediately/))
      .toBeVisible();
    await screen.getByRole("button", { name: "Import", exact: true }).click();

    await vi.waitFor(() => expect(onImportApplied).toHaveBeenCalledWith(imported));
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(onSave).not.toHaveBeenCalled();
    expect(localStorage.getItem("germi.autoLayout")).toBe("side");
    await expect.element(screen.getByRole("spinbutton")).toHaveValue(8080);
    await screen.getByRole("button", { name: "Autoresponder" }).click();
    await expect
      .element(screen.getByRole("button", { name: "Side by side" }))
      .toHaveClass("active");
  });
});
