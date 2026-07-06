import React from "react";
import ReactDOM from "react-dom/client";

import { App } from "./App";
import { CompareWindow } from "./components/CompareWindow";
import { RuleDetailWindow } from "./components/RuleDetailWindow";
import { ScriptsWindow } from "./components/ScriptsWindow";
import { initHighlightColorSync } from "./themeSync";
import "./styles.css";

// Every window overrides its highlight colors from the saved settings and
// follows later saves (issue #93); rendering never waits on this.
void initHighlightColorSync();

// Secondary OS windows load the same bundle but with a routing query in their
// URL: `?rule=<id>&scenario=<sid>` renders a detached rule editor (issue #72),
// `?compare=1` the compare window (issue #86), `?scripts=1` the scripts editor.
// Everything else is the app.
const params = new URLSearchParams(window.location.search);
const ruleId = params.get("rule");
const scenarioId = params.get("scenario");

function root(): React.ReactElement {
  if (ruleId && scenarioId) return <RuleDetailWindow ruleId={ruleId} scenarioId={scenarioId} />;
  if (params.get("compare")) return <CompareWindow />;
  if (params.get("scripts")) return <ScriptsWindow />;
  return <App />;
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>{root()}</React.StrictMode>,
);
