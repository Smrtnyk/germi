import { page } from "vitest/browser";
import { describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { ToastHost, useToasts, type Toast, type ToastKind } from "./toast";

interface HarnessItem {
  kind: ToastKind;
  message: string;
}

function Harness({ items }: { items: HarnessItem[] }) {
  const { toasts, notify, dismiss } = useToasts();
  return (
    <div>
      {items.map((item, i) => (
        <button key={i} onClick={() => notify(item.kind, item.message)}>
          push {i}
        </button>
      ))}
      <ToastHost toasts={toasts} onDismiss={dismiss} />
    </div>
  );
}

describe("ToastHost", () => {
  it("renders nothing when there are no toasts", async () => {
    await render(<ToastHost toasts={[]} onDismiss={vi.fn()} />);
    await expect
      .element(page.getByRole("region", { name: "Notifications" }))
      .not.toBeInTheDocument();
  });

  it("renders each toast with its message, status role and kind icon", async () => {
    const toasts: Toast[] = [
      { id: 1, kind: "success", message: "Saved it" },
      { id: 2, kind: "error", message: "It broke" },
      { id: 3, kind: "info", message: "Heads up" },
    ];
    const screen = await render(<ToastHost toasts={toasts} onDismiss={vi.fn()} />);
    await expect.element(screen.getByText("Saved it")).toBeVisible();
    await expect.element(screen.getByText("It broke")).toBeVisible();
    await expect.element(screen.getByText("Heads up")).toBeVisible();
    await expect.element(screen.getByText("✓")).toBeVisible();
    await expect.element(screen.getByText("⚠")).toBeVisible();
    await expect.element(screen.getByText("ℹ")).toBeVisible();
    expect(document.querySelectorAll(".toast[role='status']")).toHaveLength(3);
  });

  it("calls onDismiss with the toast id when its dismiss button is clicked", async () => {
    const onDismiss = vi.fn();
    const toasts: Toast[] = [{ id: 7, kind: "info", message: "Hey" }];
    const screen = await render(<ToastHost toasts={toasts} onDismiss={onDismiss} />);
    await screen.getByRole("button", { name: "Dismiss notification" }).click();
    expect(onDismiss).toHaveBeenCalledWith(7);
  });
});

describe("useToasts", () => {
  it("maps a known OS error into a friendly message", async () => {
    const screen = await render(
      <Harness items={[{ kind: "error", message: "Error: os error 98" }]} />,
    );
    await screen.getByRole("button", { name: "push 0" }).click();
    await expect
      .element(
        screen.getByText("That port is already in use — pick another in Settings → Connections."),
      )
      .toBeVisible();
    await expect.element(screen.getByText("Error: os error 98")).not.toBeInTheDocument();
  });

  it("shows a non-error message unchanged", async () => {
    const screen = await render(<Harness items={[{ kind: "success", message: "Saved" }]} />);
    await screen.getByRole("button", { name: "push 0" }).click();
    await expect.element(screen.getByText("Saved")).toBeVisible();
  });

  it("keeps only the last four toasts when more are pushed", async () => {
    const items: HarnessItem[] = [0, 1, 2, 3, 4].map((i) => ({
      kind: "info",
      message: `msg ${i}`,
    }));
    const screen = await render(<Harness items={items} />);
    for (const i of [0, 1, 2, 3, 4]) {
      await screen.getByRole("button", { name: `push ${i}` }).click();
    }
    expect(document.querySelectorAll(".toast")).toHaveLength(4);
    await expect.element(screen.getByText("msg 0")).not.toBeInTheDocument();
    await expect.element(screen.getByText("msg 4")).toBeVisible();
  });

  it("removes a toast when its dismiss button is clicked", async () => {
    const screen = await render(<Harness items={[{ kind: "info", message: "Hi there" }]} />);
    await screen.getByRole("button", { name: "push 0" }).click();
    await expect.element(screen.getByText("Hi there")).toBeVisible();
    await screen.getByRole("button", { name: "Dismiss notification" }).click();
    await expect.element(screen.getByText("Hi there")).not.toBeInTheDocument();
  });
});
