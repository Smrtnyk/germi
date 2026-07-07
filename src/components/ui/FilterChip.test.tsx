import type { CSSProperties } from "react";
import { describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import "../../styles.css";
import { FilterChip } from "./FilterChip";
import { loadScreenshotFont } from "./screenshotFont";

const gallery: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  alignItems: "center",
  gap: "6px",
  padding: "16px",
  width: "330px",
  background: "var(--bg)",
};

const STATUS = ["2xx", "3xx", "4xx", "5xx"];

function Gallery() {
  return (
    <div style={gallery} data-testid="gallery">
      <FilterChip>Doc</FilterChip>
      <FilterChip on>XHR</FilterChip>
      <FilterChip>JS</FilterChip>
      {STATUS.map((s) => (
        <FilterChip key={s} status={s} on>
          {s}
        </FilterChip>
      ))}
      {STATUS.map((s) => (
        <FilterChip key={`off-${s}`} status={s}>
          {s}
        </FilterChip>
      ))}
    </div>
  );
}

describe("FilterChip", () => {
  it("adds .on and the status tint class only when set", async () => {
    const screen = await render(
      <>
        <FilterChip>Plain</FilterChip>
        <FilterChip status="4xx" on>
          Hot
        </FilterChip>
      </>,
    );
    await expect.element(screen.getByRole("button", { name: "Plain" })).toHaveClass("fchip");
    await expect.element(screen.getByRole("button", { name: "Plain" })).not.toHaveClass("on");
    const hot = screen.getByRole("button", { name: "Hot" });
    for (const cls of ["fchip", "s-4xx", "on"]) {
      await expect.element(hot).toHaveClass(cls);
    }
  });

  it("fires onClick and forwards a passthrough className", async () => {
    const onClick = vi.fn();
    const screen = await render(
      <FilterChip className="save-filter" onClick={onClick}>
        Save
      </FilterChip>,
    );
    const chip = screen.getByRole("button", { name: "Save" });
    await expect.element(chip).toHaveClass("save-filter");
    await chip.click();
    expect(onClick).toHaveBeenCalledOnce();
  });

  it("matches the gallery screenshot", async () => {
    await loadScreenshotFont();
    const screen = await render(<Gallery />);
    await expect.element(screen.getByTestId("gallery")).toMatchScreenshot("filterchip-gallery");
  });
});
