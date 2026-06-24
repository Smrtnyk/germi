import { beforeEach, describe, expect, it, vi } from "vitest";

const { isPermissionGranted, requestPermission, sendNotification } = vi.hoisted(() => ({
  isPermissionGranted: vi.fn(),
  requestPermission: vi.fn(),
  sendNotification: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-notification", () => ({
  isPermissionGranted,
  requestPermission,
  sendNotification,
}));

beforeEach(() => {
  vi.resetModules();
  isPermissionGranted.mockReset();
  requestPermission.mockReset();
  sendNotification.mockReset();
});

describe("announce", () => {
  it("sends an OS notification and skips the in-app toast when permitted", async () => {
    isPermissionGranted.mockResolvedValue(true);
    const { announce } = await import("./announce");
    const notify = vi.fn();

    await announce(notify, "System proxy on");

    expect(sendNotification).toHaveBeenCalledWith({ title: "Germi", body: "System proxy on" });
    expect(notify).not.toHaveBeenCalled();
  });

  it("requests permission once, then notifies without a toast", async () => {
    isPermissionGranted.mockResolvedValue(false);
    requestPermission.mockResolvedValue("granted");
    const { announce } = await import("./announce");
    const notify = vi.fn();

    await announce(notify, "System proxy off");
    await announce(notify, "System proxy on");

    expect(requestPermission).toHaveBeenCalledTimes(1);
    expect(sendNotification).toHaveBeenCalledTimes(2);
    expect(notify).not.toHaveBeenCalled();
  });

  it("falls back to a toast when notifications are denied", async () => {
    isPermissionGranted.mockResolvedValue(false);
    requestPermission.mockResolvedValue("denied");
    const { announce } = await import("./announce");
    const notify = vi.fn();

    await announce(notify, "System proxy off");

    expect(sendNotification).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith("info", "System proxy off");
  });

  it("falls back to a toast when the notification plugin throws", async () => {
    isPermissionGranted.mockRejectedValue(new Error("no daemon"));
    const { announce } = await import("./announce");
    const notify = vi.fn();

    await announce(notify, "System proxy on");

    expect(notify).toHaveBeenCalledWith("info", "System proxy on");
  });
});
