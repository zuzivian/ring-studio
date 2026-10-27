// Small declarative control panel: each control binds to a state path, can
// hide itself or change its options based on the rest of the state, and calls
// onChange(path, value) when the user edits it.

let uid = 0;
const nextId = (p) => `${p.replace(/\W+/g, '-')}-${++uid}`;

export function getPath(obj, path) {
  return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}
export function setPath(obj, path, value) {
  const keys = path.split('.');
  let o = obj;
  for (let i = 0; i < keys.length - 1; i++) o = o[keys[i]];
  o[keys[keys.length - 1]] = value;
}

function el(tag, attrs = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k === 'text') e.textContent = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children) if (c != null) e.append(c);
  return e;
}
export { el };

const resolve = (v, state) => (typeof v === 'function' ? v(state) : v);

export class Panel {
  constructor(root, schema, getState, onChange) {
    this.root = root;
    this.schema = schema;
    this.getState = getState;
    this.onChange = onChange;
    this.controls = [];
    this.tabs = [];
    this.build();
  }

  build() {
    const nav = el('div', { class: 'tabs', role: 'tablist', 'aria-label': 'Option groups' });
    const bodies = el('div', { class: 'tab-bodies' });
    this.schema.forEach((tab, i) => {
      const btn = el('button', { class: 'tab', role: 'tab', id: `tab-${tab.id}`, 'aria-controls': `panel-${tab.id}`, 'aria-selected': i === 0 ? 'true' : 'false', tabindex: i === 0 ? '0' : '-1', type: 'button', text: tab.label });
      const body = el('div', { class: 'tab-body', role: 'tabpanel', id: `panel-${tab.id}`, 'aria-labelledby': `tab-${tab.id}` });
      if (i !== 0) body.hidden = true;
      btn.addEventListener('click', () => this.select(tab.id));
      btn.addEventListener('keydown', (e) => {
        const n = this.schema.length;
        let j;
        if (e.key === 'ArrowRight') j = (i + 1) % n;
        else if (e.key === 'ArrowLeft') j = (i - 1 + n) % n;
        else if (e.key === 'Home') j = 0;
        else if (e.key === 'End') j = n - 1;
        else return;
        e.preventDefault();
        this.select(this.schema[j].id);
        this.tabs[j].btn.focus();
      });
      for (const group of tab.groups) body.append(this.buildGroup(group));
      nav.append(btn);
      bodies.append(body);
      this.tabs.push({ id: tab.id, btn, body });
    });
    this.root.append(nav, bodies);
    this.refresh();
  }

  select(id) {
    for (const t of this.tabs) {
      const on = t.id === id;
      t.btn.setAttribute('aria-selected', on ? 'true' : 'false');
      t.btn.tabIndex = on ? 0 : -1;
      t.body.hidden = !on;
    }
    this.active = id;
    try { localStorage.setItem('ers.tab', id); } catch (e) { /* storage unavailable */ }
  }

  buildGroup(group) {
    const box = el('section', { class: 'group' });
    if (group.title) box.append(el('h3', { class: 'group-title', text: group.title }));
    if (group.hint) box.append(el('p', { class: 'group-hint', text: group.hint }));
    // advanced groups and controls hide in simple mode (state.ui.simple)
    const groupWhen = group.adv ? (s) => !(s.ui && s.ui.simple) && (!group.when || group.when(s)) : group.when;
    for (const c of group.controls) box.append(this.buildControl(c, groupWhen));
    this.controls.push({ when: groupWhen, node: box, update: () => {} });
    return box;
  }

  buildControl(c, groupWhen) {
    let when = groupWhen && c.when ? (s) => groupWhen(s) && c.when(s) : groupWhen || c.when;
    if (c.adv) { const w = when; when = (s) => !(s.ui && s.ui.simple) && (!w || w(s)); }
    const maker = MAKERS[c.type];
    const ctl = maker(c, this);
    const wrap = el('div', { class: `field field-${c.type}` });
    if (c.label && c.type !== 'toggle') {
      const labelable = c.type === 'slider' || c.type === 'select';
      const lab = el('div', { class: 'field-label' }, el(labelable ? 'label' : 'span', { class: 'field-name', for: labelable ? ctl.id : null, id: ctl.id + '-label', text: c.label }));
      if (ctl.readout) lab.append(ctl.readout);
      wrap.append(lab);
    }
    wrap.append(ctl.node);
    if (c.note) {
      const n = el('p', { class: 'field-note' });
      wrap.append(n);
      ctl.noteNode = n;
    }
    this.controls.push({ when, node: wrap, update: (s) => { ctl.update(s); if (ctl.noteNode) ctl.noteNode.textContent = resolve(c.note, s) || ''; } });
    return wrap;
  }

  refresh() {
    const s = this.getState();
    for (const c of this.controls) {
      const show = c.when ? !!c.when(s) : true;
      c.node.hidden = !show;
      if (show) c.update(s);
    }
  }

  emit(path, value) {
    this.onChange(path, value);
    this.refresh();
  }
}

