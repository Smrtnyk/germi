import { useMemo, useRef, type PointerEvent as ReactPointerEvent } from "react";

import type { FlowSummary } from "../types";
import { bandsToGradient, indexForFraction, railBands, railVisible } from "../matchRail";

const BANDS = 120;

interface Props {
  flows: FlowSummary[];
  matchedIds: Set<string>;
  onJump: (index: number) => void;
}

export function MatchRail({ flows, matchedIds, onJump }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const gradient = useMemo(
    () =>
      bandsToGradient(
        railBands(
          flows.map((f) => f.id),
          matchedIds,
          BANDS,
        ),
      ),
    [flows, matchedIds],
  );

  if (!railVisible(matchedIds.size, flows.length)) return null;

  function scrub(e: ReactPointerEvent<HTMLDivElement>) {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    onJump(indexForFraction((e.clientY - r.top) / r.height, flows.length));
  }

  function onPointerDown(e: ReactPointerEvent<HTMLDivElement>) {
    e.currentTarget.setPointerCapture(e.pointerId);
    scrub(e);
  }

  function onPointerMove(e: ReactPointerEvent<HTMLDivElement>) {
    if (e.buttons !== 0) scrub(e);
  }

  return (
    <div
      ref={ref}
      className="match-rail"
      style={{ backgroundImage: gradient }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      title={`${matchedIds.size} matches · drag to scan`}
    />
  );
}
