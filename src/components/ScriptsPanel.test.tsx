import { describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import {
  ScriptsPanel,
  type ScriptsPanelActions,
  type ScriptsPanelModel,
  type ScriptsPanelProps,
} from "./ScriptsPanel";
import type { Script } from "../types";

function script(id: string, name: string, enabled = true): Script {
  return { id, name, enabled, source: "fn on_response(req, res) {}" };
}

function props(
  overrides: {
    model?: Partial<ScriptsPanelModel>;
    actions?: Partial<ScriptsPanelActions>;
  } = {},
): ScriptsPanelProps {
  return {
    model: {
      scripts: [script("s1", "CORS"), script("s2", "Debug headers", false)],
      selectedId: null,
      errors: new Map(),
      ...overrides.model,
    },
    actions: {
      onSelect: vi.fn(),
      onAdd: vi.fn(),
      onInsertExample: vi.fn(),
      onDelete: vi.fn(),
      onToggle: vi.fn(),
      onRename: vi.fn(),
      onSourceChange: vi.fn(),
      ...overrides.actions,
    },
  };
}

describe("ScriptsPanel", () => {
  it("lists the scripts and reflects their enabled state", async () => {
    const screen = await render(<ScriptsPanel {...props()} />);
    await expect.element(screen.getByText("CORS")).toBeVisible();
    await expect.element(screen.getByRole("checkbox", { name: "Enable CORS" })).toBeChecked();
    await expect
      .element(screen.getByRole("checkbox", { name: "Enable Debug headers" }))
      .not.toBeChecked();
  });

  it("adds a blank script from the New button", async () => {
    const p = props();
    const screen = await render(<ScriptsPanel {...p} />);
    await screen.getByRole("button", { name: "New" }).click();
    expect(p.actions.onAdd).toHaveBeenCalledOnce();
  });

  it("shows the guide (API + examples) and inserts an example", async () => {
    const p = props();
    // Nothing selected, so the guide is the default view.
    const screen = await render(<ScriptsPanel {...p} />);
    await expect.element(screen.getByRole("heading", { name: "Examples" })).toBeVisible();
    await screen.getByRole("button", { name: "Insert CORS for mocks" }).click();
    expect(p.actions.onInsertExample).toHaveBeenCalledWith(expect.objectContaining({ id: "cors" }));
  });

  it("selects, toggles and deletes by row", async () => {
    const p = props();
    const screen = await render(<ScriptsPanel {...p} />);
    await screen.getByText("CORS").click();
    expect(p.actions.onSelect).toHaveBeenCalledWith("s1");
    await screen.getByRole("checkbox", { name: "Enable Debug headers" }).click();
    expect(p.actions.onToggle).toHaveBeenCalledWith("s2");
    await screen.getByRole("button", { name: "Delete CORS" }).click();
    expect(p.actions.onDelete).toHaveBeenCalledWith("s1");
  });

  it("flags a script that failed to compile", async () => {
    const screen = await render(
      <ScriptsPanel {...props({ model: { errors: new Map([["s2", "line 2: syntax error"]]) } })} />,
    );
    await expect.element(screen.getByTitle("line 2: syntax error")).toBeVisible();
  });

  it("surfaces persistence failures", async () => {
    const screen = await render(<ScriptsPanel {...props({ model: { saveError: "disk full" } })} />);
    await expect
      .element(screen.getByRole("alert"))
      .toHaveTextContent("Scripts were not saved: disk full");
  });

  it("shows the editor for the selected script and toggles the guide", async () => {
    const p = props({ model: { selectedId: "s1" } });
    const screen = await render(<ScriptsPanel {...p} />);
    await expect.element(screen.getByRole("textbox", { name: "Script name" })).toHaveValue("CORS");
    await screen.getByRole("button", { name: "Guide" }).click();
    await expect.element(screen.getByRole("heading", { name: "Examples" })).toBeVisible();
  });

  it("offers the pop-out action only when onPopOut is provided", async () => {
    const onPopOut = vi.fn();
    const screen = await render(<ScriptsPanel {...props({ actions: { onPopOut } })} />);
    await screen.getByRole("button", { name: "Open window" }).click();
    expect(onPopOut).toHaveBeenCalledOnce();
  });

  it("replaces the editor with a read-only placeholder while the scripts window is open", async () => {
    const screen = await render(
      <ScriptsPanel
        {...props({
          model: { selectedId: "s1", poppedOut: true },
          actions: { onFocusWindow: vi.fn() },
        })}
      />,
    );
    await expect.element(screen.getByText(/Editing in the scripts window/)).toBeVisible();
    await expect
      .element(screen.getByRole("checkbox", { name: "Enable CORS" }))
      .not.toBeInTheDocument();
    await expect
      .element(screen.getByRole("textbox", { name: "Script name" }))
      .not.toBeInTheDocument();
    await expect.element(screen.getByRole("button", { name: "New" })).not.toBeInTheDocument();
  });

  it("focuses the scripts window from the placeholder", async () => {
    const onFocusWindow = vi.fn();
    const screen = await render(
      <ScriptsPanel {...props({ model: { poppedOut: true }, actions: { onFocusWindow } })} />,
    );
    await screen.getByRole("button", { name: "Focus window" }).click();
    expect(onFocusWindow).toHaveBeenCalledOnce();
  });
});
