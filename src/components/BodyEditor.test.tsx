import { describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import "../styles.css";
import { applyAppearance } from "../theme";
import { BodyEditor } from "./BodyEditor";

describe("BodyEditor theme", () => {
  it("switches a mounted CodeMirror between real dark and light editor themes", async () => {
    applyAppearance("dark", {});
    const screen = await render(
      <BodyEditor value={'{"ok":true}'} onChange={vi.fn()} contentType="application/json" />,
    );
    const editor = screen.container.querySelector(".cm-editor") as HTMLElement;
    const darkBackground = getComputedStyle(editor).backgroundColor;
    expect(darkBackground).toBe("rgb(40, 44, 52)");
    expect(getComputedStyle(editor).color).toBe("rgb(171, 178, 191)");

    applyAppearance("light", {});

    await vi.waitFor(() => {
      expect(getComputedStyle(editor).backgroundColor).toBe("rgb(255, 255, 255)");
    });
    expect(getComputedStyle(editor).backgroundColor).not.toBe(darkBackground);
  });
});
