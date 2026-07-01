import React from "react";
import ReactDOM from "react-dom/client";

import { App } from "./App";
import { RuleDetailWindow } from "./components/RuleDetailWindow";
import "./styles.css";

// A detached rule-editor window (issue #72) loads the same bundle but with
// `?rule=<id>&scenario=<sid>` in its URL — render just that rule's editor
// instead of the whole app.
const params = new URLSearchParams(window.location.search);
const ruleId = params.get("rule");
const scenarioId = params.get("scenario");

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    {ruleId && scenarioId ? <RuleDetailWindow ruleId={ruleId} scenarioId={scenarioId} /> : <App />}
  </React.StrictMode>,
);
