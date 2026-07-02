import { describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { page } from "vitest/browser";

import { diffLines } from "../diff";
import { message } from "../flowFixtures";
import { BodyDiffSection, DiffBlock, DiffRows } from "./DiffView";

describe("DiffBlock", () => {
  it("shows +/− counts and colored rows for a changed block", async () => {
    const screen = await render(
      <DiffBlock title="Request" a={"GET /a HTTP/1.1\nHost: x"} b={"GET /b HTTP/1.1\nHost: x"} />,
    );
    await expect.element(screen.getByText("Request")).toBeVisible();
    await expect.element(screen.getByText("+1")).toBeVisible();
    await expect.element(screen.getByText("−1")).toBeVisible();
    await expect.element(screen.getByText("GET /a HTTP/1.1")).toBeVisible();
    await expect.element(screen.getByText("GET /b HTTP/1.1")).toBeVisible();
  });

  it("labels an unchanged block as identical", async () => {
    const screen = await render(
      <DiffBlock title="Response" a="HTTP/1.1 200 OK" b="HTTP/1.1 200 OK" />,
    );
    await expect.element(screen.getByText("identical")).toBeVisible();
  });

  it("renders aligned side-by-side cells in split mode", async () => {
    const screen = await render(
      <DiffBlock title="Request" a={"same\nold"} b={"same\nnew"} mode="split" />,
    );
    await expect.element(screen.getByText("old")).toHaveClass("diff-text");
    const oldCell = screen.getByText("old").element().closest(".diff-cell");
    const newCell = screen.getByText("new").element().closest(".diff-cell");
    expect(oldCell?.classList.contains("del")).toBe(true);
    expect(newCell?.classList.contains("add")).toBe(true);
    expect(oldCell?.parentElement).toBe(newCell?.parentElement);
  });

  it("marks the exact changed span inside a near-identical line pair", async () => {
    const screen = await render(
      <DiffBlock
        title="Request"
        a="X-Feature-Flags: checkout-v2"
        b="X-Feature-Flags: checkout-v3"
        mode="split"
      />,
    );
    const marks = screen.getByText("2", { exact: true });
    await expect.element(marks).toHaveClass("diff-chg");
    await expect.element(screen.getByText("3", { exact: true })).toHaveClass("diff-chg");
  });
});

describe("DiffRows", () => {
  it("folds long unchanged runs and expands them on click", async () => {
    const body = Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n");
    const lines = diffLines(`start\n${body}`, `START\n${body}`);
    const screen = await render(<DiffRows lines={lines} />);
    const fold = screen.getByRole("button", { name: /17 unchanged lines/ });
    await expect.element(fold).toBeVisible();
    await expect.element(page.getByText("line 19")).not.toBeInTheDocument();
    await fold.click();
    await expect.element(screen.getByText("line 19")).toBeVisible();
  });
});

describe("BodyDiffSection", () => {
  const bodies = {
    a: message({ bodyText: '{"config":"blue"}', size: 17 }),
    b: message({ bodyText: '{"config":"green"}', size: 18 }),
  };

  it("reports differing bodies without showing the hunks until toggled", async () => {
    const onToggle = vi.fn();
    const screen = await render(
      <BodyDiffSection
        label="Response body"
        a={bodies.a}
        b={bodies.b}
        equal={false}
        shown={false}
        onToggle={onToggle}
      />,
    );
    await expect.element(screen.getByText("differ · 17 B vs 18 B")).toBeVisible();
    await expect.element(page.getByText('{"config:"blue"}')).not.toBeInTheDocument();
    await screen.getByRole("button", { name: "Show body diff" }).click();
    expect(onToggle).toHaveBeenCalledOnce();
  });

  it("renders the hunks when shown", async () => {
    const screen = await render(
      <BodyDiffSection
        label="Response body"
        a={bodies.a}
        b={bodies.b}
        equal={false}
        shown
        onToggle={vi.fn()}
      />,
    );
    await expect.element(screen.getByText('{"config":"blue"}')).toBeVisible();
    await expect.element(screen.getByText('{"config":"green"}')).toBeVisible();
    await expect.element(screen.getByRole("button", { name: "Hide body diff" })).toBeVisible();
  });

  it("reports identical bodies with one size", async () => {
    const screen = await render(
      <BodyDiffSection
        label="Request body"
        a={message({ bodyText: "x", size: 1 })}
        b={message({ bodyText: "x", size: 1 })}
        equal
        shown={false}
        onToggle={vi.fn()}
      />,
    );
    await expect.element(screen.getByText("identical · 1 B")).toBeVisible();
  });

  it("never offers a text diff for binary bodies", async () => {
    const screen = await render(
      <BodyDiffSection
        label="Response body"
        a={message({ bodyBase64: "AAEC", size: 3 })}
        b={message({ bodyBase64: "AAED", size: 3 })}
        equal={false}
        shown={false}
        onToggle={vi.fn()}
      />,
    );
    await expect.element(screen.getByText(/binary/)).toBeVisible();
    await expect
      .element(page.getByRole("button", { name: "Show body diff" }))
      .not.toBeInTheDocument();
  });

  it("says so when neither side has a body", async () => {
    const screen = await render(
      <BodyDiffSection
        label="Request body"
        a={message()}
        b={message()}
        equal
        shown={false}
        onToggle={vi.fn()}
      />,
    );
    await expect.element(screen.getByText("none on either side")).toBeVisible();
  });
});
