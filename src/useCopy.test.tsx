import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { ToastProvider } from "./toast";
import { useCopy } from "./useCopy";

function Harness({ value }: { value: string }) {
  const copy = useCopy();
  return (
    <button type="button" onClick={() => copy("URL", value)}>
      copy
    </button>
  );
}

describe("useCopy", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("toasts success only after the clipboard write fulfills", async () => {
    const write = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue(undefined);
    const notify = vi.fn();
    const screen = await render(
      <ToastProvider value={notify}>
        <Harness value="https://example.test/a" />
      </ToastProvider>,
    );
    await screen.getByRole("button", { name: "copy" }).click();
    await vi.waitFor(() => expect(notify).toHaveBeenCalledWith("success", "URL copied"));
    expect(write).toHaveBeenCalledWith("https://example.test/a");
  });

  it("toasts an error and never success when the clipboard write rejects", async () => {
    vi.spyOn(navigator.clipboard, "writeText").mockRejectedValue(new Error("denied"));
    const notify = vi.fn();
    const screen = await render(
      <ToastProvider value={notify}>
        <Harness value="https://example.test/a" />
      </ToastProvider>,
    );
    await screen.getByRole("button", { name: "copy" }).click();
    await vi.waitFor(() =>
      expect(notify).toHaveBeenCalledWith("error", expect.stringContaining("denied")),
    );
    expect(notify).not.toHaveBeenCalledWith("success", expect.anything());
  });

  it("toasts info and skips the clipboard when there is nothing to copy", async () => {
    const write = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue(undefined);
    const notify = vi.fn();
    const screen = await render(
      <ToastProvider value={notify}>
        <Harness value="" />
      </ToastProvider>,
    );
    await screen.getByRole("button", { name: "copy" }).click();
    await vi.waitFor(() => expect(notify).toHaveBeenCalledWith("info", "No url to copy"));
    expect(write).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalledWith("success", expect.anything());
  });
});
