import { describe, expect, it } from 'vitest';
import { RunController, isActiveState } from './run-controller';

describe('RunController', () => {
  it('walks the happy path and returns to idle exactly once', () => {
    const controller = new RunController();
    expect(controller.state).toBe('idle');
    expect(controller.canStart()).toBe(true);

    const run = controller.start();
    expect(run).not.toBeNull();
    expect(controller.state).toBe('preparing');
    expect(controller.isActive()).toBe(true);

    expect(controller.markRunning(run!)).toBe(true);
    expect(controller.state).toBe('running');
    expect(controller.succeed(run!)).toBe(true);
    expect(controller.state).toBe('succeeded');
    expect(isActiveState(controller.state)).toBe(false);

    controller.finish(run!);
    expect(controller.state).toBe('idle');
    expect(controller.isActive()).toBe(false);
  });

  it('rejects a second start until the first run is finished', () => {
    const controller = new RunController();
    const first = controller.start();
    expect(first).not.toBeNull();

    expect(controller.start()).toBeNull();
    controller.cancel(first!);
    expect(controller.start()).toBeNull();

    controller.finish(first!);
    expect(controller.start()).not.toBeNull();
  });

  it('aborts the signal on cancel, and never reports the cancelled run as succeeded', () => {
    const controller = new RunController();
    const run = controller.start()!;
    controller.markRunning(run);
    expect(run.signal.aborted).toBe(false);

    expect(controller.cancel(run)).toBe(true);
    expect(run.signal.aborted).toBe(true);
    expect(controller.state).toBe('cancelled');
    expect(controller.succeed(run)).toBe(false);

    controller.finish(run);
    expect(controller.state).toBe('idle');
  });

  it('can cancel during preparation (before a child exists)', () => {
    const controller = new RunController();
    const run = controller.start()!;

    expect(controller.cancel(run)).toBe(true);
    expect(controller.state).toBe('cancelled');
    expect(run.signal.aborted).toBe(true);
    // A late preparation result must not transition the cancelled run.
    expect(controller.markRunning(run)).toBe(false);

    controller.finish(run);
    expect(controller.state).toBe('idle');
  });

  it('maps a preparation failure to failed and finish back to idle', () => {
    const controller = new RunController();
    const run = controller.start()!;

    expect(controller.fail(run)).toBe(true);
    expect(controller.state).toBe('failed');
    expect(controller.isActive()).toBe(false);
    controller.finish(run);
    expect(controller.state).toBe('idle');
  });

  it('marks timeouts distinctly and aborts the process signal', () => {
    const controller = new RunController();
    const run = controller.start()!;
    controller.markRunning(run);

    expect(controller.timeout(run)).toBe(true);
    expect(controller.state).toBe('timedOut');
    expect(run.signal.aborted).toBe(true);
    controller.finish(run);
    expect(controller.state).toBe('idle');
  });

  it('ignores stale handles instead of resetting a newer run', () => {
    const controller = new RunController();
    const first = controller.start()!;
    controller.cancel(first);
    controller.finish(first);

    const second = controller.start()!;
    expect(controller.isCurrent(first)).toBe(false);
    expect(controller.isCurrent(second)).toBe(true);

    // The old promise may settle after a new run has started; it must not
    // touch the new run's state.
    controller.finish(first);
    expect(controller.state).toBe('preparing');
    expect(controller.cancel(second)).toBe(true);
  });

  it('dispose aborts the live signal and returns to idle', () => {
    const controller = new RunController();
    const run = controller.start()!;
    controller.markRunning(run);

    controller.dispose();
    expect(run.signal.aborted).toBe(true);
    expect(controller.state).toBe('idle');
    expect(controller.isCurrent(run)).toBe(false);
  });
});
