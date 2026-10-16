// Small form helpers for the side panels.
import { el, copyText } from '../util.js';

export function field(label, input, hint) {
  return el('label', { class: 'field' }, label, input, hint ? el('span', { class: 'small muted' }, hint) : null);
}

export function text(value, onchange, attrs = {}) {
  const i = el('input', { type: 'text', value: value ?? '', ...attrs });
  i.addEventListener(attrs.live ? 'input' : 'change', () => onchange(i.value));
  return i;
}

export function num(value, onchange, attrs = {}) {
  const i = el('input', { type: 'number', value: value ?? 0, ...attrs });
  i.addEventListener('change', () => { const v = Number(i.value); if (!Number.isNaN(v)) onchange(v); });
  return i;
}

// Percent input for normalised (0..1) values.
export function pct(value, onchange, attrs = {}) {
  const i = el('input', { type: 'number', step: 0.5, value: Math.round(value * 1000) / 10, ...attrs });
  i.addEventListener('change', () => { const v = Number(i.value); if (!Number.isNaN(v)) onchange(v / 100); });
  return i;
}

export function select(options, value, onchange, attrs = {}) {
  const s = el('select', attrs, Object.entries(options).map(([k, v]) => el('option', { value: k, selected: String(value) === String(k) }, v)));
  s.addEventListener('change', () => onchange(s.value));
  return s;
}

export function color(value, onchange) {
  // Accept #rrggbbaa: the picker handles the rgb part; alpha is kept.
  const base = (value || '#000000').slice(0, 7);
  const alpha = (value || '').length === 9 ? value.slice(7) : '';
  const i = el('input', { type: 'color', value: base });
  i.addEventListener('input', () => onchange(i.value + alpha));
  return i;
}

export function check(label, value, onchange, title) {
  const i = el('input', { type: 'checkbox', checked: !!value });
  i.addEventListener('change', () => onchange(i.checked));
  return el('label', { class: 'check', title }, i, label);
}

export function linkBox(value, label = 'Copy') {
  const i = el('input', { type: 'text', readOnly: true, value });
  i.addEventListener('focus', () => i.select());
  const b = el('button', { class: 'btn sm', onclick: async () => { b.textContent = (await copyText(value)) ? 'Copied' : 'Copy failed'; setTimeout(() => (b.textContent = label), 1500); } }, label);
  return el('div', { class: 'linkbox' }, i, b);
}

export function statLine(pairs) {
  return el('div', { class: 'statline' }, pairs.filter(([, v]) => v !== undefined && v !== null && v !== '' && v !== '–')
    .map(([k, v]) => el('span', {}, el('em', {}, k), v)));
}

// Keeps a card in place while the user types in it: the build function is
// re-run only when focus is outside the card.
export class CardList {
  constructor(container, build) {
    this.container = container;
    this.build = build;
    this.cards = new Map();
    this.items = new Map();
    container.addEventListener('focusout', () => setTimeout(() => {
      for (const [id, card] of this.cards) {
        if (card.dataset.stale && !editingIn(card) && this.items.has(id)) this.refresh(this.items.get(id));
      }
    }, 0));
  }
  render(items) {
    this.items = new Map(items.map((i) => [i.id, i]));
    const nodes = items.map((it) => {
      const existing = this.cards.get(it.id);
      if (existing && editingIn(existing)) return existing;
      const node = this.build(it);
      this.cards.set(it.id, node);
      return node;
    });
    for (const id of [...this.cards.keys()]) if (!items.some((i) => i.id === id)) this.cards.delete(id);
    this.container.replaceChildren(...nodes);
  }
  refresh(item) {
    this.items.set(item.id, item);
    const old = this.cards.get(item.id);
    if (!old) return;
    if (editingIn(old)) {
      old.dataset.stale = '1';
      return;
    }
    const node = this.build(item);
    this.cards.set(item.id, node);
    old.replaceWith(node);
  }
}

// True while the user is typing in a field inside `node`.
export function editingIn(node) {
  const a = document.activeElement;
  return !!a && a !== document.body && node.contains(a) && a.matches('input:not([type=checkbox]):not([type=range]):not([type=color]), textarea, select');
}
