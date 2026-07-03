import type { IconBaseProps, IconType } from "react-icons";
import {
  FcEmptyTrash,
  FcKey,
  FcOpenedFolder,
  FcRefresh,
  FcSearch,
  FcSettings,
  FcStart,
} from "react-icons/fc";
import {
  LuArrowDown,
  LuArrowLeft,
  LuArrowLeftToLine,
  LuArrowRight,
  LuArrowRightToLine,
  LuArrowUp,
  LuBan,
  LuCheck,
  LuChevronDown,
  LuChevronRight,
  LuChevronsUpDown,
  LuChevronUp,
  LuCircleCheck,
  LuCircleHelp,
  LuCircleSlash2,
  LuColumns2,
  LuCopy,
  LuExternalLink,
  LuEye,
  LuFileDiff,
  LuGitCompareArrows,
  LuGripVertical,
  LuInfo,
  LuLink,
  LuLogIn,
  LuMaximize2,
  LuMinimize2,
  LuPanelRightClose,
  LuPanelRightOpen,
  LuPower,
  LuSave,
  LuSquare,
  LuTriangleAlert,
  LuUnlink,
  LuX,
  LuZap,
} from "react-icons/lu";

import type { AvailabilityTone } from "../availability";

function make(Base: IconType, defaults?: IconBaseProps): IconType {
  return function GermiIcon(props: IconBaseProps) {
    return <Base aria-hidden className="gi" size={16} {...defaults} {...props} />;
  };
}

export const IconStart = make(FcStart);
export const IconSettings = make(FcSettings);
export const IconOpen = make(FcOpenedFolder);
export const IconClear = make(FcEmptyTrash);
export const IconSearch = make(FcSearch);
export const IconRefresh = make(FcRefresh);
export const IconCert = make(FcKey);

export const IconStop = make(LuSquare, { color: "var(--danger)", fill: "currentColor", size: 13 });
export const IconMock = make(LuZap, { color: "var(--warn)", fill: "currentColor", size: 14 });
export const IconWarn = make(LuTriangleAlert, { color: "var(--warn)" });
export const IconCheck = make(LuCheck, { color: "var(--s2)" });
export const IconInfo = make(LuInfo, { color: "var(--s3)" });
export const IconSave = make(LuSave, { color: "var(--accent)" });
export const IconExternal = make(LuExternalLink, { color: "var(--accent)", size: 14 });
export const IconViewer = make(LuEye, { color: "var(--s3)" });

export const IconClose = make(LuX);
export const IconCopy = make(LuCopy, { size: 14 });
export const IconMaximize = make(LuMaximize2, { size: 14 });
export const IconRestore = make(LuMinimize2, { size: 14 });
export const IconSplit = make(LuColumns2, { size: 15 });
export const IconPanelCollapse = make(LuPanelRightClose);
export const IconPanelExpand = make(LuPanelRightOpen);
export const IconGrip = make(LuGripVertical, { size: 14 });
export const IconPower = make(LuPower, { size: 14 });

export const IconCompare = make(LuGitCompareArrows, { color: "var(--s3)", size: 14 });
export const IconDiff = make(LuFileDiff, { size: 14 });
export const IconArrowLeft = make(LuArrowLeft, { size: 14 });
export const IconArrowRight = make(LuArrowRight, { size: 14 });
export const IconLink = make(LuLink, { size: 13 });
export const IconUnlink = make(LuUnlink, { size: 13 });
export const IconArrowToLeft = make(LuArrowLeftToLine, { size: 13 });
export const IconArrowToRight = make(LuArrowRightToLine, { size: 13 });

export const IconSortAsc = make(LuChevronUp, { size: 14 });
export const IconSortDesc = make(LuChevronDown, { size: 14 });
export const IconSortNone = make(LuChevronsUpDown, { size: 14 });
export const IconArrowUp = make(LuArrowUp, { size: 14 });
export const IconArrowDown = make(LuArrowDown, { size: 14 });
export const IconChevronRight = make(LuChevronRight, { size: 14 });
export const IconChevronDown = make(LuChevronDown, { size: 14 });

export const availabilityToneIcon: Record<AvailabilityTone, IconType> = {
  reachable: make(LuCircleCheck, { color: "var(--s2)", size: 14 }),
  login: make(LuLogIn, { color: "var(--s3)", size: 14 }),
  forbidden: make(LuBan, { color: "var(--danger)", size: 14 }),
  gone: make(LuCircleSlash2, { color: "var(--muted)", size: 14 }),
  error: make(LuTriangleAlert, { color: "var(--warn)", size: 14 }),
  unknown: make(LuCircleHelp, { color: "var(--muted)", size: 14 }),
};
