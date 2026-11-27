import { t } from '../i18n/index';
import type { DshSettings } from '../settings/types';
import type { PreparationIssue } from './dsh-runner';
import { DshRunner } from './dsh-runner';
import { DshClient } from './dsh-client';
import { parseHeadlessOutput } from './pure';
import type { BatchExecutor, BatchItem, BatchItemResult } from '../core/batch-controller';

/** Everything needed to spawn each batch item, prepared once per batch. */
export interface BatchEnvironment {
  bin: string;
  nodeBin: string;
  dshScript: string;
  dshHome: string;
  workdir: string;
  patchPath: string[];
}

export type PreparedBatch =
  | { ok: true; env: BatchEnvironment; issues: string[] }
  | { ok: false; error: string };

/**
 * Prepare the shared DSH environment for a batch. Mirrors ChatView.prepareRun
 * without the view-specific context meter / setup-message rendering; the
 * caller surfaces `issues` and `error` in the progress dialog.
 */
export async function prepareBatchEnvironment(
  runner: DshRunner,
  vaultRoot: string,
  settings: DshSettings,
): Promise<PreparedBatch> {
  const bin = await runner.detectBin();
  if (!bin) return { ok: false, error: t('chat.noDsh') };
  const nodeBin = await runner.detectNode();
  if (!nodeBin) return { ok: false, error: t('chat.noNode') };
  const dshScript = runner.resolveDshScript(bin);
  if (!dshScript) return { ok: false, error: t('chat.dshNotNodeScript') };

  const issues: PreparationIssue[] = [];
  try {
    const patches = await runner.ensureVaultPatch(vaultRoot, issues);
    const skillDirs = runner.ensureSkillDirsPatch(vaultRoot, issues);
    const pluginHome = runner.ensurePluginDshHome(vaultRoot, {
      model: settings.model,
      effort: settings.reasoningEffort,
    }, issues);
    const dshHome = pluginHome ?? runner.dshHome();
    runner.ensureObsidianSkill(vaultRoot, issues, dshHome);
    runner.ensureMemoryFile(vaultRoot, issues);
    const workdir = runner.workdir(vaultRoot, issues);
    return {
      ok: true,
      env: {
        bin,
        nodeBin,
        dshScript,
        dshHome,
        workdir,
        patchPath: [patches.persona, patches.think, skillDirs].filter(
          (path): path is string => path !== null,
        ),
      },
      issues: issues.map((issue) => issue.message),
    };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** One DSH headless run per selected note. */
export class BatchExecutorImpl implements BatchExecutor {
  constructor(
    private readonly client: DshClient,
    private readonly runner: DshRunner,
    private readonly settings: DshSettings,
    private readonly env: BatchEnvironment,
    private readonly instruction: string,
  ) {}

  async run(item: BatchItem, signal: AbortSignal): Promise<BatchItemResult> {
    const prompt = t('batch.prompt', { path: item.path, instruction: this.instruction });
    const task = this.runner.buildTask(prompt, []);
    const startedAt = Date.now();
    try {
      const result = await this.client.run(task, {
        dshBin: this.env.bin,
        nodeBin: this.env.nodeBin,
        dshScript: this.env.dshScript,
        cwd: this.env.workdir,
        dshHome: this.env.dshHome,
        apiKey: this.settings.apiKey.trim() || undefined,
        provider: this.settings.provider,
        toolsMode: this.settings.toolExecutionMode,
        permissionMode: this.settings.permissionMode,
        patchPath: this.env.patchPath,
        timeoutMs: this.settings.timeoutSec * 1000,
        signal,
        onStdoutLine: () => {
          // Batch progress is per item, not per token; the answer is captured
          // from stdout after the child exits.
        },
      });
      const answer = parseHeadlessOutput(result.stdout);
      const ok = result.exitCode === 0 && result.killReason === null;
      let error: string | undefined;
      if (!ok) {
        if (result.killReason === 'timeout') error = t('chat.timedOut');
        else if (result.killReason === 'user') error = t('chat.cancelled');
        else error = firstLine(result.stderr) || t('batch.failed');
      }
      return { ok, answer: answer || undefined, error, durationMs: result.durationMs };
    } catch (e) {
      return {
        ok: false,
        error: e instanceof Error ? e.message : String(e),
        durationMs: Date.now() - startedAt,
      };
    }
  }

  cancel(): void {
    this.client.stop();
  }
}

function firstLine(text: string): string {
  return text.trim().split('\n').find((line) => line.trim().length > 0)?.trim() ?? '';
}
