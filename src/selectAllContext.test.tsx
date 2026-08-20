import { useEffect } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";

import { selectAllContext } from "./selectAllContext";
import { VirtualText } from "./components/FlowInspector";
import "./styles.css";

const LONG_BODY = Array.from({ length: 500 }, (_, index) => `body line ${index}`).join("\n");

function Harness({ onSelectAll }: { onSelectAll: () => void }) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (selectAllContext(event, ".owned-list") !== "list") return;
      event.preventDefault();
      onSelectAll();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onSelectAll]);

  return (
    <div>
      <div className="owned-list" role="listbox" tabIndex={0} aria-label="Requests">
        <div role="option" aria-selected="false">
          GET /api/items
        </div>
      </div>
      <input aria-label="Filter" defaultValue="query" />
      <textarea aria-label="Request body" defaultValue="payload" />
      <div role="textbox" contentEditable tabIndex={0} suppressContentEditableWarning>
        editable text
      </div>
      <div className="cm-editor">
        <div
          className="cm-content"
          role="textbox"
          contentEditable
          tabIndex={0}
          suppressContentEditableWarning
        >
          editor text
        </div>
      </div>
      <div style={{ width: "400px", height: "120px", display: "flex" }}>
        <VirtualText text={LONG_BODY} />
      </div>
      <div data-select-all="native" data-testid="request-url">
        https://example.com/api/items
      </div>
      <div data-select-all="native" data-testid="response-headers">
        content-type: application/json
      </div>
      <button type="button">Unrelated action</button>
    </div>
  );
}

afterEach(() => window.getSelection()?.removeAllRanges());

describe("context-sensitive select-all", () => {
  it("uses the composed path to preserve an editor hidden behind a retargeted host", () => {
    const host = document.createElement("div");
    host.className = "owned-list";
    const shadow = host.attachShadow({ mode: "open" });
    const input = document.createElement("input");
    shadow.append(input);
    document.body.append(host);
    let context = "none";
    host.addEventListener("keydown", (event) => {
      context = selectAllContext(event, ".owned-list");
    });

    input.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "a",
        ctrlKey: true,
        bubbles: true,
        composed: true,
      }),
    );

    expect(context).toBe("native");
    host.remove();
  });

  it("does not let an owning list claim shortcuts from a dialog", () => {
    const dialog = document.createElement("dialog");
    dialog.className = "owned-list";
    const button = document.createElement("button");
    dialog.append(button);
    document.body.append(dialog);
    let context = "none";
    dialog.addEventListener("keydown", (event) => {
      context = selectAllContext(event, ".owned-list");
    });

    button.dispatchEvent(
      new KeyboardEvent("keydown", { key: "a", ctrlKey: true, bubbles: true, composed: true }),
    );

    expect(context).toBe("native");
    dialog.remove();
  });

  it("preserves native select-all in inputs and textareas", async () => {
    const onSelectAll = vi.fn();
    const screen = await render(<Harness onSelectAll={onSelectAll} />);

    const input = screen.getByRole("textbox", { name: "Filter" });
    await input.click();
    await userEvent.keyboard("{Control>}a{/Control}");
    expect((input.element() as HTMLInputElement).selectionStart).toBe(0);
    expect((input.element() as HTMLInputElement).selectionEnd).toBe(5);

    const textarea = screen.getByRole("textbox", { name: "Request body" });
    await textarea.click();
    await userEvent.keyboard("{Control>}a{/Control}");
    expect((textarea.element() as HTMLTextAreaElement).selectionStart).toBe(0);
    expect((textarea.element() as HTMLTextAreaElement).selectionEnd).toBe(7);
    expect(onSelectAll).not.toHaveBeenCalled();
  });

  it("preserves contenteditable and CodeMirror-shaped editor shortcuts", async () => {
    const onSelectAll = vi.fn();
    const screen = await render(<Harness onSelectAll={onSelectAll} />);
    const editors = screen.getByRole("textbox").all();

    await editors[2].click();
    await userEvent.keyboard("{Control>}a{/Control}");
    await editors[3].click();
    await userEvent.keyboard("{Control>}a{/Control}");

    expect(onSelectAll).not.toHaveBeenCalled();
  });

  it("selects and copies the complete virtualized body after a zero-selection click", async () => {
    const onSelectAll = vi.fn();
    const screen = await render(<Harness onSelectAll={onSelectAll} />);
    const list = screen.getByRole("listbox");
    (list.element() as HTMLElement).focus();

    const body = screen.getByRole("region", { name: "Body content" });
    await body.click();
    expect(document.activeElement).toBe(body.element());
    window.getSelection()?.removeAllRanges();

    await userEvent.keyboard("{Control>}a{/Control}");
    expect(onSelectAll).not.toHaveBeenCalled();
    const selectionRange = window.getSelection()?.getRangeAt(0);
    expect(selectionRange?.commonAncestorContainer).toBe(body.element());
    expect(document.querySelectorAll(".vline").length).toBeLessThan(500);

    let copied = "";
    const captureCopy = (event: ClipboardEvent) => {
      copied = event.clipboardData?.getData("text/plain") ?? "";
    };
    window.addEventListener("copy", captureCopy);
    try {
      await userEvent.keyboard("{Control>}c{/Control}");
    } finally {
      window.removeEventListener("copy", captureCopy);
    }
    expect(copied).toBe(LONG_BODY);
  });

  it("keeps URL and header text selection out of traffic select-all", async () => {
    const onSelectAll = vi.fn();
    const screen = await render(<Harness onSelectAll={onSelectAll} />);
    const list = screen.getByRole("listbox");
    (list.element() as HTMLElement).focus();

    for (const testId of ["request-url", "response-headers"]) {
      const content = screen.getByTestId(testId).element();
      const range = document.createRange();
      range.selectNodeContents(content);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      await userEvent.keyboard("{Control>}a{/Control}");
    }

    expect(onSelectAll).not.toHaveBeenCalled();
  });

  it("lets the focused owning list claim select-all", async () => {
    const onSelectAll = vi.fn();
    const screen = await render(<Harness onSelectAll={onSelectAll} />);
    (screen.getByRole("listbox").element() as HTMLElement).focus();

    await userEvent.keyboard("{Control>}a{/Control}");
    expect(onSelectAll).toHaveBeenCalledOnce();
  });

  it("does not route select-all from an unrelated control to the list", async () => {
    const onSelectAll = vi.fn();
    const screen = await render(<Harness onSelectAll={onSelectAll} />);
    await screen.getByRole("button", { name: "Unrelated action" }).click();

    await userEvent.keyboard("{Control>}a{/Control}");
    expect(onSelectAll).not.toHaveBeenCalled();
  });
});
