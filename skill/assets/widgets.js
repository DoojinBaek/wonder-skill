// Wonder widgets: ready-made live elements for explainer decks. new-deck.mjs copies this file into
// the deck's assets/ and loads it as a module; a slide then needs only the tag and its data.
// Every widget reads the theme's colors, uses 28px+ text, fills the width of its parent, and
// explains in its first state (decks are printed as they first appear).
//
// Colors in data are names: accent (blue), alt (orange), gray, purple, ink.
//   <line-chart>     curves from data, static
//   <bar-chart>      horizontal bars, static
//   <dot-rows>       points on a shared number line, one row per case, optional slider
//   <slider-plot>    a function of x with one parameter on a slider
//   <step-through>   a pipeline of boxes; buttons walk through the steps
//   <predict-reveal> a question with choices; the answer shows after a choice

const css = getComputedStyle(document.documentElement);
const V = n => css.getPropertyValue(n).trim();
const FONT = '"IBM Plex Sans KR", -apple-system, sans-serif';
const MONO = '"IBM Plex Mono", ui-monospace, monospace';
const color = c => ({ accent: V('--accent') || '#2f5fb3', alt: V('--alt') || '#c05f0c', gray: '#9aa1ab', purple: '#7c4dbd', ink: V('--ink') || '#1d2026' }[c] || c || V('--accent'));
const json = (el, name, fallback) => { try { return JSON.parse(el.dataset[name]); } catch { return fallback; } };
const nums = s => (s || '').split(',').map(Number);
const fmt = v => String(Math.round(v * 100) / 100);
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
const BASE = `:host { display: block; font: 30px/1.4 ${FONT}; color: ${V('--ink')}; }
  button { font: inherit; font-size: 28px; padding: 6px 22px; border: 3px solid ${V('--accent')}; border-radius: 14px;
    background: #fff; color: ${V('--accent')}; font-weight: 600; cursor: pointer; }
  button[disabled] { opacity: .35; cursor: default; }
  input[type=range] { width: 640px; accent-color: ${V('--accent')}; }
  .mono { font-family: ${MONO}; }
  .read { font-size: 28px; color: ${V('--muted')}; }`;
const once = el => { if (el.shadowRoot) return null; return el.attachShadow({ mode: 'open' }); };

// Axes for a plot: maps data to an SVG box and draws ticks.
function axes({ W, H, x, y, xlabel = '', ylabel = '', xlog = false }) {
  const L = 96, R = 24, T = 20, B = 70;
  const tx = v => xlog ? Math.log10(v) : v;
  const X = v => L + (tx(v) - tx(x[0])) / (tx(x[1]) - tx(x[0])) * (W - L - R);
  const Y = v => H - B - (v - y[0]) / (y[1] - y[0]) * (H - T - B);
  const ticks = (a, b, log) => {
    if (log) { const out = []; for (let e = Math.ceil(Math.log10(a)); e <= Math.floor(Math.log10(b)); e++) out.push(10 ** e); return out; }
    const span = b - a, step = 10 ** Math.floor(Math.log10(span / 4)), m = span / step > 8 ? step * 2 : span / step > 4 ? step : step / 2;
    const out = []; for (let v = Math.ceil(a / m) * m; v <= b + 1e-9; v += m) out.push(Math.round(v * 1e6) / 1e6); return out;
  };
  let g = `<line x1="${L}" x2="${W - R}" y1="${H - B}" y2="${H - B}" stroke="#c9ced6" stroke-width="2"/>`;
  for (const v of ticks(x[0], x[1], xlog)) g += `<text x="${X(v)}" y="${H - B + 34}" text-anchor="middle" font-size="24" fill="#8a919b">${fmt(v)}</text>`;
  for (const v of ticks(y[0], y[1], false)) g += `<line x1="${L}" x2="${W - R}" y1="${Y(v)}" y2="${Y(v)}" stroke="#eef0f3" stroke-width="2"/><text x="${L - 14}" y="${Y(v) + 8}" text-anchor="end" font-size="24" fill="#8a919b">${fmt(v)}</text>`;
  if (xlabel) g += `<text x="${(L + W - R) / 2}" y="${H - 8}" text-anchor="middle" font-size="26" fill="#6b7280">${esc(xlabel)}</text>`;
  if (ylabel) g += `<text x="${L}" y="${T - 2}" font-size="26" fill="#6b7280" dominant-baseline="hanging" dx="8">${esc(ylabel)}</text>`;
  return { X, Y, g, L, R, T, B };
}
const svg = (W, H, inner) => `<svg viewBox="0 0 ${W} ${H}" width="100%" style="display:block" font-family='${FONT}'>${inner}</svg>`;

