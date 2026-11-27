/**
 * Sequential batch orchestration.
 *
 * The batch is deliberately a queue, not a parallel fan-out: every item runs
 * the same DSH profile against the same vault, and two concurrent writers would
 * make the post-batch review (and undo) meaningless. A failed item does not
 * stop the queue; cancellation stops after the current child exits.
 */
export type BatchItemStatus =
  | 'pending'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'cancelled';

export interface BatchItem {
  /** Vault-relative Markdown path. */
  path: string;
  status: BatchItemStatus;
  answer?: string;
  error?: string;
  durationMs?: number;
}

export interface BatchItemResult {
  ok: boolean;
  answer?: string;
  error?: string;
  durationMs: number;
}

export interface BatchExecutor {
  run(item: BatchItem, signal: AbortSignal): Promise<BatchItemResult>;
  /** Stop the currently running child, if any. */
  cancel(): void;
}

export interface BatchResult {
  items: BatchItem[];
  cancelled: boolean;
}

export class BatchController {
  private active = false;
  private abort = new AbortController();

  constructor(private readonly executor: BatchExecutor) {}

  get isRunning(): boolean {
    return this.active;
  }

  /**
   * Run every path in order. `onProgress` receives a snapshot after every
   * transition, so the UI can render pending/running/terminal states without
   * reaching into the controller.
   */
  async run(
    paths: string[],
    onProgress: (items: BatchItem[]) => void,
  ): Promise<BatchResult> {
    if (this.active) throw new Error('batch already running');
    this.active = true;
    this.abort = new AbortController();
    const items: BatchItem[] = paths.map((path) => ({ path, status: 'pending' }));
    const emit = (): void => onProgress(items.map((item) => ({ ...item })));

    emit();
    for (const item of items) {
      if (this.abort.signal.aborted) {
        item.status = 'cancelled';
        emit();
        continue;
      }
      item.status = 'running';
      emit();
      try {
        const result = await this.executor.run(item, this.abort.signal);
        item.durationMs = result.durationMs;
        if (this.abort.signal.aborted) {
          item.status = 'cancelled';
        } else if (result.ok) {
          item.status = 'succeeded';
          item.answer = result.answer;
        } else {
          item.status = 'failed';
          item.error = result.error || 'failed';
        }
      } catch (e) {
        item.durationMs = 0;
        item.status = this.abort.signal.aborted ? 'cancelled' : 'failed';
        item.error = e instanceof Error ? e.message : String(e);
      }
      emit();
    }
    this.active = false;
    return { items, cancelled: this.abort.signal.aborted };
  }

  /** Ask the executor to stop; the queue marks the rest cancelled. */
  cancel(): void {
    if (!this.active) return;
    this.abort.abort();
    this.executor.cancel();
  }
}
