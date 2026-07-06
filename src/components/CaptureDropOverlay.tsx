import { IconOpen } from "./icons";

export interface CaptureDropOverlayProps {
  active: boolean;
  title: string;
  hint: string;
}

/** Full-window drop affordance shown while an OS file is dragged over the
 *  window (issue #100). Purely visual — `pointer-events: none` (see styles.css)
 *  so the drag events keep reaching the `useCaptureDrop` window listener. */
export function CaptureDropOverlay({ active, title, hint }: CaptureDropOverlayProps) {
  if (!active) return null;
  return (
    <div className="drop-overlay" role="presentation">
      <div className="drop-overlay-card">
        <IconOpen />
        <span className="drop-overlay-title">{title}</span>
        <span className="drop-overlay-hint">{hint}</span>
      </div>
    </div>
  );
}
