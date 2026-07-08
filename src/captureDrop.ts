import { useEffect, useRef, useState } from "react";

import { captureExtFromName, hasFileDrag, type CaptureExt } from "./dnd";

/** Read a dropped File as base64 (data-URL prefix stripped) so the bytes can be
 *  handed to the backend over IPC — HTML5 file drops expose the File's bytes,
 *  not a filesystem path like the native picker. `readAsDataURL` handles large
 *  files without the call-stack blow-up of `btoa(String.fromCharCode(...))`. */
export function readFileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("could not read the file"));
    reader.onload = () => {
      const result = typeof reader.result === "string" ? reader.result : "";
      const comma = result.indexOf(",");
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.readAsDataURL(file);
  });
}

interface CaptureDropOptions {
  /** Load a recognised capture file (already validated by extension). */
  onFile: (file: File, ext: CaptureExt) => void;
  /** A file was dropped that isn't a capture we can open. */
  onReject?: (reason: string) => void;
  /** Ignore drops (still swallowed, so the webview never navigates to file://). */
  disabled?: boolean;
}

/**
 * Window-level OS-file drag-drop for capture files (issue #100). Attaches to
 * `window` so the whole surface is a drop target, and keys off `"Files"` in
 * `dataTransfer.types` so it never touches the in-app row / rule / colour drags
 * (which carry a custom MIME instead). Returns whether a file is hovering, for
 * a drop overlay.
 *
 * Works cross-platform on `dragDropEnabled: false` (which the app keeps so the
 * in-app HTML5 drags survive on Windows): WebKitGTK, macOS WKWebView, and —
 * because wry only calls `SetAllowExternalDrop(false)` when its native handler
 * is registered — Windows WebView2 all deliver OS file drops to the DOM.
 */
export function useCaptureDrop(opts: CaptureDropOptions): { dragging: boolean } {
  const [dragging, setDragging] = useState(false);
  const depth = useRef(0);
  const ref = useRef(opts);
  ref.current = opts;

  useEffect(() => {
    const isFileDrag = (e: DragEvent) => !!e.dataTransfer && hasFileDrag(e.dataTransfer.types);

    const onEnter = (e: DragEvent) => {
      if (!isFileDrag(e)) return;
      e.preventDefault();
      depth.current += 1;
      if (!ref.current.disabled) setDragging(true);
    };
    const onOver = (e: DragEvent) => {
      if (!isFileDrag(e)) return;
      // preventDefault is what makes the window a drop target; without it the
      // webview navigates to file:// on drop instead of firing `drop`.
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = ref.current.disabled ? "none" : "copy";
    };
    const onLeave = (e: DragEvent) => {
      if (!isFileDrag(e)) return;
      depth.current = Math.max(0, depth.current - 1);
      if (depth.current === 0) setDragging(false);
    };
    const onDrop = (e: DragEvent) => {
      if (!isFileDrag(e)) return;
      e.preventDefault();
      depth.current = 0;
      setDragging(false);
      if (ref.current.disabled) return;
      const file = e.dataTransfer?.files[0];
      if (!file) return;
      const ext = captureExtFromName(file.name);
      if (!ext) {
        ref.current.onReject?.(`"${file.name}" isn't a .har or .saz capture file`);
        return;
      }
      ref.current.onFile(file, ext);
    };

    window.addEventListener("dragenter", onEnter);
    window.addEventListener("dragover", onOver);
    window.addEventListener("dragleave", onLeave);
    window.addEventListener("drop", onDrop);
    return () => {
      window.removeEventListener("dragenter", onEnter);
      window.removeEventListener("dragover", onOver);
      window.removeEventListener("dragleave", onLeave);
      window.removeEventListener("drop", onDrop);
    };
  }, []);

  return { dragging };
}
