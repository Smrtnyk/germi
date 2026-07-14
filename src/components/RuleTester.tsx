import { useEffect, useRef, useState } from "react";

import { api } from "../ipc";
import type { SequenceStep, TestInput, TestResult } from "../types";
import { IconRefresh } from "./icons";
import { Button } from "./ui/Button";

interface Props {
  /** The backend-owned scenario to simulate as a whole, in order. */
  scenarioId: string;
  seedMethod?: string;
  seedUrl?: string;
}

const DEFAULT_METHOD = "GET";
const DEFAULT_URL = "https://api.example.com/health";

const OUTCOME: Record<TestResult["outcome"], { label: string; cls: string }> = {
  respond: { label: "Auto-responded (short-circuit)", cls: "respond" },
  block: { label: "Blocked", cls: "block" },
  continue: { label: "Forwarded upstream", cls: "continue" },
  mapRemote: { label: "Forwarded to mapped URL", cls: "map-remote" },
};

function SequenceStrip({ sequence, loops }: { sequence: SequenceStep[]; loops: boolean }) {
  return (
    <div className="seq-strip">
      <span className="muted small">If this exact request repeats:</span>
      <div className="seq-chips">
        {sequence.map((step, i) => (
          <span
            key={i}
            className={`seq-chip ${step.outcome}`}
            title={step.rule ?? "forwarded upstream"}
          >
            {step.outcome === "mapRemote" ? "→ mapped" : (step.status ?? "→ upstream")}
          </span>
        ))}
        {loops && (
          <span className="seq-chip loops" title="sequence loops while it keeps matching">
            <IconRefresh /> loops
          </span>
        )}
      </div>
    </div>
  );
}

export function RuleTester({ scenarioId, seedMethod, seedUrl }: Props) {
  const [method, setMethod] = useState(seedMethod ?? DEFAULT_METHOD);
  const [url, setUrl] = useState(seedUrl ?? DEFAULT_URL);
  const [reqBody, setReqBody] = useState("");
  const [respStatus, setRespStatus] = useState(200);
  const [respBody, setRespBody] = useState('{ "upstream": true }');
  const [result, setResult] = useState<TestResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const runGeneration = useRef(0);

  // Re-seed from the selected rule when it changes, and drop the previous
  // result so a stale preview from another rule isn't shown as this rule's.
  useEffect(() => {
    runGeneration.current += 1;
    // `undefined` is meaningful here: it is how an any-method matcher or an
    // empty URL is passed in. Reset to the tester defaults instead of retaining
    // the previous selected rule's method/URL.
    setUrl(seedUrl ?? DEFAULT_URL);
    setMethod(seedMethod ?? DEFAULT_METHOD);
    setResult(null);
    setError(null);
  }, [scenarioId, seedUrl, seedMethod]);

  async function run() {
    const generation = ++runGeneration.current;
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
      const next = await api.testScenario(scenarioId, input);
      if (generation === runGeneration.current) setResult(next);
    } catch (e) {
      if (generation === runGeneration.current) setError(String(e));
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
          onKeyDown={(e) => {
            if (e.key === "Enter") void run();
          }}
        />
        <Button variant="primary" onClick={run} title="Run test (Enter)">
          Run test
        </Button>
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

      {result && <TestResultView result={result} />}
    </div>
  );
}

function TestResultView({ result }: { result: TestResult }) {
  return (
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

      {result.mappedUrl && (
        <div className="mapped-url" title="Where the request is actually sent">
          → <code>{result.mappedUrl}</code>
        </div>
      )}

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

      {result.sequence.length > 0 && (
        <SequenceStrip sequence={result.sequence} loops={result.sequenceLoops} />
      )}
    </div>
  );
}
