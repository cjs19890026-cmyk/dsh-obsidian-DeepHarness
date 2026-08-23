import { App, PluginSettingTab, Setting, type SettingDefinitionItem, type SettingDefinitionRender } from 'obsidian';
import type DshPlugin from './main';
import { t, Locale } from './i18n';
import { DshRunner } from './dsh-runner';

export interface DshSettings {
  dshBin: string;
  nodeBin: string;
  dshHome: string;
  workdir: string;
  timeoutSec: number;
  memoryEnabled: boolean;
  language: 'auto' | Locale;
  customPersona: string;
  /** Tool execution backend: '' (default native) | 'native' | 'code' | 'both'. */
  toolExecutionMode: string;
  /** DeepSeek model id: deepseek-v4-flash | deepseek-v4-pro. */
  model: string;
  /** Reasoning effort: off | high | max. */
  reasoningEffort: string;
  /** DSH sandbox mode: read-only | workspace-write | danger-full-access. */
  permissionMode: string;
  /** Show the thinking (reasoning) block in the chat. */
  showThinking: boolean;
  /** Show tool call blocks in the chat. */
  showTools: boolean;
  /** Max history entries kept (10-200). */
  historyLimit: number;
  /** Ship the built-in `obsidian` DSH skill into the isolated DSH_HOME. */
  obsidianSkill: boolean;
  /** Comma-separated vault-relative extra skill dirs (scanned + passed to DSH). */
  extraSkillDirs: string;
  /** Plugin-only DeepSeek API key; empty = reuse the desktop DSH credentials. */
  apiKey: string;
  /** Model API backend used by the plugin's isolated DSH_HOME. */
  provider: 'deepseek-official' | 'opencode-go';
}

export const DEFAULT_SETTINGS: DshSettings = {
  dshBin: '',
  nodeBin: '',
  dshHome: '~/.dsh',
  workdir: '',
  timeoutSec: 600,
  memoryEnabled: true,
  language: 'auto',
  customPersona: '',
  toolExecutionMode: '',
  model: 'deepseek-v4-flash',
  reasoningEffort: 'high',
  permissionMode: 'workspace-write',
  showThinking: true,
  showTools: true,
  historyLimit: 50,
  obsidianSkill: true,
  extraSkillDirs: 'Library/Skills, .claude/skills',
  apiKey: '',
  provider: 'deepseek-official',
};

export const PROVIDER_OPTIONS = [
  { id: 'deepseek-official', label: 'DeepSeek 官方 API' },
  { id: 'opencode-go', label: 'OpenCode Go' },
] as const;

