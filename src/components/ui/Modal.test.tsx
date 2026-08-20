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

function clickBackdrop(dialog: HTMLDialogElement) {
  const rect = dialog.getBoundingClientRect();
  dialog.dispatchEvent(
    new MouseEvent("click", {
      bubbles: true,
      clientX: rect.left - 1,
      clientY: rect.top - 1,
    }),
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

  it("can block Escape dismissal while an async action is pending", async () => {
    const onClose = vi.fn();
    const shouldCloseOnRequest = vi.fn(() => true);
    await render(
      <Modal
        onClose={onClose}
        ariaLabel="Saving settings"
        dismissible={false}
        shouldCloseOnRequest={shouldCloseOnRequest}
      >
        <p>Saving…</p>
      </Modal>,
    );
    await userEvent.keyboard("{Escape}");
    expect(onClose).not.toHaveBeenCalled();
    expect(shouldCloseOnRequest).not.toHaveBeenCalled();
  });

  it("can intercept an Escape close request before the dialog closes", async () => {
    const onClose = vi.fn();
    const shouldCloseOnRequest = vi.fn(() => false);
    await render(
      <Modal
        onClose={onClose}
        ariaLabel="Unsaved settings"
        shouldCloseOnRequest={shouldCloseOnRequest}
      >
        <p>Draft settings</p>
      </Modal>,
    );
    const dialog = document.querySelector("dialog") as HTMLDialogElement;

    await userEvent.keyboard("{Escape}");

    expect(shouldCloseOnRequest).toHaveBeenCalledOnce();
    expect(onClose).not.toHaveBeenCalled();
    expect(dialog.open).toBe(true);
  });

  it("uses the latest close-request policy after rerender", async () => {
    const onClose = vi.fn();
    const stale = vi.fn(() => false);
    const fresh = vi.fn(() => true);
    const screen = await render(
      <Modal onClose={onClose} ariaLabel="Policy dialog" shouldCloseOnRequest={stale}>
        <p>Policy content</p>
      </Modal>,
    );
    await screen.rerender(
      <Modal onClose={onClose} ariaLabel="Policy dialog" shouldCloseOnRequest={fresh}>
        <p>Policy content</p>
      </Modal>,
    );

    await userEvent.keyboard("{Escape}");

    expect(fresh).toHaveBeenCalledOnce();
    expect(stale).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("keeps backdrop clicks inert by default without blocking Escape", async () => {
    const onClose = vi.fn();
    const screen = await render(
      <Modal onClose={onClose} ariaLabel="Settings">
        <p>Draft settings</p>
      </Modal>,
    );
    const dialog = document.querySelector("dialog") as HTMLDialogElement;

    await expect
      .element(screen.getByRole("dialog", { name: "Settings" }))
      .toHaveAttribute("closedby", "closerequest");
    clickBackdrop(dialog);
    expect(onClose).not.toHaveBeenCalled();
    expect(dialog.open).toBe(true);

    await userEvent.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("can explicitly opt into backdrop dismissal", async () => {
    const onClose = vi.fn();
    const screen = await render(
      <Modal onClose={onClose} ariaLabel="Light dismiss" backdropDismissible>
        <p>Dismiss me</p>
      </Modal>,
    );
    const dialog = document.querySelector(
      'dialog[aria-label="Light dismiss"]',
    ) as HTMLDialogElement;
    await expect
      .element(screen.getByRole("dialog", { name: "Light dismiss" }))
      .toHaveAttribute("closedby", "any");

    clickBackdrop(dialog);

    await vi.waitFor(() => expect(onClose).toHaveBeenCalledOnce());
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
