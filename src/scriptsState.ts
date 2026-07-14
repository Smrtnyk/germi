import type { Script, ScriptDiagnostic } from "./types";

/** The built-in CORS example: stamp the permissive headers a browser needs onto
 *  every response (real or mocked). The motivating use case — what a Fiddler
 *  OnBeforeResponse script does — in a few lines. */
export const CORS_TEMPLATE = `fn on_response(req, res) {
    let origin = req.header("Origin");
    if origin != "" {
        res.set_header("Access-Control-Allow-Origin", origin);
        res.set_header("Access-Control-Allow-Credentials", "true");
        res.add_header("Vary", "Origin");

        let requested_method = req.header("Access-Control-Request-Method");
        if requested_method != "" {
            res.add_header("Vary", "Access-Control-Request-Method");
            res.set_header("Access-Control-Allow-Methods", requested_method);
            let requested_headers = req.header("Access-Control-Request-Headers");
            if requested_headers != "" {
                res.add_header("Vary", "Access-Control-Request-Headers");
                res.set_header("Access-Control-Allow-Headers", requested_headers);
            }
            if req.method == "OPTIONS" {
                res.set_status(204);
            }
        }
    }
}
`;

/** A commented starter that documents the available hooks and message API. */
const STARTER_TEMPLATE = `// Scripts run on every request and response, including mocked ones.
// Define either hook (or both):
//
//   fn on_request(req) {
//       req.set_header("x-debug", "germi");
//   }
//
//   fn on_response(req, res) {
//       if req.host == "api.example.com" {
//           res.set_header("x-served-by", "germi");
//       }
//   }
//
// Read:  req.method, req.url, req.host, req.path, req.query, req.status,
//        req.header(name), req.has_header(name), req.body_complete, req.body
// Bodies over the capture limit (or incomplete streams) set body_complete=false;
// check it before reading body. Incomplete or non-UTF-8 bodies reject body reads.
// Write: set_header(name, value), add_header(name, value),
//        remove_header(name), res.set_status(code)
`;

/** A ready-to-insert, self-documenting example script. */
export interface ScriptExample {
  /** Stable key for the examples list (not the created script's id). */
  id: string;
  name: string;
  description: string;
  source: string;
}

/** The built-in examples surfaced in the Scripts guide. Each is a real, working
 *  script a user can insert and tweak. */
export const SCRIPT_EXAMPLES: ScriptExample[] = [
  {
    id: "cors",
    name: "CORS for mocks",
    description: "Add permissive CORS headers to every response so a browser accepts your mocks.",
    source: CORS_TEMPLATE,
  },
  {
    id: "auth-header",
    name: "Add an auth header to requests",
    description: "Attach an Authorization header to every outgoing request.",
    source: `fn on_request(req) {
    req.set_header("Authorization", "Bearer PASTE_TOKEN_HERE");
}
`,
  },
  {
    id: "allow-framing",
    name: "Allow framing (strip CSP / X-Frame-Options)",
    description: "Remove the headers that stop a page from loading inside an iframe.",
    source: `fn on_response(req, res) {
    res.remove_header("X-Frame-Options");
    res.remove_header("Content-Security-Policy");
}
`,
  },
  {
    id: "tag-by-host",
    name: "Tag responses from one host",
    description: "Add a marker header only to responses from a specific API host.",
    source: `fn on_response(req, res) {
    if req.host == "api.example.com" {
        res.set_header("X-Handled-By", "germi");
    }
}
`,
  },
  {
    id: "simulate-outage",
    name: "Simulate an outage",
    description: "Force a 503 for one path to test how the app handles failures.",
    source: `fn on_response(req, res) {
    if req.path == "/api/health" {
        res.set_status(503);
    }
}
`,
  },
  {
    id: "no-store",
    name: "Disable response caching",
    description: "Rewrite Cache-Control so responses are never cached while you debug.",
    source: `fn on_response(req, res) {
    res.set_header("Cache-Control", "no-store");
    res.remove_header("ETag");
    res.remove_header("Last-Modified");
}
`,
  },
];

let idSeq = 0;

/** A collision-resistant id for a new script. Scripts carry their own ids (the
 *  backend stores whatever the frontend sends), so they're minted here. */
function nextId(): string {
  idSeq += 1;
  return `script-${Date.now().toString(36)}-${idSeq.toString(36)}`;
}

/** Make `base` unique against the existing script names by appending " (n)". */
export function uniqueName(base: string, existing: readonly Script[]): string {
  const names = new Set(existing.map((s) => s.name));
  if (!names.has(base)) return base;
  for (let i = 2; ; i += 1) {
    const candidate = `${base} (${i})`;
    if (!names.has(candidate)) return candidate;
  }
}

function makeScript(name: string, source: string, existing: readonly Script[]): Script {
  return { id: nextId(), name: uniqueName(name, existing), enabled: true, source };
}

/** A blank, enabled script with a unique default name and the starter source. */
export function blankScript(existing: readonly Script[]): Script {
  return makeScript(`Script ${existing.length + 1}`, STARTER_TEMPLATE, existing);
}

/** A new, enabled script seeded from a built-in example (name deduped). */
export function scriptFromExample(example: ScriptExample, existing: readonly Script[]): Script {
  return makeScript(example.name, example.source, existing);
}

/** Index the compile diagnostics by script id, keeping only the failures. */
export function errorsById(diagnostics: readonly ScriptDiagnostic[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const diagnostic of diagnostics) {
    if (diagnostic.error) map.set(diagnostic.id, diagnostic.error);
  }
  return map;
}
