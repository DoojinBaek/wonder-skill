/*!
 * deck-edit.js v2026.10.18.5 — present an HTML slide deck, press E to edit it in place, ⌘S to save.
 * https://github.com/DoojinBaek/html-deck · update a deck's copy with: deck update <folder>
 *
 * Deck format: one <main class="deck" data-size="1920x1080"> whose children are
 * <section class="slide"> elements. Everything this script adds at runtime is
 * stripped before saving, so the file on disk stays plain, readable HTML.
 */
(() => {
  'use strict';
  if (window.deckEdit) return;

  const RT = 'data-dk-runtime';            // marks elements that never get saved
  const SIDEBAR = 216, TOOLBAR = 52, THUMB_W = 160;
  const TEXT_TAGS = new Set(['H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'P', 'LI', 'TD', 'TH', 'DT', 'DD',
    'FIGCAPTION', 'BLOCKQUOTE', 'CAPTION', 'PRE', 'LABEL', 'SUMMARY']);
  const PASS_THROUGH = new Set(['TBODY', 'THEAD', 'TFOOT', 'TR']);   // never worth selecting on their own
  // Parts of a table: clicking one edits a cell, but the selection box, grip and handles belong to the whole table.
  const TABLE_PARTS = new Set(['TD', 'TH', 'TR', 'THEAD', 'TBODY', 'TFOOT', 'CAPTION']);
  const MEDIA_TAGS = new Set(['IMG', 'svg', 'SVG', 'VIDEO', 'CANVAS', 'IFRAME', 'PICTURE', 'OBJECT']);
  const KATEX = 'https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/';

  const html = document.documentElement;
  let deck, W, H, FILE, DIR_KEY, STATE_KEY;

  // ---------- state ----------
  let mode = 'present';
  let cur = 0;
  let scale = 1;
  let selected = null, editing = null;
  let sel = [];          // every selected frame, in document order (sel[0] === selected)
  const hist = [];
  let hi = -1, commitTimer = 0, thumbTimer = 0;
  let saved = '';        // deck HTML at last load/save
  let baseline = '';     // deck HTML as we last saw it on disk
  let diskText = null;   // full file text as we last saw it on disk
  let dir = null, dirOK = false, lastMod = 0, watchTimer = 0, checking = false;
  let skipUnloadPrompt = false, justReloaded = false, reloadStamp = null;

  // ---------- helpers ----------
  const slides = () => [...deck.children].filter(el => el.classList.contains('slide'));
  const curSlide = () => slides()[cur] || null;
  const $ = (sel, root) => (root || shadow).querySelector(sel);
  const isMedia = el => MEDIA_TAGS.has(el.tagName) || isLive(el);
  const ownText = el => [...el.childNodes].some(n => n.nodeType === 3 && n.textContent.trim());
  const isCell = el => !!el && (el.tagName === 'TD' || el.tagName === 'TH');
  const isList = el => !!el && (el.tagName === 'UL' || el.tagName === 'OL');
  // A text column: a box holding only paragraphs, headings and lists (e.g. the text half of a two-column slide).
  // Its blocks are edited together, so a selection can run from one paragraph into the next.
  const COLUMN_KIDS = /^(P|H[1-6]|UL|OL|BLOCKQUOTE|PRE)$/;
  function isTextColumn(el) {
    if (!el || el.nodeType !== 1 || el instanceof SVGElement || !deck || el === deck || el.classList.contains('slide')) return false;
    if (/^(TABLE|TR|FIGURE|LI|UL|OL)$/.test(el.tagName) || el.classList.contains('math') || el.classList.contains('shape')) return false;
    if (ownText(el) || el.childElementCount < 2) return false;
    return [...el.children].every(k => COLUMN_KIDS.test(k.tagName) && !k.hasAttribute(RT) && !/^(absolute|fixed)$/.test(getComputedStyle(k).position));
  }
  function outerList(li) {
    let l = isList(li) ? li : li.parentElement;
    while (l.parentElement && /^(UL|OL|LI)$/.test(l.parentElement.tagName)) l = l.parentElement;
    return l;
  }
  // The element that becomes contenteditable when text inside `block` is clicked: a whole list, a whole
  // text column, a table cell on its own, or else the block itself. It is chosen once, when editing starts.
  function hostOf(b) {
    if (!b || isCell(b) || b.classList.contains('math')) return b;
    // A shape's text (one paragraph or several, or a list) is edited as one, like a text column.
    const sh = isBoxShape(b) ? b : labelShape(b);
    if (sh && (!curSlide() || curSlide().contains(sh))) return sh;
    const cell = b.closest('td, th');
    if (cell && (!curSlide() || curSlide().contains(cell))) return cell;
    let h = b;
    const li = b.tagName === 'LI' ? b : b.parentElement && b.parentElement.closest('li');
    if (li && (!curSlide() || curSlide().contains(li))) h = outerList(li);
    else if (isList(b)) h = outerList(b);
    if (h.parentElement && isTextColumn(h.parentElement)) h = h.parentElement;
    else if (h.parentElement && h.parentElement === curSlide() && runOf(h).length > 1) h = h.parentElement;
    return h;
  }
  // Paragraphs, headings and lists that sit directly on the slide, one after another (a title slide's h1 + p + p,
  // an h2 + p + p slide), are edited as one run, so a selection can go from one into the next. The slide itself is
  // then the editing host and everything else on it is contenteditable=false; nothing about this is saved.
  const RUN_TAGS = /^(P|H[1-6]|UL|OL|BLOCKQUOTE|PRE)$/;
  function runBlock(el) {
    if (!el || el.nodeType !== 1 || !RUN_TAGS.test(el.tagName) || el.hasAttribute(RT) || el.matches('aside.notes')) return false;
    if (el.classList.contains('math') || el.classList.contains('shape')) return false;
    const cs = getComputedStyle(el);
    return cs.display !== 'none' && cs.visibility !== 'hidden' && !/^(absolute|fixed)$/.test(cs.position) && cs.float === 'none';
  }
  function runOf(b) {
    if (!runBlock(b) || !b.parentElement || !b.parentElement.classList.contains('slide')) return [b];
    const out = [b];
    for (let e = b.previousElementSibling; e && (e.hasAttribute(RT) || runBlock(e)); e = e.previousElementSibling) if (!e.hasAttribute(RT)) out.unshift(e);
    for (let e = b.nextElementSibling; e && (e.hasAttribute(RT) || runBlock(e)); e = e.nextElementSibling) if (!e.hasAttribute(RT)) out.push(e);
    return out;
  }
  const isSlide = el => !!el && el.nodeType === 1 && el.classList.contains('slide') && el.parentElement === deck;
  // What the selection box, grip, handles, chip and toolbars attach to: a table (never a cell or row),
  // a whole list (never one bullet), a whole text column.
  function frameOf(el) {
    if (!el || el.nodeType !== 1) return el;
    // The text inside a box drawn as a shape belongs to the shape: it moves and is selected with it.
    const sh = labelShape(el);
    if (sh) return sh;
    if (TABLE_PARTS.has(el.tagName)) return el.closest('table') || el;
    if (el.tagName === 'LI' || isList(el)) el = outerList(el);
    if (el.parentElement && isTextColumn(el.parentElement)) return el.parentElement;
    return el;
  }

  // A box drawn as a shape (<div class="shape" data-shape="rect|round|circle">) that `el` is inside of, if any: its
  // text is the shape's label. A deck's own div.shape without data-shape (a card, say) is ordinary layout.
  const isBoxShape = el => !!el && el.nodeType === 1 && el.tagName === 'DIV' && el.classList.contains('shape') && el.hasAttribute('data-shape');
  function labelShape(el) {
    for (let e = el && el.parentElement; e && e !== deck; e = e.parentElement) if (isBoxShape(e)) return e;
    return null;
  }
  // ---------- live elements ----------
  // The interactive parts of a slide: a custom element (<quiz-box>) or anything marked data-live. The deck's scripts
  // may change what is inside them while they run; the editor saves them as the file has them. Each one carries the
  // markup it had before any script touched it (data-dk-src, recorded when this script starts, before deferred and
  // module scripts run, and whenever the editor builds slides from markup), and is saved as that markup with the
  // style the user gave it (moved, sized). On a slide they are objects, like pictures: no text is edited inside them.
  const LIVE_SRC = 'data-dk-src', FOLD = 'data-dk-open';
  const isLive = el => !!el && el.nodeType === 1 && !(el instanceof SVGElement) && !el.hasAttribute(RT) &&
    (el.hasAttribute('data-live') || el.localName.includes('-'));
  // The outermost live elements in `root` (itself included).
  function liveIn(root) {
    const out = [];
    const walk = el => { for (const c of el.children) { if (isLive(c)) out.push(c); else walk(c); } };
    if (isLive(root)) out.push(root); else if (root.children) walk(root);
    return out;
  }
  function stampLive(root) {
    if (!root) return root;
    for (const el of liveIn(root)) if (!el.hasAttribute(LIVE_SRC)) el.setAttribute(LIVE_SRC, el.outerHTML);
    // A fold (<details>) is saved open or closed as it was written, however often it is opened while presenting.
    const folds = [...(root.matches && root.matches('details') ? [root] : []), ...root.querySelectorAll('details')];
    for (const d of folds) if (!d.hasAttribute(FOLD)) d.setAttribute(FOLD, d.open ? '1' : '0');
    return root;
  }
  // The live element as written, with the style the user gave it.
  function liveSource(el) {
    const t = document.createElement('template');
    t.innerHTML = el.getAttribute(LIVE_SRC);
    const s = t.content.firstElementChild;
    if (!s) return null;
    const st = el.getAttribute('style');
    if (st === null) s.removeAttribute('style'); else s.setAttribute('style', st);
    return s;
  }
  // A copy (duplicate, thumbnail) starts as written, so the deck's script sets it up afresh instead of copying its state.
  function resetLive(root) {
    let out = root;
    for (const el of liveIn(root)) {
      if (!el.hasAttribute(LIVE_SRC)) continue;
      const s = liveSource(el);
      if (!s) continue;
      s.setAttribute(LIVE_SRC, el.getAttribute(LIVE_SRC));
      if (el === root) out = s; else el.replaceWith(s);
    }
    return out;
  }
  const liveRoot = el => { let r = null; for (let e = el; e && e.nodeType === 1 && e !== deck; e = e.parentElement) if (isLive(e)) r = e; return r; };
  stampLive(document.querySelector('main.deck'));

  function cleanClone(node) {
    let c = node.cloneNode(true);
    for (const el of liveIn(c)) {
      if (!el.hasAttribute(LIVE_SRC)) continue;
      const s = liveSource(el);
      if (!s) continue;
      if (el === c) c = s; else el.replaceWith(s);
    }
    for (const d of [c, ...c.querySelectorAll('[' + FOLD + ']')]) {
      if (d.nodeType !== 1 || !d.hasAttribute(FOLD)) continue;
      const open = d.getAttribute(FOLD) === '1';
      if (open !== d.hasAttribute('open')) d.toggleAttribute('open', open);
      d.removeAttribute(FOLD);
    }
    [c, ...c.querySelectorAll('[data-dk-tex]')].filter(m => m.nodeType === 1 && m.hasAttribute('data-dk-tex')).forEach(m => {
      m.textContent = m.getAttribute('data-dk-tex');
      m.removeAttribute('data-dk-tex');
    });
    c.querySelectorAll('[' + RT + ']').forEach(e => e.remove());
    // The zero-width space that gives the caret a place after a formula is never recorded or saved.
    if (c.textContent.includes('\u200b')) {
      const w = document.createTreeWalker(c, NodeFilter.SHOW_TEXT), drop = [];
      for (let n; (n = w.nextNode());) {
        if (!n.data.includes('\u200b') || (n.parentElement && n.parentElement.closest('.math, style, script'))) continue;
        n.data = n.data.replace(/\u200b/g, '');
        if (!n.data) drop.push(n);
      }
      drop.forEach(n => n.remove());
    }
    // An empty table cell holds a placeholder <br> while edited; save it as <td></td>.
    c.querySelectorAll('td, th').forEach(cell => {
      const kids = [...cell.childNodes], brs = kids.filter(n => n.nodeName === 'BR');
      if (brs.length === 1 && kids.every(n => n === brs[0] || (n.nodeType === 3 && !n.textContent.trim()))) cell.replaceChildren();
    });
    for (const e of [c, ...c.querySelectorAll('*')]) {
      e.removeAttribute('contenteditable');
      e.removeAttribute('data-dk-main');
      e.removeAttribute(LIVE_SRC);
      if (e.classList && e.classList.length) {
        [...e.classList].filter(k => k.startsWith('dk-')).forEach(k => e.classList.remove(k));
      }
      if (e.getAttribute('class') === '') e.removeAttribute('class');
      const st = e.getAttribute('style');
      if (st === '') e.removeAttribute('style');
      // White text is written as #fff, the way a person (and the AI) writes it, not as the browser's rgb(255, 255, 255).
      else if (st && st.includes('rgb(255, 255, 255)')) e.setAttribute('style', st.replace(/(^|[;\s])color: rgb\(255, 255, 255\)/g, '$1color: #fff'));
    }
    return c;
  }
  // The HTML serializer writes empty SVG shapes as <rect …></rect>; put them back to <rect …/> so diffs stay quiet.
  const SVG_EMPTY = /<(rect|circle|ellipse|line|path|polygon|polyline|stop|use|image|animate|animateTransform|set|fe[A-Z][A-Za-z]*)(\s[^<>]*)?><\/\1>/g;
  const tidySvg = s => s.replace(SVG_EMPTY, (_, tag, attrs) => `<${tag}${attrs || ''}/>`);
  const deckHTML = () => tidySvg(cleanClone(deck).innerHTML);
  function fullHTML() {
    const c = cleanClone(html), t = c.querySelector('title');
    if (t && autoTitle) t.textContent = fileTitle;   // the tab shows the talk's title; the file keeps its own
    return '<!DOCTYPE html>\n' + tidySvg(c.outerHTML) + '\n';
  }
  // A deck still titled like the template (or titled like its first slide) shows its first slide's heading as the
  // tab and PDF name. Only the page shows it; the <title> in the file is never changed.
  let fileTitle = '', autoTitle = false;
  function firstHeading() {
    const s = slides()[0], h = s && s.querySelector('h1, h2');
    return h ? cleanClone(h).textContent.replace(/\s+/g, ' ').trim() : '';
  }
  const isAutoTitle = () => !fileTitle.trim() || fileTitle.trim() === '발표 제목' || fileTitle.trim() === 'Presentation title' || fileTitle.trim() === firstHeading();
  function updateTitle() {
    if (!autoTitle) return;
    const t = firstHeading() || fileTitle;
    if (document.title !== t) document.title = t;
  }

  function deckFromText(text) {
    const d = new DOMParser().parseFromString(text, 'text/html').querySelector('main.deck, .deck');
    return d ? tidySvg(cleanClone(d).innerHTML) : null;
  }

  // Same length as `text`, with comments and <style>/<script> bodies blanked, so tag searches see only real markup.
  function blankNonMarkup(text) {
    return text.replace(/<!--[\s\S]*?(?:-->|$)|(<(style|script|textarea|template)\b(?:[^>"']|"[^"]*"|'[^']*')*>)([\s\S]*?)(<\/\2\s*>)/gi,
      (m, open, tag, body, close) => (open ? open + body.replace(/[^\n]/g, ' ') + close : m.replace(/[^\n]/g, ' ')));
  }
  const TAG = '(?:[^>"\']|"[^"]*"|\'[^\']*\')*';
  // Where the inside of <main class="deck">…</main> sits in the file text.
  function locateDeck(text) {
    const t = blankNonMarkup(text);
    if ((t.match(/<main\b/gi) || []).length !== 1) return null;
    const open = new RegExp('<main\\b' + TAG + '>', 'i').exec(t);
    if (!open || !/\bclass\s*=\s*(?:"[^"]*\bdeck\b[^"]*"|'[^']*\bdeck\b[^']*'|deck\b)/i.test(open[0])) return null;
    const start = open.index + open[0].length;
    const end = t.toLowerCase().indexOf('</main', start);
    return end < 0 ? null : { start, end };
  }
  // Split the deck's inner text into top-level <section class="slide"> chunks and the gaps between them.
  function splitSlides(inner) {
    const blank = blankNonMarkup(inner);
    const tok = new RegExp('<section\\b' + TAG + '>|<\\/section\\s*>', 'gi');
    const chunks = [], gaps = [];
    let depth = 0, from = 0, start = 0, m;
    while ((m = tok.exec(blank))) {
      if (m[0][1] !== '/') {
        if (depth++ === 0) { gaps.push(inner.slice(from, m.index)); start = m.index; }
      } else if (depth > 0 && --depth === 0) {
        chunks.push(inner.slice(start, tok.lastIndex));
        from = tok.lastIndex;
      }
    }
    if (depth) return null;
    gaps.push(inner.slice(from));
    const onlySpace = g => !g.replace(/<!--[\s\S]*?-->/g, '').trim();
    if (!gaps.every(onlySpace) || !chunks.every(c => /^<section\b[^>]*\bclass\s*=\s*["'][^"']*\bslide\b/i.test(c))) return null;
    return { chunks, gaps };
  }
  function serializeChunk(src) {
    const t = document.createElement('template');
    t.innerHTML = src;
    const el = t.content.firstElementChild;
    return el ? tidySvg(cleanClone(el).outerHTML) : null;
  }
  // New file text: slides that did not change keep their exact original text; only edited slides are re-serialized.
  // What sits in front of a slide in the file (blank lines, a comment such as <!-- 3. Results -->) belongs to that slide
  // and goes wherever it goes; an edited slide keeps the one of the slide it replaces, a new slide gets only a blank line.
  // Where each slide on screen came from in the file: the text of its <section> there, as last read or written. A
  // slide that is moved and edited in the same save keeps the comment above it through this.
  const origins = new WeakMap();
  // What stood in front of each slide in the file (its comment), so a slide the AI deleted and I keep gets it back.
  const leads = new Map();
  function noteOrigins(text) {
    const loc = text && locateDeck(text), parts = loc && splitSlides(text.slice(loc.start, loc.end));
    if (!parts) return;
    const sers = parts.chunks.map(serializeChunk), nodes = slides();
    sers.forEach((x, i) => { if (x && /<!--/.test(parts.gaps[i])) leads.set(x, parts.gaps[i]); });
    matchSlides(sers, nodes.map(n => tidySvg(cleanClone(n).outerHTML))).forEach((j, c) => { if (j >= 0) origins.set(nodes[j], sers[c]); });
  }
  function composeFile(text, inner, orig = []) {
    const loc = locateDeck(text);
    if (!loc) return null;
    const live = slideList(inner);
    const parts = splitSlides(text.slice(loc.start, loc.end));
    let body;
    if (!parts) {
      body = inner;
    } else {
      const { chunks, gaps } = parts;
      const sers = chunks.map(serializeChunk);
      const used = chunks.map(() => false);
      // 1. Slides whose content is unchanged, wherever they moved.
      const exact = live.map(ser => {
        const i = sers.findIndex((x, j) => !used[j] && x === ser);
        if (i >= 0) used[i] = true;
        return i;
      });
      // 2. An edited slide keeps the comment of the slide it was in the file, wherever it is now.
      const from = exact.slice();
      for (let k = 0; k < live.length; k++) {
        if (from[k] >= 0 || !orig[k]) continue;
        const i = sers.findIndex((x, j) => !used[j] && x === orig[k]);
        if (i >= 0) { used[i] = true; from[k] = i; }
      }
      // 3. Else it takes the place (and the comment) of the original most like it between the same unchanged
      // neighbours, or of one with the same first heading; a slide like none of them is new.
      for (let k = 0; k < live.length; k++) {
        if (from[k] >= 0) continue;
        let lo = -1, hi = chunks.length;
        for (let j = 0; j < k; j++) if (from[j] > lo) lo = from[j];
        for (let j = k + 1; j < live.length; j++) if (exact[j] >= 0) { hi = exact[j]; break; }
        const free = sers.map((x, j) => j).filter(j => !used[j] && j > lo && j < hi);
        const i = likest(live[k], free.map(j => sers[j]));
        if (i >= 0) { used[free[i]] = true; from[k] = free[i]; }
      }
      for (let k = 0; k < live.length; k++) {
        const h = from[k] < 0 && headOf(live[k]);
        const free = h ? sers.map((x, j) => j).filter(j => !used[j] && headOf(sers[j]) === h) : [];
        const i = likest(live[k], free.map(j => sers[j]));
        if (i >= 0) { used[free[i]] = true; from[k] = free[i]; }
      }
      const ind = (/\n([ \t]*)$/.exec(gaps[0]) || /\n([ \t]*)$/.exec(gaps[1] || '') || ['', ''])[1];
      const sep = '\n\n' + ind;
      const lead = i => gaps[i];
      // A slide no longer in the file (the AI deleted it; I kept mine) comes back with the comment it had there.
      const back = k => (orig[k] && !sers.includes(orig[k]) && leads.get(orig[k])) || sep;
      body = live.map((ser, k) => (exact[k] >= 0 ? lead(exact[k]) + chunks[exact[k]] : from[k] >= 0 ? lead(from[k]) + ser : back(k) + ser)).join('') + gaps[gaps.length - 1];
      if (!live.length) body = gaps[0] + gaps[gaps.length - 1];
    }
    return text.slice(0, loc.start) + body + text.slice(loc.end);
  }

  // ---------- math ----------
  let katexP = null;
  function loadKatex(any = false) {
    if (!any && !deck.querySelector('.math') && !shadowMaths(deck).length) return Promise.resolve();
    // KaTeX's stylesheet hides the MathML copy of each formula. Without it (it failed to load, or the deck brought
    // its own KaTeX script and no stylesheet) every formula would show twice, so then only the MathML copy shows.
    if (!document.querySelector('link[href*="katex"][href$=".css"]')) {
      const l = document.createElement('link');
      l.rel = 'stylesheet'; l.href = KATEX + 'katex.min.css'; l.setAttribute(RT, '');
      l.onerror = () => html.classList.add('dk-mathml-only');
      document.head.append(l);
    }
    if (window.katex) return Promise.resolve();
    if (!katexP) katexP = new Promise(res => {
      const s = document.createElement('script');
      s.src = KATEX + 'katex.min.js'; s.setAttribute(RT, '');
      s.onload = s.onerror = () => res();
      document.head.append(s);
    });
    return katexP;
  }
  function renderMathEl(el) {
    if (!window.katex || el.hasAttribute('data-dk-tex') || el === editing) return;
    const tex = el.textContent;
    el.setAttribute('data-dk-tex', tex);
    // In an interactive element, or inside its shadow root, a formula is drawn as MathML only: the browser draws it
    // without KaTeX's stylesheet, which never reaches a shadow root, so a widget that copies its content stays right.
    const widget = !!liveRoot(el) || el.getRootNode() !== document;
    try {
      window.katex.render(tex.trim(), el, {
        displayMode: el.classList.contains('display') || el.tagName === 'DIV',
        throwOnError: false,
        output: widget ? 'mathml' : 'htmlAndMathml',
      });
    } catch (_) { /* leave the raw TeX visible */ }
    if (el.classList.contains('display') || el.tagName === 'DIV') fitMath(el);
  }
  const renderMath = (root = deck) => { root.querySelectorAll('.math').forEach(renderMathEl); shadowMaths(root).forEach(renderMathEl); };
  // Formulas a widget put inside its (open) shadow root.
  function shadowMaths(root) {
    const out = [];
    const walk = r => r.querySelectorAll('*').forEach(e => { if (e.shadowRoot) { out.push(...e.shadowRoot.querySelectorAll('.math')); walk(e.shadowRoot); } });
    if (root && root.querySelectorAll) walk(root);
    return out;
  }
  // A widget may build or rebuild its formulas later (on a click, a step): draw them once it has.
  function renderWidgetMath(root) {
    if (!shadowMaths(root).some(m => !m.hasAttribute('data-dk-tex'))) return;
    loadKatex(true).then(() => renderMath(root));
  }
  // A display formula a little too wide for its box is drawn smaller (down to 60%) instead of sticking out. Only the
  // rendered formula is scaled; the file keeps the TeX and the size it was given.
  function fitMath(el) {
    const k = el.querySelector(':scope > .katex-display > .katex, :scope > .katex');
    if (!k || !el.hasAttribute('data-dk-tex')) return;
    k.style.fontSize = '';
    const box = el.clientWidth, html = k.querySelector('.katex-html');
    if (!box || !html) return;   // on a hidden slide: fitted when it is shown
    const w = html.scrollWidth;
    if (w > box + 1) k.style.fontSize = Math.max(60, Math.floor(box / w * 1000) / 10) + '%';
  }
  const fitMaths = (root = deck) => root && root.querySelectorAll && root.querySelectorAll('.math.display, div.math').forEach(fitMath);

  // ---------- runtime styles ----------
  // What the deck looks like before our styles take over the page; slides and thumbnails inherit this.
  function readLook() {
    const transparent = c => !c || c === 'transparent' || /rgba\(.*,\s*0\)$/.test(c);
    const b = getComputedStyle(document.body), r = getComputedStyle(html);
    const bg = !transparent(b.backgroundColor) ? b.backgroundColor : !transparent(r.backgroundColor) ? r.backgroundColor : '#fff';
    return { bg, fontFamily: b.fontFamily, fontSize: b.fontSize, lineHeight: b.lineHeight, fontWeight: b.fontWeight, color: b.color, letterSpacing: b.letterSpacing };
  }
  let look;
  // How the deck spaces a bulleted list, so a numbered list made from it (when the deck has no rule for those) sits
  // exactly where the bullets were.
  function listLook() {
    const probe = document.createElement('section');
    probe.className = 'slide';
    probe.setAttribute(RT, '');
    probe.style.cssText = 'position:absolute;left:-99999px;top:0;visibility:hidden';
    probe.innerHTML = '<ul><li>x</li></ul>';
    deck.appendChild(probe);
    const cs = getComputedStyle(probe.firstChild);
    const out = { mt: cs.marginTop, mb: cs.marginBottom, pl: cs.paddingLeft };
    probe.remove();
    return out;
  }
  function injectStyles() {
    look = readLook();
    const ul = listLook();
    const st = document.createElement('style');
    st.setAttribute(RT, '');
    st.textContent = `
@media screen {
  html.dk-on, html.dk-on body { margin:0 !important; height:100%; overflow:hidden !important; background:#111 !important; }
  html.dk-on [data-dk-main] { position:fixed !important; inset:0; margin:0 !important; padding:0 !important; transform:none !important; display:block !important;
    width:auto !important; height:auto !important; min-width:0 !important; min-height:0 !important; max-width:none !important; max-height:none !important;
    zoom:1 !important; overflow:hidden !important; border:0 !important; }
  html.dk-edit [data-dk-main] { left:${SIDEBAR}px; top:${TOOLBAR}px; background:#1d1d20 !important; }
  html.dk-on [data-dk-main] > .slide:not(.dk-current) { position:absolute !important; left:-400vw !important; top:0 !important;
    visibility:hidden !important; pointer-events:none !important; }
  html.dk-on [data-dk-main] > .slide.dk-current { position:absolute !important; left:50% !important; top:50% !important; margin:0 !important;
    transform:translate(-50%,-50%) scale(var(--dk-scale,1)) !important; }
  html.dk-edit [data-dk-main] > .slide.dk-current { box-shadow:0 10px 40px #0009; }
  html.dk-edit [data-dk-main] .slide img { -webkit-user-drag:none; }
  html.dk-mathml-only .katex-html { display:none !important; }
  html.dk-edit [data-dk-main] .slide details:not([open])::details-content { content-visibility:visible; opacity:.7; }
  html.dk-edit [data-dk-main] [contenteditable="true"] { outline:none; cursor:text; }
  html.dk-edit [data-dk-main] .slide { user-select:none; -webkit-user-select:none; }
  html.dk-on:not(.dk-edit) [data-dk-main] .slide { user-select:none; -webkit-user-select:none; }
  html.dk-edit [data-dk-main] [contenteditable] { user-select:text; -webkit-user-select:text; }
  html.dk-edit [data-dk-main] .slide :is(td,th) { outline:1px dashed #4c8dff59; outline-offset:-1px; min-width:2.5em; }
  html.dk-edit [data-dk-main] > .slide[contenteditable] { cursor:default; }
  html.dk-edit [data-dk-main] > .slide[contenteditable] > :not([contenteditable]) { cursor:text; }
  html.dk-dragging, html.dk-dragging * { user-select:none !important; cursor:grabbing !important; }
  html.dk-edit.dk-hover-move [data-dk-main] .slide, html.dk-edit.dk-hover-move [data-dk-main] .slide * { cursor:move; }
  html.dk-edit.dk-hover-text [data-dk-main] .slide * { cursor:text; }
  html:not(.dk-edit) #dk-sidebar { display:none !important; }
  html.dk-on.dk-hide-cursor, html.dk-on.dk-hide-cursor * { cursor:none !important; }
}
[data-dk-main] > .slide, .dk-thumb-scale > .slide { width:${W}px !important; height:${H}px !important; min-width:0 !important; min-height:0 !important;
  max-width:none !important; max-height:none !important; box-sizing:border-box; overflow:hidden; zoom:1 !important; isolation:isolate; }
/* An empty table cell keeps its line height in every mode (nothing is written into the file for it). */
[data-dk-main] > .slide :is(td,th):empty::before, .dk-thumb-scale > .slide :is(td,th):empty::before { content:'\\200b'; }
[data-dk-main] > .slide.dk-bgfix, .dk-thumb-scale > .slide.dk-bgfix { background-color:${look.bg} !important; }
#dk-sidebar .dk-thumb-scale { font-family:${look.fontFamily}; font-size:${look.fontSize}; line-height:${look.lineHeight}; font-weight:${look.fontWeight};
  color:${look.color}; letter-spacing:${look.letterSpacing}; text-align:start; }
.slide .notes { display:none !important; }
#dk-sidebar { all:initial; position:fixed; left:0; top:${TOOLBAR}px; bottom:0; width:${SIDEBAR}px; overflow-y:auto; overflow-x:hidden;
  background:#161618; border-right:1px solid #2a2a2e; padding:14px 10px 60px 6px; box-sizing:border-box; z-index:2147483000;
  font:12px -apple-system, system-ui, sans-serif; color:#888; }
#dk-sidebar .dk-thumb { display:flex; gap:6px; align-items:flex-start; margin:0 0 12px; cursor:pointer; position:relative; }
#dk-sidebar .dk-thumb-num { width:22px; flex:none; text-align:right; font:11px/1 -apple-system, system-ui, sans-serif; color:#888; padding-top:3px; }
#dk-sidebar .dk-thumb.dk-active .dk-thumb-num { color:#fff; }
#dk-sidebar .dk-thumb-frame { width:${THUMB_W}px; height:${Math.round(THUMB_W * H / W)}px; flex:none; overflow:hidden; position:relative;
  border-radius:4px; background:#fff; box-shadow:0 0 0 1px #2e2e33; }
#dk-sidebar .dk-thumb:hover .dk-thumb-frame { box-shadow:0 0 0 2px #4c8dff66; }
#dk-sidebar .dk-thumb.dk-active .dk-thumb-frame { box-shadow:0 0 0 2px #4c8dff; }
#dk-sidebar .dk-thumb.dk-conflict .dk-thumb-frame { box-shadow:0 0 0 3px #f0b429; }
#dk-sidebar .dk-thumb.dk-dragsrc { opacity:.35; }
#dk-sidebar .dk-thumb.dk-flash .dk-thumb-frame { animation:dk-flash .9s ease-out; }
@keyframes dk-flash { 0%, 40% { box-shadow:0 0 0 5px #f0b429; } 100% { box-shadow:0 0 0 2px #4c8dff; } }
#dk-sidebar .dk-thumb.dk-drop-before::before, #dk-sidebar .dk-thumb.dk-drop-after::after { content:""; position:absolute; left:28px; right:0; height:3px;
  background:#4c8dff; border-radius:2px; }
#dk-sidebar .dk-add-slide { display:flex; align-items:center; justify-content:center; gap:6px; margin:2px 0 0 28px; width:${THUMB_W}px; height:40px;
  box-sizing:border-box; border:1px dashed #3a3a40; border-radius:4px; color:#8a8a90; cursor:pointer; font:12px -apple-system, system-ui, sans-serif; }
#dk-sidebar .dk-add-slide:hover { border-color:#4c8dff; color:#cfe0ff; background:#4c8dff14; }
#dk-sidebar .dk-thumb.dk-drop-before::before { top:-8px; }
#dk-sidebar .dk-thumb.dk-drop-after::after { bottom:-8px; }
#dk-sidebar .dk-thumb-scale { position:absolute !important; left:0 !important; top:0 !important; width:${W}px !important; height:${H}px !important;
  margin:0 !important; padding:0 !important; transform:scale(${THUMB_W / W}) !important; transform-origin:0 0 !important; pointer-events:none;
  display:block !important; background:none !important; }
#dk-sidebar .dk-thumb-scale > .slide { position:relative !important; left:auto !important; top:auto !important; transform:none !important; margin:0 !important; }
/* Korean words wrap at spaces, not between syllables (a deck's own word-break wins; nothing of this is saved). */
:where([data-dk-main] > .slide, .dk-thumb-scale > .slide) { word-break:keep-all; overflow-wrap:break-word; }
@media print {
  @page { size:${W}px ${H}px; margin:0; }
  html, body { margin:0 !important; padding:0 !important; background:none !important; }
  /* Shape fills and slide backgrounds print without the browser's "background graphics" option. */
  [data-dk-main] > .slide, [data-dk-main] > .slide * { -webkit-print-color-adjust:exact !important; print-color-adjust:exact !important; }
  #dk-sidebar, #dk-chrome { display:none !important; }
  [data-dk-main] > .slide { break-after:page; page-break-after:always; }
  /* Printing while text is being edited: no focus ring, caret or selection on the page. */
  [data-dk-main] [contenteditable] { outline:none !important; caret-color:transparent !important; }
  [data-dk-main] ::selection { background:transparent !important; }
}
/* Text inside a shape sits in its middle and wraps inside it. What the toolbar makes (numbered lists, quotes, code,
   links) looks like part of the deck when the deck has no rule for it; every rule here has zero specificity, so the
   deck's own CSS always wins. Nothing of this is saved. */
:where([data-dk-main] > .slide, .dk-thumb-scale > .slide) :where(div.shape[data-shape]) { display:flex; flex-direction:column; align-items:center;
  justify-content:center; text-align:center; box-sizing:border-box; padding:.3em .5em; overflow-wrap:anywhere; }
:where([data-dk-main] > .slide, .dk-thumb-scale > .slide) :where(div.shape[data-shape] > *) { margin:0; max-width:100%; }
:where([data-dk-main] > .slide, .dk-thumb-scale > .slide) :where(ol) { margin-top:${ul.mt}; margin-bottom:${ul.mb}; padding-left:${ul.pl}; }
:where([data-dk-main] > .slide, .dk-thumb-scale > .slide) :where(blockquote) { margin:0; padding-left:.8em;
  border-left:.15em solid color-mix(in srgb, currentColor 25%, transparent); }
:where([data-dk-main] > .slide, .dk-thumb-scale > .slide) :where(code) { font-family:ui-monospace, "SF Mono", Menlo, Consolas, monospace;
  font-size:.88em; background:color-mix(in srgb, currentColor 9%, transparent); padding:.08em .3em; border-radius:.25em; }
:where([data-dk-main] > .slide, .dk-thumb-scale > .slide) :where(pre) { margin:0; padding:.6em .8em; border-radius:.35em; white-space:pre-wrap;
  background:color-mix(in srgb, currentColor 7%, transparent); font-family:ui-monospace, "SF Mono", Menlo, Consolas, monospace; font-size:.8em; line-height:1.5; }
:where([data-dk-main] > .slide, .dk-thumb-scale > .slide) :where(pre code) { background:none; padding:0; font-size:inherit; }
:where([data-dk-main] > .slide, .dk-thumb-scale > .slide) :where(a) { color:var(--accent, #4c8dff); }
/* KaTeX marks accented letters (\\hat, \\bar, \\vec) with the class "accent"; a deck's own .accent color is not for them. */
.slide .katex .accent { color:inherit; }`;
    document.head.appendChild(st);
    const vars = document.createElement('style');
    vars.setAttribute(RT, '');
    document.head.appendChild(vars);
    return vars;
  }
  let varStyle;

  // ---------- chrome (toolbar, selection box, toasts) in a shadow root ----------
  let host, shadow, sidebar, fileInput;
  const svgI = d => `<svg viewBox="0 0 24 24" aria-hidden="true">${d}</svg>`;
  const IC = {
    slide: svgI('<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M12 9.5v5M9.5 12h5"/>'),
    text: svgI('<path d="M5 7.5V5h14v2.5M12 5v14M9 19h6"/>'),
    table: svgI('<rect x="3" y="4.5" width="18" height="15" rx="2"/><path d="M3 9.5h18M3 14.5h18M9 4.5v15M15 4.5v15"/>'),
    image: svgI('<rect x="3" y="4.5" width="18" height="15" rx="2"/><circle cx="8.5" cy="9.5" r="1.8"/><path d="M21 15.5l-5-5-10 9"/>'),
    rect: svgI('<rect x="4" y="6" width="16" height="12" rx="1"/>'),
    round: svgI('<rect x="4" y="6" width="16" height="12" rx="4.5"/>'),
    circle: svgI('<circle cx="12" cy="12" r="7.5"/>'),
    line: svgI('<path d="M5 19L19 5"/>'),
    arrow: svgI('<path d="M5 19L19 5M10 5h9v9"/>'),
    math: svgI('<path d="M17.5 5H6.5l6 7-6 7h11"/>'),
    undo: svgI('<path d="M9 13L4 8l5-5"/><path d="M4 8h10.5a5.5 5.5 0 0 1 0 11H11"/>'),
    redo: svgI('<path d="M15 13l5-5-5-5"/><path d="M20 8H9.5a5.5 5.5 0 0 0 0 11H13"/>'),
    play: svgI('<path d="M8 5.5l11 6.5-11 6.5z" fill="currentColor" stroke="none"/>'),
    caret: svgI('<path d="M7 10l5 5 5-5"/>'),
    caretUp: svgI('<path d="M7 14l5-5 5 5"/>'),
    alignL: svgI('<path d="M4 6h16M4 10h10M4 14h16M4 18h10"/>'),
    alignC: svgI('<path d="M4 6h16M7 10h10M4 14h16M7 18h10"/>'),
    alignR: svgI('<path d="M4 6h16M10 10h10M4 14h16M10 18h10"/>'),
    alignJ: svgI('<path d="M4 6h16M4 10h16M4 14h16M4 18h16"/>'),
    vTop: svgI('<path d="M4 4h16"/><rect x="6" y="7" width="5" height="13" rx="1"/><rect x="13" y="7" width="5" height="8" rx="1"/>'),
    slideH: svgI('<rect x="3" y="5" width="18" height="14" rx="1.5"/><path d="M12 3v18" stroke-dasharray="2 2"/><rect x="9" y="9" width="6" height="6" rx="1"/>'),
    slideV: svgI('<rect x="3" y="5" width="18" height="14" rx="1.5"/><path d="M1 12h22" stroke-dasharray="2 2"/><rect x="9" y="9" width="6" height="6" rx="1"/>'),
    slideC: svgI('<rect x="3" y="5" width="18" height="14" rx="1.5"/><path d="M12 3v18M1 12h22" stroke-dasharray="2 2"/>'),
    vMid: svgI('<path d="M4 12h16"/><rect x="6" y="5" width="5" height="14" rx="1"/><rect x="13" y="8" width="5" height="8" rx="1"/>'),
    vBot: svgI('<path d="M4 20h16"/><rect x="6" y="4" width="5" height="13" rx="1"/><rect x="13" y="9" width="5" height="8" rx="1"/>'),
    ul: svgI('<path d="M10 6h11M10 12h11M10 18h11"/><circle cx="4.5" cy="6" r="1.4" fill="currentColor"/><circle cx="4.5" cy="12" r="1.4" fill="currentColor"/><circle cx="4.5" cy="18" r="1.4" fill="currentColor"/>'),
    ol: svgI('<path d="M10 6h11M10 12h11M10 18h11M4 4h1.5v5M3.5 9h3M3.5 14.5c.5-1 3-1 3 .5 0 1.2-3 2-3 3.5h3"/>'),
    unlist: svgI('<path d="M4 6h16M4 12h16M4 18h10"/>'),
    indent: svgI('<path d="M11 6h10M11 12h10M11 18h10M3 8l4 4-4 4"/>'),
    outdent: svgI('<path d="M11 6h10M11 12h10M11 18h10M7 8l-4 4 4 4"/>'),
    link: svgI('<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>'),
    unlink: svgI('<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/><path d="M4 4l16 16"/>'),
    code: svgI('<path d="M8 7l-5 5 5 5M16 7l5 5-5 5"/>'),
    quote: svgI('<path d="M6 17c-1.5-1-2-2.5-2-4.5C4 9 6 7 9 6.5M9 11H5M15 17c-1.5-1-2-2.5-2-4.5 0-3.5 2-5.5 5-6M18 11h-4"/>'),
    clear: svgI('<path d="M5 5h12M11 5l-3 14M14 14l6 6M20 14l-6 6"/>'),
    dots: svgI('<circle cx="5" cy="12" r="1.5" fill="currentColor"/><circle cx="12" cy="12" r="1.5" fill="currentColor"/><circle cx="19" cy="12" r="1.5" fill="currentColor"/>'),
    front: svgI('<rect x="8" y="8" width="12" height="12" rx="1.5" fill="currentColor" fill-opacity=".25"/><path d="M4 16V5a1 1 0 0 1 1-1h11"/>'),
    back: svgI('<rect x="4" y="4" width="12" height="12" rx="1.5"/><path d="M20 8v11a1 1 0 0 1-1 1H8"/>'),
    rotl: svgI('<path d="M4 4v6h6"/><path d="M5.5 15a8 8 0 1 0 1.9-8.3L4 10"/>'),
    rotr: svgI('<path d="M20 4v6h-6"/><path d="M18.5 15a8 8 0 1 1-1.9-8.3L20 10"/>'),
    rowAbove: svgI('<rect x="3" y="11" width="18" height="9" rx="1.5"/><path d="M12 3v6M9 6h6"/>'),
    rowBelow: svgI('<rect x="3" y="4" width="18" height="9" rx="1.5"/><path d="M12 15v6M9 18h6"/>'),
    colLeft: svgI('<rect x="11" y="3" width="9" height="18" rx="1.5"/><path d="M3 12h6M6 9v6"/>'),
    colRight: svgI('<rect x="4" y="3" width="9" height="18" rx="1.5"/><path d="M15 12h6M18 9v6"/>'),
    heading: svgI('<path d="M6 5v14M17 5v14M6 12h11"/>'),
    dup: svgI('<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3"/>'),
    trash: svgI('<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>'),
  };
  function buildChrome() {
    host = document.createElement('div');
    host.id = 'dk-chrome';
    host.setAttribute(RT, '');
    host.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483001;';
    shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = `
<style>
  :host { all:initial; }
  * { box-sizing:border-box; font:13px/1.2 -apple-system, BlinkMacSystemFont, "Apple SD Gothic Neo", system-ui, sans-serif; }
  .bar { position:fixed; left:0; right:0; top:0; height:${TOOLBAR}px; display:none; align-items:center; gap:2px; padding:0 10px;
    background:#161618; color:#ddd; border-bottom:1px solid #2a2a2e; pointer-events:auto; }
  .edit .bar { display:flex; }
  button { all:unset; box-sizing:border-box; cursor:pointer; padding:7px 9px; border-radius:6px; color:#ddd; white-space:nowrap; }
  button:hover { background:#2a2a2e; color:#fff; }
  button[disabled] { opacity:.35; pointer-events:none; }
  .bar button { display:inline-flex; align-items:center; gap:6px; height:32px; padding:0 8px; }
  .bar svg { width:18px; height:18px; flex:none; stroke:currentColor; fill:none; stroke-width:1.8; stroke-linecap:round; stroke-linejoin:round; }
  .bar .split { display:inline-flex; border-radius:6px; }
  .bar .split > button:first-child { border-radius:6px 0 0 6px; padding-right:5px; }
  .bar .split > .caret { border-radius:0 6px 6px 0; padding:0 5px 0 3px; color:#8a8a90; }
  .bar .split > .caret svg { width:12px; height:12px; stroke-width:2.4; }
  .bar .split:hover > button { background:#222226; }
  .bar .split > button:hover { background:#303036; color:#fff; }
  .bar .split > button.open, .bar button.open { background:#303036; color:#fff; }
  button.primary { background:#3b6fe0; color:#fff; }
  .bar button.primary { padding:0 14px; margin:0 2px; }
  button.primary:hover { background:#4b7ff0; }
  button.status { color:#9a9aa2; font-size:12px; height:28px; padding:0 11px; border:1px solid #2e2e34; border-radius:999px; margin-right:4px; }
  .bar button.status { height:28px; padding:0 11px; }
  button.status:hover { color:#ddd; background:#222226; }
  button.status.warn { color:#f0b429; border-color:#5b4a1d; }
  button.status.ai { color:#9cc0ff; border-color:#2c4a80; }
  button.status .dot { display:inline-block; width:7px; height:7px; border-radius:50%; background:#f0b429; margin-right:2px; flex:none; }
  .sep { width:1px; height:22px; background:#333; margin:0 6px; flex:none; }
  .count { color:#999; padding:0 6px 0 4px; min-width:46px; font-variant-numeric:tabular-nums; }
  .spacer { flex:1; min-width:8px; }
  @media (max-width:1179px) { .bar .lb { display:none; } .bar .split > button:first-child { padding-right:3px; } }

  .fmt { position:fixed; display:none; flex-wrap:wrap; gap:6px; padding:6px; max-width:min(600px, calc(100vw - ${SIDEBAR + 12}px));
    background:rgba(222,226,234,.92); backdrop-filter:blur(10px); border-radius:12px; box-shadow:0 8px 28px #0003; pointer-events:auto; align-items:center; }
  .fmt.show { display:flex; }
  .fmt .grp { display:flex; align-items:center; gap:2px; background:#fff; border-radius:8px; padding:3px; }
  .fmt button { color:#3a3d44; padding:0 7px; border-radius:6px; min-width:30px; height:30px; display:inline-flex; align-items:center;
    justify-content:center; gap:6px; font-size:14px; }
  .fmt button:hover { background:#eef1f6; color:#111; }
  .fmt button.on, .fmt button.open { background:#cfe3ff; color:#0b57d0; }
  .fmt .dd { min-width:76px; justify-content:space-between; padding:0 6px 0 10px; }
  .fmt .dd.size { min-width:54px; }
  .fmt .dd.color { min-width:44px; padding:0 6px 0 8px; }
  .fmt .dd.ic { min-width:0; padding:0 4px 0 6px; gap:2px; }
  .fmt .dd.txt { min-width:0; padding:0 6px 0 10px; font-size:13px; }
  .fmt .dd i { font-style:normal; font-size:10px; color:#777; }
  .fmt .txt { font-size:13px; padding:0 9px; }
  .fmt .hide { display:none !important; }
  .fmt .vsep { width:1px; height:20px; background:#e3e5ea; margin:0 3px; }
  .fmt svg, .menu svg { width:18px; height:18px; flex:none; stroke:currentColor; fill:none; stroke-width:2; stroke-linecap:round; stroke-linejoin:round; }
  .fmt .glyph { font:600 16px/1 Georgia, serif; }
  .fmt .swatch { width:18px; height:18px; border-radius:4px; box-shadow:inset 0 0 0 1px #0003; background:var(--sw, #888); }
  .fmt.otb button { font-size:13px; }
  .fmt .colorA { font-weight:700; line-height:1; padding:0 1px 1px; border-bottom:3px solid var(--sw, #333); }

  .menu { position:fixed; display:none; background:#fff; color:#222; border-radius:10px; box-shadow:0 12px 32px #0004; padding:6px;
    pointer-events:auto; max-height:calc(100vh - 70px); overflow:auto; min-width:150px; }
  .menu.show { display:block; }
  .fmt { z-index:2; } .menu, .pop { z-index:3; } .toast, .banner { z-index:4; } .help { z-index:5; }
  .menu .item { display:flex; align-items:center; gap:10px; width:100%; box-sizing:border-box; padding:6px 12px 6px 10px; border-radius:6px; color:#222; }
  .menu .item:hover { background:#eef1f6; }
  .menu .item.on { background:#cfe3ff; color:#0b57d0; }
  .menu .item.danger { color:#c5221f; }
  .menu .item small { color:#999; margin-left:auto; padding-left:16px; }
  .menu hr { border:0; border-top:1px solid #eee; margin:4px 2px; }
  .menu .swatches { display:grid; grid-template-columns:repeat(8, 24px); gap:6px; padding:4px; }
  .menu .sw { width:24px; height:24px; min-width:0; border-radius:5px; padding:0; box-shadow:inset 0 0 0 1px #0002; }
  .menu .sw.on { box-shadow:0 0 0 2px #0b57d0; }
  .menu h4 { font-size:11px; color:#888; margin:6px 4px 4px; font-weight:500; }
  .menu .tgrid { display:grid; grid-template-columns:repeat(8, 20px); gap:3px; padding:6px 6px 2px; }
  .menu .tgrid button { width:20px; height:20px; padding:0; border-radius:3px; box-shadow:inset 0 0 0 1px #c9ced8; background:#fff; }
  .menu .tgrid button.hl { background:#cfe3ff; box-shadow:inset 0 0 0 1px #4c8dff; }
  .menu .tsize { padding:6px 8px 4px; color:#555; font-size:12px; min-height:24px; }
  .menu .chk { display:flex; align-items:center; gap:8px; width:100%; padding:6px 8px; border-radius:6px; color:#222; }
  .menu .chk:hover { background:#eef1f6; }
  .menu .chk .box { width:16px; height:16px; border-radius:4px; box-shadow:inset 0 0 0 1.5px #999; display:inline-flex; align-items:center;
    justify-content:center; color:transparent; font-size:12px; }
  .menu .chk.on .box { background:#3b6fe0; box-shadow:none; color:#fff; }

  .pop { position:fixed; display:none; width:300px; background:#fff; color:#222; border-radius:10px; box-shadow:0 12px 32px #0005;
    padding:14px; pointer-events:auto; }
  .pop.show { display:block; }
  .pop .msg { line-height:1.55; color:#333; margin-bottom:12px; }
  .pop .acts { display:flex; gap:6px; justify-content:flex-end; }
  .pop button { padding:6px 12px; color:#333; }
  .pop button:hover { background:#eef1f6; color:#111; }
  .pop button.primary { background:#3b6fe0; color:#fff; }
  .pop button.primary:hover { background:#4b7ff0; }

  .sel { position:fixed; display:none; outline:1.5px solid #4c8dff; outline-offset:3px; pointer-events:none; z-index:2; }
  .sel.editing { outline-style:dashed; }
  .grip { position:absolute; left:-24px; top:-24px; width:20px; height:20px; border-radius:5px; background:#4c8dff; color:#fff;
    cursor:move; pointer-events:auto; display:flex; align-items:center; justify-content:center; font-size:12px; }
  .sel.tight .grip { top:2px; left:-26px; }
  .resize, .edge { position:absolute; background:#fff; border:2px solid #4c8dff; border-radius:3px; pointer-events:auto; }
  .resize { right:-10px; bottom:-10px; width:12px; height:12px; cursor:nwse-resize; }
  .edge.rw { right:-9px; top:50%; margin-top:-11px; width:10px; height:22px; cursor:ew-resize; }
  .edge.rh { bottom:-9px; left:50%; margin-left:-11px; width:22px; height:10px; cursor:ns-resize; }
  .sel.no-edges .edge, .sel.no-rh .edge.rh { display:none; }
  .endpt { position:absolute; display:none; width:14px; height:14px; margin:-7px 0 0 -7px; border-radius:50%; background:#fff;
    border:2px solid #4c8dff; pointer-events:auto; cursor:crosshair; }
  .sel.line-ends .endpt { display:block; }
  .sel.line-ends .resize, .sel.line-ends .edge { display:none; }
  .selg .resize { pointer-events:auto; right:-9px; bottom:-9px; }
  .sizebadge { position:fixed; display:none; background:#111c; color:#fff; font-size:12px; padding:4px 8px; border-radius:6px;
    white-space:nowrap; font-variant-numeric:tabular-nums; z-index:6; pointer-events:auto; }
  .root.dragging .fmt { display:none !important; }
  .root.textdrag .fmt, .root.textdrag .fmt * { pointer-events:none !important; }
  .fmt .g-size .szl { min-width:44px; text-align:center; color:#3a3d44; font-size:13px; font-variant-numeric:tabular-nums; cursor:default; }
  .fmt .g-size button { font-size:17px; min-width:28px; }
  .tag { position:absolute; left:-2px; top:-31px; display:flex; gap:2px; pointer-events:none; white-space:nowrap; }
  .sel.tight .tag { top:4px; left:4px; }
  .tag span, .tag button { background:#4c8dff; color:#fff; font-size:11px; padding:4px 7px; border-radius:4px; }
  .tag button { cursor:pointer; background:#2f6fe8; pointer-events:auto; }
  .tag button:hover { background:#1f5fd8; }
  .sel.editing .tag { display:none; }
  .cellmark { position:fixed; display:none; box-shadow:inset 0 0 0 2px #4c8dff; pointer-events:none; }
  .guide { position:fixed; display:none; background:#ff2d87; pointer-events:none; }
  .guide.gx { width:1px; }
  .guide.gy { height:1px; }
  .guide.slide { box-shadow:0 0 0 0.5px #ff2d87; }
  .marquee { position:fixed; display:none; border:1px solid #4c8dff; background:#4c8dff1a; pointer-events:none; }
  .selm { position:fixed; display:none; outline:1px solid #4c8dff; pointer-events:none; }
  .hover { position:fixed; display:none; outline:1px solid #4c8dff80; pointer-events:none; }
  .selg { position:fixed; display:none; border:1px dashed #4c8dff; pointer-events:none; }
  .selg .gtag { position:absolute; left:-1px; top:-27px; background:#4c8dff; color:#fff; font-size:11px; padding:4px 7px; border-radius:4px; white-space:nowrap; }
  .selg.tight .gtag { top:4px; left:4px; }

  .toast { position:fixed; left:50%; bottom:28px; transform:translateX(-50%); background:#1f1f22f2; color:#fff; padding:10px 16px;
    border-radius:8px; opacity:0; transition:opacity .2s; pointer-events:none; max-width:80vw; box-shadow:0 4px 20px #0006; }
  .toast.show { opacity:1; }
  .toast.up { bottom:auto; top:${TOOLBAR + 12}px; }
  .banner { position:fixed; left:50%; top:${TOOLBAR + 12}px; transform:translateX(-50%); display:none; gap:6px; align-items:center;
    background:#3a2f12; color:#fde7a8; border:1px solid #6b5520; padding:6px 6px 6px 14px; border-radius:8px; pointer-events:auto; }
  .banner.show { display:flex; }
  .banner.pulse { animation:dk-pulse .45s ease-in-out 2; }
  @keyframes dk-pulse { 50% { box-shadow:0 0 0 6px #f0b42999; } }
  .banner .msg { margin-right:6px; }
  .banner button { background:#fde7a8; color:#2b2208; font-weight:600; padding:6px 14px; }
  .banner button:hover { background:#fff1c7; color:#1a1405; }
  .hint { position:fixed; left:50%; bottom:24px; transform:translateX(-50%); color:#fff; background:#000a; padding:9px 16px;
    border-radius:999px; opacity:0; transition:opacity .5s; pointer-events:none; }
  .hint.show { opacity:1; }
  .pcount { position:fixed; right:18px; bottom:14px; color:#fff9; background:#0006; padding:4px 8px; border-radius:6px; opacity:0; transition:opacity .3s; }
  .pcount.show { opacity:1; }
  .help { position:fixed; inset:0; display:none; align-items:center; justify-content:center; background:#000a; pointer-events:auto; }
  .help.show { display:flex; }
  .help .card { background:#1b1b1e; color:#ddd; border:1px solid #333; border-radius:12px; padding:24px 28px; max-width:680px; width:90vw;
    max-height:calc(100vh - 40px); overflow:auto; }
  .help h3 { font-size:15px; font-weight:600; color:#fff; margin:14px 0 8px; }
  .help h3:first-child { margin-top:0; }
  .help table { border-collapse:collapse; width:100%; table-layout:fixed; }
  .help td { padding:4px 0; vertical-align:top; }
  .help td:first-child { color:#9ab4ff; width:230px; padding-right:16px; }
</style>
<div class="root">
  <div class="bar">
    <span class="count" title="Current slide / total"></span>
    <span class="sep"></span>
    <span class="split"><button data-act="slide-new" title="Add a new slide (title + list)">${IC.slide}<span class="lb">New slide</span></button><button class="caret" data-menu="slide" title="Slide: blank slide, duplicate, delete">${IC.caret}</button></span>
    <span class="sep"></span>
    <span class="split"><button data-act="text" title="Add a text box">${IC.text}<span class="lb">Text</span></button><button class="caret" data-menu="text" title="Add a title or bulleted list">${IC.caret}</button></span>
    <span class="split"><button data-act="table" title="Add a table (3 × 3)">${IC.table}<span class="lb">Table</span></button><button class="caret" data-menu="table" title="Pick a table size">${IC.caret}</button></span>
    <button data-act="image" title="Add an image (or drop a file, or ⌘V)">${IC.image}<span class="lb">Image</span></button>
    <span class="split"><button data-act="shape" title="Add rectangle">${IC.rect}<span class="lb">Shape</span></button><button class="caret" data-menu="shape" title="Pick a shape: rectangle, rounded rectangle, circle, line">${IC.caret}</button></span>
    <button data-act="arrow" title="Add an arrow">${IC.arrow}<span class="lb">Arrow</span></button>
    <button data-act="math" title="Add an equation (TeX)">${IC.math}<span class="lb">Equation</span></button>
    <span class="spacer"></span>
    <button data-act="undo" title="Undo (⌘Z)">${IC.undo}</button>
    <button data-act="redo" title="Redo (⌘⇧Z)">${IC.redo}</button>
    <span class="sep"></span>
    <button data-act="connect" class="status"></button>
    <button data-act="save" class="primary" title="Save (⌘S)">Save</button>
    <button data-act="present" title="Present mode (E)">${IC.play}<span>Present</span></button>
    <button data-act="help" title="Help and shortcuts (?)">?</button>
  </div>
  <div class="fmt">
    <div class="grp">
      <button class="dd block" data-menu="block" title="Paragraph style"><span class="lbl">Body</span><i>▾</i></button>
      <button class="dd size" data-menu="size" title="Font size (⌘⇧. ⌘⇧,)"><span class="lbl">40</span><i>▾</i></button>
      <button class="dd color" data-menu="color" title="Text color"><span class="colorA">A</span><i>▾</i></button>
    </div>
    <div class="grp">
      <button data-fmt="bold" title="Bold (⌘B)"><b style="font-weight:800">B</b></button>
      <button data-fmt="italic" title="Italic (⌘I)"><i style="font:italic 600 15px Georgia,serif">I</i></button>
      <button data-fmt="strikeThrough" title="Strikethrough"><s style="font-weight:600">S</s></button>
    </div>
    <div class="grp">
      <button class="dd ic g-align" data-menu="align" title="Align"><span class="face">${IC.alignL}</span><i>▾</i></button>
      <button class="dd ic g-list" data-menu="list" title="List: bulleted, numbered"><span class="face">${IC.ul}</span><i>▾</i></button>
    </div>
    <div class="grp g-table">
      <button class="dd txt" data-menu="row" title="Add or delete rows">Row<i>▾</i></button>
      <button class="dd txt" data-menu="col" title="Add or delete columns">Column<i>▾</i></button>
      <button class="txt" data-fmt="table-del" title="Delete the whole table">Delete table</button>
    </div>
    <div class="grp">
      <button data-fmt="link" title="Link (⌘K)">${IC.link}</button>
      <button data-fmt="math" title="Insert an equation (TeX)"><span class="glyph">∑</span></button>
      <button data-menu="more" title="Code, quote, clear formatting, remove link">${IC.dots}</button>
    </div>
  </div>
  <div class="fmt otb">
    <div class="grp g-arrange"><button class="dd txt" data-menu="arrange" title="Center on the slide, or align several to each other">Align<i>▾</i></button></div>
    <div class="grp g-fill"><button class="dd color" data-menu="fill" title="Color"><span class="swatch"></span><i>▾</i></button></div>
    <div class="grp g-tbl"><button class="dd txt" data-menu="trow" title="Add or delete rows">Row<i>▾</i></button><button class="dd txt" data-menu="tcol" title="Add or delete columns">Column<i>▾</i></button></div>
    <div class="grp g-tcell"><button class="dd ic" data-menu="talign" title="Align all cells"><span class="face">${IC.alignL}</span><i>▾</i></button><button data-obj="tbold" title="Bold all cells"><b style="font-weight:800">B</b></button><button class="dd color" data-menu="tcolor" title="Text color for all cells"><span class="colorA">A</span><i>▾</i></button></div>
    <div class="grp g-img"><button data-obj="image" title="Replace with another image">Replace image</button></div>
    <div class="grp g-tex"><button data-obj="tex" title="Edit the TeX equation (or double-click it)">Edit equation</button></div>
    <div class="grp g-size">
      <button data-obj="smaller" title="Smaller (⌘⇧,)">−</button><span class="szl"></span><button data-obj="bigger" title="Bigger (⌘⇧.)">＋</button>
    </div>
    <div class="grp">
      <button data-obj="dup" title="Duplicate (⌘D)">Duplicate</button>
      <button data-obj="del" title="Delete (Delete)">Delete</button>
    </div>
    <div class="grp g-more"><button data-menu="objmore" title="Order and rotation: bring to front, send to back, rotate 15°">${IC.dots}</button></div>
  </div>
  <div class="menu"></div>
  <div class="pop"><div class="msg"></div><div class="acts"></div></div>
  <div class="cellmark"></div>
  <div class="hover"></div>
  <div class="selms"></div>
  <div class="selg"><span class="gtag"></span><div class="resize gres" title="Drag to resize everything selected proportionally"></div></div>
  <div class="sizebadge"></div>
  <div class="marquee"></div>
  <div class="guide gx"></div><div class="guide gy"></div>
  <div class="sel"><div class="grip" title="Drag to move">✥</div><div class="resize" title="Drag to resize"></div><div class="edge rw" title="Drag to change the width"></div><div class="edge rh" title="Drag to change the height"></div><div class="endpt tail" title="Drag to move this end (Shift: 15° steps)"></div><div class="endpt head" title="Drag to move this end (Shift: 15° steps)"></div><div class="tag"></div></div>
  <div class="banner"><span class="msg">The AI also edited the same slide. Which version do you want to keep?</span>
    <button data-act="keep" title="Keep that slide as you edited it. The AI's edits to other slides stay in">Keep mine</button><button data-act="reload" title="Replace just that slide with the AI's version. Your edits to other slides stay">Use AI's</button></div>
  <div class="toast"></div>
  <div class="hint">E edit · F full screen · ? shortcuts</div>
  <div class="pcount"></div>
  <div class="help"><div class="card">
    <h3>Present mode</h3>
    <table>
      <tr><td>→ Space PageDown · click</td><td>Next slide</td></tr>
      <tr><td>← PageUp · Shift-click</td><td>Previous slide</td></tr>
      <tr><td>F</td><td>Full screen</td></tr>
      <tr><td>E</td><td>Edit mode</td></tr>
      <tr><td>Esc</td><td>Back to editing, if you started presenting from the editor (the Present button starts in full screen)</td></tr>
      <tr><td>⌘P</td><td>Save as PDF (one slide per page)</td></tr>
    </table>
    <h3>Edit mode: adding (top bar)</h3>
    <table>
      <tr><td>New slide · ▾</td><td>Add a title + list slide · Blank slide, duplicate, delete. The ＋ at the bottom of the slide list works too</td></tr>
      <tr><td>Text · ▾</td><td>Text box · Title, bulleted list</td></tr>
      <tr><td>Table · ▾</td><td>3 × 3 table · pick a size</td></tr>
      <tr><td>Image · Shape · Arrow · Equation</td><td>One click inserts it, in a free spot</td></tr>
    </table>
    <h3>Edit mode: editing</h3>
    <table>
      <tr><td>Click text</td><td>Edit in place (Esc to finish). Clicking the empty space right of a line types at its end; a triple-click selects the paragraph. Titles, paragraphs and lists in the slide's flow, and boxes holding only text, are edited together: drag across lines to delete or replace them at once. Links don't open while editing</td></tr>
      <tr><td>Type on selected text</td><td>With a title, paragraph, list or text box selected, typing continues at its end (IME input too)</td></tr>
      <tr><td>Enter · Shift+Enter</td><td>New paragraph or item · line break in the same paragraph (in titles, text boxes and cells, Enter is a line break too). Enter on an empty last item ends the list. Enter with several paragraphs selected deletes only the selected text and keeps the paragraphs around it</td></tr>
      <tr><td>Home · End (Shift)</td><td>Start · end of the caret's line (Shift: select within that line). With nothing selected, first · last slide</td></tr>
      <tr><td>Backspace at the start of a paragraph</td><td>Merge with the previous paragraph or item (at the start of a sub-item, outdent one level)</td></tr>
      <tr><td>Tab · Shift+Tab in a list</td><td>Indent · outdent a bullet. Indent · Outdent under List ▾ work too</td></tr>
      <tr><td>Paste several lines</td><td>Lists and paragraphs get an item or paragraph per line; titles, text boxes and cells get line breaks</td></tr>
      <tr><td>Toolbar over text</td><td>Paragraph style, size, color, bold, align, list, link (⌘K), equation (∑). Code, quote and clear formatting under ⋯. Applies to the selected text, or else to the whole paragraph (code with no selection applies to what you type next). Enter in a code block is a line break</td></tr>
      <tr><td>Tab · Shift+Tab in a cell</td><td>Next · previous cell (Tab in the last cell adds a row). ↑↓ move to the cell above or below</td></tr>
      <tr><td>Toolbar over a cell</td><td>Row ▾ · Column ▾ add and delete, Delete table removes the table. Align this column under Column ▾. Cells are edited one at a time</td></tr>
      <tr><td>Whole table selected (Esc from a cell)</td><td>Row ▾ · Column ▾, plus align, bold and text color for all cells at once. Column widths follow the text</td></tr>
      <tr><td>Paste into a table</td><td>Cells from Excel, Google Sheets or tab-separated text fill cell by cell (adding rows and columns if needed). Pasted with nothing selected, they make a new table</td></tr>
      <tr><td>Toolbar on a shape or image</td><td>Color (No fill keeps just the outline), Duplicate, Delete. Bring to front/back and rotate under ⋯. An image with a caption gets Replace image</td></tr>
      <tr><td>Text in a shape</td><td>Double-click the shape, or select it and press Enter or start typing (IME input too, at the end of the last line). Several lines are edited together. The text stays centered and moves with the shape; emptied, it goes away</td></tr>
      <tr><td>⌘C · ⌘X · ⌘V</td><td>Copy · cut · paste the selection (several things too). On another slide it lands in the same spot (nudged a little on the same slide). Text pasted with nothing selected becomes a new text box. While editing text, the selected text is copied as is, equations included</td></tr>
      <tr><td>Click, then drag an image or box</td><td>Move (text and tables move by the ✥ handle). Hovering outlines what a click would grab</td></tr>
      <tr><td>Drag on empty space</td><td>Select everything it touches (previewed before you let go)</td></tr>
      <tr><td>Shift·⌘-click</td><td>Add to or remove from the selection</td></tr>
      <tr><td>⌘A</td><td>Select everything on the slide (while editing text, all the text in that box)</td></tr>
      <tr><td>With several selected</td><td>Drag together · arrow keys · Delete · ⌘D. Align ▾ in the toolbar lines them up left, center, right, top or bottom</td></tr>
      <tr><td>Alt+↑ · Alt+↓</td><td>Move a paragraph or item up or down (while editing text). A selected object swaps places with its neighbor</td></tr>
      <tr><td>Bottom-right handle</td><td>Resize proportionally. Equations, text and tables scale their text too, images keep their ratio, shapes resize freely (Shift: keep ratio). The size shows while dragging</td></tr>
      <tr><td>Pink lines while moving</td><td>Snaps to the slide's center and margins and to other objects' edges and centers, and shows a line. Hold ⌘ while moving to turn snapping off</td></tr>
      <tr><td>Align ▾ › Relative to slide</td><td>Center the selection (several things as one piece) horizontally, vertically or on the slide</td></tr>
      <tr><td>Right · bottom handles</td><td>Width only · height only (height for shapes only; text rewraps as its width changes, up to the slide's right margin)</td></tr>
      <tr><td>Dots at the ends of a line or arrow</td><td>Drag one end; the other stays put, so the direction and length change (Shift: 15° steps)</td></tr>
      <tr><td>− number ＋ in the toolbar</td><td>10% smaller · bigger, each in place (text changes only its letters, the box keeps its width). The number is the font size, the width (images, shapes) or Size (groups). ⌘⇧. · ⌘⇧, work too</td></tr>
      <tr><td>Group corner with several selected</td><td>Resize them all proportionally, keeping the layout</td></tr>
      <tr><td>Esc · ⤴ on the selection chip</td><td>Up one level: finish editing text → select the whole enclosing group (from a cell straight to the whole table, from a list item to the whole list). Esc clears a multiple selection</td></tr>
      <tr><td>Delete · ⌘D</td><td>Delete · duplicate the selection</td></tr>
      <tr><td>Arrow keys</td><td>Move 1px (Shift: 10px). With nothing selected, change slides</td></tr>
      <tr><td>⌘⇧. · ⌘⇧,</td><td>Bigger · smaller text</td></tr>
      <tr><td>Double-click an image · drop a file · ⌘V</td><td>Replace · add an image. It fills an empty figure (one with only its caption left) if there is one, else a free spot, at a size that fits</td></tr>
      <tr><td>Double-click an equation</td><td>Edit its TeX</td></tr>
      <tr><td>Thumbnails on the left</td><td>Drag to reorder. Click one, then Delete · ⌘D to delete · duplicate the slide. Right-click: Duplicate, Delete, Move up, Move down</td></tr>
      <tr><td>⌘Z · ⌘⇧Z</td><td>Undo · redo. If you were typing, you keep typing in the same spot. If another slide changes, it goes to that slide. The AI's edits are never undone</td></tr>
      <tr><td>⌘S</td><td>Save (the first time, pick the folder this file is in)</td></tr>
      <tr><td>When the AI edits the file</td><td>Only the changed slides update, right away (their thumbnails flash). A note says what it edited, added, moved or deleted. Text you are typing carries on. If the AI edits a slide you moved, or you edit one it moved, both changes stay</td></tr>
      <tr><td>When you and the AI edit the same slide</td><td>The banner at the top names the slide (its thumbnail gets a yellow border), and says so if only the speaker notes differ. Keep mine · Use AI's apply to that slide only; everything else is already merged. After Use AI's, ⌘Z brings yours back</td></tr>
      <tr><td>E</td><td>Present mode (when nothing is selected; the Present button always works, in full screen). Esc while presenting comes back to editing</td></tr>
    </table>
  </div></div>
</div>
<input type="file" accept="image/*" hidden>`;
    document.body.appendChild(host);
    fileInput = $('input[type=file]');

    sidebar = document.createElement('div');
    sidebar.id = 'dk-sidebar';
    sidebar.setAttribute(RT, '');
    document.body.appendChild(sidebar);

    const bar = $('.bar');
    // Keep focus (and the caret) in the slide while clicking toolbar buttons.
    bar.addEventListener('mousedown', e => e.preventDefault());
    for (const el of [...shadow.querySelectorAll('.fmt'), $('.menu'), $('.tag'), $('.pop')]) {
      // Keep the caret and text selection in the slide while using the text toolbar.
      el.addEventListener('mousedown', e => e.preventDefault());
      el.addEventListener('pointerdown', e => e.stopPropagation());
    }
    // One listener for every control in the editor chrome.
    shadow.addEventListener('click', e => {
      const b = e.target.closest('button');
      if (!b) return;
      if (b.dataset.menu) return openMenu(b.dataset.menu, b);
      if (b.dataset.toggle) return toggleOption(b);
      if (b.dataset.pop) return popAction(b.dataset.pop);
      if (b.dataset.kind) { closeMenu(); return menuPick(b.dataset.kind, b.dataset.val); }
      closeMenu();
      b.blur();
      if (b.dataset.fmt) return fmt(b.dataset.fmt, b.dataset.val);
      if (b.dataset.obj) return objAction(b.dataset.obj);
      if (b.dataset.act) return action(b.dataset.act, b);
    });
    // The table size picker highlights the range under the pointer.
    $('.menu').addEventListener('mouseover', e => {
      const c = e.target.closest('.tgrid button');
      if (c) markTableGrid(c.dataset.val);
    });
    document.addEventListener('selectionchange', () => { if (editing) { clampRunSelection(); refreshFmt(); } });
    $('.help').addEventListener('click', e => { if (e.target === $('.help')) toggleHelp(false); });
    $('.grip').addEventListener('pointerdown', e => {
      if (!selected) return;
      e.preventDefault(); e.stopPropagation();
      drag(e, selected, 'move');
    });
    for (const [cls, kind] of [['.sel .resize', 'resize'], ['.rw', 'resize-w'], ['.rh', 'resize-h']]) {
      $(cls).addEventListener('pointerdown', e => {
        if (!selected) return;
        e.preventDefault(); e.stopPropagation();
        const k = sizeKind(selected);
        // The corner scales in proportion (text and formulas with their letters); shapes stretch freely unless Shift.
        if (kind === 'resize' && k !== 'line' && !(k === 'shape' && !e.shiftKey)) scaleDrag(e, [selected]);
        else drag(e, selected, kind);
      });
    }
    for (const end of ['tail', 'head']) {
      $('.endpt.' + end).addEventListener('pointerdown', e => {
        if (!selected) return;
        e.preventDefault(); e.stopPropagation();
        lineDrag(e, selected, end);
      });
    }
    $('.gres').addEventListener('pointerdown', e => {
      if (sel.length < 2) return;
      e.preventDefault(); e.stopPropagation();
      scaleDrag(e, sel.slice());
    });
    fileInput.addEventListener('change', async () => {
      const f = fileInput.files[0];
      fileInput.value = '';
      if (f) await placeImage(f, pendingImageTarget);
      pendingImageTarget = null;
    });
  }

  let toastTimer = 0;
  function toast(msg, ms = 2600) {
    const t = $('.toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), ms);
    toastClear();
    requestAnimationFrame(toastClear);
  }
  // The toast goes to the top of the window while a floating toolbar sits where it would show at the bottom.
  // With the conflict banner up, a toast at the top goes below it, never over its buttons.
  function toastClear() {
    const t = shadow && $('.toast');
    if (!t || !t.classList.contains('show')) return;
    t.classList.remove('up');
    t.style.top = '';
    const r = t.getBoundingClientRect();
    if (![...shadow.querySelectorAll('.fmt.show')].some(b => overlapArea(r, b.getBoundingClientRect()) > 0)) return;
    t.classList.add('up');
    const bn = $('.banner');
    if (bn.classList.contains('show')) t.style.top = Math.round(bn.getBoundingClientRect().bottom + 8) + 'px';
  }
  function pulseBanner() {
    const bn = $('.banner');
    bn.classList.remove('pulse');
    void bn.offsetWidth;
    bn.classList.add('pulse');
    setTimeout(() => bn.classList.remove('pulse'), 1000);
  }
  function hideToast() { if (shadow) { clearTimeout(toastTimer); $('.toast').classList.remove('show'); } }
  function toggleHelp(force) { $('.help').classList.toggle('show', force); }

  // ---------- layout & navigation ----------
  function layout() {
    const aw = mode === 'edit' ? innerWidth - SIDEBAR - 64 : innerWidth;
    const ah = mode === 'edit' ? innerHeight - TOOLBAR - 64 : innerHeight;
    scale = Math.max(0.05, Math.min(aw / W, ah / H));
    varStyle.textContent = `:root{--dk-scale:${scale}}`;
  }

  // A slide with no background of its own would show our dark backdrop; give it the page's background instead.
  function fixBackgrounds() {
    for (const el of slides()) {
      el.classList.remove('dk-bgfix');
      const cs = getComputedStyle(el);
      if (/rgba\(.*,\s*0\)$|^transparent$/.test(cs.backgroundColor) && cs.backgroundImage === 'none') el.classList.add('dk-bgfix');
    }
  }
  function go(i) {
    const s = slides();
    if (!s.length) return;
    i = Math.max(0, Math.min(s.length - 1, i | 0));
    if (s[cur] !== s[i]) { stopEditing(); select(null); }
    s.forEach((el, k) => el.classList.toggle('dk-current', k === i));
    cur = i;
    fitMaths(s[i]);
    renderWidgetMath(s[i]);
    if (location.hash !== '#' + (i + 1)) history.replaceState(null, '', '#' + (i + 1));
    $('.count').textContent = `${i + 1} / ${s.length}`;
    const pc = $('.pcount');
    pc.textContent = `${i + 1} / ${s.length}`;
    markThumb();
  }

  // Presenting hides an idle mouse pointer; nothing else may leave it hidden.
  let idleTimer = 0;
  function showCursor() {
    clearTimeout(idleTimer);
    html.classList.remove('dk-hide-cursor');
  }

  // Presenting started from the editor (the Present button or E): Esc, or leaving full screen with Esc, comes back.
  let fromEditor = false, fsByKeyAt = 0;
  function presentFromEditor(full) {
    setMode('present');
    fromEditor = true;
    if (full && !document.fullscreenElement && html.requestFullscreen) {
      try { const p = html.requestFullscreen(); if (p && p.catch) p.catch(() => {}); } catch (_) {}
    }
    showHint('Click · → next · Esc to edit');
  }
  // The pill at the bottom while presenting. Never in automated or headless runs, where it would sit in screenshots.
  const automated = () => navigator.webdriver || /HeadlessChrome/.test(navigator.userAgent);
  let hintTimer = 0;
  function showHint(text) {
    if (!shadow || automated()) return;
    const hint = $('.hint');
    if (text) hint.textContent = text;
    hint.classList.add('show');
    clearTimeout(hintTimer);
    hintTimer = setTimeout(() => hint.classList.remove('show'), 2600);
  }
  function setMode(m) {
    if (m === mode) return;
    fromEditor = false;
    if (mode === 'edit') { stopEditing(); select(null); commit(); closeMenu(); closePop(); }
    showCursor();
    $('.pcount').classList.remove('show');
    $('.hint').classList.remove('show');
    mode = m;
    html.classList.toggle('dk-edit', m === 'edit');
    $('.root').classList.toggle('edit', m === 'edit');
    try { sessionStorage.setItem(STATE_KEY, JSON.stringify({ mode })); } catch (_) {}
    layout();
    if (m === 'edit') {
      // A field or button on a slide that had the focus while presenting lets go of it: keys now edit the deck.
      const a = document.activeElement;
      if (a && a !== document.body && deck.contains(a)) a.blur();
      buildThumbs();
      updateStatus();
      if (dir && !dirOK) ensureDir(true, { pick: false });   // E is a user gesture: re-grant folder access now
    }
  }

  // ---------- thumbnails ----------
  let dragFrom = -1;
  function buildThumbs() {
    clearTimeout(thumbTimer);
    fixBackgrounds();
    if (mode !== 'edit') return;
    const top = sidebar.scrollTop;
    sidebar.textContent = '';
    slides().forEach((s, i) => {
      const t = document.createElement('div');
      t.className = 'dk-thumb' + (conflictMarks.includes(i) ? ' dk-conflict' : '');
      t.draggable = true;
      t.dataset.i = i;
      const num = document.createElement('span');
      num.className = 'dk-thumb-num';
      num.textContent = i + 1;
      const frame = document.createElement('div');
      frame.className = 'dk-thumb-frame';
      const inner = document.createElement('div');
      inner.className = 'deck dk-thumb-scale';
      const c = resetLive(s.cloneNode(true));
      c.classList.remove('dk-current');
      c.removeAttribute('contenteditable');
      c.querySelectorAll('[contenteditable]').forEach(e => e.removeAttribute('contenteditable'));
      c.setAttribute('inert', '');
      inner.appendChild(c);
      frame.appendChild(inner);
      t.append(num, frame);
      sidebar.appendChild(t);
    });
    const add = document.createElement('div');
    add.className = 'dk-add-slide';
    add.title = 'Add a new slide (title + list) at the end';
    add.textContent = '＋ New slide';
    sidebar.appendChild(add);
    sidebar.scrollTop = top;
    markThumb();
  }
  function scheduleThumbs() { clearTimeout(thumbTimer); thumbTimer = setTimeout(buildThumbs, 250); }
  function markThumb() {
    if (!sidebar) return;
    sidebar.querySelectorAll('.dk-thumb').forEach((t, k) => t.classList.toggle('dk-active', k === cur));
    const a = sidebar.querySelector('.dk-thumb.dk-active');
    if (a && mode === 'edit') {
      const r = a.getBoundingClientRect(), sr = sidebar.getBoundingClientRect();
      if (r.top < sr.top || r.bottom > sr.bottom) a.scrollIntoView({ block: 'nearest' });
    }
  }
  function bindSidebar() {
    sidebar.addEventListener('click', e => {
      if (e.target.closest('.dk-add-slide')) return newSlide('new', true);
      const t = e.target.closest('.dk-thumb');
      // A thumbnail click puts the keys on the slide list: nothing on the slide stays selected.
      if (t) { stopEditing(); select(null); go(+t.dataset.i); }
    });
    // Right-click on a thumbnail: Duplicate, Delete, Move up, Move down.
    sidebar.addEventListener('contextmenu', e => {
      const t = e.target.closest('.dk-thumb');
      if (!t || mode !== 'edit') return;
      e.preventDefault();
      navFocus = true;
      stopEditing();
      select(null);
      go(+t.dataset.i);
      openThumbMenu(+t.dataset.i, e.clientX, e.clientY);
    });
    sidebar.addEventListener('dragstart', e => {
      const t = e.target.closest('.dk-thumb');
      if (!t) return;
      closeMenu();
      t.classList.add('dk-dragsrc');
      dragFrom = +t.dataset.i;
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', String(dragFrom));
    });
    const clearMarks = () => sidebar.querySelectorAll('.dk-drop-before,.dk-drop-after')
      .forEach(t => t.classList.remove('dk-drop-before', 'dk-drop-after'));
    sidebar.addEventListener('dragover', e => {
      if (dragFrom < 0) return;
      const t = e.target.closest('.dk-thumb');
      if (!t) return;
      e.preventDefault();
      clearMarks();
      const r = t.getBoundingClientRect();
      t.classList.add(e.clientY < r.top + r.height / 2 ? 'dk-drop-before' : 'dk-drop-after');
    });
    sidebar.addEventListener('dragleave', e => { if (!sidebar.contains(e.relatedTarget)) clearMarks(); });
    sidebar.addEventListener('drop', e => {
      const t = e.target.closest('.dk-thumb');
      if (dragFrom < 0 || !t) return;
      e.preventDefault();
      const before = t.classList.contains('dk-drop-before');
      clearMarks();
      moveSlide(dragFrom, +t.dataset.i + (before ? 0 : 1));
      dragFrom = -1;
    });
    sidebar.addEventListener('dragend', () => { dragFrom = -1; clearMarks(); sidebar.querySelectorAll('.dk-dragsrc').forEach(t => t.classList.remove('dk-dragsrc')); });
  }
  function moveSlide(from, to) {
    const s = slides();
    if (from === to || from + 1 === to) return;
    const el = s[from];
    const ref = s[to] || null;
    if (ref) deck.insertBefore(el, ref);
    else s[s.length - 1].after(el);
    commit();
    go(slides().indexOf(el));
    buildThumbs();
  }

  // ---------- history ----------
  function commit() {
    clearTimeout(commitTimer);
    commitTimer = 0;
    if (editing && editMulti && !isList(editing) && !composing) tidyGaps(editing);
    const h = deckHTML();
    fitMaths(curSlide());   // a resized or retyped formula fits its box again
    if (h === hist[hi]) { updateStatus(); return; }
    hist.splice(hi + 1);
    hist.push(h);
    scheduleAutosave();
    labelResume = null;
    if (hist.length > 300) hist.shift();
    hi = hist.length - 1;
    chipKey = '';
    updateTitle();
    updateStatus();
    scheduleThumbs();
  }
  function scheduleCommit() { clearTimeout(commitTimer); commitTimer = setTimeout(commit, 450); }
  function restore(h) {
    editing = null;
    editRun = editMulti = false;
    chipKey = '';
    selected = null;
    sel = [];
    const old = slides().map(s => ({ s: tidySvg(cleanClone(s).outerHTML), o: origins.get(s) }));
    const t = document.createElement('template');
    t.innerHTML = h;
    deck.replaceChildren(stampLive(t.content));
    const now = slides();
    matchSlides(old.map(x => x.s), slideList(h)).forEach((j, i) => { if (j >= 0 && old[i].o && now[j]) origins.set(now[j], old[i].o); });
    renderMath();
    go(cur);
    updateCrumbs();
    updateTitle();
    updateStatus();
    buildThumbs();
  }
  function undo() { step(-1); }
  function redo() { step(1); }
  // Undo/redo while typing keeps typing: the caret goes back into the same paragraph or bullet (by its place on the
  // slide), and what was selected stays selected.
  // What was typed so far becomes a step of its own exactly as typed; the editor's own clean-up (an empty bullet
  // dropped, a line break at the end trimmed) is never a step. A slide that comes back and is not being typed in
  // is shown (and saved) without such leftovers.
  let stepAt = 0;
  function step(d) {
    hideToast();
    let keep = rememberPlace();
    if (labelResume && keep && keep.sel && keep.sel.length === 1 && labelResume.slide === keep.slide && String(keep.sel[0]) === String(labelResume.shape)) keep = labelResume;
    commit();
    stepAt = Date.now();
    let to = hi + d;
    // Not typing: a step that would only bring back what the clean-up took away shows nothing new; it is dropped.
    if (!editing) while (to >= 0 && to < hist.length && settledHTML(hist[to], hist[hi]) === hist[hi]) {
      hist.splice(to, 1);
      if (d < 0) { hi--; to--; }
    }
    if (to < 0 || to >= hist.length) { updateStatus(); return; }
    const was = hist[hi];
    dropEditing();
    hi = to;
    restore(hist[hi]);
    showChanged(was, hist[hi]);
    returnTo(keep);
    settleSlides(was);
  }
  // Leftovers of typing that nobody wrote and that show nothing: empty bullets, placeholder line breaks at the end of
  // a line, the zero-width space after a formula.
  // `kept(el)`: a block written that way in the file (see asFiled), never cleaned.
  function tidyLeftovers(root, kept = () => false) {
    dropBlankBullets(root, kept);
    if (!root.parentNode) return;
    for (const b of [root, ...root.querySelectorAll('li, p, h1, h2, h3, h4, h5, h6, blockquote, pre, td, th, figcaption')]) if (!kept(b)) trimTrailingBreaks(b);
    for (const li of [root, ...root.querySelectorAll('li')]) {
      // A placeholder line break right before a bullet's sub-list, after its own text.
      if (li.tagName !== 'LI' || kept(li)) continue;
      const sub = [...li.children].find(isList);
      let n = sub && sub.previousSibling;
      while (n && isSpace(n)) n = n.previousSibling;
      if (n && n.nodeName === 'BR' && n.previousSibling) n.remove();
    }
    stripZeroWidth(root);
  }
  // The slides and blocks exactly as the file has them (as loaded, or as last seen on disk, the AI's edits included).
  // Typing leftovers are cleaned only from what is not one of these: an AI's deliberate <br> at the end of a line or
  // empty bullet stays as written, and a slide that undo brings back is byte for byte what it was.
  let formsOf = [null, null], formSlides = new Set(), formBlocks = new Set();
  const FORM_BLOCKS = 'ul, ol, li, p, h1, h2, h3, h4, h5, h6, blockquote, pre, td, th, figcaption';
  function fileForms() {
    if (formsOf[0] !== hist[0] || formsOf[1] !== baseline) {
      formsOf = [hist[0], baseline];
      formSlides = new Set();
      formBlocks = new Set();
      for (const src of formsOf) for (const s of src ? slideList(src) : []) {
        if (formSlides.has(s)) continue;
        formSlides.add(s);
        const t = document.createElement('template');
        t.innerHTML = s;
        t.content.querySelectorAll(FORM_BLOCKS).forEach(e => formBlocks.add(tidySvg(e.outerHTML)));
      }
      settledCache.clear();
    }
    return formSlides;
  }
  const asFiled = el => { fileForms(); return formBlocks.has(tidySvg(cleanClone(el).outerHTML)); };
  // A history state as it shows once nobody types in it: the slides that differ from `ref` without leftovers.
  const settledCache = new Map();
  function settledHTML(h, ref) {
    const forms = fileForms();
    const key = hashText(h) + ' ' + hashText(ref);
    if (settledCache.has(key)) return settledCache.get(key);
    const t = document.createElement('template');
    t.innerHTML = h;
    const A = slideList(h), R = slideList(ref);
    [...t.content.children].filter(e => e.classList.contains('slide')).forEach((s, k) => { if (A[k] !== R[k] && !forms.has(A[k])) tidyLeftovers(s, asFiled); });
    const out = tidySvg(t.innerHTML);
    if (settledCache.size > 60) settledCache.clear();
    settledCache.set(key, out);
    return out;
  }
  // After undo/redo: the slides that changed lose their typing leftovers, except where the caret is now.
  function settleSlides(was) {
    const before = slideList(was), now = slides(), forms = fileForms();
    let changed = false;
    now.forEach((s, k) => {
      const ser = tidySvg(cleanClone(s).outerHTML);
      if (forms.has(ser)) return;
      if (editing && (s === editing || s.contains(editing))) {
        if (s === editing) return;
        // Only the text being edited keeps them; the rest of its slide is settled.
        for (const c of [...s.children]) if (!c.contains(editing) && !c.hasAttribute(RT)) { const x = c.outerHTML; tidyLeftovers(c, asFiled); if (c.isConnected && c.outerHTML === x) continue; changed = true; }
        return;
      }
      if (ser === before[k]) return;
      tidyLeftovers(s, asFiled);
      if (tidySvg(cleanClone(s).outerHTML) !== ser) changed = true;
    });
    if (!changed) return;
    // What was selected may have been only leftovers (a list of empty bullets).
    if (sel.some(x => !x.isConnected)) setSel(sel.filter(x => x.isConnected));
    hist[hi] = deckHTML();
    // A step that now looks exactly like its neighbour is no step at all.
    if (hi > 0 && hist[hi - 1] === hist[hi]) { hist.splice(hi, 1); hi--; }
    if (hi < hist.length - 1 && hist[hi + 1] === hist[hi]) hist.splice(hi + 1, 1);
    scheduleThumbs();
    updateStatus();
    drawSel();
  }
  // Where an element sits on its slide: child indexes from the slide down (runtime elements not counted).
  const realKids = el => [...el.children].filter(c => !c.hasAttribute(RT));
  function pathOf(el) {
    const s = curSlide(), out = [];
    for (let e = el; e && e !== s; e = e.parentElement) {
      if (!e.parentElement || !s || !s.contains(e)) return null;
      out.unshift(realKids(e.parentElement).indexOf(e));
    }
    return out;
  }
  function atPath(p) {
    let e = curSlide();
    for (const i of p || []) { e = e && realKids(e)[i]; if (!e) return null; }
    return e === curSlide() ? null : e;
  }
  function rememberPlace() {
    if (mode !== 'edit') return null;
    if (editing) {
      const b = editing.classList.contains('math') ? editing : curBlock() || editing;
      const p = pathOf(b), sh = labelShape(b);
      return p && { slide: cur, edit: p, off: caretOffset(b), text: b.textContent, tag: b.tagName, math: b.classList.contains('math'), shape: sh ? pathOf(sh) : null };
    }
    const ps = sel.map(pathOf).filter(Boolean);
    return ps.length ? { slide: cur, sel: ps } : null;
  }
  // A shape whose text went away with undo is selected; redo then brings typing back into its text (labelResume).
  let labelResume = null;
  function returnTo(keep) {
    if (!keep || keep.slide !== cur || mode !== 'edit') return;
    if (keep.edit) {
      const r = resumable(keep);
      if (!r) {
        const sh = keep.shape && atPath(keep.shape);
        if (sh && isBoxShape(sh)) { select(sh); labelResume = keep; return; }
        // Never left typing into nothing: the nearest thing that is still there is selected.
        if (!sel.length) for (let n = keep.edit.length; n > 0 && !sel.length; n--) { const e = atPath(keep.edit.slice(0, n)); if (e) select(frameOf(e)); }
        return;
      }
      labelResume = null;
      const b = r.el;
      const math = b.classList.contains('math');
      select(math ? b : textFrame(b));
      startEditing(b);
      // The caret goes where the text changed (the end of what came back or went), else where it was.
      // (A space and a non-breaking space are the same here: the browser swaps one for the other as you type.)
      const t = b.textContent.replace(/\u00a0/g, ' '), kt = keep.text.replace(/\u00a0/g, ' ');
      let off = r.end ? t.length : Math.min(keep.off, t.length);
      if (!r.end && t !== kt) {
        let i = 0, j = 0;
        while (i < t.length && i < kt.length && t[i] === kt[i]) i++;
        while (j < t.length - i && j < kt.length - i && t[t.length - 1 - j] === kt[kt.length - 1 - j]) j++;
        off = t.length - j;
      }
      restoreCaret(b, off);
      drawSel();
      return;
    }
    setSel(keep.sel.map(atPath).filter(Boolean));
  }
  // Where typing goes on after undo/redo: the block at the remembered place, climbed from an inline element (a <b>,
  // a link, a line break) to the paragraph, heading or bullet holding it, and of the same kind (a formula only for a
  // formula, text only for text). Something else there now (a display formula where a paragraph was) is selected,
  // never typed into. A bullet or paragraph that went away hands the caret to the end of the one before it.
  function resumable(keep) {
    let b = atPath(keep.edit), end = false;
    if (b && b.matches('aside.notes')) b = null;
    // The place was rebuilt (a bullet indented or a list made into paragraphs, then undone): the block with the
    // same text, of the same kind first. Something else that is there now (a formula) is selected instead, below.
    const norm = t => t.replace(/\u00a0/g, ' ').trim();
    const textish = x => !x.classList.contains('math') && !(x instanceof SVGElement) && !isMedia(x) && !!textHost(x);
    // Also when a block of the same kind is there but holds other text while one with the remembered text exists
    // (a list rebuilt twice): the caret follows the text, not the index.
    if (!keep.math && keep.text.trim() && (!b || (textish(b) && (b.tagName !== keep.tag || norm(b.textContent) !== norm(keep.text))))) {
      const same = [...curSlide().querySelectorAll('li, p, h1, h2, h3, h4, h5, h6, td, th, figcaption, blockquote, pre, dt, dd')]
        .filter(e => !e.closest('[' + RT + ']') && norm(e.textContent) === norm(keep.text));
      const pick = same.find(e => e.tagName === keep.tag) || same[0];
      if (pick) b = pick;
    }
    if (!b && keep.edit.length && keep.edit[keep.edit.length - 1] > 0 && !keep.math) {
      const p = keep.edit.slice();
      p[p.length - 1]--;
      b = atPath(p);
      end = !!b && b.tagName === keep.tag;
      if (!end) b = null;
    }
    if (!b) return null;
    const m = b.closest && b.closest('.math');
    if (m && curSlide().contains(m)) b = m;
    if (!b.classList.contains('math') && !keep.math) { const t = textHost(b); if (t) b = t; }
    const math = b.classList.contains('math');
    const text = !math && !(b instanceof SVGElement) && !isWrapper(b) && (textHost(b) === b || isTextFrame(b));
    if (math !== !!keep.math || (!math && !text)) { select(b); return null; }
    return { el: b, end };
  }
  // Undo and redo never change a slide out of sight: when the slide on screen stayed the same, go to the one that changed.
  function showChanged(before, after) {
    const A = slideList(before), B = slideList(after);
    if (A.length === B.length && A[cur] !== B[cur]) return;
    let k = 0;
    while (k < A.length && k < B.length && A[k] === B[k]) k++;
    if (k >= A.length && k >= B.length) return;
    if (A.length !== B.length && k === cur) return;
    go(Math.min(k, B.length - 1));
    flashThumb(cur);
  }
  function flashThumb(i) {
    const t = sidebar && sidebar.querySelectorAll('.dk-thumb')[i];
    if (!t) return;
    t.classList.remove('dk-flash');
    void t.offsetWidth;
    t.classList.add('dk-flash');
    setTimeout(() => t.classList.remove('dk-flash'), 900);
  }
  // While typing, a commit is pending; count that as unsaved rather than serializing on every keystroke.
  let dragging = false;
  // Saved: the history's state is what was written (or, saved while still typing, what was on screen then), or has
  // the same slides as the file.
  let savedLive = '';
  const isDirty = () => dragging || !!commitTimer || !(hist[hi] === saved || hist[hi] === savedLive || sameList2(slideList(hist[hi]), slideList(saved)));
  function setSaved(x, live = x) { saved = x; savedLive = live; }

  // ---------- selection & text editing ----------
  function crumbChain() {
    const slide = curSlide();
    const chain = [];
    for (let e = selected; e && e !== slide && slide && slide.contains(e); e = e.parentElement) if (!PASS_THROUGH.has(e.tagName)) chain.unshift(e);
    return chain;
  }
  function label(el) {
    const cls = [...el.classList].filter(c => !c.startsWith('dk-'))[0];
    return el.tagName.toLowerCase() + (cls ? '.' + cls : '');
  }
  // Names people use for things on a slide, instead of tag names.
  function friendly(el) {
    if (!el) return '';
    if (el.classList.contains('math')) return 'Equation';
    if (isLive(el)) return 'Interactive';
    if (el.classList.contains('shape')) return { line: 'Line', arrow: 'Arrow', circle: 'Circle' }[el.dataset.shape] || 'Shape';
    const names = { H1: 'Title', H2: 'Title', H3: 'Subtitle', H4: 'Subtitle', H5: 'Subtitle', H6: 'Subtitle', P: 'Text', LI: 'List item', UL: 'List',
      OL: 'Numbered list', IMG: 'Image', svg: 'Figure', SVG: 'Figure', FIGURE: 'Figure group', FIGCAPTION: 'Caption', TABLE: 'Table', TD: 'Cell',
      TH: 'Cell', TR: 'Row', BLOCKQUOTE: 'Quote', A: 'Link', CODE: 'Code', VIDEO: 'Video', PRE: 'Code', IFRAME: 'Embed' };
    return names[el.tagName] || (ownText(el) ? 'Text' : isTextColumn(el) ? 'Text block' : 'Group');
  }
  function parentOf(el) {
    let p = el && el.parentElement;
    while (p && PASS_THROUGH.has(p.tagName)) p = p.parentElement;
    return p && p !== curSlide() && curSlide() && curSlide().contains(p) ? p : null;
  }
  function updateCrumbs() {
    const t = $('.tag');
    if (!t) return;
    t.textContent = '';
    if (!selected) return;
    const name = document.createElement('span');
    name.textContent = chipName(selected);
    t.appendChild(name);
    const p = parentOf(selected);
    if (p) {
      const up = document.createElement('button');
      up.dataset.obj = 'up';
      up.title = 'Select the whole ' + friendly(p).toLowerCase() + ' around this (Esc)';
      up.textContent = '⤴ Select whole ' + friendly(p).toLowerCase();
      t.appendChild(up);
    }
  }
  // The chip names the selection; a table also says how big it is.
  function chipName(el) {
    if (el.tagName === 'TABLE' && el.rows.length) return `Table · ${el.rows.length} row${el.rows.length === 1 ? '' : 's'} × ${gridWidth(tableGrid(el))} col${gridWidth(tableGrid(el)) === 1 ? '' : 's'}`;
    return friendly(el);
  }
  // `sel` holds the selected frames in document order; `selected` is always sel[0] (a table, never one of its
  // cells; a list, never one bullet). `editing` is where the caret is; while editing, sel is [frameOf(editing)].
  const docOrder = list => [...new Set(list)].sort((a, b) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
  // Members must be on the current slide, connected, and never inside another member.
  function normalize(list) {
    const s = curSlide();
    const ok = docOrder(list.filter(x => x && x.isConnected && s && x !== s && s.contains(x)));
    return ok.filter(x => !ok.some(y => y !== x && y.contains(x)));
  }
  const sameList = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
  function setSel(list) {
    list = normalize(list.map(frameOf).filter(Boolean));
    if (sameList(list, sel)) return;
    if (editing && !(list.length === 1 && list[0] === editFrame())) stopEditing();
    sel = list;
    selected = sel[0] || null;
    updateCrumbs();
    if (shadow && $('.otb').classList.contains('show')) refreshObj();
    drawSel();
  }
  function select(el) { setSel(el ? [el] : []); }
  // Clicking text edits its host (a whole list, a whole text column, one cell, or the block itself).
  const knownSpans = new WeakSet();
  let editMulti = false, editRun = false, runFrame = null, tidyFrom = null, editSnap = new Map();
  function startEditing(el) {
    const target = el;
    if (!el.classList.contains('math')) el = hostOf(el);
    if (editing === el) return;
    stopEditing();
    editing = el;
    editRun = isSlide(el);
    editMulti = isList(el) || isTextColumn(el) || editRun || (isBoxShape(el) && !ownText(el));
    if (editRun) {
      const run = runOf(slideChild(target));
      for (const c of el.children) if (!run.includes(c) && !c.hasAttribute(RT)) c.setAttribute('contenteditable', 'false');
      runFrame = frameOf(slideChild(target));
    }
    selected = editRun ? runFrame : frameOf(el);
    sel = [selected];
    if (el.classList.contains('math')) {
      const tex = el.getAttribute('data-dk-tex');
      if (tex != null) { el.removeAttribute('data-dk-tex'); el.textContent = tex; }
      el.setAttribute('contenteditable', 'plaintext-only');
    } else {
      el.setAttribute('contenteditable', 'true');
      el.querySelectorAll('.math').forEach(m => m.setAttribute('contenteditable', 'false'));
      rememberSpans();
    }
    tidyFrom = editMulti ? el.innerHTML : null;   // the gaps between blocks are tidied only once something changed
    editSnap = el.classList.contains('math') ? new Map() : new Map(leafBlocks().map(b => [b, b.innerHTML]));
    updateCrumbs();
    drawSel();
  }
  // Styled spans that exist now are the author's; ones that appear later while typing are Chrome's leftovers.
  function rememberSpans() { if (editing) editing.querySelectorAll('span[style]').forEach(n => knownSpans.add(n)); }
  function stopEditing(save = true) {
    const el = editing;
    if (!el) return;
    if (editMulti && !isList(el) && !composing) tidyGaps(el);
    const roots = editRun ? runKids(el) : [el];
    const changed = el.classList.contains('math') ? [] : leafBlocks().filter(b => editSnap.get(b) !== b.innerHTML);
    editSnap = new Map();
    editing = null;
    editMulti = editRun = false;
    runFrame = null;
    afterComposition = null;
    el.removeAttribute('contenteditable');
    el.querySelectorAll('[contenteditable]').forEach(m => m.removeAttribute('contenteditable'));
    if (!el.classList.contains('math')) {
      for (const root of roots) if (root.isConnected) unwrapBlockCode(root);
      tidyEdited(changed);
      // A list left with no bullet at all (every one deleted) goes too, unless the file has it that way.
      for (const root of roots) for (const l of root.isConnected ? (isList(root) ? [root] : [...root.querySelectorAll('ul, ol')]) : []) if (l.isConnected && isBlank(l) && !asFiled(l)) removeWithSpace(l);
    }
    if (!composing) changed.forEach(b => { if (b.isConnected) plainSpaces(b); });
    // A formula whose TeX was deleted goes away, and so does a shape's text left empty.
    if (el.classList.contains('math') && el.isConnected && !el.textContent.trim()) removeWithSpace(el);
    const sh = isBoxShape(el) ? el : labelShape(el);
    if (sh && sh.isConnected) {
      for (const c of [...sh.children]) if (!c.hasAttribute(RT) && isBlank(c) && (c === el || el === sh)) removeWithSpace(c);
      if (!sh.textContent.trim()) {
        sh.style.removeProperty('color');
        if (sh.getAttribute('style') === '') sh.removeAttribute('style');
      }
    }
    if (sel.some(x => !x.isConnected)) { sel = sel.filter(x => x.isConnected); selected = sel[0] || null; updateCrumbs(); }
    if (el.classList.contains('math') && el.isConnected) renderMathEl(el);
    const s = getSelection();
    if (s && s.rangeCount && el.contains(s.anchorNode)) s.removeAllRanges();
    if (save) commit();
    drawSel();
  }
  // Editing ends with no clean-up and no undo step, because what comes next rebuilds this part of the page (an
  // undo or redo, a list made into paragraphs) and must see the text exactly as it was typed.
  function dropEditing() {
    const el = editing;
    if (!el) return;
    editSnap = new Map();
    editing = null;
    editMulti = editRun = false;
    runFrame = null;
    afterComposition = null;
    el.removeAttribute('contenteditable');
    el.querySelectorAll('[contenteditable]').forEach(m => m.removeAttribute('contenteditable'));
    if (el.classList.contains('math') && el.isConnected) renderMathEl(el);
    const s = getSelection();
    if (s && s.rangeCount && el.contains(s.anchorNode)) s.removeAllRanges();
  }
  // Only the blocks typed in (changed or new while editing) are cleaned: a block nobody touched keeps exactly what the
  // file has, an empty bullet or a <br> at the end of a line the AI wrote on purpose included.
  function tidyEdited(blocks) {
    for (const b of [...blocks].reverse()) {
      if (!b.parentNode) continue;
      if (b.tagName === 'LI' && isBlank(b) && !b.querySelector('li')) {
        let l = b.parentElement;
        removeWithSpace(b);
        while (l && isList(l) && l.parentNode && isBlank(l)) {
          const up = l.parentElement;
          removeWithSpace(l);
          l = null;
          if (up && up.tagName === 'LI' && isBlank(up) && !up.querySelector('li') && blocks.includes(up)) { l = up.parentElement; removeWithSpace(up); }
        }
        continue;
      }
      tidyText(b);
    }
  }
  // What editing leaves behind and nobody wrote: bullets with no text, placeholder line breaks at the end of a line,
  // the zero-width space after a formula, formatting wrapped around nothing (<b></b> after a delete).
  function tidyText(root) {
    tidyLeftovers(root);
    if (!root.parentNode) return;
    for (const w of [...root.querySelectorAll('b, i, s, u, strong, em, code, a, span, strike, font, sub, sup, mark')].reverse()) {
      if (w.textContent === '' && !w.classList.contains('math') && !w.closest('.math') && !w.querySelector('img, svg, video, canvas, iframe, br, .math')) w.remove();
    }
    tidyInline(root);
  }
  // What the browser's formatting leaves: <font face="monospace"> (typing next to code) becomes <code>, any other
  // <font> goes, and two neighbours of the same kind with the same attributes (a link split by Enter and joined
  // again by Backspace, two bold runs) become one.
  const MERGEABLE = /^(A|B|I|S|U|STRONG|EM|CODE|STRIKE|SUB|SUP|MARK)$/;
  function tidyInline(root) {
    for (const f of [...root.querySelectorAll('font')].reverse()) {
      if (!f.isConnected || f.closest('.math')) continue;
      if (/mono/i.test(f.getAttribute('face') || '') && !f.closest('code, pre')) {
        const c = document.createElement('code');
        while (f.firstChild) c.appendChild(f.firstChild);
        f.replaceWith(c);
      } else unwrap(f);
    }
    const sameAttrs = (a, b) => a.attributes.length === b.attributes.length && [...a.attributes].every(x => b.getAttribute(x.name) === x.value);
    for (const el of [...root.querySelectorAll('a, b, i, s, u, strong, em, code, strike, sub, sup, mark')]) {
      if (!el.isConnected || el.classList.contains('math')) continue;
      let n = el.nextSibling;
      while (n && n.nodeType === 3 && !n.data) { const x = n.nextSibling; n.remove(); n = x; }
      while (n && n.nodeType === 1 && n.tagName === el.tagName && MERGEABLE.test(n.tagName) && sameAttrs(el, n) && !n.classList.contains('math')) {
        const next = n.nextSibling;
        while (n.firstChild) el.appendChild(n.firstChild);
        n.remove();
        n = next;
      }
      el.normalize();
    }
  }
  // The blocks of the run being edited (the slide's children that are not marked contenteditable=false).
  function runKids(h = editing) {
    return h ? [...h.children].filter(c => !c.hasAttribute(RT) && c.getAttribute('contenteditable') !== 'false') : [];
  }
  // The frame being edited: the host's frame, or in a run the slide-level block holding the caret.
  function editFrame() {
    if (!editing) return null;
    if (!editRun) return frameOf(editing);
    const s = getSelection();
    if (s.rangeCount && editing.contains(s.anchorNode)) {
      const f = slideChild(curBlock());
      if (f && f.parentElement === editing && frameOf(f) !== runFrame) {
        // Typing in one block, then clicking into the next: the first block's typing is its own undo step.
        if (runFrame && commitTimer && !composing) commit();
        runFrame = frameOf(f);
      }
    }
    if (!runFrame || !runFrame.isConnected || runFrame.parentElement !== editing) runFrame = runKids()[0] || null;
    return runFrame;
  }
  // Is frame `f` (part of) the text being edited?
  const isEditedFrame = f => !!f && !!editing && (editRun ? f.parentElement === editing && runKids().includes(f) : frameOf(editing) === f || f.contains(editing));
  // In a run, a text selection never reaches past its first and last block onto the rest of the slide.
  function clampToRun(r) {
    const kids = editRun ? runKids() : [];
    if (!kids.length) return r;
    const c = r.cloneRange(), lo = document.createRange(), hi = document.createRange();
    lo.selectNodeContents(kids[0]);
    hi.selectNodeContents(kids[kids.length - 1]);
    if (c.compareBoundaryPoints(Range.START_TO_START, lo) < 0) c.setStart(lo.startContainer, lo.startOffset);
    if (c.compareBoundaryPoints(Range.END_TO_END, hi) > 0) c.setEnd(hi.endContainer, hi.endOffset);
    if (c.compareBoundaryPoints(Range.START_TO_END, lo) < 0) c.setEnd(lo.startContainer, lo.startOffset);
    if (c.compareBoundaryPoints(Range.END_TO_START, hi) > 0) c.setStart(hi.endContainer, hi.endOffset);
    return c;
  }
  function clampRunSelection() {
    if (!editRun || composing) return;
    const s = getSelection();
    if (!s.rangeCount) return;
    const r = s.getRangeAt(0), c = clampToRun(r);
    if (!c.compareBoundaryPoints(Range.START_TO_START, r) && !c.compareBoundaryPoints(Range.END_TO_END, r)) return;
    const back = !r.collapsed && s.anchorNode === r.endContainer && s.anchorOffset === r.endOffset;
    if (back) s.setBaseAndExtent(c.endContainer, c.endOffset, c.startContainer, c.startOffset);
    else s.setBaseAndExtent(c.startContainer, c.startOffset, c.endContainer, c.endOffset);
  }
  // ⌘A in a run: the caret's block first, the whole run on the second press. The selection runs from the start of
  // the first paragraph or bullet to the end of the last one's own text, never from the edges of a list, so typing
  // over it keeps one block to type into.
  function selectAllRun() {
    const s = getSelection();
    const f = editFrame(), kids = runKids();
    if (!f || !kids.length) return;
    const leaves = leafBlocks();
    const span = list => {
      const r = document.createRange();
      r.setStart(...startOf(list[0]));
      r.setEnd(...ownEnd(list[list.length - 1]));
      return r;
    };
    const mine = leaves.filter(b => f === b || f.contains(b));
    if (!mine.length) return;
    const one = span(mine);
    const cur = s.rangeCount ? s.getRangeAt(0) : null;
    const whole = cur && !cur.compareBoundaryPoints(Range.START_TO_START, one) && !cur.compareBoundaryPoints(Range.END_TO_END, one);
    const r = whole ? span(leaves) : one;
    s.removeAllRanges();
    s.addRange(r);
  }
  // The first place text can go in a block (inside its first text, or before a formula or picture it starts with).
  function startOf(b) {
    let p = b, n = b.firstChild;
    while (n) {
      if (n.nodeType === 3) return [n, 0];
      if (n.nodeType !== 1 || n.classList.contains('math') || isMedia(n) || n.tagName === 'BR' || isList(n) || !n.firstChild) break;
      p = n; n = n.firstChild;
    }
    return [p, 0];
  }
  // The end of a block's own text: before any sub-list, after a formula or picture it ends with.
  function ownEnd(b) {
    const kids = [...b.childNodes];
    let i = kids.findIndex(n => n.nodeType === 1 && isList(n));
    if (i < 0) i = kids.length;
    while (i > 0 && kids[i] && isSpace(kids[i - 1]) && kids[i - 1].data.includes('\n')) i--;
    let p = b, n = p.childNodes[i - 1];
    while (n) {
      if (n.nodeType === 3) return [n, n.length];
      if (n.nodeType !== 1 || n.classList.contains('math') || isMedia(n) || n.tagName === 'BR' || !n.lastChild) return [p, [...p.childNodes].indexOf(n) + 1];
      p = n; n = n.lastChild;
    }
    return [p, i];
  }
  // Focus goes to the editing host; the caret may sit in any block inside it.
  function focusHost(el) {
    const h = editing && editing.contains(el) ? editing : el;
    h.focus({ preventScroll: true });
  }
  function caretAt(el, x, y) {
    focusHost(el);
    const s = getSelection();
    let r = x != null && document.caretRangeFromPoint ? document.caretRangeFromPoint(x, y) : null;
    if (!r || !el.contains(r.startContainer)) {
      r = document.createRange();
      r.setStart(...safePoint(el, el.childNodes.length));
    }
    s.removeAllRanges();
    s.addRange(r);
  }
  // A double-click on a word selects it (as the browser would, had the press not first picked the shape).
  function selectWordAt(x, y) {
    const r = document.caretRangeFromPoint && document.caretRangeFromPoint(x, y);
    if (!r || !editing || !editing.contains(r.startContainer) || r.startContainer.nodeType !== 3 || !window.Intl || !Intl.Segmenter) return;
    const n = r.startContainer, o = r.startOffset;
    for (const g of new Intl.Segmenter(document.documentElement.lang || 'ko', { granularity: 'word' }).segment(n.data)) {
      if (!g.isWordLike || o < g.index || o > g.index + g.segment.length) continue;
      getSelection().setBaseAndExtent(n, g.index, n, g.index + g.segment.length);
      return;
    }
  }
  function selectAllIn(el) {
    focusHost(el);
    const r = document.createRange();
    r.selectNodeContents(el);
    const s = getSelection();
    s.removeAllRanges();
    s.addRange(r);
  }

  function textHost(t) {
    const slide = curSlide();
    for (let e = t; e && e !== slide; e = e.parentElement) {
      if (e instanceof SVGElement || isMedia(e)) return null;
      if (TEXT_TAGS.has(e.tagName)) return e;
      if (ownText(e) && getComputedStyle(e).display !== 'inline') return e;
    }
    return null;
  }
  function objectOf(t) {
    let e = t;
    while (e instanceof SVGElement && e.ownerSVGElement) e = e.ownerSVGElement;
    return e;
  }
  function mathOf(t) {
    const m = t.closest && t.closest('.math');
    return m && curSlide() && curSlide().contains(m) ? m : null;
  }

  // ---------- what a press grabs ----------
  // A layout wrapper only arranges other things (e.g. a two-column row): pressing its empty area starts a
  // drag-selection instead of grabbing the whole row.
  const NOT_WRAPPER = /^(TABLE|UL|OL|LI|FIGURE|IMG|svg|SVG|PICTURE|VIDEO|CANVAS|IFRAME|TD|TH|TR|THEAD|TBODY|TFOOT|P|H[1-6]|BLOCKQUOTE|PRE|A|SPAN|B|I|EM|STRONG|CODE)$/;
  function isWrapper(el) {
    if (!el || el.nodeType !== 1 || el instanceof SVGElement || el === curSlide() || !el.firstElementChild) return false;
    if (NOT_WRAPPER.test(el.tagName) || TEXT_TAGS.has(el.tagName) || el.classList.contains('math') || el.classList.contains('shape')) return false;
    if (ownText(el) || isTextColumn(el)) return false;
    // A box whose children are all inline (e.g. <div><b>text</b></div>) is text, not layout.
    if (el.textContent.trim() && [...el.children].every(c => getComputedStyle(c).display.startsWith('inline'))) return false;
    return true;
  }
  // Text frames are outlined, hit-tested and lasso-tested by their text, not their (often full-width) box.
  function isTextFrame(el) {
    if (!el || el.nodeType !== 1 || el instanceof SVGElement || isCell(el) || el.tagName === 'TABLE' || el.classList.contains('math') || isMedia(el)) return false;
    return isList(el) || isTextColumn(el) || textHost(el) === el;
  }
  const inFlow = el => !/^(absolute|fixed)$/.test(getComputedStyle(el).position);
  // The box around the visible text (and inline pictures/formulas) of `el`, or null when it has none.
  function textBox(el) {
    let L = Infinity, T = Infinity, R = -Infinity, B = -Infinity;
    const add = r => { if (!r.width && !r.height) return; L = Math.min(L, r.left); T = Math.min(T, r.top); R = Math.max(R, r.right); B = Math.max(B, r.bottom); };
    const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    const rg = document.createRange();
    let n;
    while ((n = w.nextNode())) {
      if (!n.data.trim() || (n.parentElement && n.parentElement.closest('.math, aside.notes, [' + RT + ']'))) continue;
      rg.selectNodeContents(n);
      for (const r of rg.getClientRects()) add(r);
    }
    el.querySelectorAll('img, svg, video, canvas, .math').forEach(x => { if (!x.parentElement.closest('svg, .math')) add(x.getBoundingClientRect()); });
    return L < R ? { left: L, top: T, right: R, bottom: B, width: R - L, height: B - T } : null;
  }
  const unionRect = rs => {
    const l = Math.min(...rs.map(r => r.left)), t = Math.min(...rs.map(r => r.top)), r = Math.max(...rs.map(x => x.right)), b = Math.max(...rs.map(x => x.bottom));
    return { left: l, top: t, right: r, bottom: b, width: r - l, height: b - t };
  };
  const hasArea = r => !!r && r.width > 0 && r.height > 0;
  // A rendered formula: the glyphs, not the box (a display formula's box, and KaTeX's own, are as wide as the slide).
  function mathRect(el) {
    const parts = [...el.querySelectorAll('.katex-html > .base')].map(b => b.getBoundingClientRect()).filter(hasArea);
    if (parts.length) return unionRect(parts);
    const k = el.querySelector('.katex');
    if (k) {
      const rg = document.createRange();
      rg.selectNodeContents(k);
      const r = rg.getBoundingClientRect();
      if (hasArea(r)) return r;
    }
    return textBox(el);
  }
  // Something with its own background, border or shadow is visible as a box, even where it holds no text.
  const paints = cs => !/rgba\(.*,\s*0\)$|^transparent$/.test(cs.backgroundColor) || cs.backgroundImage !== 'none' || cs.boxShadow !== 'none' ||
    ['Top', 'Right', 'Bottom', 'Left'].some(k => cs[`border${k}Style`] !== 'none' && parseFloat(cs[`border${k}Width`]) > 0);
  // Where `el` is visible on screen, as a list of rects: the text itself for text blocks (a heading as wide as the
  // slide covers only its words), the rendered glyphs for a formula, the box for pictures, tables, shapes and
  // anything painted; layout wrappers (two-column rows, figures) are looked through. Placing new things, lining
  // things up and keeping toolbars and chips off content all measure with this.
  // `deep`: also what is inside a painted box (a card's words count on top of the card).
  function visibleRects(el, out = [], depth = 0, deep = false) {
    if (!el || el.nodeType !== 1 || el.hasAttribute(RT) || el.matches('aside.notes, style, script, template, link, meta, br')) return out;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') return out;
    if (cs.display === 'contents') { for (const c of el.children) visibleRects(c, out, depth, deep); return out; }
    const b = el.getBoundingClientRect();
    if (el.classList.contains('math')) { const r = mathRect(el) || b; if (hasArea(r)) out.push(r); return out; }
    const solid = el instanceof SVGElement || isMedia(el) || el.tagName === 'TABLE' || el.tagName === 'HR' || el.classList.contains('shape');
    if (solid || paints(cs)) {
      if (hasArea(b)) out.push(b);
      if (deep && !solid && el.firstElementChild && depth <= 8) for (const c of el.children) visibleRects(c, out, depth + 1, true);
      return out;
    }
    if (isTextFrame(el) || ownText(el) || !el.firstElementChild || depth > 8) {
      let r = textBox(el);
      // A list's bullets sit left of its text.
      if (r && isList(el) && cs.listStyleType !== 'none') r = { left: b.left, top: r.top, right: r.right, bottom: r.bottom, width: r.right - b.left, height: r.height };
      if (r) out.push(r);
      return out;
    }
    for (const c of el.children) visibleRects(c, out, depth + 1, deep);
    return out;
  }
  function visibleRect(el) {
    const rs = visibleRects(el);
    return rs.length ? unionRect(rs) : null;
  }
  // The rect used to outline, hit-test, lasso and line up a frame: what is visible of it, else its box.
  const tightRect = el => visibleRect(el) || el.getBoundingClientRect();
  const inside = (r, x, y, dx = 0, dy = 0) => x >= r.left - dx && x <= r.right + dx && y >= r.top - dy && y <= r.bottom + dy;
  const meets = (a, b) => a.left <= b.right && b.left <= a.right && a.top <= b.bottom && b.top <= a.bottom;
  // The frame a click at (x, y) on `t` would grab, using the same rules as activate(); null for the slide
  // background, the empty part of a layout wrapper, and the blank space beside a line of text.
  function textFrame(block) {
    const h = hostOf(block);
    return isSlide(h) ? frameOf(slideChild(block)) : frameOf(h);
  }
  function resolveHit(t, x, y) {
    const s = curSlide();
    if (!s || !t || t.nodeType !== 1 || !s.contains(t) || t === s) return null;
    const m = mathOf(t);
    if (m) return m;
    if (isWrapper(t)) return null;
    const th = textHost(t);
    const f = th ? textFrame(th) : frameOf(objectOf(t));
    if (!f || f === s) return null;
    if (x != null && isTextFrame(f) && inFlow(f)) {
      const r = textBox(f);
      if (r && !inside(r, x, y, 12, 4)) return null;
    }
    // A figure stretched taller than its picture and caption: the empty part below is not the figure.
    if (x != null && f.tagName === 'FIGURE' && inFlow(f) && !inside(frameBox(f), x, y, 12, 4)) return null;
    return f;
  }

  let navFocus = false;   // the last press was on the thumbnails: keys there are not for slide objects
  function onPointerDown(e) {
    if (mode !== 'edit' || e.button !== 0) return;
    const path = e.composedPath();
    if (path.includes(host)) return;
    closeMenu();
    closePop();
    hideHover();
    navFocus = path.includes(sidebar);
    if (navFocus) return;
    hideToast();
    // Object keys act on the slide again once the slide is clicked.
    if (sidebar.contains(document.activeElement)) document.activeElement.blur();
    const slide = curSlide();
    const x = e.clientX, y = e.clientY;
    const t0 = throughMath(e.target, x, y), t = liveRoot(t0) || t0;
    const additive = e.shiftKey || e.metaKey || e.ctrlKey;
    if (!slide || !slide.contains(t) || t === slide) {
      if (t === slide || deck.contains(t) || t === deck) {
        // A press on the background never starts a page-wide text selection; dragging draws a selection box.
        e.preventDefault();
        return startMarquee(e, additive, () => { if (!additive) { stopEditing(); select(null); } });
      }
      stopEditing();
      select(null);
      return;
    }
    // Inside the text being edited, the browser handles the caret and the text selection. In a run, a press
    // beside the text of another block (not on it) still starts a drag-selection, as it would without the run.
    if (editing && editing.contains(t) && !(t.closest && t.closest('[contenteditable="false"]')) &&
      !(editRun && slideChild(t) !== editFrame() && !resolveHit(t, x, y))) {
      if (!e.shiftKey || !additive) watchTextDrag(e);
      return;
    }
    const hit = resolveHit(t, x, y);
    if (additive) {
      e.preventDefault();
      if (!hit) return startMarquee(e, true, null);
      // Shift/⌘-click adds a frame to the selection (or takes it out); dragging moves the whole group.
      stopEditing();
      const was = sel.includes(hit);
      if (!was) setSel([...sel, hit]);
      drag(e, sel.slice(), 'move', () => { if (was) setSel(sel.filter(x => x !== hit)); });
      return;
    }
    if (sel.length > 1 && !editing) {
      const m = sel.find(x => x.contains(t));
      if (m) {
        e.preventDefault();
        drag(e, sel.slice(), 'move', () => { select(m); activate(t, x, y, null); });
        return;
      }
    }
    if (selected && !editing && selected.contains(t) && inside(frameBox(selected), x, y, 12, 6)) {
      e.preventDefault();
      drag(e, selected, 'move', () => activate(t, x, y, null));
      return;
    }
    if (!hit) {
      e.preventDefault();
      const wrap = isWrapper(t) ? t : null;
      // A click (not a drag) beside the words of a heading, paragraph or bullet types at the end of that line.
      const near = besideText(t, x, y);
      return startMarquee(e, false, () => {
        if (near && near.block.isConnected) return activate(near.block, near.x, near.y, null);
        stopEditing();
        select(wrap);
      });
    }
    activate(t, x, y, e);
  }
  // A press inside the box of a heading, paragraph, bullet or text column but beside its words: the text block and the
  // end of its line nearest the press, or null.
  function besideText(t, x, y) {
    const s = curSlide();
    if (!s || !t || t.nodeType !== 1 || t === s || !s.contains(t) || t instanceof SVGElement || mathOf(t) || isBoxShape(t) || labelShape(t)) return null;
    let blocks;
    if (isTextColumn(t)) blocks = [...t.children].flatMap(c => (isList(c) ? [...c.querySelectorAll('li')] : [c]));
    else if (isList(t)) blocks = [...t.querySelectorAll('li')];
    else { const h = textHost(t); if (!h || isWrapper(h)) return null; blocks = [h]; }
    let best = null, bd = Infinity;
    const rg = document.createRange();
    for (const b of blocks) {
      const w = document.createTreeWalker(b, NodeFilter.SHOW_TEXT);
      for (let n; (n = w.nextNode());) {
        if (!n.data.trim() || !n.parentElement || n.parentElement.closest('.math, [' + RT + ']')) continue;
        rg.selectNodeContents(n);
        for (const r of rg.getClientRects()) {
          if (!r.width) continue;
          const d = y < r.top ? r.top - y : y > r.bottom ? y - r.bottom : 0;
          if (d < bd || (d === bd && best && r.right > best.r.right && Math.abs(r.top - best.r.top) < 2)) { bd = d; best = { b, r }; }
        }
      }
    }
    // Far below the words of a column stretched by its row is empty space, not the column.
    if (!best || bd > 30) return null;
    return { block: best.b, x: Math.max(best.r.left + 1, Math.min(x, best.r.right - 1)), y: (best.r.top + best.r.bottom) / 2 };
  }
  // Decide what a click on `t` means. With `e` (a live pointerdown) the browser places the caret itself.
  function activate(t, x, y, e) {
    // A shape is grabbed whole, also by its text; a click on the shape already selected types into it.
    const sh = isBoxShape(t) ? t : labelShape(t);
    if (sh && curSlide() && curSlide().contains(sh)) {
      if (!e && sel.length === 1 && selected === sh) return startLabel(sh, x, y);
      stopEditing();
      select(sh);
      if (e) { e.preventDefault(); drag(e, sh, 'move'); }
      return;
    }
    const m = mathOf(t);
    if (m) {
      stopEditing();
      select(m);
      if (e) { e.preventDefault(); drag(e, m, 'move'); }
      return;
    }
    const h = textHost(t);
    if (h) {
      stopEditing();
      select(h);
      startEditing(h);
      if (!e) caretAt(h, x, y);
      else watchTextDrag(e);
      return;
    }
    const o = frameOf(objectOf(t));
    stopEditing();
    select(o);
    if (e) { e.preventDefault(); drag(e, o, 'move'); }
  }
  // A text selection cannot reach into another box; say so once if someone tries.
  let crossHintAt = 0;
  function watchTextDrag(e) {
    const sx = e.clientX, sy = e.clientY;
    let start = null;
    // While text is dragged over, the toolbars let the pointer through to the text under them.
    $('.root').classList.add('textdrag');
    // Chrome sometimes drags only a caret, selecting nothing, when the press lands on the exact middle of a
    // character; then the selection is made here, from the press to the pointer.
    const move = ev => {
      if (!(ev.buttons & 1) || !editing || composing || Math.hypot(ev.clientX - sx, ev.clientY - sy) < 6) return;
      const s = getSelection();
      if (!s.rangeCount || !s.isCollapsed) return;
      if (!start) start = document.caretRangeFromPoint && document.caretRangeFromPoint(sx, sy);
      const end = document.caretRangeFromPoint && document.caretRangeFromPoint(ev.clientX, ev.clientY);
      if (!start || !end || !editing.contains(start.startContainer) || !editing.contains(end.startContainer)) return;
      if (!start.compareBoundaryPoints(Range.START_TO_START, end)) return;
      s.setBaseAndExtent(start.startContainer, start.startOffset, end.startContainer, end.startOffset);
    };
    addEventListener('pointermove', move, true);
    const up = ev => {
      removeEventListener('pointerup', up, true);
      removeEventListener('pointermove', move, true);
      $('.root').classList.remove('textdrag');
      move(Object.assign({ buttons: 1, clientX: ev.clientX, clientY: ev.clientY }));
      if (!editing || Math.hypot(ev.clientX - sx, ev.clientY - sy) < 8 || Date.now() - crossHintAt < 10000) return;
      const at = document.elementFromPoint(ev.clientX, ev.clientY);
      const cell = at && at.closest && at.closest('td, th');
      if (isCell(editing) && cell && cell !== editing && cell.closest('table') === editing.closest('table')) {
        crossHintAt = Date.now();
        toast('Tables are edited one cell at a time · click a cell, Tab for the next', 4000);
        return;
      }
      const f = resolveHit(at, ev.clientX, ev.clientY);
      if (f && !isEditedFrame(f)) {
        crossHintAt = Date.now();
        toast('Text in other boxes isn\'t selected along · drag from empty space to select whole boxes', 4000);
      }
    };
    addEventListener('pointerup', up, true);
  }

  // ---------- drag-selection (marquee) ----------
  // Frames a marquee `m` (screen rect) picks inside `container`: a layout wrapper is taken whole when the box
  // covers it, otherwise we look inside it; anything else is taken when the box touches its text or its box.
  function collect(container, m, depth = 0, out = []) {
    for (const c of container.children) {
      if (c.hasAttribute(RT) || c.matches('aside.notes, style, script, template, link, meta')) continue;
      const cs = getComputedStyle(c);
      if (cs.display === 'none') continue;
      if (cs.display === 'contents') { collect(c, m, depth, out); continue; }
      const b = c.getBoundingClientRect();
      if (!b.width && !b.height) continue;
      if (isWrapper(c) && depth < 3) {
        if (b.left >= m.left && b.right <= m.right && b.top >= m.top && b.bottom <= m.bottom) out.push(c);
        else if (meets(m, b)) collect(c, m, depth + 1, out);
        continue;
      }
      if (meets(m, tightRect(c))) out.push(frameOf(c));
    }
    return out;
  }
  let preview = null;      // frames a marquee in progress would pick
  function startMarquee(e, additive, onClick) {
    const sx = e.clientX, sy = e.clientY;
    const base = additive ? sel.slice() : [];
    const box = $('.marquee');
    let moved = false, hits = [];
    const move = ev => {
      if (!moved && Math.hypot(ev.clientX - sx, ev.clientY - sy) < 4) return;
      if (!moved) {
        moved = true;
        stopEditing();
        if (!additive) setSel([]);
        getSelection().removeAllRanges();
        html.classList.add('dk-dragging');
      }
      const m = { left: Math.min(sx, ev.clientX), top: Math.min(sy, ev.clientY), right: Math.max(sx, ev.clientX), bottom: Math.max(sy, ev.clientY) };
      Object.assign(box.style, { display: 'block', left: m.left + 'px', top: m.top + 'px', width: m.right - m.left + 'px', height: m.bottom - m.top + 'px' });
      hits = curSlide() ? collect(curSlide(), m) : [];
      preview = normalize([...base, ...hits]);
      drawSel();
    };
    const up = () => {
      removeEventListener('pointermove', move);
      removeEventListener('pointerup', up);
      removeEventListener('pointercancel', up);
      html.classList.remove('dk-dragging');
      box.style.display = 'none';
      preview = null;
      if (moved) setSel([...base, ...hits]);
      else if (onClick) onClick();
      drawSel();
    };
    addEventListener('pointermove', move);
    addEventListener('pointerup', up);
    addEventListener('pointercancel', up);
  }

  function showBadge(ev, text) {
    const b = $('.sizebadge');
    b.textContent = text;
    Object.assign(b.style, { display: 'block', left: ev.clientX + 14 + 'px', top: ev.clientY + 14 + 'px' });
  }
  function readTranslate(el) {
    const v = getComputedStyle(el).translate;
    if (!v || v === 'none') return [0, 0];
    const p = v.split(/\s+/).map(parseFloat);
    return [p[0] || 0, p[1] || 0];
  }
  // translate and width have no effect on plain inline boxes.
  function makeTransformable(el) {
    if (!(el instanceof SVGElement) && !MEDIA_TAGS.has(el.tagName) && getComputedStyle(el).display === 'inline') el.style.display = 'inline-block';
  }
  // A floating box placed by left/top keeps only left/top: a move is written into them, not as a translate on top.
  function tidy(el) {
    const t = el.style.translate;
    if (t && /^(absolute|fixed)$/.test(getComputedStyle(el).position)) {
      const [x, y] = t.split(/\s+/).map(v => (/^-?[\d.]+px$/.test(v) ? parseFloat(v) : NaN));
      const pxv = v => /^-?[\d.]+px$/.test(v);
      let tx = isNaN(x) ? null : x, ty = y === undefined ? 0 : isNaN(y) ? null : y;
      if (tx !== null && ty !== null) {
        if (tx && pxv(el.style.left)) { el.style.left = Math.round(parseFloat(el.style.left) + tx) + 'px'; tx = 0; }
        if (ty && pxv(el.style.top)) { el.style.top = Math.round(parseFloat(el.style.top) + ty) + 'px'; ty = 0; }
        el.style.translate = `${tx}px ${ty}px`;
      }
    }
    if (/^0px( 0px)?$/.test(el.style.translate)) el.style.removeProperty('translate');
    if (el.getAttribute('style') === '') el.removeAttribute('style');
  }
  // How far `el` is turned (radians), by the rotate property and any transform.
  function angleOf(el) {
    const cs = getComputedStyle(el);
    let a = 0;
    const m = cs.rotate && cs.rotate !== 'none' && /(-?[\d.]+)(deg|rad|turn|grad)\s*$/.exec(cs.rotate);
    if (m) a += +m[1] * { deg: Math.PI / 180, rad: 1, turn: 2 * Math.PI, grad: Math.PI / 200 }[m[2]];
    if (cs.transform && cs.transform !== 'none') { try { const t = new DOMMatrix(cs.transform); a += Math.atan2(t.b, t.a); } catch (_) {} }
    return a;
  }
  // The size of `el` in slide px as laid out, before it is turned (a turned box's bounding box is bigger).
  function ownSize(el) {
    if (Math.abs(angleOf(el)) < 1e-6) { const r = el.getBoundingClientRect(); return [r.width / scale, r.height / scale]; }
    if (el instanceof HTMLElement) return [el.offsetWidth, el.offsetHeight];
    const cs = getComputedStyle(el), w = parseFloat(cs.width), h = parseFloat(cs.height);
    if (w && h) return [w, h];
    const r = el.getBoundingClientRect();
    return [r.width / scale, r.height / scale];
  }
  // Move (one element or a group), or resize one element. Nothing changes until the pointer travels 4px.
  const isDisplayMath = el => !!el && el.nodeType === 1 && el.classList.contains('math') && (el.classList.contains('display') || el.tagName === 'DIV');
  // A slide whose flow is only its heading: the rest floats (a diagram of boxes and arrows).
  function diagramSlide(s) {
    const kids = [...s.children].filter(shown);
    return kids.some(c => !inFlow(c)) && kids.filter(inFlow).every(c => /^H[1-6]$/.test(c.tagName) || isDisplayMath(c));
  }
  // Take `el` out of the flow without moving what shows: its glyphs stay where they are on screen.
  function floatOut(el) {
    const g0 = (isDisplayMath(el) && mathRect(el)) || el.getBoundingClientRect();
    el.style.removeProperty('translate');
    Object.assign(el.style, { position: 'absolute', left: '0px', top: '0px', margin: '0', width: 'max-content' });
    const g1 = (isDisplayMath(el) && mathRect(el)) || el.getBoundingClientRect();
    el.style.left = Math.round((g0.left - g1.left) / scale) + 'px';
    el.style.top = Math.round((g0.top - g1.top) / scale) + 'px';
  }
  // A press on the empty part of a display formula's box (as wide as the slide) is a press on what lies under it.
  function throughMath(t, x, y) {
    const m = t && t.nodeType === 1 && mathOf(t);
    if (!m || !isDisplayMath(m) || m === editing) return t;
    const r = mathRect(m);
    if (!r || inside(r, x, y, 10, 6)) return t;
    for (const e of document.elementsFromPoint(x, y)) if (e !== m && !m.contains(e) && !e.closest('[' + RT + ']') && !(host && host.contains(e))) return e;
    return t;
  }
  // Slide px from the left edge of `el` to the slide's right margin.
  function roomRight(el) {
    const s = curSlide();
    if (!s) return Infinity;
    const sr = s.getBoundingClientRect(), pr = parseFloat(getComputedStyle(s).paddingRight) || 0;
    return W - pr - (el.getBoundingClientRect().left - sr.left) / scale;
  }
  // ---------- snapping while moving ----------
  const SNAP_PX = 7;   // screen pixels
  // What a moved selection can snap to, in screen coordinates: the slide's centre lines and content margins, and the
  // left/centre/right (top/middle/bottom) of everything else visible on the slide.
  function snapTargets(els) {
    const s = curSlide();
    if (!s) return null;
    const S = s.getBoundingClientRect(), cs = getComputedStyle(s);
    const pad = k => (parseFloat(cs['padding' + k]) || 0) * scale;
    const xs = [{ v: (S.left + S.right) / 2, center: true, slide: true },
      { v: S.left + pad('Left'), slide: true }, { v: S.right - pad('Right'), slide: true }];
    const ys = [{ v: (S.top + S.bottom) / 2, center: true, slide: true },
      { v: S.top + pad('Top'), slide: true }, { v: S.bottom - pad('Bottom'), slide: true }];
    for (const r of peerRects(els)) {
      if (r.width < 2 && r.height < 2) continue;
      xs.push({ v: r.left, r }, { v: (r.left + r.right) / 2, center: true, r }, { v: r.right, r });
      ys.push({ v: r.top, r }, { v: (r.top + r.bottom) / 2, center: true, r }, { v: r.bottom, r });
    }
    return { S, R0: unionRect(els.map(tightRect)), xs, ys };
  }
  // Centres snap to centres and edges to edges; the slide's own centre wins a near tie.
  function snapAxis(lo, hi, targets) {
    const mid = (lo + hi) / 2;
    let best = null;
    for (const t of targets) {
      for (const c of t.center ? [mid] : [lo, hi]) {
        const d = t.v - c, score = Math.abs(d) - (t.slide && t.center ? 2 : 0);
        if (Math.abs(d) <= SNAP_PX && (!best || score < best.score)) best = { d, t, score };
      }
    }
    return best;
  }
  const shiftRect = (r, x, y) => ({ left: r.left + x, right: r.right + x, top: r.top + y, bottom: r.bottom + y, width: r.width, height: r.height });
  function snapMove(snap, dx, dy) {
    const R = shiftRect(snap.R0, dx * scale, dy * scale);
    const bx = snapAxis(R.left, R.right, snap.xs), by = snapAxis(R.top, R.bottom, snap.ys);
    const ndx = dx + (bx ? bx.d / scale : 0), ndy = dy + (by ? by.d / scale : 0);
    return { dx: ndx, dy: ndy, bx, by, R: shiftRect(snap.R0, ndx * scale, ndy * scale) };
  }
  function drawGuides(snap, sn) {
    if (!shadow) return;
    const gx = $('.guide.gx'), gy = $('.guide.gy');
    const line = (g, b, vertical) => {
      if (!snap || !sn || !b) { g.style.display = 'none'; return; }
      const t = b.t, S = snap.S, R = sn.R;
      g.classList.toggle('center', !!(t.slide && t.center));
      g.classList.toggle('slide', !!t.slide);
      // Slide lines run across the slide; a line to another object spans just the two of them.
      const a = t.slide ? (vertical ? S.top : S.left) : Math.min(vertical ? R.top : R.left, vertical ? t.r.top : t.r.left) - 8;
      const z = t.slide ? (vertical ? S.bottom : S.right) : Math.max(vertical ? R.bottom : R.right, vertical ? t.r.bottom : t.r.right) + 8;
      Object.assign(g.style, vertical
        ? { display: 'block', left: Math.round(t.v) + 'px', top: a + 'px', height: z - a + 'px', width: '' }
        : { display: 'block', top: Math.round(t.v) + 'px', left: a + 'px', width: z - a + 'px', height: '' });
    };
    line(gx, sn && sn.bx, true);
    line(gy, sn && sn.by, false);
  }

  function drag(e, target, kind, onClick) {
    const els = Array.isArray(target) ? target : [target];
    const el = els[0];
    const sx = e.clientX, sy = e.clientY;
    const t0 = els.map(readTranslate);
    // A turned object is resized along its own sides: the pointer's travel is turned into its frame.
    const [w0, h0] = ownSize(el), th = kind === 'move' ? 0 : angleOf(el), cos = Math.cos(th), sin = Math.sin(th);
    // In a flex row, flex-grow/basis would override the width we set.
    const ps = el.parentElement && getComputedStyle(el.parentElement);
    const cs = getComputedStyle(el);
    const parentFlex = ps && /flex/.test(ps.display) && ps.flexDirection.startsWith('row') &&
      (cs.flexGrow !== '0' || cs.flexBasis !== 'auto');
    let moved = false, lastDy = 0, snap = null;
    const h0px = el.getBoundingClientRect().height / scale;
    const move = ev => {
      if (!moved && Math.hypot(ev.clientX - sx, ev.clientY - sy) < 4) return;
      if (!moved) {
        moved = true;
        dragging = true;
        html.classList.add('dk-dragging');
        if (kind !== 'move') $('.root').classList.add('dragging');   // the live size badge is never under a toolbar
        hideHover();
        if (kind === 'move' && !(editing && el.contains(editing))) getSelection().removeAllRanges();
        els.forEach(makeTransformable);
        if (kind === 'move') snap = snapTargets(els);
      }
      const mx = (ev.clientX - sx) / scale, my = (ev.clientY - sy) / scale;
      const dx = mx * cos + my * sin, dy = -mx * sin + my * cos;
      lastDy = dy;
      if (kind === 'move') {
        // Snap to the slide's centre lines and margins and to other things' edges and centres; ⌘ moves freely.
        const sn = snap && !ev.metaKey ? snapMove(snap, dx, dy) : { dx, dy };
        drawGuides(snap, sn);
        els.forEach((x, i) => { x.style.translate = `${Math.round(t0[i][0] + sn.dx)}px ${Math.round(t0[i][1] + sn.dy)}px`; });
      } else if (kind === 'resize-w') {
        let nw = Math.max(16, Math.round(w0 + dx));
        // Text never runs past the slide's right margin, and a width set by hand is the width (no cap left over).
        if (sizeKind(el) === 'text') { el.style.maxWidth = ''; nw = Math.min(nw, Math.max(16, roomRight(el))); }
        el.style.width = nw + 'px';
        if (parentFlex) el.style.flex = '0 0 auto';
        showBadge(ev, `Width ${Math.round(ownSize(el)[0])}`);
      } else if (kind === 'resize-h') {
        el.style.height = Math.max(8, Math.round(h0 + dy)) + 'px';
        showBadge(ev, `Height ${Math.round(ownSize(el)[1])}`);
      } else {
        const nw = Math.max(16, Math.round(w0 + dx));
        el.style.width = nw + 'px';
        if (el.classList.contains('shape')) {
          el.style.height = Math.max(8, Math.round(h0 + dy)) + 'px';
          if (el.dataset.shape === 'line' || el.dataset.shape === 'arrow') drawLine(el);
        } else if (isMedia(el)) {
          el.style.height = 'auto';
          el.style.maxWidth = 'none';
        } else if (ev.shiftKey) {
          el.style.height = Math.max(16, Math.round(h0 + dy)) + 'px';
        }
        if (parentFlex) el.style.flex = '0 0 auto';
        const [rw, rh] = ownSize(el);
        showBadge(ev, `${Math.round(rw)} × ${Math.round(rh)}`);
      }
    };
    const up = () => {
      removeEventListener('pointermove', move);
      removeEventListener('pointerup', up);
      removeEventListener('pointercancel', up);
      html.classList.remove('dk-dragging');
      $('.root').classList.remove('dragging');
      $('.sizebadge').style.display = 'none';
      drawGuides(null);
      dragging = false;
      // A display formula dragged out of its place in the flow (or on a slide of boxes and arrows) floats where it
      // was dropped: placed by left/top, so it stays put when the flow changes and copies with the diagram.
      if (moved && kind === 'move' && els.length === 1 && isDisplayMath(el) && el.parentElement === curSlide() && inFlow(el) &&
        (Math.abs(lastDy) > h0px / 2 || diagramSlide(el.parentElement))) floatOut(el);
      if (moved) { els.forEach(tidy); commit(); if ($('.otb').classList.contains('show')) refreshObj(); }
      else if (onClick) onClick();
    };
    addEventListener('pointermove', move);
    addEventListener('pointerup', up);
    addEventListener('pointercancel', up);
  }

  // ---------- pointing lines and arrows ----------
  // Where a line's two ends and its middle are on screen. The line runs along the middle of its box, tail on the left.
  function lineEnds(el) {
    const r = el.getBoundingClientRect(), a = angleOf(el), half = ownSize(el)[0] * scale / 2;
    const c = { x: (r.left + r.right) / 2, y: (r.top + r.bottom) / 2 };
    return { c, tail: { x: c.x - Math.cos(a) * half, y: c.y - Math.sin(a) * half }, head: { x: c.x + Math.cos(a) * half, y: c.y + Math.sin(a) * half } };
  }
  // Drag one end: the other end stays where it is; the line's length (width) and angle (rotate) follow the pointer.
  // Shift turns it in 15° steps. One undo step per drag.
  function lineDrag(e, el, end) {
    const w0 = ownSize(el)[0], ends = lineEnds(el), fixed = end === 'head' ? ends.tail : ends.head, c0 = ends.c;
    const cs = getComputedStyle(el);
    const left0 = parseFloat(el.style.left) || parseFloat(cs.left) || 0, top0 = parseFloat(el.style.top) || parseFloat(cs.top) || 0;
    const sx = e.clientX, sy = e.clientY;
    let moved = false;
    const move = ev => {
      if (!moved && Math.hypot(ev.clientX - sx, ev.clientY - sy) < 3) return;
      if (!moved) { moved = true; dragging = true; html.classList.add('dk-dragging'); $('.root').classList.add('dragging'); hideHover(); }
      const sign = end === 'head' ? 1 : -1;
      const vx = sign * (ev.clientX - fixed.x) / scale, vy = sign * (ev.clientY - fixed.y) / scale;
      const L = Math.max(20, Math.round(Math.hypot(vx, vy)));
      let a = Math.atan2(vy, vx) * 180 / Math.PI;
      a = ev.shiftKey ? Math.round(a / 15) * 15 : Math.round(a * 10) / 10;
      // Within half a degree of level or upright it is level or upright (no rotate: 359.9deg in the file).
      if (Math.abs(a - Math.round(a / 90) * 90) <= 0.5) a = Math.round(a / 90) * 90;
      const ux = Math.cos(a * Math.PI / 180), uy = Math.sin(a * Math.PI / 180);
      const cx = fixed.x + sign * ux * L * scale / 2, cy = fixed.y + sign * uy * L * scale / 2;
      el.style.width = L + 'px';
      el.style.left = Math.round(left0 + (cx - c0.x) / scale - (L - w0) / 2) + 'px';
      el.style.top = Math.round(top0 + (cy - c0.y) / scale) + 'px';
      const deg = Math.round((((a % 360) + 360) % 360) * 10) / 10;
      if (deg && deg !== 360) el.style.rotate = deg + 'deg'; else el.style.removeProperty('rotate');
      drawLine(el);
      showBadge(ev, `Length ${L} · ${Math.round(deg) % 360}°`);
      drawSel();
    };
    const up = () => {
      removeEventListener('pointermove', move);
      removeEventListener('pointerup', up);
      removeEventListener('pointercancel', up);
      html.classList.remove('dk-dragging');
      $('.root').classList.remove('dragging');
      $('.sizebadge').style.display = 'none';
      dragging = false;
      if (moved) { commit(); if ($('.otb').classList.contains('show')) refreshObj(); }
    };
    addEventListener('pointermove', move);
    addEventListener('pointerup', up);
    addEventListener('pointercancel', up);
  }

  // ---------- resizing in proportion ----------
  // What a resize means for each kind of thing on a slide.
  function sizeKind(el) {
    if (!el) return '';
    if (el.classList.contains('math')) return 'math';
    if (el.dataset && (el.dataset.shape === 'line' || el.dataset.shape === 'arrow')) return 'line';
    if (el.classList.contains('shape')) return 'shape';
    if (isLive(el)) return 'live';
    if (isMedia(el)) return 'media';
    if (el.tagName === 'TABLE') return 'table';
    if (isTextFrame(el)) return 'text';
    return 'box';
  }
  const insideKatex = n => n.closest && n.closest('.katex') && !n.classList.contains('math');
  // Everything a proportional resize starts from, so each pointer move scales from the original, not the last step.
  function measure(el) {
    const kind = sizeKind(el);
    const [w, h] = ownSize(el);
    const m = { el, kind, w, h, fonts: [], widths: [] };
    // An interactive element grows as a whole (zoom): what is inside it is its script's, and never saved.
    if (kind === 'live') { m.z = parseFloat(el.style.zoom) || 1; return m; }
    if (kind === 'media' || kind === 'shape' || kind === 'line') return m;
    for (const n of [el, ...el.querySelectorAll('*')]) {
      if (n !== el && (insideKatex(n) || n instanceof SVGElement && n.ownerSVGElement)) continue;
      m.fonts.push([n, parseFloat(getComputedStyle(n).fontSize)]);
      // Pictures inside a box, and boxes given an explicit width, grow with it.
      if (n !== el && (n.tagName === 'IMG' || n instanceof SVGElement) && !n.ownerSVGElement) m.widths.push([n, n.getBoundingClientRect().width / scale]);
    }
    const cs = getComputedStyle(el);
    // Only a width someone set is scaled; an in-flow block keeps filling its column and just its contents grow.
    m.ownWidth = !!(el.style.width || el.style.maxWidth);
    const ps = el.parentElement && getComputedStyle(el.parentElement);
    m.flexRow = ps && /flex/.test(ps.display) && ps.flexDirection.startsWith('row') && (cs.flexGrow !== '0' || cs.flexBasis !== 'auto');
    return m;
  }
  const px = v => Math.max(1, Math.round(v)) + 'px';
  function applyScale(m, f) {
    const el = m.el;
    if (m.kind === 'media') { el.style.width = px(m.w * f); el.style.height = 'auto'; el.style.maxWidth = 'none'; return; }
    if (m.kind === 'live') { const z = Math.round(m.z * f * 1000) / 1000; if (z === 1) el.style.removeProperty('zoom'); else el.style.zoom = String(z); return; }
    if (m.kind === 'shape' || m.kind === 'line') {
      el.style.width = px(m.w * f);
      el.style.height = px(m.h * f);
      if (m.kind === 'line') drawLine(el);
      return;
    }
    // Letters: set the outer size, then fix up any inner part whose own CSS size did not follow.
    const [[, f0], ...rest] = m.fonts;
    el.style.fontSize = px(f0 * f);
    for (const [n, size] of rest) {
      if (Math.abs(parseFloat(getComputedStyle(n).fontSize) - size * f) > 0.75) n.style.fontSize = px(size * f);
    }
    for (const [n, w] of m.widths) {
      if (Math.abs(n.getBoundingClientRect().width / scale - w * f) > 1) { n.style.width = px(w * f); if (n.tagName === 'IMG') n.style.height = 'auto'; }
    }
    if (m.ownWidth && m.kind !== 'math') {
      // Text never grows past the slide's right margin (the side handle keeps the same limit).
      const room = m.kind === 'text' ? Math.max(16, roomRight(el)) : Infinity;
      if (el.style.maxWidth && (!el.style.width || el.style.width === 'max-content')) el.style.maxWidth = px(Math.min(parseFloat(el.style.maxWidth) * f, room));
      else el.style.width = px(Math.min(m.w * f, room));
      if (m.flexRow) el.style.flex = '0 0 auto';
    }
  }
  function snapshot(els) {
    const out = [];
    for (const el of els) for (const n of [el, ...el.querySelectorAll('*')]) if (!insideKatex(n)) out.push([n, n.getAttribute('style')]);
    return out;
  }
  const restoreSnap = snap => snap.forEach(([n, v]) => { if (!n.isConnected) return; if (v == null) n.removeAttribute('style'); else n.setAttribute('style', v); });
  // Scale every element by f; a group keeps its arrangement, growing away from its top-left corner.
  function scaleAll(els, base, f) {
    base.ms.forEach(m => applyScale(m, f));
    if (els.length < 2) return;
    els.forEach((el, i) => {
      makeTransformable(el);
      const r = tightRect(el), r0 = base.rects[i];
      const wx = base.u.left + (r0.left - base.u.left) * f, wy = base.u.top + (r0.top - base.u.top) * f;
      el.style.translate = `${Math.round(base.t0[i][0] + (wx - r.left) / scale)}px ${Math.round(base.t0[i][1] + (wy - r.top) / scale)}px`;
    });
  }
  function scaleBase(els) {
    const rects = els.map(tightRect);
    return { ms: els.map(measure), rects, u: unionRect(rects), t0: els.map(readTranslate) };
  }
  function sizeLabel(els) {
    if (els.length !== 1) return 'Size';
    const el = els[0], k = sizeKind(el);
    if (k === 'box') return 'Size';
    if (k === 'live') return Math.round((parseFloat(el.style.zoom) || 1) * 100) + '%';
    if (k === 'media' || k === 'shape' || k === 'line') return Math.round(ownSize(el)[0]) + '';
    return Math.round(parseFloat(getComputedStyle(el).fontSize)) + '';
  }
  function badgeText(els, f) {
    if (els.length > 1) return Math.round(f * 100) + '%';
    const k = sizeKind(els[0]);
    if (k === 'live') return Math.round((parseFloat(els[0].style.zoom) || 1) * 100) + '%';
    if (k === 'media' || k === 'shape' || k === 'line') {
      const [w, h] = ownSize(els[0]);
      return `${Math.round(w)} × ${Math.round(h)}`;
    }
    return `Text ${Math.round(parseFloat(getComputedStyle(els[0]).fontSize))}px`;
  }
  // − / ＋ and ⌘⇧, / ⌘⇧.: every selected thing grows or shrinks about its own middle, so a label centred on a
  // shape stays centred and a row of labels keeps its spacing. Text keeps its box width (only its letters change)
  // and its vertical middle; things in the flow just change size where they are.
  function scaleBy(f) {
    const els = sel.slice();
    if (!els.length) return;
    stopEditing();
    for (const el of els) {
      const m = measure(el), r0 = el.getBoundingClientRect();
      if (m.kind === 'text') m.ownWidth = false;
      applyScale(m, f);
      if (inFlow(el)) continue;
      const r1 = el.getBoundingClientRect();
      const dx = m.kind === 'text' ? 0 : (r0.left + r0.right - r1.left - r1.right) / 2 / scale;
      const dy = (r0.top + r0.bottom - r1.top - r1.bottom) / 2 / scale;
      if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) continue;
      const [x, y] = readTranslate(el);
      el.style.translate = `${Math.round(x + dx)}px ${Math.round(y + dy)}px`;
      tidy(el);
    }
    commit();
    if (shadow) $('.otb .szl').textContent = sizeLabel(els);
  }
  function scaleDrag(e, els) {
    const sx = e.clientX, sy = e.clientY;
    const base = scaleBase(els);
    const frame = els.length > 1 ? base.u : (els[0].classList.contains('math') ? tightRect(els[0]) : els[0].getBoundingClientRect());
    const W0 = Math.max(8, frame.width), H0 = Math.max(8, frame.height);
    const snap = snapshot(els);
    const badge = $('.sizebadge');
    let moved = false;
    const move = ev => {
      if (!moved && Math.hypot(ev.clientX - sx, ev.clientY - sy) < 4) return;
      if (!moved) { moved = true; dragging = true; html.classList.add('dk-dragging'); $('.root').classList.add('dragging'); hideHover(); }
      // Project the pointer onto the frame's diagonal, so the corner follows the hand.
      const dx = ev.clientX - sx, dy = ev.clientY - sy;
      const f = Math.max(0.1, 1 + (dx * W0 + dy * H0) / (W0 * W0 + H0 * H0));
      restoreSnap(snap);
      scaleAll(els, base, f);
      badge.textContent = badgeText(els, f);
      Object.assign(badge.style, { display: 'block', left: ev.clientX + 14 + 'px', top: ev.clientY + 14 + 'px' });
      drawSel();
    };
    const up = () => {
      removeEventListener('pointermove', move);
      removeEventListener('pointerup', up);
      removeEventListener('pointercancel', up);
      html.classList.remove('dk-dragging');
      $('.root').classList.remove('dragging');
      badge.style.display = 'none';
      dragging = false;
      if (moved) { els.forEach(tidy); commit(); if ($('.otb').classList.contains('show')) refreshObj(); }
    };
    addEventListener('pointermove', move);
    addEventListener('pointerup', up);
    addEventListener('pointercancel', up);
  }

  // ---------- drawing the selection ----------
  const place = (el, r, pad = 0) => Object.assign(el.style, { display: 'block', left: r.left - pad + 'px', top: r.top - pad + 'px', width: r.width + 2 * pad + 'px', height: r.height + 2 * pad + 'px' });
  // One outline per member (pooled), shown for a group and for what a marquee in progress would pick.
  function drawMembers(list) {
    const pool = $('.selms');
    while (pool.children.length < list.length) pool.appendChild(Object.assign(document.createElement('div'), { className: 'selm' }));
    [...pool.children].forEach((d, i) => {
      if (i < list.length) place(d, tightRect(list[i]), 3);
      else d.style.display = 'none';
    });
  }
  function drawSel() {
    const box = $('.sel'), grp = $('.selg'), mark = $('.cellmark');
    if (editing && (!editing.isConnected || !deck.contains(editing))) { editing = null; editMulti = editRun = false; }
    const n = editing ? [editFrame()] : normalize(sel);
    if (!sameList(n, sel)) { sel = n; selected = sel[0] || null; updateCrumbs(); if ($('.otb').classList.contains('show')) refreshObj(); }
    if (mode !== 'edit' || !sel.length) {
      box.style.display = grp.style.display = mark.style.display = 'none';
      drawMembers(mode === 'edit' && preview ? preview : []);
      placeFmt(null);
      return;
    }
    if (sel.length > 1) {
      box.style.display = mark.style.display = 'none';
      const list = preview || sel;
      drawMembers(list);
      // A group is outlined by what is visible of its members (a heading's words, not its full-width box).
      const u = unionRect(list.map(tightRect));
      place(grp, u, 8);
      grp.classList.toggle('tight', u.top - 42 < TOOLBAR);
      $('.selg .gtag').textContent = `${sel.length} selected`;
      if (!preview) placeChip(u, $('.selg .gtag'), 8);
      placeFmt(u);
      return;
    }
    grp.style.display = 'none';
    drawMembers(preview && preview.length > 1 ? preview : []);
    const r = frameRect();
    box.style.display = 'block';
    box.style.left = r.left + 'px';
    box.style.top = r.top + 'px';
    box.style.width = r.width + 'px';
    box.style.height = r.height + 'px';
    box.classList.toggle('editing', !!editing);
    // No room above the frame: the grip moves inside it.
    box.classList.toggle('tight', r.top - 34 < TOOLBAR);
    const sk = sizeKind(selected);
    box.classList.toggle('no-edges', editing ? false : sk === 'media' || sk === 'live' || sk === 'line' || sk === 'math');
    box.classList.toggle('no-rh', sk !== 'shape');
    // A line or arrow is pointed by its two ends.
    const ends = !editing && sk === 'line' && sel.length === 1 ? lineEnds(selected) : null;
    box.classList.toggle('line-ends', !!ends);
    if (ends) {
      for (const k of ['tail', 'head']) Object.assign($('.endpt.' + k).style, { left: ends[k].x - r.left + 'px', top: ends[k].y - r.top + 'px' });
    }
    const tip = { math: 'Drag: resize the equation', text: 'Drag: resize, text included', table: 'Drag: resize the table, text included',
      media: 'Drag: resize, keeping the ratio', shape: 'Drag: resize (Shift: keep the ratio)', line: 'Drag: change the length', box: 'Drag: resize, text and images inside included' }[sk];
    $('.sel .resize').title = tip || 'Drag to resize';
    if (!editing) placeChip(r);
    if (isCell(editing)) {
      const c = editing.getBoundingClientRect();
      Object.assign(mark.style, { display: 'block', left: c.left + 'px', top: c.top + 'px', width: c.width + 'px', height: c.height + 'px' });
    } else mark.style.display = 'none';
    // Typing in a text column: the toolbar goes by the paragraph or list being typed in.
    let at = r;
    if (editing && isTextColumn(editing)) {
      const b = curBlock(), k = b && [...editing.children].find(c => c.contains(b));
      if (k) at = frameBox(k);
    }
    placeFmt(at);
  }

  // The chip naming the selection goes above the frame's left end, else above its right end, else beside it,
  // wherever it covers nothing else on the slide; only when every such spot does, inside the frame's top edge.
  let chipKey = '';
  function placeChip(r, tag = $('.tag'), pad = 0) {
    const cw = tag.offsetWidth, ch = tag.offsetHeight;
    const key = [tag.className, tag.textContent, sel.length, cw, ch, Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height), innerWidth, innerHeight].join();
    if (key === chipKey && selected === placeChip.el) return;
    chipKey = key;
    placeChip.el = selected;
    const peers = peerRects(sel);
    const w = r.width + 2 * pad;
    const spots = [[-2, -ch - 8], [w - cw + 2, -ch - 8], [w + 16, 0], [-cw - 30, 0]];
    let at = [4, 4];
    for (const [x, y] of spots) {
      const b = { left: r.left - pad + x, top: r.top - pad + y, right: r.left - pad + x + cw, bottom: r.top - pad + y + ch };
      if (b.top < TOOLBAR + 2 || b.left < SIDEBAR + 2 || b.right > innerWidth - 2 || b.bottom > innerHeight - 2) continue;
      if (peers.some(p => overlapArea(b, p) > 0)) continue;
      at = [x, y];
      break;
    }
    tag.style.left = at[0] + 'px';
    tag.style.top = at[1] + 'px';
  }

  // ---------- hover: outline what a click would grab ----------
  let hoverRaf = 0, hoverEv = null, hoverCls = '';
  function setHoverCls(c) {
    if (c === hoverCls) return;
    if (hoverCls) html.classList.remove(hoverCls);
    if (c) html.classList.add(c);
    hoverCls = c;
  }
  function hideHover() {
    if (shadow) $('.hover').style.display = 'none';
    setHoverCls('');
  }
  function onHoverMove(e) {
    hoverEv = e;
    if (!hoverRaf) hoverRaf = requestAnimationFrame(drawHover);
  }
  function drawHover() {
    hoverRaf = 0;
    const e = hoverEv;
    if (!e || mode !== 'edit' || e.buttons || dragging || preview) return hideHover();
    const path = e.composedPath ? e.composedPath() : [];
    if (path.includes(host) || path.includes(sidebar)) return hideHover();
    const t = throughMath(e.target, e.clientX, e.clientY);
    let f = resolveHit(t, e.clientX, e.clientY);
    if (!f) { const near = besideText(t, e.clientX, e.clientY); if (near) f = textFrame(near.block); }
    const isEdited = isEditedFrame(f);
    if (!f || isEdited) return hideHover();
    const member = sel.includes(f);
    const text = !member && (isTextFrame(f) || f.tagName === 'TABLE');
    setHoverCls(text ? 'dk-hover-text' : 'dk-hover-move');
    if (member) { $('.hover').style.display = 'none'; return; }
    place($('.hover'), tightRect(f), 3);
  }
  function tick() {
    try {
      // A caret pushed past an overflowing edge scrolls the slide itself (overflow:hidden still scrolls); undo that.
      const s = curSlide();
      if (s && (s.scrollLeft || s.scrollTop)) { s.scrollLeft = 0; s.scrollTop = 0; }
      drawSel();
    } catch (err) { console.warn('[deck-edit]', err); }
    requestAnimationFrame(tick);
  }

  // ---------- element & slide operations ----------
  function fontStep(dir) {
    if (!editing && sel.length) return scaleBy(dir > 0 ? 1.1 : 1 / 1.1);
    const el = editing ? curBlock() || editing : selected;
    if (!el) return toast('Select something first to change its font size');
    if (TEXT_TAGS.has(el.tagName) || el === editing || ownText(el)) {
      const fs = parseFloat(getComputedStyle(el).fontSize);
      el.style.fontSize = Math.max(6, Math.round(fs * (dir > 0 ? 1.1 : 1 / 1.1))) + 'px';
    } else {
      const z = parseFloat(el.style.zoom) || 1;
      el.style.zoom = String(Math.round(z * (dir > 0 ? 1.1 : 1 / 1.1) * 1000) / 1000);
    }
    commit();
  }
  function removeSelected() {
    const list = sel.slice();
    if (!list.length) return;
    stopEditing(false);
    setSel([]);
    list.forEach(removeWithSpace);
    commit();
    if (list.length > 1) toast(`${list.length} deleted · ⌘Z to undo`);
  }
  // Each copy goes right after its original; floating ones are offset so they do not hide it.
  function duplicateSelected() {
    const list = sel.slice();
    if (!list.length) return;
    stopEditing();
    const copies = list.map(el => {
      const c = resetLive(el.cloneNode(true));
      uniquifyIds(c);
      putAfter(el, c);   // on a line of its own, indented like the original
      if (getComputedStyle(el).position === 'absolute') {
        const [x, y] = readTranslate(el);
        c.style.translate = `${x + 30}px ${y + 30}px`;
        tidy(c);
      }
      return c;
    });
    setSel(copies);
    commit();
  }
  function nudge(dx, dy) {
    for (const el of sel) {
      makeTransformable(el);
      const [x, y] = readTranslate(el);
      el.style.translate = `${x + dx}px ${y + dy}px`;
      tidy(el);
    }
    scheduleCommit();
  }
  // Align ▾ for a group: line every member up with an edge (or the middle) of the group's bounding box.
  function arrange(how) {
    if (how.startsWith('slide-')) return centerOnSlide(how);
    if (sel.length < 2) return;
    // Line up what is visible (the text of a full-width heading, the formula of a display formula), not the boxes.
    const rs = sel.map(tightRect);
    const u = unionRect(rs);
    sel.forEach((el, i) => {
      const r = rs[i];
      const dx = how === 'left' ? u.left - r.left : how === 'right' ? u.right - r.right : how === 'center' ? (u.left + u.right - r.left - r.right) / 2 : 0;
      const dy = how === 'top' ? u.top - r.top : how === 'bottom' ? u.bottom - r.bottom : how === 'middle' ? (u.top + u.bottom - r.top - r.bottom) / 2 : 0;
      if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) return;
      makeTransformable(el);
      const [x, y] = readTranslate(el);
      el.style.translate = `${Math.round(x + dx / scale)}px ${Math.round(y + dy / scale)}px`;
      tidy(el);
    });
    commit();
  }
  // Align ▾ › Relative to slide: move the selection (as one piece) to the slide's centre line(s), by what is visible.
  function centerOnSlide(how) {
    const s = curSlide();
    if (!s || !sel.length) return;
    const S = s.getBoundingClientRect(), u = unionRect(sel.map(tightRect));
    const dx = how === 'slide-v' ? 0 : (S.left + S.right - u.left - u.right) / 2;
    const dy = how === 'slide-h' ? 0 : (S.top + S.bottom - u.top - u.bottom) / 2;
    if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) return toast('Already centered');
    sel.forEach(el => {
      makeTransformable(el);
      const [x, y] = readTranslate(el);
      el.style.translate = `${Math.round(x + dx / scale)}px ${Math.round(y + dy / scale)}px`;
      tidy(el);
    });
    commit();
  }
  // Alt+↑/↓ on one selected object in the flow: swap it with the next in-flow neighbour (notes and floating things are skipped).
  function moveInFlow(d) {
    const el = selected;
    if (!el || sel.length !== 1 || !inFlow(el) || !el.parentElement) return;
    const sib = [...el.parentElement.children].filter(c => c === el || (!skipChild(c) && inFlow(c) && getComputedStyle(c).display !== 'none'));
    const other = sib[sib.indexOf(el) + d];
    if (!other) return;
    if (d < 0) other.before(el); else other.after(el);
    commit();
  }
  // A copy must not reuse ids, or url(#…) / href="#…" references (SVG gradients, markers) point at the original.
  let idSeq = 0;
  function uniquifyIds(root) {
    const map = new Map();
    for (const el of [root, ...root.querySelectorAll('[id]')]) {
      if (!el.id) continue;
      let n;
      do { n = `${el.id.replace(/-c\d+$/, '')}-c${++idSeq}`; } while (document.getElementById(n));
      map.set(el.id, n);
      el.id = n;
    }
    if (!map.size) return;
    for (const el of [root, ...root.querySelectorAll('*')]) {
      for (const a of [...el.attributes]) {
        let v = a.value;
        if ((a.name === 'href' || a.name === 'xlink:href') && v[0] === '#' && map.has(v.slice(1))) v = '#' + map.get(v.slice(1));
        else if (v.includes('url(#')) v = v.replace(/url\(#([^)]+)\)/g, (m, id) => (map.has(id) ? `url(#${map.get(id)})` : m));
        if (v !== a.value) el.setAttribute(a.name, v);
      }
    }
  }
  function duplicateSlide() {
    const s = curSlide();
    if (!s) return;
    stopEditing();
    const c = resetLive(s.cloneNode(true));
    c.classList.remove('dk-current');
    uniquifyIds(c);
    s.after(c);
    commit();
    go(cur + 1);
    buildThumbs();
  }
  function deleteSlide() {
    const s = slides();
    if (s.length <= 1) return toast('Can\'t delete the last slide');
    stopEditing(false);
    select(null);
    removeWithSpace(s[cur]);
    commit();
    go(Math.min(cur, s.length - 2));
    buildThumbs();
    toast('Slide deleted · ⌘Z to undo');
  }
  // `text` (pasted with nothing being edited): the box holds it, one line per line, and is selected.
  function addTextBox(text) {
    const s = curSlide();
    if (!s) return;
    const anchor = selected && slideChild(selected);
    stopEditing();
    const p = document.createElement('p');
    const lines = text == null ? ['Text'] : String(text).replace(/\r\n?/g, '\n').replace(/^\n+|\s+$/g, '').split('\n');
    lines.forEach((l, i) => { if (i) p.appendChild(document.createElement('br')); p.appendChild(document.createTextNode(l)); });
    // As wide as its text, wrapping at the slide's right margin, so the box never reaches past what it shows. It goes
    // at the content's left edge under what is there (or under the selected object), else in a free spot.
    const ss = getComputedStyle(s), pl = parseFloat(ss.paddingLeft) || 0, pr = parseFloat(ss.paddingRight) || 0;
    const room = Math.max(300, W - pl - pr);
    const [nw, nh] = text == null ? [400, 80] : naturalSize(p, room);
    const w = Math.max(120, nw), h = Math.max(80, nh);
    const spot = spotBelow(s, anchor, pl, w, h) || freeSpot(w, h);
    placeAbs(p, room, h, false, w, spot);
    p.style.maxWidth = Math.max(120, Math.min(room, W - pr - spot[0])) + 'px';
    p.style.width = 'max-content';
    putIn(s, p, notesOf(s));
    finishInsert(p, text == null ? p : null);
  }
  // Under the selected object, or under the slide's content at its left edge, when a w×h box fits there uncovered.
  function spotBelow(s, anchor, left, w, h) {
    const sr = s.getBoundingClientRect(), ss = getComputedStyle(s);
    const pb = parseFloat(ss.paddingBottom) || 0;
    let x = left, y;
    if (anchor && shown(anchor) && !anchor.matches('aside.notes')) {
      const r = toSlide(tightRect(anchor), sr);
      if (!inFlow(anchor)) x = Math.max(0, r.left);
      y = r.bottom + 40;
    } else {
      const flows = [...s.children].filter(c => shown(c) && inFlow(c)).flatMap(c => visibleRects(c)).map(r => toSlide(r, sr));
      if (!flows.length) return null;
      y = Math.max(...flows.map(r => r.bottom)) + 60;
    }
    x = Math.round(x); y = Math.round(y);
    if (y + h > H - pb / 2 || x + w > W) return null;
    const AIR = 24, me = { left: x - AIR, top: y - AIR, right: x + w + AIR, bottom: y + h + AIR };
    return occupied(s).some(r => overlapArea(me, r) > 0) ? null : [x, y, false];
  }
  // ---------- copy and paste of objects ----------
  // ⌘C / ⌘X with objects selected (and no text being edited) put them on the clipboard as their HTML, marked as ours;
  // ⌘V puts them on the slide on screen, selected. One undo step each.
  const CLIP = 'data-dk-objects';
  function copyObjects(e, cut) {
    if (mode !== 'edit' || editing || !sel.length || navFocus || sidebar.contains(document.activeElement) || !e.clipboardData) return;
    const s = getSelection();
    if (s.rangeCount && !s.isCollapsed && !deck.contains(s.anchorNode)) return;
    e.preventDefault();
    // A figure's caption or picture is copied with its figure.
    const whole = [...new Set(sel.map(el => (el.tagName === 'FIGCAPTION' || figureMedia(el) ? el.closest('figure') : el)))];
    const parts = whole.map(el => tidySvg(cleanClone(el).outerHTML));
    e.clipboardData.setData('text/html', `<div ${CLIP}="1">${parts.join('\n')}</div>`);
    e.clipboardData.setData('text/plain', sel.map(el => cleanClone(el).textContent.replace(/\s+/g, ' ').trim()).filter(Boolean).join('\n'));
    if (cut) removeSelected();
    else toast(sel.length > 1 ? `${sel.length} copied · ⌘V on another slide` : 'Copied · ⌘V on another slide', 1800);
  }
  // ⌘C / ⌘X on text being edited: formulas go out as their TeX (as <span class="math"> in our own HTML, as $TeX$ in
  // plain text), never as the rendered formula's letters. Pasted back into the deck, our HTML keeps bold, code, links
  // and formulas; anything else is pasted as plain text.
  const TEXT_CLIP = 'data-dk-text';
  const BLOCKISH = /^(P|LI|H[1-6]|DIV|BLOCKQUOTE|PRE|TR|UL|OL|FIGCAPTION|TABLE|TBODY|THEAD|SECTION|FIGURE|DT|DD)$/;
  const texOf = m => (m.hasAttribute('data-dk-tex') ? m.getAttribute('data-dk-tex') : m.textContent);
  function copyText(e, cut) {
    if (mode !== 'edit' || !editing || composing || !e.clipboardData || editing.classList.contains('math')) return false;
    const s = getSelection();
    if (!s.rangeCount || s.isCollapsed || !editing.contains(s.anchorNode)) return false;
    const r = clampToRun(s.getRangeAt(0));
    const mathAt = n => { const el = n && (n.nodeType === 1 ? n : n.parentElement); const m = el && el.closest('.math'); return m && m !== editing && editing.contains(m) ? m : null; };
    const m1 = mathAt(r.startContainer), m2 = mathAt(r.endContainer);
    if (m1) r.setStartBefore(m1);
    if (m2) r.setEndAfter(m2);
    const box = document.createElement('div');
    box.appendChild(r.cloneContents());
    box.querySelectorAll('.math').forEach(m => { const k = document.createElement('span'); k.className = 'math'; k.textContent = texOf(m); m.replaceWith(k); });
    const clean = cleanClone(box);
    // Plain text: one line per paragraph or bullet, a formula as $TeX$.
    const lines = [''];
    const walk = n => {
      for (const c of n.childNodes) {
        if (c.nodeType === 3) lines[lines.length - 1] += c.data.replace(/\s+/g, ' ');
        else if (c.nodeType !== 1) continue;
        else if (c.classList.contains('math')) lines[lines.length - 1] += '$' + c.textContent + '$';
        else if (c.tagName === 'BR') lines.push('');
        else if (BLOCKISH.test(c.tagName)) { lines.push(''); walk(c); lines.push(''); }
        else walk(c);
      }
    };
    walk(clean);
    const plain = lines.map(l => l.trim()).filter(Boolean).join('\n');
    e.preventDefault();
    e.clipboardData.setData('text/html', `<div ${TEXT_CLIP}="1">${clean.innerHTML}</div>`);
    e.clipboardData.setData('text/plain', plain);
    if (cut) {
      s.removeAllRanges();
      s.addRange(r);
      if (multiBlockRange()) deleteRange();
      else { quiet++; try { document.execCommand('delete'); } finally { quiet--; } }
      plainSpaceAtCaret();
      scheduleCommit();
    }
    return true;
  }
  // Our own copied text, pasted while editing: lines of inline content (text, bold, italic, code, links, formulas).
  function pasteText(markup) {
    const t = document.createElement('template');
    t.innerHTML = markup;
    const box = t.content.querySelector('[' + TEXT_CLIP + ']');
    if (!box || !editing || composing || editing.getAttribute('contenteditable') === 'plaintext-only') return false;
    const lines = [document.createDocumentFragment()];
    const cur = () => lines[lines.length - 1];
    const brk = () => { if (cur().childNodes.length) lines.push(document.createDocumentFragment()); };
    const INLINE = /^(B|I|S|U|STRONG|EM|CODE|A|SUB|SUP|MARK|STRIKE)$/;
    const walk = (n, into) => {
      for (const c of n.childNodes) {
        const to = into || cur();
        if (c.nodeType === 3) { const x = c.data.replace(/\s+/g, ' '); if (x) to.appendChild(document.createTextNode(x)); continue; }
        if (c.nodeType !== 1) continue;
        if (c.classList.contains('math')) { const m = document.createElement('span'); m.className = 'math'; m.textContent = c.textContent; to.appendChild(m); continue; }
        if (c.tagName === 'BR') { if (!into) brk(); continue; }
        if (BLOCKISH.test(c.tagName) && !into) { brk(); walk(c, null); brk(); continue; }
        if (INLINE.test(c.tagName)) {
          const k = document.createElement(c.tagName.toLowerCase());
          if (c.tagName === 'A' && c.getAttribute('href')) k.setAttribute('href', c.getAttribute('href'));
          to.appendChild(k);
          walk(c, k);
          continue;
        }
        walk(c, into);
      }
    };
    walk(box, null);
    const blank = f => !f.textContent.trim() && !f.querySelector('.math');
    let list = lines.filter(f => !blank(f));
    if (!list.length) return true;
    // Spaces from the source's line breaks at the edges of a paragraph are not text.
    if (list.length > 1) list.forEach(f => {
      const a = f.firstChild, z = f.lastChild;
      if (a && a.nodeType === 3) a.data = a.data.replace(/^ +/, '');
      if (z && z.nodeType === 3) z.data = z.data.replace(/ +$/, '');
    });
    clampRunSelection();
    if (multiBlockRange()) deleteRange();
    const b = curBlock();
    const split = list.length > 1 && !!b && b !== editing && canSplit(b);
    const maths = [];
    list.forEach((f, i) => {
      if (i) { if (split) splitBlock(false); else { quiet++; try { document.execCommand('insertLineBreak'); } finally { quiet--; } } }
      const s = getSelection();
      if (!s.rangeCount) return;
      const r = s.getRangeAt(0);
      r.deleteContents();
      f.querySelectorAll('.math').forEach(m => { m.setAttribute('contenteditable', 'false'); maths.push(m); });
      if (f.lastChild && f.lastChild.nodeType === 1 && f.lastChild.classList.contains('math')) f.appendChild(document.createTextNode('\u200b'));
      const end = f.lastChild;
      r.insertNode(f);
      if (end.nodeType === 3) placeCaret(end, end.length);
      else { const c = document.createRange(); c.setStartAfter(end); c.collapse(true); s.removeAllRanges(); s.addRange(c); }
    });
    loadKatex().then(() => { maths.forEach(m => { if (m.isConnected) renderMathEl(m); }); scheduleThumbs(); drawSel(); });
    sanitizeSpans();
    return true;
  }
  function pasteObjects(markup) {
    const s = curSlide();
    if (!s) return;
    const t = document.createElement('template');
    t.innerHTML = markup;
    stampLive(t.content);
    const box = t.content.querySelector('[' + CLIP + ']');
    const els = box ? [...box.children] : [];
    if (!els.length) return;
    stopEditing();
    hideToast();
    const here = new Set([...s.children].map(c => tidySvg(cleanClone(c).outerHTML)));
    let anchor = selected && slideChild(selected);
    if (anchor && (anchor.matches('aside.notes') || !inFlow(anchor))) anchor = null;
    // Pasted where it was copied from (or where an earlier paste went): all of it steps 30px down-right, as often as
    // it takes to land on no other object's spot, so copies never stack on each other.
    const floating = els.filter(el => /^(absolute|fixed)$/.test(el.style.position) && /^-?[\d.]+px$/.test(el.style.left) && /^-?[\d.]+px$/.test(el.style.top));
    const spots = new Set([...s.children].filter(c => c.style && c.style.left && c.style.top).map(c => parseFloat(c.style.left) + ',' + parseFloat(c.style.top)));
    let shift = floating.some(el => here.has(tidySvg(el.outerHTML))) ? 1 : 0;
    while (shift < 60 && floating.some(el => spots.has((parseFloat(el.style.left) + 30 * shift) + ',' + (parseFloat(el.style.top) + 30 * shift)))) shift++;
    const added = [];
    for (let el of els) {
      uniquifyIds(el);
      // A caption, bullet or table cell copied alone never lands on the slide bare.
      if (el.tagName === 'FIGCAPTION') { const f = document.createElement('figure'); f.appendChild(el); el = f; }
      else if (el.tagName === 'LI') { const l = document.createElement('ul'); l.appendChild(el); el = l; }
      else if (/^(TR|TD|TH)$/.test(el.tagName)) { const t = document.createElement('table'); t.innerHTML = '<tbody><tr></tr></tbody>'; if (el.tagName === 'TR') t.tBodies[0].replaceChildren(el); else t.rows[0].appendChild(el); el = t; }
      if (/^(absolute|fixed)$/.test(el.style.position)) {
        if (shift && floating.includes(el)) for (const k of ['left', 'top']) el.style[k] = Math.round(parseFloat(el.style[k]) + 30 * shift) + 'px';
        putIn(s, el, notesOf(s));
      } else if (anchor) { putAfter(anchor, el); anchor = el; }
      else putIn(s, el, notesOf(s));
      added.push(el);
    }
    if (added.some(el => el.matches('.math') || el.querySelector('.math'))) loadKatex().then(() => { added.forEach(el => renderMath(el.parentElement || s)); scheduleThumbs(); });
    renderMath(s);
    setSel(added);
    commit();
    scheduleThumbs();
  }

  // ---------- images ----------
  let pendingImageTarget = null;
  async function requestImage(target, anchor) {
    if (!dirOK) return showImageCard(target, anchor);
    return pickImage(target);
  }
  async function pickImage(target) {
    pendingImageTarget = target || null;
    try {
      if (window.showOpenFilePicker) {
        const [fh] = await window.showOpenFilePicker({
          types: [{ description: 'Images', accept: { 'image/*': ['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.avif'] } }],
        });
        await placeImage(await fh.getFile(), pendingImageTarget);
        pendingImageTarget = null;
      } else {
        fileInput.click();
      }
      return true;
    } catch (err) {
      if (err.name === 'AbortError') return true;
      // The folder picker may have used up this click; the caller then offers a fresh button.
      if (err.name === 'SecurityError' || err.name === 'NotAllowedError') return false;
      fileInput.click();
      return true;
    }
  }
  // Images are copied into the deck's assets/ folder, so the folder must be connected first.
  // Explain that once, next to the button, instead of opening a folder picker out of nowhere.
  let popTarget = null;
  function showImageCard(target, anchor) {
    closeMenu();
    popTarget = target || null;
    const pop = $('.pop');
    pop.querySelector('.msg').textContent = 'Images are saved in this deck folder\'s assets/. Pick the folder once.';
    pop.querySelector('.acts').innerHTML = '<button data-pop="close">Cancel</button><button class="primary" data-pop="connect">Choose folder</button>';
    pop.classList.add('show');
    const a = anchor && anchor.getBoundingClientRect().width ? anchor : $('.bar [data-act="image"]');
    const r = a.getBoundingClientRect();
    pop.style.left = Math.max(6, Math.min(r.left, innerWidth - pop.offsetWidth - 6)) + 'px';
    pop.style.top = Math.min(r.bottom + 8, innerHeight - pop.offsetHeight - 6) + 'px';
  }
  function closePop() { const p = shadow && $('.pop'); if (p) p.classList.remove('show'); }
  async function popAction(a) {
    if (a === 'close') return closePop();
    if (a === 'pick') { closePop(); return pickImage(popTarget); }
    if (a === 'connect') {
      if (!(await ensureDir(true))) return;
      if (await pickImage(popTarget)) return closePop();
      $('.pop .msg').textContent = 'Connected. Now pick an image to add.';
      $('.pop .acts').innerHTML = '<button data-pop="close">Close</button><button class="primary" data-pop="pick">Choose image</button>';
    }
  }
  async function storeAsset(file) {
    const d = await ensureDir(false);
    if (!d) {
      toast('Connect the folder first to add images (press Save once)');
      return null;
    }
    const assets = await d.getDirectoryHandle('assets', { create: true });
    const dot = file.name.lastIndexOf('.');
    const ext = dot > 0 ? file.name.slice(dot).toLowerCase() : '.' + ((file.type.split('/')[1] || 'png').replace('jpeg', 'jpg').replace('svg+xml', 'svg'));
    const base = (dot > 0 ? file.name.slice(0, dot) : 'image').replace(/[^\w가-힣.-]+/g, '-').replace(/^-+|-+$/g, '') || 'image';
    let name = base + ext;
    for (let k = 2; ; k++) {
      try { await assets.getFileHandle(name); name = `${base}-${k}${ext}`; } catch (_) { break; }
    }
    const fh = await assets.getFileHandle(name, { create: true });
    const w = await fh.createWritable();
    await w.write(file);
    await w.close();
    return 'assets/' + name;
  }
  async function placeImage(file, target, at) {
    if (!file || !file.type.startsWith('image/')) return;
    const src = await storeAsset(file);
    if (!src) return;
    hideToast();
    stopEditing();
    const s = curSlide();
    const plain = () => { const img = document.createElement('img'); img.setAttribute('src', src); img.setAttribute('alt', ''); return img; };
    const fig = !target && !at && emptyFigure(s);
    if (target && target.tagName === 'IMG') {
      target.setAttribute('src', src);
      target.removeAttribute('srcset');
      select(target);
    } else if (target && figureMedia(target)) {
      // The placeholder picture of a figure: the image takes its place, in the flow, above the caption.
      const img = plain();
      target.replaceWith(img);
      select(img);
    } else if (fig) {
      // A figure with no picture (its placeholder was deleted): the image goes into it, before the caption.
      const img = plain();
      putIn(fig, img, [...fig.children].find(c => c.tagName === 'FIGCAPTION') || null);
      select(img);
    } else {
      let nw = 800, nh = 600;
      try { const bmp = await createImageBitmap(file); nw = bmp.width; nh = bmp.height; bmp.close(); } catch (_) {}
      // As big as the largest free space allows (never above its own size), its shape kept.
      const w0 = Math.max(1, Math.min(nw, W - 160, (H - 160) * nw / nh));
      let w = w0, spot = null;
      if (at) { w = Math.min(w0, W * 0.5); spot = [at[0] - w / 2, at[1] - w * nh / nw / 2]; }
      else {
        for (let f = 1; ; f *= 0.88) {
          const ww = Math.round(w0 * f), sp = freeSpot(ww, Math.round(ww * nh / nw));
          if (!spot || !sp[2]) { w = ww; spot = sp; }
          if (!sp[2] || ww * 0.88 < Math.min(160, w0)) break;
        }
        if (spot[2]) toast('No free spot, so it overlaps · drag it into place', 3500);
      }
      const img = plain();
      img.style.cssText = `position:absolute; left:${Math.round(spot[0])}px; top:${Math.round(spot[1])}px; width:${Math.round(w)}px; height:auto;`;
      putIn(s, img, notesOf(s));
      select(img);
    }
    commit();
    scheduleThumbs();
  }
  // A picture standing in a figure (the template's example chart, or an image), which Replace image replaces.
  function figureMedia(el) {
    return !!el && el.nodeType === 1 && (isMedia(el) || el.tagName === 'svg') && !!el.parentElement && el.parentElement.tagName === 'FIGURE' && !!curSlide() && curSlide().contains(el);
  }
  function emptyFigure(s) {
    return s ? [...s.querySelectorAll('figure')].find(f => !f.querySelector('img, svg, video, canvas, picture, iframe, object')) || null : null;
  }
  function slidePoint(cx, cy) {
    const r = curSlide().getBoundingClientRect();
    return [(cx - r.left) / scale, (cy - r.top) / scale];
  }

  // ---------- saving & watching the file ----------
  function idb() {
    return new Promise((res, rej) => {
      const r = indexedDB.open('deck-edit', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('dirs');
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
  }
  async function idbGet(k) {
    try {
      const db = await idb();
      return await new Promise(res => {
        const q = db.transaction('dirs').objectStore('dirs').get(k);
        q.onsuccess = () => res(q.result || null);
        q.onerror = () => res(null);
      });
    } catch (_) { return null; }
  }
  async function idbSet(k, v) {
    try {
      const db = await idb();
      db.transaction('dirs', 'readwrite').objectStore('dirs').put(v, k);
    } catch (_) {}
  }

  // Chromium refuses folders under ~/Library (iCloud Drive's real location, cloud-storage mounts) as "system files".
  const blockedPlace = () => /^\/Users\/[^/]+\/Library\//.test(DIR_KEY);
  const dirName = () => DIR_KEY.split('/').filter(Boolean).pop() || '';
  // One remembered picker location per deck folder, so the picker never opens in another deck's folder.
  function pickerId() {
    let h = 0;
    for (const ch of DIR_KEY) h = (h * 31 + ch.charCodeAt(0)) | 0;
    return 'deck-' + (h >>> 0).toString(36);
  }

  // Opened through `deck open`, the page is served by a small server on this Mac (deck serve) and reads and writes its
  // folder through it: no folder picker, ever. The handle below behaves like the browser's folder handle.
  let serverMode = false;
  function httpDir(base, name) {
    const stat = async p => {
      const r = await fetch(base + p, { method: 'HEAD', cache: 'no-store' });
      if (!r.ok) throw new DOMException(p + ' not found', 'NotFoundError');
      return +r.headers.get('x-mtime') || Date.now();
    };
    const file = (p, fname) => ({
      kind: 'file', name: fname,
      async getFile() {
        const lastModified = await stat(p);
        const body = async () => { const r = await fetch(base + p, { cache: 'no-store' }); if (!r.ok) throw new DOMException(p + ' not found', 'NotFoundError'); return r; };
        return { name: fname, lastModified, text: async () => (await body()).text(), arrayBuffer: async () => (await body()).arrayBuffer() };
      },
      async createWritable() {
        const chunks = [];
        return {
          write: async d => { chunks.push(d); },
          close: async () => {
            const r = await fetch(base + p, { method: 'PUT', body: new Blob(chunks) });
            if (!r.ok) throw new DOMException(`couldn't write ${fname} (${r.status})`, r.status === 403 ? 'NotAllowedError' : 'InvalidStateError');
          },
        };
      },
    });
    const folder = (prefix, fname) => ({
      kind: 'directory', name: fname,
      async getFileHandle(n, o = {}) {
        if (!o.create) await stat(prefix + encodeURIComponent(n));
        return file(prefix + encodeURIComponent(n), n);
      },
      async getDirectoryHandle(n) { return folder(prefix + encodeURIComponent(n) + '/', n); },
      async queryPermission() { return 'granted'; },
      async requestPermission() { return 'granted'; },
    });
    return folder('', name);
  }
  async function findServer() {
    if (location.protocol !== 'http:' || !/^(127\.0\.0\.1|localhost)$/.test(location.hostname)) return null;
    const [, mark, token] = location.pathname.split('/');
    if (mark !== '_deck' || !token) return null;
    try {
      const r = await fetch(`/_deck/${token}/__deck`, { cache: 'no-store' });
      return r.ok && (await r.json()).deck ? httpDir(location.pathname.replace(/[^/]*$/, ''), dirName()) : null;
    } catch (_) { return null; }
  }
  // Shown inside another site's frame (Claude's artifact viewer, say): the page cannot write to this Mac's files.
  const framed = (() => { try { return window.top !== window.self && !window.top.location.href; } catch (_) { return true; } })();

  // Saving by itself: a moment after the last edit, once the folder is connected (or the server serves the deck).
  const AUTOSAVE = !(window.deckEditOptions && window.deckEditOptions.autosave === false);
  let autoTimer = 0;
  function scheduleAutosave(reset = true) {
    if (!AUTOSAVE || !dir || !dirOK || (autoTimer && !reset)) return;
    clearTimeout(autoTimer);
    autoTimer = setTimeout(autosave, 1500);
  }
  async function autosave() {
    autoTimer = 0;
    if (!dirOK || saving || !isDirty()) return;
    if (composing || dragging || pointerDown || reloading || $('.banner').classList.contains('show')) return scheduleAutosave();
    await save({ quiet: true });
  }

  // Get write access to the deck's folder. Showing the picker needs a fresh user gesture, hence `pick`.
  async function ensureDir(interactive, { pick = true, force = false } = {}) {
    if (serverMode) {
      if (!dirOK) {
        const sv = await findServer();
        if (sv) { dir = sv; dirOK = true; await connected(); }
        else if (interactive) toast('The deck server stopped. Open the deck again with deck open (or ask the AI to), and nothing typed here is lost until you close this tab', 8000);
      }
      return dirOK ? dir : null;
    }
    if (dir && dirOK && !force) return dir;
    if (framed) return null;
    if (!window.showDirectoryPicker) return null;
    if (dir && !force) {
      let p = 'prompt';
      try {
        p = await dir.queryPermission({ mode: 'readwrite' });
        if (p !== 'granted' && interactive) p = await dir.requestPermission({ mode: 'readwrite' });
      } catch (_) {}
      if (p === 'granted') {
        dirOK = true;
        await connected();
        return dirOK ? dir : null;
      }
      if (!interactive || !pick || p === 'denied') return null;
    }
    if (!interactive || !pick) return null;
    if (blockedPlace()) {
      toast('This file is under ~/Library (e.g. an iCloud Drive app folder), where the browser blocks saving. Move it to a folder under Documents or Desktop', 9000);
      return null;
    }
    let picked;
    try {
      toast(`Pick the '${dirName()}' folder that contains ${FILE}`, 6000);
      picked = await window.showDirectoryPicker({ id: pickerId(), mode: 'readwrite' });
    } catch (err) {
      if (err.name !== 'AbortError') toast('Couldn\'t open the folder picker. Try again', 5000);
      return null;
    }
    if (dirName() && picked.name !== dirName()) {
      toast(`You picked the '${picked.name}' folder. Pick the '${dirName()}' folder that contains ${FILE}`, 6000);
      return null;
    }
    try { await picked.getFileHandle(FILE); } catch (_) {
      toast(`The folder you picked has no ${FILE}. Pick the folder that contains ${FILE}`, 5000);
      return null;
    }
    dir = picked;
    dirOK = true;
    await idbSet(DIR_KEY, dir);
    await connected();
    return dirOK ? dir : null;
  }
  const LOST = ['NotAllowedError', 'NotFoundError', 'SecurityError', 'InvalidStateError', 'TypeError'];
  function disconnect(err) {
    dirOK = false;
    if (err && err.name === 'NotFoundError') dir = null;   // folder or file moved: pick again next time
    clearInterval(watchTimer);
    updateStatus();
  }
  async function connected() {
    clearInterval(watchTimer);
    const stamp = reloadStamp;
    reloadStamp = null;   // only the first look after a reload may take the disk as it is
    try {
      const f = await (await dir.getFileHandle(FILE)).getFile();
      const text = await f.text();
      lastMod = f.lastModified;
      if (!looksComplete(text)) {
        lastMod = 0;   // the AI is still writing it: the watcher looks again
      } else {
        // First look at the disk since this page loaded: the AI may have changed the file in the meantime.
        const changed = diskText === null ? !sameDeck(deckFromText(text), baseline) : text !== diskText;
        if (changed && diskText === null && stamp !== null && hashText(text) === stamp) {
          // We reloaded a moment ago for exactly this file, so the page already shows it; a difference here is
          // only how the browser (or an extension) altered the page. Never reload again in a loop.
          diskText = text;
          baseline = deckFromText(text) ?? baseline;
          setSaved(baseline);
          updateStatus();
        } else if (changed) onExternalChange(text);
        else diskText = text;
        if (diskText === text) noteOrigins(text);
      }
    } catch (err) {
      disconnect(err);
      return;
    }
    watchTimer = setInterval(checkDisk, 1200);
    updateStatus();
  }
  async function checkDisk() {
    if (checking || !dir || !dirOK) return;
    try { await checkDiskNow(); } finally { pollsDone++; }
  }
  async function checkDiskNow() {
    checking = true;
    try {
      const f = await (await dir.getFileHandle(FILE)).getFile();
      if (f.lastModified !== lastMod) {
        const text = await f.text();
        // A file the AI is still writing (cut off, no deck end or no script) is left alone until it is whole.
        if (text === diskText || (diskText === null && sameDeck(deckFromText(text), baseline))) { lastMod = f.lastModified; diskText = text; }
        else if (looksComplete(text)) { lastMod = f.lastModified; onExternalChange(text); }
      }
    } catch (err) {
      disconnect(err);
      toast('Lost the folder connection. Press Save to reconnect', 5000);
    } finally {
      checking = false;
    }
  }
  // A whole deck file: the deck and every slide close, this script is still loaded, and it ends like the file did.
  const SELF_NAME = ((document.currentScript && document.currentScript.getAttribute('src')) || '').split(/[?#]/)[0].split('/').pop();
  function looksComplete(text) {
    const loc = locateDeck(text);
    if (!loc || !splitSlides(text.slice(loc.start, loc.end))) return false;
    if (SELF_NAME && !text.includes(SELF_NAME)) return false;
    if (/<\/html\s*>/i.test(diskText || '') && !/<\/html\s*>/i.test(text)) return false;
    return true;
  }
  function hashText(t) {
    let h = 0x811c9dc5;
    for (let i = 0; i < t.length; i++) h = Math.imul(h ^ t.charCodeAt(i), 16777619);
    return (h >>> 0).toString(36) + ':' + t.length;
  }

  // ---------- merging the AI's edits with mine ----------
  const slideCache = new Map();
  function slideList(inner) {
    const hit = slideCache.get(inner);
    if (hit) return hit;
    const t = document.createElement('template');
    t.innerHTML = inner;
    const out = [...t.content.children].filter(e => e.classList.contains('slide')).map(e => tidySvg(cleanClone(e).outerHTML));
    if (slideCache.size > 400) slideCache.clear();
    slideCache.set(inner, out);
    return out;
  }
  const sameList2 = (x, y) => x.length === y.length && x.every((v, k) => v === y[k]);
  // Two deck texts with the same slides (only the spacing or comments between slides differ).
  const sameDeck = (a, b) => a === b || (a != null && b != null && sameList2(slideList(a), slideList(b)));
  function lcsPairs(a, b) {
    const n = a.length, m = b.length;
    const dp = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
    const pairs = [];
    for (let i = 0, j = 0; i < n && j < m;) {
      if (a[i] === b[j]) { pairs.push([i, j]); i++; j++; } else if (dp[i + 1][j] >= dp[i][j + 1]) i++; else j++;
    }
    return pairs;
  }
  // The text of a slide's first heading, to recognise a slide that was both moved and edited.
  const headOf = s => { const m = /<h[1-6]\b[^>]*>([\s\S]*?)<\/h[1-6]>/i.exec(s || ''); return m ? m[1].replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim() || null : null; };
  // What became of each base slide on one side: m[k] is its index in X, or -1 when that side deleted it. A slide that
  // is still there unchanged is found wherever it is now (moved is not deleted and added again); then, between two
  // such slides in the same order, a slide in the same place is the same slide edited; last, a slide with the same
  // first heading is the same slide moved and edited. Slides of X no base slide maps to were added.
  function matchSlides(B, X) {
    const m = new Array(B.length).fill(-1), used = new Array(X.length).fill(false);
    for (const [b, x] of lcsPairs(B, X)) { m[b] = x; used[x] = true; }
    for (let b = 0; b < B.length; b++) {
      if (m[b] >= 0) continue;
      const x = X.findIndex((v, j) => !used[j] && v === B[b]);
      if (x >= 0) { m[b] = x; used[x] = true; }
    }
    for (let b = 0; b < B.length; b++) {
      if (m[b] >= 0) continue;
      let pb = b - 1; while (pb >= 0 && m[pb] < 0) pb--;
      let nb = b + 1; while (nb < B.length && m[nb] < 0) nb++;
      const lo = pb >= 0 ? m[pb] : -1, hi = nb < B.length ? m[nb] : X.length;
      // In that gap, the slide most like it (a slide added in front of an edited one is not it); none alike enough:
      // it was deleted and the others were added.
      const free = []; for (let j = lo + 1; j < hi; j++) if (!used[j]) free.push(j);
      const j = likest(B[b], free.map(x => X[x]));
      if (j >= 0) { m[b] = free[j]; used[free[j]] = true; }
    }
    for (let b = 0; b < B.length; b++) {
      const h = m[b] < 0 && headOf(B[b]);
      if (!h) continue;
      const xs = X.map((v, j) => j).filter(j => !used[j] && headOf(X[j]) === h);
      const j = likest(B[b], xs.map(x => X[x]));
      if (j >= 0) { m[b] = xs[j]; used[xs[j]] = true; }
    }
    return m;
  }
  // How alike two versions of a slide are, 0…1 (plus a little for the same first heading): the share of words they
  // have in common, or of their lines of text that stay in the same order, whichever is higher. An edited slide
  // keeps most of either; a different slide with the same layout (another results table) does not.
  const wordCache = new Map();
  function slideWords(s) {
    let w = wordCache.get(s);
    if (w) return w;
    const text = s.replace(/<(style|script)\b[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ');
    const words = new Set(text.toLowerCase().split(/\s+/).map(x => x.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '')).filter(Boolean));
    const lines = s.split('\n').map(l => l.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()).filter(Boolean);
    w = { words, lines };
    if (wordCache.size > 400) wordCache.clear();
    wordCache.set(s, w);
    return w;
  }
  function slideSim(a, b) {
    if (a === b) return 1.2;
    if (a == null || b == null) return 0;
    const A = slideWords(a), B = slideWords(b);
    let inter = 0;
    for (const x of A.words) if (B.words.has(x)) inter++;
    const uni = A.words.size + B.words.size - inter;
    const jac = uni ? inter / uni : 1;
    const n = A.lines.length + B.lines.length;
    const lines = n ? 2 * lcsPairs(A.lines, B.lines).length / n : 1;
    const h = headOf(a);
    return Math.max(jac, lines) + (h && h === headOf(b) ? 0.2 : 0);
  }
  const SAME_SLIDE = 0.4;
  // Index in `list` of the version of slide `s` most like it, or -1 when none is alike enough.
  function likest(s, list) {
    let best = -1, top = SAME_SLIDE - 1e-9;
    list.forEach((x, i) => { const v = slideSim(s, x); if (v > top) { top = v; best = i; } });
    return best;
  }
  // The longest run of entries whose values only go up (entries below 0 are left out), as a set of entry indexes.
  // `must`: an entry the run goes through (the slide on screen, which then never has to move).
  function increasing(vals, must = -1) {
    const idx = vals.map((v, i) => i).filter(i => vals[i] >= 0), n = idx.length;
    const s = new Set();
    if (!n) return s;
    const ok = (a, b) => vals[idx[a]] < vals[idx[b]];
    const end = new Array(n).fill(1), prev = new Array(n).fill(-1), beg = new Array(n).fill(1), next = new Array(n).fill(-1);
    for (let b = 0; b < n; b++) for (let a = 0; a < b; a++) if (ok(a, b) && end[a] + 1 > end[b]) { end[b] = end[a] + 1; prev[b] = a; }
    for (let a = n - 1; a >= 0; a--) for (let b = a + 1; b < n; b++) if (ok(a, b) && beg[b] + 1 > beg[a]) { beg[a] = beg[b] + 1; next[a] = b; }
    let m = idx.indexOf(must);
    if (m < 0) { m = 0; for (let i = 1; i < n; i++) if (end[i] + beg[i] > end[m] + beg[m]) m = i; }
    for (let i = m; i >= 0; i = prev[i]) s.add(idx[i]);
    for (let i = next[m]; i >= 0; i = next[i]) s.add(idx[i]);
    return s;
  }
  // Speaker notes are merged apart from what the slide shows: they are not visible, so a difference in them alone
  // must never look like a clash of the slide.
  function splitNotes(s) {
    const t = document.createElement('template');
    t.innerHTML = s;
    const el = t.content.firstElementChild;
    const n = el && [...el.children].find(c => c.matches('aside.notes'));
    if (!n) return { body: s, notes: null };
    const notes = n.outerHTML;
    removeWithSpace(n);
    return { body: tidySvg(el.outerHTML), notes };
  }
  // A slide with its notes set to `notes` (null: none), the rest kept as it is.
  function withNotes(s, notes) {
    const t = document.createElement('template');
    t.innerHTML = s;
    const el = t.content.firstElementChild;
    if (!el) return s;
    const old = [...el.children].find(c => c.matches('aside.notes'));
    if ((old ? old.outerHTML : null) === notes) return s;
    let fresh = null;
    if (notes !== null) { const u = document.createElement('template'); u.innerHTML = notes; fresh = u.content.firstElementChild; }
    if (old && fresh) old.replaceWith(fresh);
    else if (old) removeWithSpace(old);
    else if (fresh) {
      const last = el.lastElementChild, ws = last && isSpace(last.previousSibling) ? last.previousSibling.data : (/\n[ \t]*$/.exec(el.lastChild && el.lastChild.nodeType === 3 ? el.lastChild.data : '') || [''])[0] + '  ';
      if (last) last.after(ws, fresh); else el.append(fresh);
    }
    return tidySvg(el.outerHTML);
  }
  // One slide, three ways: b (base), a (mine), t (theirs); undefined means deleted on that side.
  function mergeSlide(b, a, t, prefer) {
    if (a === b) return { v: t };
    if (t === b || a === t) return { v: a };
    if (a === undefined || t === undefined) return { v: prefer === 'theirs' ? t : a, clash: a === undefined ? 'mine-deleted' : 'ai-deleted' };
    const B = splitNotes(b), A = splitNotes(a), T = splitNotes(t);
    const pick = (x, y, z) => (y === x ? { v: z, side: 't' } : z === x || y === z ? { v: y, side: 'a' } : null);
    const body = pick(B.body, A.body, T.body), notes = pick(B.notes, A.notes, T.notes);
    if (body && notes) return { v: withNotes(body.side === 'a' ? a : t, notes.v) };
    if (body) return { v: withNotes(body.side === 'a' ? a : t, prefer === 'theirs' ? T.notes : A.notes), clash: 'notes' };
    const side = prefer === 'theirs' ? t : a;
    return { v: notes ? withNotes(side, notes.v) : side, clash: 'slide' };
  }
  // Three-way merge of slide lists. Each slide is followed by identity (matchSlides), so a slide one side moved and
  // the other edited is moved and edited, never doubled or lost. A slide only one side changed is taken from that
  // side; the speaker notes and the rest of a slide are merged apart. Only a slide both sides changed differently,
  // or one side deleted and the other edited, is a conflict: `prefer` ('mine' or 'theirs') decides it, and it is
  // listed in `conflicts` ({ at, kind }). The order comes from the side that reordered slides (mine if both did);
  // what the other side added goes after the slide it follows there.
  // Returns also what the AI did (`ai`: indexes in the result of the slides it edited, added and moved, and how many
  // it deleted) and, for each slide in the result, which of my slides it is (`mineAt`, -1 for none).
  function merge3(base, mine, theirs, prefer = 'mine') {
    const ma = matchSlides(base, mine), mt = matchSlides(base, theirs);
    const reordered = m => { let last = -1; for (const x of m) { if (x < 0) continue; if (x < last) return true; last = x; } return false; };
    const pMine = reordered(ma) || !reordered(mt);
    // Both reordered: my order stands, so nothing the AI moved is reported as moved.
    const aiOrderKept = !pMine || !reordered(mt);
    const P = pMine ? { X: mine, m: ma, side: 'mine' } : { X: theirs, m: mt, side: 'theirs' };
    const O = pMine ? { X: theirs, m: mt, side: 'theirs' } : { X: mine, m: ma, side: 'mine' };
    const inv = m => { const r = new Map(); m.forEach((x, k) => { if (x >= 0) r.set(x, k); }); return r; };
    const invP = inv(P.m), invO = inv(O.m);
    const seq = P.X.map((s, j) => (invP.has(j) ? { k: invP.get(j) } : { ins: s, side: P.side, j }));
    let anchor = -1;
    O.X.forEach((s, j) => {
      const k = invO.has(j) ? invO.get(j) : -1;
      if (k >= 0 && P.m[k] >= 0) { anchor = k; return; }
      if (k < 0) {
        // Both added the very same slide: once.
        const twin = seq.find(e => e.ins === s && !e.twin && e.side === P.side);
        if (twin) { twin.twin = true; twin[O.side + 'J'] = j; return; }
      }
      let at = anchor < 0 ? 0 : seq.findIndex(e => e.k === anchor) + 1;
      while (at < seq.length && seq[at].k === undefined) at++;
      seq.splice(at, 0, k >= 0 ? { k } : { ins: s, side: O.side, j });
      if (k >= 0) anchor = k;
    });
    const list = [], conflicts = [], mineAt = [], theirsAt = [];
    const ai = { edited: [], added: [], moved: [], deleted: 0 };
    const stay = increasing(base.map((_, k) => mt[k]));
    for (const e of seq) {
      if (e.k === undefined) {
        list.push(e.ins);
        mineAt.push(e.side === 'mine' ? e.j : e.mineJ ?? -1);
        theirsAt.push(e.side === 'theirs' ? e.j : e.theirsJ ?? -1);
        if (e.side === 'theirs') ai.added.push(list.length - 1);
        continue;
      }
      const k = e.k;
      const r = mergeSlide(base[k], ma[k] >= 0 ? mine[ma[k]] : undefined, mt[k] >= 0 ? theirs[mt[k]] : undefined, prefer);
      if (r.clash) conflicts.push({ at: list.length, kind: r.clash, gone: r.v === undefined });
      if (r.v === undefined) continue;
      list.push(r.v);
      mineAt.push(ma[k]);
      theirsAt.push(mt[k]);
      if (!r.clash && mt[k] >= 0 && theirs[mt[k]] !== base[k]) ai.edited.push(list.length - 1);
      if (aiOrderKept && mt[k] >= 0 && !stay.has(k)) ai.moved.push(list.length - 1);
    }
    ai.deleted = base.filter((_, k) => mt[k] < 0).length;
    return { list, conflicts, ai, mineAt, theirsAt };
  }
  // Put the merged slides on screen without making an undo step: every step in the history gets the AI's changes
  // too, so ⌘Z only ever takes back my own edits. Returns the indexes of the slides that came in from the AI.
  function applyMerged(r, baseL, diskL, disk, prefer) {
    const list = r.list;
    const inner = l => (sameList2(l, diskL) ? disk : '\n' + l.join('\n') + '\n');
    const before = slideList(hist[hi]);
    if (!sameList2(list, before)) replaceSlides(list, r.mineAt);
    for (let k = 0; k < hist.length; k++) {
      if (k === hi) continue;
      hist[k] = inner(merge3(baseL, slideList(hist[k]), diskL, prefer).list);
    }
    hist[hi] = deckHTML();
    chipKey = '';
    updateTitle();
    updateStatus();
    const kept = new Set(before);
    return list.map((_, j) => j).filter(j => !kept.has(list[j]));
  }
  // Swap in a new slide list, touching only the slides that changed: every slide whose content is unchanged stays the
  // very same node, moved if it has to (never the one on screen while it can stay), so the slide being edited keeps its
  // caret, selection and a syllable being composed. `mineAt[j]`: which slide now on screen new slide j continues.
  // When the AI changed the slide being edited, typing goes on in the same paragraph if its text is unchanged;
  // otherwise the change is announced and letters typed in the next moment are not taken as shortcuts.
  let aiTookSlide = false, typeGuardUntil = 0;
  function replaceSlides(list, mineAt) {
    const nodes = slides();
    const sers = nodes.map(s => tidySvg(cleanClone(s).outerHTML));
    const from = new Map(), used = new Set();
    for (const [i, j] of lcsPairs(sers, list)) { from.set(j, i); used.add(i); }
    list.forEach((src, j) => {
      if (from.has(j)) return;
      const i = sers.findIndex((x, k) => !used.has(k) && x === src);
      if (i >= 0) { from.set(j, i); used.add(i); }
    });
    const shown = nodes[cur];
    let keep = null;
    if (shown && !used.has(cur)) {
      if (editing && shown.contains(editing) || editing === shown) keep = rememberPlace();
      dropEditing();
      select(null);
    }
    nodes.forEach((n, i) => { if (!used.has(i)) removeWithSpace(n); });
    const gap = '\n\n' + ((/\n([ \t]*)$/.exec(deck.firstChild && deck.firstChild.nodeType === 3 ? deck.firstChild.data : '') || ['', '  '])[1]);
    // The slides that stay where they are: the longest run already in order, through the one on screen.
    const order = list.map((_, j) => (from.has(j) ? from.get(j) : -1));
    const stay = increasing(order, used.has(cur) ? order.indexOf(cur) : -1);
    let prev = null;
    const nextSlide = n => { let e = n.nextElementSibling; while (e && !isSlide(e)) e = e.nextElementSibling; return e; };
    const now = list.map((src, j) => {
      let n = from.has(j) ? nodes[from.get(j)] : null;
      if (n && stay.has(j)) { prev = n; return n; }
      if (!n) {
        const t = document.createElement('template');
        t.innerHTML = src;
        n = stampLive(t.content).firstElementChild;
        renderMath(n);
      } else if (prev ? nextSlide(prev) === n : slides()[0] === n) { prev = n; return n; }
      else removeWithSpace(n);
      if (prev) prev.after(gap, n);
      else {
        const first = slides()[0];
        if (first) first.before(n, gap); else deck.append(gap, n, '\n');
      }
      prev = n;
      return n;
    });
    const at = now.indexOf(shown);
    const mine = mineAt ? mineAt.indexOf(cur) : -1;
    cur = at >= 0 ? at : mine >= 0 ? mine : Math.max(0, Math.min(cur, now.length - 1));
    go(cur);
    if (keep && mode === 'edit') {
      keep.slide = cur;
      const b = atPath(keep.edit);
      if (b && b.tagName === keep.tag && b.classList.contains('math') === !!keep.math && b.textContent === keep.text && (keep.math || textHost(b) === b || isTextFrame(b))) {
        select(keep.math ? b : textFrame(b));
        startEditing(b);
        restoreCaret(b, keep.off);
      } else {
        if (b) select(b.classList.contains('math') ? b : textFrame(b) || b);
        aiTookSlide = true;
        typeGuardUntil = Date.now() + 1500;
      }
    }
    updateCrumbs();
    buildThumbs();
  }
  // Style changes outside the slides are shown live: the deck's <style>s and <title>.
  function applyHead(text) {
    const doc = new DOMParser().parseFromString(text, 'text/html');
    const mine = [...document.querySelectorAll('head style:not([' + RT + '])')];
    const theirs = [...doc.querySelectorAll('head style')];
    let changed = false;
    if (mine.length === theirs.length) {
      mine.forEach((st, i) => { if (st.textContent !== theirs[i].textContent) { st.textContent = theirs[i].textContent; changed = true; } });
    } else {
      const ref = document.head.querySelector('style[' + RT + ']');
      mine.forEach(s => s.remove());
      for (const t of theirs) {
        const s = document.createElement('style');
        for (const a of t.attributes) s.setAttribute(a.name, a.value);
        s.textContent = t.textContent;
        document.head.insertBefore(s, ref);
      }
      changed = true;
    }
    // A stylesheet link the AI added is loaded at once, also while there are unsaved edits.
    const have = new Set([...document.querySelectorAll('link[rel~="stylesheet"]:not([' + RT + '])')].map(l => l.getAttribute('href')));
    for (const l of doc.querySelectorAll('head link[rel~="stylesheet"]')) {
      if (have.has(l.getAttribute('href'))) continue;
      const n = document.createElement('link');
      for (const a of l.attributes) n.setAttribute(a.name, a.value);
      n.addEventListener('load', () => { fixBackgrounds(); scheduleThumbs(); });
      document.head.insertBefore(n, document.head.querySelector('style[' + RT + ']'));
      changed = true;
    }
    const t = doc.querySelector('title');
    if (t && t.textContent !== fileTitle) {
      fileTitle = t.textContent;
      autoTitle = isAutoTitle();
      if (autoTitle) updateTitle(); else document.title = fileTitle;
    }
    if (changed) { fixBackgrounds(); scheduleThumbs(); }
  }
  // Scripts and stylesheets the page loads, and the slide size: a change there needs a fresh page.
  const loads = d => [...d.querySelectorAll('script, link')].filter(e => !e.hasAttribute(RT) && !e.closest('main'))
    .map(e => [e.tagName, e.getAttribute('src') || e.getAttribute('href') || e.textContent.trim(), e.getAttribute('rel') || ''].join('|'));
  function needsReload(text) {
    const doc = new DOMParser().parseFromString(text, 'text/html');
    const live = new Set(loads(document));
    const d = doc.querySelector('main.deck, .deck');
    return loads(doc).some(x => !live.has(x)) || (!!d && (d.getAttribute('data-size') || '1920x1080') !== (deck.getAttribute('data-size') || '1920x1080'));
  }
  let conflictDisk = null, conflictMarks = [], mergeSeq = 0, reloading = false, pendingShow = null;
  // While a syllable is being composed, right after typing, or while the mouse button is down (a drag, a resize),
  // the merge waits. Saving (`now`) merges at once.
  let pendingDisk = null, pendingTimer = 0, lastTypedAt = 0, pointerDown = false;
  function onExternalChange(text, now = false) {
    if (!now && (composing || dragging || pointerDown || (editing && Date.now() - lastTypedAt < 1200))) {
      pendingDisk = text;
      clearTimeout(pendingTimer);
      pendingTimer = setTimeout(() => { const t = pendingDisk; pendingDisk = null; if (t !== null) onExternalChange(t); }, 500);
      return;
    }
    pendingDisk = null;
    clearTimeout(pendingTimer);
    if (!looksComplete(text)) return;
    // Presenting full screen: the slides change after the talk, not in front of the audience.
    if (!now && mode === 'present' && document.fullscreenElement) { pendingShow = text; return; }
    diskText = text;
    if (needsReload(text) && !isDirty() && conflictDisk === null) return reloadInPlace();
    const disk = deckFromText(text);
    applyHead(text);
    if (disk === null) return;
    const baseL = slideList(baseline), diskL = slideList(disk);
    if (sameList2(baseL, diskL)) {
      // Only comments, styles or spacing changed, or the AI took back what clashed with mine: nothing to merge.
      baseline = disk;
      if (conflictDisk !== null) { conflictDisk = null; showConflict([]); }
      updateStatus();
      return;
    }
    commit();
    aiTookSlide = false;
    const r = merge3(baseL, slideList(hist[hi]), diskL, 'mine');
    const came = applyMerged(r, baseL, diskL, disk, 'mine');
    noteOrigins(text);
    mergeSeq++;
    if (r.conflicts.length) {
      // Everything else is merged; the slides both of us changed wait for a choice (the latest AI text counts).
      conflictDisk = disk;
      showConflict(r.conflicts);
      came.forEach(flashThumb);
      return;
    }
    conflictDisk = null;
    showConflict([]);
    came.forEach(flashThumb);
    baseline = disk;
    if (sameList2(slideList(hist[hi]), diskL)) setSaved(hist[hi]); else setSaved(disk);
    noteAI();
    const what = aiSummary(r.ai);
    toast(isDirty() ? what + ' · your edits are still here (not saved yet)' : what, 4500);
  }
  // What the AI did, in plain words: which slides it edited, added and moved, and how many it deleted.
  function aiSummary(ai) {
    const n = a => { const l = [...new Set(a)].map(i => i + 1); return (l.length > 1 ? 'slides ' : 'slide ') + l.join(', '); };
    const edited = ai.edited.filter(i => !(aiTookSlide && i === cur));
    const parts = [];
    if (aiTookSlide) parts.push('edited this slide');
    if (edited.length) parts.push('edited ' + n(edited));
    if (ai.added.length) parts.push('added ' + n(ai.added));
    if (ai.moved.length) parts.push('moved ' + n(ai.moved));
    if (ai.deleted) parts.push(`deleted ${ai.deleted} slide${ai.deleted === 1 ? '' : 's'}`);
    return 'AI ' + (parts.join(' · ') || 'edited the slides');
  }
  // The banner names the slides both sides changed, and their thumbnails are marked.
  function showConflict(conflicts) {
    const b = $('.banner');
    conflictMarks = conflicts.filter(c => !c.gone).map(c => c.at);
    if (!conflicts.length) { b.classList.remove('show'); buildThumbs(); return; }
    hideToast();
    const of = kind => conflicts.filter(c => c.kind === kind);
    const nums = list => { const l = [...new Set(list.filter(c => !c.gone).map(c => c.at + 1))]; return l.length ? (l.length > 1 ? 'slides ' : 'slide ') + l.join(', ') : 'the same slide'; };
    const parts = [];
    if (of('slide').length) parts.push(`The AI also edited ${nums(of('slide'))}`);
    if (of('notes').length) parts.push(`Only the speaker notes differ on ${nums(of('notes'))}`);
    if (of('ai-deleted').length) parts.push(`The AI deleted ${nums(of('ai-deleted'))}, which you edited`);
    if (of('mine-deleted').length) parts.push('The AI edited a slide you deleted');
    b.querySelector('.msg').textContent = parts.join(' · ') + '. Which version do you want to keep?';
    b.classList.add('show');
    buildThumbs();
  }
  // Keep mine / Use AI's: only the slides both sides changed follow the choice; every other change stays merged.
  // Taking the AI's version is an undo step of its own, so ⌘Z brings my version back.
  function resolveConflict(prefer) {
    if (conflictDisk === null) return showConflict([]);
    if (editing) stopEditing();
    commit();
    const disk = conflictDisk;
    const baseL = slideList(baseline), diskL = slideList(disk);
    const r = merge3(baseL, slideList(hist[hi]), diskL, prefer);
    if (!sameList2(r.list, slideList(hist[hi]))) {
      replaceSlides(r.list, r.mineAt);
      hist.splice(hi + 1);
      hist.push(deckHTML());
      hi = hist.length - 1;
      updateTitle();
    }
    conflictDisk = null;
    showConflict([]);
    baseline = disk;
    noteOrigins(diskText);
    if (sameList2(slideList(hist[hi]), diskL)) setSaved(hist[hi]); else setSaved(disk);
    mergeSeq++;
    updateStatus();
    toast(prefer === 'theirs' ? 'Switched to the AI\'s version · ⌘Z for yours' + (isDirty() ? ' (not saved yet)' : '') : 'Kept your version · ⌘S to save', 3500);
  }
  function reloadInPlace() {
    reloading = true;
    clearInterval(watchTimer);
    skipUnloadPrompt = true;
    try { sessionStorage.setItem(STATE_KEY, JSON.stringify({ mode, reloadedAt: Date.now(), disk: diskText === null ? null : hashText(diskText) })); } catch (_) {}
    location.reload();
  }
  function download(text) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: 'text/html' }));
    a.download = FILE;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  // The deck as it is once editing ends (blank bullets and placeholder line breaks dropped, &nbsp; made plain, empty
  // formatting removed), made on a copy: the page, the caret and a syllable being composed are left alone.
  function cleanedDeck() {
    if (!editing) return hist[hi];
    const c = cleanClone(deck);
    const cs = [...c.children].filter(e => e.classList.contains('slide'))[slides().indexOf(curSlide())];
    if (!cs) return hist[hi];
    const find = p => { let e = cs; for (const i of p || []) { e = e && e.children[i]; if (!e) return null; } return e === cs ? null : e; };
    const math = editing.classList.contains('math');
    const changed = math ? [] : leafBlocks().filter(b => editSnap.get(b) !== b.innerHTML).map(pathOf).map(find).filter(Boolean);
    changed.forEach(plainSpaces);
    if (math) { const root = find(pathOf(editing)); if (root && !root.textContent.trim()) removeWithSpace(root); }
    else {
      (editRun ? runKids(editing) : [editing]).map(pathOf).map(find).filter(Boolean).forEach(unwrapBlockCode);
      tidyEdited(changed);
    }
    return tidySvg(c.innerHTML);
  }

  // A deck still titled like the template (or like its first slide) is saved with its first slide's heading as its
  // <title>; a title set on purpose is never touched.
  function retitle(text) {
    const want = firstHeading();
    if (!autoTitle || !want || want === fileTitle.trim()) return text;
    const head = blankNonMarkup(text.slice(0, (locateDeck(text) || { start: text.length }).start));
    const m = /<title\b[^>]*>([^<]*)<\/title\s*>/i.exec(head);
    if (!m) return text;
    const at = m.index + m[0].indexOf('>') + 1;
    fileTitle = want;
    return text.slice(0, at) + esc(want) + text.slice(at + m[1].length);
  }
  // Every ⌘S counts once it has finished, however it ended (tests wait on this instead of guessing a delay).
  let savesDone = 0, pollsDone = 0;
  async function save(opts = {}) {
    try { return await saveNow(opts); } finally { savesDone++; }
  }
  async function saveNow({ quiet = false } = {}) {
    commit();
    if (framed && !serverMode) {
      download(fullHTML());
      return toast('This viewer can\'t write to your files, so a copy was saved to Downloads. To edit and save in place, open the deck in Aside or Chrome with deck open', 8000);
    }
    if (!window.showDirectoryPicker && !serverMode) {
      download(fullHTML());
      return toast('This browser can\'t edit files directly, so a copy was saved to Downloads. The original file is unchanged', 6000);
    }
    const seq = mergeSeq;
    const d = await ensureDir(true);
    // Connecting may have just reloaded the page or merged the AI's edits in; let the user see them before writing.
    if (!d || reloading || mergeSeq !== seq) return;
    // Saving waits for a choice in the banner: the banner itself says so, nothing covers it.
    if ($('.banner').classList.contains('show')) return pulseBanner();
    commit();
    const live = hist[hi], inner = cleanedDeck();
    saving = true;
    updateStatus();
    try {
      const fh = await d.getFileHandle(FILE);
      const text = await (await fh.getFile()).text();
      if (!looksComplete(text)) return toast('The AI is writing the file. Save again in a moment', 4000);
      {
        const disk = deckFromText(text);
        if (disk !== null && !sameDeck(disk, baseline) && !sameDeck(disk, inner)) {
          // Changed since we last looked: fold the AI's edits in instead of overwriting them.
          onExternalChange(text, true);
          if (!reloading && !$('.banner').classList.contains('show')) toast('Merged the AI\'s changes first. Check them and save again', 5000);
          return;
        }
      }
      let out = composeFile(text, inner, slides().map(n => origins.get(n) || null));
      if (out !== null) out = retitle(out);
      if (out === null) {
        if (!confirm(`Couldn't find <main class="deck"> in ${FILE}.\nRewrite the whole file from what's on screen?`)) return;
        out = fullHTML();
      }
      if (out !== text) {
        const w = await fh.createWritable();
        await w.write(out);
        await w.close();
      }
      lastMod = (await fh.getFile()).lastModified;
      diskText = out;
      noteOrigins(out);
      baseline = inner;
      setSaved(inner, live);
      updateStatus();
      if (!quiet) toast('Saved');
    } catch (err) {
      if (LOST.includes(err.name)) {
        disconnect(err);
        toast('Lost the folder connection. Save (⌘S) to reconnect the folder', 6000);
      } else {
        toast('Save failed: ' + err.message, 6000);
      }
    } finally {
      saving = false;
      updateStatus();
    }
  }

  // The pill next to Save says, in plain words, whether the file on disk has my latest edits.
  let saving = false, aiNoteUntil = 0, aiNoteTimer = 0;
  function noteAI() {
    aiNoteUntil = Date.now() + 3000;
    clearTimeout(aiNoteTimer);
    aiNoteTimer = setTimeout(updateStatus, 3050);
    updateStatus();
  }
  function updateStatus() {
    if (!shadow) return;
    const st = $('button.status');
    const dirty = isDirty();
    $('button[data-act=undo]').disabled = hi <= 0 && !commitTimer;
    $('button[data-act=redo]').disabled = hi >= hist.length - 1;
    st.className = 'status';
    const set = (html, title, cls) => { st.innerHTML = html; st.title = title; if (cls) st.classList.add(cls); };
    const dot = '<i class="dot"></i>';
    const where = `${FILE} in the '${dirName()}' folder`, again = serverMode ? '' : '. Click to pick the folder again';
    if (serverMode && !dirOK) set((dirty ? dot : '') + 'Not saving', 'The deck server stopped: open the deck again with deck open. Your edits stay in this tab until you close it', 'warn');
    else if (framed && !serverMode) set('View only here', 'This viewer can\'t write to your files. Open the deck in Aside or Chrome with deck open to edit and save it', 'warn');
    else if (!window.showDirectoryPicker && !serverMode) set('Download only', 'This browser can\'t edit the original file. Use a Chromium-based browser', 'warn');
    else if (blockedPlace()) set('Can\'t save here', 'The browser blocks folders under ~/Library. Move the deck under Documents or Desktop', 'warn');
    else if (!dirOK) set((dirty ? dot : '') + 'Folder not connected', `⌘S picks this deck's folder once; after that, edits save by themselves and AI edits show up right away. To skip this, open the deck with deck open`, dirty ? 'warn' : '');
    else if (saving) set('Saving…', `Writing ${where}`);
    else if (aiNoteUntil > Date.now()) set('AI edits applied', 'The AI changed the file, and the screen now shows it', 'ai');
    else if (dirty) set(dot + (AUTOSAVE ? 'Edited' : 'Unsaved changes'), (AUTOSAVE ? `Saves to ${where} a moment after you stop` : `⌘S saves to ${where}`) + again);
    else set('Saved ✓', `Matches ${where}. AI edits to the file show up automatically${again}`);
    if (dirty && dirOK && !saving) scheduleAutosave(false);
  }

  // ---------- actions & keys ----------
  function action(a, btn) {
    hideToast();
    closePop();
    switch (a) {
      case 'slide-new': return newSlide('new');
      case 'text': return addTextBox();
      case 'table': return insertTable(3, 3, true);
      case 'shape': return insert(lastShape);
      case 'arrow': return insert('arrow');
      case 'math': return insert('math');
      case 'image': return requestImage(null, btn);
      case 'smaller': return fontStep(-1);
      case 'bigger': return fontStep(1);
      case 'dup-slide': return duplicateSlide();
      case 'del-slide': return deleteSlide();
      case 'undo': return undo();
      case 'redo': return redo();
      case 'connect': return ensureDir(true, { force: dirOK });
      case 'save': return save();
      case 'present': return presentFromEditor(true);
      case 'help': return toggleHelp();
      case 'reload': return resolveConflict('theirs');
      case 'keep': return resolveConflict('mine');
    }
  }

  function onKeyDown(e) {
    const mod = e.metaKey || e.ctrlKey;
    const k = e.key, code = e.code;
    // ⌘S must work even while the last Korean syllable is still composing, or the browser's "Save Page As" opens.
    if (mod && !e.shiftKey && !e.altKey && code === 'KeyS') { e.preventDefault(); save(); return; }
    if (e.isComposing || e.keyCode === 229) {
      // Korean typed on a selected heading, paragraph or bullet: start editing it (caret at its end) before the
      // composition begins, so the syllable goes into the text and nothing is changed mid-composition.
      if (mode === 'edit' && !editing && !e.isComposing && !composing && !mod && !e.altKey && Date.now() >= typeGuardUntil && typeable()) startTyping();
      else if (mode === 'edit' && !editing && !sel.length && !navFocus && !sidebar.contains(document.activeElement)) strayKey();
      // A Korean syllable is about to replace a selection that spans several paragraphs or bullets: remove the
      // selection ourselves first (before composition starts), so the browser never merges the blocks its own way.
      if (editing && !e.isComposing && !composing) { clampRunSelection(); if (multiBlockRange()) deleteRange(); }
      if (k === 'Escape' && editing) afterComposition = () => { stopEditing(); updateCrumbs(); };
      // Tab in a table cell while a syllable is composing: move once the IME has committed it.
      if (k === 'Tab' && editing) {
        e.preventDefault();
        if (isCell(editing) || isRich(editing)) queueImeTab(e.shiftKey ? -1 : 1);
      }
      return;
    }
    if ($('.help').classList.contains('show')) {
      if (k === 'Escape' || k === '?') { e.preventDefault(); toggleHelp(false); }
      return;
    }

    if (mode === 'present') {
      // Keys typed into a field on a slide (an input in an interactive element) are its own; Escape leaves the field.
      // Space and Enter on a focused button press it instead of turning the page.
      const origin = e.composedPath()[0];
      if (origin && origin.nodeType === 1 && deck.contains(e.target)) {
        if (origin.matches('textarea, select, [contenteditable]:not([contenteditable="false"]), input:not([type=button], [type=submit], [type=reset], [type=checkbox], [type=radio], [type=image])')) {
          if (k === 'Escape') { e.preventDefault(); origin.blur(); }
          return;
        }
        if ((k === ' ' || k === 'Enter') && origin.matches('button, summary, a[href], input, [role=button], [tabindex]')) return;
      }
      if (mod || e.altKey) return;
      if (['ArrowRight', 'ArrowDown', 'PageDown', ' ', 'Enter'].includes(k)) { e.preventDefault(); go(cur + (e.shiftKey && k === ' ' ? -1 : 1)); }
      else if (['ArrowLeft', 'ArrowUp', 'PageUp', 'Backspace'].includes(k)) { e.preventDefault(); go(cur - 1); }
      else if (k === 'Home') go(0);
      else if (k === 'End') go(slides().length - 1);
      else if (code === 'KeyE') { e.preventDefault(); setMode('edit'); }
      else if (k === 'Escape' && fromEditor) {
        e.preventDefault();
        if (document.fullscreenElement) { fsByKeyAt = Date.now(); document.exitFullscreen().catch(() => {}); }
        setMode('edit');
      }
      else if (code === 'KeyF') {
        fsByKeyAt = Date.now();
        if (document.fullscreenElement) document.exitFullscreen();
        else html.requestFullscreen().catch(() => {});
      }
      else if (k === '?') toggleHelp(true);
      return;
    }

    // edit mode
    if (mod && code === 'KeyZ') { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
    if (mod && code === 'KeyY') { e.preventDefault(); redo(); return; }
    if (mod && e.shiftKey && (e.code === 'Period' || e.code === 'Comma')) { e.preventDefault(); fontStep(e.code === 'Period' ? 1 : -1); return; }

    if (editing) {
      // Enter and Backspace are handled in onBeforeInput, which also sees IME-committed keys.
      if (k === 'Escape') {
        e.preventDefault();
        if ($('.menu').classList.contains('show')) return closeMenu();
        stopEditing();
        updateCrumbs();
      } else if (mod && code === 'KeyK') { e.preventDefault(); fmt('link'); }
      else if (mod && code === 'KeyA' && editRun) { e.preventDefault(); selectAllRun(); }
      else if ((k === 'Home' || k === 'End') && !mod && !e.altKey && isRich(editing)) {
        // Home/End (with Shift: select) go to the start/end of the line the caret is on. Left to the browser they go to
        // the edges of the whole list or text box on a Mac, and typing over that would wipe the other bullets.
        e.preventDefault();
        const s = getSelection();
        if (!s.rangeCount) return;
        s.modify(e.shiftKey ? 'extend' : 'move', k === 'Home' ? 'backward' : 'forward', 'lineboundary');
        clampRunSelection();
      }
      else if (k === 'Tab') {
        // Tab never moves focus out of the slide; in a table it goes to the next or previous cell.
        e.preventDefault();
        if (mod || e.altKey || imeTabPending || Date.now() - imeTabAt < 150) return;
        if (isCell(editing)) moveCell(e.shiftKey ? -1 : 1);
        else if (isRich(editing)) indentItems(e.shiftKey ? -1 : 1);
      } else if ((k === 'ArrowUp' || k === 'ArrowDown') && e.altKey && !mod && !e.shiftKey) {
        // Alt+↑/↓ moves the paragraph or bullet up or down among its neighbours.
        e.preventDefault();
        moveBlock(k === 'ArrowUp' ? -1 : 1);
      } else if ((k === 'ArrowUp' || k === 'ArrowDown') && isCell(editing) && !mod && !e.altKey && !e.shiftKey) {
        if (cellVertical(k === 'ArrowUp' ? -1 : 1)) e.preventDefault();
      }
      return;
    }

    // With a thumbnail in focus, object keys never reach the slide.
    const inRail = navFocus || sidebar.contains(document.activeElement);
    if (mod && code === 'KeyA') {
      if (inRail) return;
      e.preventDefault();
      const s = curSlide();
      if (s) setSel(collect(s, s.getBoundingClientRect()));
      return;
    }
    // With a thumbnail in focus (nothing on the slide selected), ⌘D and Delete act on the slide itself.
    const onSlide = inRail && !sel.length;
    if (mod && code === 'KeyD') { e.preventDefault(); if (onSlide) duplicateSlide(); else if (!inRail) duplicateSelected(); return; }
    if (e.altKey && !mod && (k === 'ArrowUp' || k === 'ArrowDown')) {
      e.preventDefault();
      if (!inRail) moveInFlow(k === 'ArrowUp' ? -1 : 1);
      return;
    }
    if (mod || e.altKey) return;
    if (k === 'Escape' && (menuFor || $('.pop').classList.contains('show'))) { e.preventDefault(); closePop(); return closeMenu(); }
    if (k === 'Escape') {
      e.preventDefault();
      if (sel.length > 1) setSel([]);
      else select(parentOf(selected));
      return;
    }
    if (k === 'Delete' || k === 'Backspace') {
      e.preventDefault();
      if (onSlide) deleteSlide();
      else if (selected && !inRail) removeSelected();
      return;
    }
    if (k === 'Enter' && selected && sel.length === 1 && isBoxShape(selected)) { e.preventDefault(); startLabel(selected); return; }
    if (k === 'Enter' && selected && sel.length === 1 && (textHost(selected) === selected || isTextFrame(selected))) {
      e.preventDefault();
      if (typeable()) return startTyping();
      startEditing(selected);
      caretAt(selected);
      return;
    }
    if (k === 'Enter' && selected && selected.tagName === 'TABLE' && selected.rows.length && selected.rows[0].cells.length) {
      e.preventDefault();
      const c = selected.rows[0].cells[0];
      startEditing(c);
      selectAllIn(c);
      return;
    }
    if (k.startsWith('Arrow')) {
      e.preventDefault();
      if (selected && !inRail) {
        const step = e.shiftKey ? 10 : 1;
        nudge(k === 'ArrowLeft' ? -step : k === 'ArrowRight' ? step : 0, k === 'ArrowUp' ? -step : k === 'ArrowDown' ? step : 0);
      } else {
        go(cur + (k === 'ArrowRight' || k === 'ArrowDown' ? 1 : -1));
      }
      return;
    }
    if (k === 'PageDown') { e.preventDefault(); go(cur + 1); return; }
    if (k === 'PageUp') { e.preventDefault(); go(cur - 1); return; }
    if ((k === 'Home' || k === 'End') && !sel.length) { e.preventDefault(); go(k === 'Home' ? 0 : slides().length - 1); return; }
    // Right after the AI changed the slide being typed in, the next letters were meant as text: never shortcuts.
    if (k.length === 1 && Date.now() < typeGuardUntil) { e.preventDefault(); return; }
    // A letter typed on a selected text (heading, paragraph, list, text box, caption) goes into it, at its end.
    if (k.length === 1 && !inRail && typeable()) { startTyping(); return; }
    // Other letters never act on a selection: E presents only when nothing is selected (the Present button always works).
    if (sel.length || inRail) return;
    if (k === '?') return toggleHelp(true);
    // Letters typed with nothing to type into were meant as text: say where text goes, once per burst, and never take
    // the E in a word (or one typed right after ⌘Z) as "present".
    if (k.length === 1 && (code !== 'KeyE' || Date.now() - lastStrayAt < 1500 || Date.now() - stepAt < 1000)) {
      e.preventDefault();
      return strayKey();
    }
    if (code === 'KeyE') { e.preventDefault(); presentFromEditor(false); }
  }
  let lastStrayAt = 0;
  function strayKey() {
    const typedAt = lastStrayAt;
    lastStrayAt = Date.now();
    if (lastStrayAt - typedAt > 1500) toast('Click the text to edit it');
  }
  // One selected thing that holds text the way a paragraph does.
  function typeable() {
    const el = selected;
    return sel.length === 1 && !!el && el.isConnected && !el.classList.contains('math') && !(el instanceof SVGElement) &&
      (textHost(el) === el || isTextFrame(el) || isBoxShape(el));
  }
  function startTyping() {
    const el = selected;
    if (isBoxShape(el)) return startLabel(el);
    startEditing(el);
    focusHost(el);
    placeCaret(...endPoint(el));
    drawSel();
  }
  // Typing into a shape: its text is a paragraph inside it (made when there is none yet), centred by the deck's CSS.
  function startLabel(sh, x, y) {
    const blocks = [...sh.children].filter(c => !c.hasAttribute(RT) && (TEXT_TAGS.has(c.tagName) || isList(c)));
    if (!blocks.length && !ownText(sh)) {
      const p = document.createElement('p');
      p.appendChild(document.createElement('br'));
      sh.appendChild(p);
      blocks.push(p);
    }
    inkFor(sh);
    select(sh);
    startEditing(blocks[0] || sh);
    focusHost(sh);
    // At the point clicked; else (typing or Enter on the selected shape) at the end of its last line.
    if (x != null && sh.textContent.trim()) caretAt(sh, x, y);
    else placeCaret(...endPoint(blocks[blocks.length - 1] || sh));
    drawSel();
  }
  // The text on a filled shape is white when the fill is dark; on a light or empty one it keeps the deck's colour.
  function inkFor(sh) {
    const white = sh.style.color === 'rgb(255, 255, 255)' || sh.style.color === '#fff';
    const m = /rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?/.exec(getComputedStyle(sh).backgroundColor);
    const dark = !!m && (m[4] === undefined || +m[4] > 0.4) && (0.299 * m[1] + 0.587 * m[2] + 0.114 * m[3]) < 150;
    if (dark && !sh.style.color) sh.style.color = '#fff';
    else if (!dark && white) sh.style.removeProperty('color');
    if (sh.getAttribute('style') === '') sh.removeAttribute('style');
  }
  // The end of the last line of text in `el` (inside its last bullet or paragraph, never between blocks).
  function endPoint(el) {
    let t = el;
    for (let k = 0; k < 20; k++) {
      const kids = [...t.children].filter(c => !c.hasAttribute(RT) && !c.matches('aside.notes'));
      const last = kids[kids.length - 1];
      if ((isList(t) || isTextColumn(t)) && last) t = last;
      else if (t.tagName === 'LI' && last && isList(last)) t = last;
      else break;
    }
    return pointIn(t, t.textContent.length);
  }


  // ---------- text toolbar ----------
  const isRich = el => el && el.getAttribute('contenteditable') === 'true';
  const BLOCKS = [['P', 'Body'], ['H1', 'Title 1'], ['H2', 'Title 2'], ['H3', 'Title 3'], ['BLOCKQUOTE', 'Quote']];
  const SIZES = [20, 24, 28, 32, 36, 40, 48, 56, 64, 72, 80, 96, 120, 144];
  const BASIC_COLORS = ['#111111', '#555555', '#999999', '#ffffff', '#d93025', '#f29900', '#188038', '#1a73e8', '#7b1fa2', '#e8710a', '#12b5cb', '#c2185b'];
  const esc = t => t.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

  // The floating toolbars sit next to the selection frame (above when there is room), never on top of it,
  // and, where they can, not on top of the other things on the slide either.
  const TEXT_MENUS = ['block', 'size', 'color', 'align', 'list', 'more', 'row', 'col'];
  const OBJ_MENUS = ['fill', 'objmore', 'arrange', 'trow', 'tcol', 'talign', 'tcolor'];
  let fmtPlace = null;
  // What a toolbar or chip must not cover: what is visible of everything on the slide except the frames
  // themselves (and what contains them, whose other parts still count).
  function peerRects(frames) {
    const slide = curSlide();
    const out = [];
    const walk = parent => {
      for (const c of parent.children) {
        if (frames.includes(c) || c.hasAttribute(RT) || c.matches('aside.notes, style, script, template')) continue;
        if (frames.some(f => c.contains(f))) { walk(c); continue; }
        visibleRects(c, out);
      }
    };
    if (slide && frames.length && frames.every(f => slide.contains(f))) walk(slide);
    return out;
  }
  const overlapArea = (a, b) => Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left)) *
    Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
  // The rect a frame is drawn with: while a run of slide-level blocks is edited, every block the text selection touches.
  function frameRect() {
    if (editRun) {
      const fs = [...new Set(touchedBlocks().map(slideChild).filter(Boolean))];
      if (fs.length > 1) return unionRect(fs.map(f => f.getBoundingClientRect()));
    }
    if (!editing && selected.classList.contains('math')) return tightRect(selected);
    return frameBox(selected);
  }
  // The box a frame is drawn around. Text, and a figure, stretched by the row they sit in (a column of a two-column
  // slide) end where their content ends, not hundreds of pixels lower; anything with a look of its own keeps its box.
  function frameBox(el) {
    const b = el.getBoundingClientRect();
    if (!(isTextFrame(el) || el.tagName === 'FIGURE') || paints(getComputedStyle(el))) return b;
    const rs = visibleRects(el, [], 0, true);
    if (!rs.length) return b;
    const u = unionRect(rs);
    const top = u.top - b.top > 24 ? u.top : b.top, bottom = b.bottom - u.bottom > 24 ? u.bottom : b.bottom;
    if (top === b.top && bottom === b.bottom) return b;
    return { left: b.left, right: b.right, top, bottom, width: b.width, height: bottom - top, x: b.left, y: top };
  }
  // The floating toolbars sit next to the frame and never on it. Among the spots above and below it (shifted
  // sideways, or past a neighbour) the closest one that covers nothing visible wins; failing that, the one that
  // covers least. The spot is kept while the frame stays the same, so the bar does not jump while typing.
  function placeFmt(r) {
    const text = $('.fmt:not(.otb)'), obj = $('.otb');
    const wantText = r && isRich(editing), wantObj = r && !editing && sel.length;
    if (!wantObj && obj.classList.contains('show')) { obj.classList.remove('show'); if (OBJ_MENUS.includes(menuFor)) closeMenu(); }
    if (!wantText && text.classList.contains('show')) { text.classList.remove('show'); if (TEXT_MENUS.includes(menuFor)) closeMenu(); }
    if (!wantText && !wantObj) { fmtPlace = null; return; }
    const bar = wantText ? text : obj;
    if (!bar.classList.contains('show') || (!wantText && fmtPlace && fmtPlace.n !== sel.length)) {
      bar.classList.add('show'); wantText ? refreshFmt() : refreshObj(); fmtPlace = null;
    }
    const anchor = selected;
    const w = bar.offsetWidth, h = bar.offsetHeight;
    // Above, the object toolbar leaves room for the selection chip; below, both clear the resize handles.
    const gapA = wantText ? 8 : 40, gapB = wantText ? 14 : 18;
    const minTop = TOOLBAR + 6, maxBottom = innerHeight - 6, minLeft = SIDEBAR + 6, maxLeft = innerWidth - w - 6;
    const clampL = x => Math.round(Math.max(minLeft, Math.min(x, maxLeft)));
    // A few px of air around what is there, so the bar never sits in a hairline gap touching it.
    const nearPeers = () => peerRects(sel).filter(p => !meets(p, r) || overlapArea(p, r) < p.width * p.height * 0.5)
      .map(p => ({ left: p.left - 4, top: p.top - 4, right: p.right + 4, bottom: p.bottom + 4, width: p.width + 8, height: p.height + 8 }));
    // The move grip and the chip naming the selection are never covered: they are how the frame is grabbed.
    const handles = sel.length === 1 ? [...shadow.querySelectorAll('.sel .grip, .sel .tag')].map(e => e.getBoundingClientRect()).filter(hasArea)
      .map(g => ({ left: g.left - 4, top: g.top - 4, right: g.right + 4, bottom: g.bottom + 4 })) : [];
    const blocked = box => overlapArea(box, r) > 0 || handles.some(g => overlapArea(box, g) > 0);
    let stale = !fmtPlace || fmtPlace.el !== anchor || fmtPlace.n !== sel.length || fmtPlace.bar !== bar || fmtPlace.w !== w || Math.abs(fmtPlace.h - r.height) > 40;
    // The frame grew or moved a little (a line typed): the kept spot stays unless it now covers something.
    if (!stale && fmtPlace.spot && ['left', 'top', 'right', 'bottom'].some(k => Math.abs(fmtPlace.r[k] - r[k]) > 0.5)) {
      const sp = fmtPlace.spot, top = (sp.ref === 'top' ? r.top : r.bottom) + sp.off, left = clampL(r.left + sp.dx);
      const box = { left, right: left + w, top, bottom: top + h };
      stale = blocked(box) || nearPeers().some(p => overlapArea(box, p) > 0);
      if (!stale) fmtPlace.r = { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
    }
    if (stale) {
      const peers = nearPeers();
      const lefts = new Set([clampL(r.left), clampL(r.right - w)]);
      for (const g of handles) lefts.add(clampL(g.left - w - 6));
      const tops = [['top', -gapA - h, 0], ['bottom', gapB, 6]];
      for (const p of peers) {
        lefts.add(clampL(p.right + 10)); lefts.add(clampL(p.left - w - 10));
        if (p.top - 8 - h < r.top - gapA - h) tops.push(['top', p.top - 8 - h - r.top, 0]);
        if (p.bottom + 8 > r.bottom + gapB) tops.push(['bottom', p.bottom + 8 - r.bottom, 6]);
      }
      const home = clampL(r.left);
      let best = null;
      for (const [ref, off, bias] of tops) {
        const top = (ref === 'top' ? r.top : r.bottom) + off;
        if (top < minTop || top + h > maxBottom) continue;
        for (const left of lefts) {
          const box = { left, right: left + w, top, bottom: top + h };
          if (blocked(box)) continue;
          const cover = peers.reduce((s, p) => s + overlapArea(box, p), 0);
          const cost = (cover > 0 ? 1e7 + cover : 0) + bias + Math.abs(ref === 'top' ? off + gapA + h : off - gapB) + Math.abs(left - home) * 0.5;
          if (!best || cost < best.cost) best = { cost, ref, off, dx: left - r.left };
        }
      }
      fmtPlace = { el: anchor, n: sel.length, bar, w, h: r.height, r: { left: r.left, top: r.top, right: r.right, bottom: r.bottom }, spot: best };
    }
    const spot = fmtPlace.spot;
    let top = spot ? (spot.ref === 'top' ? r.top : r.bottom) + spot.off : minTop;
    top = Math.max(minTop, Math.min(top, maxBottom - h));
    bar.style.top = Math.round(top) + 'px';
    bar.style.left = clampL(spot ? r.left + spot.dx : r.left) + 'px';
    toastClear();
  }

  // Theme colors: custom properties on :root whose values are colors, offered as var(--name).
  function themeColors() {
    const out = [];
    const seen = new Set();
    const visit = rules => {
      for (const r of rules) {
        if (r.cssRules && !r.selectorText) { visit(r.cssRules); continue; }
        if (!r.style || !/(^|,)\s*(:root|html)\s*(,|$)/.test(r.selectorText || '')) continue;
        for (const name of r.style) {
          if (!name.startsWith('--') || seen.has(name)) continue;
          const v = getComputedStyle(html).getPropertyValue(name).trim();
          if (CSS.supports('color', v)) { seen.add(name); out.push([name, v]); }
        }
      }
    };
    for (const sh of document.styleSheets) { try { if (!sh.ownerNode || !sh.ownerNode.hasAttribute(RT)) visit(sh.cssRules); } catch (_) {} }
    return out.slice(0, 16);
  }

  let menuFor = null, menuBtn = null;
  function closeMenu() {
    const m = shadow && $('.menu');
    if (m) m.classList.remove('show');
    if (menuBtn) menuBtn.classList.remove('open');
    menuFor = null;
    menuBtn = null;
  }
  function swatchMenu(kind, noneLabel) {
    let h = '';
    const theme = themeColors();
    if (theme.length) {
      h += `<h4>Theme colors</h4><div class="swatches">` + theme.map(([n, v]) =>
        `<button class="sw" title="${n}" data-kind="${kind}" data-val="var(${n})" style="background:${v}"></button>`).join('') + `</div>`;
    }
    h += `<h4>Basic colors</h4><div class="swatches">` + BASIC_COLORS.map(c =>
      `<button class="sw" title="${c}" data-kind="${kind}" data-val="${c}" style="background:${c}"></button>`).join('') + `</div>`;
    return h + `<button class="item" data-kind="${kind}" data-val="">${noneLabel}</button>`;
  }
  const item = (kind, val, label, hint = '', icon = '', cls = '') =>
    `<button class="item${cls ? ' ' + cls : ''}" data-kind="${kind}" data-val="${val}">${icon}<span>${label}</span>${hint ? `<small>${hint}</small>` : ''}</button>`;
  const fmtItem = (cmd, label, icon, on, val) =>
    `<button class="item${on ? ' on' : ''}" data-fmt="${cmd}"${val ? ` data-val="${val}"` : ''}>${icon}<span>${label}</span></button>`;
  const objItem = (a, label, icon) => `<button class="item" data-obj="${a}">${icon}<span>${label}</span></button>`;
  const SHAPES = [['rect', 'Rectangle'], ['round', 'Rounded rectangle'], ['circle', 'Circle'], ['line', 'Line']];
  const ALIGNS = [['left', 'Left', 'alignL'], ['center', 'Center', 'alignC'], ['right', 'Right', 'alignR'], ['justify', 'Justify', 'alignJ']];
  function openMenu(kind, btn) {
    if (menuFor === kind) return closeMenu();
    closeMenu();
    closePop();
    const m = $('.menu');
    const el = editing && (curBlock() || editing);
    let h = '';
    if (kind === 'slide') {
      h = item('slide', 'new', 'New slide', 'Title + list', IC.slide) + item('slide', 'blank', 'Blank slide', '', IC.rect) + '<hr>' +
        item('slide', 'dup', 'Duplicate slide', '', IC.dup) + item('slide', 'del', 'Delete slide', '', IC.trash, 'danger');
    } else if (kind === 'text') {
      h = item('insert', 'text', 'Text box', '', IC.text) + item('insert', 'title', 'Title', '', IC.heading) + item('insert', 'list', 'Bulleted list', '', IC.ul);
    } else if (kind === 'table') {
      h = tableGridMenu();
    } else if (kind === 'shape') {
      h = SHAPES.map(([k, l]) => item('shape', k, l, '', IC[k], k === lastShape ? 'on' : '')).join('');
    } else if (kind === 'fill') {
      if (!selected) return;
      h = swatchMenu('fill', selected.dataset.shape === 'line' || selected.dataset.shape === 'arrow' ? 'Default color' : 'No fill');
    } else if (kind === 'arrange') {
      if (!sel.length) return;
      const toSlide = '<h4>Relative to slide</h4>' + item('arrange', 'slide-h', 'Center horizontally', '', IC.slideH) +
        item('arrange', 'slide-v', 'Center vertically', '', IC.slideV) + item('arrange', 'slide-c', 'Center on slide', '', IC.slideC);
      h = sel.length < 2 ? toSlide : '<h4>Align to each other</h4>' +
        item('arrange', 'left', 'Align left', '', IC.alignL) + item('arrange', 'center', 'Align center', '', IC.alignC) +
        item('arrange', 'right', 'Align right', '', IC.alignR) + '<hr>' + item('arrange', 'top', 'Align top', '', IC.vTop) +
        item('arrange', 'middle', 'Align middle', '', IC.vMid) + item('arrange', 'bottom', 'Align bottom', '', IC.vBot) + '<hr>' + toSlide;
    } else if (kind === 'trow' || kind === 'tcol') {
      if (!selected || selected.tagName !== 'TABLE' || editing) return;
      h = kind === 'trow'
        ? item('tsel', 'row-start', 'Add row at top', '', IC.rowAbove) + item('tsel', 'row-end', 'Add row at bottom', '', IC.rowBelow) + '<hr>' +
          item('tsel', 'row-del', 'Delete last row', '', IC.trash, 'danger')
        : item('tsel', 'col-start', 'Add column at left', '', IC.colLeft) + item('tsel', 'col-end', 'Add column at right', '', IC.colRight) + '<hr>' +
          item('tsel', 'col-del', 'Delete last column', '', IC.trash, 'danger');
    } else if (kind === 'talign') {
      if (!selected || selected.tagName !== 'TABLE' || editing) return;
      const al = curAlign(selected.querySelector('td, th') || selected);
      h = ALIGNS.slice(0, 3).map(([v, l, ic]) => item('talign', v, l, '', IC[ic], al === v ? 'on' : '')).join('');
    } else if (kind === 'tcolor') {
      if (!selected || selected.tagName !== 'TABLE' || editing) return;
      h = swatchMenu('tcolor', 'No color');
    } else if (kind === 'objmore') {
      if (!selected) return;
      h = objItem('front', 'Bring to front', IC.front) + objItem('back', 'Send to back', IC.back) + '<hr>' +
        objItem('rotl', 'Rotate left 15°', IC.rotl) + objItem('rotr', 'Rotate right 15°', IC.rotr);
    } else if (kind === 'block') {
      if (!el) return;
      if (!canRetag(el)) { toast('Can\'t change the paragraph style inside a list or table'); return; }
      h = BLOCKS.map(([t, l]) => `<button class="item${el.tagName === t ? ' on' : ''}" data-kind="block" data-val="${t}">${l}</button>`).join('');
    } else if (kind === 'size') {
      if (!el) return;
      const now = Math.round(parseFloat(getComputedStyle(anchorEl()).fontSize));
      h = `<button class="item" data-kind="size" data-val="">Default size</button>` +
        SIZES.map(px => `<button class="item${px === now ? ' on' : ''}" data-kind="size" data-val="${px}">${px}</button>`).join('');
    } else if (kind === 'color') {
      if (!el) return;
      h = swatchMenu('color', 'No color');
    } else if (kind === 'align') {
      if (!el) return;
      const al = curAlign(el);
      h = ALIGNS.map(([v, l, ic]) => fmtItem('align', l, IC[ic], al === v, v)).join('');
    } else if (kind === 'list') {
      if (!el) return;
      const lt = listType(el);
      h = fmtItem('ul', 'Bulleted list', IC.ul, lt === 'UL') + fmtItem('ol', 'Numbered list', IC.ol, lt === 'OL') +
        (lt ? '<hr>' + fmtItem('indent', 'Indent (Tab)', IC.indent) + fmtItem('outdent', 'Outdent (Shift+Tab)', IC.outdent) +
          '<hr>' + fmtItem('unlist', 'Remove list', IC.unlist) : '');
    } else if (kind === 'more') {
      if (!el) return;
      const a = anchorEl(), code = a.closest('code');
      h = fmtItem('code', 'Code', IC.code, code && editing.contains(code)) +
        (isCell(editing) ? '' : fmtItem('quote', 'Quote', IC.quote, el.tagName === 'BLOCKQUOTE')) + '<hr>' +
        fmtItem('clear', 'Clear formatting', IC.clear) + fmtItem('unlink', 'Remove link', IC.unlink);
    } else if (kind === 'row') {
      if (!isCell(editing)) return;
      h = item('table', 'row-above', 'Add row above', '', IC.rowAbove) + item('table', 'row-below', 'Add row below', '', IC.rowBelow) + '<hr>' +
        item('table', 'row-del', 'Delete this row', '', IC.trash, 'danger');
    } else if (kind === 'col') {
      if (!isCell(editing)) return;
      h = item('table', 'col-left', 'Add column left', '', IC.colLeft) + item('table', 'col-right', 'Add column right', '', IC.colRight) + '<hr>' +
        item('table', 'col-del', 'Delete this column', '', IC.trash, 'danger') + '<hr>' +
        item('table', 'col-align-left', 'Align column left', '', IC.alignL) + item('table', 'col-align-center', 'Align column center', '', IC.alignC) +
        item('table', 'col-align-right', 'Align column right', '', IC.alignR);
    } else return;
    m.innerHTML = h;
    m.classList.add('show');
    menuFor = kind;
    menuBtn = btn;
    btn.classList.add('open');
    const r = btn.getBoundingClientRect();
    m.style.left = Math.max(6, Math.min(r.left, innerWidth - m.offsetWidth - 6)) + 'px';
    const below = r.bottom + 6;
    m.style.top = (below + m.offsetHeight > innerHeight - 6 ? Math.max(6, r.top - m.offsetHeight - 6) : below) + 'px';
  }
  function openThumbMenu(i, x, y) {
    closeMenu();
    closePop();
    const m = $('.menu'), n = slides().length;
    m.innerHTML = item('thumb', 'dup', 'Duplicate', '⌘D', IC.dup) + item('thumb', 'del', 'Delete', 'Delete', IC.trash, 'danger') + '<hr>' +
      item('thumb', 'up', 'Move up', '', IC.caretUp) + item('thumb', 'down', 'Move down', '', IC.caret);
    if (i === 0) m.querySelector('[data-val="up"]').disabled = true;
    if (i >= n - 1) m.querySelector('[data-val="down"]').disabled = true;
    if (n <= 1) m.querySelector('[data-val="del"]').disabled = true;
    m.classList.add('show');
    menuFor = 'thumb';
    m.style.left = Math.max(6, Math.min(x, innerWidth - m.offsetWidth - 6)) + 'px';
    m.style.top = Math.max(6, Math.min(y, innerHeight - m.offsetHeight - 6)) + 'px';
  }
  function thumbAction(a) {
    if (a === 'dup') return duplicateSlide();
    if (a === 'del') return deleteSlide();
    if (a === 'up' && cur > 0) return moveSlide(cur, cur - 1);
    if (a === 'down' && cur < slides().length - 1) return moveSlide(cur, cur + 2);
  }
  function menuPick(kind, val) {
    hideToast();
    if (kind === 'thumb') return thumbAction(val);
    if (kind === 'block') setBlock(val);
    else if (kind === 'size') setSize(val ? +val : null);
    else if (kind === 'color') setColor(val || null);
    else if (kind === 'fill') setFill(val || null);
    else if (kind === 'insert') insert(val);
    else if (kind === 'shape') { setLastShape(val); insert(val); }
    else if (kind === 'table-size') { const [r, c] = val.split('×').map(Number); insertTable(r, c, tableHeader); }
    else if (kind === 'table') tableOp(val);
    else if (kind === 'tsel') tableSelOp(val);
    else if (kind === 'talign') tableCells(c => { c.style.textAlign = val; });
    else if (kind === 'tcolor') tableCells(c => { if (val) c.style.color = val; else c.style.removeProperty('color'); });
    else if (kind === 'arrange') arrange(val);
    else if (kind === 'slide') slideAction(val);
  }

  // The table picker: hover a range of cells, click to insert that size.
  let tableHeader = true;
  function tableGridMenu() {
    let g = '<div class="tgrid">';
    for (let r = 1; r <= 6; r++) for (let c = 1; c <= 8; c++) g += `<button data-kind="table-size" data-val="${r}×${c}" title="${r} × ${c}"></button>`;
    return g + '</div><div class="tsize">Pick a table size</div><hr>' +
      `<button class="chk${tableHeader ? ' on' : ''}" data-toggle="thead"><span class="box">✓</span>Header row</button>`;
  }
  function markTableGrid(val) {
    const [R, C] = val.split('×').map(Number);
    shadow.querySelectorAll('.tgrid button').forEach(b => {
      const [r, c] = b.dataset.val.split('×').map(Number);
      b.classList.toggle('hl', r <= R && c <= C);
    });
    $('.menu .tsize').textContent = `${R} × ${C} table`;
  }
  function toggleOption(b) {
    if (b.dataset.toggle === 'thead') { tableHeader = !tableHeader; b.classList.toggle('on', tableHeader); }
  }
  // The Shape button inserts the shape picked last.
  let lastShape = 'rect';
  function setLastShape(k) {
    if (!SHAPES.some(s => s[0] === k)) return;
    lastShape = k;
    const b = $('.bar [data-act="shape"]');
    b.querySelector('svg').outerHTML = IC[k];
    b.title = 'Add ' + SHAPES.find(s => s[0] === k)[1].toLowerCase();
  }

  // ---------- adding things ----------
  // Content blocks (Title, List, Table, Equation) join the slide's flow and carry no position; free objects
  // (Text box, Shape, Arrow, Image) float in a spot where they cover nothing.
  const notesOf = s => [...s.children].find(c => c.matches('aside.notes')) || null;
  // A screen rect in slide px.
  function toSlide(r, sr) {
    return { left: (r.left - sr.left) / scale, top: (r.top - sr.top) / scale, right: (r.right - sr.left) / scale, bottom: (r.bottom - sr.top) / scale };
  }
  function boxOf(el, sr) { return toSlide(el.getBoundingClientRect(), sr); }
  const skipChild = c => c.hasAttribute(RT) || c.matches('aside.notes, style, script, template');
  const shown = c => !skipChild(c) && getComputedStyle(c).display !== 'none';
  // What is taken on the slide (slide px): what is visible of everything on it, in the flow or floating (the words
  // of a heading or a text box, not its full-width box); something floating that shows nothing yet counts whole.
  function occupied(s) {
    const sr = s.getBoundingClientRect();
    const out = [];
    for (const c of s.children) {
      if (!shown(c)) continue;
      let rs = visibleRects(c, [], 0, true);
      if (!rs.length && !inFlow(c)) rs = [c.getBoundingClientRect()];
      for (const r of rs) { const b = toSlide(r, sr); if (b.right - b.left >= 1 && b.bottom - b.top >= 1) out.push(b); }
    }
    return out;
  }
  // Top-left corner (slide px) for a w×h object: under the content, else the middle, else the first gap on a 40px
  // grid, keeping a little air around what is there. With no gap anywhere: the spot that covers least, nearest the
  // middle (repeated inserts step down-right from it instead of landing on each other).
  function freeSpot(w, h) {
    const s = curSlide();
    const M = 80, G = 40, AIR = 24;
    const rects = occupied(s);
    const free = (x, y) => rects.every(r => x >= r.right + AIR || x + w <= r.left - AIR || y >= r.bottom + AIR || y + h <= r.top - AIR);
    const cx = Math.round((W - w) / 2), cy = Math.round((H - h) / 2);
    const tries = [];
    if (rects.length) {
      const sr = s.getBoundingClientRect();
      const flowBottoms = [...s.children].filter(c => shown(c) && inFlow(c) && !c.matches('aside.notes')).map(c => boxOf(c, sr).bottom);
      const y = Math.ceil(Math.max(...rects.map(r => r.bottom), ...flowBottoms) + 60);
      if (y + h <= H - M) tries.push([cx, y]);
    }
    tries.push([cx, cy]);
    for (let y = M; y + h <= H - M; y += G) for (let x = M; x + w <= W - M; x += G) tries.push([x, y]);
    for (const [x, y] of tries) if (free(x, y)) return [x, y, false];
    const steps = [];
    for (let k = 0; cx + k * G + w <= W && cy + k * G + h <= H; k++) steps.push([cx + k * G, cy + k * G]);
    // Covering content counts fully; only coming closer than AIR to it counts a little, so spots with room win.
    const cover = ([x, y]) => rects.reduce((a, r) => {
      const me = { left: x, top: y, right: x + w, bottom: y + h };
      return a + overlapArea(me, r) + 0.05 * overlapArea(me, { left: r.left - AIR, top: r.top - AIR, right: r.right + AIR, bottom: r.bottom + AIR });
    }, 0);
    const all = [...steps, ...tries];
    const least = Math.min(...all.map(cover));
    const ok = p => cover(p) <= least * 1.01 + 1;
    const step = steps.find(ok);
    const best = step || all.filter(ok).sort((a, b) => Math.hypot(a[0] - cx, a[1] - cy) - Math.hypot(b[0] - cx, b[1] - cy))[0] || [cx, cy];
    const me = { left: best[0], top: best[1], right: best[0] + w, bottom: best[1] + h };
    return [best[0], best[1], rects.some(r => overlapArea(me, r) > 1)];
  }
  // `fit`: the object keeps its natural width (up to w) and grows as it is typed into; it is placed by room for `fit` px.
  function placeAbs(el, w, h, setHeight, fit, spot) {
    const [x, y, covers] = spot || freeSpot(fit || w, h);
    el.style.position = 'absolute';
    el.style.left = Math.round(x) + 'px';
    el.style.top = Math.round(y) + 'px';
    if (fit) el.style.maxWidth = w + 'px'; else el.style.width = w + 'px';
    if (setHeight) el.style.height = h + 'px';
    el.style.margin = '0';
    if (covers) toast('No free spot, so it overlaps · drag it into place', 3500);
    return covers;
  }
  // The size (slide px) `el` takes when it floats on the current slide with no width of its own, at most maxW wide.
  function naturalSize(el, maxW, fixed) {
    const st = el.getAttribute('style');
    Object.assign(el.style, { position: 'absolute', left: '0px', top: '0px', margin: '0', visibility: 'hidden' }, fixed ? { width: maxW + 'px' } : { maxWidth: maxW + 'px' });
    curSlide().appendChild(el);
    const b = el.getBoundingClientRect();
    el.remove();
    if (st == null) el.removeAttribute('style'); else el.setAttribute('style', st);
    return [Math.ceil(b.width / scale), Math.ceil(b.height / scale)];
  }
  function slideChild(el) {
    const s = curSlide();
    for (let e = el; e && s && s !== e && s.contains(e); e = e.parentElement) if (e.parentElement === s) return e;
    return null;
  }
  // How far (slide px) the in-flow content sticks out of the slide's content area (inside its padding).
  function overflowOf(s) {
    const sr = s.getBoundingClientRect(), ss = getComputedStyle(s);
    const pt = parseFloat(ss.paddingTop) || 0, pr = parseFloat(ss.paddingRight) || 0, pb = parseFloat(ss.paddingBottom) || 0, pl = parseFloat(ss.paddingLeft) || 0;
    let over = 0;
    for (const c of s.children) {
      if (skipChild(c)) continue;
      const cs = getComputedStyle(c);
      if (cs.display === 'none' || cs.position === 'absolute' || cs.position === 'fixed') continue;
      const b = boxOf(c, sr);
      over = Math.max(over, Math.max(b.bottom, b.top + c.scrollHeight) - (H - pb), Math.max(b.right, b.left + c.scrollWidth) - (W - pr), pt - b.top, pl - b.left);
    }
    return over;
  }

  // Inserted markup is indented like its neighbours (tables one row per line), so the saved file stays readable.
  const isSpace = n => !!n && n.nodeType === 3 && !n.data.trim();
  function indentOf(parent) {
    for (const n of parent.childNodes) {
      if (n.nodeType === 3 && n.nextSibling && n.nextSibling.nodeType === 1) {
        const m = /\n([ \t]*)$/.exec(n.data);
        if (m) return m[1];
      }
    }
    const p = parent.previousSibling, m = p && p.nodeType === 3 && /\n([ \t]*)$/.exec(p.data);
    return m ? m[1] + '  ' : null;
  }
  // Put `el` into `parent` before `ref` (an element, or null for the end), with a line of its own.
  // Returns the whitespace nodes added, so the insert can be taken back.
  function putIn(parent, el, ref) {
    const ind = indentOf(parent);
    if (ind == null) { parent.insertBefore(el, ref); return []; }
    const nl = () => document.createTextNode('\n' + ind);
    const added = [];
    if (!ref && isSpace(parent.lastChild) && parent.lastChild.data.includes('\n')) ref = parent.lastChild;
    if (ref && ref.nodeType === 1) {
      ref.before(el);
      const ws = nl(); el.after(ws); added.push(ws);
      if (!(isSpace(el.previousSibling) && el.previousSibling.data.includes('\n'))) { const w2 = nl(); el.before(w2); added.push(w2); }
    } else if (ref) {
      const ws = nl(); ref.before(ws, el); added.push(ws);
    } else {
      const ws = nl(), end = document.createTextNode('\n' + ind.slice(2));
      parent.append(ws, el, end); added.push(ws, end);
    }
    layoutMarkup(el, ind);
    return added;
  }
  function putAfter(anchor, el) {
    const ind = indentOf(anchor.parentElement);
    if (ind == null) { anchor.after(el); return []; }
    const ws = document.createTextNode('\n' + ind);
    anchor.after(ws, el);
    layoutMarkup(el, ind);
    return [ws];
  }
  // After blocks were joined, split, moved or re-made inside a box of several blocks (a slide's run, a text column):
  // every block starts on a line of its own, indented like the others, with no lines holding only spaces. Only the
  // whitespace between blocks is touched, never a node the caret is in.
  function tidyGaps(box) {
    // Only a box already laid out one block per line; a box written on one line is left as it is.
    const ws = [...box.childNodes].find(n => n.nodeType === 3 && n.nextSibling && n.nextSibling.nodeType === 1 && /\n[ \t]*$/.test(n.data));
    if (!ws || box.innerHTML === tidyFrom) return;
    const ind = /\n([ \t]*)$/.exec(ws.data)[1];
    const s = getSelection();
    const busy = n => s.rangeCount > 0 && (s.anchorNode === n || s.focusNode === n);
    const gap = () => document.createTextNode('\n' + ind);
    for (let n = box.firstChild; n; n = n.nextSibling) {
      const next = n.nextSibling;
      if (n.nodeType === 1 && next && next.nodeType === 1) n.after(gap());
      else if (isSpace(n) && isSpace(next) && !busy(n) && !busy(next)) { next.data = n.data + next.data; const p = n.previousSibling; n.remove(); n = p || box.firstChild; if (!n) break; }
      else if (isSpace(n) && !busy(n) && n.previousSibling && n.previousSibling.nodeType === 1 && next && next.nodeType === 1 &&
        (!n.data.includes('\n') || /\n[ \t]+\n/.test(n.data))) n.data = '\n' + ind;
    }
    if (box.firstChild && box.firstChild.nodeType === 1) box.prepend(gap());
    if (box.lastChild && box.lastChild.nodeType === 1) box.append('\n' + ind.slice(2));
  }
  // Lines and indentation inside an inserted list or table: one bullet, section or row per line.
  function layoutMarkup(el, ind) {
    if (!/^(TABLE|THEAD|TBODY|TFOOT|UL|OL)$/.test(el.tagName) || [...el.childNodes].some(n => n.nodeType === 3 && n.data.trim())) return;
    const inner = ind + '  ';
    [...el.childNodes].filter(isSpace).forEach(n => n.remove());
    for (const c of [...el.children]) { c.before('\n' + inner); layoutMarkup(c, inner); }
    if (el.firstElementChild) el.append('\n' + ind);
  }

  // Where the visible content in the flow is (slide px), child by child, to see what an insert does to it.
  function flowLayout(s) {
    const sr = s.getBoundingClientRect();
    return [...s.children].filter(c => shown(c) && inFlow(c)).map(c => ({ el: c, rs: visibleRects(c).map(r => toSlide(r, sr)) }));
  }
  function contentArea(s) {
    const ss = getComputedStyle(s);
    return { left: parseFloat(ss.paddingLeft) || 0, top: parseFloat(ss.paddingTop) || 0, right: W - (parseFloat(ss.paddingRight) || 0), bottom: H - (parseFloat(ss.paddingBottom) || 0) };
  }
  const outside = (r, a) => Math.max(0, a.left - r.left, r.right - a.right, a.top - r.top, r.bottom - a.bottom);
  const hits = (r, list) => list.some(f => overlapArea(r, f) > 1);
  // Put a content block after the selected thing (or at the end). It floats instead (with a toast) when, in the
  // flow, it would squeeze or push out what is there (a flex chart shrinking), make the slide overflow, or land
  // under (or push content under) a shape or text box that floats on the slide.
  function insertFlow(el, absW, fit) {
    const s = curSlide();
    const cs = getComputedStyle(s);
    const flow = cs.display === 'block' || cs.display === 'flow-root' || (/flex/.test(cs.display) && cs.flexDirection.startsWith('column'));
    if (flow) {
      const sr = s.getBoundingClientRect(), area = contentArea(s);
      const floats = [...s.children].filter(c => shown(c) && !inFlow(c)).map(c => boxOf(c, sr));
      const before = flowLayout(s), over0 = overflowOf(s);
      const anchor = slideChild(selected);
      const added = anchor && !anchor.matches('aside.notes') && inFlow(anchor) ? putAfter(anchor, el) : putIn(s, el, notesOf(s));
      const after = new Map(flowLayout(s).map(x => [x.el, x.rs]));
      const mine = after.get(el) || [];
      const spoilt = before.some(({ el: c, rs }) => {
        const now = after.get(c);
        return !now || now.length !== rs.length || rs.some((r, i) => {
          const n = now[i];
          return n.right - n.left < r.right - r.left - 1 || n.bottom - n.top < r.bottom - r.top - 1 ||
            outside(n, area) > outside(r, area) + 1 || (hits(n, floats) && !hits(r, floats));
        });
      });
      // The new block's whole box counts, not just its first words: what is typed into it later must not run under
      // something floating there.
      if (!spoilt && overflowOf(s) <= over0 + 1 && !mine.some(r => outside(r, area) > 1 || hits(r, floats)) && !hits(boxOf(el, sr), floats)) return true;
      el.remove();
      added.forEach(n => n.remove());
      [...el.childNodes].filter(isSpace).forEach(n => n.remove());
    }
    // Text that floats takes only the room its words need (a title is not 1200px of blank box), with some to grow
    // into; a table that finds no room at its full width tries narrower before it would cover anything.
    let w, h, spot;
    if (fit) {
      const [nw, nh] = naturalSize(el, absW);
      w = Math.min(absW, Math.max(nw, fit)); h = Math.max(40, nh);
      spot = freeSpot(w, h);
    } else {
      for (const cw of [absW, Math.round(absW * 0.75), Math.round(absW * 0.5)]) {
        const ch = Math.max(40, naturalSize(el, cw, true)[1]), sp = freeSpot(cw, ch);
        if (!spot || !sp[2]) { w = cw; h = ch; spot = sp; }
        if (!sp[2]) break;
      }
    }
    placeAbs(el, fit ? absW : w, h, false, fit ? w : 0, spot);
    putIn(s, el, notesOf(s));
    if (flow && !spot[2]) toast('No room in the flow, so it was placed in a free spot', 3500);
    return false;
  }
  function finishInsert(el, editTarget) {
    if (editTarget) { startEditing(editTarget); selectAllIn(editTarget); } else select(el);
    commit();
    scheduleThumbs();
  }
  function insert(kind) {
    const s = curSlide();
    if (!s) return;
    hideToast();
    closePop();
    if (kind === 'text') return addTextBox();
    if (kind === 'image') return requestImage(null);
    if (kind === 'table') return insertTable(3, 3, true);
    if (kind === 'math') {
      const tex = prompt('Equation (TeX). E.g. \\frac{a}{b}, x^2, \\sum_{i=1}^n x_i', '');
      if (!tex) return;
      const anchor = selected && slideChild(selected);
      stopEditing();
      const d = document.createElement('div');
      d.className = 'math display';
      d.textContent = tex;
      // Among floating boxes and arrows (one selected, or a slide that is a diagram) it floats too, near them.
      if ((anchor && !inFlow(anchor) && shown(anchor)) || diagramSlide(s)) {
        const sp = (anchor && !inFlow(anchor) && spotBelow(s, anchor, 0, 300, 120)) || freeSpot(300, 120);
        placeAbs(d, 0, 120, false, 300, sp);
        d.style.removeProperty('max-width');
        d.style.width = 'max-content';
        putIn(s, d, notesOf(s));
      } else insertFlow(d, 1000, 400);
      finishInsert(d);
      loadKatex().then(() => { renderMathEl(d); scheduleThumbs(); drawSel(); });
      return;
    }
    stopEditing();
    if (kind === 'title') {
      const t = document.createElement('h2');
      t.textContent = 'Title';
      insertFlow(t, 1200, 400);
      return finishInsert(t, t);
    }
    if (kind === 'list') {
      const ul = document.createElement('ul');
      ul.innerHTML = '<li>Item</li>';
      insertFlow(ul, 900, 400);
      return finishInsert(ul, ul.firstElementChild);
    }
    if (kind === 'line' || kind === 'arrow') {
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('class', 'shape');
      svg.dataset.shape = kind;
      placeAbs(svg, 600, 40, true);
      drawLine(svg);
      putIn(s, svg, notesOf(s));
      return finishInsert(svg);
    }
    if (!['rect', 'round', 'circle'].includes(kind)) return;
    const shape = document.createElement('div');
    shape.className = 'shape';
    shape.dataset.shape = kind;
    placeAbs(shape, kind === 'circle' ? 360 : 480, kind === 'circle' ? 360 : 300, true);
    shape.style.background = 'var(--accent, #2f5bea)';
    if (kind === 'round') shape.style.borderRadius = '32px';
    if (kind === 'circle') shape.style.borderRadius = '50%';
    putIn(s, shape, notesOf(s));
    finishInsert(shape);
  }

  // ---------- tables ----------
  // Cells get visible lines and padding only when the deck's own CSS gives table cells none.
  function cellLook() {
    const probe = document.createElement('table');
    probe.setAttribute(RT, '');
    probe.style.cssText = 'position:absolute;visibility:hidden';
    probe.innerHTML = '<tbody><tr><th>x</th><td>x</td></tr></tbody>';
    curSlide().appendChild(probe);
    const td = getComputedStyle(probe.querySelector('td'));
    const bare = ['Top', 'Right', 'Bottom', 'Left'].every(k => parseFloat(td[`border${k}Width`]) === 0);
    const tight = parseFloat(td.paddingLeft) < 4;
    probe.remove();
    const cell = (bare ? 'border:1px solid color-mix(in srgb, currentColor 30%, transparent);' : '') + (tight ? 'padding:.35em .7em;' : '');
    return { td: cell, th: cell + (bare ? 'background:color-mix(in srgb, currentColor 8%, transparent);text-align:left;' : '') };
  }
  function buildTable(R, C, header, data) {
    const look = cellLook();
    const t = document.createElement('table');
    // Columns size to what is in them (a long method name gets a wide column).
    t.style.cssText = 'width:100%; border-collapse:collapse';
    const addRowTo = (sec, tag, r) => {
      const tr = sec.insertRow();
      for (let c = 0; c < C; c++) {
        const cell = document.createElement(tag);
        if (look[tag]) cell.style.cssText = look[tag];
        const v = data && data[r] && data[r][c];
        if (v) cell.textContent = v;
        tr.appendChild(cell);
      }
    };
    let r = 0;
    if (header) addRowTo(t.createTHead(), 'th', r++);
    if (r < R) {
      const body = t.createTBody();
      for (; r < R; r++) addRowTo(body, 'td', r);
    }
    return t;
  }
  function insertTable(R, C, header, data) {
    if (!curSlide()) return;
    hideToast();
    closePop();
    stopEditing();
    const t = buildTable(R, C, header, data);
    insertFlow(t, 960);
    if (data) select(t);
    else {
      const c = t.rows[0].cells[0];
      startEditing(c);
      caretAt(c);
    }
    commit();
    scheduleThumbs();
  }
  const isHeaderRow = tr => tr.parentElement.tagName === 'THEAD' || [...tr.cells].every(c => c.tagName === 'TH');
  function copyCell(src, tag) {
    const c = document.createElement(tag || src.tagName);
    const st = src.getAttribute('style');
    if (st) c.setAttribute('style', st);
    return c;
  }
  // The table as rows × logical columns: every slot holds the cell covering it (merged cells fill several slots).
  function tableGrid(table) {
    const rows = [...table.rows], g = rows.map(() => []);
    rows.forEach((tr, r) => {
      let c = 0;
      for (const cell of tr.cells) {
        while (g[r][c]) c++;
        const rs = Math.max(1, Math.min(cell.rowSpan || 1, rows.length - r)), cs = Math.max(1, cell.colSpan || 1);
        for (let i = 0; i < rs; i++) for (let j = 0; j < cs; j++) g[r + i][c + j] = cell;
        c += cs;
      }
    });
    return g;
  }
  const gridWidth = g => Math.max(0, ...g.map(r => r.length));
  // [row, column] of a cell's top-left slot.
  function cellAt(g, cell) {
    for (let r = 0; r < g.length; r++) { const c = g[r].indexOf(cell); if (c >= 0) return [r, c]; }
    return [-1, -1];
  }
  const hasSpans = table => [...table.querySelectorAll('td, th')].some(c => c.rowSpan > 1 || c.colSpan > 1);
  function setSpan(cell, name, n) { if (n > 1) cell.setAttribute(name, n); else cell.removeAttribute(name); }
  // A new row looks like the body rows; a header row is never copied into the body. Merged cells that the new row
  // falls inside grow by one row instead of getting a cell.
  function makeRow(table, ref, below) {
    const tpl = isHeaderRow(ref) ? [...table.rows].find(r => !isHeaderRow(r) && r.cells.length) : ref;
    const tr = document.createElement('tr');
    const fresh = src => {
      if (tpl) return copyCell(src);
      const c = copyCell(src, 'td');
      for (const p of ['background', 'font-weight', 'text-align']) c.style.removeProperty(p);
      if (c.getAttribute('style') === '') c.removeAttribute('style');
      return c;
    };
    if (!hasSpans(table)) {
      for (let i = 0; i < ref.cells.length; i++) tr.appendChild(fresh(tpl ? tpl.cells[Math.min(i, tpl.cells.length - 1)] : ref.cells[i]));
      return tr;
    }
    const g = tableGrid(table), rows = [...table.rows], at = rows.indexOf(ref) + (below ? 1 : 0);
    const tg = g[rows.indexOf(tpl || ref)] || [], grown = new Set();
    for (let c = 0; c < gridWidth(g); c++) {
      const up = g[at - 1] && g[at - 1][c], down = g[at] && g[at][c];
      if (up && up === down) { if (!grown.has(up)) { grown.add(up); setSpan(up, 'rowspan', up.rowSpan + 1); } continue; }
      const src = tg[c] || tg[tg.length - 1] || ref.cells[0];
      if (src) tr.appendChild(fresh(src)); else tr.appendChild(document.createElement('td'));
    }
    return tr;
  }
  function addRow(table, ref, below) {
    const tr = makeRow(table, ref, below);
    // A table written one row per line gets the new row on a line of its own.
    const ws = isSpace(ref.previousSibling) && ref.previousSibling.data.includes('\n') ? ref.previousSibling.data : null;
    if (below && ref.parentElement.tagName === 'THEAD') {
      let body = table.tBodies[0];
      if (!body) { body = document.createElement('tbody'); table.appendChild(body); }
      const first = isSpace(body.firstChild) ? body.firstChild : null;
      if (first) first.after(tr); else body.insertBefore(tr, body.firstChild);
      if (ws && first) tr.after(first.data);
    } else if (below) { ref.after(tr); if (ws) ref.after(ws); }
    else { ref.before(tr); if (ws) ref.before(ws); }
    return tr;
  }
  // Remove a row: merged cells reaching into it get one row shorter (one that starts in it moves down a row).
  function deleteRow(table, tr) {
    const g = tableGrid(table), rows = [...table.rows], r = rows.indexOf(tr);
    const seen = new Set();
    for (let c = 0; c < (g[r] || []).length; c++) {
      const cell = g[r][c];
      if (!cell || seen.has(cell) || cell.rowSpan < 2) continue;
      seen.add(cell);
      if (cell.parentElement === tr && rows[r + 1]) {
        const next = rows[r + 1], after = [...next.cells].find(x => cellAt(g, x)[1] > c);
        next.insertBefore(cell, after || null);
      }
      setSpan(cell, 'rowspan', cell.rowSpan - 1);
    }
    const sec = tr.parentElement;
    removeWithSpace(tr);
    if (sec !== table && !sec.rows.length) removeWithSpace(sec);
  }
  // A new column before logical column `at` (at = width: after the last). A merged cell the new column falls inside
  // grows by one column; every other row gets a cell like its neighbour.
  function addColAt(table, at, likeLeft = false) {
    const g = tableGrid(table), grown = new Set();
    [...table.rows].forEach((tr, r) => {
      const L = at > 0 ? g[r][at - 1] : null, R = g[r][at] || null;
      if (L && L === R) { if (!grown.has(L)) { grown.add(L); setSpan(L, 'colspan', L.colSpan + 1); } return; }
      const ref = likeLeft ? L || R : R || L;
      const c = ref ? copyCell(ref) : document.createElement(isHeaderRow(tr) ? 'th' : 'td');
      const next = [...tr.cells].find(x => cellAt(g, x)[1] >= at);
      if (next) next.before(c);
      else { const last = tr.cells[tr.cells.length - 1]; if (last) last.after(c); else tr.appendChild(c); }
    });
  }
  // Remove logical column `col`: cells only in it go, merged cells across it get one column narrower.
  function deleteCol(table, col) {
    const g = tableGrid(table), seen = new Set();
    for (const row of g) {
      const cell = row[col];
      if (!cell || seen.has(cell)) continue;
      seen.add(cell);
      if (cell.colSpan > 1) setSpan(cell, 'colspan', cell.colSpan - 1); else cell.remove();
    }
  }
  const cellsOf = table => [...table.rows].flatMap(r => [...r.cells]);
  // Move the caret to another cell; typing across cells is one undo step, and nothing is recorded if nothing changed.
  function goCell(target, where) {
    stopEditing(false);
    startEditing(target);
    if (where === 'all') selectAllIn(target);
    else {
      target.focus({ preventScroll: true });
      const r = document.createRange();
      r.selectNodeContents(target);
      r.collapse(where === 'start');
      const s = getSelection();
      s.removeAllRanges();
      s.addRange(r);
    }
    scheduleCommit();
    updateStatus();
  }
  function moveCell(d) {
    const cell = editing;
    if (!isCell(cell)) return;
    const table = cell.closest('table');
    const cells = cellsOf(table);
    let target = cells[cells.indexOf(cell) + d];
    if (!target) {
      if (d < 0) return;
      target = addRow(table, table.rows[table.rows.length - 1], true).cells[0];
    }
    goCell(target, 'all');
    updateCrumbs();
  }
  let imeTabPending = 0, imeTabAt = 0, composing = false;
  function queueImeTab(d) {
    imeTabPending = d;
    const run = () => {
      if (!imeTabPending) return;
      const dd = imeTabPending;
      imeTabPending = 0;
      imeTabAt = Date.now();
      if (isCell(editing)) moveCell(dd); else indentItems(dd);
    };
    afterComposition = run;
    // Some setups report keyCode 229 with nothing composing; then no compositionend comes, so move on our own.
    setTimeout(() => { if (!composing) run(); }, 80);
  }
  // Is the caret on the first (d<0) or last (d>0) line of `el`?
  function caretLineEdge(el, d) {
    const s = getSelection();
    if (!s.rangeCount) return true;
    const r = s.getRangeAt(0).cloneRange();
    r.collapse(d < 0);
    const rect = [...r.getClientRects()].find(x => x.height) || null;
    const all = document.createRange();
    all.selectNodeContents(el);
    const rs = [...all.getClientRects()].filter(x => x.height);
    if (!rs.length) return true;
    if (!rect) { const off = caretOffset(el); return d < 0 ? off === 0 : off >= el.textContent.length; }
    const half = rect.height / 2;
    return d < 0 ? rect.top < Math.min(...rs.map(x => x.top)) + half : rect.bottom > Math.max(...rs.map(x => x.bottom)) - half;
  }
  function cellVertical(d) {
    const cell = editing;
    if (!caretLineEdge(cell, d)) return false;
    const g = tableGrid(cell.closest('table')), [r, c] = cellAt(g, cell);
    const row = g[d > 0 ? r + Math.max(1, cell.rowSpan) : r - 1];
    const target = row && (row[c] || row[row.length - 1]);
    if (target && target !== cell) goCell(target, d < 0 ? 'end' : 'start');
    return true;
  }
  const TABLE_ALIAS = { 'row+': 'row-below', 'col+': 'col-right', 'row-': 'row-del', 'col-': 'col-del' };
  function tableOp(op) {
    op = TABLE_ALIAS[op] || op;
    const cell = editing;
    if (!isCell(cell)) return;
    const table = cell.closest('table'), tr = cell.parentElement;
    const rows = [...table.rows];
    // Columns are counted the way they look: a merged cell covers several.
    const g0 = tableGrid(table), [r0, c0] = cellAt(g0, cell);
    if (op === 'row-del' && rows.length < 2) return toast('Can\'t delete the last row');
    if (op === 'col-del' && gridWidth(g0) < 2) return toast('Can\'t delete the last column');
    stopEditing(false);
    if (op.startsWith('col-align-')) {
      // Align column …: every cell of the caret's column, as it looks (a merged cell across it too).
      const g = tableGrid(table), seen = new Set();
      for (const row of g) { const c = row[c0]; if (c && !seen.has(c)) { seen.add(c); c.style.textAlign = op.slice(10); } }
      startEditing(cell);
      caretAt(cell);
      commit();
      return refreshFmt();
    }
    if (op === 'table-del') {
      select(null);
      removeWithSpace(table);
      commit();
      return toast('Table deleted · ⌘Z to undo');
    }
    const at = (r, c) => { const g = tableGrid(table), row = g[Math.max(0, Math.min(r, g.length - 1))] || []; return row[Math.min(c, row.length - 1)] || cell; };
    let target = cell;
    if (op === 'row-above' || op === 'row-below') {
      const n = addRow(table, tr, op === 'row-below');
      target = at([...table.rows].indexOf(n), c0);
    } else if (op === 'col-left' || op === 'col-right') {
      const col = op === 'col-right' ? c0 + Math.max(1, cell.colSpan) : c0;
      addColAt(table, col, op === 'col-right');
      target = at(r0, col);
    } else if (op === 'row-del') {
      const i = rows.indexOf(tr);
      deleteRow(table, tr);
      target = at(i < rows.length - 1 ? i : i - 1, c0);
    } else if (op === 'col-del') {
      deleteCol(table, c0);
      target = at(r0, c0);
    }
    startEditing(target);
    caretAt(target);
    commit();
    updateCrumbs();
    refreshFmt();
  }
  // With the whole table selected: align, bold and colour go onto every cell (inline styles), as one undo step.
  function tableCells(fn) {
    const table = selected;
    if (!table || table.tagName !== 'TABLE') return;
    for (const c of table.querySelectorAll('td, th')) { fn(c); if (c.getAttribute('style') === '') c.removeAttribute('style'); }
    commit();
    refreshObj();
  }
  const allBold = table => [...table.querySelectorAll('td, th')].every(c => parseInt(getComputedStyle(c).fontWeight, 10) >= 600);
  // Row ▾ / Column ▾ on a selected table (no cell being edited): add at either end, remove the last; the table stays selected.
  function tableSelOp(op) {
    const table = selected;
    if (!table || table.tagName !== 'TABLE' || !table.rows.length) return;
    const rows = [...table.rows], last = rows[rows.length - 1], n = gridWidth(tableGrid(table));
    if (op === 'row-del' && rows.length < 2) return toast('Can\'t delete the last row');
    if (op === 'col-del' && n < 2) return toast('Can\'t delete the last column');
    if (op === 'row-end') addRow(table, last, true);
    else if (op === 'row-start') {
      const body = rows.find(r => !isHeaderRow(r));
      if (body) addRow(table, body, false); else addRow(table, last, true);
    } else if (op === 'row-del') deleteRow(table, last);
    else if (op === 'col-end') addColAt(table, n, true);
    else if (op === 'col-start') addColAt(table, 0);
    else if (op === 'col-del') deleteCol(table, n - 1);
    commit();
    updateCrumbs();
    chipKey = '';
  }
  // Clipboard → grid of strings: an HTML table (spreadsheets), tab-separated text, a markdown table, or CSV.
  function splitCsv(line) {
    const out = [];
    let cur = '', q = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (q) {
        if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') q = false; else cur += ch;
      } else if (ch === '"' && !cur.trim()) q = true;
      else if (ch === ',') { out.push(cur.trim()); cur = ''; }
      else cur += ch;
    }
    out.push(cur.trim());
    return out;
  }
  function parseGrid(dt) {
    const markup = dt.getData('text/html');
    if (markup && /<table/i.test(markup)) {
      const t = new DOMParser().parseFromString(markup, 'text/html').querySelector('table');
      if (t) {
        const g = [...t.rows].map(r => [...r.cells].map(c => c.textContent.replace(/\s+/g, ' ').trim())).filter(r => r.length);
        if (g.length) return g;
      }
    }
    const text = (dt.getData('text/plain') || '').replace(/\r\n?/g, '\n').replace(/\n+$/, '');
    if (!text) return null;
    const lines = text.split('\n');
    if (text.includes('\t')) return lines.map(l => l.split('\t'));
    const sep = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;
    const filled = lines.filter(l => l.trim());
    if (filled.length >= 2 && filled.some(l => sep.test(l)) && filled.every(l => l.includes('|'))) {
      return filled.filter(l => !sep.test(l)).map(l => l.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim()));
    }
    if (filled.length >= 2) {
      const g = filled.map(splitCsv);
      if (g[0].length >= 2 && g.every(r => r.length === g[0].length)) return g;
    }
    return [[text]];
  }
  const gridSize = g => [g.length, Math.max(0, ...g.map(r => r.length))];
  // Fill cells from the caret cell rightwards and down, adding rows and columns as needed. Text only.
  function pasteIntoTable(cell, grid) {
    const table = cell.closest('table');
    const [R, C] = gridSize(grid);
    stopEditing(false);
    const [r0, c0] = cellAt(tableGrid(table), cell);
    while (table.rows.length < r0 + R) addRow(table, table.rows[table.rows.length - 1], true);
    while (gridWidth(tableGrid(table)) < c0 + C) addColAt(table, gridWidth(tableGrid(table)), true);
    const g = tableGrid(table);
    for (let i = 0; i < R; i++) {
      grid[i].forEach((v, j) => {
        const c = g[r0 + i] && g[r0 + i][c0 + j];
        const [cr, cc] = c ? cellAt(g, c) : [-1, -1];
        if (cr === r0 + i && cc === c0 + j) c.textContent = v;   // a merged cell takes the value of its first slot
      });
    }
    startEditing(cell);
    caretAt(cell);
    commit();
    updateCrumbs();
    toast(`Pasted ${R} × ${C} cells`);
  }
  function tableFromGrid(grid) {
    const [R, C] = gridSize(grid);
    insertTable(R, C, true, grid);
    toast(`Created a ${R} × ${C} table`);
  }

  // Lines are redrawn at their real pixel size so arrowheads never stretch.
  function drawLine(svg) {
    const w = Math.max(20, Math.round(parseFloat(svg.style.width) || 600));
    const h = Math.max(8, Math.round(parseFloat(svg.style.height) || 40));
    const old = svg.querySelector('line');
    const c = (old && old.style.stroke) || 'var(--ink, #222)';
    const y = h / 2, sw = Math.max(2, Math.min(8, Math.round(h / 6)));
    const head = svg.dataset.shape === 'arrow' ? Math.min(Math.max(sw * 4, 18), w / 3) : 0;
    const n = v => Math.round(v * 10) / 10;   // at most one decimal in the file
    svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
    svg.innerHTML = `<line x1="0" y1="${n(y)}" x2="${n(w - head * 0.9)}" y2="${n(y)}" style="stroke:${c};stroke-width:${sw}"/>` +
      (head ? `<polygon points="${n(w - head)},${n(y - head * 0.55)} ${w},${n(y)} ${n(w - head)},${n(y + head * 0.55)}" style="fill:${c}"/>` : '');
  }
  function slideAction(kind) {
    if (kind === 'dup') return duplicateSlide();
    if (kind === 'del') return deleteSlide();
    newSlide(kind);
  }
  // 'new' is a title + list slide, 'blank' an empty one; after the current slide, or at the end.
  function newSlide(kind, atEnd) {
    if (!curSlide()) return;
    hideToast();
    stopEditing();
    const s = document.createElement('section');
    s.className = 'slide';
    if (kind === 'new') s.innerHTML = '\n    <h2>Title</h2>\n    <ul>\n      <li>Content</li>\n    </ul>\n  ';
    else s.textContent = '\n  ';
    const all = slides();
    const ref = atEnd ? all[all.length - 1] : curSlide();
    const gap = isSpace(ref.previousSibling) ? ref.previousSibling.data : '';
    ref.after(s);
    if (gap) ref.after(gap);
    commit();
    go(slides().indexOf(s));
    buildThumbs();
    const h = s.querySelector('h2');
    if (h) { startEditing(h); selectAllIn(h); }
  }

  // ---------- object toolbar ----------
  function setFill(c) {
    const shapes = sel.filter(el => el.classList.contains('shape'));
    if (!shapes.length) return;
    for (const el of shapes) {
      if (el.dataset.shape === 'line' || el.dataset.shape === 'arrow') {
        el.querySelectorAll('line').forEach(l => (l.style.stroke = c || 'var(--ink, #222)'));
        el.querySelectorAll('polygon').forEach(g => (g.style.fill = c || 'var(--ink, #222)'));
      } else if (c) {
        // A fill again after No fill: the outline goes.
        if (/transparent|rgba\(.*,\s*0\)$/.test(getComputedStyle(el).backgroundColor)) el.style.removeProperty('border');
        el.style.background = c;
        inkFor(el);
      } else {
        // No fill: only the outline is left, in the shape's colour, so the shape stays visible and can be grabbed.
        const cs = getComputedStyle(el);
        const own = el.style.background || el.style.backgroundColor;
        const was = own.startsWith('var(') ? own : /transparent|rgba\(.*,\s*0\)$/.test(cs.backgroundColor) ? (parseFloat(cs.borderTopWidth) ? cs.borderTopColor : 'var(--accent, #2f5bea)') : cs.backgroundColor;
        el.style.removeProperty('background-color');
        el.style.background = 'transparent';
        el.style.border = `4px solid ${was}`;
        el.style.removeProperty('outline');
        inkFor(el);
      }
    }
    commit();
    refreshObj();
  }
  function objAction(a) {
    const el = selected;
    if (a === 'up') { stopEditing(); return select(parentOf(el)); }
    if (!el) return;
    if (a === 'smaller' || a === 'bigger') return scaleBy(a === 'bigger' ? 1.1 : 1 / 1.1);
    if (a === 'tbold') { const on = allBold(el); return tableCells(c => { if (on) c.style.removeProperty('font-weight'); else c.style.fontWeight = 'bold'; if (on && parseInt(getComputedStyle(c).fontWeight, 10) >= 600) c.style.fontWeight = 'normal'; }); }
    if (a === 'del') return removeSelected();
    if (a === 'dup') return duplicateSelected();
    if (a === 'image') return requestImage(el.tagName === 'IMG' || figureMedia(el) ? el : null, $('.otb [data-obj="image"]'));
    if (a === 'tex') {
      if (!el.classList.contains('math')) return;
      startEditing(el);
      return caretAt(el);
    }
    // Order and rotation apply to the members that float freely.
    const free = sel.filter(isFree);
    if (a === 'rotl' || a === 'rotr') {
      for (const x of free) {
        const now = parseFloat(x.style.rotate) || 0;
        const deg = ((now + (a === 'rotr' ? 15 : -15)) % 360 + 360) % 360;
        if (deg) x.style.rotate = deg + 'deg'; else x.style.removeProperty('rotate');
        tidy(x);
      }
      return commit();
    }
    if (a === 'front' || a === 'back') {
      for (const x of free) {
        const others = [...x.parentElement.children].filter(y => y !== x && !y.hasAttribute(RT) && getComputedStyle(y).position !== 'static');
        const z = y => parseInt(getComputedStyle(y).zIndex, 10) || 0;
        if (getComputedStyle(x).position === 'static') x.style.position = 'relative';
        if (a === 'front') { x.style.zIndex = Math.max(0, ...others.map(z)) + 1; continue; }
        // To the back without a negative z-index (which would hide it behind the slide's own background where the slide
        // is not a stacking context): it goes to 0 and the floating things it overlaps come up to 1.
        x.style.zIndex = '0';
        const r = x.getBoundingClientRect();
        for (const y of others) if (z(y) <= 0 && overlapArea(y.getBoundingClientRect(), r) > 0) y.style.zIndex = '1';
      }
      return commit();
    }
  }

  // Order and rotation only make sense for things that float freely; lists, tables and text in the flow get neither.
  const isFree = el => el instanceof SVGElement || el.tagName === 'IMG' || el.classList.contains('shape') || getComputedStyle(el).position === 'absolute';
  function refreshObj() {
    const el = selected;
    if (!el) return;
    const many = sel.length > 1;
    const shapes = sel.every(x => x.classList.contains('shape'));
    $('.otb .g-arrange').classList.remove('hide');
    $('.otb .g-fill').classList.toggle('hide', !shapes);
    $('.otb .g-tbl').classList.toggle('hide', many || el.tagName !== 'TABLE');
    $('.otb .g-tcell').classList.toggle('hide', many || el.tagName !== 'TABLE');
    if (!many && el.tagName === 'TABLE') {
      const c0 = el.querySelector('td, th');
      setFace($('.otb [data-menu="talign"]'), (ALIGNS.find(x => x[0] === curAlign(c0 || el)) || ALIGNS[0])[2]);
      $('.otb [data-obj="tbold"]').classList.toggle('on', allBold(el));
      $('.otb .g-tcell .colorA').style.setProperty('--sw', getComputedStyle(c0 || el).color);
    }
    $('.otb .g-img').classList.toggle('hide', many || !(el.tagName === 'IMG' || figureMedia(el)));
    $('.otb .g-tex').classList.toggle('hide', many || !el.classList.contains('math'));
    $('.otb .g-more').classList.toggle('hide', !sel.some(isFree));
    $('.otb .szl').textContent = sizeLabel(sel);
    if (shapes) {
      const line = el.querySelector('line');
      $('.otb .swatch').style.setProperty('--sw', line ? getComputedStyle(line).stroke : getComputedStyle(el).backgroundColor);
    }
  }
  function anchorEl() {
    const s = getSelection();
    let n = s.rangeCount ? s.anchorNode : null;
    if (n && n.nodeType === 3) n = n.parentElement;
    return n && editing && editing.contains(n) ? n : editing;
  }
  function curAlign(el) {
    const al = getComputedStyle(el).textAlign;
    return al === 'start' || al === '-webkit-left' ? 'left' : al === 'end' || al === '-webkit-right' ? 'right' : al === '-webkit-center' ? 'center' : al;
  }
  const listType = el => (el && el.tagName === 'LI' ? el.parentElement.tagName : '');
  function setFace(btn, key) {
    const f = btn.querySelector('.face');
    if (f.dataset.k !== key) { f.dataset.k = key; f.innerHTML = IC[key]; }
  }
  function refreshFmt() {
    if (!isRich(editing) || !shadow) return;
    const el = curBlock() || editing;
    const on = (sel, v) => shadow.querySelectorAll(sel).forEach(b => b.classList.toggle('on', !!v));
    for (const c of ['bold', 'italic', 'strikeThrough']) on(`[data-fmt="${c}"]`, document.queryCommandState(c));
    const a = anchorEl();
    on('[data-fmt="code"]', a.closest('code') && editing.contains(a.closest('code')));
    on('.fmt [data-fmt="link"]', a.closest('a') && editing.contains(a.closest('a')));
    const list = listType(el);
    on('[data-fmt="ol"]', list === 'OL');
    on('[data-fmt="ul"]', list === 'UL');
    on('[data-fmt="quote"]', el.tagName === 'BLOCKQUOTE');
    const al = curAlign(el);
    shadow.querySelectorAll('[data-fmt="align"]').forEach(b => b.classList.toggle('on', b.dataset.val === al));
    setFace($('.fmt .g-align'), (ALIGNS.find(x => x[0] === al) || ALIGNS[0])[2]);
    setFace($('.fmt .g-list'), list === 'OL' ? 'ol' : 'ul');
    // Labels are names people use (Body, Title 1, List …), never tag names; the block menu hides where it cannot apply.
    const cell = isCell(editing);
    const block = BLOCKS.find(([t]) => t === el.tagName);
    $('.fmt .block .lbl').textContent = block ? block[1] : el.tagName === 'LI' ? 'List' : friendly(el);
    $('.fmt .block').classList.toggle('hide', cell || !canRetag(el));
    $('.fmt .g-list').classList.toggle('hide', cell);
    $('.fmt .g-table').classList.toggle('hide', !cell);
    $('.fmt .size .lbl').textContent = Math.round(parseFloat(getComputedStyle(a).fontSize));
    $('.fmt .colorA').style.setProperty('--sw', getComputedStyle(a).color);
  }

  function saveRange() { const s = getSelection(); return s.rangeCount ? s.getRangeAt(0).cloneRange() : null; }
  function restoreRange(r) {
    if (!editing) return;
    editing.focus({ preventScroll: true });
    if (!r) return;
    const s = getSelection();
    s.removeAllRanges();
    s.addRange(r);
  }
  function caretOffset(el) {
    const s = getSelection();
    if (!s.rangeCount || !el.contains(s.anchorNode)) return el.textContent.length;
    const r = document.createRange();
    r.selectNodeContents(el);
    r.setEnd(s.anchorNode, s.anchorOffset);
    return r.toString().length;
  }
  // The caret `off` characters into el's text, counted as caretOffset counts them (a formula's text included). It never
  // goes inside a formula: typing there would be lost.
  function restoreCaret(el, off) {
    focusHost(el);
    let [n, o] = pointIn(el, off);
    // Right after a formula with no text behind it, the caret needs a text to sit in (stopEditing drops it again).
    const prev = n.nodeType === 1 && n.childNodes[o - 1];
    if (prev && prev.nodeType === 1 && prev.classList.contains('math') && !el.classList.contains('math')) {
      const z = document.createTextNode('\u200b');
      prev.after(z);
      [n, o] = [z, 1];
    }
    placeCaret(n, o);
  }
  const hasSelection = () => { const s = getSelection(); return s.rangeCount && !s.isCollapsed && editing && editing.contains(s.anchorNode); };
  // With no text selected, a format applies to the whole paragraph.
  function selectWholeIfCollapsed() {
    if (hasSelection()) return false;
    selectAllIn(curBlock() || editing);
    return true;
  }
  function unwrap(n) { n.replaceWith(...n.childNodes); }
  function afterFmt() { rememberSpans(); scheduleCommit(); refreshFmt(); }
  function reEdit(el, off) {
    select(el);
    startEditing(el);
    restoreCaret(el, off);
    commit();
    refreshFmt();
  }

  function fmt(cmd, val) {
    if (!isRich(editing)) return;
    if (commitTimer) commit();   // typing so far is its own undo step
    const el = curBlock() || editing;
    switch (cmd) {
      case 'bold': case 'italic': case 'strikeThrough': {
        const whole = selectWholeIfCollapsed();
        quiet++;
        try {
          document.execCommand('styleWithCSS', false, false);
          document.execCommand(cmd);
        } finally { quiet--; }
        if (whole) caretAt(el);
        return afterFmt();
      }
      case 'code': return toggleCode();
      case 'clear': return clearFormat();
      case 'ol': case 'ul': return toggleList(cmd.toUpperCase());
      case 'unlist': { const t = listType(el); return t ? toggleList(t) : undefined; }
      case 'indent': return indentItems(1);
      case 'outdent': return indentItems(-1);
      case 'quote': return setBlock(el.tagName === 'BLOCKQUOTE' ? 'P' : 'BLOCKQUOTE');
      case 'align': {
        for (const b of touchedBlocks()) {
          b.style.textAlign = val;
          if (b.getAttribute('style') === '') b.removeAttribute('style');
        }
        return afterFmt();
      }
      case 'link': return makeLink();
      case 'unlink': {
        const a = anchorEl().closest('a');
        if (a && el.contains(a)) unwrap(a);
        else document.execCommand('unlink');
        return afterFmt();
      }
      case 'math': return insertMath();
      case 'table-del': case 'row+': case 'col+': case 'row-': case 'col-': return tableOp(cmd);
    }
  }
  function toggleCode() {
    const rb = rangeBlocks();
    if (rb && rb[0] !== rb[1]) return codeAcross(rb);
    const c = anchorEl().closest('code');
    if (c && editing.contains(c)) { unwrap(c); return afterFmt(); }
    if (!hasSelection()) {
      // Nothing selected: what is typed next is code.
      const s = getSelection();
      if (!s.rangeCount || !editing.contains(s.anchorNode)) return;
      const code = document.createElement('code'), z = document.createTextNode('\u200b');
      code.appendChild(z);
      s.getRangeAt(0).insertNode(code);
      placeCaret(z, 1);
      return afterFmt();
    }
    const r = getSelection().getRangeAt(0);
    const code = document.createElement('code');
    code.appendChild(r.extractContents());
    r.insertNode(code);
    const sel = document.createRange();
    sel.selectNodeContents(code);
    restoreRange(sel);
    afterFmt();
  }
  // Code over several paragraphs or bullets: each block's selected words get their own inline <code> inside that block
  // (or lose it, when all of them are code already). A <code> never holds a whole paragraph or bullet.
  function codeAcross([a, z, r]) {
    const all = leafBlocks(), from = all.indexOf(a), to = all.indexOf(z);
    if (from < 0 || to < from) return;
    const parts = all.slice(from, to + 1).map(b => {
      const x = document.createRange();
      x.setStart(...startOf(b));
      x.setEnd(...ownEnd(b));
      if (b === a && x.comparePoint(r.startContainer, r.startOffset) >= 0) x.setStart(r.startContainer, r.startOffset);
      if (b === z && x.comparePoint(r.endContainer, r.endOffset) <= 0) x.setEnd(r.endContainer, r.endOffset);
      return { b, x };
    }).filter(p => !p.x.collapsed && p.x.toString().trim());
    if (!parts.length) return;
    const texts = x => { const out = [], w = document.createTreeWalker(x.commonAncestorContainer.nodeType === 1 ? x.commonAncestorContainer : x.commonAncestorContainer.parentNode, NodeFilter.SHOW_TEXT); for (let n; (n = w.nextNode());) if (n.data.trim() && x.intersectsNode(n) && !n.parentElement.closest('.math')) out.push(n); return out; };
    const allCode = parts.every(p => texts(p.x).every(n => { const c = n.parentElement.closest('code'); return c && p.b.contains(c); }));
    let first = null, last = null;
    for (const { b, x } of parts) {
      if (allCode) {
        for (const c of [...b.querySelectorAll('code')]) if (x.intersectsNode(c) && !c.closest('pre')) unwrap(c);
        continue;
      }
      const code = document.createElement('code');
      code.appendChild(x.extractContents());
      code.querySelectorAll('code').forEach(unwrap);
      x.insertNode(code);
      first = first || code;
      last = code;
    }
    parts.forEach(p => p.b.normalize());
    if (first) {
      const sel = document.createRange();
      sel.setStart(first, 0);
      sel.setEnd(last, last.childNodes.length);
      restoreRange(sel);
    }
    afterFmt();
  }
  // A <code> around whole blocks (never made by the editor today, but possible in older saves) is taken away.
  function unwrapBlockCode(root) {
    for (const c of [...root.querySelectorAll('code')].reverse()) if ([...c.children].some(k => /^(LI|P|UL|OL|DIV|H[1-6]|BLOCKQUOTE|PRE|TABLE|TR|TD|TH|FIGURE)$/.test(k.tagName)) || isList(c.parentElement)) unwrap(c);
  }
  function clearFormat() {
    const host = editing, el = curBlock() || editing;
    const whole = selectWholeIfCollapsed();
    const r = getSelection().getRangeAt(0);
    quiet++;
    try { document.execCommand('removeFormat'); } finally { quiet--; }
    for (const n of [...host.querySelectorAll('code, span:not(.math):not(.math *), font')]) {
      if (r.intersectsNode(n) && !n.closest('.math')) unwrap(n);
    }
    if (whole) {
      el.style.removeProperty('font-size');
      el.style.removeProperty('color');
      el.style.removeProperty('text-align');
      if (el.getAttribute('style') === '') el.removeAttribute('style');
      caretAt(el);
    }
    el.normalize();
    afterFmt();
  }
  const canRetag = el => !['LI', 'TD', 'TH', 'DT', 'DD', 'FIGCAPTION', 'CAPTION', 'SUMMARY', 'LABEL'].includes(el.tagName);
  function retag(el, tag) {
    const n = document.createElement(tag);
    for (const a of [...el.attributes]) if (a.name !== 'contenteditable') n.setAttribute(a.name, a.value);
    while (el.firstChild) n.appendChild(el.firstChild);
    el.replaceWith(n);
    return n;
  }
  // Paragraph kind (Body, Title …) for the caret's block, or for every block the selection touches.
  function setBlock(tag) {
    if (commitTimer) commit();   // typing so far is its own undo step
    const blocks = touchedBlocks().filter(b => b.tagName !== tag);
    if (!blocks.length) return;
    const ok = blocks.filter(canRetag);
    if (!ok.length) return toast('Can\'t change the paragraph style inside a list or table');
    const all = touchedBlocks();
    const a = all[0], z = all[all.length - 1];
    const [ao, zo] = selOffsets(a, z);
    const map = new Map(ok.map(b => [b, b]));
    if (ok.includes(editing)) dropEditing();
    for (const b of ok) map.set(b, retag(b, tag));
    afterBlockChange(map.get(a) || a, ao, map.get(z) || z, zo);
  }
  // List ▾: bullets ↔ numbers ↔ plain paragraphs, for the caret's block or every block the selection touches.
  function toggleList(type) {
    if (commitTimer) commit();   // typing so far is its own undo step
    const blocks = touchedBlocks();
    if (!blocks.length) return;
    const a0 = blocks[0], z0 = blocks[blocks.length - 1];
    const [ao, zo] = selOffsets(a0, z0);
    const map = new Map(), shift = new Map();
    const host = editing, multi = editMulti;
    if (blocks.every(b => b.tagName === 'LI')) {
      const lists = [...new Set(blocks.map(b => b.parentElement))];
      if (lists.every(l => l.tagName === type)) {
        // Back to paragraphs: the chosen bullets (sub-bullets too, each a paragraph of its own after its parent's) leave
        // their list; the bullets before and after stay lists, nested as they were.
        const tops = [...new Set(blocks.map(outerList))], chosen = new Set(blocks);
        // Editing stops with nothing tidied: an empty bullet just made is one of the lines that change.
        if (tops.includes(host)) dropEditing();
        for (const T of tops) {
          // A list floating as a text box stays one box: its lines become one positioned paragraph, a line break
          // between them, the way Enter works in a text box.
          if (/^(absolute|fixed)$/.test(getComputedStyle(T).position)) {
            const items = [...T.querySelectorAll('li')];
            const p = document.createElement('p');
            if (T.getAttribute('style')) p.setAttribute('style', T.getAttribute('style'));
            const cls = items.length && items[0].getAttribute('class');
            if (cls) p.setAttribute('class', cls);
            items.forEach((li, i) => {
              if (i) p.appendChild(document.createElement('br'));
              shift.set(li, p.textContent.length);
              for (const n of [...li.childNodes]) {
                if (n.nodeType === 1 && isList(n)) continue;
                if (isSpace(n) && n.data.includes('\n')) continue;
                p.appendChild(n);
              }
              map.set(li, p);
            });
            T.replaceWith(p);
            continue;
          }
          const ind = lineIndent(T), first = T.firstElementChild && lineIndent(T.firstElementChild);
          const step = ind != null && first && first.length > ind.length && first.startsWith(ind) ? first.slice(ind.length) : '  ';
          const entries = [];
          const walk = (l, d) => {
            for (const li of [...l.children]) {
              if (li.tagName !== 'LI') continue;
              entries.push({ li, d, list: l });
              for (const sl of [...li.children].filter(isList)) walk(sl, d + 1);
            }
          };
          walk(T, 0);
          for (const { li } of entries) {
            [...li.children].filter(isList).forEach(x => x.remove());
            while (isSpace(li.lastChild) && li.lastChild.previousSibling) li.lastChild.remove();
            const t = li.lastChild;
            if (t && t.nodeType === 3 && /\S\s*\n\s*$/.test(t.data)) t.data = t.data.replace(/\s+$/, '');
          }
          const shell = l => { const c = l.cloneNode(false); c.removeAttribute('id'); c.removeAttribute('style'); c.removeAttribute('contenteditable'); return c; };
          const out = [];
          let stack = [];
          for (const e of entries) {
            if (chosen.has(e.li)) {
              const p = document.createElement('p');
              if (e.li.getAttribute('class')) p.setAttribute('class', e.li.getAttribute('class'));
              while (e.li.firstChild) p.appendChild(e.li.firstChild);
              e.li.remove();
              map.set(e.li, p);
              out.push(p);
              stack = [];
              continue;
            }
            if (!stack.length) {
              const root = !out.length && e.d === 0 ? T : shell(e.list);
              out.push(root);
              stack = [{ l: root, d: e.d }];
            } else {
              while (stack.length > 1 && stack[stack.length - 1].d > e.d) stack.pop();
              const top = stack[stack.length - 1];
              if (e.d > top.d && top.l.lastElementChild) {
                const nl = shell(e.list);
                top.l.lastElementChild.appendChild(nl);
                stack.push({ l: nl, d: e.d });
              }
            }
            stack[stack.length - 1].l.appendChild(e.li);
          }
          if (out[0] === T) T.after(...out.slice(1));
          else {
            // The list's own style (e.g. its position) moves to the first paragraph.
            if (T.getAttribute('style')) out[0].setAttribute('style', T.getAttribute('style'));
            T.replaceWith(...out);
          }
          // A list written one bullet per line: every piece on a line of its own, indented like the list.
          if (ind != null && first != null) {
            for (let i = 1; i < out.length; i++) out[i].before('\n' + ind);
            for (const x of out) if (isList(x)) relayList(x, ind, step);
          }
        }
      } else {
        if (lists.includes(host)) dropEditing();
        for (const l of lists) if (l.tagName !== type) retag(l, type);
      }
    } else {
      const plain = blocks.filter(b => b.tagName !== 'LI');
      if (plain.some(b => !canRetag(b))) return toast('Can\'t make a list here');
      if (plain.includes(host)) dropEditing();
      const made = new Set();
      for (const el of plain) {
        const li = document.createElement('li');
        // A styled paragraph (a title slide's .sub) keeps its class on the bullet, and gets it back as a paragraph.
        if (el.getAttribute('class')) li.setAttribute('class', el.getAttribute('class'));
        while (el.firstChild) li.appendChild(el.firstChild);
        const prev = el.previousElementSibling;
        if (prev && prev.tagName === type && !el.getAttribute('style')) {
          prev.appendChild(li);
          removeWithSpace(el);
          made.add(prev);
        } else {
          const list = document.createElement(type);
          if (el.getAttribute('style')) list.setAttribute('style', el.getAttribute('style'));
          list.appendChild(li);
          el.replaceWith(list);
          made.add(list);
        }
        map.set(el, li);
      }
      // One bullet per line, like the markup around it.
      for (const l of multi ? made : []) {
        if (!l.isConnected || [...l.childNodes].some(n => n.nodeType === 3 && n.data.trim())) continue;
        const m = l.previousSibling && l.previousSibling.nodeType === 3 && /\n([ \t]*)$/.exec(l.previousSibling.data);
        if (m) layoutMarkup(l, m[1]);
      }
    }
    afterBlockChange(map.get(a0) || a0, ao + (shift.get(a0) || 0), map.get(z0) || z0, zo + (shift.get(z0) || 0));
  }
  // With nothing selected, size and color apply to the caret's paragraph or bullet; otherwise to the selected text.
  function setSize(px) {
    if (!isRich(editing)) return;
    if (commitTimer) commit();   // typing so far is its own undo step
    const el = editing;
    if (!hasSelection()) {
      const b = curBlock() || el;
      const [o] = selOffsets(b, b);
      if (px) b.style.fontSize = px + 'px';
      else b.style.removeProperty('font-size');
      b.querySelectorAll('[style*="font-size"]').forEach(n => { n.style.removeProperty('font-size'); if (!n.getAttribute('style') && n.tagName === 'SPAN') unwrap(n); });
      if (b.getAttribute('style') === '') b.removeAttribute('style');
      selectBetween(b, o);
      return afterFmt();
    }
    quiet++;
    try {
      document.execCommand('styleWithCSS', false, false);
      document.execCommand('fontSize', false, '7');
    } finally { quiet--; }
    const spans = [...el.querySelectorAll('font[size="7"]')].map(f => {
      const sp = document.createElement('span');
      if (px) sp.style.fontSize = px + 'px';
      while (f.firstChild) sp.appendChild(f.firstChild);
      f.replaceWith(sp);
      sp.querySelectorAll('[style*="font-size"]').forEach(n => n.style.removeProperty('font-size'));
      return sp;
    });
    for (const sp of spans) if (!px) unwrap(sp);
    const live = spans.filter(sp => sp.isConnected);
    if (live.length) {
      const r = document.createRange();
      r.setStartBefore(live[0]);
      r.setEndAfter(live[live.length - 1]);
      restoreRange(r);
    }
    afterFmt();
  }
  function setColor(c) {
    if (!isRich(editing)) return;
    if (commitTimer) commit();   // typing so far is its own undo step
    const el = editing;
    if (!hasSelection()) {
      const b = curBlock() || el;
      const [o] = selOffsets(b, b);
      if (c) b.style.color = c;
      else b.style.removeProperty('color');
      if (b.getAttribute('style') === '') b.removeAttribute('style');
      selectBetween(b, o);
      return afterFmt();
    }
    // execCommand only takes literal colors: paint a marker color, then swap in the real value (which may be var(--x)).
    quiet++;
    try {
      document.execCommand('styleWithCSS', false, true);
      document.execCommand('foreColor', false, '#010203');
      document.execCommand('styleWithCSS', false, false);
    } finally { quiet--; }
    for (const n of el.querySelectorAll('[style*="color"], font[color]')) {
      const marked = n.style.color === 'rgb(1, 2, 3)' || (n.getAttribute('color') || '').toLowerCase() === '#010203';
      if (!marked) continue;
      n.removeAttribute('color');
      if (c) n.style.color = c;
      else n.style.removeProperty('color');
      if (!n.getAttribute('style') && /^(SPAN|FONT)$/.test(n.tagName)) unwrap(n);
    }
    afterFmt();
  }
  function makeLink() {
    const r = saveRange();
    const old = anchorEl().closest('a');
    const url = prompt('Link URL', old ? old.getAttribute('href') : 'https://');
    restoreRange(r);
    if (!url) return;
    quiet++;
    try {
      if (old && editing.contains(old)) old.setAttribute('href', url);
      else if (hasSelection()) document.execCommand('createLink', false, url);
      else {
        document.execCommand('insertHTML', false, `<a href="${esc(url)}">${esc(url)}</a>`);
        // Inside a flex slide Chrome copies the computed display onto the new link; keep it a plain <a href>.
        editing.querySelectorAll('a[style]').forEach(a => { if (/^\s*display:\s*inline\s*!important;?\s*$/.test(a.getAttribute('style'))) a.removeAttribute('style'); });
      }
    } finally { quiet--; }
    afterFmt();
  }
  function insertMath() {
    const r = saveRange();
    const tex = prompt('Equation (TeX). E.g. \\frac{a}{b}, x^2, \\alpha', hasSelection() ? getSelection().toString() : '');
    restoreRange(r);
    if (!tex) return;
    // Inserted by hand: Chrome's insertHTML drops the class-only <span>.
    const range = getSelection().rangeCount ? getSelection().getRangeAt(0) : null;
    if (!range || !editing.contains(range.startContainer)) return;
    range.deleteContents();
    const m = document.createElement('span');
    m.className = 'math';
    m.textContent = tex;
    m.setAttribute('contenteditable', 'false');
    // The zero-width space gives the caret a place after the formula; stopEditing removes it.
    const after = document.createTextNode('\u200b');
    range.insertNode(after);
    range.insertNode(m);
    placeCaret(after, 1);
    loadKatex().then(() => {
      if (!editing) return renderMath();
      editing.querySelectorAll('.math:not([data-dk-tex])').forEach(renderMathEl);
    });
    afterFmt();
  }

  // ---------- blocks inside the editing host ----------
  // The blocks text lives in: every bullet of a list host, every paragraph, heading and bullet of a text
  // column, or else the host itself.
  function leafBlocks(h = editing) {
    if (!h) return [];
    if (isList(h)) return [...h.querySelectorAll('li')];
    if (editMulti && h === editing) return (editRun ? runKids(h) : [...h.children].filter(c => !c.hasAttribute(RT))).flatMap(c => (isList(c) ? [...c.querySelectorAll('li')] : [c]));
    return [h];
  }
  // The innermost block holding the point (c, o); for a point between blocks, the next block (start) or the previous one.
  function blockAtPoint(c, o, start = true) {
    const blocks = leafBlocks();
    if (blocks.length <= 1) return blocks[0] || editing;
    const r = document.createRange();
    const cmp = b => { r.selectNodeContents(b); try { return r.comparePoint(c, o); } catch (_) { return 2; } };
    let best = null;
    for (const b of blocks) if (cmp(b) === 0) best = b;
    if (best) return best;
    if (start) return blocks.find(b => cmp(b) === -1) || blocks[blocks.length - 1];
    return [...blocks].reverse().find(b => cmp(b) === 1) || blocks[0];
  }
  // The paragraph or bullet the caret is in.
  function curBlock() {
    if (!editing) return null;
    const s = getSelection();
    if (!s.rangeCount || !editing.contains(s.anchorNode)) return leafBlocks()[0] || editing;
    return blockAtPoint(s.anchorNode, s.anchorOffset, true);
  }
  // [first block, last block, range] of a non-collapsed selection inside the host, or null.
  function rangeBlocks() {
    const s = getSelection();
    if (!editing || !s.rangeCount) return null;
    const r = clampToRun(s.getRangeAt(0));
    if (r.collapsed || !editing.contains(r.commonAncestorContainer)) return null;
    return [blockAtPoint(r.startContainer, r.startOffset, true), blockAtPoint(r.endContainer, r.endOffset, false), r];
  }
  function multiBlockRange() { const b = rangeBlocks(); return !!b && b[0] !== b[1]; }
  // Every block the selection touches (the caret's block when nothing is selected).
  function touchedBlocks() {
    const b = rangeBlocks();
    const c = curBlock();
    if (!b) return c ? [c] : [];
    const all = leafBlocks(), i = all.indexOf(b[0]), j = all.indexOf(b[1]);
    return i < 0 || j < i ? [c] : all.slice(i, j + 1);
  }
  // Text offsets inside a block, so the caret survives blocks being re-tagged or moved.
  function offsetIn(el, c, o) {
    const x = document.createRange();
    x.selectNodeContents(el);
    try { x.setEnd(c, o); } catch (_) { return 0; }
    return Math.min(el.textContent.length, x.toString().length);
  }
  // The point `off` characters into el's text. A formula's text counts (as in offsetIn and caretOffset), but the point
  // is never inside a formula: within one it goes just before or after it, and at its end to the text that follows.
  function pointIn(el, off) {
    const inMath = n => { const m = n.parentElement && n.parentElement.closest('.math'); return !!m && m !== el && el.contains(m); };
    const w = document.createTreeWalker(el, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
      acceptNode: n => (inMath(n) ? NodeFilter.FILTER_REJECT : n.nodeType === 3 || (n !== el && n.classList.contains('math')) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP),
    });
    const segs = [];
    for (let n; (n = w.nextNode());) segs.push(n);
    const beside = (m, after) => { const p = m.parentNode; return [p, [...p.childNodes].indexOf(m) + (after ? 1 : 0)]; };
    let last = null;
    for (let i = 0; i < segs.length; i++) {
      const n = segs[i];
      if (n.nodeType === 3) {
        if (off <= n.length) return [n, off];
        off -= n.length;
        last = [n, n.length];
        continue;
      }
      const len = n.textContent.length;
      if (off < len || (off === len && !segs.slice(i + 1).some(x => x.nodeType === 3))) return beside(n, off > 0 && off * 2 >= len);
      off -= len;
      last = beside(n, true);
    }
    return last || [el, el.childNodes.length];
  }
  function selOffsets(a, z) {
    const s = getSelection();
    if (!s.rangeCount) return [a.textContent.length, z.textContent.length];
    const r = s.getRangeAt(0);
    return [offsetIn(a, r.startContainer, r.startOffset), offsetIn(z, r.endContainer, r.endOffset)];
  }
  function selectBetween(a, ao, z = a, zo = ao) {
    focusHost(a);
    const r = document.createRange();
    try {
      const A = pointIn(a, ao), Z = pointIn(z, zo);
      if (a === z && ao === zo) { r.setStart(...safePoint(...A)); r.collapse(true); }
      else { r.setStart(...A); r.setEnd(...Z); }
    } catch (_) { r.selectNodeContents(a); r.collapse(false); }
    const s = getSelection();
    s.removeAllRanges();
    s.addRange(r);
  }
  // After blocks were re-tagged: keep the host if it still holds them (a text column), else edit the new host
  // (a paragraph turned into a list gets the list as its host).
  function afterBlockChange(a, ao, z = a, zo = ao) {
    if (!a || !a.isConnected) { if (z && z.isConnected) { a = z; ao = 0; } else { dropEditing(); select(null); return commit(); } }
    if (!z || !z.isConnected) { z = a; zo = ao; }
    const h = hostOf(a);
    if (!(editing && editing.isConnected && editing === h)) {
      dropEditing();
      // Editing starts from the block itself, so a run of slide-level blocks knows which block holds the caret.
      select(textFrame(a));
      startEditing(a);
    }
    selectBetween(a, ao, z, zo);
    rememberSpans();
    commit();
    refreshFmt();
  }
  // Lists left without a single item disappear.
  function dropEmptyLists() {
    if (!editing) return;
    const roots = editRun ? runKids() : [editing];
    for (const root of roots) {
      for (const l of [...root.querySelectorAll('ul, ol')].reverse()) if (!l.querySelector('li')) removeWithSpace(l);
      if (editRun && isList(root) && !root.querySelector('li')) removeWithSpace(root);
    }
  }
  // Take an element out without leaving a blank line where it was in the file.
  function removeWithSpace(el) {
    const p = el.previousSibling, n = el.nextSibling;
    const ws = x => x && x.nodeType === 3 && !x.data.trim() && x.data.includes('\n');
    if (ws(p) && ws(n)) p.remove();
    // Something inside a line of text (an inline formula): the spaces on both sides become one.
    else if (p && n && p.nodeType === 3 && n.nodeType === 3 && /[ \u00a0]$/.test(p.data) && /^[ \u00a0]/.test(n.data) && !ws(p) && !ws(n)) n.deleteData(0, 1);
    el.remove();
  }
  // z's own text moves to the end of a (a keeps its tag), z goes away, and the caret sits at the join. z's sub-bullets
  // become a's sub-bullets when a is a bullet, otherwise they take z's place in its list; they never go into a heading.
  function joinBlocks(a, z) {
    const sub = a.tagName === 'LI' ? [...a.children].find(isList) || null : null;   // a's own sub-list stays last
    trimTrailingBreaks(a);
    if (!sub && isBlank(a)) a.replaceChildren();
    const mark = document.createTextNode('');
    a.insertBefore(mark, sub);
    const zLists = [...z.children].filter(isList);
    const own = [...z.childNodes].filter(n => !zLists.includes(n) && !(zLists.length && isSpace(n) && n.data.includes('\n')));
    // The line break and indentation before a sub-list are layout, not text.
    const tailText = zLists.length && [...own].reverse().find(n => n.nodeType === 3);
    if (tailText && /\n\s*$/.test(tailText.data)) tailText.data = tailText.data.replace(/\s*\n\s*$/, '');
    if (own.some(n => n.nodeType === 1 ? !isBlank(n) || n.tagName !== 'BR' : n.data.trim())) {
      trimTrailingBreaks(z);
      for (const n of own) if (n.parentNode === z) a.insertBefore(n, sub);
    } else {
      // Nothing joins on: a space at the end of a's text would be swallowed by what is typed next; keep it as a
      // non-breaking one (made plain again when editing ends).
      let t = mark.previousSibling;
      while (t && t.nodeType === 1 && !t.classList.contains('math') && !isMedia(t) && t.lastChild) t = t.lastChild;
      if (t && t.nodeType === 3 && /\S $/.test(t.data)) t.replaceData(t.length - 1, 1, '\u00a0');
    }
    let top = null;
    if (zLists.length) {
      const items = zLists.flatMap(l => [...l.children].filter(x => x.tagName === 'LI').map(li => [l.tagName, li]));
      if (a.tagName === 'LI') { for (const [tag, li] of items) subListOf(a, tag).appendChild(li); top = outerList(a); }
      else if (isList(z.parentElement)) { for (const [, li] of items) z.before(li); top = outerList(z); }
      else { const l = zLists[0].cloneNode(false); items.forEach(([, li]) => l.appendChild(li)); z.after(l); top = l; }
    }
    removeWithSpace(z);
    dropEmptyLists();
    ensureLine(a);
    focusHost(a);
    placeCaret(mark.isConnected ? mark : a, 0);
    if (top && top.isConnected) {
      const [off] = selOffsets(a, a);
      relayTop(top);
      selectBetween(a, off);
    }
  }
  // Lay out a whole list again, one bullet per line, when it is written that way.
  function relayTop(top) {
    // The list's own indentation: the line it starts on, else the line its closing tag is on.
    const end = isSpace(top.lastChild) && /\n([ \t]*)$/.exec(top.lastChild.data);
    const ind = lineIndent(top) ?? (end ? end[1] : null);
    if (ind == null) return;
    const first = [...top.children].map(lineIndent).find(x => x != null && x.length > ind.length && x.startsWith(ind));
    relayList(top, ind, first ? first.slice(ind.length) : '  ');
  }
  // A selection that runs over several paragraphs or bullets: delete it ourselves, joining the first and last
  // block, so the browser never unwraps, outdents or leaves styled <span>s behind.
  // `join` false (Enter over the selection): the first and last block stay apart and the caret goes to the start of the last.
  function deleteRange(join = true) {
    const b = rangeBlocks();
    if (!b || b[0] === b[1]) return false;
    const [a, z, r] = b;
    // Ends that sit between blocks (⌘A, a triple-click, the edge of a list) are moved into the first and last block,
    // so both survive the delete and are joined, instead of whole lists going and the caret landing elsewhere.
    if (!a.contains(r.startContainer)) r.setStart(...startOf(a));
    if (!z.contains(r.endContainer)) r.setEnd(...ownEnd(z));
    const zParent = ancestorsIn(z.parentElement, editing);
    r.deleteContents();
    if (!join) {
      if (a.isConnected && z.isConnected && a.parentElement === z.parentElement && a.nextSibling === z) {
        // The whitespace between them went with the deleted blocks: z gets a line of its own again.
        const ws = a.previousSibling;
        if (isSpace(ws) && ws.data.includes('\n')) a.after('\n' + /[^\n]*$/.exec(ws.data)[0]);
      }
      dropBlankAncestors(zParent, z);
      dropEmptyLists();
      if (a.isConnected) ensureLine(a);
      if (z.isConnected) {
        ensureLine(z);
        focusHost(z);
        placeCaret(...pointIn(z, 0));
      }
      scheduleCommit();
      return true;
    }
    if (z.isConnected && a.isConnected && !z.contains(a)) joinBlocks(a, z);
    dropBlankAncestors(zParent, a);
    dropEmptyLists();
    if (a.isConnected) ensureLine(a);
    scheduleCommit();
    return true;
  }
  // After a join took the last block's text away, the bullets and lists around where it was may hold nothing but
  // whitespace (deleting from a bullet into a sub-bullet); they go too, in the same undo step.
  // A bullet left with only sub-bullets hands them to the bullet the text was joined into.
  function dropBlankAncestors(chain, keep) {
    let moved = false;
    for (const p of chain) {
      if (!p.isConnected) continue;
      if (keep && p.contains(keep)) break;
      if (p.tagName === 'LI' && keep && keep.tagName === 'LI' && !isBlank(p)) {
        const own = p.cloneNode(true);
        [...own.children].filter(isList).forEach(l => l.remove());
        if (!isBlank(own)) break;
        for (const sub of [...p.children].filter(isList)) for (const li of [...sub.children].filter(x => x.tagName === 'LI')) subListOf(keep, sub.tagName).appendChild(li);
        removeWithSpace(p);
        moved = true;
        continue;
      }
      if (isList(p) && !isBlank(p)) continue;   // still holds bullets: look at the bullet around it
      if (!(p.tagName === 'LI' || isList(p)) || !isBlank(p)) break;
      removeWithSpace(p);
    }
    if (moved && keep && keep.isConnected) {
      const top = outerList(keep), ind = lineIndent(top), first = top.firstElementChild && lineIndent(top.firstElementChild);
      const [off] = selOffsets(keep, keep);
      if (ind != null) relayList(top, ind, first && first.length > ind.length && first.startsWith(ind) ? first.slice(ind.length) : '  ');
      selectBetween(keep, off);
    }
  }
  const ancestorsIn = (el, top) => { const out = []; for (let p = el; p && p !== top && top && top.contains(p); p = p.parentElement) out.push(p); return out; };

  // ---------- Enter / Backspace inside text ----------
  // beforeinput fires after the IME has committed, so Korean composition never gets split or doubled.
  let afterComposition = null;
  const RANGE_INPUTS = /^(deleteContent|deleteWord|deleteSoftLine|deleteHardLine|deleteByCut|insertText$|insertReplacementText|insertFromPaste|insertParagraph|insertLineBreak)/;
  function onBeforeInput(e) {
    if (mode !== 'edit') return;
    if (e.inputType === 'historyUndo' || e.inputType === 'historyRedo') {
      e.preventDefault();
      if (e.inputType === 'historyUndo') undo(); else redo();
      return;
    }
    if (!editing) return;
    const t = e.inputType;
    if (editing.getAttribute('contenteditable') === 'plaintext-only') {
      if (t === 'insertParagraph' || t === 'insertLineBreak') e.preventDefault();
      return;
    }
    if (!e.isComposing) clampRunSelection();
    if (!e.isComposing && RANGE_INPUTS.test(t) && multiBlockRange()) {
      e.preventDefault();
      // Enter over a selection across blocks removes it and leaves the first and last block apart, as a break.
      if (t === 'insertParagraph' || t === 'insertLineBreak') { deleteRange(false); return commit(); }
      deleteRange();
      const text = e.data != null ? e.data : e.dataTransfer ? e.dataTransfer.getData('text/plain') : '';
      if (/^(insertText|insertReplacementText|insertFromPaste)$/.test(t) && text) insertPlain(text);
      return commit();
    }
    if (t === 'insertParagraph' || t === 'insertLineBreak') {
      e.preventDefault();
      const run = () => (inPre() ? preBreak() : t === 'insertParagraph' && canSplit(curBlock()) ? splitBlock() : lineBreak());
      if (e.isComposing) afterComposition = run;
      else run();
      return;
    }
    if (e.isComposing) return;
    const back = /^(deleteContentBackward|deleteWordBackward|deleteSoftLineBackward|deleteHardLineBackward)$/.test(t);
    const fwd = /^(deleteContentForward|deleteWordForward)$/.test(t);
    if (!back && !fwd) return;
    const s = getSelection();
    if (!s.rangeCount || !s.isCollapsed) return;
    const b = curBlock();
    if (!b) return;
    if (back && caretAtStart(b)) {
      e.preventDefault();
      backspaceAtStart(b);
    } else if (fwd && b !== editing && caretAtEnd(b)) {
      e.preventDefault();
      const all = leafBlocks(), next = all[all.indexOf(b) + 1];
      if (next && !b.contains(next) && joinable(b, next)) { joinBlocks(b, next); commit(); }
    }
  }
  // Backspace at the very start of a paragraph or bullet joins it to the one before; at the start of the
  // first one it does nothing (an empty first one goes away), so the browser never unwraps or outdents.
  function backspaceAtStart(b) {
    if (b === editing) return mergeIntoPrevious();
    // At the start of a sub-bullet, Backspace first takes it one level up.
    if (b.tagName === 'LI' && canOutdent(b)) return indentItems(-1);
    const all = leafBlocks(), i = all.indexOf(b), prev = all[i - 1];
    if (!prev) {
      const next = all[i + 1];
      if (next && isBlank(b) && !b.querySelector('li') && (!editRun || slideChild(next) === slideChild(b))) {
        removeWithSpace(b);
        dropEmptyLists();
        focusHost(next);
        placeCaret(next, 0);
        commit();
      }
      return;
    }
    if (prev.contains(b) || !joinable(prev, b)) return;
    joinBlocks(prev, b);
    commit();
  }
  // In a run, Backspace/Delete at a block edge joins two blocks of one list, or two paragraphs; a heading and the
  // paragraph or list after it stay apart (as they were before runs existed). A selection across them is different:
  // deleting it always joins.
  const joinable = (a, b) => !editRun || slideChild(a) === slideChild(b) || (a.tagName === 'P' && b.tagName === 'P');
  // Text with several lines never goes to insertText as one string (Chrome would wrap each line in a <div>, which
  // the HTML parser moves out of a <p> on reload). A bullet or a paragraph in a run splits into one block per line,
  // like pressing Enter; a heading, a text box, a cell or a caption gets line breaks, like Enter does there.
  function insertPlain(text) {
    const exec = (cmd, v) => { quiet++; try { document.execCommand(cmd, false, v); } finally { quiet--; } };
    let lines = String(text).replace(/\r\n?/g, '\n').split('\n');
    if (editing && editing.getAttribute('contenteditable') === 'plaintext-only') lines = [lines.join(' ')];
    while (lines.length > 1 && !lines[0].trim()) lines.shift();
    while (lines.length > 1 && !lines[lines.length - 1].trim()) lines.pop();
    lines = lines.filter((l, i) => l.trim() || (i > 0 && lines[i - 1].trim()));   // runs of blank lines → one
    if (lines.length < 2) {
      if (lines[0]) exec('insertText', lines[0]);
      return sanitizeSpans();
    }
    const b = curBlock();
    const split = !!b && b !== editing && canSplit(b);
    if (split) {
      lines = lines.filter(l => l.trim());
      exec('insertText', lines[0]);
      for (const l of lines.slice(1)) { splitBlock(false); exec('insertText', l); }
    } else {
      lines.forEach((l, i) => { if (i) exec('insertLineBreak'); if (l) exec('insertText', l); });
    }
    sanitizeSpans();
  }
  function onCompositionEnd() {
    const f = afterComposition;
    afterComposition = null;
    setTimeout(() => { sanitizeSpans(); if (!composing) plainSpaceAtCaret(); if (f) f(); }, 0);
  }
  // Chrome turns the space next to where it inserted or deleted text into &nbsp; when the text came from two nodes
  // (blocks joined by a selection, a word deleted at a join). Between two visible characters a plain space shows the same.
  function plainSpaceAtCaret() {
    const s = getSelection();
    if (!editing || !s.rangeCount || !s.isCollapsed || editing.getAttribute('contenteditable') !== 'true') return;
    const b = curBlock();
    if (!b || !b.contains(s.anchorNode)) return;
    b.normalize();
    const n = s.anchorNode, o = s.anchorOffset;
    if (!n || n.nodeType !== 3) return;
    for (const i of [o, o - 1]) {
      if (n.data[i] === '\u00a0' && /\S/.test(n.data[i - 1] || '') && /\S/.test(n.data[i + 1] || '') && n.data[i - 1] !== '\u00a0' && n.data[i + 1] !== '\u00a0') n.replaceData(i, 1, ' ');
    }
  }
  // Styled <span>s the browser leaves while typing (e.g. after a join) are unwrapped; the author's own stay.
  let quiet = 0;
  function sanitizeSpans() {
    if (!editing || quiet || composing || editing.getAttribute('contenteditable') !== 'true') return;
    const junk = [...editing.querySelectorAll('span[style]')].filter(n => !knownSpans.has(n) && !n.closest('.math') && !n.querySelector('.math'));
    if (!junk.length) return;
    const b = curBlock();
    const [o] = b ? selOffsets(b, b) : [0];
    junk.forEach(unwrap);
    if (b && b.isConnected) selectBetween(b, o);
  }
  const canSplit = el => !!el && (el.tagName === 'LI' || (el.tagName === 'P' && getComputedStyle(el).position !== 'absolute'));

  function lineBreak() {
    document.execCommand('insertLineBreak');
    scheduleCommit();
  }
  // The code block the caret is in, if any.
  function inPre() {
    const n = getSelection().anchorNode, el = n && (n.nodeType === 3 ? n.parentElement : n), pre = el && el.closest && el.closest('pre');
    return pre && editing && editing.contains(pre) ? pre : null;
  }
  // Enter in a code block is a newline in its text, never a <br>. At its very end a zero-width space keeps the new
  // line visible until something is typed there (it is never saved).
  function preBreak() {
    const s = getSelection(), pre = inPre();
    if (!s.rangeCount || !pre) return;
    const r = s.getRangeAt(0);
    r.deleteContents();
    const after = document.createRange();
    after.setStart(r.startContainer, r.startOffset);
    after.setEnd(pre, pre.childNodes.length);
    const atEnd = !after.toString().replace(/\u200b/g, '');
    const tn = document.createTextNode(atEnd ? '\n\u200b' : '\n');
    r.insertNode(tn);
    placeCaret(tn, tn.length);
    lastTypedAt = Date.now();
    scheduleCommit();
  }
  // A caret right behind a placeholder <br> (an empty bullet or line, the empty line after Shift+Enter) goes in
  // front of it instead: Chromium's IME types the first syllable twice when composition starts behind a lone <br>.
  function safePoint(node, off) {
    if (!node || node.nodeType !== 1 || off <= 0) return [node, off];
    const br = node.childNodes[off - 1];
    if (!br || br.nodeName !== 'BR') return [node, off];
    let n = br.nextSibling, p = br.previousSibling;
    while (n && isSpace(n)) n = n.nextSibling;
    while (p && isSpace(p) && !p.data.includes('\n')) p = p.previousSibling;
    if ((n && !isList(n)) || (p && p.nodeName !== 'BR' && !isSpace(p))) return [node, off];
    return [node, off - 1];
  }
  function placeCaret(node, offset) {
    [node, offset] = safePoint(node, offset);
    const r = document.createRange();
    r.setStart(node, offset);
    r.collapse(true);
    const s = getSelection();
    s.removeAllRanges();
    s.addRange(r);
  }
  function caretAtStart(el) {
    const s = getSelection();
    if (!s.rangeCount || !s.isCollapsed) return false;
    const pre = document.createRange();
    pre.selectNodeContents(el);
    try { pre.setEnd(s.anchorNode, s.anchorOffset); } catch (_) { return false; }
    return pre.toString() === '' && !pre.cloneContents().querySelector('img,svg,br,.math');
  }
  function caretAtEnd(el) {
    const s = getSelection();
    if (!s.rangeCount || !s.isCollapsed) return false;
    const post = document.createRange();
    post.selectNodeContents(el);
    try { post.setStart(s.anchorNode, s.anchorOffset); } catch (_) { return false; }
    const f = post.cloneContents();
    f.querySelectorAll('br').forEach(x => x.remove());
    return post.toString().replace(/​/g, '') === '' && !f.querySelector('img,svg,.math');
  }
  function isBlank(el) { return !el.textContent.trim() && !el.querySelector('img,svg,video,canvas,.math'); }
  // An empty block has no height; a <br> keeps the line (and the caret) visible.
  function ensureLine(el) { if (!el.firstChild || isBlank(el) && !el.querySelector('br')) el.replaceChildren(document.createElement('br')); }

  function splitBlock(record = true) {
    const el = curBlock();
    const s = getSelection();
    if (!el || !s.rangeCount) return;
    const r = s.getRangeAt(0);
    if (!r.collapsed) r.deleteContents();
    if (record && exitList(el)) return;
    // The tail is the text after the caret; a bullet's sub-list follows it onto the new line.
    const subs = el.tagName === 'LI' ? [...el.children].filter(l => isList(l) && r.comparePoint(l, 0) > 0) : [];
    const tail = document.createRange();
    tail.setStart(r.startContainer, r.startOffset);
    if (subs.length) tail.setEndBefore(subs[0]); else tail.setEnd(el, el.childNodes.length);
    const frag = tail.extractContents();
    const n = el.cloneNode(false);
    n.removeAttribute('id');
    n.appendChild(frag);
    // A space the new line starts with would be dropped by what is typed in front of it; keep it non-breaking
    // (made plain, or dropped at the very start, when editing ends).
    const first = n.firstChild;
    if (first && first.nodeType === 3 && /^ \S/.test(first.data)) first.replaceData(0, 1, '\u00a0');
    if (subs.length) {
      while (isSpace(n.lastChild)) n.lastChild.remove();
      if (n.lastChild && n.lastChild.nodeType === 3) n.lastChild.data = n.lastChild.data.replace(/\s*\n\s*$/, '');
      while (isSpace(el.lastChild) && el.lastChild.data.includes('\n')) el.lastChild.remove();
    }
    trimTrailingBreaks(n);
    trimTrailingBreaks(el);
    ensureLine(el);
    ensureLine(n);
    if (subs.length) {
      if (!n.firstChild || !n.textContent.trim() && !n.querySelector('img,svg,video,canvas,.math,br')) n.replaceChildren(document.createElement('br'));
      subs.forEach(l => n.appendChild(l));
    }
    el.after(n);
    const pre = el.previousSibling;
    if (pre && pre.nodeType === 3 && !pre.data.trim() && pre.data.includes('\n')) n.before(pre.data);
    if (subs.length) relayTop(outerList(n));
    if (el === editing) {
      // The block was its own host: the new paragraph becomes the host.
      stopEditing(false);
      select(n);
      startEditing(n);
    }
    focusHost(n);
    placeCaret(...startOf(n));
    rememberSpans();
    if (record) commit();
  }
  // Enter on an empty last bullet ends the list: the bullet becomes a paragraph after it (when the list sits in a
  // box of several blocks, so the paragraph has somewhere to go).
  function exitList(li) {
    if (li.tagName !== 'LI' || !isBlank(li) || li.querySelector('li') || li.nextElementSibling) return false;
    const list = li.parentElement;
    if (!editMulti || isList(editing) || list.parentElement !== editing || list.lastElementChild !== li) return false;
    const p = document.createElement('p');
    p.appendChild(document.createElement('br'));
    removeWithSpace(li);
    const ws = list.previousSibling;
    list.after(p);
    if (ws && ws.nodeType === 3 && !ws.data.trim() && ws.data.includes('\n')) p.before(ws.data.replace(/^[^\n]*/, ''));
    if (!list.querySelector('li')) removeWithSpace(list);
    focusHost(p);
    placeCaret(p, 0);
    commit();
    return true;
  }
  // Lists left with only empty bullets (every bullet deleted, Enter pressed twice at the end) lose those bullets
  // when editing ends, so no bullet dot without text is shown or saved.
  function dropBlankBullets(root, kept = () => false) {
    const lists = isList(root) ? [root] : [...root.querySelectorAll('ul, ol')].filter(l => !l.parentElement.closest('ul, ol'));
    for (const l of lists) {
      if (kept(l)) continue;
      if (isBlank(l)) { removeWithSpace(l); continue; }
      for (const li of [...l.querySelectorAll('li')].reverse()) if (isBlank(li) && !li.querySelector('li')) removeWithSpace(li);
    }
  }
  // Backspace at the start of a block that is its own host: join it to the same kind of block before it.
  function mergeIntoPrevious() {
    const el = editing;
    let prev = el.previousElementSibling;
    while (prev && prev.hasAttribute(RT)) prev = prev.previousElementSibling;
    // Only into a paragraph in the same flow: never into a floating text box or a hidden block.
    if (!prev || prev.tagName !== el.tagName || !canSplit(el) || !runBlock(prev) || !runBlock(el)) return false;
    stopEditing(false);
    trimTrailingBreaks(prev);
    if (isBlank(prev)) prev.replaceChildren();
    const mark = document.createTextNode('');
    prev.appendChild(mark);
    if (!isBlank(el)) while (el.firstChild) prev.appendChild(el.firstChild);
    removeWithSpace(el);
    ensureLine(prev);
    select(prev);
    startEditing(prev);
    prev.focus({ preventScroll: true });
    placeCaret(mark.isConnected ? mark : prev, 0);
    commit();
    return true;
  }
  // Alt+↑/↓ while typing: swap the paragraph or bullet with its neighbour inside the same box.
  function moveBlock(d) {
    const b = curBlock();
    if (!b || b === editing || !editing.contains(b.parentElement)) return;
    let sib = d < 0 ? b.previousElementSibling : b.nextElementSibling;
    while (sib && sib.hasAttribute(RT)) sib = d < 0 ? sib.previousElementSibling : sib.nextElementSibling;
    if (!sib || sib.getAttribute('contenteditable') === 'false') return;
    const [ao, zo] = selOffsets(b, b);
    if (d < 0) sib.before(b); else sib.after(b);
    selectBetween(b, ao, b, zo);
    commit();
  }
  // ---------- bullet levels ----------
  // The line indentation in front of `el` in the file, or null when its list is written on one line.
  const lineIndent = el => { const p = el.previousSibling; const m = isSpace(p) && /\n([ \t]*)$/.exec(p.data); return m ? m[1] : null; };
  // Lay out a list one bullet per line at indentation `ind` (the list's own line), sub-lists one level deeper.
  function relayList(list, ind, step = '  ') {
    [...list.childNodes].filter(isSpace).forEach(n => n.remove());
    for (const li of [...list.children]) {
      li.before('\n' + ind + step);
      const subs = [...li.children].filter(isList);
      if (!subs.length) {
        // No sub-list left: no line break before </li> either.
        while (isSpace(li.lastChild) && li.lastChild.previousSibling) li.lastChild.remove();
        const t = li.lastChild;
        if (t && t.nodeType === 3 && /\S\s*\n\s*$/.test(t.data)) t.data = t.data.replace(/\s+$/, '');
        continue;
      }
      for (const sub of subs) {
        const p = sub.previousSibling;
        if (isSpace(p) && p.previousSibling) p.remove();
        else if (p && p.nodeType === 3 && !isSpace(p)) p.data = p.data.replace(/[ \t\n]+$/, '');
        if (isSpace(sub.previousSibling)) sub.previousSibling.data = '\n' + ind + step + step; else sub.before('\n' + ind + step + step);
        relayList(sub, ind + step + step, step);
        const n = sub.nextSibling;
        if (isSpace(n)) n.remove();
        if (!sub.nextSibling) sub.after('\n' + ind + step);
      }
    }
    if (list.firstElementChild) list.append('\n' + ind);
  }
  // The list a bullet's children go into: its last sub-list, or a new one of kind `tag` at its end.
  function subListOf(li, tag) {
    const last = [...li.children].filter(isList).pop();
    if (last && !last.nextElementSibling) return last;
    const l = document.createElement(tag);
    li.appendChild(l);
    return l;
  }
  // Tab: the bullet goes one level down, under the bullet before it. Shift+Tab (or Backspace at its start): one level
  // up, right after the bullet it was under, taking the bullets after it along as its own sub-list.
  function canIndent(li) { let p = li.previousElementSibling; while (p && p.hasAttribute(RT)) p = p.previousElementSibling; return !!p && p.tagName === 'LI'; }
  const canOutdent = li => !!li.parentElement && !!li.parentElement.parentElement && li.parentElement.parentElement.tagName === 'LI';
  function indentItems(d) {
    if (!editing || composing) return false;
    const lis = touchedBlocks().filter(b => b.tagName === 'LI');
    const todo = lis.filter(li => (d > 0 ? canIndent(li) : canOutdent(li)));
    if (!lis.length || !todo.length || (d > 0 && !canIndent(lis[0]))) return !!lis.length;
    if (commitTimer) commit();   // typing so far is its own undo step
    const a = lis[0], z = lis[lis.length - 1];
    const [ao, zo] = selOffsets(a, z);
    const top = outerList(a);
    const ind = lineIndent(top), first = top.firstElementChild && lineIndent(top.firstElementChild);
    const step = ind != null && first && first.length > ind.length && first.startsWith(ind) ? first.slice(ind.length) : '  ';
    for (const li of todo) {
      if (d > 0 && canIndent(li)) {
        let prev = li.previousElementSibling;
        while (prev.hasAttribute(RT)) prev = prev.previousElementSibling;
        const tag = li.parentElement.tagName;
        removeWithSpace(li);
        subListOf(prev, tag).appendChild(li);
      } else if (d < 0 && canOutdent(li)) {
        const list = li.parentElement, parent = list.parentElement;
        const after = [];
        for (let n = li.nextElementSibling; n; n = n.nextElementSibling) if (n.tagName === 'LI') after.push(n);
        if (after.length) { const sub = subListOf(li, list.tagName); after.forEach(n => { removeWithSpace(n); sub.appendChild(n); }); }
        removeWithSpace(li);
        parent.after(li);
        if (!list.querySelector('li')) removeWithSpace(list);
        if (isSpace(parent.lastChild) && !parent.lastElementChild) parent.lastChild.remove();
      }
    }
    // Every bullet on a line of its own, indented like the list around it (lists written on one line stay so).
    if (ind != null && top.isConnected) relayList(top, ind, step);
    focusHost(a);
    selectBetween(a, ao, z, zo);
    commit();
    refreshFmt();
    return true;
  }

  function stripZeroWidth(el) {
    const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    const empty = [];
    let n;
    while ((n = w.nextNode())) {
      if (!n.data.includes('\u200b') || (n.parentElement && n.parentElement.closest('.math'))) continue;
      n.data = n.data.replace(/\u200b/g, '');
      if (!n.data) empty.push(n);
    }
    empty.forEach(t => t.remove());
  }
  // Typing leaves &nbsp; behind: a space at the end of a block (shows nothing), and one between two words that
  // Chrome kept after a join. Both become what a person would write; an &nbsp; between spaces stays.
  function plainSpaces(b) {
    // The block's own text in order (not its sub-lists); a formula or picture counts as a visible character.
    const toks = [];
    const walk = el => {
      for (const n of el.childNodes) {
        if (n.nodeType === 3) toks.push(n);
        else if (n.nodeType !== 1 || (isList(n) && n !== b)) continue;
        else if (n.classList.contains('math') || isMedia(n)) toks.push('x');
        else if (n.tagName === 'BR') toks.push('\n');
        else walk(n);
      }
    };
    walk(b);
    const nodes = toks.filter(t => typeof t !== 'string');
    // Across nodes too: "word&nbsp;<a>link</a>" and "x&nbsp;<formula>" have a plain space between two visible characters.
    const all = toks.map(t => (typeof t === 'string' ? t : t.data)).join('');
    let at = 0;
    for (const t of toks) {
      const from = at;
      at += typeof t === 'string' ? t.length : t.length;
      if (typeof t === 'string' || !t.data.includes('\u00a0')) continue;
      const n = t;
      let out = '';
      for (let i = 0; i < n.length; i++) {
        const g = from + i, ch = n.data[i];
        out += ch === '\u00a0' && /\S/.test(all[g - 1] || '') && /\S/.test(all[g + 1] || '') ? ' ' : ch;
      }
      if (out !== n.data) n.data = out;
    }
    // A line that starts with one non-breaking space (left by Enter in front of a space) starts with its text.
    const lead = nodes.find(n => n.data);
    if (lead && lead === toks.find(t => typeof t === 'string' || t.data) && /^\u00a0\S/.test(lead.data)) lead.deleteData(0, 1);
    const last = [...nodes].reverse().find(n => n.data && !(isSpace(n) && n.data.includes('\n')));
    if (!last || !/\S[ \u00a0]+$/.test(last.data)) return;   // only spaces right after a visible character
    const after = document.createRange();
    after.setStartAfter(last);
    after.setEnd(b, b.childNodes.length);
    const rest = after.cloneContents();
    rest.querySelectorAll('br, ul, ol').forEach(x => x.remove());
    if (rest.textContent.trim() || rest.querySelector('img, svg, video, canvas, .math, iframe')) return;   // something visible follows
    last.data = last.data.replace(/[ \u00a0]+$/, '');
  }
  // Chrome leaves placeholder <br>s at the end of edited text; they add nothing visible once editing ends.
  function trimTrailingBreaks(el) {
    for (;;) {
      let last = el.lastChild;
      while (last && last.nodeType === 3 && !last.textContent.trim() && last.previousSibling) last = last.previousSibling;
      if (!last || last.nodeName !== 'BR') return;
      const before = last.previousSibling;
      if (!before) return;               // a lone <br> keeps an empty line
      last.remove();
    }
  }

  function bindEvents() {
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown, true);
    document.addEventListener('beforeinput', onBeforeInput, true);
    document.addEventListener('compositionstart', () => { composing = true; }, true);
    document.addEventListener('compositionend', e => { composing = false; onCompositionEnd(e); }, true);
    // While editing, a link on a slide is text to edit or a thing to drag, never a way off the page.
    for (const type of ['click', 'auxclick']) {
      document.addEventListener(type, e => {
        if (mode === 'edit' && deck.contains(e.target) && e.target.closest && e.target.closest('a[href], summary')) e.preventDefault();
      }, true);
    }
    // While editing, an interactive element on a slide is an object to select and move: its own buttons, fields and
    // handlers get none of the presses (the editor's handlers above have already seen them).
    for (const type of ['pointerdown', 'mousedown', 'click', 'dblclick', 'auxclick', 'contextmenu', 'touchstart']) {
      document.addEventListener(type, e => {
        if (mode !== 'edit' || !deck.contains(e.target) || !liveRoot(e.target)) return;
        e.stopPropagation();
        if (type === 'mousedown' || type === 'click' || type === 'dblclick') e.preventDefault();
      }, true);
    }
    // A widget that rebuilds its formulas when used (a step, a slider) gets them drawn right after.
    for (const type of ['click', 'input', 'change', 'keyup']) {
      document.addEventListener(type, e => {
        const w = deck.contains(e.target) && liveRoot(e.target);
        if (!w) return;
        setTimeout(() => renderWidgetMath(w), 0);
        setTimeout(() => renderWidgetMath(w), 400);
      }, true);
    }
    // A press on the slide background never starts a text selection.
    document.addEventListener('mousedown', e => {
      if (mode === 'edit' && e.button === 0 && (e.target === curSlide() || e.target === deck)) e.preventDefault();
    }, true);
    // A triple-click selects a paragraph and, in a box of several blocks, the start of the next one too; keep it to the one.
    // A triple-click selects the whole paragraph or bullet it is on, formulas included, and nothing of the next one.
    document.addEventListener('mouseup', e => {
      if (mode !== 'edit' || e.button !== 0 || e.detail < 3 || !editing || composing || editing.classList.contains('math')) return;
      const s = getSelection();
      if (!s.rangeCount || !editing.contains(s.anchorNode)) return;
      const b = blockAtPoint(s.anchorNode, s.anchorOffset, true);
      if (!b) return;
      const r = document.createRange();
      r.setStart(...startOf(b));
      r.setEnd(...ownEnd(b));
      s.removeAllRanges();
      s.addRange(r);
    }, true);
    document.addEventListener('dblclick', e => {
      if (mode !== 'edit' || e.composedPath().includes(host)) return;
      const m = mathOf(e.target);
      if (m) { e.preventDefault(); select(m); startEditing(m); caretAt(m); return; }
      const sh = isBoxShape(e.target) ? e.target : labelShape(e.target);
      if (sh && curSlide() && curSlide().contains(sh)) {
        e.preventDefault();
        if (editing !== sh) startLabel(sh, e.clientX, e.clientY);
        selectWordAt(e.clientX, e.clientY);
        return;
      }
      if (e.target.tagName === 'IMG' && curSlide() && curSlide().contains(e.target)) { select(e.target); requestImage(e.target); }
    });
    document.addEventListener('input', e => {
      if (editing) {
        lastTypedAt = Date.now();
        scheduleCommit();
        if (!e.isComposing) sanitizeSpans();
        if (!e.isComposing && !composing && /^delete/.test(e.inputType || '')) plainSpaceAtCaret();
      }
      updateStatus();
    });
    // Outline what a click would grab.
    document.addEventListener('mousemove', onHoverMove, true);
    html.addEventListener('mouseleave', hideHover);
    document.addEventListener('keydown', () => { if (hoverCls || (shadow && $('.hover').style.display === 'block')) hideHover(); }, true);
    document.addEventListener('paste', async e => {
      if (mode !== 'edit') return;
      const img = [...(e.clipboardData && e.clipboardData.files || [])].find(f => f.type.startsWith('image/'));
      if (img) {
        e.preventDefault();
        if (editing) stopEditing();
        return placeImage(img, selected && (selected.tagName === 'IMG' || figureMedia(selected)) ? selected : null);
      }
      const dt = e.clipboardData;
      if (!dt) return;
      const markup = dt.getData('text/html');
      if (!editing && markup && markup.includes(CLIP) && !e.composedPath().includes(sidebar)) { e.preventDefault(); return pasteObjects(markup); }
      // Spreadsheet cells, tab-separated, markdown or CSV text: fill table cells, or make a new table.
      if (isCell(editing) && isRich(editing)) {
        const g = parseGrid(dt);
        const [R, C] = g ? gridSize(g) : [0, 0];
        if (R * C >= 2) { e.preventDefault(); return pasteIntoTable(editing, g); }
      }
      if (!editing) {
        if (e.composedPath().includes(sidebar)) return;
        const g = parseGrid(dt);
        const [R, C] = g ? gridSize(g) : [0, 0];
        if (R >= 2 && C >= 2) { e.preventDefault(); return tableFromGrid(g); }
        // Any other text goes into a new text box in a free spot.
        const text = dt.getData('text/plain');
        if (text && text.trim()) { e.preventDefault(); addTextBox(text); }
        return;
      }
      e.preventDefault();
      if (markup && markup.includes(TEXT_CLIP) && pasteText(markup)) return commit();
      clampRunSelection();
      if (multiBlockRange()) deleteRange();
      insertPlain(dt.getData('text/plain'));
      commit();
    });
    document.addEventListener('copy', e => copyText(e, false) || copyObjects(e, false));
    document.addEventListener('cut', e => copyText(e, true) || copyObjects(e, true));
    document.addEventListener('dragstart', e => {
      if (mode === 'edit' && deck.contains(e.target)) e.preventDefault();
    });
    document.addEventListener('dragover', e => {
      if (mode === 'edit' && e.dataTransfer && [...e.dataTransfer.types].includes('Files')) e.preventDefault();
    });
    document.addEventListener('drop', e => {
      if (mode !== 'edit' || !e.dataTransfer || !e.dataTransfer.files.length) return;
      e.preventDefault();
      const f = [...e.dataTransfer.files].find(x => x.type.startsWith('image/'));
      if (!f) return;
      const onImg = e.target.tagName === 'IMG' && curSlide().contains(e.target) ? e.target : null;
      placeImage(f, onImg, slidePoint(e.clientX, e.clientY));
    });
    addEventListener('resize', layout);
    document.addEventListener('fullscreenchange', () => {
      // The browser takes the first Esc to leave full screen: presenting that started in the editor goes back to it.
      if (!document.fullscreenElement && mode === 'present' && fromEditor && Date.now() - fsByKeyAt > 800) setMode('edit');
      if (document.fullscreenElement || pendingShow === null) return;
      const t = pendingShow;
      pendingShow = null;
      onExternalChange(t);
    });
    // Presenting: a click on the slide goes to the next one (Shift-click: back). Links and the editor's controls stay theirs.
    document.addEventListener('click', e => {
      if (mode !== 'present' || e.button !== 0 || e.composedPath().includes(host) || $('.help').classList.contains('show')) return;
      if (e.target.closest && e.target.closest('a[href], button, input, textarea, select, summary, video, audio, iframe, label')) return;
      // An interactive element on the slide (a quiz, a demo) keeps its clicks.
      if (liveRoot(e.target)) return;
      go(cur + (e.shiftKey ? -1 : 1));
    });
    // The AI's edits wait while a mouse button is down (a drag or a resize in progress).
    addEventListener('pointerdown', () => { pointerDown = true; }, true);
    for (const t of ['pointerup', 'pointercancel', 'blur']) addEventListener(t, () => { pointerDown = false; }, true);
    // ⌘P while editing: nothing of the editor (focus ring, caret, selection box) goes into the PDF.
    addEventListener('beforeprint', () => {
      if (mode !== 'edit') return;
      stopEditing();
      setSel([]);
      getSelection().removeAllRanges();
      if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur();
    });
    addEventListener('beforeunload', e => {
      if (!skipUnloadPrompt && isDirty()) { e.preventDefault(); e.returnValue = ''; }
    });
    addEventListener('hashchange', () => {
      const n = parseInt(location.hash.slice(1), 10);
      if (n && n - 1 !== cur) go(n - 1);
    });
    addEventListener('mousemove', () => {
      showCursor();
      if (mode !== 'present') return;
      $('.pcount').classList.add('show');
      idleTimer = setTimeout(() => {
        if (mode !== 'present') return;
        $('.pcount').classList.remove('show');
        html.classList.add('dk-hide-cursor');
      }, 1800);
    });
  }

  // ---------- init ----------
  async function init() {
    deck = document.querySelector('main.deck') || document.querySelector('.deck');
    if (!deck) { console.warn('[deck-edit] no <main class="deck"> found'); return; }
    [W, H] = (deck.getAttribute('data-size') || '1920x1080').split(/[x×]/).map(Number);
    FILE = decodeURIComponent(location.pathname.split('/').pop() || 'index.html');
    DIR_KEY = decodeURIComponent(location.pathname.replace(/[^/]*$/, ''));
    STATE_KEY = 'deck-edit:' + location.pathname;

    hist.push(deckHTML());
    hi = 0;
    fileTitle = (document.querySelector('title') || {}).textContent || '';
    autoTitle = isAutoTitle();
    updateTitle();
    baseline = hist[0];
    setSaved(baseline);

    deck.setAttribute('data-dk-main', '');
    varStyle = injectStyles();
    buildChrome();
    bindSidebar();
    bindEvents();
    html.classList.add('dk-on');
    fixBackgrounds();

    go((parseInt(location.hash.slice(1), 10) || 1) - 1);
    let st = {};
    try { st = JSON.parse(sessionStorage.getItem(STATE_KEY) || '{}'); } catch (_) {}
    justReloaded = !!st.reloadedAt && Date.now() - st.reloadedAt < 10000;
    reloadStamp = justReloaded && st.disk ? st.disk : null;
    layout();
    if (st.mode === 'edit') setMode('edit');
    if (justReloaded) noteAI();
    updateStatus();
    requestAnimationFrame(tick);

    if (mode === 'present') showHint();

    loadKatex().then(() => { renderMath(); scheduleThumbs(); });
    if (document.fonts) document.fonts.ready.then(() => { fitMaths(curSlide()); scheduleThumbs(); });

    const sv = await findServer();
    if (sv) {
      serverMode = true;
      dir = sv;
      dirOK = true;
      await connected();
      updateStatus();
    } else if (window.showDirectoryPicker && !framed) {
      dir = await idbGet(DIR_KEY);
      if (dir) await ensureDir(false);
    }
  }

  window.deckEdit = {
    version: '2026.10.18.5',
    get state() {
      return { mode, cur, slides: slides().length, hi, hist: hist.length, dirty: isDirty(), connected: dirOK,
        selected: selected ? friendly(selected) : null, path: crumbChain().map(label).join(' › '), editing: !!editing,
        selection: sel.map(friendly), count: sel.length, savesDone, pollsDone };
    },
    deckHTML: () => deckHTML(),
    fullHTML: () => fullHTML(),
    composeFile: text => { commit(); return composeFile(text, hist[hi], slides().map(n => origins.get(n) || null)); }, deckFromText,
    go: i => go(i), setMode: m => setMode(m), save: () => save(), undo: () => undo(), redo: () => redo(),
    select: el => { stopEditing(); select(el); },
    _connect: async handle => { dir = handle; dirOK = true; await idbSet(DIR_KEY, dir); await connected(); },
    _sel: () => sel.slice(),
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
