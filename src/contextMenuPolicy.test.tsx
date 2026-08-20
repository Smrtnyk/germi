import { afterEach, describe, expect, it, vi } from "vitest";
import { userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";

import { installDefaultContextMenuBlocker } from "./contextMenuPolicy";

const cleanups: (() => void)[] = [];

function install(): void {
  cleanups.push(installDefaultContextMenuBlocker());
}

function dispatchContextMenu(target: Element): PointerEvent {
  const event = new PointerEvent("contextmenu", {
    bubbles: true,
    button: 2,
    cancelable: true,
    composed: true,
  });
  target.dispatchEvent(event);
  return event;
}

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

describe("default context-menu policy", () => {
  it("blocks pointer and keyboard context menus on unsupported app chrome", async () => {
    install();
    const screen = await render(<button type="button">App chrome</button>);
    const button = screen.getByRole("button", { name: "App chrome" });
    const events: PointerEvent[] = [];
    button.element().addEventListener("contextmenu", (event) => {
      events.push(event as PointerEvent);
    });

    await button.click({ button: "right" });
    expect(events).toHaveLength(1);
    expect(events[0].defaultPrevented).toBe(true);

    button.element().focus();
    await userEvent.keyboard("{Shift>}{F10}{/Shift}");
    expect(events).toHaveLength(2);
    expect(events[1].defaultPrevented).toBe(true);
  });

  it("preserves native menus on text-edit surfaces, including nested editors", async () => {
    install();
    const screen = await render(
      <div>
        <input aria-label="Text input" />
        <textarea aria-label="Text area" />
        <div contentEditable suppressContentEditableWarning>
          <span data-testid="contenteditable-child">Editable</span>
        </div>
        <div className="cm-editor">
          <span data-testid="codemirror-child">CodeMirror</span>
        </div>
        <div role="textbox">
          <span data-testid="textbox-child">Custom editor</span>
        </div>
      </div>,
    );

    const targets = [
      screen.getByRole("textbox", { name: "Text input" }).element(),
      screen.getByRole("textbox", { name: "Text area" }).element(),
      screen.getByTestId("contenteditable-child").element(),
      screen.getByTestId("codemirror-child").element(),
      screen.getByTestId("textbox-child").element(),
    ];
    for (const target of targets) expect(dispatchContextMenu(target).defaultPrevented).toBe(false);
  });

  it("uses the composed path to preserve an editor behind a shadow host", () => {
    install();
    const host = document.createElement("div");
    const shadow = host.attachShadow({ mode: "open" });
    const input = document.createElement("input");
    shadow.append(input);
    document.body.append(host);

    expect(dispatchContextMenu(input).defaultPrevented).toBe(false);
    host.remove();
  });

  it("does not exempt non-text inputs or ordinary selectable text", async () => {
    install();
    const screen = await render(
      <div>
        <input type="checkbox" aria-label="Toggle" />
        <p>Ordinary text</p>
      </div>,
    );

    expect(
      dispatchContextMenu(screen.getByRole("checkbox", { name: "Toggle" }).element())
        .defaultPrevented,
    ).toBe(true);
    expect(dispatchContextMenu(screen.getByText("Ordinary text").element()).defaultPrevented).toBe(
      true,
    );
  });

  it("leaves an existing custom context-menu handler in control", async () => {
    install();
    const onOpen = vi.fn();
    const screen = await render(
      <div
        data-testid="custom-menu-row"
        onContextMenu={(event) => {
          event.preventDefault();
          onOpen();
        }}
      >
        Request row
      </div>,
    );

    const event = new PointerEvent("contextmenu", {
      bubbles: true,
      button: 2,
      cancelable: true,
      composed: true,
    });
    const preventDefault = vi.spyOn(event, "preventDefault");
    screen.getByTestId("custom-menu-row").element().dispatchEvent(event);

    expect(onOpen).toHaveBeenCalledOnce();
    expect(preventDefault).toHaveBeenCalledOnce();
  });

  it("can be cleaned up and installed again without accumulating behavior", () => {
    const firstCleanup = installDefaultContextMenuBlocker();
    firstCleanup();
    firstCleanup();

    const secondCleanup = installDefaultContextMenuBlocker();
    expect(dispatchContextMenu(document.body).defaultPrevented).toBe(true);
    secondCleanup();
    expect(dispatchContextMenu(document.body).defaultPrevented).toBe(false);
  });
});
