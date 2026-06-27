import { useEffect, useRef, useState, type RefObject } from "react";

const ROWS: { tokens: string[]; desc: string }[] = [
  { tokens: ["host:", "path:", "method:", "scheme:"], desc: "URL parts" },
  { tokens: ["status:"], desc: "404, a class (4xx), or a range (>=400, <500)" },
  { tokens: ["mime:", "kind:", "ext:"], desc: "content-type · inferred type · file extension" },
  { tokens: ["is:imported", "is:captured"], desc: "loaded from a file vs captured live" },
  { tokens: ["rule:"], desc: "matched autoresponder rule" },
  { tokens: ["larger-than:", "smaller-than:"], desc: "response size (k/m suffix)" },
  { tokens: ["slower-than:"], desc: "duration in ms" },
  { tokens: ["body:", "req-body:", "resp-body:"], desc: "search body content (scans backend)" },
  { tokens: ["/regex/"], desc: "regular expression on the URL" },
  { tokens: ["-term"], desc: "negate any term" },
];
const EXAMPLES = ["kind:xhr status:5xx", "host:api -mime:json", "body:timeout", "/\\.woff2/"];

interface Props {
  filter: string;
  onPick: (value: string) => void;
  inputRef: RefObject<HTMLInputElement | null>;
}

/** A small "?" info popover documenting the traffic filter syntax. Tokens and
 *  examples are clickable so users learn the DSL by building a query. */
export function FilterHelp({ filter, onPick, inputRef }: Props) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  function applyExample(ex: string) {
    onPick(ex);
    setOpen(false);
    inputRef.current?.focus();
  }

  function insertToken(tok: string) {
    const base = filter.trim();
    onPick(base ? `${base} ${tok}` : tok);
    inputRef.current?.focus();
  }

  return (
    <div className="filter-help" ref={ref}>
      <button
        className="help-btn"
        aria-label="Filter syntax help"
        aria-expanded={open}
        title="Filter syntax — click to learn the query language"
        onClick={() => setOpen((o) => !o)}
      >
        ?
      </button>
      {open && (
        <div className="help-pop" role="dialog" aria-label="Filter syntax">
          <h4>Filter syntax</h4>
          <p className="muted small help-hint">
            Whitespace = AND. Click a token to insert it, or an example to try it.
          </p>
          <table>
            <tbody>
              {ROWS.map((row) => (
                <tr key={row.desc}>
                  <td>
                    {row.tokens.map((t) => (
                      <button key={t} className="help-token" onClick={() => insertToken(t)}>
                        {t}
                      </button>
                    ))}
                  </td>
                  <td>{row.desc}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="help-examples">
            {EXAMPLES.map((e) => (
              <button key={e} className="help-example" onClick={() => applyExample(e)}>
                {e}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
