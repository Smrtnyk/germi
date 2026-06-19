import { useMemo } from "react";
import CodeMirror from "@uiw/react-codemirror";
import { json, jsonParseLinter } from "@codemirror/lang-json";
import { html } from "@codemirror/lang-html";
import { javascript } from "@codemirror/lang-javascript";
import { css } from "@codemirror/lang-css";
import { xml } from "@codemirror/lang-xml";
import { linter, lintGutter } from "@codemirror/lint";
import { oneDark } from "@codemirror/theme-one-dark";

import { useTheme } from "../theme";

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
}

/** A content-type-aware code editor (CodeMirror 6) for mock response bodies. */
export function BodyEditor({ value, onChange, contentType }: Props) {
  const extensions = useMemo(() => languageFor(contentType), [contentType]);
  const theme = useTheme();
  return (
    <CodeMirror
      className="cm-body"
      value={value}
      onChange={onChange}
      theme={theme === "dark" ? oneDark : "light"}
      extensions={extensions}
      minHeight="160px"
      maxHeight="440px"
    />
  );
}
