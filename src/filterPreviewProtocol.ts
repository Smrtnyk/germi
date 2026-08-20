import type { FilterDraft } from "./savedFilters";

export type FilterPreviewMessage =
  | {
      type: "update";
      sessionId: string;
      revision: number;
      draft: FilterDraft;
      only: boolean;
    }
  | { type: "clear"; sessionId: string; revision: number };

export interface ActiveFilterPreview {
  draft: FilterDraft;
  only: boolean;
}

export class FilterPreviewOwner {
  private activeSessionId: string | null = null;
  private revision = -1;
  private preview: ActiveFilterPreview | null = null;

  activateSession(sessionId: string): ActiveFilterPreview | null | undefined {
    if (this.activeSessionId === sessionId) return undefined;
    this.activeSessionId = sessionId;
    this.revision = -1;
    this.preview = null;
    return null;
  }

  receive(message: FilterPreviewMessage): ActiveFilterPreview | null | undefined {
    if (
      message.sessionId !== this.activeSessionId ||
      !Number.isSafeInteger(message.revision) ||
      message.revision <= this.revision
    ) {
      return undefined;
    }
    this.revision = message.revision;
    this.preview =
      message.type === "clear"
        ? null
        : {
            draft: {
              ...message.draft,
              kinds: [...message.draft.kinds],
              statuses: [...message.draft.statuses],
            },
            only: message.only,
          };
    return this.preview;
  }

  deactivateSession(sessionId?: string): ActiveFilterPreview | null | undefined {
    if (sessionId !== undefined && sessionId !== this.activeSessionId) return undefined;
    if (this.activeSessionId === null && this.preview === null) return undefined;
    this.activeSessionId = null;
    this.revision = -1;
    this.preview = null;
    return null;
  }
}