export const MODEL_OPTIONS = [
  { id: 'deepseek-v4-flash', label: 'DeepSeek V4 Flash' },
  { id: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro' },
] as const;

export const REASONING_OPTIONS = [
  { id: 'off', label: 'Off' },
  { id: 'high', label: 'High' },
  { id: 'max', label: 'Max' },
] as const;

export const PERMISSION_OPTIONS = [
  { id: 'read-only', label: '只读' },
  { id: 'workspace-write', label: '工作区写入' },
  { id: 'danger-full-access', label: '完全访问' },
] as const;

export class DshSettingTab extends PluginSettingTab {
  plugin: DshPlugin;

  constructor(app: App, plugin: DshPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  getSettingDefinitions(): SettingDefinitionItem[] {
    const s = this.plugin.settings;
    const render = (
      name: string,
      desc: string | undefined,
      fn: (setting: Setting) => void,
    ): SettingDefinitionRender => ({
      name,
      ...(desc ? { desc } : {}),
      render: fn,
    });

    return [
      {
        type: 'group',
        heading: '常规',
        items: [
          render(t('settings.language.name'), t('settings.language.desc'), (setting) => {
            setting.addDropdown((dd) => {
              dd.addOption('auto', 'Auto');
              dd.addOption('en', 'English');
              dd.addOption('zh', '中文');
              dd.setValue(s.language).onChange(async (value) => {
                s.language = value as DshSettings['language'];
                await this.plugin.saveSettings();
                this.plugin.applyLocale();
                this.update();
              });
            });
          }),

          render(t('settings.dshBin.name'), t('settings.dshBin.desc'), (setting) => {
            setting.addText((text) => text
              .setPlaceholder(t('settings.dshBin.placeholder'))
              .setValue(s.dshBin)
              .onChange(async (value) => {
                s.dshBin = value;
                await this.plugin.saveSettings();
              }));
          }),

          render(t('settings.nodeBin.name'), t('settings.nodeBin.desc'), (setting) => {
            setting.addText((text) => text
              .setPlaceholder(t('settings.nodeBin.placeholder'))
              .setValue(s.nodeBin)
              .onChange(async (value) => {
                s.nodeBin = value;
                await this.plugin.saveSettings();
              }));
          }),

          render(t('settings.dshHome.name'), t('settings.dshHome.desc'), (setting) => {
            setting.addText((text) => text
              .setPlaceholder(t('settings.dshHome.placeholder'))
              .setValue(s.dshHome)
              .onChange(async (value) => {
                s.dshHome = value;
                await this.plugin.saveSettings();
              }));
          }),

          render(t('settings.apiKey.name'), t('settings.apiKey.desc'), (setting) => {
            setting.addText((text) => {
              text
                .setPlaceholder(t('settings.apiKey.placeholder'))
                .setValue(s.apiKey)
                .onChange(async (value) => {
                  s.apiKey = value.trim();
                  await this.plugin.saveSettings();
                });
              text.inputEl.type = 'password';
              text.inputEl.autocomplete = 'off';
            });
          }),

          render(t('settings.provider.name'), t('settings.provider.desc'), (setting) => {
            setting.addDropdown((dd) => {
              for (const p of PROVIDER_OPTIONS) dd.addOption(p.id, p.label);
              dd.setValue(s.provider).onChange(async (value) => {
                s.provider = value as DshSettings['provider'];
                await this.plugin.saveSettings();
              });
            });
          }),

          render(t('settings.workdir.name'), t('settings.workdir.desc'), (setting) => {
            setting.addText((text) => text
              .setPlaceholder(t('settings.workdir.placeholder'))
              .setValue(s.workdir)
              .onChange(async (value) => {
                s.workdir = value;
                await this.plugin.saveSettings();
              }));
          }),

          render(t('settings.timeout.name'), t('settings.timeout.desc'), (setting) => {
            setting.addSlider((slider) => slider
              .setLimits(30, 1800, 30)
              .setValue(s.timeoutSec)
              .onChange(async (value) => {
                s.timeoutSec = value;
                await this.plugin.saveSettings();
              }));
          }),

          render(t('settings.memory.name'), t('settings.memory.desc'), (setting) => {
            setting.addToggle((toggle) => toggle
              .setValue(s.memoryEnabled)
              .onChange(async (value) => {
                s.memoryEnabled = value;
                await this.plugin.saveSettings();
              }));
          }),

          render(t('settings.toolMode.name'), t('settings.toolMode.desc'), (setting) => {
            setting.addDropdown((dd) => {
              dd.addOption('', '默认 (native)');
              dd.addOption('native', 'Native');
              dd.addOption('code', 'Code');
              dd.addOption('both', 'Both');
              dd.setValue(s.toolExecutionMode).onChange(async (value) => {
                s.toolExecutionMode = value;
                await this.plugin.saveSettings();
              });
            });
          }),

          render(t('settings.model.name'), t('settings.model.desc'), (setting) => {
            setting.addDropdown((dd) => {
              for (const m of MODEL_OPTIONS) dd.addOption(m.id, m.label);
              dd.setValue(s.model).onChange(async (value) => {
                s.model = value;
                await this.plugin.saveSettings();
              });
            });
          }),

          render(t('settings.reasoning.name'), t('settings.reasoning.desc'), (setting) => {
            setting.addDropdown((dd) => {
              for (const r of REASONING_OPTIONS) dd.addOption(r.id, r.label);
              dd.setValue(s.reasoningEffort).onChange(async (value) => {
                s.reasoningEffort = value;
                await this.plugin.saveSettings();
              });
            });
          }),

          render(t('settings.permission.name'), t('settings.permission.desc'), (setting) => {
            setting.addDropdown((dd) => {
              for (const p of PERMISSION_OPTIONS) dd.addOption(p.id, p.label);
              dd.setValue(s.permissionMode).onChange(async (value) => {
                await this.plugin.setPermissionMode(value);
                dd.setValue(s.permissionMode);
              });
            });
          }),

          render(t('settings.showThinking.name'), t('settings.showThinking.desc'), (setting) => {
            setting.addToggle((toggle) => toggle
              .setValue(s.showThinking)
              .onChange(async (value) => {
                s.showThinking = value;
                await this.plugin.saveSettings();
              }));
          }),

          render(t('settings.showTools.name'), t('settings.showTools.desc'), (setting) => {
            setting.addToggle((toggle) => toggle
              .setValue(s.showTools)
              .onChange(async (value) => {
                s.showTools = value;
                await this.plugin.saveSettings();
              }));
          }),

          render(t('settings.historyLimit.name'), t('settings.historyLimit.desc'), (setting) => {
            setting.addSlider((slider) => slider
              .setLimits(10, 200, 10)
              .setValue(s.historyLimit)
              .onChange(async (value) => {
                s.historyLimit = value;
                await this.plugin.saveSettings();
                this.plugin.history?.setLimit(value);
              }));
          }),

          render(t('settings.obsidianSkill.name'), t('settings.obsidianSkill.desc'), (setting) => {
            setting.addToggle((toggle) => toggle
              .setValue(s.obsidianSkill)
              .onChange(async (value) => {
                s.obsidianSkill = value;
                await this.plugin.saveSettings();
              }));
          }),

          render(t('settings.extraSkillDirs.name'), t('settings.extraSkillDirs.desc'), (setting) => {
            setting.addText((text) => text
              .setPlaceholder(t('settings.extraSkillDirs.placeholder'))
              .setValue(s.extraSkillDirs)
              .onChange(async (value) => {
                s.extraSkillDirs = value;
                await this.plugin.saveSettings();
              }));
          }),

          render(t('settings.persona.name'), t('settings.persona.desc'), (setting) => {
            setting.addTextArea((text) => {
              text
                .setPlaceholder(t('settings.persona.placeholder'))
                .setValue(s.customPersona)
                .onChange(async (value) => {
                  s.customPersona = value;
                  await this.plugin.saveSettings();
                  this.plugin.invalidateVaultPatch();
                });
              text.inputEl.rows = 3;
            });
          }),

          render(t('settings.check.title'), t('settings.check.help'), (setting) => {
            setting.addButton((button) => button
              .setButtonText(t('settings.check.run'))
              .onClick(async () => {
                const runner = new DshRunner(this.plugin.settings, this.plugin.app.vault.configDir);
                const diag = await runner.diagnose();
                const line = setting.settingEl.createEl('p', {
                  cls: diag.found ? 'dsh-check-ok' : 'dsh-check-fail',
                });
                if (!diag.found) {
                  line.setText(t('settings.check.missing'));
                } else {
                  line.setText(t('settings.check.ok', { path: diag.bin }));
                  if (diag.version) line.createEl('br');
                  line.createSpan({ text: diag.version ?? diag.error ?? '' });
                }
                if (diag.nodeBin) {
                  const nodeLine = setting.settingEl.createEl('p', { cls: 'dsh-check-ok' });
                  nodeLine.setText(`✓ Node.js: ${diag.nodeBin}`);
                } else {
                  const nodeLine = setting.settingEl.createEl('p', { cls: 'dsh-check-fail' });
                  nodeLine.setText('✗ 未找到 Node.js,请在设置中填写 node 路径');
                }
              }));
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
