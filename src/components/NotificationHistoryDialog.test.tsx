import { describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { NotificationHistoryDialog } from "./NotificationHistoryDialog";
import type { ToastRecord } from "../toast";

function record(overrides: Partial<ToastRecord> = {}): ToastRecord {
  return { id: 1, kind: "info", message: "Proxy stopped", read: false, ...overrides };
}

describe("NotificationHistoryDialog", () => {
  it("shows session history and marks an unread notification as read", async () => {
    const onMarkRead = vi.fn();
    const screen = await render(
      <NotificationHistoryDialog
        history={[record()]}
        unreadCount={1}
        onMarkRead={onMarkRead}
        onMarkAllRead={vi.fn()}
        onClear={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    await expect.element(screen.getByText("Proxy stopped")).toBeVisible();
    await screen.getByRole("button", { name: "Mark read" }).click();
    expect(onMarkRead).toHaveBeenCalledWith(1);
  });

  it("offers bulk read and clear actions", async () => {
    const onMarkAllRead = vi.fn();
    const onClear = vi.fn();
    const screen = await render(
      <NotificationHistoryDialog
        history={[record(), record({ id: 2, message: "Settings saved", read: true })]}
        unreadCount={1}
        onMarkRead={vi.fn()}
        onMarkAllRead={onMarkAllRead}
        onClear={onClear}
        onClose={vi.fn()}
      />,
    );

    await screen.getByRole("button", { name: "Mark all read" }).click();
    await screen.getByRole("button", { name: "Clear all" }).click();
    expect(onMarkAllRead).toHaveBeenCalledOnce();
    expect(onClear).toHaveBeenCalledOnce();
  });

  it("shows an empty session without enabling history actions", async () => {
    const screen = await render(
      <NotificationHistoryDialog
        history={[]}
        unreadCount={0}
        onMarkRead={vi.fn()}
        onMarkAllRead={vi.fn()}
        onClear={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    await expect.element(screen.getByText("No notifications this session.")).toBeVisible();
    await expect.element(screen.getByRole("button", { name: "Mark all read" })).toBeDisabled();
    await expect.element(screen.getByRole("button", { name: "Clear all" })).toBeDisabled();
  });
});
