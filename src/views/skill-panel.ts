import { t } from '../i18n/index';
import { FloatingPanel } from './floating-panel';
import type { ChatView } from './chat-view';

/**
 * Discovered-skills popup, anchored under the skill toolbar icon.
 *
 * Extracted from chat-view.ts (review C-1). It deliberately uses the view's
 * cached scan (view.scanSkills) rather than scanning on its own, so opening
 * the panel stays free of a filesystem walk (P2-I).
 */
export class SkillPanel extends FloatingPanel {
  constructor(private readonly view: ChatView, anchorEl: HTMLElement) {
    super(anchorEl, 'dsh-skill-panel', (panel) => this.renderList(panel));
  }

  private renderList(panel: HTMLElement): void {
    const skills = this.view.scanSkills();
    if (skills.length === 0) {
      panel.createDiv({ cls: 'dsh-history-empty', text: t('chat.skillEmpty') });
      return;
    }
    for (const s of skills) {
      const item = panel.createDiv({ cls: 'dsh-skill-item' });
      const row1 = item.createDiv({ cls: 'dsh-skill-row1' });
      row1.createSpan({ cls: 'dsh-skill-name', text: s.name });
      row1.createSpan({ cls: 'dsh-skill-badge', text: this.view.skillSourceLabel(s.source) });
      item.createDiv({ cls: 'dsh-skill-desc', text: s.description });
      item.onclick = () => {
        this.close();
        this.view.insertTextAtCursor(`/${s.name} `);
        this.view.scrollToBottom();
      };
    }
  }
}
