import { describe, expect, it } from "vitest";
import { render } from "vitest-browser-react";

import { RuleTester } from "./RuleTester";

describe("RuleTester", () => {
  it("resets stale rule seeds when the next matcher has no method or URL", async () => {
    const screen = await render(
      <RuleTester
        scenarioId="specific"
        seedMethod="POST"
        seedUrl="https://example.test/specific"
      />,
    );
    await expect.element(screen.getByRole("combobox")).toHaveValue("POST");
    await expect
      .element(screen.getByPlaceholder("https://host/path"))
      .toHaveValue("https://example.test/specific");

    await screen.rerender(<RuleTester scenarioId="wildcard" />);

    await expect.element(screen.getByRole("combobox")).toHaveValue("GET");
    await expect
      .element(screen.getByPlaceholder("https://host/path"))
      .toHaveValue("https://api.example.com/health");
  });
});
