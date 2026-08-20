import { useRef, useState } from "react";
import { describe, expect, it } from "vitest";
import { render } from "vitest-browser-react";

import { FilterHelp } from "./FilterHelp";

function Harness() {
  const [filter, setFilter] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  return (
    <>
      <label htmlFor="traffic-filter">Traffic filter</label>
      <input id="traffic-filter" ref={inputRef} value={filter} onChange={() => {}} />
      <FilterHelp filter={filter} onPick={setFilter} inputRef={inputRef} />
    </>
  );
}

describe("FilterHelp", () => {
  it("documents scoped cookie-pair search and the outer-quote rule", async () => {
    const screen = await render(<Harness />);
    await screen.getByRole("button", { name: "Filter syntax help" }).click();

    await expect
      .element(screen.getByRole("button", { name: "cookie:", exact: true }))
      .toBeVisible();
    await expect
      .element(screen.getByRole("button", { name: "req-cookie:", exact: true }))
      .toBeVisible();
    await expect
      .element(screen.getByRole("button", { name: "resp-cookie:", exact: true }))
      .toBeVisible();
    await expect.element(screen.getByText(/Quote the whole pattern after/)).toBeVisible();
    await expect.element(screen.getByText('req-cookie:"prefs=hello world"')).toBeVisible();
  });

  it("inserts a request cookie token and restores focus to the filter", async () => {
    const screen = await render(<Harness />);
    await screen.getByRole("button", { name: "Filter syntax help" }).click();
    await screen.getByRole("button", { name: "req-cookie:", exact: true }).click();

    const input = screen.getByRole("textbox", { name: "Traffic filter" });
    await expect.element(input).toHaveValue("req-cookie:");
    await expect.element(input).toHaveFocus();
  });

  it("applies a quoted response cookie name-value example as one query", async () => {
    const screen = await render(<Harness />);
    await screen.getByRole("button", { name: "Filter syntax help" }).click();
    await screen.getByRole("button", { name: 'resp-cookie:"sid=a=b/c"' }).click();

    await expect
      .element(screen.getByRole("textbox", { name: "Traffic filter" }))
      .toHaveValue('resp-cookie:"sid=a=b/c"');
  });
});
