import { createRef, useEffect } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";

import { installContextualSelectAll, selectAllContext } from "./selectAllContext";
import { FlowInspector, VirtualText } from "./components/FlowInspector";
import { detail, message, summary } from "./flowFixtures";
import type { InspectorFindHandle } from "./inspectorFind";
import "./styles.css";

const LONG_BODY = Array.from({ length: 500 }, (_, index) => `body line ${index}`).join("\n");
const FLOW_SUMMARY = summary();
const FLOW_DETAIL = detail({
  request: message({
    headers: [
      ["x-request-token", "request-secret"],
      ["x-request-trace", "request-trace-value"],
    ],
  }),
  response: message({
    headers: [
      ["x-response-token", "response-secret"],
      ["x-response-trace", "response-trace-value"],
    ],
  }),
});
const INSPECTOR_FIND_REF = createRef<InspectorFindHandle>();

function useTestSelectionPolicy(onSelectAll: () => void): void {
  useEffect(() => {
    const uninstall = installContextualSelectAll();
    const onKeyDown = (event: KeyboardEvent) => {
      if (selectAllContext(event, ".owned-list") !== "list") return;
      event.preventDefault();
      onSelectAll();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      uninstall();
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [onSelectAll]);
}

function Harness({ onSelectAll }: { onSelectAll: () => void }) {
  useTestSelectionPolicy(onSelectAll);

  return (
    <div data-testid="app-chrome">
      <div
        className="owned-list"
        data-select-all="list"
        role="listbox"
        tabIndex={0}
        aria-label="Requests"
      >
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
      <div data-select-all="region" data-testid="request-url">
        https://example.com/api/items
      </div>
      <div data-select-all="region" data-testid="response-headers">
        content-type: application/json
      </div>
      <button type="button">Unrelated action</button>
    </div>
  );
}

function InspectorHarness({ onSelectAll }: { onSelectAll: () => void }) {
  useTestSelectionPolicy(onSelectAll);
  return (
    <div className="right-content" style={{ width: "720px", height: "520px" }}>
      <div className="owned-list" data-select-all="list" tabIndex={0}>
        traffic
      </div>
      <FlowInspector
        active
        detail={FLOW_DETAIL}
        summary={FLOW_SUMMARY}
        loading={false}
        decode
        onMock={() => {}}
        onCopyCurl={() => {}}
        onLoadFull={() => {}}
        selectedSummaries={[FLOW_SUMMARY]}
        onSelectOne={() => {}}
        onMockMany={() => {}}
        onCompare={() => {}}
        onClearSelection={() => {}}
        inspectorFindRef={INSPECTOR_FIND_REF}
        viewer={false}
      />
    </div>
  );
}

function expectSelectionInside(region: Element, included: string[], excluded: string[]): void {
  const selection = window.getSelection();
  expect(selection?.rangeCount).toBe(1);
  const range = selection!.getRangeAt(0);
  expect(region.contains(range.startContainer)).toBe(true);
  expect(region.contains(range.endContainer)).toBe(true);
  for (const text of included) expect(selection!.toString()).toContain(text);
  for (const text of excluded) expect(selection!.toString()).not.toContain(text);
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

  it("consumes select-all from non-editable dialog chrome", () => {
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

    expect(context).toBe("consume");
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

  it("bounds URL selection to the marked URL text", async () => {
    const onSelectAll = vi.fn();
    const screen = await render(<Harness onSelectAll={onSelectAll} />);
    const content = screen.getByTestId("request-url");
    await content.click();
    await userEvent.keyboard("{Control>}a{/Control}");

    expect(onSelectAll).not.toHaveBeenCalled();
    expectSelectionInside(content.element(), ["https://example.com/api/items"], ["GET", "Filter"]);
  });

  it("selects only the clicked request or response header block", async () => {
    const onSelectAll = vi.fn();
    const screen = await render(<InspectorHarness onSelectAll={onSelectAll} />);

    const responseValue = screen.getByText("response-secret");
    await responseValue.click();
    await userEvent.keyboard("{Control>}a{/Control}");
    const responseRegion = responseValue.element().closest('[data-select-all="region"]');
    expect(responseRegion).not.toBeNull();
    expectSelectionInside(
      responseRegion!,
      ["x-response-token", "response-secret", "x-response-trace", "response-trace-value"],
      ["https://example.com/", "x-request-token", "Response", "Copy"],
    );

    await screen.getByRole("button", { name: "Request" }).click();
    const requestValue = screen.getByText("request-secret");
    await requestValue.click();
    await userEvent.keyboard("{Control>}a{/Control}");
    const requestRegion = requestValue.element().closest('[data-select-all="region"]');
    expect(requestRegion).not.toBeNull();
    expectSelectionInside(
      requestRegion!,
      ["x-request-token", "request-secret", "x-request-trace", "request-trace-value"],
      ["https://example.com/", "x-response-token", "Request", "Copy"],
    );
    expect(onSelectAll).not.toHaveBeenCalled();
  });

  it("lets the focused owning list claim select-all", async () => {
    const onSelectAll = vi.fn();
    const screen = await render(<Harness onSelectAll={onSelectAll} />);
    (screen.getByRole("listbox").element() as HTMLElement).focus();

    await userEvent.keyboard("{Control>}a{/Control}");
    expect(onSelectAll).toHaveBeenCalledOnce();
  });

  it("consumes select-all from app chrome without selecting the page", async () => {
    const onSelectAll = vi.fn();
    const screen = await render(<Harness onSelectAll={onSelectAll} />);
    await screen.getByRole("button", { name: "Unrelated action" }).click();
    window.getSelection()?.removeAllRanges();
    let defaultPrevented = false;
    const observe = (event: KeyboardEvent) => {
      if (event.ctrlKey && event.key.toLowerCase() === "a") {
        defaultPrevented = event.defaultPrevented;
      }
    };
    window.addEventListener("keydown", observe);

    try {
      await userEvent.keyboard("{Control>}a{/Control}");
    } finally {
      window.removeEventListener("keydown", observe);
    }
    expect(defaultPrevented).toBe(true);
    expect(window.getSelection()?.rangeCount).toBe(0);
    expect(window.getSelection()?.toString()).toBe("");
    expect(onSelectAll).not.toHaveBeenCalled();
  });
});