// <line-chart data-series='[{"name":"InfiLoop","color":"accent","x":[…],"y":[…]},{"name":"TRM","color":"alt","dash":true,…}]'
//   data-x="0,1872" data-y="0,100" data-xlabel="층 수" data-ylabel="정확도 (%)" [data-xlog] [data-height="560"]
//   [data-marks='[{"x":468,"y":62.2,"label":"468층 62.2%","color":"alt"}]']>
customElements.define('line-chart', class extends HTMLElement {
  connectedCallback() {
    const root = once(this); if (!root) return;
    const series = json(this, 'series', []), marks = json(this, 'marks', []);
    const W = 1100, H = +(this.dataset.height || 520);
    const allX = series.flatMap(s => s.x), allY = series.flatMap(s => s.y);
    const x = this.dataset.x ? nums(this.dataset.x) : [Math.min(...allX), Math.max(...allX)];
    const y = this.dataset.y ? nums(this.dataset.y) : [Math.min(0, ...allY), Math.max(...allY)];
    const a = axes({ W, H, x, y, xlabel: this.dataset.xlabel, ylabel: this.dataset.ylabel, xlog: 'xlog' in this.dataset });
    let g = a.g;
    for (const s of series) {
      const d = s.x.map((v, i) => `${i ? 'L' : 'M'}${a.X(v).toFixed(1)},${a.Y(s.y[i]).toFixed(1)}`).join('');
      g += `<path d="${d}" fill="none" stroke="${color(s.color)}" stroke-width="5" ${s.dash ? 'stroke-dasharray="14 10"' : ''} stroke-linejoin="round"/>`;
      const i = s.x.length - 1;
      g += `<text x="${a.X(s.x[i]) - 6}" y="${a.Y(s.y[i]) - 14}" text-anchor="end" font-size="26" font-weight="600" fill="${color(s.color)}">${esc(s.name)}</text>`;
    }
    for (const m of marks) g += `<circle cx="${a.X(m.x)}" cy="${a.Y(m.y)}" r="9" fill="#fff" stroke="${color(m.color)}" stroke-width="4"/>` +
      `<text x="${a.X(m.x) + 14}" y="${a.Y(m.y) - 14}" font-size="26" fill="${color(m.color)}" font-weight="600">${esc(m.label || '')}</text>`;
    root.innerHTML = `<style>${BASE} :host { width: 100%; max-width: ${Math.round(W * 580 / H)}px; margin: 0 auto; }</style>` + svg(W, H, g);
  }
});

// <bar-chart data-items='[{"label":"InfiLoop","value":90.9,"color":"accent"},{"label":"q = 0","value":84.1,"color":"gray"}]'
//   [data-max="100"] [data-unit="%"] [data-title="정확도, 1,872층"]>
customElements.define('bar-chart', class extends HTMLElement {
  connectedCallback() {
    const root = once(this); if (!root) return;
    const items = json(this, 'items', []), max = +(this.dataset.max || Math.max(...items.map(i => i.value)) * 1.1), unit = this.dataset.unit || '';
    root.innerHTML = `<style>${BASE}
      .title { font-size: 28px; font-weight: 600; margin-bottom: 14px; }
      .row { display: grid; grid-template-columns: 300px 1fr; gap: 24px; align-items: center; margin: 12px 0; }
      .lab { text-align: right; font-size: 28px; } .track { position: relative; height: 44px; }
      .bar { height: 100%; border-radius: 6px; } .val { position: absolute; top: 4px; font: 600 28px ${MONO}; }</style>
      ${this.dataset.title ? `<div class="title">${esc(this.dataset.title)}</div>` : ''}
      ${items.map(i => { const w = Math.max(0.5, i.value / max * 100); return `<div class="row"><div class="lab">${esc(i.label)}</div>
        <div class="track"><div class="bar" style="width:${w}%;background:${color(i.color)}"></div>
        <span class="val" style="left:calc(${w}% + 12px)">${fmt(i.value)}${unit}</span></div></div>`; }).join('')}`;
  }
});

