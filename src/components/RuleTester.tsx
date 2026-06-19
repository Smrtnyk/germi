import { useEffect, useState } from "react";

import { api } from "../ipc";
import type { RuleSet, TestInput, TestResult } from "../types";

interface Props {
  /** The full rule set to simulate (tested as a whole, in order). */
  rules: RuleSet;
  seedMethod?: string;
  seedUrl?: string;
}

const OUTCOME: Record<TestResult["outcome"], { label: string; cls: string }> = {
  respond: { label: "Auto-responded (short-circuit)", cls: "respond" },
  block: { label: "Blocked", cls: "block" },
  continue: { label: "Forwarded upstream", cls: "continue" },
};

export function RuleTester({ rules, seedMethod, seedUrl }: Props) {
  const [method, setMethod] = useState(seedMethod ?? "GET");
  const [url, setUrl] = useState(seedUrl ?? "https://api.example.com/health");
  const [reqBody, setReqBody] = useState("");
  const [respStatus, setRespStatus] = useState(200);
  const [respBody, setRespBody] = useState('{ "upstream": true }');
  const [result, setResult] = useState<TestResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Re-seed from the selected rule when it changes.
  useEffect(() => {
    if (seedUrl) setUrl(seedUrl);
    if (seedMethod) setMethod(seedMethod);
  }, [seedUrl, seedMethod]);

  async function run() {
    setError(null);
    const input: TestInput = {
      method,
      url,
      reqHeaders: [],
      reqBody,
      respStatus,
      respHeaders: respBody ? [["content-type", "application/json"]] : [],
      respBody,
    };
    try {
      setResult(await api.testRules(rules, input));
    } catch (e) {
      setError(String(e));
    }
  }

  return (
    <div className="tester">
      <h4>Test rules</h4>
      <p className="muted small">
        Simulate the whole rule set against a sample request — no network, no side effects. Preview
        exactly what a client would get back.
      </p>

      <div className="row">
        <select value={method} onChange={(e) => setMethod(e.target.value)}>
          {["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"].map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
        <input
          className="grow"
          value={url}
          placeholder="https://host/path"
          onChange={(e) => setUrl(e.target.value)}
        />
        <button className="btn primary" onClick={run}>
          Run test
        </button>
      </div>

      <div className="row col">
        <label className="muted small">Request body (optional)</label>
        <textarea rows={3} value={reqBody} onChange={(e) => setReqBody(e.target.value)} />
      </div>

      <div className="row">
        <label className="muted small">Sample upstream</label>
        <input
          type="number"
          style={{ width: 80 }}
          value={respStatus}
          onChange={(e) => setRespStatus(Number(e.target.value) || 200)}
        />
        <input
          className="grow"
          value={respBody}
          placeholder="body the real server would return"
          onChange={(e) => setRespBody(e.target.value)}
        />
      </div>
      <p className="muted small">
        Only used when no rule short-circuits — to preview response-phase rules (rewrite / set
        header / set status).
      </p>

      {error && <div className="error-bar">{error}</div>}

      {result && (
        <div className="test-result">
          <div className="result-head">
            <span className={`outcome-badge ${OUTCOME[result.outcome].cls}`}>
              {OUTCOME[result.outcome].label}
            </span>
            {result.firedRule && (
              <span className="muted">
                fired: <strong>{result.firedRule}</strong>
              </span>
            )}
            <span className="muted">
              matched: {result.matchedRules.length ? result.matchedRules.join(", ") : "none"}
            </span>
          </div>

          {result.notes.map((n, i) => (
            <div key={i} className="muted small note">
              {n}
            </div>
          ))}

          {result.response && (
            <div className="result-response">
              <div className="muted small">{result.response.source}</div>
              <div className="resp-status">
                <span className="badge status">{result.response.status}</span>
              </div>
              {result.response.headers.length > 0 && (
                <div className="headers compact">
                  {result.response.headers.map(([k, v], i) => (
                    <div className="hrow" key={`${k}-${i}`}>
                      <span className="hkey">{k}</span>
                      <span className="hval">{v}</span>
                    </div>
                  ))}
                </div>
              )}
              <pre className="snippet">{result.response.body || "(empty body)"}</pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
