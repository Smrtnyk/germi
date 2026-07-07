import type { CSSProperties } from "react";
import { describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import "../../styles.css";
import { IconArrowDown, IconArrowUp, IconClose } from "../icons";
import { IconButton } from "./IconButton";

const gallery: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "10px",
  padding: "16px",
  width: "220px",
  background: "var(--bg-1)",
};

function Gallery() {
  return (
    <div style={gallery} data-testid="gallery">
      <IconButton label="Move up">
        <IconArrowUp />
      </IconButton>
      <IconButton label="Move down">
        <IconArrowDown />
      </IconButton>
      <IconButton label="Close">
        <IconClose />
      </IconButton>
      <IconButton label="Remove" danger>
        <IconClose />
      </IconButton>
      <IconButton label="Disabled" disabled>
        <IconClose />
      </IconButton>
    </div>
  );
}

describe("IconButton", () => {
  it("uses label as the accessible name and default tooltip", async () => {
    const screen = await render(
      <IconButton label="Clear filter">
        <IconClose />
      </IconButton>,
    );
    const btn = screen.getByRole("button", { name: "Clear filter" });
    await expect.element(btn).toHaveClass("icon-btn");
    await expect.element(btn).toHaveAttribute("title", "Clear filter");
    await expect.element(btn).toHaveAttribute("type", "button");
  });

  it("keeps an explicit title distinct from the label, and marks danger", async () => {
    const screen = await render(
      <IconButton label="Remove host" title="Remove example.com" danger>
        <IconClose />
      </IconButton>,
    );
    const btn = screen.getByRole("button", { name: "Remove host" });
    await expect.element(btn).toHaveClass("danger");
    await expect.element(btn).toHaveAttribute("title", "Remove example.com");
  });

  it("fires onClick, but not when disabled", async () => {
    const onClick = vi.fn();
    const enabled = await render(
      <IconButton label="Go" onClick={onClick}>
        <IconClose />
      </IconButton>,
    );
    await enabled.getByRole("button", { name: "Go" }).click();
    expect(onClick).toHaveBeenCalledOnce();
    await enabled.unmount();

    const off = vi.fn();
    const disabled = await render(
      <IconButton label="Nope" disabled onClick={off}>
        <IconClose />
      </IconButton>,
    );
    await expect.element(disabled.getByRole("button", { name: "Nope" })).toBeDisabled();
    expect(off).not.toHaveBeenCalled();
  });

  it("matches the gallery screenshot", async () => {
    const screen = await render(<Gallery />);
    await expect.element(screen.getByTestId("gallery")).toMatchScreenshot("iconbutton-gallery");
  });
});
