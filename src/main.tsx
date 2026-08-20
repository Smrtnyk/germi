import React from "react";
import ReactDOM from "react-dom/client";

import { App } from "./App";
import { CompareWindow } from "./components/CompareWindow";
import { RuleDetailWindow } from "./components/RuleDetailWindow";
import { ScriptsWindow } from "./components/ScriptsWindow";
import { SettingsWindow } from "./components/SettingsWindow";
import { installDefaultContextMenuBlocker } from "./contextMenuPolicy";
import { installContextualSelectAll } from "./selectAllContext";
import { initThemeSync } from "./themeSync";
import { resolveWindowRoute } from "./windowRoute";
import "./styles.css";

// Secondary OS windows load the same bundle but with a routing query in their
// URL: `?rule=<id>&scenario=<sid>` renders a detached rule editor (issue #72),
// `?compare=1` the compare window (issue #86), `?scripts=1` the scripts editor.
// Everything else is the app.
function root(): React.ReactElement {
  const route = resolveWindowRoute(window.location.search);
  switch (route.kind) {
    case "rule":
      return <RuleDetailWindow ruleId={route.ruleId} scenarioId={route.scenarioId} />;
    case "compare":
      return <CompareWindow />;
    case "scripts":
      return <ScriptsWindow />;
    case "settings":
      return <SettingsWindow sessionId={route.sessionId} />;
    case "app":
      return <App />;
  }
}

function Root(): React.ReactElement {
  React.useEffect(() => installDefaultContextMenuBlocker(), []);
  React.useEffect(() => installContextualSelectAll(), []);
  return root();
}

async function start() {
  // The head script applies the startup cache before first paint. Confirm the
  // durable setting and install cross-window synchronization before React (and
  // a lazy CodeMirror editor) renders.
  await initThemeSync();
  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
      <Root />
    </React.StrictMode>,
  );
}

void start();
