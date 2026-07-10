import type { Notify } from "./toast";
import { useToast } from "./toast";

export async function copyText(notify: Notify, label: string, value: string): Promise<void> {
  if (!value) {
    notify("info", `No ${label.toLowerCase()} to copy`);
    return;
  }
  try {
    await navigator.clipboard.writeText(value);
    notify("success", `${label} copied`);
  } catch (e) {
    notify("error", `Copy to clipboard failed — ${String(e)}`);
  }
}

export function useCopy() {
  const notify = useToast();
  return (label: string, value: string) => {
    void copyText(notify, label, value);
  };
}
