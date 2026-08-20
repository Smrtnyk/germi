import type {
  SettingsWindowAction,
  SettingsWindowReady,
  SettingsWindowRequest,
  SettingsWindowResult,
  SettingsWindowShutdownRequest,
  SettingsWindowState,
} from "./settingsWindowProtocol";

type Unlisten = () => void;

export interface SettingsWindowSessionTransport {
  onState: (handler: (state: SettingsWindowState) => void) => Promise<Unlisten>;
  onResult: (handler: (result: SettingsWindowResult) => void) => Promise<Unlisten>;
  onShutdown: (handler: (request: SettingsWindowShutdownRequest) => void) => Promise<Unlisten>;
  announceReady: (ready: SettingsWindowReady) => Promise<void>;
  request: (request: SettingsWindowRequest) => Promise<void>;
}

interface PendingRequest {
  requestId: string;
  resolve: (result: SettingsWindowResult) => void;
  timer: ReturnType<typeof setTimeout> | null;
}

interface Options {
  sessionId: string;
  transport: SettingsWindowSessionTransport;
  onState: (state: SettingsWindowState) => void;
  onShutdown: (request: SettingsWindowShutdownRequest) => void;
  onError: (error: string) => void;
  requestId?: () => string;
  retryMs?: number;
  timeoutMs?: number;
}

function failed(request: SettingsWindowRequest, error: string): SettingsWindowResult {
  return { sessionId: request.sessionId, requestId: request.requestId, ok: false, error };
}

/** Native file pickers are user-paced: ten seconds is a normal think time,
 * not a transport failure. Other operations remain bounded so a lost main
 * response cannot leave the Settings UI permanently busy. */
function requestTimeout(action: SettingsWindowAction, timeoutMs: number): number | null {
  switch (action.kind) {
    case "export":
    case "peekImport":
    case "exportCa":
      return null;
    default:
      return timeoutMs;
  }
}

/** Child-side listener-before-ready/request-result session. One request may be
 * pending at a time; late, stale and mismatched results are ignored. */
export class SettingsWindowSession {
  private readonly options: Options;
  private readonly requestId: () => string;
  private readonly retryMs: number;
  private readonly timeoutMs: number;
  private active = true;
  private seeded = false;
  private unlistens: Unlisten[] = [];
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private pending: PendingRequest | null = null;

  constructor(options: Options) {
    this.options = options;
    this.requestId = options.requestId ?? (() => crypto.randomUUID());
    this.retryMs = options.retryMs ?? 500;
    this.timeoutMs = options.timeoutMs ?? 10_000;
  }

  async start(): Promise<void> {
    try {
      await this.install(this.options.transport.onState, (state) => this.receiveState(state));
      await this.install(this.options.transport.onResult, (result) => this.receiveResult(result));
      await this.install(this.options.transport.onShutdown, (request) => {
        if (this.active && request.sessionId === this.options.sessionId)
          this.options.onShutdown(request);
      });
      await this.requestSeed();
    } catch (error) {
      if (!this.active) return;
      this.options.onError(`Could not connect to Germi: ${String(error)}`);
      this.dispose();
    }
  }

  request(action: SettingsWindowAction): Promise<SettingsWindowResult> {
    const request: SettingsWindowRequest = {
      sessionId: this.options.sessionId,
      requestId: this.requestId(),
      action,
    };
    if (!this.active) return Promise.resolve(failed(request, "The Settings window is closed."));
    if (this.pending)
      return Promise.resolve(failed(request, "Another Settings operation is already in progress."));

    return new Promise((resolve) => {
      const timeout = requestTimeout(action, this.timeoutMs);
      const timer =
        timeout === null
          ? null
          : setTimeout(() => {
              if (!this.active || this.pending?.requestId !== request.requestId) return;
              this.pending = null;
              resolve(failed(request, "Germi did not confirm the Settings operation. Try again."));
            }, timeout);
      this.pending = { requestId: request.requestId, resolve, timer };
      void this.options.transport.request(request).catch((error: unknown) => {
        if (!this.active || this.pending?.requestId !== request.requestId) return;
        if (timer) clearTimeout(timer);
        this.pending = null;
        resolve(failed(request, `Could not request the Settings operation: ${String(error)}`));
      });
    });
  }

  dispose(): void {
    if (!this.active) return;
    this.active = false;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    if (this.pending) {
      if (this.pending.timer) clearTimeout(this.pending.timer);
      this.pending.resolve({
        sessionId: this.options.sessionId,
        requestId: this.pending.requestId,
        ok: false,
        error: "The Settings window closed before the operation completed.",
      });
    }
    this.pending = null;
    for (const unlisten of this.unlistens.splice(0)) unlisten();
  }

  private async install<T>(
    subscribe: (handler: (payload: T) => void) => Promise<Unlisten>,
    handler: (payload: T) => void,
  ): Promise<void> {
    const stop = await subscribe(handler);
    if (!this.active) {
      stop();
      return;
    }
    this.unlistens.push(stop);
  }

  private receiveState(state: SettingsWindowState): void {
    if (!this.active || state.sessionId !== this.options.sessionId) return;
    this.seeded = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.options.onState(state);
  }

  private receiveResult(result: SettingsWindowResult): void {
    if (!this.active || result.sessionId !== this.options.sessionId) return;
    const pending = this.pending;
    if (!pending || pending.requestId !== result.requestId) return;
    if (pending.timer) clearTimeout(pending.timer);
    this.pending = null;
    pending.resolve(result);
  }

  private async requestSeed(): Promise<void> {
    if (!this.active || this.seeded) return;
    await this.options.transport.announceReady({ sessionId: this.options.sessionId });
    if (!this.active || this.seeded) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.requestSeed().catch((error: unknown) => {
        if (this.active) this.options.onError(`Could not request Settings state: ${String(error)}`);
      });
    }, this.retryMs);
  }
}
