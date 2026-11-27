import { describe, expect, it, vi } from 'vitest';
import { BatchController, type BatchExecutor, type BatchItem } from './batch-controller';

function executor(handler: (item: BatchItem) => Promise<{ ok: boolean; answer?: string; error?: string; durationMs: number }>): BatchExecutor & { cancel: ReturnType<typeof vi.fn> } {
  const cancel = vi.fn();
  return { run: vi.fn(handler), cancel } as unknown as BatchExecutor & { cancel: ReturnType<typeof vi.fn> };
}

describe('BatchController', () => {
  it('runs items sequentially and reports every transition', async () => {
    const seen: string[] = [];
    const exec = executor(async (item) => {
      seen.push(item.path);
      return { ok: true, answer: `done ${item.path}`, durationMs: 5 };
    });
    const controller = new BatchController(exec);
    const snapshots: string[][] = [];

    const result = await controller.run(['a.md', 'b.md', 'c.md'], (items) => {
      snapshots.push(items.map((item) => `${item.path}:${item.status}`));
    });

    expect(seen).toEqual(['a.md', 'b.md', 'c.md']);
    expect(result.items.map((item) => item.status)).toEqual(['succeeded', 'succeeded', 'succeeded']);
    expect(result.cancelled).toBe(false);
    expect(snapshots[0]).toEqual(['a.md:pending', 'b.md:pending', 'c.md:pending']);
    expect(snapshots[1]).toEqual(['a.md:running', 'b.md:pending', 'c.md:pending']);
  });

  it('continues after a failed item and records the error', async () => {
    const exec = executor(async (item) => {
      if (item.path === 'bad.md') return { ok: false, error: 'no access', durationMs: 3 };
      return { ok: true, answer: 'ok', durationMs: 2 };
    });
    const result = await new BatchController(exec).run(['bad.md', 'good.md'], () => {});

    expect(result.items[0]).toMatchObject({ status: 'failed', error: 'no access' });
    expect(result.items[1]).toMatchObject({ status: 'succeeded', answer: 'ok' });
  });

  it('marks the current and remaining items cancelled on cancel()', async () => {
    let release: ((value: { ok: boolean; durationMs: number }) => void) | undefined;
    const exec = executor((item) => {
      if (item.path === 'a.md') {
        return new Promise((resolve) => {
          release = resolve as typeof release;
        });
      }
      return Promise.resolve({ ok: true, durationMs: 1 });
    });
    const controller = new BatchController(exec);
    const running = controller.run(['a.md', 'b.md', 'c.md'], () => {});
    await Promise.resolve();
    controller.cancel();
    release?.({ ok: true, durationMs: 1 });

    const result = await running;
    expect(exec.cancel).toHaveBeenCalled();
    expect(result.cancelled).toBe(true);
    expect(result.items.map((item) => item.status)).toEqual(['cancelled', 'cancelled', 'cancelled']);
  });

  it('rejects a second run while the first is active', async () => {
    let release: (() => void) | undefined;
    const exec = executor(() => new Promise((resolve) => {
      release = () => resolve({ ok: true, durationMs: 1 });
    }));
    const controller = new BatchController(exec);
    const first = controller.run(['a.md'], () => {});
    await expect(controller.run(['b.md'], () => {})).rejects.toThrow('batch already running');
    release?.();
    await first;
  });
});
