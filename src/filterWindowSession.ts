import type { FilterDraft } from "./savedFilters";
import type {
  FilterSaveRequest,
  FilterSaveResult,
  FilterWindowRegistration,
  FilterWindowState,
} from "./filterWindowProtocol";

type Unlisten = () => void;

export interface FilterWindowSessionTransport {
  onState: (handler: (state: FilterWindowState) => void) => Promise<Unlisten>;
  onSaveResult: (handler: (result: FilterSaveResult) => void) => Promise<Unlisten>;
  requestState: (registration: FilterWindowRegistration) => Promise<void>;
  requestSave: (request: FilterSaveRequest) => Promise<void>;
}

interface PendingSave {
  requestId: string;
  resolve: (result: FilterSaveResult) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface FilterWindowSessionOptions {
  sessionId: string;
  transport: FilterWindowSessionTransport;
  onState: (state: FilterWindowState) => void;
  onError: (error: string) => void;
  requestId?: () => string;
  retryMs?: number;
  saveTimeoutMs?: number;
}

const CLOSED_ERROR = "The filter window was closed before the save completed.";

function failed(request: FilterSaveRequest, error: string): FilterSaveResult {
  return {
    sessionId: request.sessionId,
    requestId: request.requestId,
    ok: false,
    error,
  };
}

/** Child-window request/result controller. State/result listeners are installed
 * before the ready event, refresh requests are retried until the first seed,
 * and every callback is inert after disposal. */
export class FilterWindowSession {
  private readonly sessionId: string;
  private readonly transport: FilterWindowSessionTransport;
  private readonly onState: (state: FilterWindowState) => void;
  private readonly onError: (error: string) => void;
  private readonly requestId: () => string;
  private readonly retryMs: number;
  private readonly saveTimeoutMs: number;
  private active = true;
  private seeded = false;
  private unlistens: Unlisten[] = [];
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingSave: PendingSave | null = null;

  constructor(options: FilterWindowSessionOptions) {
    this.sessionId = options.sessionId;
    this.transport = options.transport;
    this.onState = options.onState;
    this.onError = options.onError;
    this.requestId = options.requestId ?? (() => crypto.randomUUID());
    this.retryMs = options.retryMs ?? 500;
    this.saveTimeoutMs = options.saveTimeoutMs ?? 5_000;
  }

  async start(): Promise<void> {
    try {
      const stopState = await this.transport.onState((state) => this.receiveState(state));
      if (!this.active) {
        stopState();
        return;
      }
      this.unlistens.push(stopState);

      const stopResult = await this.transport.onSaveResult((result) =>
        this.receiveSaveResult(result),
      );
      if (!this.active) {
        stopResult();
        return;
      }
      this.unlistens.push(stopResult);
      await this.requestSeed();
    } catch (error) {
      if (this.active) {
        this.onError(`Could not connect to Germi: ${String(error)}`);
        this.dispose();
      }
    }
  }

  save(draft: FilterDraft, only: boolean): Promise<FilterSaveResult> {
    if (!this.active) {
      return Promise.resolve({
        sessionId: this.sessionId,
        requestId: "cancelled",
        ok: false,
        error: CLOSED_ERROR,
      });
    }
    if (this.pendingSave) {
      return Promise.resolve({
        sessionId: this.sessionId,
        requestId: this.pendingSave.requestId,
        ok: false,
        error: "A save is already in progress.",
      });
    }

    const requestId = this.requestId();
    const request: FilterSaveRequest = { sessionId: this.sessionId, requestId, draft, only };
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (!this.active || this.pendingSave?.requestId !== requestId) return;
        this.pendingSave = null;
        resolve(failed(request, "Germi did not confirm the save. Try again."));
      }, this.saveTimeoutMs);
      this.pendingSave = { requestId, resolve, timer };
      void this.transport
        .requestSave(request)
        .catch((error: unknown) => this.failPendingSave(request, timer, error));
    });
  }

  dispose(): void {
    if (!this.active) return;
    this.active = false;
    if (this.retryTimer !== null) clearTimeout(this.retryTimer);
    if (this.pendingSave) {
      const pending = this.pendingSave;
      clearTimeout(pending.timer);
      pending.resolve({
        sessionId: this.sessionId,
        requestId: pending.requestId,
        ok: false,
        error: CLOSED_ERROR,
      });
    }
    this.pendingSave = null;
    for (const unlisten of this.unlistens.splice(0)) unlisten();
  }

  private receiveState(state: FilterWindowState): void {
    if (!this.active || state.sessionId !== this.sessionId) return;
    if (!this.seeded && !state.initialDraft) return;
    this.seeded = true;
    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    this.onState(state);
  }

  private receiveSaveResult(result: FilterSaveResult): void {
    if (!this.active || result.sessionId !== this.sessionId) return;
    const pending = this.pendingSave;
    if (!pending || result.requestId !== pending.requestId) return;
    clearTimeout(pending.timer);
    this.pendingSave = null;
    pending.resolve(result);
  }

  private failPendingSave(
    request: FilterSaveRequest,
    timer: ReturnType<typeof setTimeout>,
    error: unknown,
  ): void {
    const pending = this.pendingSave;
    if (!this.active || pending?.requestId !== request.requestId) return;
    clearTimeout(timer);
    this.pendingSave = null;
    pending.resolve(failed(request, `Could not request the save: ${String(error)}`));
  }

  private async requestSeed(): Promise<void> {
    if (!this.active || this.seeded) return;
    try {
      await this.transport.requestState({ sessionId: this.sessionId });
    } catch (error) {
      if (this.active && !this.seeded) {
        this.onError(`Could not request filter state: ${String(error)}`);
      }
    }
    if (!this.active || this.seeded) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.requestSeed();
    }, this.retryMs);
  }
}
