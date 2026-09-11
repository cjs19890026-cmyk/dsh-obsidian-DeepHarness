import { App, Notice, Platform, PluginSettingTab, Setting, requestUrl, type DropdownComponent, type SettingDefinitionItem, type SettingDefinitionRender, type TextComponent } from 'obsidian';
import type DshPlugin from '../main';
import { t, type TranslationKey } from '../i18n';
import { DshRunner } from '../dsh-runner';
import { pluginPaths } from '../paths';
import { DiagnosticPromptModal, FolderSuggestModal } from '../modals';
import { comparePluginVersion, fetchLatestRelease, type PluginUpdateStatus } from '../updates';
import {
  buildCheckOutcomes,
  buildRepairPrompt,
  CHECK_HINT_KEYS,
  CHECK_LABEL_KEYS,
  checkWritableDir,
  checkWritableFile,
  hasFailures,
  type CheckOutcome,
  type WriteProbe,
} from '../diagnostics';
import {
  DEFAULT_SETTINGS,
  MODEL_OPTIONS,
  PERMISSION_OPTIONS,
  REASONING_OPTIONS,
  TOOL_EXECUTION_LABELS,
  TOOL_EXECUTION_MODES,
  permissionLabel,
  type DshSettings,
  type OptionFieldKey,
  type PermissionMode,
  type ReasoningEffort,
  type ToolExecutionMode,
} from './types';
import {
  buildProviderOptions,
  mergeModelIds,
  modelDisplayLabel,
  modelOptionsWithCurrent,
  normalizeStoredSettings,
} from './validate';
import { isSafeModelId } from '../dsh-config';
// The page uses the validation helpers, and these re-exports also keep
// `import … from './settings'` working for every existing caller after the
// C-2 split — `export *` re-exports the names into this module's scope too.
export * from './types';
export * from './validate';

/**
 * The settings page (Obsidian's 1.13 declarative API).
 *
 * Split out of settings.ts (review C-2). The data shape is `./types` and the
 * validation rules are `./validate`; both are re-exported below so
 * `import … from './settings'` keeps working for every existing caller.
 */

export class DshSettingTab extends PluginSettingTab {
  plugin: DshPlugin;

