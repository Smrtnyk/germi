import { userEvent } from "vitest/browser";
import { describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import "../../styles.css";
import { Button } from "./Button";
import { Modal } from "./Modal";
import { loadScreenshotFont } from "./screenshotFont";

function Confirm({ onClose }: { onClose: () => void }) {
  return (
    <Modal onClose={onClose} className="confirm-modal" ariaLabelledby="m-title">
      {(close) => (
        <>
          <h3 id="m-title">Delete scenario?</h3>
          <p className="muted">This cannot be undone.</p>
          <div className="modal-foot">
            <Button onClick={close}>Cancel</Button>
            <Button variant="primary" danger>
              Delete
            </Button>
          </div>
        </>
      )}
    </Modal>
  );
}

describe("Modal", () => {
  it("shows its content in an open dialog with the .modal chrome", async () => {
    const screen = await render(<Confirm onClose={vi.fn()} />);
    await expect.element(screen.getByRole("heading", { name: "Delete scenario?" })).toBeVisible();
    await expect.element(screen.getByRole("dialog")).toHaveClass("modal");
    await expect.element(screen.getByRole("dialog")).toHaveClass("confirm-modal");
  });

  it("closes (firing onClose) when the render-prop close() is invoked", async () => {
    const onClose = vi.fn();
    const screen = await render(<Confirm onClose={onClose} />);
    await screen.getByRole("button", { name: "Cancel" }).click();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("treats Escape as a close", async () => {
    const onClose = vi.fn();
    await render(<Confirm onClose={onClose} />);
    await userEvent.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("invokes the latest onClose when the prop changes after mount", async () => {
    const stale = vi.fn();
    const fresh = vi.fn();
    const screen = await render(<Confirm onClose={stale} />);
    await screen.rerender(<Confirm onClose={fresh} />);
    await userEvent.keyboard("{Escape}");
    expect(fresh).toHaveBeenCalledOnce();
    expect(stale).not.toHaveBeenCalled();
  });

  it("accepts static (non-render-prop) children", async () => {
    const screen = await render(
      <Modal onClose={vi.fn()} ariaLabel="Info">
        <p>Just some content.</p>
      </Modal>,
    );
    await expect.element(screen.getByText("Just some content.")).toBeVisible();
    await expect.element(screen.getByRole("dialog", { name: "Info" })).toBeVisible();
  });

  it("matches the modal card screenshot", async () => {
    await loadScreenshotFont();
    const screen = await render(<Confirm onClose={vi.fn()} />);
    await expect.element(screen.getByRole("dialog")).toMatchScreenshot("modal-card");
  });
});