// <dot-rows data-range="-4,9" data-rows='[{"label":"원래 숫자","values":[2.1,3.4,…],"color":"gray"},
//   {"label":"AdaLN","expr":"v*(0.5+1.2*p)+2-2.5*p","from":0,"color":"alt"}]'
//   [data-param="t" data-min="0" data-max="1" data-step="0.01" data-value="0.8" data-readout="'γ = '+(0.5+1.2*p).toFixed(2)"]>
// A row with "expr" computes its points from row "from" (v = each value, p = the slider).
customElements.define('dot-rows', class extends HTMLElement {
  connectedCallback() {
    const root = once(this); if (!root) return;
    const rows = json(this, 'rows', []), [lo, hi] = nums(this.dataset.range || '-4,9');
    const hasP = 'param' in this.dataset;
    root.innerHTML = `<style>${BASE}
      .grid { display: grid; grid-template-columns: 260px 1fr; column-gap: 28px; align-items: center; }
      .lab { font-size: 28px; font-weight: 600; line-height: 1.3; }
      .ctl { display: flex; align-items: center; gap: 24px; margin-top: 18px; }</style>
      <div class="grid">${rows.map((r, i) => `<div class="lab" style="color:${r.color === 'gray' ? V('--ink') : color(r.color)}">${esc(r.label)}</div><div class="r" data-i="${i}"></div>`).join('')}</div>
      ${hasP ? `<div class="ctl"><span>${esc(this.dataset.param)}</span><input type="range" min="${this.dataset.min || 0}" max="${this.dataset.max || 1}" step="${this.dataset.step || 0.01}" value="${this.dataset.value || 0}"><span class="mono read"></span></div>` : ''}`;
    const fns = rows.map(r => r.expr ? new Function('v', 'p', `return (${r.expr});`) : null);
    const readout = this.dataset.readout ? new Function('p', `return (${this.dataset.readout});`) : null;
    const W = 1000, H = 92, X = v => 24 + (v - lo) / (hi - lo) * (W - 48);
    const ticks = []; for (let v = Math.ceil(lo); v <= hi; v++) if ((v - Math.ceil(lo)) % (hi - lo > 12 ? 2 : 1) === 0) ticks.push(v);
    const draw = () => {
      const p = hasP ? +root.querySelector('input').value : 0;
      rows.forEach((r, i) => {
        const vals = r.expr ? rows[r.from || 0].values.map(v => fns[i](v, p)) : r.values;
        const t = ticks.map(v => `<line x1="${X(v)}" x2="${X(v)}" y1="38" y2="54" stroke="#c9ced6" stroke-width="2"/><text x="${X(v)}" y="86" text-anchor="middle" font-size="22" fill="#9aa1ab">${v}</text>`).join('');
        const dots = vals.map(v => `<circle cx="${X(v).toFixed(1)}" cy="46" r="12" fill="${color(r.color)}" fill-opacity=".85"/>`).join('');
        root.querySelector(`.r[data-i="${i}"]`).innerHTML = svg(W, H, `<line x1="24" x2="${W - 24}" y1="46" y2="46" stroke="#c9ced6" stroke-width="3"/>${t}${dots}`);
      });
      if (hasP) root.querySelector('.read').textContent = `${this.dataset.param} = ${fmt(p)}${readout ? ' · ' + readout(p) : ''}`;
    };
    if (hasP) root.querySelector('input').oninput = draw;
    draw();
  }
});