  constructor(app: App, plugin: DshPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  getSettingDefinitions(): SettingDefinitionItem[] {
    // Every read and write below goes through `this.plugin.settings` and never
    // through a captured snapshot: these render callbacks fire later (and their
    // onChange handlers later still), so a captured reference would keep
    // writing into an object that `loadSettings()`'s wholesale replacement has
    // already orphaned — changes that appear to save and silently do not.
    const render = (
      name: string,
      desc: string | undefined,
      fn: (setting: Setting) => void,
    ): SettingDefinitionRender => ({
      name,
      ...(desc ? { desc } : {}),
      render: fn,
    });

    // The model list editor adds and removes rows imperatively, so it needs
    // the live dropdown handle and the "new model" input to redraw them in
    // place: the settings tab is not re-rendered on change.
    let modelDropdown: DropdownComponent | null = null;
    let newModelText: TextComponent | null = null;

    return [
      {
        type: 'group',
        heading: t('settings.groupGeneral'),
        items: [
          render(t('settings.language.name'), t('settings.language.desc'), (setting) => {
            setting.addDropdown((dd) => {
              dd.addOption('auto', 'Auto');
              dd.addOption('en', 'English');
              dd.addOption('zh', '中文');
              dd.setValue(this.plugin.settings.language).onChange(async (value) => {
                this.plugin.settings.language = value as DshSettings['language'];
                // Apply the locale BEFORE persisting: saveSettings() notifies
                // settings listeners (chat trigger labels), which must render
                // in the NEW language rather than the old one.
                this.plugin.applyLocale();
                await this.plugin.saveSettings();
                this.update();
              });
            });
          }),

          render(t('settings.workdir.name'), t('settings.workdir.desc'), (setting) => {
            setting.addText((text) => text
              .setPlaceholder(t('settings.workdir.placeholder'))
              .setValue(this.plugin.settings.workdir)
              .onChange(async (value) => {
                this.plugin.settings.workdir = value;
                await this.plugin.saveSettings();
              }));
          }),

          render(t('settings.timeout.name'), t('settings.timeout.desc'), (setting) => {
            setting.addSlider((slider) => slider
              .setLimits(30, 1800, 30)
              .setValue(this.plugin.settings.timeoutSec)
              .onChange(async (value) => {
                this.plugin.settings.timeoutSec = value;
                await this.plugin.saveSettings();
              }));
          }),

          render(t('settings.memory.name'), t('settings.memory.desc'), (setting) => {
            setting.addToggle((toggle) => toggle
              .setValue(this.plugin.settings.memoryEnabled)
              .onChange(async (value) => {
                this.plugin.settings.memoryEnabled = value;
                await this.plugin.saveSettings();
              }));
          }),

          render(t('settings.historyLimit.name'), t('settings.historyLimit.desc'), (setting) => {
            setting.addSlider((slider) => slider
              .setLimits(10, 200, 10)
              .setValue(this.plugin.settings.historyLimit)
              .onChange(async (value) => {
                this.plugin.settings.historyLimit = value;
                await this.plugin.saveSettings();
                this.plugin.history?.setLimit(value);
              }));
          }),

        ],
      },
      {
        type: 'group',
        heading: t('settings.groupModel'),
        items: [
          render(t('settings.provider.name'), t('settings.provider.desc'), (setting) => {
            setting.addDropdown((dd) => {
              for (const p of buildProviderOptions()) {
                dd.addOption(p.id, p.label);
              }
              dd.setValue(this.plugin.settings.provider).onChange(async (value) => {
                this.plugin.settings.provider = value;
                await this.plugin.saveSettings();
              });
            });
          }),

          render(t('settings.model.name'), t('settings.model.desc'), (setting) => {
            const options = modelOptionsWithCurrent(this.plugin.settings.models, this.plugin.settings.model);
            setting.addDropdown((dd) => {
              modelDropdown = dd;
              for (const m of options) dd.addOption(m.id, m.label);
              dd.setValue(this.plugin.settings.model).onChange(async (value) => {
                if (value === this.plugin.settings.model) return;
                this.plugin.settings.model = value;
                await this.plugin.saveSettings();
              });
            });
          }),

          // The model list is user-grown, so it is the one control that can
          // become arbitrarily tall. It lives in a bounded, scrollable box and
          // the row is stacked (description on top, controls underneath) so
          // importing a large catalog cannot stretch the settings page.
          render(t('settings.modelList.name'), t('settings.modelList.desc'), (setting) => {
            setting.settingEl.addClass('dsh-setting-stacked');

            const box = setting.settingEl.createDiv({ cls: 'dsh-model-box' });
            const rows = box.createDiv({ cls: 'dsh-model-list' });
            const countEl = box.createDiv({ cls: 'dsh-model-count' });

            const redraw = (): void => {
              rows.empty();
              for (const id of this.plugin.settings.models) {
                const row = rows.createDiv({ cls: 'dsh-model-row' });
                row.createSpan({ text: modelDisplayLabel(id), cls: 'dsh-model-row-label' });
                row.createSpan({ text: id, cls: 'dsh-model-row-id' });
                const del = row.createEl('button', {
                  text: t('settings.modelList.remove'),
                  cls: 'dsh-model-row-remove',
                });
                // Keep at least one model: an empty dropdown would leave the
                // plugin with nothing to run and no obvious way back.
                del.disabled = this.plugin.settings.models.length <= 1;
                del.onclick = async () => {
                  this.plugin.settings.models = this.plugin.settings.models.filter((x) => x !== id);
                  // Deleting the active model is an explicit act, so switching
                  // the selection to the first survivor is expected here (the
                  // load-time normalizer never switches it silently).
                  if (this.plugin.settings.model === id) this.plugin.settings.model = this.plugin.settings.models[0];
                  await this.plugin.saveSettings();
                  redraw();
                  refreshDropdown();
                };
              }
              countEl.setText(t('settings.modelList.count', { count: String(this.plugin.settings.models.length) }));
            };

            // Rebuild the dropdown in place so a removal or addition shows up
            // without closing the settings tab.
            const refreshDropdown = (): void => {
              const dd = modelDropdown;
              if (!dd) return;
              dd.selectEl.empty();
              for (const m of modelOptionsWithCurrent(this.plugin.settings.models, this.plugin.settings.model)) {
                dd.addOption(m.id, m.label);
              }
              dd.setValue(this.plugin.settings.model);
            };

            setting.addText((text) => {
              text.setPlaceholder(t('settings.modelList.placeholder'));
              newModelText = text;
            });
            setting.addButton((button) => button
              .setButtonText(t('settings.modelList.add'))
              .setCta()
              .onClick(async () => {
                const input = newModelText;
                const next = input?.getValue().trim() ?? '';
                if (!next) return;
                if (!isSafeModelId(next)) {
                  input?.inputEl.addClass('dsh-input-invalid');
                  if (input) input.inputEl.title = t('settings.modelList.invalid');
                  return;
                }
                input?.inputEl.removeClass('dsh-input-invalid');
                if (input) input.inputEl.title = '';
                this.plugin.settings.models = mergeModelIds(this.plugin.settings.models, [next]).models;
                input?.setValue('');
                await this.plugin.saveSettings();
                redraw();
                refreshDropdown();
              }));
            setting.addButton((button) => button
              .setButtonText(t('settings.modelList.import'))
              .setTooltip(t('settings.modelList.importTooltip'))
              .onClick(async () => {
                // Explicit, never automatic: this is the only place the plugin
                // reads the user's DSH catalog, so someone running TUI-only (or
                // who never opened DSH's model settings) is unaffected by it.
                const runner = new DshRunner(
                  this.plugin.settings,
                  this.plugin.app.vault.configDir,
                );
                const found = (runner.userDshConfig()?.models ?? []).map((m) => m.id);
                const { models, added } = mergeModelIds(this.plugin.settings.models, found);
                this.plugin.settings.models = models;
                await this.plugin.saveSettings();
                redraw();
                refreshDropdown();
                new Notice(added.length > 0
                  ? t('settings.modelList.imported', { count: String(added.length) })
                  : t('settings.modelList.importNone'));
              }));

            // Move the box above the controls: Obsidian appends the control row
            // in the Setting constructor, and the list reads better between the
            // description and the add/import controls.
            const control = setting.settingEl.querySelector('.setting-item-control');
            if (control) {
              setting.settingEl.insertBefore(box, control);
            }

            redraw();
          }),

          render(t('settings.reasoning.name'), t('settings.reasoning.desc'), (setting) => {
            setting.addDropdown((dd) => {
              for (const r of REASONING_OPTIONS) dd.addOption(r.id, r.label);
              dd.setValue(this.plugin.settings.reasoningEffort).onChange(async (value) => {
                this.plugin.settings.reasoningEffort = value as ReasoningEffort;
                await this.plugin.saveSettings();
              });
            });
          }),

        ],
      },
      {
        type: 'group',
        heading: t('settings.groupPermission'),
        items: [
          render(t('settings.permission.name'), t('settings.permission.desc'), (setting) => {
            setting.addDropdown((dd) => {
              for (const p of PERMISSION_OPTIONS) dd.addOption(p.id, permissionLabel(p.id));
              dd.setValue(this.plugin.settings.permissionMode).onChange(async (value) => {
                await this.plugin.setPermissionMode(value as PermissionMode);
                dd.setValue(this.plugin.settings.permissionMode);
              });
            });
          }),

          render(t('settings.toolMode.name'), t('settings.toolMode.desc'), (setting) => {
            setting.addDropdown((dd) => {
              for (const mode of TOOL_EXECUTION_MODES) {
                const label = mode === '' ? t('settings.toolModeDefault') : TOOL_EXECUTION_LABELS[mode];
                dd.addOption(mode, label);
              }
              dd.setValue(this.plugin.settings.toolExecutionMode).onChange(async (value) => {
                this.plugin.settings.toolExecutionMode = value as ToolExecutionMode;
                await this.plugin.saveSettings();
              });
            });
          }),

          render(t('settings.showThinking.name'), t('settings.showThinking.desc'), (setting) => {
            setting.addToggle((toggle) => toggle
              .setValue(this.plugin.settings.showThinking)
              .onChange(async (value) => {
                this.plugin.settings.showThinking = value;
                await this.plugin.saveSettings();
              }));
          }),

          render(t('settings.showTools.name'), t('settings.showTools.desc'), (setting) => {
            setting.addToggle((toggle) => toggle
              .setValue(this.plugin.settings.showTools)
              .onChange(async (value) => {
                this.plugin.settings.showTools = value;
                await this.plugin.saveSettings();
              }));
          }),

        ],
      },
      {
        type: 'group',
        heading: t('settings.groupSkills'),
        items: [
          render(t('settings.obsidianSkill.name'), t('settings.obsidianSkill.desc'), (setting) => {
            setting.addToggle((toggle) => toggle
              .setValue(this.plugin.settings.obsidianSkill)
              .onChange(async (value) => {
                this.plugin.settings.obsidianSkill = value;
                await this.plugin.saveSettings();
              }));
          }),

          render(t('settings.extraSkillDirs.name'), t('settings.extraSkillDirs.desc'), (setting) => {
            setting.addText((text) => text
              .setPlaceholder(t('settings.extraSkillDirs.placeholder'))
              .setValue(this.plugin.settings.extraSkillDirs)
              .onChange(async (value) => {
                this.plugin.settings.extraSkillDirs = value;
                await this.plugin.saveSettings();
              }));
            // Folder picker: novice-friendly way to add vault folders without
            // typing a path (picked folders are vault-internal by construction).
            setting.addButton((button) => button
              .setButtonText(t('settings.extraSkillDirs.pick'))
              .onClick(() => {
                new FolderSuggestModal(this.app, (picked) => {
                  const existing = this.plugin.settings.extraSkillDirs.split(',').map((x) => x.trim()).filter(Boolean);
                  if (!existing.includes(picked)) existing.push(picked);
                  this.plugin.settings.extraSkillDirs = existing.join(', ');
                  void this.plugin.saveSettings();
                  this.update();
                }).open();
              }));
          }),

        ],
      },
      {
        type: 'group',
        heading: t('settings.groupPersona'),
        items: [
          render(t('settings.persona.name'), t('settings.persona.desc'), (setting) => {
            setting.addTextArea((text) => {
              text
                .setPlaceholder(t('settings.persona.placeholder'))
                .setValue(this.plugin.settings.customPersona)
                .onChange(async (value) => {
                  this.plugin.settings.customPersona = value;
                  await this.plugin.saveSettings();
                });
              text.inputEl.rows = 3;
            });
          }),

        ],
      },
      {
        type: 'group',
        heading: t('settings.groupRuntime'),
        items: [
          render(t('settings.dshBin.name'), t('settings.dshBin.desc'), (setting) => {
            setting.addText((text) => text
              .setPlaceholder(t('settings.dshBin.placeholder'))
              .setValue(this.plugin.settings.dshBin)
              .onChange(async (value) => {
                this.plugin.settings.dshBin = value;
                await this.plugin.saveSettings();
              }));
          }),

          render(t('settings.nodeBin.name'), t('settings.nodeBin.desc'), (setting) => {
            setting.addText((text) => text
              .setPlaceholder(t('settings.nodeBin.placeholder'))
              .setValue(this.plugin.settings.nodeBin)
              .onChange(async (value) => {
                this.plugin.settings.nodeBin = value;
                await this.plugin.saveSettings();
              }));
          }),

          render(t('settings.dshHome.name'), t('settings.dshHome.desc'), (setting) => {
            setting.addText((text) => text
              .setPlaceholder(t('settings.dshHome.placeholder'))
              .setValue(this.plugin.settings.dshHome)
              .onChange(async (value) => {
                this.plugin.settings.dshHome = value;
                await this.plugin.saveSettings();
              }));
          }),

          render(t('settings.apiKey.name'), t('settings.apiKey.desc'), (setting) => {
            // P2-D: surface the plaintext-storage risk while a plugin key is set
            // (data.json lives inside the vault, so it syncs with the vault).
            const warningEl = setting.descEl.createDiv({ cls: 'dsh-setting-warning' });
            warningEl.setText(t('settings.apiKey.warning'));
            const applyWarning = (): void => {
              warningEl.style.display = this.plugin.settings.apiKey ? '' : 'none';
            };
            applyWarning();
            setting.addText((text) => {
              text
                .setPlaceholder(t('settings.apiKey.placeholder'))
                .setValue(this.plugin.settings.apiKey)
                .onChange(async (value) => {
                  this.plugin.settings.apiKey = value.trim();
                  await this.plugin.saveSettings();
                  applyWarning();
                });
              text.inputEl.type = 'password';
              text.inputEl.autocomplete = 'off';
            });
          }),

        ],
      },
      {
        type: 'group',
        heading: t('settings.groupUpdates'),
        items: [
          render(t('settings.update.name'), t('settings.update.desc'), (setting) => {
            const current = this.plugin.manifest.version;
            const statusEl = setting.settingEl.createEl('p', { cls: 'dsh-check-ok' });
            statusEl.setText(t('settings.update.current', { version: current }));

            setting.addButton((button) => button
              .setButtonText(t('settings.update.check'))
              .onClick(async () => {
                button.setDisabled(true);
                statusEl.removeClass('dsh-check-ok', 'dsh-check-fail', 'dsh-check-warn');
                statusEl.setText(t('settings.update.checking'));
                // Only on explicit user action: GitHub rate-limits
                // unauthenticated callers to ~60 requests per hour per IP.
                let status: PluginUpdateStatus;
                try {
                  const { release, error } = await fetchLatestRelease(requestUrl);
                  status = comparePluginVersion(current, release, error ?? undefined);
                } catch (e) {
                  status = {
                    kind: 'check-failed',
                    current,
                    error: e instanceof Error ? e.message : String(e),
                  };
                }
                statusEl.removeClass('dsh-check-ok', 'dsh-check-fail', 'dsh-check-warn');
                if (status.kind === 'update-available') {
                  statusEl.addClass('dsh-check-warn');
                  statusEl.setText(t('settings.update.available', {
                    current: status.current,
                    latest: status.latest,
                  }));
                  new Notice(t('settings.update.notice'));
                } else if (status.kind === 'up-to-date') {
                  statusEl.addClass('dsh-check-ok');
                  statusEl.setText(t('settings.update.latest', { version: status.current }));
                } else {
                  statusEl.addClass('dsh-check-fail');
                  statusEl.setText(t('settings.update.failed', { message: status.error }));
                }
                button.setDisabled(false);
              }));
          }),

          // Stacked, bounded, and rebuilt on every run: the previous version
          // appended <p> elements straight into the row, which is a flex row,
          // so long paths spilled outside the border — and repeated clicks
          // stacked duplicate reports on top of each other.
          render(t('settings.check.title'), t('settings.check.help'), (setting) => {
            setting.settingEl.addClass('dsh-setting-stacked');

            const box = setting.settingEl.createDiv({ cls: 'dsh-check-box' });
            const list = box.createDiv({ cls: 'dsh-check-list' });
            const actions = box.createDiv({ cls: 'dsh-check-actions' });

            // Latest outcomes, kept so the copy button can report without
            // forcing a second run.
            let lastOutcomes: CheckOutcome[] = [];

            const renderRow = (o: CheckOutcome, hint: string | undefined): void => {
              const row = list.createDiv({ cls: `dsh-check-row ${o.ok ? 'is-ok' : 'is-fail'}` });
              const head = row.createDiv({ cls: 'dsh-check-head' });
              head.createSpan({ text: o.ok ? '✓' : '✗', cls: 'dsh-check-icon' });
              head.createSpan({ text: t(CHECK_LABEL_KEYS[o.id] as TranslationKey) });
              if (o.detail) {
                row.createDiv({ text: o.detail, cls: 'dsh-check-detail' });
              }
              if (o.error) {
                row.createDiv({ text: o.error, cls: 'dsh-check-error' });
              }
              // The remedy only appears under a failure: an advisory next to a
              // passing check is noise, and this is the part that turns "EACCES:
              // permission denied" into something a user can act on.
              if (!o.ok && hint) {
                row.createDiv({ text: `→ ${hint}`, cls: 'dsh-check-hint' });
              }
            };

            const runChecks = async (): Promise<void> => {
              list.empty();
              const runner = new DshRunner(this.plugin.settings, this.plugin.app.vault.configDir);
              const diag = await runner.diagnose();

              const vaultRoot = this.plugin.getVaultRoot();
              const paths = pluginPaths(vaultRoot, this.plugin.app.vault.configDir);
              const targets: Array<{ id: WriteProbe['id']; path: string; isFile: boolean }> = [
                { id: 'generatedDir', path: paths.generatedDir, isFile: false },
                { id: 'pluginHome', path: paths.dshHomeDir, isFile: false },
                { id: 'settingsYaml', path: paths.dshHomeFile('settings.yaml'), isFile: true },
              ];

              const outcomes = buildCheckOutcomes(diag, targets.map((target) => ({
                id: target.id,
                path: target.path,
                error: target.isFile
                  ? checkWritableFile(target.path)
                  : checkWritableDir(target.path),
              })), {
                missingDsh: t('settings.check.missing'),
                missingNode: t('settings.checkNoNode'),
              });

              lastOutcomes = outcomes;
              for (const o of outcomes) {
                const hintKey = CHECK_HINT_KEYS[o.id];
                renderRow(o, hintKey ? t(hintKey as TranslationKey) : undefined);
              }

              // The escape hatch is only worth showing once something is
              // actually wrong; on a clean run it is pure clutter.
              actions.toggleClass('is-hidden', !hasFailures(outcomes));
            };

            setting.addButton((button) => button
              .setButtonText(t('settings.check.run'))
              .setCta()
              .onClick(() => void runChecks()));

            // The copy action lives in the escape-hatch row inside the box,
            // not beside "Run check": it is a follow-up to a failure, not a
            // peer of running the checks.
            actions.createSpan({ text: t('settings.check.copyNote'), cls: 'dsh-check-copy-note' });
            const copyBtn = actions.createEl('button', {
              text: t('settings.check.copy'),
              cls: 'dsh-check-copy',
            });
            copyBtn.setAttr('aria-label', t('settings.check.copyTooltip'));
            copyBtn.onclick = async () => {
              // Copying before running would produce a report with no results,
              // so run first when nothing has been collected yet.
              if (lastOutcomes.length === 0) await runChecks();
              new DiagnosticPromptModal(this.app, buildRepairPrompt(lastOutcomes, {
                pluginVersion: this.plugin.manifest.version,
                vaultRoot: this.plugin.getVaultRoot(),
                configDir: this.plugin.app.vault.configDir,
                dshHome: this.plugin.settings.dshHome,
                platform: Platform.isMacOS ? 'darwin' : (Platform.isWin ? 'win32' : 'linux'),
                arch: process.arch,
                nodeVersion: process.version,
              })).open();
            };

            const control = setting.settingEl.querySelector('.setting-item-control');
            if (control) setting.settingEl.insertBefore(box, control);
          }),

          {
            name: '',
            desc: t('settings.footer'),
            render: () => {},
          },
        ],
      },
    ];
  }
}

export function obsidianLocale(app: App): string {
  return (app as unknown as { i18n?: { language?: string } }).i18n?.language ?? 'en';
}
