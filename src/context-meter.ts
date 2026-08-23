/**
 * Context usage meter: a small circular progress ring showing the estimated
 * prompt tokens against the model's context window.
 *
 * The ring shows no text by default; hovering it reveals the percentage and
 * token detail in a floating tip.
 *
 * Data source (Phase 1): local estimation — CJK chars ≈ 1 token each,
 * other chars ≈ 1 token / 4 chars. A Phase-2 streaming relay can replace
 * the estimate with real usage without touching this UI.
 */
import { t } from './i18n';

/** Rough token estimate for a text blob (mixed CJK / Latin). */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  let cjk = 0;
  let other = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (
      (code >= 0x4e00 && code <= 0x9fff) ||   // CJK Unified
      (code >= 0x3040 && code <= 0x30ff) ||   // Hiragana / Katakana
      (code >= 0xac00 && code <= 0xd7af)      // Hangul
    ) {
      cjk++;
    } else {
      other++;
    }
  }
  return Math.ceil(cjk) + Math.ceil(other / 4);
}

const RADIUS = 9;
const STROKE = 2.5;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

interface ThresholdColor {
  max: number; // exclusive fraction bound
  color: string;
}

const THRESHOLDS: ThresholdColor[] = [
  { max: 0.5, color: '#4caf50' },  // green
  { max: 0.8, color: '#ffb300' },  // yellow
  { max: 0.95, color: '#ff8c00' }, // orange
  { max: 1.01, color: '#f44336' }, // red
];

export class ContextMeter {
  private el: HTMLElement;
  private tip: HTMLElement;
  private progress: SVGCircleElement;
  private tokens = 0;
  private contextWindow: number;

  constructor(container: HTMLElement, contextWindow: number) {
    this.contextWindow = contextWindow;
    const size = (RADIUS + STROKE) * 2 + 4;
    this.el = container.createDiv({ cls: 'dsh-meter' });
    this.el.setAttribute('aria-label', 'Context usage');
    this.el.setAttribute('tabindex', '0');

    const svg = this.el.createSvg('svg', {
      attr: {
        width: String(size),
        height: String(size),
        viewBox: `0 0 ${size} ${size}`,
      },
    });

    // Track (background ring)
    svg.createSvg('circle', {
      attr: {
        cx: String(size / 2),
        cy: String(size / 2),
        r: String(RADIUS),
        fill: 'none',
        stroke: 'var(--background-modifier-border)',
        'stroke-width': String(STROKE),
      },
    });

    // Progress arc (starts at 12 o'clock)
    this.progress = svg.createSvg('circle', {
      attr: {
        cx: String(size / 2),
        cy: String(size / 2),
        r: String(RADIUS),
        fill: 'none',
        stroke: THRESHOLDS[0].color,
        'stroke-width': String(STROKE),
        'stroke-linecap': 'round',
        'stroke-dasharray': String(CIRCUMFERENCE),
        'stroke-dashoffset': String(CIRCUMFERENCE),
        transform: `rotate(-90 ${size / 2} ${size / 2})`,
      },
    });

    // Hover tip: only visible while the cursor is over the ring
    this.tip = this.el.createDiv({ cls: 'dsh-meter-tip hidden' });
    this.tip.createDiv({ cls: 'dsh-meter-tip-pct' });
    this.tip.createDiv({ cls: 'dsh-meter-tip-detail' });

    this.el.addEventListener('mouseenter', () => {
      this.tip.removeClass('hidden');
    });
    this.el.addEventListener('mouseleave', () => {
      this.tip.addClass('hidden');
    });
    this.el.addEventListener('focus', () => {
      this.tip.removeClass('hidden');
    });
    this.el.addEventListener('blur', () => {
      this.tip.addClass('hidden');
    });

    this.render();
  }

  /** Absolute token count. */
  getTokens(): number {
    return this.tokens;
  }

  addTokens(count: number): void {
    this.tokens += count;
    this.render();
  }

  reset(): void {
    this.tokens = 0;
    this.render();
  }

  /** Update the denominator when the model changes. */
  setContextWindow(contextWindow: number): void {
    this.contextWindow = contextWindow;
    this.render();
  }

  private render(): void {
    const fraction = Math.min(this.tokens / this.contextWindow, 1);
    const pct = fraction * 100;

    this.progress.setAttribute('stroke-dashoffset', String(CIRCUMFERENCE * (1 - fraction)));

    // Color by threshold
    const color = THRESHOLDS.find((t) => pct / 100 < t.max)?.color ?? THRESHOLDS[THRESHOLDS.length - 1].color;
    this.progress.setAttribute('stroke', color);
    this.progress.style.filter = fraction > 0.8 ? 'drop-shadow(0 0 2px ' + color + ')' : 'none';

    // Hover tip content: big percentage + token detail
    const label = pct < 10 ? pct.toFixed(1) : String(Math.round(pct));
    const pctEl = this.tip.querySelector('.dsh-meter-tip-pct') as HTMLElement;
    const detailEl = this.tip.querySelector('.dsh-meter-tip-detail') as HTMLElement;
    pctEl.textContent = label + '%';
    pctEl.style.color = color;
    detailEl.textContent = `~${this.tokens.toLocaleString()} / ${this.contextWindow.toLocaleString()} tokens ${t('chat.contextEstimated')}`;
  }
}
