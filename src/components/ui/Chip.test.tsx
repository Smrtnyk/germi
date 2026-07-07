import type { CSSProperties } from "react";
import { describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import "../../styles.css";
import { Chip } from "./Chip";
import { loadScreenshotFont } from "./screenshotFont";

const gallery: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  alignItems: "center",
  gap: "6px",
  padding: "16px",
  width: "300px",
  background: "var(--bg)",
};

function Gallery() {
  return (
    <div style={gallery} data-testid="gallery">
      <Chip>200</Chip>
      <Chip on>201</Chip>
      <Chip>301</Chip>
      <Chip>404</Chip>
      <Chip on>500</Chip>
      <Chip disabled>418</Chip>
    </div>
  );
}

describe("Chip", () => {
  it("carries .on only when toggled on", async () => {
    const screen = await render(
      <>
        <Chip>Off</Chip>
        <Chip on>On</Chip>
      </>,
    );
    await expect.element(screen.getByRole("button", { name: "Off" })).not.toHaveClass("on");
    const on = screen.getByRole("button", { name: "On" });
    await expect.element(on).toHaveClass("chip");
    await expect.element(on).toHaveClass("on");
  });

  it("defaults to type=button and fires onClick", async () => {
    const onClick = vi.fn();
    const screen = await render(<Chip onClick={onClick}>Toggle</Chip>);
    const chip = screen.getByRole("button", { name: "Toggle" });
    await expect.element(chip).toHaveAttribute("type", "button");
    await chip.click();
    expect(onClick).toHaveBeenCalledOnce();
  });

  it("matches the gallery screenshot", async () => {
    await loadScreenshotFont();
    const screen = await render(<Gallery />);
    await expect.element(screen.getByTestId("gallery")).toMatchScreenshot("chip-gallery");
  });
});
