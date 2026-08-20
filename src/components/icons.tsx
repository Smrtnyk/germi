import type { ReactNode, SVGProps } from "react";
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
  LuBell,
  LuCheck,
  LuChevronDown,
  LuChevronRight,
  LuChevronsUpDown,
  LuChevronUp,
  LuCircleCheck,
  LuCircleHelp,
  LuCircleSlash2,
  LuCopy,
  LuExternalLink,
  LuEye,
  LuFileDiff,
  LuGitCompareArrows,
  LuGripVertical,
  LuInfo,
  LuLayers,
  LuLink,
  LuLogIn,
  LuMaximize2,
  LuMinimize2,
  LuMonitor,
  LuMoon,
  LuPanelRightClose,
  LuPanelRightOpen,
  LuPower,
  LuSave,
  LuScrollText,
  LuSquare,
  LuSun,
  LuTriangleAlert,
  LuUnlink,
  LuX,
  LuZap,
} from "react-icons/lu";

import type { AvailabilityTone } from "../availability";
import { resourceTypeLabel, type ResourceType } from "../resourceType";

const RESOURCE_GLYPHS: Record<ResourceType, ReactNode> = {
  html: <path d="M6 4 3 8l3 4m4-8 3 4-3 4" />,
  stylesheet: (
    <>
      <path d="M6 3.5H5c-.8 0-1.3.5-1.3 1.3v1.4c0 .8-.4 1.3-1.2 1.3.8 0 1.2.5 1.2 1.3v1.4c0 .8.5 1.3 1.3 1.3h1" />
      <path d="M10 3.5h1c.8 0 1.3.5 1.3 1.3v1.4c0 .8.4 1.3 1.2 1.3-.8 0-1.2.5-1.2 1.3v1.4c0 .8-.5 1.3-1.3 1.3h-1" />
    </>
  ),
  javascript: (
    <text
      x="8"
      y="10.4"
      fill="currentColor"
      stroke="none"
      fontFamily="sans-serif"
      fontSize="6.4"
      fontWeight="700"
      textAnchor="middle"
    >
      JS
    </text>
  ),
  json: (
    <>
      <path d="M6.2 3.5H5c-.8 0-1.2.5-1.2 1.3v1.3c0 .9-.4 1.4-1.3 1.4.9 0 1.3.5 1.3 1.4v1.3c0 .8.4 1.3 1.2 1.3h1.2m3.6-8H11c.8 0 1.2.5 1.2 1.3v1.3c0 .9.4 1.4 1.3 1.4-.9 0-1.3.5-1.3 1.4v1.3c0 .8-.4 1.3-1.2 1.3H9.8" />
      <path d="M8 7.5h.01" strokeWidth="2" />
    </>
  ),
  xml: <path d="m5.5 4-3 4 3 4m5-8 3 4-3 4M9 3 7 13" />,
  text: <path d="M3.5 4.5h9m-9 3h9m-9 3h6" />,
  image: (
    <>
      <circle cx="10.8" cy="5.2" r="1.2" />
      <path d="m2.8 11 3-3 2.1 2.1 1.4-1.4 3.9 3.8H2.8z" />
    </>
  ),
  font: <path d="m3.2 12.5 3.9-9h1.8l3.9 9M4.7 9.2h6.6" />,
  media: <path d="M5.2 3.5 12 8l-6.8 4.5z" />,
  wasm: <path d="m8 2.5 4.8 2.7v5.6L8 13.5l-4.8-2.7V5.2zm-3 4 1.2 4 1.8-3 1.8 3 1.2-4" />,
  archive: <path d="M3 5h10v7.5H3zM2.5 3.5h11V6h-11zM7 7h2m-2 2h2m-2 2h2" />,
  document: <path d="M4 2.5h5l3 3v8H4zm5 0v3h3M6 8h4m-4 2h4" />,
  "event-stream": (
    <>
      <circle cx="8" cy="8" r="1" />
      <path d="M5.5 5.5a3.5 3.5 0 0 0 0 5m5-5a3.5 3.5 0 0 1 0 5M3.5 3.5a6.3 6.3 0 0 0 0 9m9-9a6.3 6.3 0 0 1 0 9" />
    </>
  ),
  "fetch-xhr": <path d="M3 5.5h8.5L9.5 3m3.5 7.5H4.5l2 2.5" />,
  websocket: <path d="M2.5 5h8l-2-2m5 8h-8l2 2m3-8 3 3-3 3m-5 0-3-3 3-3" />,
  data: (
    <>
      <ellipse cx="8" cy="4.2" rx="4.5" ry="1.7" />
      <path d="M3.5 4.2v3.7c0 .9 2 1.7 4.5 1.7s4.5-.8 4.5-1.7V4.2m-9 3.7v3.7c0 .9 2 1.7 4.5 1.7s4.5-.8 4.5-1.7V7.9" />
    </>
  ),
};

interface ResourceIconProps extends Omit<SVGProps<SVGSVGElement>, "children"> {
  resourceType: ResourceType;
  /** Use when adjacent visible text already names the icon. */
  decorative?: boolean;
}

export function IconResourceType({
  resourceType,
  decorative = false,
  className,
  ...props
}: ResourceIconProps) {
  const label = resourceTypeLabel(resourceType);
  const icon = (
    <svg
      {...props}
      aria-hidden="true"
      className={`gi resource-icon resource-icon-${resourceType}${className ? ` ${className}` : ""}`}
      fill="none"
      focusable="false"
      viewBox="0 0 16 16"
    >
      <rect x="1" y="1" width="14" height="14" rx="3" fill="currentColor" opacity="0.14" />
      <g stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.35">
        {RESOURCE_GLYPHS[resourceType]}
      </g>
    </svg>
  );

  if (decorative) return icon;
  const accessibleLabel = `${label} resource`;
  return (
    <span
      className="resource-icon-label"
      role="img"
      aria-label={accessibleLabel}
      title={accessibleLabel}
    >
      {icon}
    </span>
  );
}

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
export const IconScript = make(LuScrollText, { color: "var(--s3)", size: 14 });
export const IconWarn = make(LuTriangleAlert, { color: "var(--warn)" });
export const IconCheck = make(LuCheck, { color: "var(--s2)" });
export const IconInfo = make(LuInfo, { color: "var(--s3)" });
export const IconSave = make(LuSave, { color: "var(--accent)" });
export const IconExternal = make(LuExternalLink, { color: "var(--accent)", size: 14 });
export const IconViewer = make(LuEye, { color: "var(--s3)" });
export const IconSystemTheme = make(LuMonitor, { size: 14 });

export const IconClose = make(LuX);
export const IconCopy = make(LuCopy, { size: 14 });
export const IconMaximize = make(LuMaximize2, { size: 14 });
export const IconRestore = make(LuMinimize2, { size: 14 });
export const IconPanelCollapse = make(LuPanelRightClose);
export const IconPanelExpand = make(LuPanelRightOpen);
export const IconGrip = make(LuGripVertical, { size: 14 });
export const IconPower = make(LuPower, { size: 14 });
export const IconGeneral = make(LuLayers, { color: "var(--s3)", size: 14 });
export const IconBell = make(LuBell, { size: 14 });
export const IconMoon = make(LuMoon, { size: 14 });
export const IconSun = make(LuSun, { size: 14 });

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
