import { useMemo } from "react";
import CodeMirror, { EditorView } from "@uiw/react-codemirror";
import { json, jsonParseLinter } from "@codemirror/lang-json";
import { html } from "@codemirror/lang-html";
import { javascript } from "@codemirror/lang-javascript";
import { css } from "@codemirror/lang-css";
import { xml } from "@codemirror/lang-xml";
import { linter, lintGutter } from "@codemirror/lint";
import { oneDark } from "@codemirror/theme-one-dark";

/** Pick CodeMirror language extensions from a Content-Type. */
function languageFor(contentType: string) {
  const ct = contentType.toLowerCase();
  if (ct.includes("json")) return [json(), linter(jsonParseLinter()), lintGutter()];
  if (ct.includes("html")) return [html()];
  if (ct.includes("javascript") || ct.includes("ecmascript")) return [javascript()];
  if (ct.includes("css")) return [css()];
  if (ct.includes("xml") || ct.includes("svg")) return [xml()];
  return [];
}

interface Props {
  value: string;
  onChange: (value: string) => void;
  contentType: string;
  /** Fill the available height (used inside the maximized overlay). */
  fill?: boolean;
  /** Soft-wrap long lines instead of scrolling horizontally. */
  wrap?: boolean;
}

/** A content-type-aware code editor (CodeMirror 6) for mock response bodies. */
export function BodyEditor({ value, onChange, contentType, fill, wrap }: Props) {
  const extensions = useMemo(
    () =>
      wrap ? [...languageFor(contentType), EditorView.lineWrapping] : languageFor(contentType),
    [contentType, wrap],
  );
  return (
    <CodeMirror
      className={fill ? "cm-body cm-fill" : "cm-body"}
      value={value}
      onChange={onChange}
      theme={oneDark}
      extensions={extensions}
      height={fill ? "100%" : undefined}
      minHeight={fill ? undefined : "160px"}
      maxHeight={fill ? undefined : "440px"}
    />
  );
}
