import type { CSSProperties } from "react";
import { describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import "../../styles.css";
import { Button } from "./Button";
import { loadScreenshotFont } from "./screenshotFont";

const gallery: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  alignItems: "center",
  gap: "8px",
  padding: "16px",
  width: "460px",
  background: "var(--bg)",
};

function Gallery() {
  return (
    <div style={gallery} data-testid="gallery">
      <Button>Default</Button>
      <Button variant="primary">Primary</Button>
      <Button variant="ghost">Ghost</Button>
      <Button danger>Danger</Button>
      <Button active>Active</Button>
      <Button variant="ghost" danger>
        Ghost danger
      </Button>
      <Button size="small">Small</Button>
      <Button variant="primary" size="small">
        Primary sm
      </Button>
      <Button disabled>Disabled</Button>
    </div>
  );
}

describe("Button", () => {
  it("maps props to the shared .btn design-system classes", async () => {
    const screen = await render(
      <>
        <Button>Plain</Button>
        <Button variant="primary" active size="small" block danger className="mock-btn">
          Loaded
        </Button>
      </>,
    );
    await expect.element(screen.getByRole("button", { name: "Plain" })).toHaveClass("btn");
    const loaded = screen.getByRole("button", { name: "Loaded" });
    for (const cls of ["btn", "primary", "active", "small", "block", "danger", "mock-btn"]) {
      await expect.element(loaded).toHaveClass(cls);
    }
  });

  it("defaults to type=button and fires onClick", async () => {
    const onClick = vi.fn();
    const screen = await render(<Button onClick={onClick}>Go</Button>);
    const btn = screen.getByRole("button", { name: "Go" });
    await expect.element(btn).toHaveAttribute("type", "button");
    await btn.click();
    expect(onClick).toHaveBeenCalledOnce();
  });

  it("renders a disabled button that cannot be activated", async () => {
    const onClick = vi.fn();
    const screen = await render(
      <Button disabled onClick={onClick}>
        Nope
      </Button>,
    );
    await expect.element(screen.getByRole("button", { name: "Nope" })).toBeDisabled();
    expect(onClick).not.toHaveBeenCalled();
  });

  it("matches the variant gallery screenshot", async () => {
    await loadScreenshotFont();
    const screen = await render(<Gallery />);
    await expect.element(screen.getByTestId("gallery")).toMatchScreenshot("button-gallery");
  });
});
