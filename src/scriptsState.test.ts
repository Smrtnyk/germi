import { describe, expect, it } from "vitest";

import {
  blankScript,
  CORS_TEMPLATE,
  errorsById,
  SCRIPT_EXAMPLES,
  scriptFromExample,
  type ScriptExample,
  uniqueName,
} from "./scriptsState";
import type { Script, ScriptDiagnostic } from "./types";

function script(name: string): Script {
  return { id: name, name, enabled: true, source: "" };
}

describe("scriptsState", () => {
  it("uniqueName appends a counter only on collision", () => {
    const existing = [script("CORS for mocks"), script("CORS for mocks (2)")];
    expect(uniqueName("Fresh", existing)).toBe("Fresh");
    expect(uniqueName("CORS for mocks", existing)).toBe("CORS for mocks (3)");
  });

  it("blankScript is enabled, uniquely named and freshly identified", () => {
    const first = blankScript([]);
    expect(first.enabled).toBe(true);
    expect(first.name).toBe("Script 1");
    const second = blankScript([first]);
    expect(second.name).toBe("Script 2");
    expect(second.id).not.toBe(first.id);
  });

  it("scriptFromExample seeds name + source and dedupes the name", () => {
    const example: ScriptExample = {
      id: "x",
      name: "My rule",
      description: "d",
      source: "fn on_request(req) {}",
    };
    const first = scriptFromExample(example, []);
    expect(first.name).toBe("My rule");
    expect(first.source).toBe(example.source);
    expect(first.enabled).toBe(true);
    const second = scriptFromExample(example, [first]);
    expect(second.name).toBe("My rule (2)");
    expect(second.id).not.toBe(first.id);
  });

  it("ships examples that all define a hook, including the CORS template", () => {
    expect(SCRIPT_EXAMPLES.length).toBeGreaterThanOrEqual(3);
    for (const example of SCRIPT_EXAMPLES) {
      expect(example.name.length).toBeGreaterThan(0);
      expect(example.source).toMatch(/fn on_(request|response)/);
    }
    expect(SCRIPT_EXAMPLES.find((e) => e.id === "cors")?.source).toBe(CORS_TEMPLATE);
  });

  it("errorsById keeps only the failing scripts", () => {
    const diagnostics: ScriptDiagnostic[] = [
      { id: "a", name: "a", error: null },
      { id: "b", name: "b", error: "line 1: bad" },
    ];
    const errors = errorsById(diagnostics);
    expect(errors.has("a")).toBe(false);
    expect(errors.get("b")).toBe("line 1: bad");
  });
});
