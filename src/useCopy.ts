import { useToast } from "./toast";

export function useCopy() {
  const notify = useToast();
  return (label: string, value: string) => {
    if (!value) {
      notify("info", `No ${label.toLowerCase()} to copy`);
      return;
    }
    void navigator.clipboard.writeText(value);
    notify("success", `${label} copied`);
  };
}
