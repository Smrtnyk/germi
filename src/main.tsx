import React from "react";
import ReactDOM from "react-dom/client";

import { App } from "./App";
import { CompareWindow } from "./components/CompareWindow";
import { RuleDetailWindow } from "./components/RuleDetailWindow";
import "./styles.css";

// Secondary OS windows load the same bundle but with a routing query in their
// URL: `?rule=<id>&scenario=<sid>` renders a detached rule editor (issue #72),
// `?compare=1` the compare window (issue #86). Everything else is the app.
const params = new URLSearchParams(window.location.search);
const ruleId = params.get("rule");
const scenarioId = params.get("scenario");

function root(): React.ReactElement {
  if (ruleId && scenarioId) return <RuleDetailWindow ruleId={ruleId} scenarioId={scenarioId} />;
  if (params.get("compare")) return <CompareWindow />;
  return <App />;
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>{root()}</React.StrictMode>,
);
