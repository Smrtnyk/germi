import { describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { useCaptureDrop } from "./captureDrop";
import { FLOW_DRAG_MIME } from "./dnd";

function Harness(props: Parameters<typeof useCaptureDrop>[0]) {
  const { dragging } = useCaptureDrop(props);
  return <div>{dragging ? "dragging" : "idle"}</div>;
}

/** A DataTransfer carrying an OS file — `items.add(File)` makes `types` include
 *  the synthetic "Files" entry, exactly like a real filesystem drag. */
function fileTransfer(name: string): DataTransfer {
  const dt = new DataTransfer();
  dt.items.add(new File(["{}"], name, { type: "application/json" }));
  return dt;
}

/** A DataTransfer for an in-app row drag — a custom MIME, no "Files". */
function inAppTransfer(): DataTransfer {
  const dt = new DataTransfer();
  dt.setData(FLOW_DRAG_MIME, "[]");
  return dt;
}

/** Dispatch a drag event on `window` (where the hook listens) with a controlled
 *  dataTransfer. Returns true if a listener called preventDefault (i.e. the drop
 *  was swallowed so the webview can't navigate to the file). */
function dispatchDrag(type: string, dataTransfer: DataTransfer): boolean {
  const ev = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(ev, "dataTransfer", { value: dataTransfer, configurable: true });
  return !window.dispatchEvent(ev);
}

describe("useCaptureDrop", () => {
  it("shows the overlay for a file drag and loads a recognised capture on drop", async () => {
    const onFile = vi.fn();
    const onReject = vi.fn();
    const screen = await render(<Harness onFile={onFile} onReject={onReject} />);

    dispatchDrag("dragenter", fileTransfer("session.har"));
    await expect.element(screen.getByText("dragging")).toBeVisible();

    dispatchDrag("drop", fileTransfer("session.har"));
    await expect.element(screen.getByText("idle")).toBeVisible();
    expect(onFile).toHaveBeenCalledTimes(1);
    expect(onFile.mock.calls[0][0]).toBeInstanceOf(File);
    expect(onFile.mock.calls[0][1]).toBe("har");
    expect(onReject).not.toHaveBeenCalled();
    await screen.unmount();
  });

  it("rejects a dropped file that isn't a capture, without loading", async () => {
    const onFile = vi.fn();
    const onReject = vi.fn();
    const screen = await render(<Harness onFile={onFile} onReject={onReject} />);

    dispatchDrag("drop", fileTransfer("photo.png"));
    expect(onReject).toHaveBeenCalledTimes(1);
    expect(onFile).not.toHaveBeenCalled();
    await screen.unmount();
  });

  it("leaves the in-app row drag alone (no overlay, no preventDefault)", async () => {
    const onFile = vi.fn();
    const screen = await render(<Harness onFile={onFile} />);

    dispatchDrag("dragenter", inAppTransfer());
    expect(screen.getByText("dragging").elements()).toHaveLength(0);
    const swallowed = dispatchDrag("drop", inAppTransfer());
    expect(onFile).not.toHaveBeenCalled();
    expect(swallowed).toBe(false);
    await screen.unmount();
  });

  it("swallows the drop but does not load when disabled", async () => {
    const onFile = vi.fn();
    const screen = await render(<Harness onFile={onFile} disabled />);

    dispatchDrag("dragenter", fileTransfer("session.har"));
    expect(screen.getByText("dragging").elements()).toHaveLength(0);
    const swallowed = dispatchDrag("drop", fileTransfer("session.har"));
    expect(onFile).not.toHaveBeenCalled();
    expect(swallowed).toBe(true);
    await screen.unmount();
  });
});