// <slider-plot data-fn="Math.exp(-x*x/(2*s*s))" data-param="s" data-min="0.2" data-max="2" data-value="1"
//   data-x="-3,3" data-y="0,1.1" [data-fn2="…same parameter, drawn gray for reference…"]
//   [data-xlabel="z"] [data-ylabel="밀도"] [data-readout="'최댓값 = ' + (1).toFixed(2)"]>
customElements.define('slider-plot', class extends HTMLElement {
  connectedCallback() {
    const root = once(this); if (!root) return;
    const d = this.dataset, P = d.param || 'p';
    const f = new Function('x', P, `return (${d.fn});`), f2 = d.fn2 ? new Function('x', P, `return (${d.fn2});`) : null;
    const readout = d.readout ? new Function(P, `return (${d.readout});`) : null;
    const W = 1100, H = +(d.height || 460), x = nums(d.x || '0,1'), y = nums(d.y || '0,1');
    root.innerHTML = `<style>${BASE} :host { width: 100%; max-width: ${Math.round(W * 500 / H)}px; margin: 0 auto; } input[type=range] { width: 520px; } .ctl { display: flex; align-items: center; gap: 24px; margin-top: 12px; }</style>
      <div class="plot"></div><div class="ctl"><span>${esc(P)}</span><input type="range" min="${d.min || 0}" max="${d.max || 1}" step="${d.step || (+(d.max || 1) - +(d.min || 0)) / 200}" value="${d.value || d.min || 0}"><span class="mono read"></span></div>`;
    const a = axes({ W, H, x, y, xlabel: d.xlabel, ylabel: d.ylabel });
    const path = (fn, p) => { let s = ''; for (let i = 0; i <= 240; i++) { const xv = x[0] + (x[1] - x[0]) * i / 240, yv = Math.max(y[0] - 1e3, Math.min(y[1] + 1e3, fn(xv, p))); s += `${i ? 'L' : 'M'}${a.X(xv).toFixed(1)},${a.Y(yv).toFixed(1)}`; } return s; };
    const draw = () => {
      const p = +root.querySelector('input').value;
      root.querySelector('.plot').innerHTML = svg(W, H, `<clipPath id="c"><rect x="${a.L}" y="${a.T}" width="${W - a.L - a.R}" height="${H - a.T - a.B}"/></clipPath>${a.g}
        <g clip-path="url(#c)">${f2 ? `<path d="${path(f2, p)}" fill="none" stroke="#9aa1ab" stroke-width="4" stroke-dasharray="12 9"/>` : ''}
        <path d="${path(f, p)}" fill="none" stroke="${V('--accent')}" stroke-width="5"/></g>`);
      root.querySelector('.read').textContent = `${P} = ${fmt(p)}${readout ? ' · ' + readout(p) : ''}`;
    };
    root.querySelector('input').oninput = draw;
    draw();
  }
});

