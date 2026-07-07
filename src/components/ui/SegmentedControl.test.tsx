import type { CSSProperties } from "react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import "../../styles.css";
import { SegmentedControl } from "./SegmentedControl";

const gallery: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  alignItems: "flex-start",
  gap: "10px",
  padding: "16px",
  width: "320px",
  background: "var(--bg)",
};

function Gallery() {
  return (
    <div style={gallery} data-testid="gallery">
      <SegmentedControl
        options={[
          { value: "pretty", label: "Pretty" },
          { value: "raw", label: "Raw" },
        ]}
        value="pretty"
        onChange={() => {}}
      />
      <SegmentedControl
        options={[
          { value: "split", label: "Side by side" },
          { value: "unified", label: "Unified" },
        ]}
        value="unified"
        onChange={() => {}}
      />
      <SegmentedControl
        options={[
          { value: "request", label: "Request" },
          { value: "response", label: "Response (pending)", disabled: true },
        ]}
        value="request"
        onChange={() => {}}
      />
    </div>
  );
}

function Controlled() {
  const [value, setValue] = useState("hide");
  return (
    <SegmentedControl
      ariaLabel="Non-matching requests"
      options={[
        { value: "hide", label: "Hide" },
        { value: "dim", label: "Dim" },
      ]}
      value={value}
      onChange={setValue}
    />
  );
}

describe("SegmentedControl", () => {
  it("marks the active option with .on and labels the group", async () => {
    const screen = await render(
      <SegmentedControl
        ariaLabel="View"
        options={[
          { value: "a", label: "Alpha" },
          { value: "b", label: "Beta" },
        ]}
        value="b"
        onChange={vi.fn()}
      />,
    );
    await expect.element(screen.getByRole("group", { name: "View" })).toBeVisible();
    await expect.element(screen.getByRole("button", { name: "Beta" })).toHaveClass("on");
    await expect.element(screen.getByRole("button", { name: "Alpha" })).not.toHaveClass("on");
  });

  it("calls onChange with the clicked option's value", async () => {
    const onChange = vi.fn();
    const screen = await render(
      <SegmentedControl
        options={[
          { value: "split", label: "Side by side" },
          { value: "unified", label: "Unified" },
        ]}
        value="split"
        onChange={onChange}
      />,
    );
    await screen.getByRole("button", { name: "Unified" }).click();
    expect(onChange).toHaveBeenCalledWith("unified");
  });

  it("moves the .on selection as the user picks options", async () => {
    const screen = await render(<Controlled />);
    await expect.element(screen.getByRole("button", { name: "Hide" })).toHaveClass("on");
    await screen.getByRole("button", { name: "Dim" }).click();
    await expect.element(screen.getByRole("button", { name: "Dim" })).toHaveClass("on");
    await expect.element(screen.getByRole("button", { name: "Hide" })).not.toHaveClass("on");
  });

  it("does not activate a disabled option", async () => {
    const onChange = vi.fn();
    const screen = await render(
      <SegmentedControl
        options={[
          { value: "request", label: "Request" },
          { value: "response", label: "Response", disabled: true },
        ]}
        value="request"
        onChange={onChange}
      />,
    );
    await expect.element(screen.getByRole("button", { name: "Response" })).toBeDisabled();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("matches the gallery screenshot", async () => {
    const screen = await render(<Gallery />);
    await expect.element(screen.getByTestId("gallery")).toMatchScreenshot("segmented-gallery");
  });
});