// Radio groups (segmented, shapes, scale, swatches): one tab stop per group, arrow
// keys move and select, Home/End jump to the ends.
function radioKeys(node) {
  node.addEventListener('keydown', (e) => {
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
    if (!step && e.key !== 'Home' && e.key !== 'End') return;
    const radios = [...node.querySelectorAll('[role="radio"]')];
    const i = radios.indexOf(document.activeElement);
    if (i < 0) return;
    e.preventDefault();
    const j = e.key === 'Home' ? 0 : e.key === 'End' ? radios.length - 1 : (i + step + radios.length) % radios.length;
    radios[j].focus();
    radios[j].click();
  });
}
function rovingTab(node) {
  const radios = [...node.querySelectorAll('[role="radio"]')];
  const on = radios.find((r) => r.getAttribute('aria-checked') === 'true') || radios[0];
  for (const r of radios) r.tabIndex = r === on ? 0 : -1;
}

// ---------------------------------------------------------------------------

const MAKERS = {
  segmented(c, panel) {
    const id = nextId(c.path);
    const node = el('div', { class: 'segmented', role: 'radiogroup', id, 'aria-labelledby': id + '-label' });
    radioKeys(node);
    let last = '';
    return {
      id, node,
      update(s) {
        const opts = resolve(c.options, s);
        const key = JSON.stringify(opts.map((o) => o[0]));
        const val = getPath(s, c.path);
        if (key !== last) {
          node.replaceChildren();
          for (const [v, label, title] of opts) {
            const b = el('button', { type: 'button', role: 'radio', class: 'seg', 'data-v': String(v), title: title || null, text: label });
            b.addEventListener('click', () => panel.emit(c.path, v));
            node.append(b);
          }
          last = key;
        }
        for (const b of node.children) b.setAttribute('aria-checked', String(b.dataset.v === String(val)));
        rovingTab(node);
      },
    };
  },

  select(c, panel) {
    const id = nextId(c.path);
    const node = el('select', { id });
    let last = '';
    node.addEventListener('change', () => {
      const opts = resolve(c.options, panel.getState());
      const hit = opts.find((o) => String(o[0]) === node.value);
      panel.emit(c.path, hit ? hit[0] : node.value);
    });
    return {
      id, node,
      update(s) {
        const opts = resolve(c.options, s);
        const key = JSON.stringify(opts);
        if (key !== last) {
          node.replaceChildren();
          let group = null;
          for (const o of opts) {
            if (o[0] === '__group') { group = el('optgroup', { label: o[1] }); node.append(group); continue; }
            (group || node).append(el('option', { value: String(o[0]), text: o[1] }));
          }
          last = key;
        }
        node.value = String(getPath(s, c.path));
      },
    };
  },

  slider(c, panel) {
    const id = nextId(c.path);
    const node = el('input', { type: 'range', id, min: c.min, max: c.max, step: c.step });
    const readout = el('output', { class: 'readout', for: id });
    const toVal = (x) => (c.map ? c.map.from(x) : x);
    const toPos = (v) => (c.map ? c.map.to(v) : v);
    node.addEventListener('input', () => panel.emit(c.path, Math.round(toVal(Number(node.value)) * 1e4) / 1e4));
    return {
      id, node, readout,
      update(s) {
        const v = getPath(s, c.path);
        if (document.activeElement !== node) node.value = String(toPos(v));
        readout.textContent = c.format ? c.format(v, s) : String(v);
        const min = resolve(c.min, s), max = resolve(c.max, s);
        node.min = String(min); node.max = String(max);
        const pct = ((toPos(v) - min) / (max - min)) * 100;
        node.style.setProperty('--fill', `${Math.max(0, Math.min(100, pct))}%`);
      },
    };
  },

  toggle(c, panel) {
    const id = nextId(c.path);
    const input = el('input', { type: 'checkbox', id, role: 'switch' });
    input.addEventListener('change', () => panel.emit(c.path, input.checked));
    const node = el('label', { class: 'toggle', for: id }, input, el('span', { class: 'toggle-track', 'aria-hidden': 'true' }), el('span', { class: 'toggle-text', text: c.label }));
    return { id, node, update(s) { input.checked = !!getPath(s, c.path); } };
  },

  // shape picker: grid of outline icons
  shapes(c, panel) {
    const id = nextId(c.path);
    const node = el('div', { class: 'shape-grid', role: 'radiogroup', id, 'aria-labelledby': id + '-label' });
    radioKeys(node);
    let last = '';
    return {
      id, node,
      update(s) {
        const opts = resolve(c.options, s);
        const key = opts.map((o) => o[0]).join();
        if (key !== last) {
          node.replaceChildren();
          for (const [v, label, path] of opts) {
            const svg = `<svg viewBox="0 0 40 40" aria-hidden="true"><path d="${path}"/></svg>`;
            const b = el('button', { type: 'button', role: 'radio', class: 'shape', 'data-v': v, title: label });
            b.innerHTML = svg;
            b.append(el('span', { text: label }));
            b.addEventListener('click', () => panel.emit(c.path, v));
            node.append(b);
          }
          last = key;
        }
        const val = getPath(s, c.path);
        for (const b of node.children) b.setAttribute('aria-checked', String(b.dataset.v === val));
        rovingTab(node);
      },
    };
  },

  // graded scale (diamond colour D–Z, clarity FL–I3): a row of cells with band labels.
  // The readout names the chosen grade and its band, so it stays legible when the
  // cells are small or a finger covers them.
  scale(c, panel) {
    const id = nextId(c.path);
    const node = el('div', { class: `scale${c.options.length > 12 ? ' dense' : ''}`, id, role: 'radiogroup', 'aria-labelledby': id + '-label' });
    const cells = el('div', { class: 'scale-cells' });
    const bands = el('div', { class: 'scale-bands', 'aria-hidden': 'true' });
    const readout = el('output', { class: 'readout' });
    node.append(cells, bands);
    radioKeys(node);
    for (const [v, label, swatch] of c.options) {
      const b = el('button', { type: 'button', role: 'radio', class: 'scale-cell', 'data-v': v, title: label, 'aria-label': label, text: v });
      if (swatch) b.style.setProperty('--swatch', swatch);
      b.addEventListener('click', () => panel.emit(c.path, v));
      cells.append(b);
    }
    for (const [label, span] of c.bands || []) {
      const d = el('span', { text: label });
      d.style.flex = String(span);
      bands.append(d);
    }
    const bandOf = (i) => {
      let acc = 0;
      for (const [label, span] of c.bands || []) { acc += span; if (i < acc) return label; }
      return '';
    };
    return {
      id, node, readout,
      update(s) {
        const val = getPath(s, c.path);
        for (const b of cells.children) b.setAttribute('aria-checked', String(b.dataset.v === val));
        const i = c.options.findIndex((o) => o[0] === val);
        readout.textContent = i < 0 ? '' : [val, bandOf(i)].filter(Boolean).join(' · ');
        rovingTab(node);
      },
    };
  },

  swatches(c, panel) {
    const id = nextId(c.path);
    const node = el('div', { class: 'swatches', role: 'radiogroup', id, 'aria-labelledby': id + '-label' });
    const readout = el('output', { class: 'readout' });
    radioKeys(node);
    let last = '';
    return {
      id, node, readout,
      update(s) {
        const opts = resolve(c.options, s);
        const key = opts.map((o) => o[0]).join();
        if (key !== last) {
          node.replaceChildren();
          for (const [v, label, color] of opts) {
            const b = el('button', { type: 'button', role: 'radio', class: 'swatch', 'data-v': v, title: label, 'aria-label': label });
            b.style.setProperty('--sw', color);
            b.addEventListener('click', () => panel.emit(c.path, v));
            node.append(b);
          }
          last = key;
        }
        const val = getPath(s, c.path);
        for (const b of node.children) b.setAttribute('aria-checked', String(b.dataset.v === val));
        const hit = opts.find((o) => o[0] === val);
        readout.textContent = hit ? hit[1] : '';
        rovingTab(node);
      },
    };
  },

  buttons(c, panel) {
    const id = nextId(c.label || 'buttons');
    const node = el('div', { class: 'button-row', id });
    const btns = [];
    for (const [label, fn, kind, disabledWhen] of c.items) {
      const b = el('button', { type: 'button', class: `btn ${kind || 'ghost'}`, text: label });
      b.addEventListener('click', () => { fn(); panel.refresh(); });
      node.append(b);
      btns.push([b, disabledWhen]);
    }
    return { id, node, update(s) { for (const [b, off] of btns) b.disabled = !!(off && off(s)); } };
  },

  info(c) {
    const id = nextId('info');
    const node = el('div', { class: 'info', id });
    return { id, node, update(s) { node.replaceChildren(...[].concat(c.render(s))); } };
  },
};

// ---------------------------------------------------------------------------
// Saved-image dialog: Escape and a click on the backdrop close it, Tab stays on the
// button, and focus goes back to where it was.
// ---------------------------------------------------------------------------

function wireDialog() {
  const dlg = document.getElementById('preview');
  if (!dlg) return;
  let opener = null;
  document.addEventListener('focusin', (e) => { if (!dlg.contains(e.target)) opener = e.target; });
  const close = () => { dlg.hidden = true; };
  dlg.addEventListener('click', (e) => { if (e.target === dlg) close(); });
  document.addEventListener('keydown', (e) => {
    if (dlg.hidden) return;
    if (e.key === 'Escape') { e.preventDefault(); close(); }
    else if (e.key === 'Tab') { e.preventDefault(); dlg.querySelector('button').focus(); }
  });
  new MutationObserver(() => {
    if (dlg.hidden && opener && document.contains(opener) && !opener.disabled) opener.focus();
  }).observe(dlg, { attributes: true, attributeFilter: ['hidden'] });
}
wireDialog();
