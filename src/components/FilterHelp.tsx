import { useEffect, useRef, useState } from "react";

const ROWS: [string, string][] = [
  ["word", "substring match on the URL"],
  ["/regex/", "regular expression on the URL"],
  ["-term", "negate any term"],
  ["host:  path:  method:  scheme:", "URL parts"],
  ["status:", "404, a class (4xx), or a range (>=400, <500)"],
  ["mime:  kind:  ext:", "content-type · inferred type · file extension"],
  ["rule:", "matched autoresponder rule"],
  ["larger-than:  smaller-than:", "response size (k/m suffix)"],
  ["slower-than:", "duration in ms"],
  ["body:  req-body:  resp-body:", "search body content (scans the backend)"],
];
const EXAMPLES = ["kind:xhr status:5xx", "host:api -mime:json", "body:timeout", "/\\.woff2/"];

/** A small "?" info popover documenting the traffic filter syntax. */
export function FilterHelp() {
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

  return (
    <div className="filter-help" ref={ref}>
      <button
        className="help-btn"
        aria-label="Filter syntax help"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        ?
      </button>
      {open && (
        <div className="help-pop" role="dialog" aria-label="Filter syntax">
          <h4>Filter syntax</h4>
          <table>
            <tbody>
              {ROWS.map(([k, v]) => (
                <tr key={k}>
                  <td>
                    <code>{k}</code>
                  </td>
                  <td>{v}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="help-examples">
            {EXAMPLES.map((e) => (
              <code key={e}>{e}</code>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
