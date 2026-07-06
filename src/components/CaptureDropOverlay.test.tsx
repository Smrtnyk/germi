import { describe, expect, it } from "vitest";
import { render } from "vitest-browser-react";

import { CaptureDropOverlay } from "./CaptureDropOverlay";

describe("CaptureDropOverlay", () => {
  it("renders nothing while inactive", async () => {
    const screen = await render(
      <CaptureDropOverlay active={false} title="Drop here" hint="a hint" />,
    );
    expect(screen.getByText("Drop here").elements()).toHaveLength(0);
    await screen.unmount();
  });

  it("shows the title and hint while a file is dragged over", async () => {
    const screen = await render(
      <CaptureDropOverlay active title="Drop to open this capture" hint=".germi, .har, or .saz" />,
    );
    await expect.element(screen.getByText("Drop to open this capture")).toBeVisible();
    await expect.element(screen.getByText(".germi, .har, or .saz")).toBeVisible();
    await screen.unmount();
  });
});
