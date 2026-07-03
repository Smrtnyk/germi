import {
  IconArrowLeft,
  IconArrowRight,
  IconArrowToLeft,
  IconArrowToRight,
  IconLink,
  IconUnlink,
} from "./icons";

export interface CompareGutterProps {
  linked: boolean;
  canMoveRight: boolean;
  canMoveLeft: boolean;
  onToggleLinked: () => void;
  onCopyFilter: (from: "left" | "right") => void;
  onMoveRight: () => void;
  onMoveLeft: () => void;
}

/** The strip between the two compare panes: the filter link/copy controls sit
 *  at the top (issue #88) and the row-move buttons in the middle. Manual
 *  copies only make sense while unlinked — linked panes always share one
 *  filter, so those buttons disable. */
export function CompareGutter(props: CompareGutterProps) {
  return (
    <div className="compare-gutter">
      <div className="compare-gutter-filters">
        <button
          className={props.linked ? "btn ghost small on" : "btn ghost small"}
          onClick={props.onToggleLinked}
          title={
            props.linked
              ? "Filters are linked — typing filters both sides. Click to search each side separately."
              : "Link the filters — copies the filled-in side (left wins) and mirrors further edits."
          }
        >
          {props.linked ? <IconLink /> : <IconUnlink />}
        </button>
        <button
          className="btn ghost small"
          disabled={props.linked}
          onClick={() => props.onCopyFilter("left")}
          title="Copy the left filter to the right side"
        >
          <IconArrowToRight />
        </button>
        <button
          className="btn ghost small"
          disabled={props.linked}
          onClick={() => props.onCopyFilter("right")}
          title="Copy the right filter to the left side"
        >
          <IconArrowToLeft />
        </button>
      </div>
      <div className="compare-gutter-move">
        <button
          className="btn ghost"
          disabled={!props.canMoveRight}
          onClick={props.onMoveRight}
          title="Move the selected requests to the right side (→)"
        >
          <IconArrowRight />
        </button>
        <button
          className="btn ghost"
          disabled={!props.canMoveLeft}
          onClick={props.onMoveLeft}
          title="Move the selected requests back to the left side (←)"
        >
          <IconArrowLeft />
        </button>
      </div>
    </div>
  );
}