// <step-through [data-loop="4,2"]>
//   <li data-box="인코더">관측을 벡터로 바꾼다.</li><li data-box="예측기">다음 벡터를 예측한다.</li> …
// </step-through>
// Boxes in a row; the current step is highlighted and its sentence shown below. data-loop="from,to"
// (1-based) draws a return arrow from box "from" back to box "to".
customElements.define('step-through', class extends HTMLElement {
  connectedCallback() {
    const root = once(this); if (!root) return;
    const steps = [...this.querySelectorAll('li')].map(li => ({ box: li.dataset.box || '', text: li.innerHTML }));
    const n = steps.length, W = 1500, bw = Math.min(250, (W - 40 * (n - 1)) / n), gap = n > 1 ? (W - bw * n) / (n - 1) : 0, by = 40, bh = 120;
    const loop = this.dataset.loop ? nums(this.dataset.loop) : null;
    root.innerHTML = `<style>${BASE}
      .say { min-height: 100px; margin-top: 18px; font-size: 32px; } .say b { color: ${V('--accent')}; }
      .ctl { display: flex; gap: 16px; align-items: center; margin-top: 10px; }</style>
      <div class="pic"></div><div class="say"></div>
      <div class="ctl"><button class="prev">◀ 이전</button><button class="next">다음 ▶</button><span class="read mono"></span></div>`;
    let k = 0;
    const draw = () => {
      let g = `<defs><marker id="ah" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0L10,5L0,10z" fill="#8a919b"/></marker></defs>`;
      steps.forEach((s, i) => {
        const x = i * (bw + gap), on = i === k;
        g += `<rect x="${x}" y="${by}" width="${bw}" height="${bh}" rx="18" fill="${on ? V('--accent') : '#fff'}" stroke="${on ? V('--accent') : '#c9ced6'}" stroke-width="3"/>` +
          `<text x="${x + bw / 2}" y="${by + bh / 2 + 10}" text-anchor="middle" font-size="30" font-weight="600" fill="${on ? '#fff' : V('--ink')}">${esc(s.box)}</text>`;
        if (i < n - 1) g += `<line x1="${x + bw + 8}" y1="${by + bh / 2}" x2="${x + bw + gap - 10}" y2="${by + bh / 2}" stroke="#8a919b" stroke-width="4" marker-end="url(#ah)"/>`;
      });
      if (loop) { const xa = (loop[0] - 1) * (bw + gap) + bw / 2, xb = (loop[1] - 1) * (bw + gap) + bw / 2, yb = by + bh;
        g += `<path d="M${xa},${yb + 6} V${yb + 50} H${xb} V${yb + 14}" fill="none" stroke="#8a919b" stroke-width="4" marker-end="url(#ah)"/>`; }
      root.querySelector('.pic').innerHTML = svg(W, by + bh + (loop ? 70 : 20), g);
      root.querySelector('.say').innerHTML = `<b>${k + 1}. ${esc(steps[k].box)}</b> ${steps[k].text}`;
      root.querySelector('.read').textContent = `${k + 1} / ${n}`;
      root.querySelector('.prev').disabled = k === 0; root.querySelector('.next').disabled = k === n - 1;
    };
    root.querySelector('.prev').onclick = () => { k = Math.max(0, k - 1); draw(); };
    root.querySelector('.next').onclick = () => { k = Math.min(n - 1, k + 1); draw(); };
    draw();
  }
});

// <predict-reveal data-question="반복을 네 배로 늘리면 정확도는?" data-options="오른다|그대로다|떨어진다" data-answer="3">
//   떨어진다. 468층 62.2% → 1,872층 58.1%.
// </predict-reveal>
// The element's own text is the answer, shown after any choice (data-answer is 1-based).
customElements.define('predict-reveal', class extends HTMLElement {
  connectedCallback() {
    const root = once(this); if (!root) return;
    const opts = (this.dataset.options || '').split('|'), ans = +(this.dataset.answer || 0) - 1;
    root.innerHTML = `<style>${BASE}
      .q { font-size: 32px; font-weight: 600; margin-bottom: 16px; } .opts { display: flex; gap: 16px; flex-wrap: wrap; }
      button.right { background: ${V('--accent')}; color: #fff; } button.wrong { border-color: #c9ced6; color: #9aa1ab; }
      .a { margin-top: 18px; font-size: 30px; } .a[hidden] { display: none; }</style>
      <div class="q">${esc(this.dataset.question || '')}</div>
      <div class="opts">${opts.map((o, i) => `<button data-i="${i}">${esc(o)}</button>`).join('')}</div>
      <div class="a" hidden><slot></slot></div>`;
    root.querySelectorAll('button').forEach(b => b.onclick = () => {
      root.querySelectorAll('button').forEach(x => x.classList.add(+x.dataset.i === ans ? 'right' : 'wrong'));
      root.querySelector('.a').hidden = false;
    });
  }
});
