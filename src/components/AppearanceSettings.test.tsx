import { userEvent } from "vitest/browser";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { delay } from "es-toolkit";

import "../styles.css";
import {
  applyAppearance,
  applyHighlightColors,
  compositeHex8,
  contrastRatio,
  HIGHLIGHT_COLORS,
  LEGACY_DARK_CONTRAST_PAIRS,
  LIGHT_THEME_CONTRAST_PAIRS,
  REQUIRED_THEME_TOKENS,
} from "../theme";
import type { ThemeContrastPair } from "../theme";
import type { ProxySettings, Theme, ThemePreference } from "../types";
import { DEFAULT_FILTER_COLOR_PRESETS } from "../filterColorPresets";
import { AppearanceSettings } from "./AppearanceSettings";

function settings(
  colors: Record<string, string> = {},
  theme: ThemePreference = "dark",
): ProxySettings {
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
    theme,
    highlightColors: colors,
    filterColorPresets: [...DEFAULT_FILTER_COLOR_PRESETS],
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

function canonical(value: string): string {
  if (value.startsWith("#"))
    return value.length === 7 ? `${value.toLowerCase()}ff` : value.toLowerCase();
  const m = /^rgba\((\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\)$/.exec(value);
  if (!m) throw new Error(`unsupported color: ${value}`);
  const parts = [Number(m[1]), Number(m[2]), Number(m[3]), Math.round(Number(m[4]) * 255)];
  return `#${parts.map((n) => n.toString(16).padStart(2, "0")).join("")}`;
}

async function setColorInput(el: HTMLInputElement, hex: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(el, hex);
  el.dispatchEvent(new Event("input", { bubbles: true }));
  await delay(0);
  el.dispatchEvent(new Event("change", { bubbles: true }));
}

const rootStyle = () => document.documentElement.style;

const OUTPUT_CLASSES: Record<string, string> = {
  selected: "flow-row selected",
  multiSelected: "flow-row checked",
  filterMatch: "flow-row match",
  mockedRow: "flow-row ruled",
  importedRow: "flow-row imported",
  compareMatchLeft: "compare-row hit-a",
  compareMatchRight: "compare-row hit-b",
  diffAdded: "diff-line add",
  diffRemoved: "diff-line del",
};

function AppliedHighlightSurfaces() {
  return (
    <div>
      <div className="flow-canvas" data-color-surface style={{ background: "var(--bg)" }}>
        {HIGHLIGHT_COLORS.filter((spec) => spec.group === "rows").map((spec) => (
          <div key={spec.key} className={OUTPUT_CLASSES[spec.key]} data-output-key={spec.key} />
        ))}
      </div>
      <div className="compare-pane" data-color-surface>
        {HIGHLIGHT_COLORS.filter((spec) => spec.key.startsWith("compareMatch")).map((spec) => (
          <div key={spec.key} className={OUTPUT_CLASSES[spec.key]} data-output-key={spec.key} />
        ))}
      </div>
      <div className="diff-section" data-color-surface>
        {HIGHLIGHT_COLORS.filter((spec) => spec.key.startsWith("diff")).map((spec) => (
          <div key={spec.key} className={OUTPUT_CLASSES[spec.key]} data-output-key={spec.key} />
        ))}
      </div>
    </div>
  );
}

const LEGACY_DARK_TOKEN_BASELINE = {
  "--bg": "#0e1116",
  "--bg-1": "#151a21",
  "--bg-2": "#1c232c",
  "--bg-3": "#232c38",
  "--line": "#2a333f",
  "--text": "#d7dee8",
  "--muted": "#8a96a6",
  "--accent": "#2dd4bf",
  "--accent-dim": "#0d9488",
  "--accent-bg": "#113333",
  "--danger": "#f87171",
  "--warn": "#fbbf24",
  "--imported": "#a78bfa",
  "--s2": "#34d399",
  "--s3": "#60a5fa",
  "--s4": "#fbbf24",
  "--s5": "#f87171",
  "--sel-bg": "#173a36",
  "--sel-multi-bg": "rgba(96, 165, 250, 0.13)",
  "--row-match-bg": "rgba(45, 212, 191, 0.08)",
  "--row-mock-bg": "rgba(45, 212, 191, 0.05)",
  "--row-imported-bg": "rgba(167, 139, 250, 0.06)",
  "--drop-overlay": "rgba(45, 212, 191, 0.13)",
  "--bar-accent-bg": "#13302c",
  "--chip-on-bg": "#112e2e",
  "--banner-warn-bg": "#2a2410",
  "--banner-warn-line": "#5b4a1e",
  "--diff-add-bg": "rgba(52, 211, 153, 0.09)",
  "--diff-del-bg": "rgba(248, 113, 113, 0.1)",
  "--diff-add-hl": "rgba(52, 211, 153, 0.28)",
  "--diff-del-hl": "rgba(248, 113, 113, 0.3)",
  "--match-a-bg": "rgba(45, 212, 191, 0.08)",
  "--match-b-bg": "rgba(96, 165, 250, 0.09)",
  "--scrollbar-thumb": "#3a4655",
  "--scrollbar-track": "transparent",
} as const;

function expectContrastPairs(theme: Theme, pairs: readonly ThemeContrastPair[]) {
  applyAppearance(theme, {});
  const computed = getComputedStyle(document.documentElement);
  for (const pair of pairs) {
    const foregroundValue = canonical(computed.getPropertyValue(pair.foreground).trim());
    expect(foregroundValue.endsWith("ff"), `${theme} ${pair.foreground} must be opaque`).toBe(true);
    const foreground = foregroundValue.slice(0, 7);
    const backgroundValue = canonical(computed.getPropertyValue(pair.background).trim());
    if (!backgroundValue.endsWith("ff") && pair.surface === undefined) {
      throw new Error(`${theme} ${pair.background} needs its underlying surface`);
    }
    const background = backgroundValue.endsWith("ff")
      ? backgroundValue.slice(0, 7)
      : compositeHex8(
          backgroundValue,
          canonical(computed.getPropertyValue(pair.surface ?? "").trim()).slice(0, 7),
        );
    if (!backgroundValue.endsWith("ff")) {
      expect(pair.surface, `${theme} ${pair.background} needs its underlying surface`).toBe("--bg");
    }
    expect(
      contrastRatio(foreground, background),
      `${theme} ${pair.foreground} on ${pair.background}`,
    ).toBeGreaterThanOrEqual(pair.minimum);
  }
}

beforeEach(() => {
  document.documentElement.removeAttribute("style");
  applyAppearance("dark", {});
  if (!document.querySelector('meta[name="color-scheme"]')) {
    const meta = document.createElement("meta");
    meta.name = "color-scheme";
    document.head.append(meta);
  }
});

describe("HIGHLIGHT_COLORS vs styles.css", () => {
  it("mirrors every theme default", () => {
    for (const theme of ["dark", "light"] as const) {
      applyAppearance(theme, {});
      const computed = getComputedStyle(document.documentElement);
      for (const spec of HIGHLIGHT_COLORS) {
        expect(canonical(computed.getPropertyValue(spec.cssVar).trim()), spec.cssVar).toBe(
          spec.defaultValues[theme],
        );
        expect(computed.getPropertyValue(spec.foregroundVar).trim()).not.toBe("");
        if (spec.derivedVar) expect(computed.getPropertyValue(spec.derivedVar).trim()).not.toBe("");
      }
    }
  });

  it("defines every required semantic token in the light theme", () => {
    applyAppearance("light", {});
    const computed = getComputedStyle(document.documentElement);
    for (const token of REQUIRED_THEME_TOKENS) {
      expect(computed.getPropertyValue(token).trim(), `light ${token}`).not.toBe("");
    }
  });

  it("meets light WCAG contrast and preserves compliant legacy dark pairs", () => {
    expectContrastPairs("light", LIGHT_THEME_CONTRAST_PAIRS);
    expectContrastPairs("dark", LEGACY_DARK_CONTRAST_PAIRS);
  });
});

describe("legacy dark appearance", () => {
  it("locks the pre-light token palette and representative computed states", () => {
    applyAppearance("dark", {});
    const root = getComputedStyle(document.documentElement);
    for (const [token, expected] of Object.entries(LEGACY_DARK_TOKEN_BASELINE)) {
      expect(root.getPropertyValue(token).trim(), token).toBe(expected);
    }
    expect(root.colorScheme).toBe("dark");

    const fixture = document.createElement("div");
    fixture.innerHTML = `
      <button class="btn primary legacy-primary">Save</button>
      <button class="btn danger legacy-danger">Delete</button>
      <div class="error-bar legacy-error">Failed</div>
      <button class="fchip s-2xx on legacy-status">2xx</button>
      <div class="flow-canvas">
        <div class="flow-row selected legacy-selected"><span class="c-kind">GET</span></div>
        <div class="flow-row checked legacy-checked">Checked</div>
        <div class="flow-row match legacy-match">Match</div>
        <div class="flow-row ruled legacy-ruled">Mocked</div>
        <div class="flow-row imported legacy-imported">Imported</div>
        <div class="flow-row dim legacy-dim">Dimmed</div>
      </div>
      <mark class="vmatch active legacy-find">match</mark>
      <div class="compare-row selected legacy-compare"><span class="compare-seq">1</span></div>
      <div class="diff-line add legacy-diff"><span class="diff-sign">+</span>line</div>
      <span class="outcome-badge respond legacy-outcome">Respond</span>
      <div class="toast error legacy-toast"><span class="toast-icon">!</span></div>
      <span class="notification-badge legacy-notification">1</span>
      <span class="tooltip-popup legacy-tooltip">Help</span>
    `;
    document.body.append(fixture);
    const pick = (selector: string) =>
      getComputedStyle(fixture.querySelector<HTMLElement>(selector)!);
    const colorProbe = document.createElement("span");
    colorProbe.style.color = "color-mix(in srgb, #34d399 15%, #1c232c)";
    fixture.append(colorProbe);

    try {
      expect(pick(".legacy-primary").backgroundColor).toBe("rgb(13, 148, 136)");
      expect(pick(".legacy-primary").color).toBe("rgb(4, 32, 28)");
      expect(pick(".legacy-danger").borderTopColor).toBe("rgb(107, 43, 43)");
      expect(pick(".legacy-error").backgroundColor).toBe("rgb(58, 29, 29)");
      expect(pick(".legacy-error").color).toBe("rgb(255, 215, 215)");
      expect(pick(".legacy-error").borderBottomColor).toBe("rgb(91, 42, 42)");
      expect(pick(".legacy-status").backgroundColor).toBe(getComputedStyle(colorProbe).color);

      expect(pick(".legacy-selected").backgroundColor).toBe("rgb(23, 58, 54)");
      expect(pick(".legacy-selected").color).toBe("rgb(215, 222, 232)");
      expect(pick(".legacy-selected").outlineStyle).toBe("none");
      expect(pick(".legacy-selected .c-kind").color).toBe("rgb(138, 150, 166)");
      expect(pick(".legacy-selected").borderBottomColor).toBe("rgb(26, 33, 42)");
      expect(pick(".legacy-checked").backgroundColor).toBe("rgba(96, 165, 250, 0.13)");
      expect(pick(".legacy-checked").outlineStyle).toBe("none");
      expect(pick(".legacy-match").backgroundColor).toBe("rgba(45, 212, 191, 0.08)");
      expect(pick(".legacy-ruled").backgroundColor).toBe("rgba(45, 212, 191, 0.05)");
      expect(pick(".legacy-imported").backgroundColor).toBe("rgba(167, 139, 250, 0.06)");
      expect(pick(".legacy-dim").opacity).toBe("0.32");

      expect(pick(".legacy-find").backgroundColor).toBe("rgb(45, 212, 191)");
      expect(pick(".legacy-find").color).toBe("rgb(4, 32, 28)");
      expect(pick(".legacy-compare").outlineStyle).toBe("none");
      expect(pick(".legacy-compare .compare-seq").color).toBe("rgb(138, 150, 166)");
      expect(pick(".legacy-diff").backgroundColor).toBe("rgba(52, 211, 153, 0.09)");
      expect(pick(".legacy-diff").color).toBe("rgb(215, 222, 232)");
      expect(pick(".legacy-diff .diff-sign").color).toBe("rgb(52, 211, 153)");
      expect(pick(".legacy-outcome").backgroundColor).toBe("rgb(19, 59, 54)");
      expect(pick(".legacy-toast").borderTopColor).toBe("rgb(107, 43, 43)");
      expect(pick(".legacy-toast").boxShadow).toContain("rgba(0, 0, 0, 0.5)");
      expect(pick(".legacy-toast .toast-icon").color).toBe("rgb(42, 12, 12)");
      expect(pick(".legacy-notification").color).toBe("rgb(255, 255, 255)");
      expect(pick(".legacy-tooltip").boxShadow).toContain("rgba(0, 0, 0, 0.3)");

      applyAppearance("dark", { selected: "#ffffff80" });
      expect(rootStyle().getPropertyValue("--sel-bg")).toBe("#ffffff80");
      expect(rootStyle().getPropertyValue("--sel-fg")).toBe("");
    } finally {
      fixture.remove();
    }
  });
});

describe("AppearanceSettings", () => {
  it("resolves System initially and follows live operating-system changes", async () => {
    const scheme = mockPreferredScheme("light");
    try {
      applyAppearance("system", {});
      expect(document.documentElement.dataset.theme).toBe("light");
      expect(localStorage.getItem("germi.theme-cache")).toBe("light");
      expect(localStorage.getItem("germi.theme-preference-cache")).toBe("system");

      const screen = await render(
        <AppearanceSettings settings={settings({}, "system")} onChange={vi.fn()} />,
      );
      await expect.element(screen.getByRole("button", { name: "System" })).toHaveClass("on");

      scheme.set("dark");
      expect(document.documentElement.dataset.theme).toBe("dark");
      expect(getComputedStyle(document.documentElement).colorScheme).toBe("dark");
      expect(localStorage.getItem("germi.theme-cache")).toBe("dark");
    } finally {
      scheme.restore();
    }
  });

  it("keeps explicit Dark and Light choices independent of OS changes", () => {
    const scheme = mockPreferredScheme("light");
    try {
      applyAppearance("system", {});
      applyAppearance("dark", {});
      scheme.set("light");
      expect(document.documentElement.dataset.theme).toBe("dark");

      applyAppearance("light", {});
      scheme.set("dark");
      expect(document.documentElement.dataset.theme).toBe("light");
    } finally {
      scheme.restore();
    }
  });

  it("persists the System choice from the Appearance control", async () => {
    const scheme = mockPreferredScheme("light");
    try {
      const onChange = vi.fn();
      const screen = await render(
        <AppearanceSettings settings={settings({}, "dark")} onChange={onChange} />,
      );
      await screen.getByRole("button", { name: "System" }).click();
      expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ theme: "system" }));
      expect(document.documentElement.dataset.theme).toBe("light");
      expect(localStorage.getItem("germi.theme-cache")).toBe("light");
      expect(localStorage.getItem("germi.theme-preference-cache")).toBe("system");
    } finally {
      scheme.restore();
    }
  });

  it("switches and persists the applied light theme", async () => {
    const onChange = vi.fn();
    const screen = await render(<AppearanceSettings settings={settings()} onChange={onChange} />);
    await screen.getByRole("button", { name: "Light" }).click();
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ theme: "light" }));
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(getComputedStyle(document.documentElement).colorScheme).toBe("light");
    expect(document.querySelector<HTMLMetaElement>('meta[name="color-scheme"]')?.content).toBe(
      "light",
    );
    expect(localStorage.getItem("germi.theme-cache")).toBe("light");
    expect(localStorage.getItem("germi.theme-preference-cache")).toBe("light");
    expect(getComputedStyle(document.body).backgroundColor).toBe("rgb(246, 248, 251)");
  });

  it("renders the shared picker for every highlight color", async () => {
    const screen = await render(<AppearanceSettings settings={settings()} onChange={vi.fn()} />);
    await expect.element(screen.getByText("Traffic rows")).toBeVisible();
    await expect.element(screen.getByText("Compare & diff")).toBeVisible();
    for (const s of HIGHLIGHT_COLORS) {
      await expect.element(screen.getByRole("button", { name: `${s.label} color` })).toBeVisible();
    }
    expect(document.querySelectorAll('input[type="range"]')).toHaveLength(0);
    await screen.getByRole("button", { name: "Multi-selected rows color" }).click();
    await expect
      .element(screen.getByRole("slider", { name: "Multi-selected rows opacity" }))
      .toBeVisible();
    await expect.element(screen.getByText("13%")).toBeVisible();
  });

  it("edits one complete filter preset without offering the filter preset chooser recursively", async () => {
    const onChange = vi.fn();
    const screen = await render(<AppearanceSettings settings={settings()} onChange={onChange} />);
    expect(screen.getByRole("button", { name: /Filter preset \d+ color/ }).all()).toHaveLength(10);
    await screen.getByRole("button", { name: "Filter preset 1 color" }).click();

    await expect.element(screen.getByRole("radio")).not.toBeInTheDocument();
    await screen.getByLabelText("Hex").fill("#11223380");
    expect(onChange).not.toHaveBeenCalled();
    await screen.getByRole("button", { name: "Apply" }).click();

    expect(onChange).toHaveBeenCalledOnce();
    expect(onChange.mock.calls[0][0].filterColorPresets).toEqual([
      "#11223380",
      ...DEFAULT_FILTER_COLOR_PRESETS.slice(1),
    ]);
  });

  it("resets all filter presets as one Settings draft change", async () => {
    const onChange = vi.fn();
    const custom = ["#11223380", ...DEFAULT_FILTER_COLOR_PRESETS.slice(1)];
    const screen = await render(
      <AppearanceSettings
        settings={{ ...settings(), filterColorPresets: custom }}
        onChange={onChange}
      />,
    );
    await screen.getByRole("button", { name: "Reset filter presets" }).click();

    expect(onChange).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ filterColorPresets: [...DEFAULT_FILTER_COLOR_PRESETS] }),
    );
  });

  it("keeps all ten preset editors owned and clickable in the narrow one-column layout", async () => {
    const screen = await render(
      <div data-testid="narrow-settings" style={{ width: 300 }}>
        <AppearanceSettings settings={settings()} onChange={vi.fn()} />
      </div>,
    );
    const grid = document.querySelector<HTMLElement>(".filter-preset-settings-grid")!;
    expect(getComputedStyle(grid).gridTemplateColumns.split(" ")).toHaveLength(1);
    expect(grid.scrollWidth).toBeLessThanOrEqual(grid.clientWidth);

    for (let index = 1; index <= 10; index += 1) {
      const trigger = screen.getByRole("button", { name: `Filter preset ${index} color` });
      const card = trigger.element().closest<HTMLElement>(".filter-preset-setting")!;
      const triggerRect = trigger.element().getBoundingClientRect();
      const cardRect = card.getBoundingClientRect();
      expect(triggerRect.left).toBeGreaterThanOrEqual(cardRect.left);
      expect(triggerRect.right).toBeLessThanOrEqual(cardRect.right);
      await trigger.click();
      const dialog = screen.getByRole("dialog", { name: `Filter preset ${index} color` });
      await expect.element(dialog).toBeVisible();
      await dialog.getByRole("button", { name: "Cancel" }).click();
    }
  });

  it("previews each applied output over the same traffic backdrop", async () => {
    const colors = Object.fromEntries(HIGHLIGHT_COLORS.map((spec) => [spec.key, "#33669980"]));
    applyHighlightColors(colors);
    await render(
      <>
        <AppearanceSettings settings={settings(colors)} onChange={vi.fn()} />
        <AppliedHighlightSurfaces />
      </>,
    );

    for (const spec of HIGHLIGHT_COLORS) {
      const picker = document.querySelector<HTMLElement>(`[data-color-key="${spec.key}"]`)!;
      const preview = picker.querySelector<HTMLElement>(".color-picker-swatch")!;
      const previewTint = picker.querySelector<HTMLElement>(".color-picker-swatch-tint")!;
      const output = document.querySelector<HTMLElement>(`[data-output-key="${spec.key}"]`)!;
      const outputSurface = output.closest<HTMLElement>("[data-color-surface]")!;
      expect(getComputedStyle(previewTint).backgroundColor, spec.key).toBe(
        getComputedStyle(output).backgroundColor,
      );
      expect(getComputedStyle(preview).backgroundColor, spec.key).toBe(
        getComputedStyle(outputSurface).backgroundColor,
      );
      expect(getComputedStyle(preview).backgroundColor, spec.key).toBe("rgb(14, 17, 22)");
    }
  });

  it("previews opacity live but commits it only once on Apply", async () => {
    const onChange = vi.fn();
    const screen = await render(<AppearanceSettings settings={settings()} onChange={onChange} />);
    await screen.getByRole("button", { name: "Selected row color" }).click();
    const slider = screen.getByRole("slider", { name: "Selected row opacity" });
    (slider.element() as HTMLInputElement).focus();
    await userEvent.keyboard("{ArrowLeft}");

    expect(onChange).not.toHaveBeenCalled();
    expect(rootStyle().getPropertyValue("--sel-bg")).toBe("#173a36fc");
    await screen.getByRole("button", { name: "Apply" }).click();
    expect(onChange).toHaveBeenCalledOnce();
    expect(onChange.mock.calls[0][0].highlightColors).toEqual({ selected: "#173a36fc" });
    expect(rootStyle().getPropertyValue("--sel-bg")).toBe("#173a36fc");
  });

  it("reverts a live preview on Cancel without persisting it", async () => {
    const onChange = vi.fn();
    const screen = await render(<AppearanceSettings settings={settings()} onChange={onChange} />);
    await screen.getByRole("button", { name: "Selected row color" }).click();
    const slider = screen.getByRole("slider", { name: "Selected row opacity" });
    (slider.element() as HTMLInputElement).focus();
    await userEvent.keyboard("{ArrowLeft}");
    expect(rootStyle().getPropertyValue("--sel-bg")).toBe("#173a36fc");

    await screen.getByRole("button", { name: "Cancel" }).click();
    expect(onChange).not.toHaveBeenCalled();
    expect(rootStyle().getPropertyValue("--sel-bg")).toBe("");
  });

  it("reverts a live preview on Escape and returns focus without persisting it", async () => {
    const onChange = vi.fn();
    const screen = await render(<AppearanceSettings settings={settings()} onChange={onChange} />);
    const trigger = screen.getByRole("button", { name: "Selected row color" });
    await trigger.click();
    await screen.getByRole("slider", { name: "Selected row opacity" }).fill("40");
    expect(rootStyle().getPropertyValue("--sel-bg")).toBe("#173a3666");

    await userEvent.keyboard("{Escape}");
    expect(onChange).not.toHaveBeenCalled();
    expect(rootStyle().getPropertyValue("--sel-bg")).toBe("");
    expect(document.activeElement).toBe(trigger.element());
  });

  it("commits a hue keeping the row's opacity and derives the diff mark", async () => {
    const onChange = vi.fn();
    const screen = await render(<AppearanceSettings settings={settings()} onChange={onChange} />);
    await screen.getByRole("button", { name: "Diff — added lines color" }).click();
    const hue = screen.getByLabelText("Diff — added lines hue");
    await setColorInput(hue.element() as HTMLInputElement, "#112233");
    expect(onChange).not.toHaveBeenCalled();
    await screen.getByRole("button", { name: "Apply" }).click();
    expect(onChange.mock.calls[0][0].highlightColors).toEqual({ diffAdded: "#11223317" });
    expect(rootStyle().getPropertyValue("--diff-add-bg")).toBe("#11223317");
    expect(rootStyle().getPropertyValue("--diff-add-hl")).toBe("#11223345");
  });

  it("commits a typed 6-digit hex keeping the row's opacity", async () => {
    const onChange = vi.fn();
    const screen = await render(<AppearanceSettings settings={settings()} onChange={onChange} />);
    await screen.getByRole("button", { name: "Diff — added lines color" }).click();
    await screen.getByLabelText("Hex").fill("#112233");
    await screen.getByRole("button", { name: "Apply" }).click();
    expect(onChange.mock.calls[0][0].highlightColors).toEqual({ diffAdded: "#11223317" });
  });

  it("commits a typed 8-digit hex including its alpha", async () => {
    const onChange = vi.fn();
    const screen = await render(<AppearanceSettings settings={settings()} onChange={onChange} />);
    await screen.getByRole("button", { name: "Selected row color" }).click();
    await screen.getByLabelText("Hex").fill("11223380");
    expect(onChange).not.toHaveBeenCalled();
    await screen.getByRole("button", { name: "Apply" }).click();
    expect(onChange.mock.calls[0][0].highlightColors).toEqual({ selected: "#11223380" });
  });

  it("does not allow an unparseable hex entry to save", async () => {
    const onChange = vi.fn();
    const screen = await render(<AppearanceSettings settings={settings()} onChange={onChange} />);
    await screen.getByRole("button", { name: "Selected row color" }).click();
    const field = screen.getByLabelText("Hex");
    await field.fill("bogus");
    await expect.element(screen.getByRole("button", { name: "Apply" })).toBeDisabled();
    await screen.getByRole("button", { name: "Cancel" }).click();
    expect(onChange).not.toHaveBeenCalled();
    expect(rootStyle().getPropertyValue("--sel-bg")).toBe("");
  });

  it("copies the hue onto another row on drop, keeping the target's opacity", async () => {
    const onChange = vi.fn();
    const screen = await render(<AppearanceSettings settings={settings()} onChange={onChange} />);
    const rows = screen.getByRole("listitem").all();
    const source = rows[0].getByRole("button", { name: "Selected row color" });
    await userEvent.dragAndDrop(source, rows[1]);

    expect(onChange.mock.calls[0][0].highlightColors).toEqual({ multiSelected: "#173a3621" });
    expect(rootStyle().getPropertyValue("--sel-multi-bg")).toBe("#173a3621");
    await expect
      .element(screen.getByRole("dialog", { name: "Selected row color" }))
      .not.toBeInTheDocument();
    await expect.element(source).toHaveAttribute("aria-expanded", "false");
  });

  it("does not save when the committed value equals the current one", async () => {
    const onChange = vi.fn();
    const screen = await render(<AppearanceSettings settings={settings()} onChange={onChange} />);
    await screen.getByRole("button", { name: "Selected row color" }).click();
    await screen.getByRole("button", { name: "Apply" }).click();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("resets one override and clears its custom properties", async () => {
    const onChange = vi.fn();
    const screen = await render(
      <AppearanceSettings settings={settings({ selected: "#ff000080" })} onChange={onChange} />,
    );
    rootStyle().setProperty("--sel-bg", "#ff000080");
    const rows = screen.getByRole("listitem").all();
    await expect.element(rows[1].getByRole("button", { name: "Reset" })).toBeDisabled();
    await rows[0].getByRole("button", { name: "Reset" }).click();
    expect(onChange.mock.calls[0][0].highlightColors).toEqual({});
    expect(rootStyle().getPropertyValue("--sel-bg")).toBe("");
  });

  it("resets everything at once", async () => {
    const onChange = vi.fn();
    const screen = await render(
      <AppearanceSettings
        settings={settings({ selected: "#ff000080", diffAdded: "#11223344" })}
        onChange={onChange}
      />,
    );
    await screen.getByRole("button", { name: "Reset all to defaults" }).click();
    expect(onChange.mock.calls[0][0].highlightColors).toEqual({});
  });

  it("disables Reset all when nothing is overridden", async () => {
    const screen = await render(<AppearanceSettings settings={settings()} onChange={vi.fn()} />);
    await expect
      .element(screen.getByRole("button", { name: "Reset all to defaults" }))
      .toBeDisabled();
  });
});
