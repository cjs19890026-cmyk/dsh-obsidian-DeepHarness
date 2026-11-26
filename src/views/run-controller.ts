/**
 * Explicit lifecycle for one chat run.
 *
 * Before this existed, `ChatView` tracked a single `running` boolean plus an
 * `AbortController`. That was enough for the happy path but not for the states
 * the UI actually has to explain: preparing can fail before a child exists,
 * a child can be stopped by the user or by the timeout, and every one of those
 * paths has to put the composer back into a usable state. The bug that
 * motivated this class was exactly that: a failed preparation returned early
 * and left `running = true`, so the send button stayed on "Stop" until the
 * user clicked it.
 *
 * The controller owns only state and cancellation. It does not spawn, render,
 * or know about Obsidian. `ChatView` drives it:
 *
 *   const run = controller.start();          // idle -> preparing
 *   const prep = await prepareRun(...);      // may fail
 *   if (!prep.ok) { controller.fail(run); return; }
 *   controller.markRunning(run);             // preparing -> running
 *   const result = await client.run(..., { signal: run.signal });
 *   controller.succeed(run);                 // or cancel / timeout / fail
 *   controller.finish(run);                  // terminal -> idle
 *
 * `finish()` is intentionally separate from the terminal transition: callers
 * can observe "succeeded/failed/..." and then always clean up in `finally`.
 * A stale handle is ignored, so an old run can never reset the state of a
 * newer one.
 */

export type RunState =
  | 'idle'
  | 'preparing'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'timedOut';

export interface RunHandle {
  readonly id: number;
  readonly signal: AbortSignal;
}

/** States in which the UI must treat the composer as busy. */
export function isActiveState(state: RunState): boolean {
  return state === 'preparing' || state === 'running';
}

export class RunController {
  private current: RunState = 'idle';
  private handle: RunHandle | null = null;
  private abortController: AbortController | null = null;
  private nextId = 1;

  get state(): RunState {
    return this.current;
  }

  /** True while a run is preparing or running (including one being stopped). */
  isActive(): boolean {
    return isActiveState(this.current);
  }

  /** True only from `idle`; a terminal state must be finished first. */
  canStart(): boolean {
    return this.current === 'idle';
  }

  /**
   * Begin a run. Returns null when another run is active; callers should not
   * create a second AbortController or touch the UI in that case.
   */
  start(): RunHandle | null {
    if (!this.canStart()) return null;
    const abortController = new AbortController();
    const handle: RunHandle = {
      id: this.nextId++,
      signal: abortController.signal,
    };
    this.handle = handle;
    this.abortController = abortController;
    this.current = 'preparing';
    return handle;
  }

  /** Move a current preparation into the spawned/running phase. */
  markRunning(handle: RunHandle): boolean {
    if (!this.isCurrent(handle) || this.current !== 'preparing') return false;
    this.current = 'running';
    return true;
  }

  succeed(handle: RunHandle): boolean {
    return this.transition(handle, 'running', 'succeeded');
  }

  fail(handle: RunHandle): boolean {
    if (!this.isCurrent(handle) || !isActiveState(this.current)) return false;
    this.current = 'failed';
    return true;
  }

  /**
   * Cancel a preparing or running run. The signal is aborted immediately so
   * a child that already exists is killed by `DshClient`; the caller still
   * waits for its promise to settle and then calls `finish()`.
   */
  cancel(handle: RunHandle): boolean {
    if (!this.isCurrent(handle) || !isActiveState(this.current)) return false;
    this.current = 'cancelled';
    this.abortController?.abort();
    return true;
  }

  timeout(handle: RunHandle): boolean {
    const changed = this.transition(handle, 'running', 'timedOut');
    if (changed) this.abortController?.abort();
    return changed;
  }

  /**
   * Stop whatever run is current, if any. This is the UI's "Stop" button:
   * it must not expose the handle to the view just to cancel. Returns false
   * when there is nothing active (idempotent double-click).
   */
  cancelCurrent(): boolean {
    return this.handle ? this.cancel(this.handle) : false;
  }

  /** Return to idle after a terminal state (or after teardown). */
  finish(handle: RunHandle): void {
    if (!this.isCurrent(handle)) return;
    if (isActiveState(this.current)) {
      // Defensive: every caller is supposed to transition first. If one
      // forgets, do not leave the controller permanently busy.
      this.current = 'cancelled';
      this.abortController?.abort();
    }
    this.current = 'idle';
    this.handle = null;
    this.abortController = null;
  }

  /** True when a handle still refers to the run currently owned by this view. */
  isCurrent(handle: RunHandle): boolean {
    return this.handle?.id === handle.id;
  }

  /** Abort and reset without waiting for the run promise (view teardown). */
  dispose(): void {
    this.abortController?.abort();
    this.handle = null;
    this.abortController = null;
    this.current = 'idle';
  }

  private transition(handle: RunHandle, from: RunState, to: RunState): boolean {
    if (!this.isCurrent(handle) || this.current !== from) return false;
    this.current = to;
    return true;
  }
}
