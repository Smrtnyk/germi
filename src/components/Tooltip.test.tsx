import { userEvent } from "vitest/browser";
import { describe, expect, it } from "vitest";
import { render } from "vitest-browser-react";

import { Tooltip } from "./Tooltip";

describe("Tooltip", () => {
  it("always renders its children", async () => {
    const screen = await render(
      <Tooltip label="Save the file">
        <button>Save</button>
      </Tooltip>,
    );
    await expect.element(screen.getByRole("button", { name: "Save" })).toBeVisible();
  });

  it("shows no tooltip before the trigger is hovered", async () => {
    const screen = await render(
      <>
        <p>neutral ground</p>
        <Tooltip label="Save the file">
          <button>Save</button>
        </Tooltip>
      </>,
    );
    await userEvent.hover(screen.getByText("neutral ground"));
    await expect.element(screen.getByRole("tooltip")).not.toBeInTheDocument();
  });

  it("reveals the label in a tooltip on hover", async () => {
    const screen = await render(
      <Tooltip label="Save the file">
        <button>Save</button>
      </Tooltip>,
    );
    await userEvent.hover(screen.getByRole("button", { name: "Save" }));
    await expect.element(screen.getByRole("tooltip")).toHaveTextContent("Save the file");
  });

  it("hides the tooltip again when the trigger is unhovered", async () => {
    const screen = await render(
      <Tooltip label="Save the file">
        <button>Save</button>
      </Tooltip>,
    );
    const trigger = screen.getByRole("button", { name: "Save" });
    await userEvent.hover(trigger);
    await expect.element(screen.getByRole("tooltip")).toBeVisible();
    await userEvent.unhover(trigger);
    await expect.element(screen.getByRole("tooltip")).not.toBeInTheDocument();
  });
});
