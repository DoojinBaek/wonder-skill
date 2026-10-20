// End-to-end tests for deck-edit.js in real Chrome.
//   npm test                 run everything
//   npm test -- enter        run tests whose name contains "enter" (use a|b for either)
//   HEADED=1 npm test        watch it happen
import { chromium } from 'playwright-core';
import { useCdnCache } from './cdn-cache.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawnSync } from 'node:child_process';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const SKILL = path.join(ROOT, 'skill');
const OUT = path.join(ROOT, 'tests', '.out');
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const FILTER = process.argv.slice(2).join(' ').toLowerCase();
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==', 'base64');

const EXTRA_SLIDE = `
  <section class="slide">
    <h2>표와 이미지</h2>
    <table><tr><th>모델</th><th>정확도</th></tr><tr><td>A</td><td>91.2</td></tr></table>
    <img class="pic" src="assets/dot.png" alt="점" style="width:200px">
    <p class="free" style="position:absolute; left:1200px; top:300px; width:500px; margin:0;">자유 상자</p>
    <p class="withmath">수식 <span class="math">x^2</span> 포함 문장</p>
  </section>
`;
// The tests' deck: the original Korean template (kept as a fixture, so the Korean content and IME scenarios stay
// stable) plus a slide of tables, pictures and formulas, and speaker notes on slide 2.
// TEMPLATE is the real skill/template.html, for the tests that are about the template itself.
const TEMPLATE = fs.readFileSync(path.join(SKILL, 'template.html'), 'utf8');
const TEMPLATE_KO = fs.readFileSync(path.join(ROOT, 'tests', 'fixture-template-ko.html'), 'utf8');
const FIXTURE = (TEMPLATE_KO.includes('class="notes"') ? TEMPLATE_KO
  : TEMPLATE_KO.replace('      <li>세 번째 요점</li>\n    </ul>\n', '      <li>세 번째 요점</li>\n    </ul>\n    <aside class="notes">발표자 메모 (화면에는 보이지 않음)</aside>\n'))
  .replace('\n</main>', EXTRA_SLIDE + '\n</main>');

// The skill's text as an agent sees it: SKILL.md plus the references it points to.
const skillDocs = () => ['SKILL.md', ...fs.readdirSync(path.join(SKILL, 'references')).map(f => 'references/' + f)]
  .map(f => fs.readFileSync(path.join(SKILL, f), 'utf8')).join('\n');

// ---------- tiny runner ----------
const tests = [];
const test = (name, fn, opts = {}) => tests.push({ name, fn, ...opts });
class Fail extends Error {}
const expect = (cond, msg) => { if (!cond) throw new Fail(msg); };
const eq = (a, b, msg) => expect(JSON.stringify(a) === JSON.stringify(b), `${msg}\n      expected: ${JSON.stringify(b)}\n      actual:   ${JSON.stringify(a)}`);

// ---------- server for http tests: static files + a fake folder API backed by real disk ----------
let tmpRoot;
const server = http.createServer((req, res) => {
  const u = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const isFs = u.startsWith('/fs/');
  const p = path.join(tmpRoot, isFs ? u.slice(3) : u);
  if (!p.startsWith(tmpRoot)) { res.writeHead(403); return res.end(); }
  if (req.method === 'PUT') {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, Buffer.concat(chunks));
      res.writeHead(200); res.end();
    });
    return;
  }
  if (u === '/favicon.ico') { res.writeHead(204); return res.end(); }
  if (!fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); return res.end(); }
  const type = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.png': 'image/png', '.css': 'text/css' }[path.extname(p)] || 'application/octet-stream';
  res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store', 'x-mtime': String(Math.round(fs.statSync(p).mtimeMs)) });
  res.end(req.method === 'HEAD' ? undefined : fs.readFileSync(p));
});

// Injected into http pages: showDirectoryPicker returns a handle whose files live in the test's folder on disk.
const FAKE_FS = `(() => {
  const base = '/fs' + location.pathname.replace(/[^/]*$/, '');
  const folder = location.pathname.split('/').filter(Boolean).slice(-2, -1)[0];
  window.__fs = { gone: false, perm: 'granted', pickName: null };
  const perm = () => window.__startPerm || window.__fs.perm;
  const exists = async p => (await fetch(base + p, { method: 'HEAD', cache: 'no-store' })).ok;
  class FH {
    constructor(p, name) { this.p = p; this.name = name; this.kind = 'file'; }
    async getFile() {
      if (window.__fs.gone) throw new DOMException('gone', 'NotFoundError');
      const r = await fetch(base + this.p, { cache: 'no-store' });
      if (!r.ok) throw new DOMException('missing', 'NotFoundError');
      return new File([await r.arrayBuffer()], this.name, { lastModified: +r.headers.get('x-mtime'), type: r.headers.get('content-type') || '' });
    }
    async createWritable() {
      const chunks = [], p = this.p;
      window.__writes = (window.__writes || 0) + 1;
      return { write: async d => { chunks.push(d); }, close: async () => { await fetch(base + p, { method: 'PUT', body: new Blob(chunks) }); } };
    }
  }
  class DH {
    constructor(p, name) { this.p = p; this.name = name; this.kind = 'directory'; }
    async getFileHandle(name, o = {}) {
      if (window.__fs.gone) throw new DOMException('gone', 'NotFoundError');
      const p = this.p + name;
      if (!(await exists(p))) {
        if (!o.create) throw new DOMException('missing', 'NotFoundError');
        await fetch(base + p, { method: 'PUT', body: '' });
      }
      return new FH(p, name);
    }
    async getDirectoryHandle(name) { return new DH(this.p + name + '/', name); }
    async queryPermission() { return perm(); }
    async requestPermission() { return perm() === 'denied' ? 'denied' : 'granted'; }
  }
  window.__pickerCalls = 0;
  window.showDirectoryPicker = async () => { window.__pickerCalls++; return new DH('', window.__fs.pickName || folder); };
  // A real folder handle survives a page reload in IndexedDB; this fake one is kept by path in localStorage instead.
  const put = IDBObjectStore.prototype.put, get = IDBObjectStore.prototype.get;
  IDBObjectStore.prototype.put = function (v, k) {
    if (v instanceof DH) { localStorage.setItem('fakeh:' + k, JSON.stringify([v.p, v.name])); return { set onsuccess(f) { setTimeout(f); } }; }
    return put.call(this, v, k);
  };
  IDBObjectStore.prototype.get = function (k) {
    const j = localStorage.getItem('fakeh:' + k);
    if (!j) return get.call(this, k);
    const [p, n] = JSON.parse(j);
    const q = { result: new DH(p, n) };
    Object.defineProperty(q, 'onsuccess', { set(f) { setTimeout(() => f && f()); } });
    return q;
  };
})();`;

// ---------- per-test environment ----------
let browser, port, seq = 0;
async function setup(t) {
  const dir = t.libraryDir ? path.join(os.homedir(), 'Library', 'Caches', 'deck-edit-test', 't' + (++seq)) : path.join(tmpRoot, 't' + (++seq));
  fs.mkdirSync(path.join(dir, 'assets'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'deck.html'), typeof t.fixture === 'function' ? t.fixture() : t.fixture || FIXTURE);
  // A single-file deck (deck export) runs with nothing beside it.
  if (!t.bare) {
    fs.copyFileSync(process.env.DECKJS || path.join(SKILL, 'deck-edit.js'), path.join(dir, 'deck-edit.js'));
    fs.writeFileSync(path.join(dir, 'assets', 'dot.png'), PNG);
  }
  const ctx = await browser.newContext({ viewport: t.viewport || { width: 1600, height: 1000 } });
  await useCdnCache(ctx);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  // the fake folder answers 404 when deck-edit checks whether a file name is free; that is expected
  page.on('console', m => { if (m.type() === 'error' && !(m.location().url || '').includes('/fs/')) errors.push('console: ' + m.text()); });
  page.on('dialog', d => (page.__dialog ? page.__dialog(d) : d.accept()));
  // Saving by itself is tested on its own; elsewhere each test saves when it means to.
  if (!t.autosave) await page.addInitScript(() => { window.deckEditOptions = { autosave: false }; });
  if (t.http) await page.addInitScript(FAKE_FS);
  if (t.init) await page.addInitScript(t.init);
  const url = t.url ? await t.url(dir) : t.http ? `http://127.0.0.1:${port}/t${seq}/deck.html` : 'file://' + path.join(dir, 'deck.html');
  await page.goto(url + (t.hash || ''));
  if (!t.noDeck) await page.waitForFunction(() => window.deckEdit && window.deckEdit.state.slides > 0);
  await page.waitForTimeout(300);
  const cdp = await ctx.newCDPSession(page);
  return { ctx, page, dir, url, errors, cdp };
}

// ---------- helpers bound to a page ----------
function helpers(env) {
  const { page, cdp, dir } = env;
  const h = {
    state: () => page.evaluate(() => deckEdit.state),
    deck: () => page.evaluate(() => deckEdit.deckHTML()),
    disk: () => fs.readFileSync(path.join(dir, 'deck.html'), 'utf8'),
    writeDisk: s => fs.writeFileSync(path.join(dir, 'deck.html'), s),
    cur: sel => page.locator(`main.deck > .slide.dk-current ${sel}`).first(),
    go: i => page.evaluate(i => deckEdit.go(i), i),
    edit: async () => { await page.keyboard.press('e'); await page.waitForTimeout(150); expect((await h.state()).mode === 'edit', 'should be in edit mode'); },
    act: a => page.evaluate(a => document.querySelector('#dk-chrome').shadowRoot.querySelector(`[data-act="${a}"]`).click(), a),
    shadow: sel => page.evaluate(sel => { const e = document.querySelector('#dk-chrome').shadowRoot.querySelector(sel); return e && { text: e.textContent, cls: e.className, display: getComputedStyle(e).display }; }, sel),
    // What is being edited: the focused editing host, or, when a run of slide-level blocks is edited together
    // (the slide is then the host), the block on the slide that holds the caret.
    active: () => page.evaluate(() => {
      let a = document.activeElement;
      if (!a) return null;
      const ce = a.getAttribute('contenteditable');
      if (a.classList.contains('slide') && ce === 'true') {
        let n = getSelection().anchorNode;
        while (n && n.parentElement !== a) n = n.parentElement;
        if (n) a = n;
      }
      return a.tagName + (a.className ? '.' + a.className : '') + ':' + ce;
    }),
    caretRect: () => page.evaluate(() => {
      const s = getSelection(); if (!s.rangeCount) return null;
      const r = s.getRangeAt(0).cloneRange();
      let rect = r.getClientRects()[0];
      if (!rect) { const sp = document.createElement('span'); sp.textContent = '​'; r.insertNode(sp); rect = sp.getBoundingClientRect(); sp.remove(); }
      return rect ? { x: rect.x, y: rect.y, h: rect.height } : null;
    }),
    // click near the right edge (end of text) or left edge of an element
    clickEnd: async loc => { const b = await loc.boundingBox(); await page.mouse.click(b.x + b.width - 2, b.y + b.height / 2); await page.waitForTimeout(60); },
    clickText: async (loc, where = 'end') => {
      const p = await loc.evaluate((el, where) => {
        const r = document.createRange();
        const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, { acceptNode: n => n.textContent.trim() ? 1 : 3 });
        const nodes = []; while (w.nextNode()) nodes.push(w.currentNode);
        const n = where === 'start' ? nodes[0] : nodes[nodes.length - 1];
        if (where === 'start') { r.setStart(n, 0); r.setEnd(n, 1); } else { r.setStart(n, n.length - 1); r.setEnd(n, n.length); }
        const b = r.getBoundingClientRect();
        return where === 'start' ? { x: b.left + 1, y: b.top + b.height / 2 } : { x: b.right - 1, y: b.top + b.height / 2 };
      }, where);
      await page.mouse.click(p.x, p.y);
      await page.waitForTimeout(60);
    },
    // Korean IME: every syllable goes through composition and is then committed.
    ime: async (text, { leaveComposing = false } = {}) => {
      const chars = [...text];
      for (let i = 0; i < chars.length; i++) {
        const c = chars[i];
        await cdp.send('Input.imeSetComposition', { text: c, selectionStart: 1, selectionEnd: 1 });
        if (leaveComposing && i === chars.length - 1) break;
        await cdp.send('Input.insertText', { text: c });
      }
    },
    // macOS Chrome: Enter while composing sends keydown(229, isComposing), the IME commits, then a real Enter.
    imeEnter: async committed => {
      await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 229, nativeVirtualKeyCode: 36 });
      await cdp.send('Input.insertText', { text: committed });
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 229, nativeVirtualKeyCode: 36 });
      await page.keyboard.press('Enter');
    },
    drag: async (from, to, steps = 6) => {
      await page.mouse.move(from.x, from.y);
      await page.mouse.down();
      await page.mouse.move(to.x, to.y, { steps });
      await page.mouse.up();
      await page.waitForTimeout(60);
    },
    center: async loc => { const b = await loc.boundingBox(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; },
    handle: async cls => { const b = await page.locator('#dk-chrome').evaluate((h, cls) => { const r = h.shadowRoot.querySelector(cls).getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; }, cls); return b; },
    settle: (ms = 600) => page.waitForTimeout(ms),
    // ⌘S, then wait until that save has really finished (connecting, merging, writing) instead of a fixed delay.
    save: async () => {
      const n = await page.evaluate(() => deckEdit.state.savesDone);
      await page.keyboard.press('Meta+s');
      await page.waitForFunction(n => deckEdit.state.savesDone > n, n, { timeout: 15000 }).catch(() => {});
      await page.waitForTimeout(60);
    },
    // click a control inside the editor chrome with the real mouse (keeps focus behaviour honest)
    tb: async sel => {
      await page.waitForTimeout(40);
      const c = await page.locator('#dk-chrome').evaluate((host, sel) => {
        const el = host.shadowRoot.querySelector(sel);
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return r.width ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null;
      }, sel);
      if (!c) throw new Fail('toolbar control not visible: ' + sel);
      await page.mouse.click(c.x, c.y);
      await page.waitForTimeout(60);
    },
    menu: async (kind, val) => { await h.tb(`[data-menu="${kind}"]`); await h.tb(`.menu [data-val="${val}"]`); },
    // open a toolbar menu (정렬 ▾, 목록 ▾, ⋯ …) and click an item in it
    pick: async (menu, sel) => { await h.tb(`[data-menu="${menu}"]`); await h.tb(`.menu ${sel}`); },
    rect: sel => page.locator('#dk-chrome').evaluate((host, sel) => { const r = host.shadowRoot.querySelector(sel).getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom }; }, sel),
    children: () => page.evaluate(() => document.querySelector('main.deck > .slide.dk-current').children.length),
    path: async () => (await h.state()).path,
    selectText: async (loc, text) => {
      await loc.evaluate((el, text) => {
        const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
        let n;
        while ((n = w.nextNode())) {
          const i = n.data.indexOf(text);
          if (i >= 0) { const r = document.createRange(); r.setStart(n, i); r.setEnd(n, i + text.length); const s = getSelection(); s.removeAllRanges(); s.addRange(r); return; }
        }
        throw new Error('text not found: ' + text);
      }, text);
      await page.waitForTimeout(40);
    },
    texts: sel => page.locator(`main.deck > .slide.dk-current ${sel}`).allTextContents(),
  };
  return h;
}

// =====================================================================
// Present mode
// =====================================================================
test('loads on file:// with folder API and IndexedDB, no console errors', async ({ page, h }) => {
  const env = await page.evaluate(async () => ({
    secure: isSecureContext, picker: typeof showDirectoryPicker,
    idb: await new Promise(r => { const q = indexedDB.open('probe', 1); q.onsuccess = () => r('ok'); q.onerror = () => r('err'); }),
  }));
  eq(env, { secure: true, picker: 'function', idb: 'ok' }, 'file:// environment');
  const s = await h.state();
  eq([s.mode, s.slides, s.cur], ['present', 5, 0], 'initial state');
});

test('navigation keys and URL hash', async ({ page, h }) => {
  const seq = [['ArrowRight', 1], [' ', 2], ['Shift+ ', 1], ['PageDown', 2], ['ArrowLeft', 1], ['End', 4], ['Home', 0], ['ArrowLeft', 0]];
  for (const [k, want] of seq) {
    await page.keyboard.press(k === ' ' ? 'Space' : k === 'Shift+ ' ? 'Shift+Space' : k);
    eq((await h.state()).cur, want, `after ${k}`);
  }
  await page.evaluate(() => { location.hash = '#4'; });
  await page.waitForTimeout(100);
  eq((await h.state()).cur, 3, 'hashchange navigates');
  expect(page.url().endsWith('#4'), 'hash reflects slide');
});

test('opening with #3 starts on slide 3', async ({ h }) => {
  eq((await h.state()).cur, 2, 'start slide');
}, { hash: '#3' });

test('slide is scaled to fit and centered (wide and tall windows)', async ({ page, h }) => {
  for (const vp of [{ width: 1600, height: 1000 }, { width: 900, height: 1000 }, { width: 1200, height: 500 }]) {
    await page.setViewportSize(vp);
    await page.waitForTimeout(80);
    const b = await page.locator('main.deck > .slide.dk-current').boundingBox();
    expect(b.width <= vp.width + 1 && b.height <= vp.height + 1, `fits ${vp.width}x${vp.height}: ${JSON.stringify(b)}`);
    expect(Math.abs(b.x + b.width / 2 - vp.width / 2) < 2 && Math.abs(b.y + b.height / 2 - vp.height / 2) < 2, 'centered');
    expect(Math.abs(b.width / b.height - 16 / 9) < 0.01, 'aspect kept');
    expect(Math.abs(b.width - vp.width) < 2 || Math.abs(b.height - vp.height) < 2, 'fills one dimension');
  }
});

test('mouse pointer hides only while presenting idle (regression: stayed hidden in edit mode)', async ({ page, h }) => {
  const cursor = () => page.locator('main.deck > .slide.dk-current h1').evaluate(e => getComputedStyle(e).cursor);
  await page.mouse.move(400, 400); await page.mouse.move(410, 410);
  await page.waitForTimeout(2000);
  eq(await cursor(), 'none', 'present idle hides pointer');
  await page.mouse.move(420, 420);
  expect(await cursor() !== 'none', 'moving shows pointer again');
  await page.keyboard.press('e');
  await page.waitForTimeout(2200);
  expect(await cursor() !== 'none', 'edit mode never hides pointer');
  await h.clickText(h.cur('h1'));
  await page.keyboard.type('x');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(2200);
  expect(await cursor() !== 'none', 'still visible after typing + Enter');
}, { serial: true });   // times a 1.8s idle timer: run alone

test('Korean layout key ㄷ toggles edit mode', async ({ page, h }) => {
  await page.keyboard.press('KeyE'); // reset nothing; real check below uses key value
  await page.evaluate(() => deckEdit.setMode('present'));
  await page.evaluate(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ㄷ', code: 'KeyE', bubbles: true })));
  eq((await h.state()).mode, 'edit', 'ㄷ enters edit');
});

// =====================================================================
// Text editing
// =====================================================================
test('click puts the caret where you clicked', async ({ page, h }) => {
  await h.go(1); await h.edit();
  const h2 = h.cur('h2');
  await h.clickText(h2, 'start');
  await page.keyboard.type('X');
  await h.clickText(h2, 'end');
  await page.keyboard.type('Y');
  eq(await h2.textContent(), 'X슬라이드 제목Y', 'text after two clicks');
});

test('Korean IME typing produces exactly the composed text', async ({ page, h }) => {
  await h.go(1); await h.edit();
  await h.clickText(h.cur('h2'));
  await h.ime('한글 입력 테스트');
  await h.settle();
  eq(await h.cur('h2').textContent(), '슬라이드 제목한글 입력 테스트', 'heading text');
  expect((await h.deck()).includes('<h2>슬라이드 제목한글 입력 테스트</h2>'), 'serialized');
});

test('Enter while composing Korean in a bullet: new bullet, no doubled syllable', async ({ page, h }) => {
  await h.go(1); await h.edit();
  await h.clickText(h.cur('li'));
  await h.ime('부제', { leaveComposing: true });
  await h.imeEnter('제');
  await page.waitForTimeout(50);
  await h.ime('다음');
  await h.settle();
  eq(await h.texts('li'), ['첫 번째 요점부제', '다음', '두 번째 요점', '세 번째 요점'], 'bullets');
});

test('Enter while composing Korean in a paragraph: splits once, no doubled syllable', async ({ page, h }) => {
  await h.edit();
  await h.clickText(h.cur('.sub'));
  await h.ime('부제', { leaveComposing: true });
  await h.imeEnter('제');
  await h.ime('둘째 줄');
  await h.settle();
  eq(await h.texts('p.sub'), ['한 줄 부제부제', '둘째 줄'], 'paragraphs');
});

test('Enter in a paragraph creates a sibling paragraph with a visible caret', async ({ page, h }) => {
  await h.edit();
  await h.clickText(h.cur('.sub'));
  const before = await h.caretRect();
  await page.keyboard.press('Enter');
  const after = await h.caretRect();
  expect(after && after.h > 10, 'caret has height on the empty new line: ' + JSON.stringify(after));
  expect(after.y > before.y + 10, 'caret moved down');
  eq(await h.active(), 'P.sub:true', 'focus on new paragraph');
  await page.keyboard.type('B');
  eq(await h.texts('p.sub'), ['한 줄 부제', 'B'], 'two paragraphs');
});

test('Enter at the start of a paragraph pushes it down and keeps an empty line', async ({ page, h }) => {
  await h.edit();
  await h.clickText(h.cur('.sub'), 'start');
  await page.keyboard.press('Home');
  await page.keyboard.press('Enter');
  const subs = page.locator('main.deck > .slide.dk-current p.sub');
  eq(await subs.count(), 2, 'two paragraphs');
  expect((await subs.nth(0).boundingBox()).height > 20, 'empty first paragraph keeps its line height');
  eq(await subs.nth(1).textContent(), '한 줄 부제', 'text moved down');
});

test('Enter in a heading inserts a line break and the caret goes to the new line', async ({ page, h }) => {
  await h.edit();
  await h.clickText(h.cur('h1'));
  const y0 = (await h.caretRect()).y;
  await page.keyboard.press('Enter');
  const c = await h.caretRect();
  expect(c && c.y > y0 + 30 && c.h > 10, 'caret on line 2: ' + JSON.stringify(c));
  await page.keyboard.type('둘째');
  eq(await h.cur('h1').innerHTML(), '발표 제목<br>둘째', 'heading html');
  eq(await page.locator('main.deck > .slide.dk-current h1').count(), 1, 'still one heading');
});

test('Shift+Enter in a bullet inserts a line break, not a new bullet', async ({ page, h }) => {
  await h.go(1); await h.edit();
  await h.clickText(h.cur('li'));
  await page.keyboard.press('Shift+Enter');
  await page.keyboard.type('줄');
  eq(await h.cur('li').innerHTML(), '첫 번째 요점<br>줄', 'bullet html');
  eq((await h.texts('li')).length, 3, 'bullet count unchanged');
});

test('Backspace at the start of a bullet joins it to the previous one', async ({ page, h }) => {
  await h.go(1); await h.edit();
  await h.clickText(page.locator('main.deck > .slide.dk-current li').nth(1), 'start');
  await page.keyboard.press('Home');
  await page.keyboard.press('Backspace');
  eq(await h.texts('li'), ['첫 번째 요점두 번째 요점', '세 번째 요점'], 'merged');
  await page.keyboard.type('|');
  eq((await h.texts('li'))[0], '첫 번째 요점|두 번째 요점', 'caret sits at the join');
});

test('Enter then Backspace on an empty bullet leaves the list as it was', async ({ page, h }) => {
  await h.go(1); await h.edit();
  const before = await h.deck();
  await h.clickText(h.cur('li'));
  await page.keyboard.press('Enter');
  eq((await h.texts('li')).length, 4, 'new bullet');
  await page.keyboard.press('Backspace');
  eq((await h.texts('li')).length, 3, 'bullet removed');
  await page.keyboard.type('!');
  eq((await h.texts('li'))[0], '첫 번째 요점!', 'caret back at end of previous bullet');
  await page.keyboard.press('Backspace');
  await page.keyboard.press('Escape');
  eq(await h.deck(), before, 'deck identical');
});

test('trailing line breaks are not saved', async ({ page, h }) => {
  await h.edit();
  await h.clickText(h.cur('h1'));
  await page.keyboard.press('Enter');
  await page.keyboard.press('Escape');
  expect((await h.deck()).includes('<h1>발표 제목</h1>'), 'no <br> left in heading');
});

test('Esc stops editing and keeps selection; Esc again selects the parent', async ({ page, h }) => {
  await h.go(2); await h.edit();
  await h.clickText(h.cur('.cols p'));
  await page.keyboard.press('Escape');
  eq(await h.active(), 'BODY:null', 'not editing');
  eq(await h.path(), 'div.cols › div › p', 'paragraph selected');
  await page.keyboard.press('Escape');
  eq(await h.path(), 'div.cols › div', 'parent selected');
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  eq((await h.state()).selected, null, 'nothing selected');
});

test('letters, Delete and arrows while editing only touch the text', async ({ page, h }) => {
  await h.go(1); await h.edit();
  await h.clickText(h.cur('h2'));
  await page.keyboard.type('e?');
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('Delete');
  await page.keyboard.press('Backspace');
  const s = await h.state();
  eq(s.mode, 'edit', 'still editing mode');
  eq(await h.cur('h2').textContent(), '슬라이드 제목', 'typed then deleted');
  eq(await h.shadow('.help').then(x => x.display), 'none', 'help did not open');
});

test('pasting rich text inserts plain text only', async ({ page, h }) => {
  await h.go(1); await h.edit();
  await h.clickText(h.cur('h2'));
  await page.evaluate(() => {
    const dt = new DataTransfer();
    dt.setData('text/html', '<b style="color:red;font-size:99px">굵은 <i>글</i></b>');
    dt.setData('text/plain', '굵은 글');
    document.activeElement.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  });
  eq(await h.cur('h2').innerHTML(), '슬라이드 제목굵은 글', 'plain text pasted');
});

test('⌘B makes bold and survives saving', async ({ page, h }) => {
  await h.go(1); await h.edit();
  await h.clickText(h.cur('li'));
  await page.keyboard.press('Shift+Home');
  await page.keyboard.press('Meta+b');
  await page.keyboard.press('Escape');
  expect((await h.deck()).includes('<li><b>첫 번째 요점</b></li>'), 'bold in output: ' + (await h.deck()).match(/<li>.*?<\/li>/)[0]);
});

test('undo and redo across typing', async ({ page, h }) => {
  await h.go(1); await h.edit();
  await h.clickText(h.cur('h2'));
  await page.keyboard.type('abc');
  await h.settle();
  await page.keyboard.type('def');
  await page.keyboard.press('Meta+z');
  eq(await h.cur('h2').textContent(), '슬라이드 제목abc', 'undo removes the last burst');
  await page.keyboard.press('Meta+z');
  eq(await h.cur('h2').textContent(), '슬라이드 제목', 'undo again');
  await page.keyboard.press('Meta+Shift+z');
  await page.keyboard.press('Meta+Shift+z');
  eq(await h.cur('h2').textContent(), '슬라이드 제목abcdef', 'redo twice');
});

test('clicking another text commits the previous edit', async ({ page, h }) => {
  await h.go(1); await h.edit();
  await h.clickText(h.cur('h2'));
  await page.keyboard.type('1');
  await h.clickText(h.cur('li'));
  await page.keyboard.type('2');
  await page.keyboard.press('Escape');
  const d = await h.deck();
  expect(d.includes('<h2>슬라이드 제목1</h2>') && d.includes('<li>첫 번째 요점2</li>'), 'both edits kept');
  const s = await h.state();
  expect(s.hist >= 3, 'two history entries: ' + s.hist);
});

// =====================================================================
// Objects
// =====================================================================
test('drag moves an svg with translate; a plain click does not move it', async ({ page, h }) => {
  await h.go(2); await h.edit();
  const svg = h.cur('svg');
  const c = await h.center(svg);
  await page.mouse.click(c.x, c.y);
  expect(!/<svg[^>]*style/.test(await h.deck()), 'click alone changes nothing');
  await h.drag(c, { x: c.x + 50, y: c.y + 25 });
  const m = (await h.deck()).match(/<svg[^>]*style="translate: (\d+)px (\d+)px;"/);
  expect(m, 'translate written');
  const scale = (await page.locator('main.deck > .slide.dk-current').boundingBox()).width / 1920;
  expect(Math.abs(+m[1] - 50 / scale) <= 3, `moved by screen distance / scale (${m[1]} vs ${(50 / scale).toFixed(1)})`);
});

test('resize handle: image keeps aspect ratio; a table scales with its letters', async ({ page, h }) => {
  await h.go(4); await h.edit();
  await page.mouse.click(...Object.values(await h.center(h.cur('img.pic'))));
  await h.settle(100);
  let r = await h.handle('.sel .resize');
  await h.drag(r, { x: r.x + 60, y: r.y + 200 });
  const d = await h.deck();
  expect(/<img class="pic"[^>]*style="width: \d+px; height: auto; max-width: none;"/.test(d), 'img width + auto height: ' + d.match(/<img class="pic"[^>]*>/)[0]);
  await page.keyboard.press('Escape');
  await page.mouse.click(...Object.values(await h.center(h.cur('table td'))));
  await page.keyboard.press('Escape');
  eq(await h.path(), 'table', 'one Esc from a cell selects the table');
  await h.settle(100);
  r = await h.handle('.sel .resize');
  await h.drag(r, { x: r.x + 40, y: r.y + 40 });
  const t = (await h.deck()).match(/<table[^>]*>/)[0];
  expect(/font-size: (\d+)px/.test(t) && +t.match(/font-size: (\d+)px/)[1] > 34, 'table letters scaled up: ' + t);
});

test('arrow keys nudge, ⌘D duplicates, Delete removes, ⌘Z restores', async ({ page, h }) => {
  await h.go(2); await h.edit();
  const before = await h.deck();
  await page.mouse.click(...Object.values(await h.center(h.cur('svg'))));
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Shift+ArrowDown');
  await h.settle();
  expect((await h.deck()).includes('style="translate: 1px 10px;"'), 'nudged 1px right, 10px down');
  await page.keyboard.press('Meta+d');
  eq(await page.locator('main.deck > .slide.dk-current svg').count(), 2, 'duplicated');
  await page.keyboard.press('Delete');
  eq(await page.locator('main.deck > .slide.dk-current svg').count(), 1, 'copy deleted');
  eq((await h.state()).selected, null, 'nothing selected after delete');
  for (let i = 0; i < 6; i++) await page.keyboard.press('Meta+z');
  eq(await h.deck(), before, 'undo back to start');
});

test('the "⤴ … 전체" chip selects the surrounding group, which can then be dragged', async ({ page, h }) => {
  await h.go(2); await h.edit();
  await h.clickText(h.cur('.cols p'));
  await page.keyboard.press('Escape');
  eq((await h.shadow('.tag')).text, 'Text⤴ Select whole group', 'chip names the paragraph and its group');
  await h.tb('.tag button');
  await h.tb('.tag button');
  eq(await h.path(), 'div.cols', 'container selected');
  const c = await h.center(h.cur('.cols'));
  await h.drag(c, { x: c.x, y: c.y + 40 });
  expect(/<div class="cols" style="translate: 0px \d+px;"/.test(await h.deck()), 'container moved');
});

test('click (no drag) inside a selected container starts editing that text', async ({ page, h }) => {
  await h.go(2); await h.edit();
  await page.mouse.click(...Object.values(await h.center(h.cur('svg'))));
  await page.keyboard.press('Escape'); // figure
  await page.keyboard.press('Escape'); // div.cols
  eq(await h.path(), 'div.cols', 'cols selected');
  await h.clickText(h.cur('.cols p'));
  eq(await h.active(), 'P:true', 'editing paragraph');
  await page.keyboard.type('!');
  eq(await h.cur('.cols p').textContent(), '왼쪽에 설명을 둡니다.!', 'typed at click point');
  expect(!(await h.deck()).includes('translate'), 'nothing moved');
});

test('grip handle moves a text element while it is being edited', async ({ page, h }) => {
  await h.go(1); await h.edit();
  await h.clickText(h.cur('h2'));
  const g = await h.handle('.grip');
  await h.drag(g, { x: g.x + 30, y: g.y + 30 });
  expect(/<h2 style="translate: \d+px \d+px;">/.test(await h.deck()), 'heading moved');
});

test('inline math can be moved (becomes inline-block)', async ({ page, h }) => {
  await h.go(4); await h.edit();
  const m = h.cur('p.withmath .math');
  const c = await h.center(m);
  await h.drag(c, { x: c.x + 30, y: c.y });
  const span = (await h.deck()).match(/<span class="math"[^>]*>x\^2<\/span>/)[0];
  expect(/style="display: inline-block; translate: \d+px;"/.test(span), 'math moved: ' + span);
});

test('⌘⇧. / ⌘⇧, change font size', async ({ page, h }) => {
  await h.go(1); await h.edit();
  await h.clickText(h.cur('h2'));
  await page.keyboard.press('Meta+Shift+Period');
  expect((await h.deck()).includes('<h2 style="font-size: 70px;">'), '⌘⇧. → 70px');
  await page.keyboard.press('Meta+Shift+Comma');
  expect((await h.deck()).includes('<h2 style="font-size: 64px;">'), '⌘⇧, → 64px');
  eq(await h.active(), 'H2:true', 'still editing');
});

test('text box: added, typed, Enter adds a line break inside it', async ({ page, h }) => {
  await h.go(1); await h.edit();
  await h.tb('[data-act="text"]');
  await page.keyboard.type('첫 줄');
  await page.keyboard.press('Enter');
  await page.keyboard.type('둘째 줄');
  await page.keyboard.press('Escape');
  const d = await h.deck();
  expect(/<p style="position: absolute;[^"]*">첫 줄<br>둘째 줄<\/p>/.test(d), 'one absolute box with a line break: ' + d.match(/<p style="position[^]*?<\/p>/));
});

// =====================================================================
// Math
// =====================================================================
test('double-click math edits TeX; Esc renders; output keeps TeX', async ({ page, h }) => {
  await h.go(3); await h.edit();
  const m = h.cur('div.math');
  await m.dblclick();
  expect((await m.textContent()).includes('\\mathcal{L}'), 'raw TeX shown');
  await page.keyboard.press('End');
  await page.keyboard.type(' + 1');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Escape');
  expect(await m.evaluate(e => !!e.querySelector('.katex')), 're-rendered');
  expect((await h.deck()).includes('\\log q_\\theta(x)\\right] + 1</div>'), 'TeX saved without newline');
});

test('editing a paragraph with inline math leaves the math intact', async ({ page, h }) => {
  await h.go(4); await h.edit();
  await h.clickText(h.cur('p.withmath'));
  await page.keyboard.type(' 끝');
  await page.keyboard.press('Escape');
  expect((await h.deck()).includes('<p class="withmath">수식 <span class="math">x^2</span> 포함 문장 끝</p>'), 'math TeX intact');
});

// =====================================================================
// Slides & thumbnails
// =====================================================================
test('duplicate, delete, undo delete, reorder by dragging thumbnails', async ({ page, h }) => {
  await h.edit();
  await h.menu('slide', 'dup');
  eq((await h.state()).slides, 6, 'duplicated');
  eq((await h.state()).cur, 1, 'moved to copy');
  await h.menu('slide', 'del');
  await h.menu('slide', 'del');
  eq((await h.state()).slides, 4, 'deleted two');
  await page.keyboard.press('Meta+z');
  eq((await h.state()).slides, 5, 'undo restores one');
  await h.settle(400);
  const thumbs = page.locator('#dk-sidebar .dk-thumb');
  eq(await thumbs.count(), 5, 'thumbnails match');
  await thumbs.nth(4).dragTo(thumbs.nth(0), { targetPosition: { x: 100, y: 4 } });
  const firsts = await page.evaluate(() => [...document.querySelectorAll('main.deck > .slide')].map(s => s.querySelector('h1,h2').textContent));
  eq(firsts[0], '표와 이미지', 'last slide moved to front');
  eq((await h.state()).cur, 0, 'current follows moved slide');
});

test('thumbnails follow edits and click navigates', async ({ page, h }) => {
  await h.go(1); await h.edit();
  await h.clickText(h.cur('h2'));
  await page.keyboard.type('수정');
  await h.settle(900);
  eq(await page.locator('#dk-sidebar .dk-thumb').nth(1).locator('h2').textContent(), '슬라이드 제목수정', 'thumbnail updated');
  await page.locator('#dk-sidebar .dk-thumb').nth(3).click();
  eq((await h.state()).cur, 3, 'thumbnail click');
});

test('toolbar fits on a 1280px-wide window', async ({ page, h }) => {
  await h.edit();
  const fit = await page.locator('#dk-chrome').evaluate(host => { const b = host.shadowRoot.querySelector('.bar'); return [b.scrollWidth, b.clientWidth]; });
  expect(fit[0] <= fit[1], 'no overflow: ' + fit);
}, { viewport: { width: 1280, height: 800 } });


// =====================================================================
// Text toolbar
// =====================================================================
test('toolbar appears next to the text being edited (not on the list) and hides otherwise', async ({ page, h }) => {
  await h.go(1); await h.edit();
  const vis = async () => (await h.shadow('.fmt')).display;
  eq(await vis(), 'none', 'hidden with nothing selected');
  await h.clickText(h.cur('li'));
  eq(await vis(), 'flex', 'shown while editing');
  const tb = await h.rect('.fmt');
  const ul = await h.cur('ul').boundingBox();
  expect(tb.bottom < ul.y || tb.y > ul.y + ul.height, 'toolbar sits next to the list, not on it: ' + JSON.stringify([tb, ul]));
  eq((await h.shadow('.fmt .block .lbl')).text, 'List', 'block label');
  await page.keyboard.press('Escape');
  eq(await vis(), 'none', 'hidden after Esc');
  await h.go(3);
  await h.cur('div.math').dblclick();
  eq(await vis(), 'none', 'not shown for TeX editing');
});

test('B / I / S apply to the selection, or to the whole paragraph with no selection', async ({ page, h }) => {
  await h.go(1); await h.edit();
  await h.clickText(h.cur('li'));
  await h.selectText(h.cur('li'), '요점');
  await h.tb('[data-fmt="bold"]');
  eq(await h.cur('li').innerHTML(), '첫 번째 <b>요점</b>', 'bold selection');
  expect((await h.shadow('[data-fmt="bold"]')).cls.includes('on'), 'bold button active');
  await h.tb('[data-fmt="italic"]');
  eq(await h.cur('li').innerHTML(), '첫 번째 <b><i>요점</i></b>', 'italic too');
  const li2 = page.locator('main.deck > .slide.dk-current li').nth(1);
  await h.clickText(li2);
  await h.tb('[data-fmt="strikeThrough"]');
  eq(await li2.innerHTML(), '<strike>두 번째 요점</strike>', 'whole item struck');
  eq(await h.active(), 'UL:true', 'still editing (the whole list is the editing unit)');
});

test('size menu: selection gets a span, no selection sizes the paragraph', async ({ page, h }) => {
  await h.go(1); await h.edit();
  await h.clickText(h.cur('li'));
  await h.selectText(h.cur('li'), '번째');
  await h.tb('[data-menu="size"]');
  await h.tb('.menu [data-val="64"]');
  eq(await h.cur('li').innerHTML(), '첫 <span style="font-size: 64px;">번째</span> 요점', 'selection sized');
  await h.clickText(h.cur('li'));
  await h.tb('[data-menu="size"]');
  await h.tb('.menu [data-val="28"]');
  expect((await h.deck()).includes('<li style="font-size: 28px;">첫 번째 요점</li>'), 'whole item sized, inner size dropped');
  eq((await h.shadow('.fmt .size .lbl')).text, '28', 'size label updates');
});

test('color menu: theme colors are saved as CSS variables', async ({ page, h }) => {
  await h.go(1); await h.edit();
  await h.clickText(h.cur('li'));
  await h.selectText(h.cur('li'), '요점');
  await h.tb('[data-menu="color"]');
  await h.tb('.menu [data-val="var(--accent)"]');
  eq(await h.cur('li').innerHTML(), '첫 번째 <span style="color: var(--accent);">요점</span>', 'accent var on selection');
  await page.keyboard.press('Escape');
  await h.clickText(h.cur('h2'));
  await h.tb('[data-menu="color"]');
  await h.tb('.menu [data-val="#d93025"]');
  expect((await h.deck()).includes('<h2 style="color: rgb(217, 48, 37);">슬라이드 제목</h2>'), 'whole heading colored');
});

test('block menu turns a paragraph into a heading and keeps the caret', async ({ page, h }) => {
  await h.edit();
  await h.clickText(h.cur('.sub'), 'start');
  await page.keyboard.press('Home');
  await page.keyboard.press('ArrowRight');
  await h.tb('[data-menu="block"]');
  await h.tb('.menu [data-val="H2"]');
  eq(await h.active(), 'H2.sub:true', 'editing the new heading');
  await page.keyboard.type('|');
  expect((await h.deck()).includes('<h2 class="sub">한| 줄 부제</h2>'), 'tag changed, class kept, caret kept');
});

test('list buttons: paragraph → bullet list → numbered → back to paragraphs', async ({ page, h }) => {
  await h.go(2); await h.edit();
  await h.clickText(h.cur('.cols p'));
  await h.pick('list', '[data-fmt="ul"]');
  expect((await h.deck()).includes('<ul><li>왼쪽에 설명을 둡니다.</li></ul>'), 'became a bullet list');
  await h.pick('list', '[data-fmt="ol"]');
  expect((await h.deck()).includes('<ol><li>왼쪽에 설명을 둡니다.</li></ol>'), 'became numbered');
  await page.keyboard.press('End'); await page.keyboard.press('Enter'); await page.keyboard.type('둘');
  // With the caret in one bullet, only that bullet leaves the list; with both selected, both do.
  await h.pick('list', '[data-fmt="unlist"]');
  expect((await h.deck()).includes('<ol><li>왼쪽에 설명을 둡니다.</li></ol><p>둘</p>'), 'caret bullet back to a paragraph: ' + (await h.deck()).match(/<div>[\s\S]*?<\/div>/)[0]);
  await page.keyboard.press('Meta+z');
  await h.clickText(h.cur('.cols li'));
  await page.keyboard.press('Meta+a');
  await h.pick('list', '[data-fmt="unlist"]');
  expect((await h.deck()).includes('<p>왼쪽에 설명을 둡니다.</p><p>둘</p>'), 'back to paragraphs: ' + (await h.deck()).match(/<div>[\s\S]*?<\/div>/)[0]);
});

test('alignment, quote, clear formatting', async ({ page, h }) => {
  await h.go(1); await h.edit();
  await h.clickText(h.cur('h2'));
  await h.pick('align', '[data-fmt="align"][data-val="center"]');
  expect((await h.deck()).includes('<h2 style="text-align: center;">'), 'centered');
  expect((await h.shadow('[data-val="center"]')).cls.includes('on'), 'center active');
  await h.tb('[data-fmt="bold"]');
  await h.pick('more', '[data-fmt="clear"]');
  eq(await h.cur('h2').evaluate(e => e.outerHTML.replace(' contenteditable="true"', '')), '<h2>슬라이드 제목</h2>', 'clear removes bold and alignment');
  await page.keyboard.press('Escape');
  await h.go(2);
  await h.clickText(h.cur('.cols p'));
  await h.pick('more', '[data-fmt="quote"]');
  expect((await h.deck()).includes('<blockquote>왼쪽에 설명을 둡니다.</blockquote>'), 'quoted');
});

test('link via toolbar and ⌘K; unlink', async ({ page, h }) => {
  await h.go(1); await h.edit();
  await h.clickText(h.cur('li'));
  await h.selectText(h.cur('li'), '요점');
  page.__dialog = d => d.accept('https://example.com');
  await h.tb('[data-fmt="link"]');
  eq(await h.cur('li').innerHTML(), '첫 번째 <a href="https://example.com">요점</a>', 'link created');
  await h.selectText(h.cur('li'), '첫');
  page.__dialog = d => d.accept('https://kaist.ac.kr');
  await page.keyboard.press('Meta+k');
  expect((await h.cur('li').innerHTML()).startsWith('<a href="https://kaist.ac.kr">첫</a>'), '⌘K link');
  await h.selectText(h.cur('li'), '요점');
  await h.pick('more', '[data-fmt="unlink"]');
  eq(await h.cur('li').innerHTML(), '<a href="https://kaist.ac.kr">첫</a> 번째 요점', 'unlinked');
});

test('∑ inserts an inline formula that renders and saves as TeX', async ({ page, h }) => {
  await h.go(1); await h.edit();
  await h.clickText(h.cur('li'));
  page.__dialog = d => d.accept('\\alpha + \\beta');
  await h.tb('[data-fmt="math"]');
  await page.waitForFunction(() => document.querySelector('main.deck > .slide.dk-current li .math .katex'), null, { timeout: 5000 });
  await page.keyboard.type(' 끝');
  await page.keyboard.press('Escape');
  const li = (await h.deck()).match(/<li>첫 번째 요점.*?<\/li>/)[0];
  eq(li, '<li>첫 번째 요점<span class="math">\\alpha + \\beta</span> 끝</li>', 'saved TeX, no helper characters');
});

test('code button wraps the selection in <code> and unwraps it again', async ({ page, h }) => {
  await h.go(1); await h.edit();
  await h.clickText(h.cur('li'));
  await h.selectText(h.cur('li'), '번째');
  await h.pick('more', '[data-fmt="code"]');
  eq(await h.cur('li').innerHTML(), '첫 <code>번째</code> 요점', 'wrapped');
  await h.pick('more', '[data-fmt="code"]');
  eq(await h.cur('li').innerHTML(), '첫 번째 요점', 'unwrapped');
});

test('toolbar edits are undoable', async ({ page, h }) => {
  await h.go(1); await h.edit();
  const before = await h.deck();
  await h.clickText(h.cur('li'));
  await h.pick('align', '[data-fmt="align"][data-val="right"]');
  await h.pick('list', '[data-fmt="ol"]');
  await h.settle();
  await page.keyboard.press('Meta+z');
  await page.keyboard.press('Meta+z');
  eq(await h.deck(), before, 'back to start');
});


// =====================================================================
// Adding things, object toolbar, labels
// =====================================================================
test('selection chip uses plain names, never tag names', async ({ page, h }) => {
  await h.go(2); await h.edit();
  await page.mouse.click(...Object.values(await h.center(h.cur('svg'))));
  eq((await h.shadow('.tag')).text, 'Figure⤴ Select whole figure group', 'svg chip');
  await h.go(3);
  await page.mouse.click(...Object.values(await h.center(h.cur('div.math'))));
  eq((await h.shadow('.tag')).text, 'Equation', 'math chip');
  await h.clickText(h.cur('h2'));
  eq((await h.shadow('.tag')).display, 'none', 'chip hidden while typing');
  const bar = await page.locator('#dk-chrome').evaluate(h => h.shadowRoot.querySelector('.bar').textContent);
  expect(!/div|span|\bp\b|h2/.test(bar), 'top bar has no tag names: ' + bar.replace(/\s+/g, ' '));
});

test('insert from the top bar: title and list (텍스트 ▾), table, formula go into the flow', async ({ page, h }) => {
  await h.go(1); await h.edit();
  await h.menu('slide', 'blank');
  await h.menu('text', 'title');
  await page.keyboard.type('새 제목');
  await h.menu('text', 'list');
  await page.keyboard.type('하나');
  await page.keyboard.press('Enter');
  await page.keyboard.type('둘');
  await h.tb('[data-act="table"]');
  await page.keyboard.type('이름');
  page.__dialog = d => d.accept('E=mc^2');
  await h.tb('[data-act="math"]');
  await page.waitForFunction(() => [...document.querySelectorAll('main.deck > .slide.dk-current div.math')].some(m => m.querySelector('.katex')));
  const d = await h.deck();
  const slide = d.slice(d.lastIndexOf('<section class="slide">', d.indexOf('새 제목')));
  // Inserted markup is indented like hand-written HTML: one block per line, a table one row per line.
  const want = `<section class="slide">
    <h2>새 제목</h2>
    <ul>
      <li>하나</li>
      <li>둘</li>
    </ul>
    <table style="width: 100%; border-collapse: collapse;">
      <thead>
        <tr><th>이름</th><th></th><th></th></tr>
      </thead>
      <tbody>
        <tr><td></td><td></td><td></td></tr>
        <tr><td></td><td></td><td></td></tr>
      </tbody>
    </table>
    <div class="math display">E=mc^2</div>
  </section>`;
  eq(slide.slice(0, want.length), want, 'flow inserts, in order, no position, indented');
});

test('shapes: rectangle resizes freely, fill uses theme color, rotate, order, delete', async ({ page, h }) => {
  await h.go(1); await h.edit();
  await h.menu('shape', 'rect');
  const rect = h.cur('div.shape');
  eq((await h.shadow('.tag')).text, 'Shape', 'chip');
  eq((await h.shadow('.otb')).display, 'flex', 'object toolbar shown');
  const b0 = await rect.boundingBox();
  const r = await h.handle('.sel .resize');
  await h.drag(r, { x: r.x + 80, y: r.y - 60 });
  const b1 = await rect.boundingBox();
  expect(b1.width > b0.width + 50 && b1.height < b0.height - 30, 'width and height change independently');
  await h.tb('[data-menu="fill"]');
  await h.tb('.menu [data-val="var(--accent)"]');
  await h.pick('objmore', '[data-obj="rotr"]');
  await h.pick('objmore', '[data-obj="back"]');
  const st = await rect.getAttribute('style');
  expect(st.includes('background: var(--accent)') && st.includes('rotate: 15deg') && st.includes('z-index: 0') && !st.includes('z-index: -'), 'styles: ' + st);
  await h.tb('[data-obj="dup"]');
  eq(await page.locator('main.deck > .slide.dk-current div.shape').count(), 2, 'duplicated');
  await h.tb('[data-obj="del"]');
  eq(await page.locator('main.deck > .slide.dk-current div.shape').count(), 1, 'deleted');
});

test('shapes: round, circle, line and arrow; arrow redraws at its new size', async ({ page, h }) => {
  await h.go(1); await h.edit();
  for (const k of ['round', 'circle', 'line']) await h.menu('shape', k);
  await h.tb('[data-act="arrow"]');
  const kinds = await page.evaluate(() => [...document.querySelectorAll('main.deck > .slide.dk-current .shape')].map(e => e.dataset.shape));
  eq(kinds, ['round', 'circle', 'line', 'arrow'], 'all inserted');
  eq((await h.shadow('.tag')).text, 'Arrow', 'arrow selected');
  const r = await h.handle('.endpt.head');
  await h.drag(r, { x: r.x + 100, y: r.y });
  const arrow = await page.evaluate(() => { const a = document.querySelector('main.deck > .slide.dk-current svg[data-shape="arrow"]'); return [a.getAttribute('viewBox'), a.style.width, a.querySelector('polygon') ? 1 : 0]; });
  eq(arrow[0], `0 0 ${parseInt(arrow[1])} 40`, 'viewBox follows width (no stretched head)');
  eq(arrow[2], 1, 'has a head');
  await h.tb('[data-menu="fill"]');
  await h.tb('.menu [data-val="#d93025"]');
  expect((await h.deck()).includes('stroke: rgb(217, 48, 37)') || (await h.deck()).includes('stroke: #d93025'), 'line colored');
  await h.tb('[data-act="shape"]');
  eq(await page.evaluate(() => [...document.querySelectorAll('main.deck > .slide.dk-current .shape')].pop().dataset.shape), 'line', 'the Shape button repeats the last shape picked');
});

test('slide menu: new slide (title + list) and blank slide', async ({ page, h }) => {
  await h.edit();
  await h.menu('slide', 'new');
  eq((await h.state()).cur, 1, 'moved to the new slide');
  await page.keyboard.type('결론');
  await h.menu('slide', 'blank');
  eq((await h.state()).slides, 7, 'two slides added');
  const d = await h.deck();
  expect(d.includes('<h2>결론</h2>') && d.includes('<section class="slide">\n  </section>'), 'contents');
});

test('table: add and remove rows and columns from the 행 ▾ / 열 ▾ menus', async ({ page, h }) => {
  await h.go(4); await h.edit();
  await h.clickText(h.cur('td'));
  eq((await h.shadow('.fmt .g-table')).display, 'flex', 'table controls shown in a cell');
  await h.pick('row', '[data-val="row-below"]');
  await page.keyboard.type('C');
  await h.pick('col', '[data-val="col-right"]');
  const shape = () => page.evaluate(() => [...document.querySelectorAll('main.deck > .slide.dk-current table tr')].map(r => r.children.length));
  eq(await shape(), [3, 3, 3], 'one more row and column');
  await h.pick('col', '[data-val="col-del"]');
  await h.pick('row', '[data-val="row-del"]');
  eq(await shape(), [2, 2], 'removed again');
  await h.clickText(h.cur('h2'));
  eq((await h.shadow('.fmt .g-table')).display, 'none', 'hidden outside tables');
});

// =====================================================================
// Top bar, inserting, tables (package A)
// =====================================================================
// Tag names as markup spells them. Lowercase table, figure, section and aside are also plain English words the UI uses
// ("Add a table"), so only their uppercase tag form (TABLE …) counts.
const TAGNAME = /\b(div|span|p|h[1-6]|li|ul|ol|thead|tbody|td|th|tr|img|svg|figcaption|blockquote|DIV|SPAN|P|H[1-6]|LI|UL|OL|TABLE|THEAD|TBODY|TD|TH|TR|IMG|SVG|FIGURE|FIGCAPTION|SECTION|BLOCKQUOTE|ASIDE)\b/;
const cellTexts = () => `[...document.querySelector('main.deck > .slide.dk-current table').rows].map(r => [...r.cells].map(c => c.textContent))`;
const BARE_CELLS = FIXTURE.replace(/  \.slide table \{[^}]*\}\n  \.slide th, \.slide td \{[^}]*\}\n  \.slide th \{[^}]*\}\n/, '');
const FULL = FIXTURE.replace('\n</main>', `
  <section class="slide">
    <div class="cover" style="position:absolute; left:0; top:0; width:1920px; height:1080px"></div>
  </section>
  <section class="slide">
    <ul>${Array.from({ length: 11 }, (_, i) => `<li>항목 ${i + 1}</li>`).join('')}</ul>
  </section>
\n</main>`);

test('every top-bar button acts once per click (undo, help, save)', async ({ page, h }) => {
  await h.go(1); await h.edit();
  for (let i = 0; i < 3; i++) await h.tb('[data-act="shape"]');
  const hi0 = (await h.state()).hi;
  await h.tb('[data-act="undo"]');
  eq((await h.state()).hi, hi0 - 1, 'one click on ↶ undoes exactly one step');
  await h.tb('[data-act="help"]');
  eq((await h.shadow('.help')).display, 'flex', 'one click on ? opens the help');
  await page.keyboard.press('Escape');
  await h.tb('[data-act="save"]');
  await h.settle(500);
  eq(await page.evaluate(() => [window.__pickerCalls, window.__writes]), [1, 1], 'one click on 저장 saves once');
}, { http: true });

test('dragging on the slide background never selects page text', async ({ page, h }) => {
  await h.go(1); await h.edit();
  const b = await page.locator('main.deck > .slide.dk-current').boundingBox();
  await h.drag({ x: b.x + 10, y: b.y + 10 }, { x: b.x + b.width - 10, y: b.y + b.height - 10 }, 12);
  expect(await page.evaluate(() => getSelection().isCollapsed || getSelection().rangeCount === 0), 'no native selection');
  await h.clickText(h.cur('h2'));
  await page.keyboard.type('!');
  eq(await h.cur('h2').textContent(), '슬라이드 제목!', 'text editing still works');
});

test('top bar fits: labels at 1280px, icons only at 1000px', async ({ page, h }) => {
  await h.edit();
  const measure = () => page.locator('#dk-chrome').evaluate(host => {
    const b = host.shadowRoot.querySelector('.bar');
    return { over: b.scrollWidth - b.clientWidth, labels: [...b.querySelectorAll('.lb')].map(l => l.offsetWidth > 0) };
  });
  let m = await measure();
  expect(m.over <= 0, 'no overflow at 1280: ' + m.over);
  expect(m.labels.length >= 7 && m.labels.every(Boolean), 'every insert label visible at 1280');
  await page.setViewportSize({ width: 1000, height: 800 });
  await h.settle(100);
  m = await measure();
  expect(m.over <= 0, 'no overflow at 1000: ' + m.over);
  expect(m.labels.every(v => !v), 'labels hidden at 1000');
  eq((await h.shadow('[data-act="save"]')).text, 'Save', 'Save keeps its label');
}, { viewport: { width: 1280, height: 800 } });

test('each insert button adds its element with a single click', async ({ page, h }) => {
  await h.go(1); await h.edit();
  await h.menu('slide', 'blank');
  page.__dialog = d => d.accept('x^2');
  const steps = [['text', () => h.tb('[data-act="text"]')], ['title', () => h.menu('text', 'title')], ['list', () => h.menu('text', 'list')],
    ['table', () => h.tb('[data-act="table"]')], ['table 2×5', () => h.menu('table', '2×5')], ['shape', () => h.tb('[data-act="shape"]')],
    ['circle', () => h.menu('shape', 'circle')], ['arrow', () => h.tb('[data-act="arrow"]')], ['math', () => h.tb('[data-act="math"]')]];
  for (const [name, run] of steps) {
    const n = await h.children();
    await run();
    eq(await h.children(), n + 1, name + ': one element per click');
  }
  const s = (await h.state()).slides;
  await h.tb('[data-act="slide-new"]');
  eq((await h.state()).slides, s + 1, '새 슬라이드: one slide per click');
  eq(await h.active(), 'H2:true', 'editing the new slide title');
});

test('no control or menu shows a tag name', async ({ page, h }) => {
  await h.go(4); await h.edit();
  const scan = () => page.locator('#dk-chrome').evaluate((host, re) => {
    const rx = new RegExp(re);
    return [...host.shadowRoot.querySelectorAll('button')].map(b => (b.textContent + ' | ' + (b.title || '')).trim()).filter(t => rx.test(t));
  }, TAGNAME.source);
  eq(await scan(), [], 'buttons');
  for (const m of ['slide', 'text', 'table', 'shape']) { await h.tb(`[data-menu="${m}"]`); eq(await scan(), [], m + ' menu'); await page.keyboard.press('Escape'); }
  await h.clickText(h.cur('td'));
  for (const m of ['size', 'align', 'more', 'row', 'col']) { await h.tb(`[data-menu="${m}"]`); eq(await scan(), [], m + ' menu'); await h.tb(`[data-menu="${m}"]`); }
});

test('the ＋ New slide row under the thumbnails adds a slide at the end', async ({ page, h }) => {
  await h.edit();
  await page.locator('#dk-sidebar .dk-add-slide').click();
  const s = await h.state();
  eq([s.slides, s.cur], [6, 5], 'appended and shown');
  eq(await page.locator('#dk-sidebar .dk-thumb').count(), 6, 'thumbnail added');
  expect((await h.deck()).trimEnd().endsWith('<h2>Title</h2>\n    <ul>\n      <li>Content</li>\n    </ul>\n  </section>'), 'title + list slide at the end');
});

test('free objects land in free spots: text box, shape and arrow never overlap', async ({ page, h }) => {
  await h.go(1); await h.edit();
  await h.menu('slide', 'blank');
  await h.tb('[data-act="text"]');
  await h.tb('[data-act="shape"]');
  await h.tb('[data-act="arrow"]');
  const rects = await page.evaluate(() => [...document.querySelector('main.deck > .slide.dk-current').children].map(e => {
    const r = e.getBoundingClientRect(); return { l: r.left, t: r.top, r: r.right, b: r.bottom, abs: getComputedStyle(e).position === 'absolute' };
  }));
  eq(rects.length, 3, 'three objects');
  expect(rects.every(r => r.abs), 'all absolute');
  for (let i = 0; i < 3; i++) for (let j = i + 1; j < 3; j++) {
    const a = rects[i], b = rects[j];
    expect(a.r <= b.l || b.r <= a.l || a.b <= b.t || b.b <= a.t, `objects ${i} and ${j} overlap: ${JSON.stringify([a, b])}`);
  }
  const slide = await page.locator('main.deck > .slide.dk-current').boundingBox();
  expect(rects.every(r => r.l >= slide.x && r.r <= slide.x + slide.width && r.t >= slide.y && r.b <= slide.y + slide.height), 'all inside the slide');
});

test('on a full slide, repeated text boxes step 40px instead of stacking', async ({ page, h }) => {
  await h.go(5); await h.edit();
  await h.tb('[data-act="text"]');
  await h.tb('[data-act="text"]');
  const pos = await page.evaluate(() => [...document.querySelectorAll('main.deck > .slide.dk-current p')].map(p => [parseFloat(p.style.left), parseFloat(p.style.top)]));
  eq(pos.length, 2, 'two boxes');
  expect(pos[1][0] - pos[0][0] >= 40 && pos[1][1] - pos[0][1] >= 40, 'offset: ' + JSON.stringify(pos));
}, { fixture: FULL });

test('title and list float in a free spot (with a toast) when the slide has no room', async ({ page, h }) => {
  await h.go(6); await h.edit();
  await h.menu('text', 'title');
  expect((await h.shadow('.toast')).text.includes('free spot'), 'toast explains');
  await h.menu('text', 'list');
  const d = await h.deck();
  expect(/<h2 style="position: absolute; left: \d+px; top: \d+px; max-width: 1200px; margin: 0px;">Title<\/h2>/.test(d), 'title absolute');
  expect(/<ul style="position: absolute; [^"]*">\s*<li>Item<\/li>\s*<\/ul>/.test(d), 'list absolute');
  eq(await page.evaluate(() => document.querySelector('main.deck > .slide.dk-current ul').children.length), 11, 'original list untouched');
}, { fixture: FULL });

test('table: 표 inserts 3×3 with a header row, empty cells, caret in the first header cell', async ({ page, h }) => {
  await h.go(1); await h.edit();
  await h.tb('[data-act="table"]');
  const t = await page.evaluate(() => {
    const t = document.querySelector('main.deck > .slide.dk-current table');
    return { head: t.tHead && t.tHead.rows[0].cells.length, ths: [...t.tHead.rows[0].cells].map(c => c.tagName), body: [...t.tBodies[0].rows].map(r => [...r.cells].map(c => c.tagName + ':' + c.textContent)), style: t.getAttribute('style') };
  });
  eq(t.head, 3, 'thead with 3 cells');
  eq(t.ths, ['TH', 'TH', 'TH'], 'header cells');
  eq(t.body, [['TD:', 'TD:', 'TD:'], ['TD:', 'TD:', 'TD:']], 'two empty body rows');
  expect(!/table-layout/.test(t.style) && /width: 100%/.test(t.style), 'columns sized by their text, full width: ' + t.style);
  eq(await h.active(), 'TH:true', 'editing the first header cell');
  eq(await page.evaluate(() => document.activeElement === document.querySelector('main.deck > .slide.dk-current th')), true, 'first th focused');
  eq((await h.state()).selected, 'Table', 'the table is the selection');
  const mark = await h.rect('.cellmark'), th = await h.cur('th').boundingBox();
  expect(Math.abs(mark.x - th.x) < 2 && Math.abs(mark.width - th.width) < 2, 'active cell marked');
});

test('table: the grid picker inserts the hovered size; header can be turned off', async ({ page, h }) => {
  await h.go(1); await h.edit();
  await h.tb('[data-menu="table"]');
  const c = await h.handle('.menu [data-val="3×4"]');
  await page.mouse.move(c.x, c.y);
  eq((await h.shadow('.menu .tsize')).text, '3 × 4 table', 'size shown while hovering');
  eq(await page.locator('#dk-chrome').evaluate(h => h.shadowRoot.querySelectorAll('.tgrid .hl').length), 12, 'range highlighted');
  await page.mouse.click(c.x, c.y);
  await h.settle(100);
  eq(await page.evaluate(() => [...document.querySelector('main.deck > .slide.dk-current table').rows].map(r => r.cells.length)), [4, 4, 4], '3 rows × 4 columns');
  await page.keyboard.press('Escape'); await page.keyboard.press('Escape');
  await h.tb('[data-menu="table"]');
  await h.tb('.menu [data-toggle="thead"]');
  await h.tb('.menu [data-val="2×2"]');
  const t = await page.evaluate(() => { const t = document.querySelectorAll('main.deck > .slide.dk-current table')[1]; return [!!t.tHead, t.querySelectorAll('th').length, t.querySelectorAll('td').length]; });
  eq(t, [false, 0, 4], 'no header row');
});

test('table: decks without cell styles get visible lines; styled decks get none', async ({ page, h }) => {
  await h.go(1); await h.edit();
  await h.tb('[data-act="table"]');
  const bw = () => page.evaluate(() => [...document.querySelectorAll('main.deck > .slide.dk-current table:last-of-type :is(td,th)')].map(c => parseFloat(getComputedStyle(c).borderTopWidth)));
  expect((await bw()).every(w => w > 0), 'borders visible');
  await h.pick('col', '[data-val="col-right"]');
  await h.pick('col', '[data-val="col-right"]');
  const widths = await page.evaluate(() => [...document.querySelectorAll('main.deck > .slide.dk-current table td, main.deck > .slide.dk-current table th')].map(c => c.getBoundingClientRect().width));
  expect(widths.length === 15 && widths.every(w => w > 20), 'cells stay wide: ' + widths.map(Math.round));
  const d = await h.deck();
  const th = d.match(/<th[ >][^>]*>/)[0], td = d.match(/<td[ >][^>]*>/)[0];
  expect(/border: 1px solid color-mix\(in srgb, currentcolor 30%, transparent( 70%)?\)/.test(td) && /padding: 0\.35em 0\.7em/.test(td), 'cell fallback style: ' + td);
  expect(/background: color-mix\(in srgb, currentcolor 8%, transparent( 92%)?\)/.test(th) && /text-align: left/.test(th), 'header fallback style: ' + th);
}, { fixture: BARE_CELLS });

test('table: dark deck without cell styles gets lines that follow the text color', async ({ page, h }) => {
  await h.go(1); await h.edit();
  await h.tb('[data-act="table"]');
  const c = await page.evaluate(() => { const td = document.querySelector('main.deck > .slide.dk-current td'); const cs = getComputedStyle(td); return [parseFloat(cs.borderTopWidth), cs.borderTopColor]; });
  expect(c[0] > 0, 'border visible');
  expect(/238, 238, 238|0\.93/.test(c[1]) || c[1].includes('color(srgb 0.93'), 'border derived from light text: ' + c[1]);
}, { fixture: BARE_CELLS.replace('</style>', '  .slide { background:#111 !important; color:#eee !important; }\n</style>') });

test('table: on a deck that styles cells, no fallback style is written', async ({ page, h }) => {
  await h.go(1); await h.edit();
  await h.tb('[data-act="table"]');
  await h.pick('row', '[data-val="row-below"]');
  const d = await h.deck();
  expect(!d.includes('color-mix') && !/<t[dh] style/.test(d), 'plain cells');
});

test('table: grip moves the whole table while a cell is edited; Esc selects the table in one press', async ({ page, h }) => {
  await h.go(4); await h.edit();
  await h.clickText(h.cur('td'));
  const sel = await h.rect('.sel'), tb = await h.cur('table').boundingBox();
  expect(Math.abs(sel.width - tb.width) < 2 && Math.abs(sel.height - tb.height) < 2, 'selection box is on the table');
  const g = await h.handle('.grip');
  await h.drag(g, { x: g.x + 40, y: g.y + 20 });
  const d = await h.deck();
  expect(/<table style="translate: \d+px \d+px;">/.test(d), 'table moved: ' + d.match(/<table[^>]*>/)[0]);
  expect(!/<t[dhr][^>]*translate/.test(d), 'no cell or row moved');
  eq(await h.active(), 'TD:true', 'still editing the cell');
  await page.keyboard.press('Escape');
  expect((await h.shadow('.tag')).text.startsWith('Table · 2 rows × 2 cols'), 'chip names the table and its size: ' + (await h.shadow('.tag')).text);
  expect((await h.path()).endsWith('table'), 'path ends with table');
  await page.keyboard.press('Enter');
  eq(await h.active(), 'TH:true', 'Enter edits the first cell');
  await page.keyboard.press('Escape');
  await page.keyboard.press('Delete');
  eq(await page.locator('main.deck > .slide.dk-current table').count(), 0, 'Delete removes the selected table');
});

test('table: Tab / Shift+Tab move between cells; Tab in the last cell adds a row; ↑↓ move by row', async ({ page, h }) => {
  await h.go(1); await h.edit();
  await h.tb('[data-act="table"]');
  await page.keyboard.type('모델');
  await page.keyboard.press('Tab');
  await page.keyboard.type('정확도');
  let cells = await page.evaluate(cellTexts());
  eq(cells[0], ['모델', '정확도', ''], 'typed into two cells');
  await page.keyboard.press('Shift+Tab');
  eq(await page.evaluate(() => [document.activeElement.textContent, getSelection().toString()]), ['모델', '모델'], 'back in the first cell, contents selected');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.type('a');
  await page.keyboard.press('ArrowUp');
  await page.keyboard.type('!');
  cells = await page.evaluate(cellTexts());
  eq([cells[0][0], cells[1][0]], ['모델!', 'a'], '↓ goes to the cell below, ↑ back up to the end of the text');
  for (let i = 0; i < 8; i++) await page.keyboard.press('Tab');
  eq(await page.evaluate(() => document.activeElement.parentElement.rowIndex), 2, 'in the last row');
  await page.keyboard.press('Tab');
  cells = await page.evaluate(cellTexts());
  eq(cells.length, 4, 'Tab in the last cell added a row');
  eq(await page.evaluate(() => [document.activeElement.parentElement.rowIndex, document.activeElement.cellIndex]), [3, 0], 'caret in its first cell');
  await page.keyboard.press('Escape');
  const d = await h.deck();
  expect(/<tr><td><\/td><td><\/td><td><\/td><\/tr>\s*<\/tbody>/.test(d) && !d.includes('<br>'), 'empty cells save as <td></td>');
});

test('table: Korean syllable still composing, then Tab → syllable kept once, next cell', async ({ page, h }) => {
  await h.go(1); await h.edit();
  await h.tb('[data-act="table"]');
  await h.ime('정', { leaveComposing: true });
  // macOS Chrome: keydown 229 while composing, the IME commits, then the real Tab arrives.
  await h.cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 229 });
  await h.cdp.send('Input.insertText', { text: '정' });
  await h.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 229 });
  await page.keyboard.press('Tab');
  await h.settle(200);
  eq((await page.evaluate(cellTexts()))[0], ['정', '', ''], 'syllable once');
  eq(await page.evaluate(() => document.activeElement.cellIndex), 1, 'moved exactly one cell');
  await h.ime('확');
  eq((await page.evaluate(cellTexts()))[0], ['정', '확', ''], 'typing continues in the next cell');
});

test('table: pasting tab-separated text fills cells; with nothing selected it makes a new table', async ({ page, h }) => {
  await h.go(4); await h.edit();
  await h.clickText(h.cur('td'));
  const paste = (text, html) => page.evaluate(([text, html]) => {
    const dt = new DataTransfer();
    dt.setData('text/plain', text);
    if (html) dt.setData('text/html', html);
    (document.activeElement || document).dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  }, [text, html]);
  await paste('ResNet\t76.1\nViT\t81.3');
  eq(await page.evaluate(cellTexts()), [['모델', '정확도'], ['ResNet', '76.1'], ['ViT', '81.3']], 'filled 2×2, grew a row');
  expect((await h.shadow('.toast')).text.includes('Pasted 2 × 2 cells'), 'toast');
  await page.keyboard.press('Meta+z');
  eq(await page.evaluate(cellTexts()), [['모델', '정확도'], ['A', '91.2']], 'one undo step');
  await page.keyboard.press('Escape'); await page.keyboard.press('Escape');
  eq((await h.state()).selected, null, 'nothing selected');
  await paste('x', '<table><tr><td>방법</td><td>점수</td></tr><tr><td>우리 것</td><td>99</td></tr></table>');
  const t = await page.evaluate(() => { const ts = document.querySelectorAll('main.deck > .slide.dk-current table'); const t = ts[ts.length - 1]; return [ts.length, [...t.rows].map(r => [...r.cells].map(c => c.tagName + ':' + c.textContent))]; });
  eq(t, [2, [['TH:방법', 'TH:점수'], ['TD:우리 것', 'TD:99']]], 'new table from a spreadsheet paste');
  await page.keyboard.press('Escape'); await page.keyboard.press('Escape');
  await paste('| 모델 | 점수 |\n|---|---:|\n| A | 1 |');
  await page.keyboard.press('Escape'); await page.keyboard.press('Escape');
  await paste('이름,값\n"x, y",2\n');
  const more = await page.evaluate(() => [...document.querySelectorAll('main.deck > .slide.dk-current table')].slice(2).map(t => [...t.rows].map(r => [...r.cells].map(c => c.textContent))));
  eq(more, [[['모델', '점수'], ['A', '1']], [['이름', '값'], ['x, y', '2']]], 'markdown and CSV tables');
  await h.clickText(h.cur('h2'));
  await paste('a\tb');
  eq(await h.cur('h2').textContent(), '표와 이미지a\tb', 'outside tables, paste stays plain text');
});

test('table: rows and columns go where asked and copy the neighbour\'s style', async ({ page, h }) => {
  await h.go(4); await h.edit();
  await page.evaluate(() => { const td = document.querySelector('main.deck > .slide.dk-current td'); td.style.color = 'red'; });
  await h.clickText(h.cur('td'));
  await h.pick('row', '[data-val="row-above"]');
  await page.keyboard.type('위');
  await h.pick('col', '[data-val="col-left"]');
  await page.keyboard.type('왼');
  const rows = await page.evaluate(() => [...document.querySelector('main.deck > .slide.dk-current table').rows].map(r => [...r.cells].map(c => c.tagName + (c.getAttribute('style') ? '[' + c.getAttribute('style') + ']' : '') + ':' + c.textContent)));
  eq(rows, [
    ['TH:', 'TH:모델', 'TH:정확도'],
    ['TD[color: red;]:왼', 'TD[color: red;]:위', 'TD:'],
    ['TD[color: red;]:', 'TD[color: red;]:A', 'TD:91.2'],
  ], 'new row above the body row, new column on the left, styles copied');
});

test('cell toolbar at 1280×800: compact, inside the window, never on the table', async ({ page, h }) => {
  await h.go(1); await h.edit();
  await h.tb('[data-act="table"]');
  const fmt = await h.rect('.fmt'), t = await h.cur('table').boundingBox();
  expect(fmt.x >= 216 && fmt.right <= 1280 && fmt.y >= 52 && fmt.bottom <= 800, 'inside the editor area: ' + JSON.stringify(fmt));
  expect(fmt.width <= 600, 'at most 600px wide: ' + fmt.width);
  expect(fmt.bottom <= t.y || fmt.y >= t.y + t.height, 'not on the table');
  eq((await h.shadow('.fmt .block')).display, 'none', 'no paragraph menu in a cell');
  eq((await h.shadow('.fmt .g-list')).display, 'none', 'no list menu in a cell');
}, { viewport: { width: 1280, height: 800 } });

test('text toolbar labels are plain names; the paragraph menu hides where it cannot apply', async ({ page, h }) => {
  const seen = [];
  const check = async (i, sel) => {
    await h.go(i);
    await h.clickText(h.cur(sel));
    const lbl = await h.shadow('.fmt .block .lbl'), dd = await h.shadow('.fmt .block');
    const tag = await h.cur(sel).evaluate(e => e.tagName.toLowerCase());
    expect(lbl.text !== tag && !TAGNAME.test(lbl.text), `${sel}: label "${lbl.text}"`);
    seen.push([sel, dd.display === 'none' ? '-' : lbl.text]);
    await page.keyboard.press('Escape');
  };
  await h.edit();
  await check(0, 'h1'); await check(0, '.sub'); await check(1, 'li'); await check(2, 'figcaption'); await check(4, 'td'); await check(4, 'th');
  eq(seen, [['h1', 'Title 1'], ['.sub', 'Body'], ['li', '-'], ['figcaption', '-'], ['td', '-'], ['th', '-']], 'labels');
});

test('object toolbar shows only what applies; right and bottom handles resize one way', async ({ page, h }) => {
  await h.go(1); await h.edit();
  const vis = sel => h.shadow(sel).then(x => x && x.display !== 'none');
  await h.tb('[data-act="shape"]');
  expect(await vis('.otb .g-more') && await vis('.otb .g-fill'), 'shape: color and ⋯');
  const shape = h.cur('div.shape');
  const b0 = await shape.boundingBox();
  let r = await h.handle('.rw');
  await h.drag(r, { x: r.x + 60, y: r.y + 40 });
  const b1 = await shape.boundingBox();
  expect(b1.width > b0.width + 30 && Math.abs(b1.height - b0.height) < 1, 'right handle: width only');
  r = await h.handle('.rh');
  await h.drag(r, { x: r.x + 40, y: r.y + 30 });
  const b2 = await shape.boundingBox();
  expect(b2.height > b1.height + 15 && Math.abs(b2.width - b1.width) < 1, 'bottom handle: height only');
  await page.keyboard.press('Escape'); await page.keyboard.press('Escape');
  await h.clickText(h.cur('li'));
  await page.keyboard.press('Escape');
  eq((await h.state()).selected, 'List', 'one Esc from a bullet selects the list');
  expect(!(await vis('.otb .g-more')) && !(await vis('.otb .g-fill')), 'list: no rotate, order or color');
  expect(await vis('.otb [data-obj="dup"]') && await vis('.otb [data-obj="del"]'), 'list: duplicate and delete');
  await h.go(4);
  await h.clickText(h.cur('td'));
  await page.keyboard.press('Escape');
  expect(!(await vis('.otb .g-more')), 'table: no rotate or order');
  await page.mouse.click(...Object.values(await h.center(h.cur('img.pic'))));
  expect(await vis('.otb .g-img') && await vis('.otb .g-more'), 'image: replace and ⋯');
  eq((await h.shadow('.sel .rw')).display, 'none', 'images keep their aspect ratio: no edge handles');
  await h.go(3);
  await page.mouse.click(...Object.values(await h.center(h.cur('div.math'))));
  expect(await vis('.otb .g-tex') && !(await vis('.otb .g-more')), 'formula: 수식 편집, no rotate');
  await h.tb('[data-obj="tex"]');
  expect((await h.cur('div.math').textContent()).includes('\\mathcal{L}'), '수식 편집 shows the TeX');
});

test('status pill: 저장 안 한 변경 after an edit, 저장됨 after saving', async ({ page, h }) => {
  await h.edit();
  expect((await h.shadow('.status')).text.includes('Folder not connected') && !(await h.shadow('.status')).cls.includes('warn'), 'not connected, calm while clean');
  await page.evaluate(async () => deckEdit._connect(await showDirectoryPicker()));
  await h.settle(200);
  expect((await h.shadow('.status')).text.includes('Saved'), 'clean: ' + (await h.shadow('.status')).text);
  eq((await h.state()).count, 0, 'state.count with nothing selected');
  await h.clickText(h.cur('h1'));
  eq([(await h.state()).count, (await h.state()).selection], [1, ['Title']], 'state.selection while editing');
  await page.keyboard.type('!');
  expect((await h.shadow('.status')).text.includes('Unsaved changes'), 'dirty: ' + (await h.shadow('.status')).text);
  eq((await h.shadow('[data-act="save"]')).text, 'Save', 'button label stays Save');
  await h.save();
  expect((await h.shadow('.status')).text.includes('Saved'), 'saved: ' + (await h.shadow('.status')).text);
}, { http: true });


// =====================================================================
// Resizing in proportion
// =====================================================================
const fontOf = (d, re) => { const m = d.match(re); return m ? +m[1] : null; };

test('formula: frame hugs the glyphs; corner drag scales it, with a live size badge; undo restores', async ({ page, h }) => {
  await h.go(3); await h.edit();
  const before = await h.deck();
  const m = h.cur('div.math');
  await page.mouse.click(...Object.values(await h.center(m)));
  await h.settle(100);
  const frame = await page.locator('#dk-chrome').evaluate(x => x.shadowRoot.querySelector('.sel').getBoundingClientRect().width);
  const divW = (await m.boundingBox()).width;
  expect(frame < divW * 0.8, `selection frame hugs the formula (${Math.round(frame)} < ${Math.round(divW)})`);
  eq((await h.shadow('.sel .edge.rw')).display, 'none', 'no width-only handle on a formula');
  const r = await h.handle('.sel .resize');
  await page.mouse.move(r.x, r.y); await page.mouse.down();
  await page.mouse.move(r.x + 120, r.y + 40, { steps: 6 });
  const badge = await h.shadow('.sizebadge');
  expect(badge.display === 'block' && /^Text \d+px$/.test(badge.text), 'badge while dragging: ' + badge.text);
  await page.mouse.up();
  const d = await h.deck();
  const fs = fontOf(d, /<div class="math display" style="font-size: (\d+)px;">/);
  expect(fs > 52, 'formula font grew from 52px: ' + fs);
  expect(d.includes('\\mathcal{L}(\\theta) = '), 'TeX kept');
  eq((await h.shadow('.sizebadge')).display, 'none', 'badge hidden after');
  await page.keyboard.press('Meta+z');
  eq(await h.deck(), before, 'one undo restores');
});

test('size stepper in the object toolbar: shows the size and steps by 10%', async ({ page, h }) => {
  await h.go(3); await h.edit();
  await page.mouse.click(...Object.values(await h.center(h.cur('div.math'))));
  eq((await h.shadow('.otb .szl')).text, '52', 'label shows the formula size');
  await h.tb('[data-obj="bigger"]');
  await h.tb('[data-obj="bigger"]');
  eq((await h.shadow('.otb .szl')).text, '63', 'two steps up');
  await h.tb('[data-obj="smaller"]');
  expect((await h.deck()).includes('<div class="math display" style="font-size: 57px;">'), 'saved size');
  await page.keyboard.press('Meta+Shift+Period');
  expect((await h.deck()).includes('font-size: 63px'), '⌘⇧. also scales a selected object');
});

test('text box: corner scales letters and width together; side handle changes width only', async ({ page, h }) => {
  await h.go(4); await h.edit();
  const box = h.cur('p.free');
  await h.clickText(box);
  await page.keyboard.press('Escape');
  expect((await h.state()).count === 1 && (await h.path()).includes('p.free'), 'text box selected: ' + (await h.path()));
  let r = await h.handle('.sel .rw');
  await h.drag(r, { x: r.x + 60, y: r.y });
  let st = await box.getAttribute('style');
  expect(!/font-size/.test(st) && /width: (\d+)px/.test(st) && +st.match(/width: (\d+)px/)[1] > 500, 'side handle: width only: ' + st);
  r = await h.handle('.sel .resize');
  await h.drag(r, { x: r.x + 80, y: r.y + 20 });
  st = await box.getAttribute('style');
  expect(/font-size: (\d+)px/.test(st) && +st.match(/font-size: (\d+)px/)[1] > 40, 'corner: letters grow: ' + st);
});

test('heading in flow: corner scales only its letters (no width written)', async ({ page, h }) => {
  await h.go(1); await h.edit();
  await h.clickText(h.cur('h2'));
  await page.keyboard.press('Escape');
  const r = await h.handle('.sel .resize');
  await h.drag(r, { x: r.x + 60, y: r.y + 10 });
  const tag = (await h.deck()).match(/<h2[^>]*>/)[0];
  expect(/^<h2 style="font-size: \d+px;">$/.test(tag) && +tag.match(/(\d+)px/)[1] > 64, 'font only: ' + tag);
});

test('shape: corner stretches freely; with Shift it keeps its proportions', async ({ page, h }) => {
  await h.go(1); await h.edit();
  await h.tb('[data-act="shape"]');
  const shape = h.cur('div.shape');
  const b0 = await shape.boundingBox();
  const r = await h.handle('.sel .resize');
  await page.keyboard.down('Shift');
  await h.drag(r, { x: r.x + 90, y: r.y + 10 });
  await page.keyboard.up('Shift');
  const b1 = await shape.boundingBox();
  expect(Math.abs(b1.width / b1.height - b0.width / b0.height) < 0.03, `ratio kept ${(b0.width / b0.height).toFixed(2)} → ${(b1.width / b1.height).toFixed(2)}`);
  expect(b1.width > b0.width * 1.1, 'grew');
});

test('group: the group corner scales every member by the same ratio and keeps the layout', async ({ page, h }) => {
  await h.go(3); await h.edit();
  await page.mouse.click(...Object.values(await h.center(h.cur('div.math'))));
  await page.keyboard.down('Shift');
  await h.clickText(h.cur('h2'));
  await page.keyboard.up('Shift');
  eq((await h.state()).count, 2, 'two selected');
  const gap0 = await page.evaluate(() => { const s = document.querySelector('main.deck > .slide.dk-current'); return s.querySelector('div.math .katex').getBoundingClientRect().top - s.querySelector('h2').getBoundingClientRect().top; });
  const r = await h.handle('.gres');
  await page.mouse.move(r.x, r.y); await page.mouse.down();
  await page.mouse.move(r.x + 100, r.y + 60, { steps: 6 });
  expect(/^\d+%$/.test((await h.shadow('.sizebadge')).text), 'percent badge');
  await page.mouse.up();
  const d = await h.deck();
  const fh = fontOf(d, /<h2 style="[^"]*font-size: (\d+)px/), fm = fontOf(d, /<div class="math display" style="[^"]*font-size: (\d+)px/);
  expect(fh && fm, 'both scaled: ' + fh + ' / ' + fm);
  expect(Math.abs(fh / 64 - fm / 52) < 0.04, `same ratio (${(fh / 64).toFixed(2)} vs ${(fm / 52).toFixed(2)})`);
  const gap1 = await page.evaluate(() => { const s = document.querySelector('main.deck > .slide.dk-current'); return s.querySelector('div.math .katex').getBoundingClientRect().top - s.querySelector('h2').getBoundingClientRect().top; });
  expect(Math.abs(gap1 / gap0 - fh / 64) < 0.08, `spacing scaled too (${(gap1 / gap0).toFixed(2)})`);
  await page.keyboard.press('Meta+z');
  expect(!(await h.deck()).includes('font-size'), 'one undo step');
});

test('figure group: corner scales the picture and its caption together', async ({ page, h }) => {
  await h.go(2); await h.edit();
  await page.mouse.click(...Object.values(await h.center(h.cur('svg'))));
  await h.tb('.tag button');
  eq((await h.state()).selected, 'Figure group', 'figure selected');
  const svgW0 = (await h.cur('figure svg').boundingBox()).width;
  const r = await h.handle('.sel .resize');
  await h.drag(r, { x: r.x - 120, y: r.y - 60 });
  const d = await h.deck();
  expect(/<figcaption style="font-size: \d+px;">/.test(d) && +d.match(/<figcaption style="font-size: (\d+)px;">/)[1] < 28, 'caption shrank: ' + d.match(/<figcaption[^>]*>/)[0]);
  expect((await h.cur('figure svg').boundingBox()).width < svgW0 * 0.95, 'picture shrank');
});

test('corner-resizing a text box never pushes it past the slide edge, and the slide never scrolls sideways', async ({ page, h }) => {
  await h.go(1); await h.edit();
  await h.tb('[data-act="text"]');
  await page.keyboard.type('short text');
  await page.keyboard.press('Escape');
  await h.settle(150);
  const r = await h.handle('.sel .resize');
  await h.drag(r, { x: r.x + 60, y: r.y + 20 });
  const box = page.locator('main.deck > .slide.dk-current p').last();
  await h.clickText(box);
  await page.keyboard.press('End');
  await page.keyboard.type(' 아주 긴 문장을 계속 써서 상자가 슬라이드 오른쪽 끝을 넘어가는지 확인합니다 그리고 조금 더 씁니다');
  await h.settle(200);
  const m = await page.evaluate(() => {
    const s = document.querySelector('main.deck > .slide.dk-current'), k = s.getBoundingClientRect().width / 1920;
    const b = [...s.querySelectorAll('p')].pop().getBoundingClientRect();
    return { right: (b.right - s.getBoundingClientRect().left) / k, pad: parseFloat(getComputedStyle(s).paddingRight), sl: s.scrollLeft };
  });
  expect(m.right <= 1920 - m.pad + 2, `box right ${Math.round(m.right)} stays inside ${1920 - m.pad}`);
  eq(m.sl, 0, 'slide not scrolled sideways');
});

test('undo after a list was rebuilt twice puts the caret back in the same bullet', async ({ page, h }) => {
  await h.go(1); await h.edit();
  await h.clickText(page.locator('main.deck > .slide.dk-current li').nth(1));
  await page.keyboard.press('End');
  await page.keyboard.press('Tab');
  await page.keyboard.press('Shift+Tab');
  await h.settle(150);
  await page.keyboard.press('Meta+z');
  await h.settle(150);
  await page.keyboard.type('P');
  const lis = await page.evaluate(() => [...document.querySelectorAll('main.deck > .slide.dk-current li')].map(l => l.firstChild.textContent));
  expect(lis.includes('두 번째 요점P') && lis.includes('세 번째 요점'), 'typed at the end of bullet 2: ' + JSON.stringify(lis));
});

// =====================================================================
// Snapping and centring on the slide
// =====================================================================
const centers = (page, sel) => page.evaluate(sel => {
  const s = document.querySelector('main.deck > .slide.dk-current'), S = s.getBoundingClientRect(), k = S.width / 1920;
  const r = s.querySelector(sel).getBoundingClientRect();
  return { dx: ((r.left + r.right) / 2 - (S.left + S.right) / 2) / k, dy: ((r.top + r.bottom) / 2 - (S.top + S.bottom) / 2) / k, k };
}, sel);

test('moving a shape near the slide centre snaps onto it and shows the centre guide; ⌘ moves freely', async ({ page, h }) => {
  await h.go(1); await h.edit();
  await h.tb('[data-act="shape"]');
  const c0 = await centers(page, 'div.shape');
  const from = await h.center(h.cur('div.shape'));
  // Aim 4 screen px right of / below the exact centre.
  const to = { x: from.x - c0.dx * c0.k + 4, y: from.y - c0.dy * c0.k + 4 };
  await page.mouse.move(from.x, from.y); await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 8 });
  const gx = await h.shadow('.guide.gx'), gy = await h.shadow('.guide.gy');
  expect(gx.display === 'block' && gy.display === 'block' && gx.cls.includes('center') && !gx.text && !gy.text, 'both centre guides while dragging, with no label');
  await page.mouse.up();
  eq((await h.shadow('.guide.gx')).display, 'none', 'guides gone after drop');
  const c1 = await centers(page, 'div.shape');
  expect(Math.abs(c1.dx) <= 1 && Math.abs(c1.dy) <= 1, `snapped to the centre (${c1.dx.toFixed(1)}, ${c1.dy.toFixed(1)})`);
  // The same move with ⌘ held lands where the pointer goes.
  await page.keyboard.press('Meta+z');
  const f2 = await h.center(h.cur('div.shape'));
  await page.keyboard.down('Meta');
  await page.mouse.move(f2.x, f2.y); await page.mouse.down();
  await page.mouse.move(f2.x - c0.dx * c0.k + 4, f2.y - c0.dy * c0.k + 4, { steps: 8 });
  eq((await h.shadow('.guide.gx')).display, 'none', 'no guide with ⌘');
  await page.mouse.up();
  await page.keyboard.up('Meta');
  const c2 = await centers(page, 'div.shape');
  expect(Math.abs(c2.dx) > 2, `⌘ drag not snapped (${c2.dx.toFixed(1)})`);
});

test('moving a shape lines its edge up with another shape, with a short guide between them', async ({ page, h }) => {
  await h.go(1); await h.edit();
  await h.tb('[data-act="shape"]');
  // Off the slide's centre line, so the guide that appears belongs to the other shape.
  for (let i = 0; i < 15; i++) await page.keyboard.press('Shift+ArrowRight');
  await h.tb('[data-act="shape"]');
  const shapes = page.locator('main.deck > .slide.dk-current div.shape');
  const a = await shapes.nth(0).boundingBox(), b = await shapes.nth(1).boundingBox();
  // The second shape is selected right after it is inserted. Drag it so its left edge is 3 px right of the first one's left edge, well away from the slide centre.
  const from = { x: b.x + b.width / 2, y: b.y + b.height / 2 };
  await page.mouse.move(from.x, from.y); await page.mouse.down();
  await page.mouse.move(from.x + (a.x - b.x) + 3, from.y + 120, { steps: 8 });
  const g = await h.shadow('.guide.gx');
  expect(g.display === 'block' && !g.cls.includes('center'), 'object guide shown (not the slide centre)');
  await page.mouse.up();
  const a2 = await shapes.nth(0).boundingBox(), b2 = await shapes.nth(1).boundingBox();
  expect(Math.abs(a2.x - b2.x) < 1.5, `left edges line up (${a2.x.toFixed(1)} vs ${b2.x.toFixed(1)})`);
});

test('정렬 › 슬라이드 기준 centres one object, or a whole group as one piece', async ({ page, h }) => {
  await h.go(1); await h.edit();
  await h.tb('[data-act="shape"]');
  eq((await h.shadow('.otb .g-arrange')).display, 'flex', 'align button offered for a single object');
  await h.menu('arrange', 'slide-c');
  let c = await centers(page, 'div.shape');
  expect(Math.abs(c.dx) <= 1 && Math.abs(c.dy) <= 1, `centred (${c.dx.toFixed(1)}, ${c.dy.toFixed(1)})`);
  await page.keyboard.press('Meta+z');
  await h.tb('[data-act="shape"]');
  const shapes = page.locator('main.deck > .slide.dk-current div.shape');
  const gap = async () => { const a = await shapes.nth(0).boundingBox(), b = await shapes.nth(1).boundingBox(); return [b.x - a.x, b.y - a.y]; };
  await page.mouse.click(...Object.values(await h.center(shapes.nth(0))));
  await page.keyboard.down('Shift');
  await page.mouse.click(...Object.values(await h.center(shapes.nth(1))));
  await page.keyboard.up('Shift');
  const g0 = await gap();
  await h.menu('arrange', 'slide-h');
  const u = await page.evaluate(() => {
    const s = document.querySelector('main.deck > .slide.dk-current'), S = s.getBoundingClientRect();
    const rs = [...s.querySelectorAll('div.shape')].map(e => e.getBoundingClientRect());
    return ((Math.min(...rs.map(r => r.left)) + Math.max(...rs.map(r => r.right))) / 2 - (S.left + S.right) / 2) / (S.width / 1920);
  });
  expect(Math.abs(u) <= 1, `group centred horizontally (${u.toFixed(1)})`);
  const g1 = await gap();
  expect(Math.abs(g1[0] - g0[0]) < 1 && Math.abs(g1[1] - g0[1]) < 1, 'members keep their spacing');
});

// =====================================================================
// Saving, watching, images (http + folder backed by disk)
// =====================================================================
test('save writes the file; everything outside <main> stays byte-identical', async ({ page, h }) => {
  await h.edit();
  const before = h.disk();
  await h.save();
  eq(await page.evaluate(() => window.__pickerCalls), 1, 'asked for the folder once');
  eq(h.disk(), before, 'unchanged save is byte-identical');
  await h.clickText(h.cur('h1'));
  await page.keyboard.type(' 저장');
  await h.save();
  const after = h.disk();
  expect(after.includes('<h1>발표 제목 저장</h1>'), 'edit saved');
  // The template's placeholder <title> becomes the first slide's title; nothing else outside <main> changes.
  eq(after.slice(0, after.indexOf('<main')), before.slice(0, before.indexOf('<main')).replace('<title>발표 제목</title>', '<title>발표 제목 저장</title>'), 'head identical but the title');
  eq(after.slice(after.indexOf('</main>')), before.slice(before.indexOf('</main>')), 'tail identical');
  eq((await h.state()).dirty, false, 'clean after save');
  expect((await h.shadow('.status')).text.includes('Saved'), 'status says saved');
  await page.keyboard.press('Meta+s');
  eq(await page.evaluate(() => window.__pickerCalls), 1, 'second save does not ask again');
}, { http: true });

test('AI edits the file while clean → shown in place, same slide and mode', async ({ page, h }) => {
  await h.go(2); await h.edit();
  await h.save();
  h.writeDisk(h.disk().replace('텍스트와 그림', 'AI가 바꾼 제목').replace('--accent: #2f5bea', '--accent: #e11d48'));
  await page.waitForFunction(() => document.querySelector('main.deck > .slide.dk-current h2')?.textContent === 'AI가 바꾼 제목', null, { timeout: 5000 });
  await page.waitForFunction(() => window.deckEdit && deckEdit.state.connected, null, { timeout: 5000 });
  const s = await h.state();
  eq([s.cur, s.mode, s.connected, s.dirty], [2, 'edit', true, false], 'kept slide and mode, still connected and clean');
}, { http: true });

test('saving right after the AI changed the same slide never overwrites it', async ({ page, h }) => {
  await h.edit();
  await h.save();
  await h.clickText(h.cur('h1'));
  await page.keyboard.type('!');
  h.writeDisk(h.disk().replace('한 줄 부제', '디스크 부제'));
  await h.save();
  expect(h.disk().includes('디스크 부제') && !h.disk().includes('발표 제목!'), 'disk untouched');
  eq((await h.shadow('.banner')).cls, 'banner show', 'asks which to keep');
}, { http: true });

test('AI edits another slide while I have unsaved edits → merged, both kept, saved without prompts', async ({ page, h }) => {
  await h.edit();
  await h.save();
  await h.clickText(h.cur('h1'));
  await page.keyboard.type(' 내 수정');
  await h.settle();
  h.writeDisk(h.disk().replace('<li>두 번째 요점</li>', '<li>AI가 고친 요점</li>').replace('--accent: #2f5bea', '--accent: #e11d48'));
  await page.waitForFunction(() => document.querySelector('#dk-chrome').shadowRoot.querySelector('.status').textContent.includes('AI edits applied'), null, { timeout: 4000 });
  eq((await h.shadow('.banner')).cls, 'banner', 'no banner for a clean merge');
  expect((await h.shadow('.toast')).text.includes('slide 2') && (await h.shadow('.toast')).text.includes('your edits are still here'), 'toast names the AI slide and says mine is kept');
  expect((await h.cur('h1').textContent()).includes('내 수정'), 'my edit still on screen');
  expect((await page.evaluate(() => document.querySelector('main.deck').innerHTML)).includes('AI가 고친 요점'), 'AI edit on screen');
  eq(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--accent').trim()), '#e11d48', 'AI style change applied live');
  let dialogs = 0;
  page.__dialog = d => { dialogs++; d.accept(); };
  await h.save();
  eq(dialogs, 0, 'no prompts');
  const disk = h.disk();
  expect(disk.includes('발표 제목 내 수정') && disk.includes('AI가 고친 요점') && disk.includes('--accent: #e11d48'), 'file has both edits and the AI style');
  eq((await h.state()).dirty, false, 'clean after save');
}, { http: true });

test('AI adds a slide while I edit another → the new slide lands in place', async ({ page, h }) => {
  await h.go(1); await h.edit();
  await h.save();
  await h.clickText(h.cur('h2'));
  await page.keyboard.type('+');
  await h.settle();
  h.writeDisk(h.disk().replace('  <section class="slide">\n    <h2>수식</h2>', '  <section class="slide">\n    <h2>AI 새 슬라이드</h2>\n  </section>\n\n  <section class="slide">\n    <h2>수식</h2>'));
  await page.waitForTimeout(2500);
  const titles = await page.evaluate(() => [...document.querySelectorAll('main.deck > .slide')].map(s => s.querySelector('h1,h2').textContent));
  eq(titles, ['발표 제목', '슬라이드 제목+', '텍스트와 그림', 'AI 새 슬라이드', '수식', '표와 이미지'], 'merged slide order');
  eq((await h.state()).cur, 1, 'still on my slide');
  await h.save();
  expect(h.disk().includes('<h2>AI 새 슬라이드</h2>') && h.disk().includes('<h2>슬라이드 제목+</h2>'), 'saved both');
}, { http: true });

test('AI and I edit the same slide → banner; "my version" then save keeps mine', async ({ page, h }) => {
  await h.edit();
  await h.save();
  await h.clickText(h.cur('h1'));
  await page.keyboard.type(' 내 수정');
  await h.settle();
  h.writeDisk(h.disk().replace('한 줄 부제', 'AI 부제'));
  await page.waitForTimeout(2500);
  eq((await h.shadow('.banner')).cls, 'banner show', 'banner visible');
  expect((await h.cur('h1').textContent()).includes('내 수정'), 'my edit still on screen');
  await h.save();
  expect(!h.disk().includes('내 수정'), 'save is blocked until a choice is made');
  await h.act('keep');
  let dialogs = 0;
  page.__dialog = d => { dialogs++; d.accept(); };
  await h.save();
  eq(dialogs, 0, 'no prompts after choosing');
  expect(h.disk().includes('발표 제목 내 수정') && h.disk().includes('한 줄 부제'), 'my version saved');
}, { http: true });

test('AI and I edit the same slide → "AI version" takes the AI\'s slide', async ({ page, h }) => {
  await h.edit();
  await h.save();
  await h.clickText(h.cur('h1'));
  await page.keyboard.type(' 내 수정');
  await h.settle();
  h.writeDisk(h.disk().replace('한 줄 부제', 'AI 부제'));
  await page.waitForTimeout(2500);
  await h.act('reload');
  await page.waitForFunction(() => document.querySelector('main.deck .sub')?.textContent === 'AI 부제');
  await page.waitForFunction(() => window.deckEdit);
  expect(!(await page.evaluate(() => document.querySelector('main.deck h1').textContent)).includes('내 수정'), 'mine discarded');
}, { http: true });

test('paste an image → saved under assets/ and inserted with a relative src', async ({ page, h }) => {
  await h.go(1); await h.edit();
  await h.save();
  await page.evaluate(async b64 => {
    const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
    const dt = new DataTransfer();
    dt.items.add(new File([bytes], 'screenshot.png', { type: 'image/png' }));
    document.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  }, PNG.toString('base64'));
  await h.settle(500);
  expect(/<img src="assets\/screenshot\.png" alt="" style="position: absolute;/.test(await h.deck()), 'img inserted');
  expect(fs.existsSync(path.join(h.dir, 'assets', 'screenshot.png')), 'file written');
  await page.evaluate(async b64 => {
    const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
    const dt = new DataTransfer();
    dt.items.add(new File([bytes], 'screenshot.png', { type: 'image/png' }));
    document.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  }, PNG.toString('base64'));
  await h.settle(500);
  expect(fs.existsSync(path.join(h.dir, 'assets', 'screenshot-2.png')), 'second paste does not overwrite');
}, { http: true });

test('drop an image onto an existing picture replaces it', async ({ page, h }) => {
  await h.go(4); await h.edit();
  await h.save();
  const c = await h.center(h.cur('img.pic'));
  await page.evaluate(async ({ b64, c }) => {
    const bytes = Uint8Array.from(atob(b64), ch => ch.charCodeAt(0));
    const dt = new DataTransfer();
    dt.items.add(new File([bytes], '새 그림.png', { type: 'image/png' }));
    const target = document.elementFromPoint(c.x, c.y);
    target.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, clientX: c.x, clientY: c.y, bubbles: true, cancelable: true }));
  }, { b64: PNG.toString('base64'), c });
  await h.settle(500);
  expect((await h.deck()).includes('<img class="pic" src="assets/새-그림.png"'), 'src replaced: ' + (await h.deck()).match(/<img class="pic"[^>]*>/)[0]);
}, { http: true });

test('pasting an image before connecting a folder explains what to do', async ({ page, h }) => {
  await h.edit();
  await page.evaluate(async b64 => {
    const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
    const dt = new DataTransfer();
    dt.items.add(new File([bytes], 'x.png', { type: 'image/png' }));
    document.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  }, PNG.toString('base64'));
  await h.settle(300);
  expect((await h.shadow('.toast')).text.includes('folder'), 'toast mentions folder');
  expect(!(await h.deck()).includes('<img src='), 'nothing inserted');
});

test('connecting after the AI changed the file shows the AI version', async ({ page, h }) => {
  await h.edit();
  h.writeDisk(h.disk().replace('한 줄 부제', 'AI가 연결 전에 고침'));
  await page.keyboard.press('Meta+s');
  await page.waitForFunction(() => document.querySelector('main.deck .sub')?.textContent === 'AI가 연결 전에 고침', null, { timeout: 5000 });
  await page.waitForFunction(() => window.deckEdit);
  expect(h.disk().includes('AI가 연결 전에 고침'), 'disk kept');
}, { http: true });

test('connecting after the AI changed another slide merges into my unsaved edits', async ({ page, h }) => {
  await h.edit();
  await h.clickText(h.cur('h1'));
  await page.keyboard.type(' 내 수정');
  await h.settle();
  h.writeDisk(h.disk().replace('<li>세 번째 요점</li>', '<li>AI 요점</li>'));
  await h.save();
  expect(h.disk().includes('<li>AI 요점</li>'), 'AI edit not lost');
  expect((await page.evaluate(() => document.querySelector('main.deck').innerHTML)).includes('AI 요점'), 'merged on screen');
  await h.save();
  expect(h.disk().includes('발표 제목 내 수정') && h.disk().includes('<li>AI 요점</li>'), 'both saved');
}, { http: true });

test('picking the wrong folder is refused', async ({ page, h }) => {
  await h.edit();
  await page.evaluate(() => { window.__fs.pickName = '다른-발표'; });
  const before = h.disk();
  await h.clickText(h.cur('h1')); await page.keyboard.type('x');
  await h.save();
  expect((await h.shadow('.toast')).text.includes('다른-발표'), 'toast names the wrong folder: ' + (await h.shadow('.toast')).text);
  eq((await h.state()).connected, false, 'not connected');
  eq(h.disk(), before, 'nothing written');
}, { http: true });

test('lost folder access is noticed and saving reconnects', async ({ page, h }) => {
  await h.edit();
  await h.save();
  await page.evaluate(() => { window.__fs.gone = true; });
  await page.waitForTimeout(1800);
  eq((await h.state()).connected, false, 'watcher noticed');
  expect((await h.shadow('.status')).text.includes('not connected'), 'status shows it');
  await page.evaluate(() => { window.__fs.gone = false; });
  await h.clickText(h.cur('h1')); await page.keyboard.type('!');
  await h.save();
  eq(await page.evaluate(() => window.__pickerCalls), 2, 'asked for the folder again');
  expect(h.disk().includes('<h1>발표 제목!</h1>'), 'saved after reconnecting');
}, { http: true });

test('after a browser restart, E asks for permission but never opens a picker by itself', async ({ page, h }) => {
  await page.keyboard.press('e');
  await h.save();
  await page.addInitScript(() => { window.__startPerm = 'denied'; });
  await page.reload();
  await page.waitForFunction(() => window.deckEdit && window.deckEdit.state.slides > 0);
  await page.waitForTimeout(300);
  eq((await h.state()).connected, false, 'not connected after restart');
  await page.evaluate(() => deckEdit.setMode('present'));
  await page.keyboard.press('e'); await h.settle(300);
  eq(await page.evaluate(() => window.__pickerCalls), 0, 'no picker on E');
}, { http: true });

test('⌘S while a Korean syllable is still composing saves (no browser Save dialog)', async ({ page, h }) => {
  await h.edit();
  await h.save();
  await h.clickText(h.cur('h1'));
  await h.ime('저장', { leaveComposing: true });
  await page.evaluate(() => { window.__kd = null; addEventListener('keydown', e => { window.__kd = e.defaultPrevented; }, { once: true }); });
  await h.cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 's', code: 'KeyS', windowsVirtualKeyCode: 229, modifiers: 4 });
  await h.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 's', code: 'KeyS', windowsVirtualKeyCode: 229, modifiers: 4 });
  await h.settle(500);
  eq(await page.evaluate(() => window.__kd), true, 'browser default prevented');
  expect(h.disk().includes('<h1>발표 제목저'), 'saved: ' + h.disk().match(/<h1>.*<\/h1>/)[0]);
}, { http: true });

test('Esc while composing Korean ends editing once the syllable commits', async ({ page, h }) => {
  await h.edit();
  await h.clickText(h.cur('h1'));
  await h.ime('끝', { leaveComposing: true });
  await h.cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 229 });
  await h.cdp.send('Input.insertText', { text: '끝' });
  await h.settle(100);
  eq(await h.active(), 'BODY:null', 'editing ended');
  eq(await h.cur('h1').textContent(), '발표 제목끝', 'syllable kept once');
});

test('without the folder API, saving downloads a copy and the deck stays marked unsaved', async ({ page, h }) => {
  await h.edit();
  await h.clickText(h.cur('h1')); await page.keyboard.type('!');
  const dl = page.waitForEvent('download');
  await page.keyboard.press('Meta+s');
  const d = await dl;
  eq(d.suggestedFilename(), 'deck.html', 'download name');
  await h.settle(500);
  eq((await h.state()).dirty, true, 'still unsaved');
  expect((await h.shadow('.status')).text.includes('Download'), 'status explains');
}, { init: 'delete window.showDirectoryPicker; window.showDirectoryPicker = undefined;' });

test('image button before connecting: a card explains, 폴더 선택 connects and opens the image picker', async ({ page, h }) => {
  await h.go(1); await h.edit();
  await h.tb('[data-act="image"]');
  eq(await page.evaluate(() => window.__pickerCalls), 0, 'no folder picker out of nowhere');
  const card = await h.shadow('.pop');
  eq(card.display, 'block', 'card shown');
  expect(card.text.includes('assets/') && card.text.includes('Choose folder'), 'card explains: ' + card.text);
  const tb = await h.rect('.bar [data-act="image"]'), pop = await h.rect('.pop');
  expect(pop.y >= tb.bottom && Math.abs(pop.x - tb.x) < 40, 'card sits under the button');
  await h.tb('.pop [data-pop="connect"]');
  await h.settle(400);
  eq(await page.evaluate(() => window.__pickerCalls), 1, 'folder picker shown once');
  eq((await h.state()).connected, true, 'connected');
  eq(await page.evaluate(() => window.__openCalls), 1, 'image picker opened right away');
  expect(/<img src="assets\/pick\.png"/.test(await h.deck()), 'picked image inserted');
  eq((await h.shadow('.pop')).display, 'none', 'card closed');
  expect(!/again/i.test((await h.shadow('.toast')).text), 'no "click again" wording');
}, { http: true, init: `window.__openCalls = 0; window.showOpenFilePicker = async () => { window.__openCalls++; const b = Uint8Array.from(atob('${PNG.toString('base64')}'), c => c.charCodeAt(0)); return [{ getFile: async () => new File([b], 'pick.png', { type: 'image/png' }) }]; };` });

test('image button: when the folder picker used up the click, the card offers 이미지 고르기', async ({ page, h }) => {
  await h.edit();
  await h.tb('[data-act="image"]');
  await h.tb('.pop [data-pop="connect"]');
  await h.settle(300);
  eq((await h.state()).connected, true, 'connected');
  const card = await h.shadow('.pop');
  expect(card.display === 'block' && card.text.includes('Connected') && card.text.includes('Choose image'), 'offers a fresh button: ' + card.text);
  await h.tb('.pop [data-pop="pick"]');
  await h.settle(300);
  eq(await page.evaluate(() => window.__openCalls), 2, 'second try opens the picker');
  expect(/<img src="assets\/pick\.png"/.test(await h.deck()), 'image inserted');
}, { http: true, init: `window.__openCalls = 0; window.showOpenFilePicker = async () => { if (++window.__openCalls === 1) throw new DOMException('no activation', 'SecurityError'); const b = Uint8Array.from(atob('${PNG.toString('base64')}'), c => c.charCodeAt(0)); return [{ getFile: async () => new File([b], 'pick.png', { type: 'image/png' }) }]; };` });

test('pasting a screenshot while the caret is in text inserts the image', async ({ page, h }) => {
  await h.go(1); await h.edit();
  await h.save();
  await h.clickText(h.cur('h2'));
  await page.evaluate(async b64 => {
    const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
    const dt = new DataTransfer();
    dt.items.add(new File([bytes], 'shot.png', { type: 'image/png' }));
    document.activeElement.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  }, PNG.toString('base64'));
  await h.settle(500);
  expect((await h.deck()).includes('<img src="assets/shot.png"'), 'image inserted');
  eq(await h.cur('h2').textContent(), '슬라이드 제목', 'heading untouched');
}, { http: true });

test('duplicating a slide with SVG gradients gives the copy its own ids', async ({ page, h }) => {
  await h.go(5); await h.edit();
  await h.menu('slide', 'dup');
  const svgs = await page.evaluate(() => [...document.querySelectorAll('main.deck > .slide svg.grad')].map(s => s.outerHTML));
  eq(svgs.length, 2, 'two copies');
  const ids = svgs.map(x => x.match(/id="([^"]+)"/)[1]);
  expect(ids[0] === 'g1' && ids[1] !== 'g1', 'copy renamed: ' + ids);
  expect(svgs[1].includes(`url(#${ids[1]})`), 'copy points at its own gradient');
  const hidden = await page.evaluate(() => getComputedStyle(document.querySelector('main.deck > .slide:not(.dk-current)')).display);
  expect(hidden !== 'none', 'other slides are not display:none (SVG defs keep painting)');
}, { fixture: FIXTURE.replace('\n</main>', `
  <section class="slide">
    <h2>그라디언트</h2>
    <svg class="grad" viewBox="0 0 100 50" width="400"><defs><linearGradient id="g1"><stop offset="0" stop-color="#f00"/><stop offset="1" stop-color="#00f"/></linearGradient></defs><rect width="100" height="50" fill="url(#g1)"/></svg>
  </section>
\n</main>`) });

test('a stray </main> in a comment or <main> in CSS does not break saving', async ({ page, h }) => {
  await h.edit();
  await h.clickText(h.cur('h1')); await page.keyboard.type('!');
  await h.save();
  const d = h.disk();
  expect(d.includes('<h1>발표 제목!</h1>'), 'edit saved');
  expect(d.includes('<script src="deck-edit.js"></script>') && d.includes('<!-- deck ends at </main> -->') && d.includes('/* styles for <main> */'), 'rest of file intact');
}, { http: true, fixture: FIXTURE.replace('<style>', '<style>\n  /* styles for <main> */').replace('</body>', '<!-- deck ends at </main> -->\n</body>') });

test('author CSS on main and slides does not break the layout; transparent slides get the page background', async ({ page, h }) => {
  for (const mode of ['present', 'edit']) {
    await page.evaluate(m => deckEdit.setMode(m), mode);
    await page.waitForTimeout(80);
    const b = await page.locator('main.deck > .slide.dk-current').boundingBox();
    expect(Math.abs(b.width / b.height - 16 / 9) < 0.01 && b.width > 600, `${mode}: slide keeps 16:9 and size ${JSON.stringify(b)}`);
  }
  eq(await page.locator('main.deck > .slide.dk-current').evaluate(e => getComputedStyle(e).backgroundColor), 'rgb(17, 34, 51)', 'slide background from body');
}, { fixture: FIXTURE.replace('</style>', '  main { max-width: 800px; margin: 0 auto; zoom: 0.5; }\n  section.slide.title { height: auto; min-height: 100vh; background: none; }\n  body { background: #112233 !important; }\n</style>') });

// =====================================================================
// Serialization & output
// =====================================================================
test('unchanged deck saves byte-for-byte, even with markup the parser rewrites (<table> → <tbody>)', async ({ page, h }) => {
  eq(await page.evaluate(s => deckEdit.composeFile(s), FIXTURE), FIXTURE, 'compose(file) === file');
  const live = await page.evaluate(s => deckEdit.deckHTML() === deckEdit.deckFromText(s), FIXTURE);
  expect(live, 'live DOM (with KaTeX rendered) matches the file');
});

test('unchanged deck saves byte-for-byte (the English skill template)', async ({ page, h }) => {
  eq(await page.evaluate(s => deckEdit.composeFile(s), TEMPLATE), TEMPLATE, 'compose(template) === template');
  const live = await page.evaluate(s => deckEdit.deckHTML() === deckEdit.deckFromText(s), TEMPLATE);
  expect(live, 'live DOM (with KaTeX rendered) matches the template');
}, { fixture: TEMPLATE });

test('the English template\'s <title> counts as a template title: the tab follows the first heading', async ({ page, h }) => {
  eq(await page.title(), 'Presentation title', 'starts as the heading');
  await h.edit();
  await h.clickText(h.cur('h1'));
  await page.keyboard.press('Meta+a');
  await page.keyboard.type('World models that plan');
  await page.keyboard.press('Escape');
  eq(await page.title(), 'World models that plan', 'title follows the heading');
}, { fixture: TEMPLATE });

test('editing one slide rewrites only that slide; reordering keeps slide text verbatim', async ({ page, h }) => {
  await h.edit();
  await h.clickText(h.cur('h1'));
  await page.keyboard.type('!');
  await page.keyboard.press('Escape');
  const out = await page.evaluate(s => deckEdit.composeFile(s), FIXTURE);
  eq(out, FIXTURE.replace('<h1>발표 제목</h1>', '<h1>발표 제목!</h1>'), 'only the heading changed');
  expect(out.includes('<table><tr>'), 'untouched table slide kept without <tbody>');
  await page.locator('#dk-sidebar .dk-thumb').nth(4).dragTo(page.locator('#dk-sidebar .dk-thumb').nth(0), { targetPosition: { x: 100, y: 4 } });
  const out2 = await page.evaluate(s => deckEdit.composeFile(s), FIXTURE);
  expect(out2.includes('<table><tr>') && out2.indexOf('표와 이미지') < out2.indexOf('발표 제목!'), 'moved slide keeps its original text');
});

test('print/PDF: one page per slide', async ({ page }) => {
  const pdf = await page.pdf({ preferCSSPageSize: true, printBackground: true });
  const pages = (pdf.toString('latin1').match(/\/Type\s*\/Page[^s]/g) || []).length;
  eq(pages, 5, 'pdf pages');
});

test('decks under ~/Library (iCloud Drive app folder) explain why saving is blocked', async ({ page, h }) => {
  await h.edit();
  expect((await h.shadow('.status')).text.includes('Can\'t save here'), 'status warns up front');
  await h.save();
  expect((await h.shadow('.toast')).text.includes('Library'), 'toast explains');
}, { libraryDir: true });

// =====================================================================
// Selecting several things, and text across lines
// =====================================================================
const slideBox = page => page.locator('main.deck > .slide.dk-current').boundingBox();
const liveOutlines = page => page.locator('#dk-chrome').evaluate(h => [...h.shadowRoot.querySelectorAll('.selm')].filter(x => x.style.display === 'block').length);
const noPageSelection = page => page.evaluate(() => getSelection().isCollapsed || getSelection().rangeCount === 0);
// Screen point of the middle of character `i` of an element's text.
const charPoint = (loc, i) => loc.evaluate((el, i) => {
  const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  let n;
  while ((n = w.nextNode())) {
    if (i < n.length) { const r = document.createRange(); r.setStart(n, i); r.setEnd(n, i + 1); const b = r.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; }
    i -= n.length;
  }
  throw new Error('no such character');
}, i);
// The text a selection leaves behind: [text before it in the first block, text after it in the last block].
const selEdges = page => page.evaluate(() => {
  const r = getSelection().getRangeAt(0);
  const block = n => (n.nodeType === 3 ? n.parentElement : n).closest('li, p, h1, h2, h3');
  const a = block(r.startContainer), z = block(r.endContainer);
  const pre = document.createRange(); pre.selectNodeContents(a); pre.setEnd(r.startContainer, r.startOffset);
  const post = document.createRange(); post.selectNodeContents(z); post.setStart(r.endContainer, r.endOffset);
  return [pre.toString(), post.toString(), a === z];
});

test('drag on the slide background: live outlines, two picked, Delete removes both, one ⌘Z restores', async ({ page, h }) => {
  await h.go(1); await h.edit();
  const before = await h.deck();
  const s = await slideBox(page);
  const ul = await h.cur('ul').boundingBox();
  await page.mouse.move(s.x + 10, s.y + 10);
  await page.mouse.down();
  await page.mouse.move(s.x + 420, ul.y + ul.height - 8, { steps: 8 });
  eq(await liveOutlines(page), 2, 'both outlined while dragging, before release');
  eq((await h.shadow('.marquee')).display, 'block', 'selection box drawn');
  await page.mouse.up();
  const st = await h.state();
  eq([st.count, st.selection], [2, ['Title', 'List']], 'heading and list selected');
  expect(await noPageSelection(page), 'no page text highlighted');
  eq((await h.shadow('.selg .gtag')).text, '2 selected', 'chip counts the selection');
  await page.keyboard.press('Delete');
  eq(await page.locator('main.deck > .slide.dk-current > :is(h2, ul)').count(), 0, 'both removed');
  expect((await h.shadow('.toast')).text.includes('2 deleted'), 'toast says how many');
  await page.keyboard.press('Meta+z');
  eq(await h.deck(), before, 'one undo restores the deck exactly');
});

test('drag starting beside a line of text (not on it) selects only the list', async ({ page, h }) => {
  await h.go(1); await h.edit();
  const li = page.locator('main.deck > .slide.dk-current li').first();
  const right = await li.evaluate(el => { const r = document.createRange(); r.selectNodeContents(el); return r.getBoundingClientRect().right; });
  const lb = await li.boundingBox(), ul = await h.cur('ul').boundingBox();
  expect(right + 200 < lb.x + lb.width, 'start point is on the bullet box, right of its text');
  await h.drag({ x: right + 200, y: lb.y + lb.height / 2 }, { x: ul.x + 40, y: ul.y + ul.height - 6 }, 8);
  eq((await h.state()).selection, ['List'], 'only the list');
  eq((await h.state()).editing, false, 'nothing being edited');
});

test('drag over the picture and part of the text column picks those two, not the row around them', async ({ page, h }) => {
  await h.go(2); await h.edit();
  const s = await slideBox(page);
  const p = await h.cur('.cols p').boundingBox();
  await h.drag({ x: s.x + s.width - 10, y: s.y + s.height - 10 }, { x: p.x + 30, y: p.y + p.height / 2 }, 8);
  eq((await h.state()).selection, ['Text', 'Figure group'], 'paragraph and figure');
});

test('Shift-click adds and removes; the group drags, nudges, duplicates and lines up', async ({ page, h }) => {
  await h.go(3); await h.edit();
  await page.mouse.click(...Object.values(await h.center(h.cur('div.math .katex'))));
  await page.keyboard.down('Shift');
  await h.clickText(h.cur('h2'));
  await page.keyboard.up('Shift');
  const st = await h.state();
  eq([st.count, st.editing], [2, false], 'formula and heading selected, nothing edited');
  const c = await h.center(h.cur('h2'));
  await h.drag({ x: c.x - 40, y: c.y }, { x: c.x + 20, y: c.y + 30 });
  const tr = () => page.evaluate(() => [...document.querySelectorAll('main.deck > .slide.dk-current > :is(h2, div.math)')].map(e => e.style.translate));
  const t1 = await tr();
  expect(t1.length === 2 && t1.every(t => /^\d+px \d+px$/.test(t)) && t1[0] === t1[1], 'both moved the same: ' + t1);
  eq((await h.state()).count, 2, 'still both selected after the drag');
  await page.keyboard.press('ArrowRight');
  const t2 = await tr();
  eq(t2.map(t => parseInt(t)), t1.map(t => parseInt(t) + 1), 'ArrowRight nudges both by 1px');
  await page.keyboard.press('Meta+d');
  eq(await page.locator('main.deck > .slide.dk-current > :is(h2, div.math)').count(), 4, 'two copies');
  eq((await h.state()).count, 2, 'the copies are selected');
  await h.pick('arrange', '[data-val="left"]');
  const lefts = await page.evaluate(() => {
    const s = document.querySelector('main.deck > .slide.dk-current');
    const h2 = s.querySelectorAll(':scope > h2')[1], m = s.querySelectorAll(':scope > div.math')[1];
    const r = document.createRange(); r.selectNodeContents(h2);
    return [r.getBoundingClientRect().left, Math.min(...[...m.querySelectorAll('.katex-html > .base')].map(b => b.getBoundingClientRect().left))];
  });
  expect(Math.abs(lefts[0] - lefts[1]) <= 1, '왼쪽 맞춤 lines up the visible left edges: ' + lefts);
  await page.keyboard.down('Shift');
  await h.clickText(page.locator('main.deck > .slide.dk-current > h2').nth(1));
  await page.keyboard.up('Shift');
  eq((await h.state()).count, 1, 'Shift-click on a member takes it out');
});

test('⌘A selects everything on the slide; while typing it selects all the text of that box', async ({ page, h }) => {
  await h.go(1); await h.edit();
  await page.keyboard.press('Meta+a');
  eq((await h.state()).selection, ['Title', 'List'], 'every top-level object');
  expect(await noPageSelection(page), 'no page highlight');
  await page.keyboard.press('Escape');
  eq((await h.state()).count, 0, 'Esc clears a multi-selection');
  await h.clickText(h.cur('li'));
  await page.keyboard.press('Meta+a');
  const t = await page.evaluate(() => getSelection().toString());
  expect(['첫 번째 요점', '두 번째 요점', '세 번째 요점'].every(x => t.includes(x)), 'all bullets selected: ' + JSON.stringify(t));
});

test('drag across bullets, then Backspace or typing joins the first and last bullet', async ({ page, h }) => {
  await h.go(1); await h.edit();
  const lis = page.locator('main.deck > .slide.dk-current li');
  for (const key of ['Backspace', '가']) {
    await h.drag(await charPoint(lis.nth(0), 3), await charPoint(lis.nth(2), 3), 10);
    const [head, tail, same] = await selEdges(page);
    expect(!same && head.length > 0 && tail.length > 0, 'selection runs from bullet 1 into bullet 3: ' + [head, tail]);
    if (key === 'Backspace') await page.keyboard.press('Backspace'); else await page.keyboard.type('가');
    eq(await h.texts('li'), [head + (key === 'Backspace' ? '' : '가') + tail], key + ': one bullet left');
    eq(await h.active(), 'UL:true', 'still editing the list');
    await page.keyboard.type('|');
    eq(await h.texts('li'), [head + (key === 'Backspace' ? '' : '가') + '|' + tail], 'caret at the join');
    expect(!/<span style/.test(await h.deck()), 'no styled spans left behind');
    await page.keyboard.press('Escape');
    await page.keyboard.press('Meta+z'); await page.keyboard.press('Meta+z');
    eq((await h.texts('li')).length, 3, 'undo brings the bullets back');
    await page.keyboard.press('Escape');   // the list stays selected after ⌘Z; let go of it before dragging over its text
  }
});

test('Korean typed over a selection across bullets: one bullet, the syllable once, no styled spans', async ({ page, h }) => {
  await h.go(1); await h.edit();
  await h.clickText(h.cur('li'));
  await page.evaluate(() => {
    const li = document.querySelectorAll('main.deck > .slide.dk-current li');
    const r = document.createRange();
    r.setStart(li[0].firstChild, 3); r.setEnd(li[2].firstChild, 3);
    getSelection().removeAllRanges(); getSelection().addRange(r);
  });
  // macOS: the first key of a syllable arrives as keydown 229 before composition starts.
  await h.cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Process', code: 'KeyR', windowsVirtualKeyCode: 229 });
  await h.ime('가');
  await h.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Process', code: 'KeyR', windowsVirtualKeyCode: 229 });
  await h.settle(200);
  eq(await h.texts('li'), ['첫 번가째 요점'], 'merged bullet with the syllable');
  expect(!(await page.evaluate(() => document.querySelector('main.deck > .slide.dk-current ul').querySelector('span[style]'))), 'no span[style]');
});

test('Korean typed over a selection across bullets with no keydown first: the span clean-up still applies', async ({ page, h }) => {
  await h.go(1); await h.edit();
  await h.clickText(h.cur('li'));
  await page.evaluate(() => {
    const li = document.querySelectorAll('main.deck > .slide.dk-current li');
    const r = document.createRange();
    r.setStart(li[0].firstChild, 3); r.setEnd(li[2].firstChild, 3);
    getSelection().removeAllRanges(); getSelection().addRange(r);
  });
  await h.ime('가');
  await h.settle(200);
  eq(await h.texts('li'), ['첫 번가째 요점'], 'merged bullet with the syllable');
  expect(!(await page.evaluate(() => document.querySelector('main.deck > .slide.dk-current ul').querySelector('span[style]'))), 'no span[style]');
});

const COLUMN_FIXTURE = FIXTURE.replace('<div>\n        <p>왼쪽에 설명을 둡니다.</p>\n      </div>', '<div>\n        <h3>소제목입니다</h3>\n        <p>왼쪽에 설명을 둡니다.</p>\n      </div>');
test('text column: a selection from the heading into the paragraph deletes as one, keeping the heading', async ({ page, h }) => {
  await h.go(2); await h.edit();
  await h.clickText(h.cur('.cols h3'));
  eq(await h.active(), 'DIV:true', 'the whole column is edited as one');
  await h.drag(await charPoint(h.cur('.cols h3'), 2), await charPoint(h.cur('.cols p'), 4), 10);
  const [head, tail, same] = await selEdges(page);
  expect(!same, 'selection spans heading and paragraph');
  await page.keyboard.press('Backspace');
  await page.keyboard.press('Escape');
  const html = await page.evaluate(() => document.querySelector('main.deck > .slide.dk-current .cols > div').innerHTML.trim());
  eq(html, `<h3>${head}${tail}</h3>`, 'one heading holding both halves');
  expect(!/<span[^>]* style=/.test(await h.deck()), 'no styled spans');
}, { fixture: COLUMN_FIXTURE });

test('text column: Korean typed over heading + paragraph (with and without keydown 229) leaves one heading, no spans', async ({ page, h }) => {
  await h.go(2); await h.edit();
  for (const withKey of [true, false]) {
    await h.clickText(h.cur('.cols h3'));
    await page.evaluate(() => {
      const d = document.querySelector('main.deck > .slide.dk-current .cols > div');
      const r = document.createRange();
      r.setStart(d.querySelector('h3').firstChild, 2); r.setEnd(d.querySelector('p').firstChild, 4);
      getSelection().removeAllRanges(); getSelection().addRange(r);
    });
    if (withKey) await h.cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Process', code: 'KeyR', windowsVirtualKeyCode: 229 });
    await h.ime('한');
    await h.settle(200);
    const html = await page.evaluate(() => document.querySelector('main.deck > .slide.dk-current .cols > div').innerHTML.trim());
    eq(html, '<h3>소제한설명을 둡니다.</h3>', (withKey ? 'with' : 'without') + ' keydown: one heading, syllable once, no spans');
    await page.keyboard.press('Escape');
    await page.keyboard.press('Meta+z');
  }
}, { fixture: COLUMN_FIXTURE });

test('text column: Enter, Backspace and the paragraph menu work per paragraph inside it', async ({ page, h }) => {
  await h.go(2); await h.edit();
  await h.clickText(h.cur('.cols p'));
  await page.keyboard.press('Enter');
  await page.keyboard.type('새 문단');
  eq(await h.texts('.cols p'), ['왼쪽에 설명을 둡니다.', '새 문단'], 'Enter adds a paragraph inside the column');
  await h.menu('block', 'H3');
  eq(await h.texts('.cols h3'), ['소제목입니다', '새 문단'], 'only the caret paragraph became a heading');
  eq(await h.active(), 'DIV:true', 'still editing the column');
  await page.keyboard.press('Home');
  await page.keyboard.press('Backspace');
  eq(await h.texts('.cols > div > *'), ['소제목입니다', '왼쪽에 설명을 둡니다.새 문단'], 'Backspace at the start joins into the paragraph before');
  await h.clickText(h.cur('.cols h3'), 'start');
  await page.keyboard.press('Home');
  await page.keyboard.press('Backspace');
  eq(await h.texts('.cols > div > *'), ['소제목입니다', '왼쪽에 설명을 둡니다.새 문단'], 'Backspace at the very start does nothing');
}, { fixture: COLUMN_FIXTURE });

test('Alt+↓ moves a bullet (caret kept); Alt+↑ moves a selected heading below the list back', async ({ page, h }) => {
  await h.go(1); await h.edit();
  await h.clickText(h.cur('li'));
  await page.keyboard.press('Alt+ArrowDown');
  eq(await h.texts('li'), ['두 번째 요점', '첫 번째 요점', '세 번째 요점'], 'bullet 1 is now second');
  await page.keyboard.type('!');
  eq((await h.texts('li'))[1], '첫 번째 요점!', 'caret stayed in the moved bullet');
  await page.keyboard.press('Escape');
  expect(!/<li style/.test(await h.deck()), 'no style on any bullet');
  // the list is selected now; Alt+↑ swaps it with the heading
  await page.keyboard.press('Alt+ArrowUp');
  eq(await page.evaluate(() => [...document.querySelector('main.deck > .slide.dk-current').children].map(e => e.tagName).slice(0, 2)), ['UL', 'H2'], 'list moved above the heading');
  expect(!/translate|z-index/.test(await h.deck()), 'reordered without translate or z-index');
});

test('Esc clears a selection of three; with a thumbnail in focus Delete acts on the slide, not on what was selected', async ({ page, h }) => {
  await h.go(4); await h.edit();
  await page.keyboard.press('Meta+a');
  expect((await h.state()).count >= 3, 'several selected: ' + (await h.state()).count);
  await page.keyboard.press('Escape');
  eq((await h.state()).count, 0, 'cleared');
  await page.mouse.click(...Object.values(await h.center(h.cur('img.pic'))));
  eq((await h.state()).selected, 'Image', 'image selected');
  const before = await h.deck();
  await page.locator('#dk-sidebar .dk-thumb').nth(4).click();
  eq((await h.state()).count, 0, 'a thumbnail click leaves nothing on the slide selected');
  await page.keyboard.press('Meta+a');
  eq((await h.state()).count, 0, '⌘A aimed at the thumbnails selects nothing on the slide');
  await page.keyboard.press('Delete');
  eq((await h.state()).slides, 4, 'Delete removed the slide');
  await page.keyboard.press('Meta+z');
  eq(await h.deck(), before, 'undo brings it back');
  await h.go(4);
  await page.mouse.click(...Object.values(await h.center(h.cur('img.pic'))));
  await page.keyboard.press('Delete');
  eq(await page.locator('main.deck > .slide.dk-current img.pic').count(), 0, 'keys reach the slide again after clicking it');
  eq((await h.state()).slides, 5, 'slides kept');
});

test('hover outlines what a click would grab and sets the pointer', async ({ page, h }) => {
  await h.go(1); await h.edit();
  await page.mouse.move(...Object.values(await charPoint(h.cur('h2'), 2)));
  await h.settle(100);
  eq((await h.shadow('.hover')).display, 'block', 'heading outlined');
  expect(await page.evaluate(() => document.documentElement.classList.contains('dk-hover-text')), 'text pointer');
  const s = await slideBox(page);
  await page.mouse.move(s.x + 10, s.y + s.height - 10);
  await h.settle(100);
  eq((await h.shadow('.hover')).display, 'none', 'nothing on the background');
  await h.go(2);
  await page.mouse.move(...Object.values(await h.center(h.cur('svg'))));
  await h.settle(100);
  expect(await page.evaluate(() => document.documentElement.classList.contains('dk-hover-move')), 'move pointer over a picture');
  expect(!(await h.deck()).includes('cursor'), 'nothing written on the deck');
});

test('dragging text from one box into another explains that boxes are selected whole', async ({ page, h }) => {
  // (A heading and the list under it on the slide are one run now, so this drags from the title into the text column.)
  await h.go(2); await h.edit();
  await h.drag(await charPoint(h.cur('h2'), 2), await charPoint(h.cur('.cols p'), 3), 10);
  expect((await h.shadow('.toast')).text.includes('Text in other boxes isn\'t selected along'), 'toast explains');
});

test('AI changes another slide while two objects are selected: no errors, selection stays valid', async ({ page, h }) => {
  await h.go(1); await h.edit();
  await h.save();
  await h.clickText(h.cur('h2'));
  await page.keyboard.type('+');
  await page.keyboard.press('Escape');
  await page.keyboard.press('Meta+a');
  eq((await h.state()).count, 2, 'two selected');
  h.writeDisk(h.disk().replace('한 줄 부제', 'AI 부제'));
  await page.waitForFunction(() => document.querySelector('#dk-chrome').shadowRoot.querySelector('.status').textContent.includes('AI edits applied'), null, { timeout: 4000 });
  await h.settle(200);
  const ok = await page.evaluate(() => deckEdit.state.count >= 0 && deckEdit._sel().every(e => e.isConnected));
  expect(ok, 'only connected nodes selected');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Meta+a');
  await page.keyboard.press('Delete');
  eq(await page.locator('main.deck > .slide.dk-current > :is(h2, ul)').count(), 0, 'selection still usable after the merge');
}, { http: true });

// =====================================================================
// Second QA round: where inserts land, toolbars and chips, alignment, text across slide-level blocks, tables
// =====================================================================
// Visible rects (screen px) used by the checks below: the words of text, the glyphs of a formula, the box of anything else.
const textRect = loc => loc.evaluate(el => { const r = document.createRange(); r.selectNodeContents(el); const b = r.getBoundingClientRect(); return { l: b.left, t: b.top, r: b.right, b: b.bottom }; });
const mathRectOf = loc => loc.evaluate(el => { const bs = [...el.querySelectorAll('.katex-html > .base')].map(b => b.getBoundingClientRect()); return { l: Math.min(...bs.map(b => b.left)), t: Math.min(...bs.map(b => b.top)), r: Math.max(...bs.map(b => b.right)), b: Math.max(...bs.map(b => b.bottom)) }; });
const boxRect = loc => loc.boundingBox().then(b => ({ l: b.x, t: b.y, r: b.x + b.width, b: b.y + b.height }));
const chromeRect = (page, sel) => page.locator('#dk-chrome').evaluate((h, sel) => { const b = h.shadowRoot.querySelector(sel).getBoundingClientRect(); return { l: b.left, t: b.top, r: b.right, b: b.bottom }; }, sel);
const cross = (a, b) => Math.min(a.r, b.r) - Math.max(a.l, b.l) > 0.5 && Math.min(a.b, b.b) - Math.max(a.t, b.t) > 0.5;
const RUN_FIXTURE = FIXTURE.replace('\n</main>', `
  <section class="slide">
    <h2>AI가 쓴 슬라이드</h2>
    <p>첫 번째 문단입니다.</p>
    <p>두 번째 문단입니다.</p>
  </section>

  <section class="slide">
    <h2>그림이 섞인 슬라이드</h2>
    <p>그림 위 문단입니다.</p>
    <figure style="width:300px"><svg viewBox="0 0 100 40"><rect width="100" height="40" fill="#93a5f5"/></svg></figure>
    <p>그림 아래 문단입니다.</p>
    <p class="box" style="position:absolute; left:1300px; top:760px; width:400px; margin:0">떠 있는 상자</p>
  </section>
\n</main>`);

test('flow inserts never squeeze a flex layout: three tables and a title leave the chart its size', async ({ page, h }) => {
  await h.go(2); await h.edit();
  const svgH = () => h.cur('figure svg').evaluate(e => Math.round(e.getBoundingClientRect().height));
  const h0 = await svgH();
  for (let i = 0; i < 3; i++) {
    await h.tb('[data-act="table"]');
    if (i === 0) expect((await h.shadow('.toast')).text.includes('free spot'), 'toast says it floats');
    await page.keyboard.press('Escape'); await page.keyboard.press('Escape');
    eq(await svgH(), h0, `chart keeps its height after table ${i + 1}`);
  }
  await h.menu('text', 'title');
  await page.keyboard.press('Escape');
  eq(await svgH(), h0, 'chart keeps its height after a title');
  const tables = await page.evaluate(() => [...document.querySelectorAll('main.deck > .slide.dk-current table')].map(t => getComputedStyle(t).position));
  eq(tables, ['absolute', 'absolute', 'absolute'], 'tables float');
});

test('flow inserts never land under a shape: title, list and table go elsewhere', async ({ page, h }) => {
  await h.go(1); await h.edit();
  await h.menu('slide', 'blank');
  await h.tb('[data-act="shape"]');
  await h.menu('shape', 'circle');
  const shapes = await Promise.all([0, 1].map(i => boxRect(page.locator('main.deck > .slide.dk-current .shape').nth(i))));
  await h.menu('text', 'title'); await page.keyboard.press('Escape');
  await h.menu('text', 'list'); await page.keyboard.press('Escape'); await page.keyboard.press('Escape');
  await h.tb('[data-act="table"]'); await page.keyboard.press('Escape');
  const got = [await textRect(h.cur('h2')), await textRect(h.cur('ul')), await boxRect(h.cur('table'))];
  for (const [i, r] of got.entries()) for (const sh of shapes) expect(!cross(r, sh), `insert ${i} is not under a shape: ${JSON.stringify([r, sh])}`);
});

test('free objects land in empty space beside short text, not on the table or bullets', async ({ page, h }) => {
  await h.go(1); await h.edit();
  await h.tb('[data-act="table"]');
  await page.keyboard.press('Escape'); await page.keyboard.press('Escape');
  const content = [await textRect(h.cur('h2')), ...(await Promise.all([0, 1, 2].map(i => textRect(page.locator('main.deck > .slide.dk-current li').nth(i))))), await boxRect(h.cur('table'))];
  for (const a of ['shape', 'arrow', 'text', 'shape', 'arrow']) { await h.tb(`[data-act="${a}"]`); await page.keyboard.press('Escape'); await page.keyboard.press('Escape'); }
  const objs = await page.evaluate(() => [...document.querySelectorAll('main.deck > .slide.dk-current > :is(.shape, p)')].map(e => { const b = e.getBoundingClientRect(); return { l: b.left, t: b.top, r: b.right, b: b.bottom }; }));
  eq(objs.length, 5, 'five objects');
  for (const o of objs) for (const c of content) expect(!cross(o, c), 'object on content: ' + JSON.stringify([o, c]));
  for (let i = 0; i < 5; i++) for (let j = i + 1; j < 5; j++) expect(!cross(objs[i], objs[j]), `objects ${i} and ${j} overlap`);
  const s = await slideBox(page);
  expect(objs.every(o => o.l >= s.x && o.r <= s.x + s.width && o.t >= s.y && o.b <= s.y + s.height), 'all on the slide');
});

for (const width of [1280, 1440, 1600]) {
  test(`text toolbar covers neither the heading above nor the formula below (${width}px)`, async ({ page, h }) => {
    await h.go(3); await h.edit();
    await h.clickText(h.cur('p'));
    const bar = await chromeRect(page, '.fmt');
    const others = [await textRect(h.cur('h2')), await mathRectOf(h.cur('div.math')), await textRect(h.cur('p'))];
    for (const o of others) expect(!cross(bar, o), 'toolbar covers content: ' + JSON.stringify([bar, o]));
    expect(bar.l >= 216 && bar.r <= width && bar.t >= 52, 'inside the editor');
  }, { viewport: { width, height: Math.round(width * 0.625) } });
}

test('정렬 lines up what is visible: heading and display formula, left then right', async ({ page, h }) => {
  await h.go(3); await h.edit();
  await page.mouse.click(...Object.values(await h.center(h.cur('div.math .katex-html'))));
  await page.keyboard.down('Shift');
  await h.clickText(h.cur('h2'));
  await page.keyboard.up('Shift');
  eq((await h.state()).count, 2, 'two selected');
  await h.pick('arrange', '[data-val="left"]');
  let a = await textRect(h.cur('h2')), m = await mathRectOf(h.cur('div.math'));
  expect(Math.abs(a.l - m.l) <= 1, '왼쪽 맞춤: visible left edges meet: ' + [a.l, m.l]);
  const s = await slideBox(page);
  await h.pick('arrange', '[data-val="right"]');
  a = await textRect(h.cur('h2')); m = await mathRectOf(h.cur('div.math'));
  expect(Math.abs(a.r - m.r) <= 1, '오른쪽 맞춤: visible right edges meet: ' + [a.r, m.r]);
  expect(a.r < s.x + s.width * 0.75, 'the heading is not thrown to the slide edge: ' + a.r);
});

test('title slide: drag from the title into the subtitle, Backspace joins them (title keeps its tag); undo restores', async ({ page, h }) => {
  await h.edit();
  const before = await h.deck();
  await h.drag(await charPoint(h.cur('h1'), 1), await charPoint(h.cur('.sub'), 2), 10);
  const [head, tail, same] = await selEdges(page);
  expect(!same && head === '발' && tail.length > 0, 'selection runs from the title into the subtitle: ' + [head, tail]);
  await page.keyboard.press('Backspace');
  eq(await h.texts('h1'), [head + tail], 'one title holding both halves');
  eq(await h.texts('p'), ['이름 · 소속 · 날짜'], 'subtitle gone, meta untouched');
  await page.keyboard.type('|');
  eq(await h.texts('h1'), [head + '|' + tail], 'caret at the join');
  await page.keyboard.press('Escape');
  const d = await h.deck();
  expect(!/contenteditable|<span style/.test(d), 'nothing left behind');
  await page.keyboard.press('Meta+z'); await page.keyboard.press('Meta+z');
  eq(await h.deck(), before, 'undo restores the deck exactly');
});

test('h2 + p + p slide: typing, Delete and paste over a selection across paragraphs', async ({ page, h }) => {
  await h.go(5); await h.edit();
  const ps = page.locator('main.deck > .slide.dk-current p');
  for (const key of ['가', 'Delete', 'paste', 'Enter']) {
    const before = await h.deck();
    await h.drag(await charPoint(h.cur('h2'), 2), await charPoint(ps.nth(1), 3), 10);
    const [head, tail, same] = await selEdges(page);
    expect(!same && head === 'AI' && tail === '째 문단입니다.', 'selection from the heading into the last paragraph: ' + [head, tail]);
    if (key === 'paste') {
      await page.evaluate(() => { const dt = new DataTransfer(); dt.setData('text/plain', '붙임'); document.activeElement.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })); });
    } else if (key === '가') await page.keyboard.type('가'); else await page.keyboard.press(key);
    const mid = { '가': '가', Delete: '', paste: '붙임', Enter: '' }[key];
    if (key === 'Enter') eq(await page.evaluate(() => [...document.querySelector('main.deck > .slide.dk-current').children].map(e => e.tagName + ':' + e.innerHTML)), ['H2:' + head, 'P:' + tail], 'Enter: removes the selection, the heading and the last paragraph stay apart');
    else eq(await page.evaluate(() => [...document.querySelector('main.deck > .slide.dk-current').children].map(e => e.tagName + ':' + e.textContent)), ['H2:' + head + mid + tail], key + ': one heading left, holding both ends');
    await page.keyboard.press('Escape');
    expect(!/<span style/.test(await h.deck()), 'no styled spans');
    for (let i = 0; i < 3 && (await h.deck()) !== before; i++) await page.keyboard.press('Meta+z');
    eq(await h.deck(), before, key + ': undo restores exactly');
    await page.keyboard.press('Escape');   // what was selected stays selected after ⌘Z; let go before dragging over text
  }
}, { fixture: RUN_FIXTURE });

test('h2 + p + p slide: Korean typed over paragraphs (with and without keydown 229) leaves one heading, no spans', async ({ page, h }) => {
  await h.go(5); await h.edit();
  for (const withKey of [true, false]) {
    await h.clickText(h.cur('h2'));
    await page.evaluate(() => {
      const s = document.querySelector('main.deck > .slide.dk-current');
      const r = document.createRange();
      r.setStart(s.querySelector('h2').firstChild, 2); r.setEnd(s.querySelectorAll('p')[1].firstChild, 3);
      getSelection().removeAllRanges(); getSelection().addRange(r);
    });
    if (withKey) await h.cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Process', code: 'KeyR', windowsVirtualKeyCode: 229 });
    await h.ime('한');
    if (withKey) await h.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Process', code: 'KeyR', windowsVirtualKeyCode: 229 });
    await h.settle(200);
    const html = await page.evaluate(() => document.querySelector('main.deck > .slide.dk-current').innerHTML.replace(/ contenteditable="[^"]*"/g, '').trim());
    eq(html, '<h2>AI한째 문단입니다.</h2>', (withKey ? 'with' : 'without') + ' keydown: one heading, syllable once, no spans');
    await page.keyboard.press('Escape');
    await page.keyboard.press('Meta+z');
  }
}, { fixture: RUN_FIXTURE });

test('slide-level blocks: Backspace at a block start joins paragraphs only; Enter splits; the heading stays apart', async ({ page, h }) => {
  await h.go(5); await h.edit();
  const ps = page.locator('main.deck > .slide.dk-current p');
  await h.clickText(ps.nth(0), 'start');
  await page.keyboard.press('Home');
  await page.keyboard.press('Backspace');
  eq(await h.texts('h2'), ['AI가 쓴 슬라이드'], 'heading not joined');
  await h.clickText(ps.nth(1), 'start');
  await page.keyboard.press('Home');
  await page.keyboard.press('Backspace');
  eq(await h.texts('p'), ['첫 번째 문단입니다.두 번째 문단입니다.'], 'paragraphs joined');
  await page.keyboard.press('Enter');
  eq(await h.texts('p'), ['첫 번째 문단입니다.', '두 번째 문단입니다.'], 'Enter splits again');
  await page.keyboard.press('Escape');
  expect((await h.deck()).includes('<p>첫 번째 문단입니다.</p>\n    <p>두 번째 문단입니다.</p>'), 'each paragraph on its own line');
}, { fixture: RUN_FIXTURE });

test('slide with a figure and a floating text box: selection stops at the figure, the figure stays an object, the box stays separate', async ({ page, h }) => {
  await h.go(6); await h.edit();
  const ps = page.locator('main.deck > .slide.dk-current > p');
  await h.drag(await charPoint(h.cur('h2'), 1), await charPoint(ps.nth(0), 2), 10);
  let [head, tail, same] = await selEdges(page);
  expect(!same, 'heading into the paragraph above the figure');
  // dragging on past the figure into the paragraph below it: the selection stops at the end of the run
  await h.clickText(ps.nth(0));
  await h.drag(await charPoint(ps.nth(0), 2), await charPoint(ps.nth(1), 3), 12);
  const sel = await page.evaluate(() => getSelection().toString());
  expect(!sel.includes('그림 아래'), 'nothing after the figure is selected: ' + JSON.stringify(sel));
  await page.keyboard.press('Backspace');
  eq(await page.locator('main.deck > .slide.dk-current figure svg').count(), 1, 'figure still there');
  eq(await h.texts('p'), ['그림', '그림 아래 문단입니다.', '떠 있는 상자'], 'only the run text changed');
  await page.mouse.click(...Object.values(await h.center(h.cur('figure svg'))));
  const picked = await h.state();
  expect(['Figure', 'Figure group'].includes(picked.selected) && !picked.editing, 'the figure is picked as an object: ' + picked.selected);
  await h.clickText(h.cur('p.box'));
  eq(await h.active(), 'P.box:true', 'the floating box is edited on its own');
  await h.drag(await charPoint(h.cur('p.box'), 2), await charPoint(ps.nth(1), 2), 10);
  expect((await h.shadow('.toast')).text.includes('Text in other boxes isn\'t selected along'), 'dragging out of the box explains');
  expect(!(await page.evaluate(() => getSelection().toString())).includes('아래'), 'selection stays in the box');
}, { fixture: RUN_FIXTURE });

test('table: empty rows keep their height when presenting', async ({ page, h }) => {
  await h.go(1); await h.edit();
  await h.tb('[data-act="table"]');
  await page.keyboard.type('모델');
  await page.keyboard.press('Tab');
  await page.keyboard.type('점수');
  await page.keyboard.press('Escape'); await page.keyboard.press('Escape');
  const rows = () => page.evaluate(() => [...document.querySelector('main.deck > .slide.dk-current table').rows].map(r => r.getBoundingClientRect().height));
  const e = await rows();
  await page.keyboard.press('e');
  await h.settle(200);
  const p = await rows();
  const k = p[0] / e[0];
  expect(p.every((x, i) => Math.abs(x - e[i] * k) < 2), 'rows keep their proportions: ' + JSON.stringify([e, p]));
  expect(!(await h.deck()).includes('<br>'), 'nothing written into the cells');
});

test('table chip covers nothing above the table', async ({ page, h }) => {
  await h.go(1); await h.edit();
  await h.tb('[data-act="table"]');
  await page.keyboard.press('Escape');
  eq((await h.state()).selected, 'Table', 'table selected');
  const chip = await chromeRect(page, '.tag');
  expect(chip.r > chip.l, 'chip shown');
  const lis = await Promise.all([0, 1, 2].map(i => textRect(page.locator('main.deck > .slide.dk-current li').nth(i))));
  for (const li of lis) expect(!cross(chip, li), 'chip covers a bullet: ' + JSON.stringify([chip, li]));
}, { viewport: { width: 1280, height: 800 } });

test('inserted markup is indented like its neighbours; added rows go on their own line', async ({ page, h }) => {
  await h.go(1); await h.edit();
  await h.tb('[data-act="table"]');
  await page.keyboard.type('모델');
  for (let i = 0; i < 9; i++) await page.keyboard.press('Tab');
  await page.keyboard.press('Escape');
  await h.menu('text', 'title');
  await page.keyboard.type('소제목');
  await page.keyboard.press('Escape');
  const d = await h.deck();
  const slide = d.slice(d.indexOf('<h2>슬라이드 제목</h2>'), d.indexOf('</section>', d.indexOf('<h2>슬라이드 제목</h2>')));
  const rows = '        <tr><td></td><td></td><td></td></tr>\n';
  eq(slide, `<h2>슬라이드 제목</h2>
    <ul>
      <li>첫 번째 요점</li>
      <li>두 번째 요점</li>
      <li>세 번째 요점</li>
    </ul>
    <table style="width: 100%; border-collapse: collapse;">
      <thead>
        <tr><th>모델</th><th></th><th></th></tr>
      </thead>
      <tbody>
${rows}${rows}${rows}      </tbody>
    </table>
    <h2>소제목</h2>
    <aside class="notes">발표자 메모 (화면에는 보이지 않음)</aside>
  `, 'readable markup');
});

test('a selected table offers 행 ▾ / 열 ▾; dragging across cells explains cells are edited one at a time', async ({ page, h }) => {
  await h.go(4); await h.edit();
  await h.clickText(h.cur('td'));
  await page.keyboard.press('Escape');
  eq([(await h.state()).selected, (await h.state()).editing], ['Table', false], 'table selected');
  const size = () => page.evaluate(() => { const t = document.querySelector('main.deck > .slide.dk-current table'); return [t.rows.length, t.rows[0].cells.length]; });
  const before = await h.deck();
  await h.pick('trow', '[data-val="row-end"]');
  eq(await size(), [3, 2], 'row added at the end');
  await h.pick('tcol', '[data-val="col-end"]');
  eq(await size(), [3, 3], 'column added at the end');
  await h.pick('tcol', '[data-val="col-del"]');
  await h.pick('trow', '[data-val="row-del"]');
  eq(await size(), [2, 2], 'and removed again');
  eq((await h.state()).selected, 'Table', 'still selected');
  eq(await h.deck(), before, 'deck back as it was');
  await h.clickText(h.cur('td'));
  const c1 = await page.locator('main.deck > .slide.dk-current td').nth(1).boundingBox();
  const to = { x: c1.x + 30, y: c1.y + c1.height / 2 };
  await h.drag(await charPoint(h.cur('td'), 0), to, 10);
  expect((await h.shadow('.toast')).text.includes('one cell at a time'), 'toast explains cells are edited one at a time');
});

// =====================================================================
// QA round 3
// =====================================================================
const tripleClick = async (page, pt) => { await page.mouse.click(pt.x, pt.y, { clickCount: 3 }); await page.waitForTimeout(80); };
const pasteText = (page, text) => page.evaluate(text => { const dt = new DataTransfer(); dt.setData('text/plain', text); document.activeElement.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })); }, text);
const slideKids = page => page.evaluate(() => [...document.querySelector('main.deck > .slide.dk-current').children].filter(e => !e.hasAttribute('data-dk-runtime') && !e.matches('aside.notes')).map(e => e.tagName + (e.className.replace(/\s*dk-\S+/g, '') ? '.' + e.className.replace(/\s*dk-\S+/g, '').trim() : '') + ':' + e.textContent.trim().replace(/\s+/g, ' ')));

test('triple-click a slide title and retype it: only the title changes (typing, Backspace, Korean, paste)', async ({ page, h }) => {
  await h.edit();
  for (const how of ['type', 'Backspace', 'ime']) {
    const before = await h.deck();
    await tripleClick(page, await charPoint(h.cur('h1'), 2));
    eq(await page.evaluate(() => getSelection().toString().trim()), '발표 제목', how + ': triple-click selects the title only');
    if (how === 'type') await page.keyboard.type('새 제목');
    else if (how === 'Backspace') await page.keyboard.press('Backspace');
    else {
      await h.cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Process', code: 'KeyT', windowsVirtualKeyCode: 229 });
      await h.ime('새제목');
      await h.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Process', code: 'KeyT', windowsVirtualKeyCode: 229 });
      await h.settle(150);
    }
    const want = { type: '새 제목', Backspace: '', ime: '새제목' }[how];
    eq(await slideKids(page), ['H1:' + want, 'P.sub:한 줄 부제', 'P.meta:이름 · 소속 · 날짜'], how + ': subtitle and meta untouched');
    await page.keyboard.press('Escape');
    for (let i = 0; i < 4 && (await h.deck()) !== before; i++) await page.keyboard.press('Meta+z');
    eq(await h.deck(), before, how + ': undo restores');
  }
  await h.go(1);
  await tripleClick(page, await charPoint(h.cur('h2'), 2));
  await page.keyboard.type('새 제목');
  await page.keyboard.press('Escape');
  expect((await h.deck()).includes('<h2>새 제목</h2>\n    <ul>\n      <li>첫 번째 요점</li>'), 'bullets slide: heading replaced, bullets intact');
});

test('triple-click a paragraph on an h2 + p + p slide and paste: only that paragraph changes', async ({ page, h }) => {
  await h.go(5); await h.edit();
  await tripleClick(page, await charPoint(page.locator('main.deck > .slide.dk-current p').nth(0), 3));
  await pasteText(page, '붙임');
  eq(await slideKids(page), ['H2:AI가 쓴 슬라이드', 'P:붙임', 'P:두 번째 문단입니다.'], 'one paragraph replaced');
  await tripleClick(page, await charPoint(h.cur('h2'), 3));
  await page.keyboard.type('제목');
  eq(await slideKids(page), ['H2:제목', 'P:붙임', 'P:두 번째 문단입니다.'], 'heading replaced');
}, { fixture: RUN_FIXTURE });

const DARK_FIXTURE = String.raw`<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>어두운 덱</title>
<style>
  :root { --ink: #e5e7eb; --muted: #9ca3af; --accent: #f59e0b; --soft: #1f2937; --line: #374151; }
  body { margin: 0; background: #000; }
  .slide {
    width: 1920px; height: 1080px; padding: 100px 120px; box-sizing: border-box;
    position: relative; overflow: hidden; background: #0b1020; color: var(--ink);
    font: 400 38px/1.5 -apple-system, "Apple SD Gothic Neo", sans-serif;
  }
  .slide h1 { font-size: 104px; margin: 0 0 30px; color: #fff; }
  .slide h2 { font-size: 60px; margin: 0 0 40px; color: var(--accent); }
  .slide p { margin: 0 0 24px; }
  .slide ul { margin: 0; padding-left: 1.2em; }
  .slide .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 60px; }
  .slide .card { background: var(--soft); border-radius: 24px; padding: 40px; }
  .slide .math.display { font-size: 50px; text-align: center; margin: 40px 0; }
  .slide.cover { background: radial-gradient(circle at 30% 30%, #1e3a8a, #0b1020); padding-top: 360px; }
</style>
</head>
<body>
<main class="deck" data-size="1920x1080">

  <section class="slide cover">
    <h1>어두운 표지</h1>
    <p>부제가 여기에 들어갑니다</p>
    <p style="color: var(--muted)">홍길동 · KAIST · 2026</p>
  </section>

  <section class="slide">
    <h2>연구 동기</h2>
    <p>기존 방법은 긴 문맥에서 성능이 떨어집니다.</p>
    <p>우리는 잠재 공간에서 추론하는 방법을 제안합니다.</p>
    <div style="position:absolute; left:1200px; top:600px; width:500px; margin:0"><p>떠 있는 텍스트 상자</p></div>
    <div class="shape" data-shape="rect" style="position:absolute; left:1300px; top:200px; width:400px; height:240px; margin:0; background: var(--accent)"></div>
  </section>

  <section class="slide">
    <h2>두 칸 구성</h2>
    <div class="grid">
      <div class="card"><h3>왼쪽</h3><p>짧은 설명</p></div>
      <div class="card"><h3>오른쪽</h3><ul><li>항목 하나</li><li>항목 둘</li></ul></div>
    </div>
  </section>

  <section class="slide">
    <h2>목표 함수</h2>
    <p>다음을 최소화합니다.</p>
    <div class="math display">\min_\theta \; \mathbb{E}_{x}\big[\lVert f_\theta(x) - y \rVert^2\big]</div>
    <p>여기서 <span class="math">f_\theta</span> 는 신경망입니다.</p>
  </section>

</main>
<script src="deck-edit.js"></script>
</body>
</html>
`;
// What is visible of each object on the slide (screen px): table/shape/picture boxes, formula glyphs, the words of text.
const visibleParts = page => page.evaluate(() => {
  const s = document.querySelector('main.deck > .slide.dk-current');
  const R = b => ({ l: b.left, t: b.top, r: b.right, b: b.bottom });
  const one = el => {
    if (el.tagName === 'FIGURE') return [...el.children].flatMap(one);
    if (/^(TABLE|IMG|svg)$/.test(el.tagName) || el.classList.contains('shape') || el.classList.contains('card')) return [R(el.getBoundingClientRect())];
    if (el.classList.contains('math')) { const bs = [...el.querySelectorAll('.katex-html > .base')].map(b => b.getBoundingClientRect()); return bs.length ? [{ l: Math.min(...bs.map(b => b.left)), t: Math.min(...bs.map(b => b.top)), r: Math.max(...bs.map(b => b.right)), b: Math.max(...bs.map(b => b.bottom)) }] : []; }
    if (getComputedStyle(el).display === 'grid' || el.classList.contains('cols')) return [...el.children].flatMap(one);
    const out = [], w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT), rg = document.createRange();
    let n; while ((n = w.nextNode())) { if (!n.data.trim()) continue; rg.selectNodeContents(n); for (const b of rg.getClientRects()) out.push(R(b)); }
    return out;
  };
  return [...s.children].filter(c => !c.hasAttribute('data-dk-runtime') && !c.matches('aside.notes, style, script')).map(c => ({ name: c.tagName + (c.style.position === 'absolute' ? '(free)' : '') + ':' + c.textContent.trim().slice(0, 12), rs: one(c) }));
});
const overlapsOf = parts => {
  const out = [];
  const area = (a, b) => Math.max(0, Math.min(a.r, b.r) - Math.max(a.l, b.l)) * Math.max(0, Math.min(a.b, b.b) - Math.max(a.t, b.t));
  for (let i = 0; i < parts.length; i++) for (let j = i + 1; j < parts.length; j++) {
    const a = parts[i].rs.reduce((s, x) => s + parts[j].rs.reduce((t, y) => t + area(x, y), 0), 0);
    if (a > 4) out.push(`${parts[i].name} × ${parts[j].name}: ${Math.round(a)}px²`);
  }
  return out;
};
const insertSteps = async (page, h, kinds) => {
  for (const k of kinds) {
    if (k === 'title' || k === 'list') await h.menu('text', k);
    else if (k === 'math') { page.__dialog = d => d.accept('E=mc^2'); await h.tb('[data-act="math"]'); await h.settle(300); }
    else if (k === 'rect') await h.menu('shape', 'rect');
    else await h.tb(`[data-act="${k}"]`);
    for (let i = 0; i < 3; i++) await page.keyboard.press('Escape');
  }
  await h.settle(300);
};

for (const width of [1280, 1600]) {
  test(`dark cover slide: six inserts in a row all land in visibly empty space (${width}px)`, async ({ page, h }) => {
    await h.edit();
    await insertSteps(page, h, ['table', 'table', 'title', 'list', 'math', 'table']);
    eq(overlapsOf(await visibleParts(page)), [], 'nothing visible overlaps');
  }, { fixture: DARK_FIXTURE, viewport: { width, height: Math.round(width * 0.625) } });
}

for (const width of [1280, 1600]) {
  test(`text + chart slide: three tables, a title, a list and a formula all find room (narrower tables if needed) (${width}px)`, async ({ page, h }) => {
    await h.go(2); await h.edit();
    await insertSteps(page, h, ['table', 'table', 'table', 'title', 'list', 'math']);
    eq(overlapsOf(await visibleParts(page)), [], 'nothing visible overlaps');
  }, { viewport: { width, height: Math.round(width * 0.625) } });
}

test('when nothing fits, the object overlaps and the toast says so (not "빈 곳")', async ({ page, h }) => {
  await h.go(2); await h.edit();
  await h.tb('[data-act="table"]');
  for (let i = 0; i < 3; i++) await page.keyboard.press('Escape');
  await h.tb('[data-act="table"]');
  const t = (await h.shadow('.toast')).text;
  expect(t.includes('overlaps') && !t.includes('placed in'), 'toast is honest: ' + t);
  for (let i = 0; i < 3; i++) await page.keyboard.press('Escape');
  await h.menu('shape', 'rect');
  const parts = await visibleParts(page);
  const words = parts.filter(p => /^(H2|H3)/.test(p.name) || p.name.startsWith('DIV:'));
  const shape = parts.filter(p => p.name.startsWith('DIV(free)'));
  eq(overlapsOf([...shape, ...parts.filter(p => p.name.startsWith('H2'))]), [], 'the shape does not hide the slide title');
  const cardText = await page.evaluate(() => [...document.querySelectorAll('main.deck > .slide.dk-current .card > *')].map(e => { const r = document.createRange(); r.selectNodeContents(e); const b = r.getBoundingClientRect(); return { l: b.left, t: b.top, r: b.right, b: b.bottom }; }));
  const sb = shape[0].rs[0];
  for (const c of cardText) expect(!cross(sb, c), 'the shape covers card background, not card text: ' + JSON.stringify([sb, c]));
}, { fixture: DARK_FIXTURE });

const BAR_FIXTURE = FIXTURE.replace('\n</main>', `
  <section class="slide">
    <h2 style="position:absolute; left:140px; top:60px; margin:0">위 제목</h2>
    <ul style="position:absolute; left:140px; top:190px; width:900px; margin:0">
      <li>첫 항목</li>
    </ul>
    <p style="position:absolute; left:140px; top:375px; width:900px; margin:0">아래 문단</p>
  </section>
\n</main>`);
test('text toolbar moves off what the growing text pushes it onto while typing', async ({ page, h }) => {
  await h.go(5); await h.edit();
  await h.clickText(h.cur('li'));
  const covered = async () => {
    const bar = await chromeRect(page, '.fmt');
    const os = [await textRect(h.cur('h2')), await textRect(h.cur('p'))];
    return os.filter(o => cross(bar, o)).map(o => JSON.stringify([bar, o]));
  };
  eq(await covered(), [], 'clear at first');
  const below = (await chromeRect(page, '.fmt')).t > (await textRect(h.cur('li'))).b;
  expect(below, 'the bar starts below the list (above is the heading)');
  for (const t of ['둘째 줄', '셋째 줄', '넷째 줄']) {
    await page.keyboard.press('Shift+Enter');
    await page.keyboard.type(t);
    await h.settle(100);
    eq(await covered(), [], 'clear after adding ' + t);
    expect(!cross(await chromeRect(page, '.fmt'), await textRect(h.cur('ul'))), 'never on the list itself');
  }
}, { fixture: BAR_FIXTURE, viewport: { width: 1440, height: 900 } });

test('a drag that starts exactly on the middle of a character still selects (heading into paragraph)', async ({ page, h }) => {
  await h.go(3); await h.edit();
  for (const i of [0, 1]) {
    await h.drag(await charPoint(h.cur('h2'), i), await charPoint(h.cur('p'), 2), 10);
    const t = await page.evaluate(() => getSelection().toString());
    expect(t.length > 2 && t.includes('인'), `char ${i}: selection made: ` + JSON.stringify(t));
    await page.keyboard.press('Escape'); await page.keyboard.press('Escape');
  }
}, { viewport: { width: 1280, height: 800 } });

test('every bullet selected and deleted: no empty bullet is left or saved; undo restores', async ({ page, h }) => {
  await h.go(1); await h.edit();
  const before = await h.deck();
  const lis = page.locator('main.deck > .slide.dk-current li');
  await h.drag(await charPoint(lis.nth(0), 0), { ...(await charPoint(lis.nth(2), 5)), x: (await charPoint(lis.nth(2), 5)).x + 40 }, 10);
  eq(await page.evaluate(() => getSelection().toString().replace(/\s+/g, ' ').trim()), '첫 번째 요점 두 번째 요점 세 번째 요점', 'all bullets selected');
  await page.keyboard.press('Backspace');
  await page.keyboard.press('Escape');
  const d = await h.deck();
  expect(!/<li>|<ul>|<br>/.test(d.split('<section')[2]), 'no empty bullet saved: ' + d.split('<section')[2]);
  eq(await h.texts('h2'), ['슬라이드 제목'], 'heading kept');
  for (let i = 0; i < 3 && (await h.deck()) !== before; i++) await page.keyboard.press('Meta+z');
  eq(await h.deck(), before, 'undo restores');
});

test('Enter on an empty last bullet ends the list with a paragraph after it', async ({ page, h }) => {
  await h.go(1); await h.edit();
  await h.clickText(page.locator('main.deck > .slide.dk-current li').nth(2));
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  await page.keyboard.type('결론');
  eq(await slideKids(page), ['H2:슬라이드 제목', 'UL:첫 번째 요점 두 번째 요점 세 번째 요점', 'P:결론'], 'a paragraph after the list');
  await page.keyboard.press('Escape');
  expect((await h.deck()).includes('<li>세 번째 요점</li>\n    </ul>\n    <p>결론</p>'), 'on its own line: ' + (await h.deck()).split('<section')[2]);
  await h.clickText(page.locator('main.deck > .slide.dk-current li').nth(2));
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Escape');
  expect(!(await h.deck()).includes('<li><br></li>'), 'an empty bullet left at the end is not saved');
});

test('⌘K at a caret in a slide-level paragraph inserts a plain <a href> (no inline style)', async ({ page, h }) => {
  await h.go(5); await h.edit();
  await h.clickText(page.locator('main.deck > .slide.dk-current p').nth(0));
  await page.keyboard.press('End');
  page.__dialog = d => d.accept('https://x.org');
  await page.keyboard.press('Meta+k');
  await h.settle(100);
  await page.keyboard.press('Escape');
  expect((await h.deck()).includes('<p>첫 번째 문단입니다.<a href="https://x.org">https://x.org</a></p>'), 'clean link: ' + (await h.deck()).match(/<p>첫[^\n]*/)[0]);
}, { fixture: RUN_FIXTURE });

test('edits across slide-level blocks keep one block per line in the saved file', async ({ page, h }) => {
  const section = async i => (await h.deck()).split('<section')[i + 1];
  const blankish = t => /\n[ \t]+\n/.test(t) || /<\/(h\d|p|ul|li)><(h\d|p|ul|li)/.test(t);
  await h.edit();
  // 1. Delete across the heading and the second bullet
  await h.go(1);
  await h.drag(await charPoint(h.cur('h2'), 3), await charPoint(page.locator('main.deck > .slide.dk-current li').nth(1), 2), 10);
  await page.keyboard.press('Delete');
  await page.keyboard.press('Escape');
  let t = await section(1);
  expect(/<h2>슬라이[^<]*<\/h2>\n    <ul>\n      <li>세 번째 요점<\/li>/.test(t) && !blankish(t), '1 delete across blocks: ' + t);
  // 2. Alt+↑ on the subtitle
  await h.go(0);
  await h.clickText(h.cur('.sub'));
  await page.keyboard.press('Alt+ArrowUp');
  await page.keyboard.press('Escape');
  t = await section(0);
  expect(t.includes('<p class="sub">한 줄 부제</p>\n    <h1>발표 제목</h1>\n    <p class="meta">') && !blankish(t), '2 Alt+↑: ' + t);
  await page.keyboard.press('Meta+z');
  // 3. A list over p + p
  await h.go(5);
  await h.drag(await charPoint(page.locator('main.deck > .slide.dk-current p').nth(0), 1), await charPoint(page.locator('main.deck > .slide.dk-current p').nth(1), 2), 10);
  await h.pick('list', '[data-fmt="ul"]');
  await page.keyboard.press('Escape');
  t = await section(5);
  expect(t.includes('<h2>AI가 쓴 슬라이드</h2>\n    <ul>\n      <li>첫 번째 문단입니다.</li>\n      <li>두 번째 문단입니다.</li>\n    </ul>\n  </section>') && !blankish(t), '3 list over p + p: ' + t);
  // 4. Paste two lines into the title
  await h.go(0);
  await h.clickText(h.cur('h1'), 'start');
  await page.keyboard.press('ArrowRight'); await page.keyboard.press('ArrowRight');
  await pasteText(page, '붙여\n넣기');
  await page.keyboard.press('Escape');
  t = await section(0);
  expect(!blankish(t) && !/<\/h1><h1>/.test(t), '4 paste two lines: ' + t);
}, { fixture: RUN_FIXTURE });

test('a classed paragraph turned into a bullet and back keeps its class', async ({ page, h }) => {
  await h.edit();
  await h.clickText(h.cur('.sub'));
  await h.pick('list', '[data-fmt="ul"]');
  await h.pick('list', '[data-fmt="unlist"]');
  await page.keyboard.press('Escape');
  expect((await h.deck()).includes('<p class="sub">한 줄 부제</p>'), 'class kept: ' + (await h.deck()).split('<section')[1]);
});

test('an AI change arriving while a Korean syllable is composing waits until typing pauses; nothing typed is lost', async ({ page, h }) => {
  await h.edit();
  await h.save();
  await h.clickText(h.cur('p.sub'));
  await h.ime('가나');
  await h.ime('다', { leaveComposing: true });
  h.writeDisk(h.disk().replace('<li>두 번째 요점</li>', '<li>AI가 고친 요점</li>'));
  await page.waitForTimeout(2600);
  expect((await h.state()).editing, 'still editing while composing');
  await h.cdp.send('Input.insertText', { text: '다' });
  await h.ime('라');
  await h.settle(300);
  eq(await page.evaluate(() => document.querySelector('main.deck > .slide .sub').textContent), '한 줄 부제가나다라', 'syllables typed once, in order');
  await page.waitForTimeout(2500);
  expect((await h.deck()).includes('AI가 고친 요점'), 'the AI change is merged once typing pauses');
  expect((await h.deck()).includes('한 줄 부제가나다라'), 'and the typing is kept');
}, { http: true });

test('Korean typed over a selection from the subtitle into the meta line saves no &nbsp;', async ({ page, h }) => {
  await h.edit();
  for (const withKey of [true, false]) {
    const before = await h.deck();
    await h.drag(await charPoint(h.cur('.sub'), 1), await charPoint(h.cur('.meta'), 2), 10);
    if (withKey) await h.cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Process', code: 'KeyR', windowsVirtualKeyCode: 229 });
    await h.ime('가나');
    if (withKey) await h.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Process', code: 'KeyR', windowsVirtualKeyCode: 229 });
    await h.settle(200);
    await page.keyboard.press('Escape');
    const d = await h.deck();
    expect(d.includes('<p class="sub">한가나 · 소속 · 날짜</p>') && !d.includes('&nbsp;'), (withKey ? 'with' : 'without') + ' keydown: plain spaces: ' + d.split('<section')[1]);
    for (let i = 0; i < 4 && (await h.deck()) !== before; i++) await page.keyboard.press('Meta+z');
    await page.keyboard.press('Escape');   // what was selected stays selected after ⌘Z; let go before dragging over text
  }
});

test('Alt+Delete twice at the end of a paragraph (joining the next one) saves no &nbsp;', async ({ page, h }) => {
  await h.go(5); await h.edit();
  await h.clickText(page.locator('main.deck > .slide.dk-current p').nth(0));
  await page.keyboard.press('End');
  await page.keyboard.press('Alt+Delete');
  await page.keyboard.press('Alt+Delete');
  await page.keyboard.press('Escape');
  const d = await h.deck();
  expect(!d.includes('&nbsp;'), 'no &nbsp;: ' + d.split('<section')[6]);
}, { fixture: RUN_FIXTURE });

// =====================================================================
// Night round 1
// =====================================================================
// Seven slides: the template's five, a list with sub-bullets and a link, and a table with merged cells.
const NIGHT = FIXTURE.replace('\n</main>', `
  <section class="slide">
    <h2>목록 단계</h2>
    <ul>
      <li>하나</li>
      <li>둘
        <ul>
          <li>둘-하위 가</li>
          <li>둘-하위 나</li>
          <li>둘-하위 다</li>
        </ul>
      </li>
      <li>셋 <a href="https://example.com/x">링크</a></li>
      <li>넷</li>
    </ul>
  </section>

  <section class="slide">
    <h2>병합된 표</h2>
    <table>
      <tr><th rowspan="2">모델</th><th colspan="2">정확도</th><th rowspan="2">비고</th></tr>
      <tr><th>CIFAR</th><th>ImageNet</th></tr>
      <tr><td>A</td><td>91.2</td><td>76.1</td><td>기준</td></tr>
      <tr><td>B</td><td>93.4</td><td>78.9</td><td>제안</td></tr>
    </table>
  </section>
\n</main>`);
// Put the caret at character `i` of the first text in `loc` (the element must already be edited).
const caretIn = (loc, i) => loc.evaluate((el, i) => {
  const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  let n;
  while ((n = w.nextNode())) {
    if (i <= n.length) { const r = document.createRange(); r.setStart(n, i); r.collapse(true); getSelection().removeAllRanges(); getSelection().addRange(r); return; }
    i -= n.length;
  }
}, i);
const slideTitles = page => page.evaluate(() => [...document.querySelectorAll('main.deck > .slide')].map(s => (s.querySelector('h1,h2') || {}).textContent));

test('multi-line paste into a new text box: line breaks inside the box, nothing escapes it after reload', async ({ page, h }) => {
  await h.go(1); await h.edit();
  await h.tb('[data-act="text"]');
  await page.keyboard.press('Meta+a');
  await pasteText(page, '첫 줄\n둘째 줄\n\n\n셋째 줄\n');
  await page.keyboard.press('Escape');
  const full = await page.evaluate(() => deckEdit.fullHTML());
  const box = /<p style="position: absolute;[^"]*">([\s\S]*?)<\/p>/.exec(full);
  expect(box, 'the text box is saved');
  eq(box[1], '첫 줄<br>둘째 줄<br><br>셋째 줄', 'three lines (one blank line kept) inside the box, no <div>');
  const after = await page.evaluate(full => {
    const doc = new DOMParser().parseFromString(full, 'text/html');
    const s = doc.querySelectorAll('main.deck > .slide')[1];
    const p = [...s.querySelectorAll('p')].find(x => x.textContent.includes('첫 줄'));
    return { text: p && p.innerHTML, kids: [...s.children].map(c => c.tagName + (c.tagName === 'P' && !c.textContent.trim() ? ':empty' : '')) };
  }, full);
  eq(after.text, '첫 줄<br>둘째 줄<br><br>셋째 줄', 'reloaded: all lines still in the box');
  eq(after.kids, ['H2', 'UL', 'P', 'ASIDE'], 'reloaded: no stray <div> or empty <p> on the slide');
});

test('multi-line paste into the title: one heading with a line break', async ({ page, h }) => {
  await h.edit();
  await h.clickText(h.cur('h1'));
  await pasteText(page, '가\n나');
  eq(await page.locator('main.deck > .slide.dk-current h1').count(), 1, 'one heading while editing');
  await page.keyboard.press('Escape');
  eq(await page.locator('main.deck > .slide.dk-current h1').evaluate(e => e.innerHTML), '발표 제목가<br>나', 'line break inside the heading');
  eq(await page.locator('main.deck > .slide.dk-current > *').evaluateAll(es => es.map(e => e.tagName)), ['H1', 'P', 'P'], 'nothing else added');
});

test('multi-line paste in the middle of a bullet: one bullet per line, each on its own source line; one undo', async ({ page, h }) => {
  await h.go(1); await h.edit();
  const before = await h.deck();
  await h.clickText(h.cur('li:nth-child(2)'), 'start');
  await caretIn(h.cur('li:nth-child(2)'), 2);
  await pasteText(page, 'A\nB\n\nC');
  eq(await h.texts('li'), ['첫 번째 요점', '두 A', 'B', 'C번째 요점', '세 번째 요점'], 'bullets');
  await page.keyboard.type('|');
  eq((await h.texts('li'))[3], 'C|번째 요점', 'caret after the last pasted line');
  await page.keyboard.press('Escape');
  const d = await h.deck();
  expect(/\n      <li>두 A<\/li>\n      <li>B<\/li>\n      <li>C\|번째 요점<\/li>\n      <li>세 번째 요점<\/li>/.test(d), 'each bullet on its own line: ' + d.slice(d.indexOf('<ul>'), d.indexOf('</ul>')));
  expect(!/<li>\s*(<br>)?\s*<\/li>/.test(d), 'no empty bullet');
  await page.keyboard.press('Meta+z');
  await page.keyboard.press('Meta+z');
  eq(await h.deck(), before, 'two undos (typing, paste) restore the list');
});

test('⌘Z right after an AI merge takes back only my edit; the AI change stays, is saved, and redo keeps it', async ({ page, h }) => {
  await h.go(1); await h.edit();
  await h.save();
  await h.clickText(h.cur('h2'));
  await page.keyboard.type(' 오타');
  await page.keyboard.press('Escape');
  await h.settle(300);
  h.writeDisk(h.disk().replace('<h2>수식</h2>', '<h2>AI 수식</h2>').replace('--accent: #2f5bea', '--accent: #e11d48'));
  await page.waitForFunction(() => document.querySelector('main.deck').innerHTML.includes('AI 수식'), null, { timeout: 5000 });
  const inner = () => page.evaluate(() => document.querySelector('main.deck').innerHTML);
  expect((await inner()).includes('오타'), 'merged: my typo still there');
  await page.keyboard.press('Meta+z');
  let now = await inner();
  expect(!now.includes('오타') && now.includes('AI 수식'), 'one ⌘Z: typo gone, AI change kept');
  await h.save();
  const disk = h.disk();
  expect(disk.includes('<h2>AI 수식</h2>') && !disk.includes('오타') && disk.includes('--accent: #e11d48'), 'disk has the AI change, not the typo');
  await page.keyboard.press('Meta+Shift+z');
  now = await inner();
  expect(now.includes('오타') && now.includes('AI 수식'), 'redo: typo back, AI change kept');
  await h.save();
  expect(h.disk().includes('슬라이드 제목 오타') && h.disk().includes('<h2>AI 수식</h2>'), 'saved both');
}, { http: true });

test('after a self-reload, reconnecting later merges a newer AI edit instead of overwriting it', async ({ page, h }) => {
  await h.go(2); await h.edit();
  await h.save();
  // From the next page load on, the browser asks again before letting the page write to the folder.
  await page.addInitScript(() => { window.__startPerm = 'prompt'; });
  // A new stylesheet link is the kind of change that reloads the page (slide edits are shown in place).
  fs.writeFileSync(path.join(h.dir, 'extra.css'), '');
  h.writeDisk(h.disk().replace('텍스트와 그림', 'AI가 바꾼 제목').replace('</head>', '<link rel="stylesheet" href="extra.css">\n</head>'));
  await page.waitForFunction(() => document.querySelector('main.deck > .slide.dk-current h2')?.textContent === 'AI가 바꾼 제목' && document.querySelector('link[href="extra.css"]'), null, { timeout: 5000 });
  await page.waitForFunction(() => window.deckEdit);
  await h.settle(400);
  eq((await h.state()).connected, false, 'not connected after the reload (permission prompt)');
  h.writeDisk(h.disk().replace('<h2>수식</h2>', '<h2>AI가 고친 수식</h2>'));
  await h.go(1);
  await h.clickText(h.cur('h2'));
  await page.keyboard.type(' 내 것');
  await page.keyboard.press('Escape');
  await h.save();
  expect(h.disk().includes('<h2>AI가 고친 수식</h2>'), 'the newer AI edit was not overwritten');
  await h.save();
  const disk = h.disk();
  expect(disk.includes('<h2>AI가 고친 수식</h2>') && disk.includes('<h2>슬라이드 제목 내 것</h2>') && disk.includes('AI가 바꾼 제목'), 'disk has both AI edits and mine');
}, { http: true });

async function conflictSetup(page, h) {
  await h.edit();
  await h.save();
  await page.evaluate(() => { window.__marker = 1; });
  await h.clickText(h.cur('h1'));
  await page.keyboard.type(' 내 제목');
  await page.keyboard.press('Escape');
  await h.go(3);
  await h.clickText(h.cur('h2'));
  await page.keyboard.type(' 내 것');
  await page.keyboard.press('Escape');
  await h.settle(300);
  h.writeDisk(h.disk().replace('한 줄 부제', 'AI 부제').replace('<h2>병합된 표</h2>', '<h2>AI 표</h2>')
    .replace('\n</main>', '\n  <section class="slide">\n    <h2>AI 새 장</h2>\n  </section>\n\n</main>'));
  await page.waitForFunction(() => document.querySelector('#dk-chrome').shadowRoot.querySelector('.banner').classList.contains('show'), null, { timeout: 5000 });
  const msg = (await h.shadow('.banner .msg')).text;
  expect(msg.includes('slide 1'), 'banner names slide 1: ' + msg);
  eq(await page.locator('#dk-sidebar .dk-thumb.dk-conflict').evaluateAll(ts => ts.map(t => +t.dataset.i)), [0], 'slide 1 thumbnail marked');
  eq((await slideTitles(page)).slice(6), ['AI 표', 'AI 새 장'], 'the AI changes nobody else touched are already in');
}
test('a conflict on one slide: "my version" keeps my slides 1 and 4 and the AI\'s slide 7 and new slide', async ({ page, h }) => {
  await conflictSetup(page, h);
  await h.act('keep');
  eq((await h.shadow('.banner')).display, 'none', 'banner gone');
  const t = await slideTitles(page);
  eq([t[0], t[3], t[6], t[7]], ['발표 제목 내 제목', '수식 내 것', 'AI 표', 'AI 새 장'], 'mine on 1 and 4, AI on 7 and 8');
  expect(!(await page.evaluate(() => document.querySelector('main.deck .sub').textContent)).includes('AI'), 'my slide 1 (no AI subtitle)');
  await h.save();
  const d = h.disk();
  expect(d.includes('발표 제목 내 제목') && d.includes('한 줄 부제') && d.includes('수식 내 것') && d.includes('AI 표') && d.includes('AI 새 장'), 'saved that way');
  eq(await page.evaluate(() => window.__marker), 1, 'page never reloaded');
}, { http: true, fixture: NIGHT });

test('a conflict on one slide: "AI version" takes only that slide from the AI, in place', async ({ page, h }) => {
  await conflictSetup(page, h);
  await h.act('reload');
  await h.settle(300);
  eq(await page.evaluate(() => window.__marker), 1, 'page not reloaded');
  eq((await h.shadow('.banner')).display, 'none', 'banner gone');
  const t = await slideTitles(page);
  eq([t[0], t[3], t[6], t[7]], ['발표 제목', '수식 내 것', 'AI 표', 'AI 새 장'], 'AI slide 1, my slide 4, AI 7 and new slide');
  eq(await page.evaluate(() => document.querySelector('main.deck .sub').textContent), 'AI 부제', 'AI subtitle');
  await h.save();
  const d = h.disk();
  expect(d.includes('AI 부제') && !d.includes('내 제목') && d.includes('수식 내 것') && d.includes('AI 새 장'), 'saved');
}, { http: true, fixture: NIGHT });

test('a conflict the AI then takes back clears the banner; saving works', async ({ page, h }) => {
  await h.go(1); await h.edit();
  await h.save();
  const orig = h.disk();
  await h.clickText(h.cur('h2'));
  await page.keyboard.type(' 내 것');
  await page.keyboard.press('Escape');
  await h.settle(300);
  h.writeDisk(orig.replace('<h2>슬라이드 제목</h2>', '<h2>AI 제목</h2>'));
  await page.waitForFunction(() => document.querySelector('#dk-chrome').shadowRoot.querySelector('.banner').classList.contains('show'), null, { timeout: 5000 });
  h.writeDisk(orig.replace('<h2>표와 이미지</h2>', '<h2>AI 표와 이미지</h2>'));
  await page.waitForFunction(() => !document.querySelector('#dk-chrome').shadowRoot.querySelector('.banner').classList.contains('show'), null, { timeout: 5000 });
  eq(await page.locator('#dk-sidebar .dk-thumb.dk-conflict').count(), 0, 'no thumbnail marked');
  await h.save();
  const d = h.disk();
  expect(d.includes('<h2>슬라이드 제목 내 것</h2>') && d.includes('<h2>AI 표와 이미지</h2>'), 'saved mine and the AI\'s later edit');
}, { http: true });

test('a half-written file is left alone until it is whole (clean, and with unsaved edits)', async ({ page, h }) => {
  await h.edit();
  await h.save();
  const full = h.disk().replace('<h1>발표 제목</h1>', '<h1>AI 제목</h1>');
  await page.evaluate(() => { window.__marker = 1; });
  h.writeDisk(full.slice(0, Math.round(full.length * 0.6)));
  await h.settle(2000);
  eq(await page.evaluate(() => window.__marker), 1, 'clean: no reload for a half file');
  eq((await h.state()).slides, 5, 'editor still has every slide');
  h.writeDisk(full);
  await page.waitForFunction(() => document.querySelector('main.deck h1')?.textContent === 'AI 제목', null, { timeout: 5000 });
  await page.waitForFunction(() => window.deckEdit && deckEdit.state.slides === 5);
  // with unsaved edits
  await h.go(1);
  await h.clickText(h.cur('h2'));
  await page.keyboard.type(' 내 것');
  await page.keyboard.press('Escape');
  const full2 = h.disk().replace('<h2>수식</h2>', '<h2>AI 수식</h2>');
  h.writeDisk(full2.slice(0, Math.round(full2.length * 0.6)));
  await h.settle(2000);
  eq((await h.shadow('.banner')).display, 'none', 'no banner for a half file');
  eq((await h.state()).slides, 5, 'no slides lost');
  h.writeDisk(full2);
  await page.waitForFunction(() => document.querySelector('main.deck').innerHTML.includes('AI 수식'), null, { timeout: 5000 });
  expect((await page.evaluate(() => document.querySelector('main.deck').innerHTML)).includes('슬라이드 제목 내 것'), 'mine kept');
}, { http: true });

const COMMENTED = (() => {
  let n = 0;
  return FIXTURE.replace(/\n  <!-- \d+\. [^>]*-->/g, '').replace(/\n  <section class="slide[^>]*>\n    <(h1|h2)>([^<]*)</g, (m, tag, title) => `\n  <!-- ${++n}. ${title} -->${m}`);
})();
test('comments between slides stay above their slide when slides are added, deleted and reordered', async ({ page, h }) => {
  const orig = h.disk();
  expect((orig.match(/<!-- \d\. /g) || []).length === 5, 'fixture has five slide comments');
  const chunk = n => { const i = orig.indexOf(`<!-- ${n}. `); return orig.slice(i, orig.indexOf('</section>', i) + 10); };
  await h.go(1); await h.edit();
  await h.save();
  await h.act('slide-new');
  await page.keyboard.press('Escape'); await page.keyboard.press('Escape');
  await h.save();
  eq(await slideTitles(page), ['발표 제목', '슬라이드 제목', 'Title', '텍스트와 그림', '수식', '표와 이미지'], 'inserted');
  await h.go(4);
  await h.menu('slide', 'del');
  await h.save();
  const thumbs = page.locator('#dk-sidebar .dk-thumb');
  await thumbs.nth(3).dragTo(thumbs.nth(2), { targetPosition: { x: 100, y: 4 } });
  eq(await slideTitles(page), ['발표 제목', '슬라이드 제목', '텍스트와 그림', 'Title', '표와 이미지'], 'reordered');
  await h.save();
  const d = h.disk();
  for (const n of [1, 2, 3, 5]) expect(d.includes(chunk(n)), `slide ${n} keeps its comment right above it, byte for byte`);
  expect(!d.includes('<!-- 4. '), 'the deleted slide took its comment along');
  const i = d.indexOf('<h2>Title</h2>');
  const gap = d.slice(d.lastIndexOf('</section>', i) + 10, d.lastIndexOf('<section', i));
  expect(!gap.trim(), 'the new slide has no comment above it: ' + JSON.stringify(gap));
  eq(d.slice(0, d.indexOf('<main')), orig.slice(0, orig.indexOf('<main')), 'head untouched');
}, { http: true, fixture: COMMENTED });

test('typing with something selected: letters go into a selected text, E presents only with nothing selected', async ({ page, h }) => {
  await h.go(4); await h.edit();
  await h.tb('[data-act="shape"]');
  eq((await h.state()).selected, 'Shape', 'shape selected');
  await page.keyboard.type('Enc');
  let s = await h.state();
  // A letter typed on a selected shape starts the shape's text (R3-09).
  eq([s.mode, s.count, s.selected, s.editing], ['edit', 1, 'Shape', true], 'shape: letters start its text');
  eq(await h.cur('.shape').textContent(), 'Enc', 'the shape holds the letters');
  await h.clickText(h.cur('h2'));
  await page.keyboard.press('Escape');
  eq((await h.state()).editing, false, 'heading selected, not edited');
  await page.keyboard.type('The');
  s = await h.state();
  eq([s.mode, s.editing], ['edit', true], 'typing starts editing');
  eq(await h.cur('h2').textContent(), '표와 이미지The', 'letters at the end of the heading');
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  eq((await h.state()).count, 0, 'nothing selected');
  await page.keyboard.press('e');
  eq((await h.state()).mode, 'present', 'E presents');
  await page.keyboard.press('e');
  await h.clickText(h.cur('p.withmath'));
  await page.keyboard.press('Escape');
  await h.cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Process', code: 'KeyR', windowsVirtualKeyCode: 229, nativeVirtualKeyCode: 15 });
  await h.ime('가');
  await h.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Process', code: 'KeyR', windowsVirtualKeyCode: 229, nativeVirtualKeyCode: 15 });
  expect((await h.cur('p.withmath').textContent()).endsWith('포함 문장가'), 'Korean typed on a selected paragraph lands at its end: ' + await h.cur('p.withmath').textContent());
  eq((await h.state()).editing, true, 'and edits it');
});

test('links on a slide never navigate while editing (drag or click), and do when presenting', async ({ page, h }) => {
  const navs = [];
  await page.route('https://example.com/**', r => r.fulfill({ status: 200, contentType: 'text/html', body: '<p>ok</p>' }));
  page.on('framenavigated', f => { if (f === page.mainFrame() && f.url().startsWith('https://example.com')) navs.push(f.url()); });
  await h.go(5); await h.edit();
  const url = page.url();
  const a = h.cur('a');
  await h.clickText(h.cur('li:nth-child(1)'));
  await page.keyboard.press('Escape');
  eq((await h.state()).selected, 'List', 'list selected');
  const c = await h.center(a);
  await h.drag(c, { x: c.x + 8, y: c.y }, 3);
  await h.settle(800);
  eq([navs, page.url()], [[], url], 'dragging the selected list by its link stays on the deck');
  await page.mouse.click(c.x + 8, c.y);
  await h.settle(800);
  eq([navs, page.url()], [[], url], 'clicking the link while editing stays on the deck');
  await page.keyboard.press('Escape'); await page.keyboard.press('Escape'); await page.keyboard.press('Escape');
  await page.evaluate(() => deckEdit.setMode('present'));
  const c2 = await h.center(a);
  await page.mouse.click(c2.x, c2.y);
  await page.waitForURL(/example\.com/, { timeout: 5000 });
  eq(navs.length, 1, 'presenting: the link opens');
  await page.goBack();
  await page.waitForFunction(() => window.deckEdit && deckEdit.state.slides > 0);
}, { fixture: NIGHT });

test('Enter over a selection from the title into the subtitle keeps both blocks; the caret starts the subtitle', async ({ page, h }) => {
  await h.edit();
  await h.drag(await charPoint(h.cur('h1'), 1), await charPoint(h.cur('p.sub'), 2), 10);
  const [head, tail, same] = await selEdges(page);
  expect(!same && head && tail, 'selection from the title into the subtitle');
  await page.keyboard.press('Enter');
  await page.keyboard.type('가');
  await page.keyboard.press('Escape');
  eq(await page.locator('main.deck > .slide.dk-current > *').evaluateAll(es => es.map(e => e.tagName + '.' + e.className + ':' + e.textContent)),
    ['H1.:' + head, 'P.sub:가' + tail, 'P.meta:이름 · 소속 · 날짜'], 'one heading, one subtitle that starts with what was typed');
});

test('Backspace at the start of a paragraph never merges it into a floating text box before it', async ({ page, h }) => {
  await h.go(4); await h.edit();
  const before = await h.deck();
  await h.clickText(h.cur('p.withmath'), 'start');
  await page.keyboard.press('Home');
  await page.keyboard.press('Backspace');
  await page.keyboard.press('Escape');
  eq(await h.deck(), before, 'both unchanged');
});

test('deleting from a bullet into a sub-bullet leaves no empty bullet; one undo restores', async ({ page, h }) => {
  await h.go(5); await h.edit();
  const before = await h.deck();
  const li = t => page.locator('main.deck > .slide.dk-current li').filter({ hasText: new RegExp('^' + t) }).first();
  await h.drag(await charPoint(li('하나'), 1), await charPoint(li('둘-하위 나'), 3), 10);
  const [head, tail] = await selEdges(page);
  await page.keyboard.press('Backspace');
  await page.keyboard.press('Escape');
  const d = await h.deck();
  expect(!/<li>\s*(<br>)?\s*<\/li>/.test(d), 'no blank bullet');
  const tree = await page.evaluate(() => {
    const walk = ul => [...ul.children].map(li => { const own = [...li.childNodes].filter(n => !(n.nodeType === 1 && /^(UL|OL)$/.test(n.tagName))).map(n => n.textContent).join('').trim(); const sub = li.querySelector(':scope > ul'); return sub ? [own, walk(sub)] : own; });
    return walk(document.querySelector('main.deck > .slide.dk-current > ul'));
  });
  eq(tree, [[head + tail, ['둘-하위 다']], '셋 링크', '넷'], 'joined bullet keeps the remaining sub-bullet');
  await page.keyboard.press('Meta+z');
  eq(await h.deck(), before, 'one ⌘Z restores');
}, { fixture: NIGHT });

const logicalWidths = page => page.evaluate(() => {
  const t = document.querySelector('main.deck > .slide.dk-current table');
  const rows = [...t.rows], g = rows.map(() => []);
  rows.forEach((tr, r) => { let c = 0; for (const cell of tr.cells) { while (g[r][c]) c++; for (let i = 0; i < cell.rowSpan; i++) for (let j = 0; j < cell.colSpan; j++) if (g[r + i]) g[r + i][c + j] = cell; c += cell.colSpan; } });
  return g.map(r => r.length);
});
test('table with merged cells: deleting and adding a column, and ↓, follow the columns as they look', async ({ page, h }) => {
  await h.go(6); await h.edit();
  const before = await h.deck();
  const cell = t => page.locator('main.deck > .slide.dk-current :is(td,th)').filter({ hasText: new RegExp('^' + t + '$') }).first();
  await h.clickText(cell('ImageNet'));
  await h.menu('col', 'col-del');
  const t1 = await page.evaluate(() => [...document.querySelector('main.deck > .slide.dk-current table').rows].map(r => [...r.cells].map(c => c.textContent + (c.colSpan > 1 ? '*' + c.colSpan : '')).join('|')));
  eq(t1, ['모델|정확도|비고', 'CIFAR', 'A|91.2|기준', 'B|93.4|제안'], 'ImageNet column gone, 정확도 narrower, CIFAR values kept');
  eq(await logicalWidths(page), [3, 3, 3, 3], 'every row the same width');
  await page.keyboard.press('Escape');
  await page.keyboard.press('Meta+z');
  eq(await h.deck(), before, 'undo');
  await h.clickText(cell('91.2'));
  await h.menu('col', 'col-right');
  eq(await logicalWidths(page), [5, 5, 5, 5], 'every row one wider');
  eq(await page.evaluate(() => [...document.querySelectorAll('main.deck > .slide.dk-current th')].find(c => c.textContent === '정확도').colSpan), 3, '정확도 spans the new column');
  await page.keyboard.press('Escape');
  await page.keyboard.press('Meta+z');
  await h.clickText(cell('CIFAR'));
  await page.keyboard.press('ArrowDown');
  eq(await page.evaluate(() => document.activeElement.textContent), '91.2', '↓ from CIFAR lands in the CIFAR column');
}, { fixture: NIGHT });

test('turned objects resize along their own sides; size readouts stay true', async ({ page, h }) => {
  await h.go(1); await h.edit();
  const sc = await page.evaluate(() => document.querySelector('main.deck > .slide.dk-current').getBoundingClientRect().width / 1920);
  await h.tb('[data-act="shape"]');
  for (let i = 0; i < 3; i++) await h.pick('objmore', '[data-obj="rotr"]');
  const shape = () => page.evaluate(() => { const el = document.querySelector('main.deck > .slide.dk-current .shape'); return { w: parseFloat(el.style.width), h: parseFloat(el.style.height), rot: el.style.rotate }; });
  eq((await shape()).rot, '45deg', 'turned 45°');
  let p = await h.handle('.sel .resize');
  await h.drag(p, { x: p.x + 3, y: p.y + 3 }, 3);
  let s = await shape();
  expect(Math.abs(s.w - 480) < 8 && Math.abs(s.h - 300) < 8 && s.rot === '45deg', 'a 3px drag keeps the size: ' + JSON.stringify(s));
  await page.keyboard.press('Delete');
  await h.tb('[data-act="arrow"]');
  for (let i = 0; i < 6; i++) await h.pick('objmore', '[data-obj="rotr"]');
  p = await h.handle('.endpt.head');
  await h.drag(p, { x: p.x, y: p.y + 60 * sc }, 6);
  s = await shape();
  expect(Math.abs(s.w - 660) < 8 && Math.abs(s.h - 40) < 3, 'arrow turned 90°: dragging down makes it longer: ' + JSON.stringify(s));
  await page.keyboard.press('Delete');
  // A plain shape: the size in the toolbar follows a free corner drag, and the live badge is never under a toolbar.
  await h.tb('[data-act="shape"]');
  p = await h.handle('.sel .resize');
  await page.mouse.move(p.x, p.y);
  await page.mouse.down();
  await page.mouse.move(p.x - 40, p.y - 10, { steps: 4 });
  const top = await page.locator('#dk-chrome').evaluate(host => {
    const b = host.shadowRoot.querySelector('.sizebadge'), r = b.getBoundingClientRect();
    return getComputedStyle(b).display !== 'none' && host.shadowRoot.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2) === b;
  });
  await page.mouse.up();
  expect(top, 'the live size badge is on top during the drag');
  const w = Math.round((await shape()).w);
  eq((await h.shadow('.otb .szl')).text, String(w), 'toolbar size shows the new width');
  // A turned picture: ＋ makes it 10% wider.
  await h.go(4);
  await page.mouse.click(...Object.values(await h.center(h.cur('img.pic'))));
  await h.pick('objmore', '[data-obj="rotr"]');
  await h.tb('[data-obj="bigger"]');
  eq(await h.cur('img.pic').evaluate(e => e.style.width), '220px', 'turned picture 200 → 220');
});

test('Tab and Shift+Tab change bullet levels; Backspace at a sub-bullet start goes up a level; one undo each', async ({ page, h }) => {
  await h.go(5); await h.edit();
  const before = await h.deck();
  const li = t => page.locator('main.deck > .slide.dk-current li').filter({ hasText: new RegExp('^' + t) }).first();
  const tree = () => page.evaluate(() => {
    const walk = ul => [...ul.children].map(li => { const own = [...li.childNodes].filter(n => !(n.nodeType === 1 && /^(UL|OL)$/.test(n.tagName))).map(n => n.textContent).join('').trim(); const sub = li.querySelector(':scope > ul'); return sub ? [own, walk(sub)] : own; });
    return walk(document.querySelector('main.deck > .slide.dk-current > ul'));
  });
  await h.clickText(li('하나'), 'start');
  await page.keyboard.press('Tab');
  eq(await h.deck(), before, 'Tab on the first bullet does nothing');
  await h.clickText(li('셋'), 'start');
  await caretIn(li('셋'), 1);
  await page.keyboard.press('Tab');
  eq(await tree(), ['하나', ['둘', ['둘-하위 가', '둘-하위 나', '둘-하위 다', '셋 링크']], '넷'], '셋 joins the sub-list under 둘');
  await page.keyboard.type('X');
  eq((await li('셋').textContent()).trim().replace(/\u00a0/g, ' '), '셋X 링크', 'caret kept');
  await page.keyboard.press('Escape');
  const d = await h.deck();
  expect(d.includes('<li>셋X <a href'), 'saved with a plain space');
  const ul = d.slice(d.indexOf('<h2>목록 단계</h2>'), d.indexOf('</section>', d.indexOf('<h2>목록 단계</h2>')));
  expect(!/[^\s]\s*<li/.test(ul.replace(/\n\s*<li/g, '')), 'every bullet on its own line:\n' + ul);
  await page.keyboard.press('Meta+z'); await page.keyboard.press('Meta+z');
  eq(await h.deck(), before, 'undo (typing, then Tab) restores');
  for (const how of ['Shift+Tab', 'Backspace']) {
    await h.clickText(li('둘-하위 가'), 'start');
    await caretIn(li('둘-하위 가'), 0);
    await page.keyboard.press(how);
    eq(await tree(), ['하나', '둘', ['둘-하위 가', ['둘-하위 나', '둘-하위 다']], '셋 링크', '넷'], how + ': one level up, later siblings under it');
    if (how === 'Shift+Tab') {
      await h.ime('가');
      expect((await li('가둘-하위 가').count()) === 1, 'IME typing right after works');
      await page.keyboard.press('Escape');
      await page.keyboard.press('Meta+z');
    } else await page.keyboard.press('Escape');
    await page.keyboard.press('Meta+z');
    eq(await h.deck(), before, how + ': undo restores');
  }
  await h.clickText(li('넷'));
  await h.pick('list', '[data-fmt="indent"]');
  eq((await tree())[2][1].slice(-1)[0], '넷', '들여쓰기 in the 목록 menu');
}, { fixture: NIGHT });

test('saved markup stays clean: moves fold into left/top, copies on their own line, short numbers, no blank lines, no zero-width or trailing &nbsp;', async ({ page, h }) => {
  await h.go(4); await h.edit();
  await h.save();
  const orig = h.disk();
  const sc = await page.evaluate(() => document.querySelector('main.deck > .slide.dk-current').getBoundingClientRect().width / 1920);
  // a floating text box moved by its grip
  await h.clickText(h.cur('p.free'));
  const g = await h.handle('.grip');
  await h.drag(g, { x: g.x - 100 * sc, y: g.y + 50 * sc }, 5);
  await page.keyboard.press('Escape'); await page.keyboard.press('Escape');
  let st = await h.cur('p.free').getAttribute('style');
  expect(!/translate/.test(st) && /left: 1100px/.test(st) && /top: 350px/.test(st), 'text box: ' + st);
  // a shape moved, then duplicated
  await h.tb('[data-act="shape"]');
  const c = await h.center(h.cur('.shape'));
  await h.drag(c, { x: c.x + 30 * sc, y: c.y + 20 * sc }, 5);
  st = await h.cur('.shape').getAttribute('style');
  expect(!/translate/.test(st), 'shape: ' + st);
  await page.keyboard.press('Meta+d');
  let d = await h.deck();
  expect(/\n    <div class="shape"[^\n]*><\/div>\n    <div class="shape"[^\n]*><\/div>\n/.test(d), 'the copy sits on its own line, indented like the original');
  expect(!/translate/.test(d.slice(d.indexOf('<h2>표와 이미지'))), 'the copy is placed by left/top too');
  // an arrow
  await page.keyboard.press('Escape');
  await h.tb('[data-act="arrow"]');
  d = await h.deck();
  const svg = d.slice(d.lastIndexOf('<svg class="shape"'), d.indexOf('</svg>', d.lastIndexOf('<svg class="shape"')));
  expect(!/\d\.\d\d/.test(svg.replace(/style="[^"]*"/g, '')), 'no long decimals in the arrow: ' + svg);
  // a trailing space typed at the end of a paragraph
  await h.clickText(h.cur('p.withmath'));
  await page.keyboard.type('a ');
  await page.keyboard.press('Escape');
  expect((await h.deck()).includes('포함 문장a</p>'), 'no trailing &nbsp;');
  // ∑ leaves no zero-width space in history or the file
  await h.clickText(h.cur('p.withmath'));
  page.__dialog = dl => dl.accept('y^2');
  await h.tb('[data-fmt="math"]');
  await page.keyboard.type('Q');
  await page.keyboard.press('Escape');
  const zw = async what => expect(!(await h.deck()).includes('​'), 'no zero-width space ' + what);
  await zw('after ∑');
  await page.keyboard.press('Meta+z'); await zw('after undo');
  await page.keyboard.press('Meta+z'); await zw('after undo 2');
  await page.keyboard.press('Meta+Shift+z'); await zw('after redo');
  await page.keyboard.press('Meta+Shift+z'); await zw('after redo 2');
  // deleting a list leaves no blank line
  await h.go(1);
  await h.clickText(h.cur('li'));
  await page.keyboard.press('Escape');
  eq((await h.state()).selected, 'List', 'list selected');
  await page.keyboard.press('Delete');
  expect((await h.deck()).includes('<h2>슬라이드 제목</h2>\n    <aside'), 'no whitespace-only line where the list was');
  await h.save();
  const disk = h.disk();
  for (const t of ['<h1>발표 제목</h1>', '<h2>텍스트와 그림</h2>', '<h2>수식</h2>']) {
    const i = orig.indexOf(t), a = orig.lastIndexOf('<section', i), b = orig.indexOf('</section>', i) + 10;
    expect(disk.includes(orig.slice(a, b)), 'untouched slide byte-identical: ' + t);
  }
  expect(!disk.includes('​') && !/&nbsp;<\/(p|li)>/.test(disk), 'file clean');
}, { http: true });

test('PDF keeps shape fills and slide backgrounds without the background option; Korean wraps at spaces', async ({ page, h }) => {
  await h.go(4); await h.edit();
  await h.tb('[data-act="shape"]');
  await page.keyboard.press('Escape');
  await page.emulateMedia({ media: 'print' });
  const adj = await page.evaluate(() => ['main.deck > .slide', 'main.deck > .slide .shape'].map(q => { const cs = getComputedStyle(document.querySelector(q)); return cs.printColorAdjust || cs.webkitPrintColorAdjust; }));
  eq(adj, ['exact', 'exact'], 'print keeps colors');
  await page.emulateMedia({ media: 'screen' });
  const breaks = await page.evaluate(() => {
    const p = document.createElement('p');
    p.style.cssText = 'position:absolute; left:100px; top:100px; width:420px; margin:0; font-size:40px';
    p.textContent = '모델이 학습 데이터에서 본 적 없는 조합을 고르고 일반화하는지 확인합니다';
    document.querySelector('main.deck > .slide.dk-current').appendChild(p);
    const t = p.firstChild, r = document.createRange(), out = [];
    let top = null;
    for (let i = 0; i < t.length; i++) {
      r.setStart(t, i); r.setEnd(t, i + 1);
      const b = r.getClientRects()[0];
      if (!b) continue;
      if (top !== null && b.top > top + 5) out.push(t.data[i - 1] === ' ' || t.data[i] === ' ');
      top = b.top;
    }
    p.remove();
    return out;
  });
  expect(breaks.length >= 2 && breaks.every(Boolean), 'every line break is at a space: ' + JSON.stringify(breaks));
  expect(!(await page.evaluate(() => deckEdit.fullHTML())).includes('keep-all'), 'nothing of it saved into an existing deck');
}, { fixture: FIXTURE.replace('    word-break: keep-all; overflow-wrap: break-word;\n', '') });

test('undo and redo go to the slide they change when it is not on screen', async ({ page, h }) => {
  await h.edit();
  await h.clickText(h.cur('p.sub'));
  await page.keyboard.type('X');
  await page.keyboard.press('Escape');
  await h.go(4);
  await page.keyboard.press('Meta+z');
  eq((await h.state()).cur, 0, 'undo went to slide 1');
  eq(await h.cur('p.sub').textContent(), '한 줄 부제', 'subtitle reverted');
  await h.go(2);
  await page.keyboard.press('Meta+Shift+z');
  eq((await h.state()).cur, 0, 'redo went to slide 1');
  eq(await h.cur('p.sub').textContent(), '한 줄 부제X', 'edit back');
  await h.go(1);
  await h.clickText(h.cur('h2'));
  await page.keyboard.type('Y');
  await page.keyboard.press('Escape');
  await page.keyboard.press('Meta+z');
  eq((await h.state()).cur, 1, 'undo on the slide on screen stays there');
});

test('slides: Delete and ⌘D with a thumbnail in focus, and the thumbnail menu (Duplicate, Delete, Move up, Move down)', async ({ page, h }) => {
  await h.edit();
  const before = await h.deck();
  const thumbs = page.locator('#dk-sidebar .dk-thumb');
  await thumbs.nth(6).click();
  await page.keyboard.press('Backspace');
  eq((await h.state()).slides, 6, 'deleted');
  expect((await h.shadow('.toast')).text.includes('Slide deleted'), 'toast');
  await page.keyboard.press('Meta+z');
  eq((await h.state()).slides, 7, 'undo');
  eq(await h.deck(), before, 'identical');
  await thumbs.nth(2).click();
  await page.keyboard.press('Meta+d');
  eq((await h.state()).slides, 8, 'duplicated');
  const same = await page.evaluate(() => { const s = [...document.querySelectorAll('main.deck > .slide')]; return s[3].innerHTML === s[2].innerHTML; });
  expect(same, 'slide 4 is a copy of slide 3');
  await page.keyboard.press('Meta+z');
  await thumbs.nth(1).click({ button: 'right' });
  eq(await page.locator('#dk-chrome').evaluate(h => h.shadowRoot.querySelectorAll('.menu.show .item').length), 4, 'menu with four entries');
  await h.tb('.menu [data-val="down"]');
  eq((await slideTitles(page)).slice(0, 3), ['발표 제목', '텍스트와 그림', '슬라이드 제목'], 'Move down swapped slides 2 and 3');
  await h.clickText(h.cur('h2'));
  await page.keyboard.press('Backspace');
  eq(await h.cur('h2').textContent(), '슬라이드 제', 'Backspace while typing deletes a letter');
  eq((await h.state()).slides, 7, 'no slide deleted');
}, { fixture: NIGHT });

// =====================================================================
// Round 2
// =====================================================================
const reparseStable = async page => {
  const r = await page.evaluate(() => {
    const text = document.documentElement.outerHTML;
    const out = deckEdit.composeFile('<!DOCTYPE html>\n' + text);
    return [deckEdit.deckFromText(out), deckEdit.deckHTML()];
  });
  eq(r[0], r[1], 'reparse-stable');
};
const ulTexts = page => page.evaluate(() => [...document.querySelectorAll('main.deck > .slide.dk-current > ul > li')].map(li => li.textContent.trim()));

test('R2-01 ⌘A in a bullet then typing replaces the list text, never the heading', async ({ page, h }) => {
  await h.go(1); await h.edit();
  await h.clickText(h.cur('li:nth-child(2)'));
  await page.keyboard.press('Meta+a');
  await page.keyboard.type('X');
  eq(await h.cur('h2').textContent(), '슬라이드 제목', 'heading unchanged');
  eq(await ulTexts(page), ['X'], 'one bullet holding X');
  await page.keyboard.press('Escape');
  await reparseStable(page);
});
test('R2-01 ⌘A in a bullet then Backspace, IME and paste', async ({ page, h }) => {
  await h.go(1); await h.edit();
  await h.clickText(h.cur('li:nth-child(2)'));
  await page.keyboard.press('Meta+a');
  await page.keyboard.press('Backspace');
  await page.keyboard.type('Y');
  eq(await h.cur('h2').textContent(), '슬라이드 제목', 'heading unchanged (Backspace)');
  eq(await ulTexts(page), ['Y'], 'one bullet holding Y');
  await page.keyboard.press('Escape'); await page.keyboard.press('Meta+z'); await page.keyboard.press('Meta+z');
  await page.keyboard.press('Escape'); await page.keyboard.press('Escape');
  eq(await ulTexts(page), ['첫 번째 요점', '두 번째 요점', '세 번째 요점'], 'undo restored');
  await h.clickText(h.cur('li:nth-child(2)'));
  await page.keyboard.press('Meta+a');
  await h.cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Process', code: 'KeyR', windowsVirtualKeyCode: 229, nativeVirtualKeyCode: 15 });
  await h.ime('가');
  await h.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Process', code: 'KeyR', windowsVirtualKeyCode: 229, nativeVirtualKeyCode: 15 });
  await h.settle(100);
  eq(await h.cur('h2').textContent(), '슬라이드 제목', 'heading unchanged (IME)');
  eq(await ulTexts(page), ['가'], 'exactly one 가');
  await page.keyboard.press('Escape');
  await reparseStable(page);
  await page.keyboard.press('Meta+z');
  await page.keyboard.press('Escape'); await page.keyboard.press('Escape');
  eq(await ulTexts(page), ['첫 번째 요점', '두 번째 요점', '세 번째 요점'], 'undo restored (IME)');
  await h.clickText(h.cur('li:nth-child(2)'));
  await page.keyboard.press('Meta+a');
  await pasteText(page, 'a\nb');
  eq(await h.cur('h2').textContent(), '슬라이드 제목', 'heading unchanged (paste)');
  eq(await ulTexts(page), ['a', 'b'], 'two bullets');
  await page.keyboard.press('Escape');
  await reparseStable(page);
});

const NEST = FIXTURE.replace('\n</main>', `
  <section class="slide">
    <h2>방법</h2>
    <ul>
      <li>첫 번째 요점
        <ul>
          <li>하위 가</li>
          <li>하위 나</li>
        </ul>
      </li>
      <li>두 번째 요점</li>
      <li>세 번째 요점</li>
    </ul>
  </section>
\n</main>`);
const selText = page => page.evaluate(() => getSelection().toString());
test('R2-02 Shift+Home / Shift+End select one line in a nested list and a text column', async ({ page, h }) => {
  await h.go(5); await h.edit();
  const li = t => page.locator('main.deck > .slide.dk-current li').filter({ hasText: new RegExp('^' + t) }).first();
  await h.clickText(li('두 번째'));
  await page.keyboard.press('Shift+Home');
  eq(await selText(page), '두 번째 요점', 'Shift+Home at the end of bullet 2');
  await h.clickText(li('세 번째'));
  await page.keyboard.press('Shift+Home');
  eq(await selText(page), '세 번째 요점', 'Shift+Home on the last bullet');
  await h.clickText(li('첫 번째'), 'start');
  await page.keyboard.press('Home');
  await page.keyboard.press('Shift+End');
  eq((await selText(page)).trim(), '첫 번째 요점', 'Shift+End stays on bullet 1');
  await page.keyboard.type('x');
  await page.keyboard.press('Escape');
  const tree = await page.evaluate(() => [...document.querySelectorAll('main.deck > .slide.dk-current li')].map(l => [...l.childNodes].filter(n => n.nodeType === 3).map(n => n.data).join('').trim()));
  eq(tree, ['x', '하위 가', '하위 나', '두 번째 요점', '세 번째 요점'], 'typing over it leaves the other bullets');
  await page.keyboard.press('Escape');
  await h.go(2);
  await h.clickText(h.cur('h3'), 'start');
  await page.keyboard.press('Home');
  await page.keyboard.press('Shift+End');
  eq(await selText(page), '소제목입니다', 'text column heading: only its line');
  await page.keyboard.press('End');
  await page.keyboard.type('!');
  eq(await h.cur('h3').textContent(), '소제목입니다!', 'End goes to the end of the heading line');
}, { fixture: NEST.replace('<div>\n        <p>왼쪽에 설명을 둡니다.</p>\n      </div>', '<div>\n        <h3>소제목입니다</h3>\n        <p>왼쪽에 설명을 둡니다.</p>\n      </div>') });

test('R2-03 ⌘Z and ⌘⇧Z while typing keep typing in the same bullet; a selected shape stays selected', async ({ page, h }) => {
  await h.go(1); await h.edit();
  const li1 = h.cur('li:nth-child(1)');
  await h.clickText(li1);
  await page.keyboard.type(' 오타abc');
  await page.waitForTimeout(700);
  await page.keyboard.type('def');
  await page.keyboard.press('Meta+z');
  let s = await h.state();
  eq(s.editing, true, 'still editing after ⌘Z');
  expect(await page.evaluate(() => document.querySelector('main.deck > .slide.dk-current').contains(document.activeElement)), 'focus in the slide');
  eq(await li1.textContent(), '첫 번째 요점 오타abc', 'typing undone');
  await page.keyboard.type('xe');
  eq((await h.state()).mode, 'edit', 'still editing (E typed as text)');
  eq(await li1.textContent(), '첫 번째 요점 오타abcxe', 'letters go into the bullet');
  await page.waitForTimeout(600);
  await page.keyboard.press('Meta+z');
  await page.keyboard.press('Meta+Shift+z');
  s = await h.state();
  eq(s.editing, true, 'still editing after ⌘⇧Z');
  await page.keyboard.type('ye');
  eq((await h.state()).mode, 'edit', 'mode stays edit');
  eq(await li1.textContent(), '첫 번째 요점 오타abcxeye', 'redo then typing');
  await page.keyboard.press('Escape'); await page.keyboard.press('Escape'); await page.keyboard.press('Escape');
  await h.tb('[data-act="shape"]');
  await h.drag(await h.center(h.cur('.shape')), { x: (await h.center(h.cur('.shape'))).x + 60, y: (await h.center(h.cur('.shape'))).y });
  await page.keyboard.press('Meta+z');
  eq((await h.state()).selected, 'Shape', 'shape still selected after ⌘Z');
  await page.keyboard.press('Delete');
  eq(await page.locator('main.deck > .slide.dk-current .shape').count(), 0, 'Delete removes it');
});

const waitToast = (page, text, timeout = 6000) => page.waitForFunction(t => (document.querySelector('#dk-chrome').shadowRoot.querySelector('.toast.show') || {}).textContent?.includes(t), text, { timeout });
const editH1 = async (page, h, text) => {
  await h.go(0);
  await h.clickText(h.cur('h1'));
  await page.keyboard.type(text);
  await page.keyboard.press('Escape');
};
for (const [name, act] of [
  ['thumbnail ⌘D', async (page, h) => { await page.locator('#dk-sidebar .dk-thumb').nth(2).click(); await page.keyboard.press('Meta+d'); }],
  ['drag reorder', async (page, h) => { const t = page.locator('#dk-sidebar .dk-thumb'); await t.nth(3).dragTo(t.nth(2), { targetPosition: { x: 100, y: 4 } }); }],
  ['Move up menu', async (page, h) => { await page.locator('#dk-sidebar .dk-thumb').nth(3).click({ button: 'right' }); await h.tb('.menu [data-val="up"]'); }],
  ['Move down menu', async (page, h) => { await page.locator('#dk-sidebar .dk-thumb').nth(1).click({ button: 'right' }); await h.tb('.menu [data-val="down"]'); }],
  ['Duplicate slide', async (page, h) => { await h.go(2); await h.menu('slide', 'dup'); }],
  ['delete', async (page, h) => { await h.go(3); await h.menu('slide', 'del'); }],
  ['new slide', async (page, h) => { await h.go(2); await h.act('slide-new'); await page.keyboard.press('Escape'); await page.keyboard.press('Escape'); }],
]) {
  test(`R2-04 after a ${name} is saved, the next ⌘S saves the next edit (comments between slides)`, async ({ page, h }) => {
    await h.edit();
    await h.save();
    await act(page, h);
    await h.save();
    await editH1(page, h, ' 다음 편집');
    await page.keyboard.press('Meta+s');
    await waitToast(page, 'Saved');
    expect(h.disk().includes('발표 제목 다음 편집'), 'disk has the edit');
    eq((await h.state()).dirty, false, 'clean');
  }, { http: true, fixture: COMMENTED });
}
test('R2-04 a real AI edit between two saves still merges', async ({ page, h }) => {
  await h.edit();
  await h.save();
  await page.locator('#dk-sidebar .dk-thumb').nth(2).click(); await page.keyboard.press('Meta+d');
  await h.save();
  await editH1(page, h, ' 내 편집');
  h.writeDisk(h.disk().replace('<h2>수식</h2>', '<h2>AI 수식</h2>'));
  await h.save();
  await h.save();
  const d = h.disk();
  expect(d.includes('<h2>AI 수식</h2>') && d.includes('발표 제목 내 편집'), 'both kept');
}, { http: true, fixture: COMMENTED });

const SPACE = FIXTURE.replace('<li>두 번째 요점</li>', '<li>한 번에 전체 시퀀스를 처리</li>');
test('R2-05 spaces survive paste, Enter and typing over a selection at a split or join', async ({ page, h }) => {
  await h.go(1); await h.edit();
  const li = n => h.cur(`li:nth-child(${n})`);
  await h.clickText(li(2));
  await caretIn(li(2), 4);
  await pasteText(page, 'A\nB');
  eq(await h.texts('li'), ['첫 번째 요점', '한 번에A', 'B 전체 시퀀스를 처리', '세 번째 요점'], 'pasted lines');
  await page.keyboard.press('Escape');
  expect((await h.deck()).includes('<li>B 전체 시퀀스를 처리</li>'), 'saved with a plain space');
  await page.keyboard.press('Meta+z');
  await page.keyboard.press('Escape'); await page.keyboard.press('Escape');
  await h.clickText(li(2));
  await caretIn(li(2), 4);
  await page.keyboard.press('Enter');
  await page.keyboard.type('C');
  await page.keyboard.press('Escape');
  eq(await h.texts('li'), ['첫 번째 요점', '한 번에', 'C 전체 시퀀스를 처리', '세 번째 요점'], 'Enter then C');
  expect((await h.deck()).includes('<li>C 전체 시퀀스를 처리</li>'), 'C and a plain space');
  // select from after '첫 ' to the end of bullet 3 (now 4) and type
  await h.clickText(li(1));
  await page.evaluate(() => {
    const lis = document.querySelectorAll('main.deck > .slide.dk-current li');
    const a = lis[0].firstChild, z = lis[lis.length - 1].firstChild;
    getSelection().setBaseAndExtent(a, 2, z, z.length);
  });
  await page.keyboard.type('k');
  await page.keyboard.press('Escape');
  eq(await h.texts('li'), ['첫 k'], 'typed after the space');
  const d = await h.deck();
  expect(d.includes('<li>첫 k</li>') && !d.includes('&nbsp;'), 'plain space, no &nbsp;: ' + d.slice(d.indexOf('<ul>'), d.indexOf('</ul>')));
  await page.keyboard.press('Meta+z');
  await page.keyboard.press('Escape'); await page.keyboard.press('Escape');
  await h.clickText(li(1));
  await page.evaluate(() => {
    const lis = document.querySelectorAll('main.deck > .slide.dk-current li');
    const a = lis[0].firstChild, z = lis[lis.length - 1].firstChild;
    getSelection().setBaseAndExtent(a, 2, z, z.length);
  });
  await h.cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Process', code: 'KeyG', windowsVirtualKeyCode: 229, nativeVirtualKeyCode: 5 });
  await h.ime('한');
  await h.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Process', code: 'KeyG', windowsVirtualKeyCode: 229, nativeVirtualKeyCode: 5 });
  await h.settle(100);
  await page.keyboard.press('Escape');
  eq(await h.texts('li'), ['첫 한'], 'IME after the space');
  expect((await h.deck()).includes('<li>첫 한</li>'), 'saved plain');
}, { fixture: SPACE });
test('R2-05 Shift+↑ selection over bullets, then Korean, keeps the space before it', async ({ page, h }) => {
  await h.go(1); await h.edit();
  const li = n => h.cur(`li:nth-child(${n})`);
  await h.clickText(li(4));
  await caretIn(li(4), 2);
  for (let i = 0; i < 3; i++) await page.keyboard.press('Shift+ArrowUp');
  await h.cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Process', code: 'KeyG', windowsVirtualKeyCode: 229, nativeVirtualKeyCode: 5 });
  await h.ime('한');
  await h.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Process', code: 'KeyG', windowsVirtualKeyCode: 229, nativeVirtualKeyCode: 5 });
  await h.settle(100);
  await page.keyboard.press('Escape');
  const t = await h.texts('li');
  eq(t, ['첫 한번째 요점'], 'one bullet, space kept');
  expect(!(await h.deck()).includes('&nbsp;'), 'no &nbsp;');
}, { fixture: FIXTURE.replace('<li>세 번째 요점</li>', '<li>세 번째 요점</li>\n      <li>넷 번째 요점</li>') });

// R2-06
const NEST2 = NEST.replace('\n</main>', `
  <section class="slide">
    <p>설명 문단입니다</p>
    <ul>
      <li>첫 번째 요점
        <ul>
          <li>하위 가</li>
          <li>하위 나</li>
        </ul>
      </li>
      <li>두 번째 요점</li>
    </ul>
  </section>
\n</main>`);
const treeOf = page => page.evaluate(() => {
  const walk = ul => [...ul.children].map(li => { const own = [...li.childNodes].filter(n => !(n.nodeType === 1 && /^(UL|OL)$/.test(n.tagName))).map(n => n.textContent).join('').trim(); const sub = li.querySelector(':scope > ul, :scope > ol'); return sub ? [own, walk(sub)] : own; });
  const ul = document.querySelector('main.deck > .slide.dk-current > ul');
  return ul ? walk(ul) : null;
});
const undoRedoAll = async (page, h, first, last) => {
  await page.keyboard.press('Escape'); await page.keyboard.press('Escape');
  for (let i = 0; i < 12 && (await h.state()).hi > 0; i++) await page.keyboard.press('Meta+z');
  await page.keyboard.press('Escape'); await page.keyboard.press('Escape');
  eq(await h.deck(), first, 'undo all');
  for (let i = 0; i < 12 && (await h.state()).hi < (await h.state()).hist - 1; i++) await page.keyboard.press('Meta+Shift+z');
  await page.keyboard.press('Escape'); await page.keyboard.press('Escape');
  eq(await h.deck(), last, 'redo all');
};
test('R2-06 Enter at the end of a parent bullet makes a sibling bullet, sub-bullets follow it', async ({ page, h }) => {
  await h.go(5); await h.edit();
  const first = await h.deck();
  const li = t => page.locator('main.deck > .slide.dk-current li').filter({ hasText: new RegExp('^' + t) }).first();
  await h.clickText(li('첫 번째'));
  await caretIn(li('첫 번째'), 7);
  await page.keyboard.press('Enter');
  await page.keyboard.type('NEW');
  await page.keyboard.press('Escape');
  eq(await treeOf(page), ['첫 번째 요점', ['NEW', ['하위 가', '하위 나']], '두 번째 요점', '세 번째 요점'], 'NEW is a top-level bullet');
  const d = await h.deck();
  expect(!/<li>\s*(<br>)?\s*<\/li>/.test(d) && !/<br>\s*<ul>/.test(d), 'no empty bullet or stray break: ' + d.slice(d.indexOf('<h2>방법'), d.indexOf('</section>', d.indexOf('<h2>방법'))));
  await reparseStable(page);
  await undoRedoAll(page, h, first, d);
}, { fixture: NEST });
test('R2-06 deleting from a heading or paragraph into a parent bullet never puts bullets in the heading', async ({ page, h }) => {
  await h.go(5); await h.edit();
  let first = await h.deck();
  await h.clickText(h.cur('h2'));
  await page.evaluate(() => {
    const s = document.querySelector('main.deck > .slide.dk-current');
    const a = s.querySelector('h2').firstChild, z = s.querySelector('li').firstChild;
    getSelection().setBaseAndExtent(a, 2, z, 2);
  });
  await page.keyboard.press('Backspace');
  await page.keyboard.press('Escape');
  eq(await h.cur('h2').evaluate(e => e.querySelector('ul, li') ? 'has list' : e.textContent), '방법번째 요점', 'heading holds only text');
  eq(await treeOf(page), ['하위 가', '하위 나', '두 번째 요점', '세 번째 요점'], 'sub-bullets took the bullet\'s place');
  let d = await h.deck();
  expect(d.includes('<h2>방법번째 요점</h2>\n    <ul>\n      <li>하위 가</li>\n      <li>하위 나</li>\n      <li>두 번째 요점</li>'), 'one bullet per line: ' + d.slice(d.indexOf('<h2>방법'), d.indexOf('</ul>', d.indexOf('<h2>방법'))));
  await reparseStable(page);
  await undoRedoAll(page, h, first, d);
  await page.keyboard.press('Meta+z');
  await h.go(6);
  first = await h.deck();
  await h.clickText(h.cur('p'));
  await page.evaluate(() => {
    const s = document.querySelector('main.deck > .slide.dk-current');
    const a = s.querySelector('p').firstChild, z = s.querySelector('li').firstChild;
    getSelection().setBaseAndExtent(a, 3, z, 2);
  });
  await page.keyboard.press('Backspace');
  await page.keyboard.press('Escape');
  eq(await h.cur('p').evaluate(e => e.querySelector('ul, li') ? 'has list' : e.textContent), '설명 번째 요점', 'paragraph holds only text');
  eq(await treeOf(page), ['하위 가', '하위 나', '두 번째 요점'], 'sub-bullets stay a list');
  d = await h.deck();
  await reparseStable(page);
}, { fixture: NEST2 });
test('R2-06 목록 해제 over a parent bullet and its sub-bullets makes sibling paragraphs', async ({ page, h }) => {
  await h.go(5); await h.edit();
  const first = await h.deck();
  const li = t => page.locator('main.deck > .slide.dk-current li').filter({ hasText: new RegExp('^' + t) }).first();
  await h.clickText(li('첫 번째'));
  await page.evaluate(() => {
    const lis = [...document.querySelectorAll('main.deck > .slide.dk-current li')];
    const a = lis[0].firstChild, z = lis[3].firstChild;
    getSelection().setBaseAndExtent(a, 0, z, z.length);
  });
  await h.pick('list', '[data-fmt="unlist"]');
  await page.keyboard.press('Escape');
  const kids = await slideKids(page);
  eq(kids, ['H2:방법', 'P:첫 번째 요점', 'P:하위 가', 'P:하위 나', 'P:두 번째 요점', 'UL:세 번째 요점'], 'paragraphs, then the rest of the list');
  expect(!(await h.deck()).match(/<p>[^<]*<p>/), 'no paragraph inside a paragraph');
  const d = await h.deck();
  await reparseStable(page);
  await undoRedoAll(page, h, first, d);
  await page.keyboard.press('Meta+z');
  await page.keyboard.press('Escape'); await page.keyboard.press('Escape');
  // only the parent and the first sub-bullet
  await h.clickText(li('첫 번째'));
  await page.evaluate(() => {
    const lis = [...document.querySelectorAll('main.deck > .slide.dk-current li')];
    getSelection().setBaseAndExtent(lis[0].firstChild, 0, lis[1].firstChild, 2);
  });
  await h.pick('list', '[data-fmt="unlist"]');
  await page.keyboard.press('Escape');
  eq(await slideKids(page), ['H2:방법', 'P:첫 번째 요점', 'P:하위 가', 'UL:하위 나 두 번째 요점 세 번째 요점'], 'the rest stays a list');
  await reparseStable(page);
}, { fixture: NEST });

test('R2-07 ⌘S while still typing saves clean markup; the pill says saved; a second ⌘S writes nothing', async ({ page, h }) => {
  await h.go(1); await h.edit();
  await h.save();
  await h.clickText(h.cur('li:nth-child(1)'));
  await page.keyboard.type(' 끝 ');
  await page.keyboard.press('Enter');
  await h.save();
  let d = h.disk();
  expect(d.includes('<li>첫 번째 요점 끝</li>'), 'bullet saved clean: ' + d.slice(d.indexOf('<ul>'), d.indexOf('</ul>')));
  expect(!/<li>\s*(<br>)?\s*<\/li>/.test(d) && !d.includes('&nbsp;'), 'no empty bullet, no &nbsp;: ' + d.slice(d.indexOf('<ul>'), d.indexOf('</ul>')));
  eq((await h.state()).editing, true, 'still typing');
  expect((await h.shadow('.status')).text.includes('Saved'), 'pill says saved: ' + (await h.shadow('.status')).text);
  const writes = await page.evaluate(() => window.__writes);
  await h.save();
  eq(await page.evaluate(() => window.__writes), writes, 'second ⌘S writes nothing');
  await page.keyboard.press('Escape');
  expect((await h.shadow('.status')).text.includes('Saved'), 'still saved after Esc');
  await page.keyboard.press('Escape');
  await h.clickText(h.cur('h2'));
  await page.keyboard.press('Shift+Enter');
  await h.save();
  expect(h.disk().includes('<h2>슬라이드 제목</h2>'), 'heading saved without line breaks');
}, { http: true });
test('R2-07 cleanup: &nbsp; before a formula, an emptied formula, an emptied bold word', async ({ page, h }) => {
  await h.go(4); await h.edit();
  await h.clickText(h.cur('p.withmath'));
  await page.keyboard.type(' x ');
  page.__dialog = dl => dl.accept('y^2');
  await h.tb('[data-fmt="math"]');
  await page.keyboard.press('Escape');
  let d = await h.deck();
  expect(d.includes('x <span class="math">y^2</span>'), 'plain space before the formula: ' + d.slice(d.indexOf('<p class="withmath">'), d.indexOf('</p>', d.indexOf('<p class="withmath">'))));
  await page.keyboard.press('Escape');
  // delete the TeX of the first formula
  const m = h.cur('p.withmath .math').first();
  await m.dblclick();
  await page.keyboard.press('Meta+a');
  await page.keyboard.press('Backspace');
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  eq(await page.locator('main.deck > .slide.dk-current p.withmath .math').count(), 1, 'the emptied formula is gone');
  expect(!/<span class="math">\s*<\/span>/.test(await h.deck()), 'no empty formula saved');
  eq((await h.state()).count, 0, 'nothing selected');
  // bold word at the start of a cross-block delete
  await h.go(1);
  await h.clickText(h.cur('li:nth-child(1)'));
  await page.evaluate(() => {
    const lis = document.querySelectorAll('main.deck > .slide.dk-current li');
    const b = lis[0].querySelector('b').firstChild;
    getSelection().setBaseAndExtent(b, 0, lis[1].firstChild, 2);
  });
  await page.keyboard.press('Backspace');
  await page.keyboard.press('Escape');
  d = await h.deck();
  expect(!/<b>\s*<\/b>/.test(d), 'no empty <b>: ' + d.slice(d.indexOf('<ul>'), d.indexOf('</ul>')));
}, { fixture: FIXTURE.replace('<li>첫 번째 요점</li>', '<li><b>굵은</b> 첫 번째 요점</li>') });

test('R2-08 merges without a banner: an AI slide after my edited slide, both adding at the end, AI deleting my neighbour', async ({ page, h }) => {
  await h.edit();
  await h.save();
  // (a) I edit slide 4, the AI adds a slide after it
  await h.go(3);
  await h.clickText(h.cur('h2'));
  await page.keyboard.type(' 내 것');
  await page.keyboard.press('Escape');
  await h.settle(300);
  h.writeDisk(h.disk().replace('<h2>표와 이미지</h2>', '<h2>표와 이미지</h2>').replace('  <section class="slide">\n    <h2>표와 이미지</h2>', '  <section class="slide">\n    <h2>AI 끼운 장</h2>\n  </section>\n\n  <section class="slide">\n    <h2>표와 이미지</h2>'));
  await page.waitForFunction(() => document.querySelectorAll('main.deck > .slide').length === 6, null, { timeout: 6000 });
  eq((await h.shadow('.banner')).display, 'none', '(a) no banner');
  eq(await slideTitles(page), ['발표 제목', '슬라이드 제목', '텍스트와 그림', '수식 내 것', 'AI 끼운 장', '표와 이미지'], '(a) both in order');
  await h.save();
  expect(h.disk().includes('수식 내 것') && h.disk().includes('AI 끼운 장'), '(a) saved both');
  // (b) both add a slide at the end
  await page.locator('#dk-sidebar .dk-add-slide').click();
  await page.keyboard.press('Escape'); await page.keyboard.press('Escape');
  await h.settle(300);
  h.writeDisk(h.disk().replace('\n</main>', '\n  <section class="slide">\n    <h2>AI 끝 장</h2>\n  </section>\n\n</main>'));
  await page.waitForFunction(() => document.querySelectorAll('main.deck > .slide').length === 8, null, { timeout: 6000 });
  eq((await h.shadow('.banner')).display, 'none', '(b) no banner');
  eq((await slideTitles(page)).slice(6), ['Title', 'AI 끝 장'], '(b) mine then the AI\'s');
  await h.save();
  // (c) I edit slide 4, the AI deletes slide 5
  await h.go(3);
  await h.clickText(h.cur('h2'));
  await page.keyboard.type('!');
  await page.keyboard.press('Escape');
  await h.settle(300);
  const disk = h.disk(), i = disk.indexOf('<h2>AI 끼운 장</h2>');
  h.writeDisk(disk.slice(0, disk.lastIndexOf('  <section', i)) + disk.slice(disk.indexOf('</section>', i) + 12));
  await page.waitForFunction(() => document.querySelectorAll('main.deck > .slide').length === 7, null, { timeout: 6000 });
  eq((await h.shadow('.banner')).display, 'none', '(c) no banner');
  eq((await slideTitles(page)).slice(3, 5), ['수식 내 것!', '표와 이미지'], '(c) slide 5 gone, my edit kept');
  await h.save();
  // (d) both edit slide 4
  await h.clickText(h.cur('h2'));
  await page.keyboard.type('?');
  await page.keyboard.press('Escape');
  await h.settle(300);
  h.writeDisk(h.disk().replace('<h2>수식 내 것!</h2>', '<h2>AI 수식</h2>'));
  await page.waitForFunction(() => document.querySelector('#dk-chrome').shadowRoot.querySelector('.banner').classList.contains('show'), null, { timeout: 6000 });
  expect((await h.shadow('.banner .msg')).text.includes('slide 4'), '(d) banner names slide 4');
}, { http: true });

test('R2-09 an AI edit to another slide: no reload, the caret stays, the thumbnail flashes, ⌘Z keeps the AI edit', async ({ page, h }) => {
  await h.go(1); await h.edit();
  await h.save();
  let navs = 0;
  page.on('framenavigated', f => { if (f === page.mainFrame()) navs++; });
  await h.clickText(h.cur('h2'));
  h.writeDisk(h.disk().replace('<h2>수식</h2>', '<h2>AI 수식</h2>'));
  await page.waitForFunction(() => document.querySelector('#dk-sidebar .dk-thumb:nth-child(4).dk-flash'), null, { timeout: 6000 });
  expect((await h.shadow('.toast')).text.includes('slide 4'), 'toast names slide 4: ' + (await h.shadow('.toast')).text);
  eq(navs, 0, 'no navigation');
  eq((await h.state()).editing, true, 'still editing');
  await page.keyboard.type('abc');
  eq(await h.cur('h2').textContent(), '슬라이드 제목abc', 'typing lands in the heading');
  await page.keyboard.press('Escape');
  await page.keyboard.press('Meta+z');
  eq(await h.cur('h2').textContent(), '슬라이드 제목', 'my typing undone');
  expect((await page.evaluate(() => document.querySelector('main.deck').innerHTML)).includes('AI 수식'), 'AI edit kept');
}, { http: true });
test('R2-09 unsaved edit: an AI edit elsewhere never interrupts typing (also Korean)', async ({ page, h }) => {
  await h.go(1); await h.edit();
  await h.save();
  await h.clickText(h.cur('li:nth-child(1)'));
  await page.keyboard.type(' 수정');
  h.writeDisk(h.disk().replace('<h2>표와 이미지</h2>', '<h2>AI 표</h2>'));
  await waitToast(page, 'slide 5');
  await page.keyboard.type('xyz');
  await h.ime('계속');
  eq(await h.cur('li:nth-child(1)').textContent(), '첫 번째 요점 수정xyz계속', 'typing went on in the bullet');
  expect((await page.evaluate(() => document.querySelector('main.deck').innerHTML)).includes('AI 표'), 'AI edit in');
}, { http: true });
test('R2-09 an AI edit during a drag waits until the drag ends', async ({ page, h }) => {
  await h.go(4); await h.edit();
  await h.save();
  await h.tb('[data-act="shape"]');
  await h.save();
  const sh = h.cur('.shape');
  const b0 = await sh.boundingBox();
  const c = { x: b0.x + b0.width / 2, y: b0.y + b0.height / 2 };
  await page.mouse.move(c.x, c.y);
  await page.mouse.down();
  await page.mouse.move(c.x + 30, c.y + 10, { steps: 3 });
  h.writeDisk(h.disk().replace('<h2>수식</h2>', '<h2>AI 수식</h2>'));
  await h.settle(2600);
  await page.mouse.move(c.x + 80, c.y + 40, { steps: 4 });
  await page.mouse.up();
  const b1 = await h.cur('.shape').boundingBox();
  expect(Math.abs(b1.x - b0.x - 80) < 3 && Math.abs(b1.y - b0.y - 40) < 3, 'the drag went to the release point: ' + JSON.stringify([b1.x - b0.x, b1.y - b0.y]));
  await page.waitForFunction(() => document.querySelector('main.deck').innerHTML.includes('AI 수식'), null, { timeout: 6000 });
}, { http: true });
test('R2-09 an AI change to a comment only: editing goes on, no merge toast', async ({ page, h }) => {
  await h.go(1); await h.edit();
  await h.save();
  await h.clickText(h.cur('h2'));
  h.writeDisk(h.disk().replace('  <section class="slide">\n    <h2>수식</h2>', '  <!-- AI 메모 -->\n  <section class="slide">\n    <h2>수식</h2>'));
  await h.settle(3000);
  eq((await h.state()).editing, true, 'still editing');
  expect(!(await h.shadow('.toast')).cls.includes('show'), 'no toast');
  await page.keyboard.type('!');
  await page.keyboard.press('Escape');
  await h.save();
  expect(h.disk().includes('<!-- AI 메모 -->') && h.disk().includes('<h2>슬라이드 제목!</h2>'), 'saved with the comment');
}, { http: true });

test('R2-10 "AI 버전" can be undone: ⌘Z brings my version back, ⌘⇧Z the AI\'s', async ({ page, h }) => {
  await h.go(1); await h.edit();
  await h.save();
  await h.clickText(h.cur('h2'));
  await page.keyboard.type(' (H>20)');
  await page.keyboard.press('Escape');
  await h.settle(300);
  h.writeDisk(h.disk().replace('<h2>슬라이드 제목</h2>', '<h2>AI 제목</h2>'));
  await page.waitForFunction(() => document.querySelector('#dk-chrome').shadowRoot.querySelector('.banner').classList.contains('show'), null, { timeout: 6000 });
  await h.act('reload');
  eq(await h.cur('h2').textContent(), 'AI 제목', 'AI title');
  const t = (await h.shadow('.toast')).text;
  expect(t.includes('⌘Z') && !t.includes('not saved yet'), 'toast: ' + t);
  expect((await h.shadow('.status')).text.includes('Saved'), 'pill: saved');
  await page.keyboard.press('Escape');
  await page.keyboard.press('Meta+z');
  eq(await h.cur('h2').textContent(), '슬라이드 제목 (H>20)', 'my version back');
  await page.keyboard.press('Meta+Shift+z');
  eq(await h.cur('h2').textContent(), 'AI 제목', 'AI version again');
}, { http: true });

test('R2-11 arrows are pointed by their ends; Shift snaps to 15°; one undo; saved geometry survives a reload', async ({ page, h }) => {
  await h.go(1); await h.edit();
  await h.save();
  await h.tb('[data-act="arrow"]');
  const style0 = await h.cur('svg.shape').getAttribute('style');
  const tail0 = await h.handle('.endpt.tail'), head0 = await h.handle('.endpt.head');
  expect(Math.abs(tail0.y - head0.y) < 1 && head0.x > tail0.x, 'ends of a new arrow');
  const to = { x: head0.x - 100, y: head0.y + 150 };
  await h.drag(head0, to, 8);
  const tail1 = await h.handle('.endpt.tail'), head1 = await h.handle('.endpt.head');
  expect(Math.hypot(tail1.x - tail0.x, tail1.y - tail0.y) <= 2, 'tail stayed: ' + JSON.stringify([tail0, tail1]));
  expect(Math.hypot(head1.x - to.x, head1.y - to.y) <= 3, 'head at the pointer: ' + JSON.stringify([to, head1]));
  const st = await h.cur('svg.shape').evaluate(e => ({ h: e.style.height, rot: e.style.rotate }));
  eq(st.h, '40px', 'height unchanged');
  expect(/deg$/.test(st.rot), 'rotate set');
  const style1 = await h.cur('svg.shape').getAttribute('style');
  await page.keyboard.down('Shift');
  await h.drag(head1, { x: head1.x + 37, y: head1.y + 11 }, 6);
  await page.keyboard.up('Shift');
  const rot = await h.cur('svg.shape').evaluate(e => parseFloat(e.style.rotate) || 0);
  eq(Math.round(rot) % 15, 0, 'Shift snaps to 15°: ' + rot);
  await page.keyboard.press('Meta+z');
  eq(await h.cur('svg.shape').getAttribute('style'), style1, '⌘Z restores the previous arrow');
  expect(style1 !== style0, 'the first drag changed it');
  await h.save();
  await page.reload();
  await page.waitForFunction(() => window.deckEdit && deckEdit.state.slides > 0);
  await h.settle(500);
  eq((await h.state()).mode, 'edit', 'edit mode after reload');
  await h.go(1);
  await page.mouse.click(...Object.values(await h.center(h.cur('svg.shape'))));
  const tail2 = await h.handle('.endpt.tail'), head2 = await h.handle('.endpt.head');
  expect(Math.hypot(tail2.x - tail1.x, tail2.y - tail1.y) <= 2 && Math.hypot(head2.x - head1.x, head2.y - head1.y) <= 2, 'same after reload');
}, { http: true });

const LABELS = FIXTURE.replace('\n</main>', `
  <section class="slide">
    <div class="shape" style="position:absolute; left:140px; top:400px; width:360px; height:240px; background:#dde"></div>
    <div class="shape" style="position:absolute; left:780px; top:400px; width:360px; height:240px; background:#dde"></div>
    <div class="shape" style="position:absolute; left:1420px; top:400px; width:360px; height:240px; background:#dde"></div>
    <p class="lbl" style="position:absolute; left:140px; top:490px; width:360px; margin:0; text-align:center;">레이블 하나</p>
    <p class="lbl" style="position:absolute; left:780px; top:490px; width:360px; margin:0; text-align:center;">레이블 둘</p>
    <p class="lbl" style="position:absolute; left:1420px; top:490px; width:360px; margin:0; text-align:center;">레이블 셋</p>
  </section>
\n</main>`);
test('R2-12 − / ＋ and ⌘⇧, scale each label about its own middle; a figure shows 크기', async ({ page, h }) => {
  await h.go(5); await h.edit();
  const lbl = i => h.cur(`p.lbl:nth-of-type(${i + 1})`);
  const info = () => page.evaluate(() => [...document.querySelectorAll('main.deck > .slide.dk-current p.lbl')].map(p => { const r = p.getBoundingClientRect(); return { left: p.style.left, width: p.style.width, fs: parseFloat(getComputedStyle(p).fontSize), cy: r.top + r.height / 2, cx: r.left + r.width / 2 }; }));
  const before = await info();
  await page.mouse.click(...Object.values(await h.center(lbl(0))));
  await page.keyboard.press('Escape');
  for (const i of [1, 2]) { await page.keyboard.down('Shift'); await page.mouse.click(...Object.values(await h.center(lbl(i)))); await page.keyboard.up('Shift'); }
  eq((await h.state()).count, 3, 'three labels selected');
  await page.keyboard.press('Meta+Shift+Comma');
  const after = await info();
  for (let i = 0; i < 3; i++) {
    eq([after[i].left, after[i].width], [before[i].left, before[i].width], 'left and width unchanged ' + i);
    expect(after[i].fs < before[i].fs, 'smaller ' + i);
    expect(Math.abs(after[i].cy - before[i].cy) <= 2, 'vertical middle kept ' + i + ': ' + (after[i].cy - before[i].cy));
  }
  await page.keyboard.press('Escape');
  await page.mouse.click(...Object.values(await h.center(lbl(1))));
  await page.keyboard.press('Escape');
  const one = (await info())[1];
  await page.keyboard.press('Meta+Shift+Comma');
  await page.keyboard.press('Meta+Shift+Comma');
  const two = (await info())[1];
  expect(Math.abs(two.cx - one.cx) <= 1 && Math.abs(two.cy - one.cy) <= 2, 'single label: middle kept');
  await h.go(2);
  await page.mouse.click(...Object.values(await h.center(h.cur('figure svg'))));
  await page.keyboard.press('Escape');
  eq((await h.state()).selected, 'Figure group', 'figure selected');
  eq((await h.shadow('.otb .szl')).text, 'Size', 'stepper says Size');
}, { fixture: LABELS });

test('R2-13 no height handle on text; shapes keep it and it changes only the height', async ({ page, h }) => {
  await h.go(2); await h.edit();
  for (const q of ['h2', 'figcaption']) {
    await h.clickText(h.cur(q));
    eq((await h.shadow('.edge.rh')).display, 'none', 'no height handle while editing ' + q);
    await page.keyboard.press('Escape');
    eq((await h.shadow('.edge.rh')).display, 'none', 'no height handle on selected ' + q);
    await page.keyboard.press('Escape');
  }
  await h.go(1);
  await h.clickText(h.cur('li:nth-child(2)'));
  eq((await h.shadow('.edge.rh')).display, 'none', 'no height handle on a bullet');
  await page.keyboard.press('Escape'); await page.keyboard.press('Escape');
  await h.go(4);
  await h.clickText(h.cur('td'));
  eq((await h.shadow('.edge.rh')).display, 'none', 'no height handle on a table cell');
  await page.keyboard.press('Escape'); await page.keyboard.press('Escape');
  await h.tb('[data-act="shape"]');
  eq((await h.shadow('.edge.rh')).display, 'block', 'shape has it');
  const w0 = await h.cur('.shape').evaluate(e => e.style.width);
  const r = await h.handle('.rh');
  await h.drag(r, { x: r.x, y: r.y + 40 });
  eq(await h.cur('.shape').evaluate(e => e.style.width), w0, 'width unchanged');
  expect(!/<(p|h\d|li|td|figcaption)[^>]*style="[^"]*height/.test(await h.deck()), 'no height on text');
});

test('R2-14 ⌘P while editing prints no focus ring, caret or selection box', async ({ page, h }) => {
  await h.go(4); await h.edit();
  await h.clickText(h.cur('p.free'));
  eq((await h.state()).editing, true, 'editing');
  await page.emulateMedia({ media: 'print' });
  const outlines = await page.evaluate(() => [...document.querySelectorAll('main.deck > .slide.dk-current [contenteditable], main.deck > .slide.dk-current[contenteditable]')].map(e => getComputedStyle(e).outlineStyle));
  expect(outlines.length && outlines.every(o => o === 'none'), 'no outline in print: ' + JSON.stringify(outlines));
  const shot = await page.screenshot({ fullPage: true, clip: await (async () => { const b = await h.cur('p.free').boundingBox(); return { x: b.x - 12, y: b.y - 12, width: b.width + 24, height: b.height + 24 }; })() });
  const blue = await page.evaluate(async b64 => {
    const img = new Image(); img.src = 'data:image/png;base64,' + b64; await img.decode();
    const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
    const x = c.getContext('2d'); x.drawImage(img, 0, 0);
    const d = x.getImageData(0, 0, c.width, c.height).data; let n = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i + 2] > 180 && d[i] < 140 && d[i + 2] - d[i] > 80) n++;
    return n;
  }, shot.toString('base64'));
  eq(blue, 0, 'no blue pixels around the label');
  await page.evaluate(() => dispatchEvent(new Event('beforeprint')));
  await page.emulateMedia({ media: 'screen' });
  eq((await h.state()).editing, false, 'editing stopped');
  await h.settle(100);
  eq((await h.shadow('.sel')).display, 'none', 'no selection box');
});

const OLD_ACCENT = FIXTURE.replace('</style>', '  .slide .accent { color: #e11d48; }\n</style>').replace('<p>인라인 수식 <span class="math">\\mathcal{L}(\\theta)</span> 은 이렇게 씁니다.</p>', '<p>모자 <span class="math">\\hat z + x</span> 입니다</p>');
test('R2-15 KaTeX accents keep the text colour even with a deck .accent rule', async ({ page, h }) => {
  await h.go(3);
  await page.waitForFunction(() => document.querySelector('main.deck > .slide.dk-current p .katex .accent'), null, { timeout: 15000 });
  const colors = () => page.evaluate(() => { const p = document.querySelector('main.deck > .slide.dk-current p'); return [getComputedStyle(p.querySelector('.katex .accent')).color, getComputedStyle(p).color]; });
  let [a, t] = await colors();
  eq(a, t, 'present');
  await h.edit();
  [a, t] = await colors();
  eq(a, t, 'edit');
  await page.emulateMedia({ media: 'print' });
  [a, t] = await colors();
  eq(a, t, 'print');
  await page.emulateMedia({ media: 'screen' });
  expect(!fs.readFileSync(path.join(SKILL, 'template.html'), 'utf8').includes('.slide .accent'), 'template has no .slide .accent rule');
}, { fixture: OLD_ACCENT });

test('R2-16 the tab shows the first slide\'s title; a template <title> is saved as that title (R3-15d)', async ({ page, h }) => {
  eq(await page.title(), '발표 제목', 'starts as the heading');
  await h.edit();
  await h.save();
  await h.clickText(h.cur('h1'));
  await page.keyboard.press('Meta+a');
  await page.keyboard.type('Latent World Model의 계획 능력');
  await page.keyboard.press('Escape');
  eq(await page.title(), 'Latent World Model의 계획 능력', 'title follows');
  await h.save();
  expect(h.disk().includes('<title>Latent World Model의 계획 능력</title>'), 'the template title became the first heading');
  await h.clickText(h.cur('h1'));
  await page.keyboard.type('!');
  await page.keyboard.press('Escape');
  await h.save();
  expect(h.disk().includes('<title>Latent World Model의 계획 능력!</title>'), 'a title that is the first heading keeps following it');
  await page.reload();
  await page.waitForFunction(() => window.deckEdit && deckEdit.state.slides > 0);
  eq(await page.title(), 'Latent World Model의 계획 능력!', 'after reload');
  const tpl = fs.readFileSync(path.join(SKILL, 'template.html'), 'utf8'), skill = skillDocs();
  eq((tpl.match(/class="notes"/g) || []).length, 1, 'the template shows one speaker-notes example (R4-16)');
  expect(skill.includes('<title>') && skill.includes('deck open') && skill.includes('<table style="width: 100%; border-collapse: collapse;">'), 'SKILL.md contract lines');
}, { http: true });

// =====================================================================
// Round 3
// =====================================================================
const histPos = page => page.evaluate(() => [deckEdit.state.hi, deckEdit.state.hist]);
const newBullet = async (page, h, edit = true) => {
  if (edit) { await h.go(1); await h.edit(); }
  await h.clickText(h.cur('li:nth-child(3)'));
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
};
test('R3-01 ⌘Z while typing a new bullet steps back one state per press to the original list', async ({ page, h }) => {
  await h.go(1); await h.edit();
  const orig = await h.deck();
  await newBullet(page, h, false);
  await page.keyboard.type('xyz');
  await h.settle(1000);
  let [prev] = await histPos(page);
  expect(prev > 0, 'something to undo');
  for (let k = 0; k < 8 && prev > 0; k++) {
    await page.keyboard.press('Meta+z');
    const [hi] = await histPos(page);
    expect(hi < prev, `⌘Z #${k + 1} steps back (${prev} → ${hi})`);
    eq((await h.state()).editing, true, 'still typing after ⌘Z #' + (k + 1));
    prev = hi;
  }
  eq(prev, 0, 'reached the first state');
  eq(await h.deck(), orig, 'the original three bullets');
  await page.keyboard.type('!');
  eq(await h.texts('li'), ['첫 번째 요점', '두 번째 요점', '세 번째 요점!'], 'typing goes on at the end of the last bullet');
});
test('R3-01 ⌘Z then ⌘⇧Z brings the typed bullet back; the undo adds no history', async ({ page, h }) => {
  await newBullet(page, h);
  await page.keyboard.type('xyz');
  await h.settle(1000);
  const [, n0] = await histPos(page);
  await page.keyboard.press('Meta+z');
  eq((await histPos(page))[1], n0, 'history length unchanged by ⌘Z');
  await page.keyboard.press('Meta+Shift+z');
  eq(await h.texts('li'), ['첫 번째 요점', '두 번째 요점', '세 번째 요점', 'xyz'], 'bullet back');
  eq((await histPos(page))[1], n0, 'history length unchanged by ⌘⇧Z');
  await page.keyboard.type('w');
  eq((await h.texts('li'))[3], 'xyzw', 'typing goes on in it');
});
test('R3-01 heading: X, Shift+Enter, Y, then ⌘Z ×3 gets back to the original heading', async ({ page, h }) => {
  await h.go(1); await h.edit();
  await h.clickText(h.cur('h2'));
  await page.keyboard.type('X'); await h.settle(700);
  await page.keyboard.press('Shift+Enter'); await h.settle(700);
  await page.keyboard.type('Y'); await h.settle(700);
  for (let k = 0; k < 3; k++) await page.keyboard.press('Meta+z');
  eq(await h.cur('h2').innerHTML(), '슬라이드 제목', 'original heading');
  await page.keyboard.press('Meta+Shift+z'); await page.keyboard.press('Meta+Shift+z'); await page.keyboard.press('Meta+Shift+z');
  eq(await h.cur('h2').innerHTML(), '슬라이드 제목X<br>Y', 'redo all the way');
});
test('R3-01 "ab " with a trailing space is undone by a single ⌘Z; ⌘Z ⌘⇧Z keeps the spaces', async ({ page, h }) => {
  await h.go(1); await h.edit();
  await h.clickText(h.cur('h2'));
  await page.keyboard.type(' ab ');
  await h.settle(800);
  await page.keyboard.press('Meta+z');
  eq(await h.cur('h2').textContent(), '슬라이드 제목', 'one ⌘Z');
  await page.keyboard.press('Meta+Shift+z');
  eq((await h.cur('h2').textContent()).replace(/ /g, ' '), '슬라이드 제목 ab ', 'redo keeps the leading and trailing space');
  await page.keyboard.type('c');
  eq((await h.cur('h2').textContent()).replace(/ /g, ' '), '슬라이드 제목 ab c', 'typing after the space');
});
test('R3-01 Esc, then ⌘Z to a state from the middle of typing: no empty bullet or trailing break is shown or saved', async ({ page, h }) => {
  await newBullet(page, h);
  await h.settle(700);
  await page.keyboard.type('xyz');
  await page.keyboard.press('Escape');
  await page.keyboard.press('Meta+z');
  eq(await h.texts('li'), ['첫 번째 요점', '두 번째 요점', '세 번째 요점'], 'three bullets, no empty one');
  await h.clickText(h.cur('h2'));
  await page.keyboard.type('X');
  await page.keyboard.press('Shift+Enter'); await h.settle(700);
  await page.keyboard.type('Y');
  await page.keyboard.press('Escape');
  await page.keyboard.press('Meta+z');
  eq((await h.state()).editing, false, 'not editing');
  await h.save();
  const d = h.disk();
  expect(!/<li>\s*<br>\s*<\/li>/.test(d) && !d.includes('<br></h2>') && d.includes('<h2>슬라이드 제목X</h2>'), 'saved clean: ' + d.match(/<h2>.*?<\/h2>/)[0]);
  eq(await page.evaluate(() => document.querySelectorAll('#dk-sidebar .dk-thumb:nth-child(2) li').length), 3, 'thumbnail shows three bullets');
}, { http: true });
test('R3-01 Korean typed into a new bullet: ⌘Z steps back to the original list', async ({ page, h }) => {
  await h.go(1); await h.edit();
  const orig = await h.deck();
  await newBullet(page, h, false);
  await h.ime('새 요점');
  await h.settle(1000);
  eq((await h.texts('li'))[3], '새 요점', 'typed');
  let [prev] = await histPos(page);
  for (let k = 0; k < 8 && prev > 0; k++) {
    await page.keyboard.press('Meta+z');
    const [hi] = await histPos(page);
    expect(hi < prev, `⌘Z #${k + 1} steps back (${prev} → ${hi})`);
    prev = hi;
  }
  eq(await h.deck(), orig, 'original list');
});

test('R3-02 Korean in a freshly indented or outdented empty bullet is typed once', async ({ page, h }) => {
  const anchor = () => page.evaluate(() => { const s = getSelection(); return [s.anchorNode.nodeName, s.anchorOffset]; });
  // Tab
  await newBullet(page, h);
  await page.keyboard.press('Tab');
  eq(await anchor(), ['LI', 0], 'after Tab the caret is in front of the placeholder line break');
  await h.ime('가나');
  await h.settle(300);
  eq(await page.evaluate(() => document.querySelector('main.deck > .slide.dk-current li li').textContent), '가나', 'Tab: typed once');
  // Shift+Tab on a nested bullet
  await page.keyboard.press('Enter');
  await page.keyboard.press('Shift+Tab');
  eq(await anchor(), ['LI', 0], 'after Shift+Tab');
  await h.ime('다라');
  await h.settle(300);
  eq(await page.evaluate(() => [...document.querySelectorAll('main.deck > .slide.dk-current > ul > li')].map(l => l.firstChild.textContent)), ['첫 번째 요점', '두 번째 요점', '세 번째 요점', '다라'], 'Shift+Tab: typed once');
  // toolbar 들여쓰기
  await page.keyboard.press('Enter');
  await h.pick('list', '[data-fmt="indent"]');
  await h.ime('마바');
  await h.settle(300);
  eq(await page.evaluate(() => [...document.querySelectorAll('main.deck > .slide.dk-current li li')].map(l => l.textContent)), ['가나', '마바'], 'toolbar: typed once');
});

const R3_TITLE_B = FIXTURE.replace('<h2>슬라이드 제목</h2>', '<h2><b>슬라이드</b> 제목</h2>');
test('R3-03 after ⌘Z editing never resumes inside a formula or on a bold word', async ({ page, h }) => {
  // (A) a copied paragraph above a display formula
  await h.go(3); await h.edit();
  await h.clickText(h.cur('p'));
  await page.keyboard.press('Escape');
  await page.keyboard.press('Meta+d');
  await h.clickText(page.locator('main.deck > .slide.dk-current p').nth(1));
  await page.keyboard.type('ab');
  await h.settle(700);
  await page.keyboard.press('Meta+z');
  await page.keyboard.press('Meta+z');
  const s = await h.state();
  expect(!s.editing || !(await page.evaluate(() => !!document.activeElement.closest('.math'))), 'not editing a formula');
  await page.keyboard.type('xy');
  await h.settle(300);
  await page.keyboard.press('Escape');
  const d = await h.deck();
  expect(d.includes('<div class="math display">\\mathcal{L}(\\theta) = \\mathbb{E}_{x \\sim p}\\left[-\\log q_\\theta(x)\\right]</div>'), 'display TeX unchanged');
  expect(!/xy/.test(d), 'no typing went anywhere');
  // (B) a heading with a bold word, made a bullet and back with ⌘Z
  await h.go(1);
  await h.clickText(h.cur('h2'));
  await h.pick('list', '[data-fmt="ul"]');
  await page.keyboard.press('Meta+z');
  expect((await h.active() || '').startsWith('H2'), 'editing the heading, not the bold word: ' + await h.active());
  await h.pick('block', '[data-val="H1"]');
  const nested = await page.evaluate(() => !!document.querySelector('main.deck :is(h1,h2,h3,h4,h5,h6) :is(h1,h2,h3,h4,h5,h6)'));
  expect(!nested, 'no heading inside a heading');
  eq(await page.evaluate(() => [...document.querySelector('main.deck > .slide.dk-current').children].map(c => c.tagName).slice(0, 2)), ['H1', 'UL'], 'a top-level h1');
}, { fixture: R3_TITLE_B });

const R3_LISTS = FIXTURE.replace('<div>\n        <p>왼쪽에 설명을 둡니다.</p>\n      </div>', '<div>\n        <ul>\n          <li>왼쪽 첫째</li>\n          <li>왼쪽 둘째</li>\n        </ul>\n      </div>')
  .replace('\n</main>', '\n  <section class="slide">\n    <ol>\n      <li>번호 하나</li>\n      <li>번호 둘</li>\n    </ol>\n  </section>\n\n  <section class="slide title">\n    <h1>제목만</h1>\n  </section>\n\n</main>');
test('R3-04 목록 해제 where the list is all the text: column, slide, and a title made a bullet', async ({ page, h }) => {
  // (A1) a column holding only a list
  await h.go(2); await h.edit();
  await h.clickText(h.cur('li:nth-child(2)'));
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await h.pick('list', '[data-fmt="unlist"]');
  await page.keyboard.type('X');
  await page.keyboard.press('Escape');
  eq(await page.evaluate(() => [...document.querySelector('main.deck > .slide.dk-current .cols > div').children].map(c => c.tagName + ':' + c.textContent.trim().replace(/\s+/g, ' '))), ['UL:왼쪽 첫째 왼쪽 둘째', 'P:X'], 'X in a paragraph after the list');
  // (A2) a slide holding only a numbered list
  await h.go(5);
  await h.clickText(h.cur('li:nth-child(2)'));
  await h.pick('list', '[data-fmt="unlist"]');
  await page.keyboard.type('X');
  await page.keyboard.press('Escape');
  const d = await h.deck();
  expect(/<ol>\s*<li>번호 하나<\/li>\s*<\/ol>\s*<p>번호 둘X<\/p>/.test(d), 'saved cleanly: ' + d.slice(d.indexOf('<ol>'), d.indexOf('<ol>') + 120));
  // (A3) the only heading of a title slide made a bullet
  await h.go(6);
  await h.clickText(h.cur('h1'));
  await h.pick('list', '[data-fmt="ul"]');
  const li = h.cur('li');
  expect((await li.boundingBox()).height > 10, 'the slide still shows its text');
  eq((await h.state()).editing, true, 'still editing');
  await page.keyboard.type('Z');
  eq(await li.textContent(), '제목만Z', 'typing lands in the bullet');
  eq(await page.evaluate(() => document.querySelectorAll('main.deck [contenteditable="false"]').length), 0, 'nothing left uneditable');
}, { fixture: R3_LISTS });
for (const all of [false, true]) {
  test(`R3-04 a text box made a list and back stays one box${all ? ' (after ⌘A)' : ''}`, async ({ page, h }) => {
    await h.go(1); await h.edit();
    await h.act('text');
    await page.keyboard.type('첫줄');
    await h.pick('list', '[data-fmt="ul"]');
    await page.keyboard.press('Enter');
    await page.keyboard.type('둘째');
    if (all) await page.keyboard.press('Meta+a');
    await h.pick('list', '[data-fmt="unlist"]');
    await page.keyboard.press('Escape');
    const r = await page.evaluate(() => [...document.querySelector('main.deck > .slide.dk-current').children].filter(c => /첫줄|둘째/.test(c.textContent))
      .map(c => [c.tagName, getComputedStyle(c).position, c.innerHTML]));
    eq(r, [['P', 'absolute', '첫줄<br>둘째']], 'one positioned paragraph with both lines');
  });
}

const R3_MOVE = FIXTURE.replace('\n</main>', '\n  <section class="slide">\n    <h2>결과</h2>\n    <p>결과 설명</p>\n  </section>\n\n  <section class="slide">\n    <h2>결론</h2>\n    <p>결론 요약</p>\n  </section>\n\n</main>');
const chunkAt = (text, title) => { const i = text.indexOf(`<h2>${title}</h2>`); return [text.lastIndexOf('  <section', i), text.indexOf('</section>', i) + 10]; };
const swapSlides = (text, t1, t2) => { const [a1, b1] = chunkAt(text, t1), [a2, b2] = chunkAt(text, t2); return text.slice(0, a1) + text.slice(a2, b2) + text.slice(b1, a2) + text.slice(a1, b1) + text.slice(b2); };
const deckText = page => page.evaluate(() => document.querySelector('main.deck').innerHTML);
test('R3-05 the AI moves a slide I edited: no banner, the AI\'s order, my edit kept, each slide saved once', async ({ page, h }) => {
  await h.go(5); await h.edit();
  await h.save();
  await h.clickText(h.cur('p'));
  await page.keyboard.type(' 내 메모');
  await page.keyboard.press('Escape');
  await h.settle(300);
  h.writeDisk(swapSlides(h.disk(), '결과', '결론'));
  await waitToast(page, 'moved');
  eq((await h.shadow('.banner')).display, 'none', 'no banner');
  eq((await slideTitles(page)).slice(5), ['결론', '결과'], 'the AI\'s order');
  expect((await deckText(page)).includes('결과 설명 내 메모'), 'my edit kept');
  eq(await page.evaluate(() => document.querySelectorAll('main.deck > .slide').length), 7, 'no slide doubled on screen');
  await h.save();
  const d = h.disk();
  eq(['결과', '결론'].map(t => d.split(`<h2>${t}</h2>`).length - 1), [1, 1], 'each slide once in the file');
  expect(d.indexOf('<h2>결론</h2>') < d.indexOf('<h2>결과</h2>') && d.includes('결과 설명 내 메모'), 'saved in the AI\'s order with my edit');
}, { http: true, fixture: R3_MOVE });
test('R3-05 I move a slide the AI then edits: no banner, my order and the AI\'s edit', async ({ page, h }) => {
  await h.edit();
  await h.save();
  const thumbs = page.locator('#dk-sidebar .dk-thumb');
  await thumbs.nth(6).dragTo(thumbs.nth(5), { targetPosition: { x: 100, y: 4 } });
  eq((await slideTitles(page)).slice(5), ['결론', '결과'], 'my order');
  await h.settle(300);
  h.writeDisk(h.disk().replace('결과 설명', 'AI 설명'));
  await page.waitForFunction(() => document.querySelector('main.deck').innerHTML.includes('AI 설명'), null, { timeout: 6000 });
  eq((await h.shadow('.banner')).display, 'none', 'no banner');
  eq((await slideTitles(page)).slice(5), ['결론', '결과'], 'my order kept');
  await h.save();
  const d = h.disk();
  expect(d.indexOf('<h2>결론</h2>') < d.indexOf('<h2>결과</h2>') && d.includes('<p>AI 설명</p>') && !d.includes('결과 설명'), 'saved: my order, the AI\'s caption');
  eq(d.split('<h2>결과</h2>').length - 1, 1, 'once');
}, { http: true, fixture: R3_MOVE });
test('R3-05 merge messages say what the AI did: added, deleted a slide I edited', async ({ page, h }) => {
  await h.go(1); await h.edit();
  await h.save();
  h.writeDisk(h.disk().replace('  <section class="slide">\n    <h2>결과</h2>', '  <section class="slide">\n    <h2>AI 새 장</h2>\n  </section>\n\n  <section class="slide">\n    <h2>결과</h2>'));
  await waitToast(page, 'added');
  expect((await h.shadow('.toast')).text.includes('added slide 6'), 'names the new slide: ' + (await h.shadow('.toast')).text);
  await h.save();
  await h.go(6);
  await h.clickText(h.cur('p'));
  await page.keyboard.type(' 내 것');
  await page.keyboard.press('Escape');
  await h.settle(300);
  const disk = h.disk(), [a, b] = chunkAt(disk, '결과');
  h.writeDisk(disk.slice(0, a) + disk.slice(b + 2));
  await page.waitForFunction(() => document.querySelector('#dk-chrome').shadowRoot.querySelector('.banner').classList.contains('show'), null, { timeout: 6000 });
  const msg = (await h.shadow('.banner .msg')).text;
  expect(msg.includes('The AI deleted slide 7'), 'banner says the AI deleted slide 7: ' + msg);
  await h.act('reload');
  eq((await slideTitles(page)).includes('결과'), false, 'Use AI\'s: the slide is gone');
}, { http: true, fixture: R3_MOVE });

test('R3-06 a slide moved and edited in one save keeps the comment above it', async ({ page, h }) => {
  const orig = h.disk();
  const chunk = n => { const i = orig.indexOf(`<!-- ${n}. `); return orig.slice(i, orig.indexOf('</section>', i) + 10); };
  await h.edit();
  await h.save();
  const thumbs = page.locator('#dk-sidebar .dk-thumb');
  await thumbs.nth(4).dragTo(thumbs.nth(3), { targetPosition: { x: 100, y: 4 } });
  eq(await slideTitles(page), ['발표 제목', '슬라이드 제목', '텍스트와 그림', '표와 이미지', '수식'], 'moved');
  await h.go(3);
  await h.clickText(h.cur('h2'));
  await page.keyboard.type(' 수정');
  await page.keyboard.press('Escape');
  await h.save();
  const d = h.disk();
  expect(/<!-- 5\. 표와 이미지 -->\n  <section class="slide">\n    <h2>표와 이미지 수정<\/h2>/.test(d), 'the comment sits right above the moved, edited slide:\n' + d.slice(d.indexOf('<!-- 3.'), d.indexOf('<!-- 3.') + 900));
  for (const n of [1, 2, 3, 4]) expect(d.includes(chunk(n)), `slide ${n} keeps its comment`);
  expect(d.indexOf('<!-- 5. ') < d.indexOf('<!-- 4. '), 'in the new order');
}, { http: true, fixture: COMMENTED });

test('R3-07 the AI changes only the speaker notes of a slide I am editing: no banner, both kept', async ({ page, h }) => {
  await h.go(1); await h.edit();
  await h.save();
  await h.clickText(h.cur('h2'));
  await page.keyboard.type(' 내 것');
  await page.keyboard.press('Escape');
  await h.settle(300);
  h.writeDisk(h.disk().replace('발표자 메모 (화면에는 보이지 않음)', 'AI가 쓴 메모'));
  await page.waitForFunction(() => document.querySelector('main.deck').innerHTML.includes('AI가 쓴 메모'), null, { timeout: 6000 });
  eq((await h.shadow('.banner')).display, 'none', 'no banner');
  eq(await h.cur('h2').textContent(), '슬라이드 제목 내 것', 'my heading');
  await h.save();
  const d = h.disk();
  expect(d.includes('<h2>슬라이드 제목 내 것</h2>') && d.includes('<aside class="notes">AI가 쓴 메모</aside>'), 'both saved');
}, { http: true });

test('R3-08 the AI edits the slide I am typing on: typing goes on in the same heading', async ({ page, h }) => {
  await h.go(3); await h.edit();
  await h.save();
  await h.clickText(h.cur('h2'));
  h.writeDisk(h.disk().replace('은 이렇게 씁니다.', '은 AI가 고쳤습니다.'));
  await page.waitForFunction(() => document.querySelector('main.deck').innerHTML.includes('AI가 고쳤습니다'), null, { timeout: 6000 });
  await h.settle(200);
  await page.keyboard.type('test');
  const s = await h.state();
  eq(s.mode, 'edit', 'still editing mode');
  eq(await h.cur('h2').textContent(), '수식test', 'typed into the heading');
  expect((await h.cur('p').textContent()).includes('AI가 고쳤습니다'), 'the AI\'s paragraph is there');
}, { http: true });
test('R3-08 when the text being typed in changed, letters right after are not shortcuts', async ({ page, h }) => {
  await h.go(3); await h.edit();
  await h.save();
  await h.clickText(h.cur('h2'));
  h.writeDisk(h.disk().replace('<h2>수식</h2>', '<h2>AI 수식</h2>'));
  await page.waitForFunction(() => document.querySelector('main.deck').innerHTML.includes('AI 수식'), null, { timeout: 6000 });
  await waitToast(page, 'this slide');
  await page.keyboard.type('test');
  eq((await h.state()).mode, 'edit', 'E was not taken as present');
}, { http: true });

const newShape = async (page, h) => { await h.tb('[data-act="shape"]'); return page.locator('main.deck > .slide.dk-current .shape').last(); };
const textCentre = sh => sh.evaluate(e => {
  const r = e.getBoundingClientRect(), rg = document.createRange();
  rg.selectNodeContents(e.querySelector('p'));
  const t = rg.getBoundingClientRect();
  return [Math.abs((t.left + t.right) / 2 - (r.left + r.right) / 2), Math.abs((t.top + t.bottom) / 2 - (r.top + r.bottom) / 2), t.left];
});
test('R3-09 text in a shape: double-click and type; centred; moves with the shape; saved as a paragraph inside it', async ({ page, h }) => {
  await h.go(4); await h.edit();
  const sh = await newShape(page, h);
  const c = await h.center(sh);
  await page.mouse.dblclick(c.x, c.y);
  eq((await h.state()).editing, true, 'editing the shape\'s text');
  await page.keyboard.type('Encoder');
  await page.keyboard.press('Escape');
  eq(await sh.evaluate(e => e.innerHTML), '<p>Encoder</p>', 'a paragraph inside the shape');
  eq((await h.state()).selected, 'Shape', 'the shape stays selected');
  const [dx, dy, x0] = await textCentre(sh);
  expect(dx <= 2 && dy <= 2, 'centred: ' + [dx, dy]);
  const b = await sh.boundingBox();
  await h.drag({ x: b.x + 12, y: b.y + 12 }, { x: b.x + 112, y: b.y + 52 });
  const [, , x1] = await textCentre(sh);
  expect(Math.abs(x1 - x0 - 100) < 2, 'the text moved with the shape: ' + (x1 - x0));
  expect(/<div class="shape" data-shape="rect" style="[^"]*">\s*<p>Encoder<\/p>\s*<\/div>/.test(await h.deck()), 'saved markup');
  // typing on a selected shape, and Korean
  const sh2 = await newShape(page, h);
  await page.keyboard.type('A');
  await page.keyboard.press('Escape');
  eq(await sh2.evaluate(e => e.innerHTML), '<p>A</p>', 'a letter typed on a selected shape starts its text');
  const shK = await newShape(page, h);
  await h.cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Process', code: 'KeyD', windowsVirtualKeyCode: 229, nativeVirtualKeyCode: 2 });
  await h.ime('디코더');
  await h.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Process', code: 'KeyD', windowsVirtualKeyCode: 229, nativeVirtualKeyCode: 2 });
  await page.keyboard.press('Escape');
  eq(await shK.evaluate(e => e.innerHTML), '<p>디코더</p>', 'Korean typed on a selected shape (no double-click) goes into it once');
  const sh3 = await newShape(page, h);
  const c3 = await h.center(sh3);
  await page.mouse.dblclick(c3.x, c3.y);
  await h.ime('인코더');
  await page.keyboard.press('Escape');
  eq(await sh3.evaluate(e => e.innerHTML), '<p>인코더</p>', 'Korean');
  // empty text goes
  await page.mouse.dblclick(c3.x, c3.y);
  await page.keyboard.press('Meta+a');
  await page.keyboard.press('Backspace');
  await page.keyboard.press('Escape');
  eq(await sh3.evaluate(e => e.innerHTML), '', 'emptied text is removed');
});
test('R3-09 a new text box hugs its text; No fill leaves a visible, clickable outline', async ({ page, h }) => {
  await h.go(1); await h.edit();
  await h.act('text');
  await page.keyboard.type('ab');
  const w = await page.evaluate(() => document.activeElement.offsetWidth);
  expect(w < 200, 'text box width ' + w);
  await page.keyboard.press('Escape'); await page.keyboard.press('Escape');
  const sh = await newShape(page, h);
  await h.menu('fill', '');
  const r = await sh.evaluate(e => { const cs = getComputedStyle(e), b = e.getBoundingClientRect(); const at = document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2); return [parseFloat(cs.borderTopWidth), cs.backgroundColor, at === e || e.contains(at)]; });
  expect(r[0] > 0 && r[2], 'outline and hit-testable: ' + JSON.stringify(r));
  await page.keyboard.press('Escape');
  const c = await h.center(sh);
  await page.mouse.click(c.x, c.y);
  eq((await h.state()).selected, 'Shape', 'a click in its middle selects it');
});

const fireClip = (page, type, data) => page.evaluate(([type, data]) => {
  const dt = new DataTransfer();
  for (const [k, v] of Object.entries(data || {})) dt.setData(k, v);
  (document.activeElement || document).dispatchEvent(new ClipboardEvent(type, { clipboardData: dt, bubbles: true, cancelable: true }));
  return { html: dt.getData('text/html'), text: dt.getData('text/plain') };
}, [type, data]);
test('R3-10 ⌘C ⌘V copies a shape, a text box and an arrow to another slide; ⌘X and ⌘Z; text pasted with nothing selected', async ({ page, h }) => {
  await h.go(1); await h.edit();
  await h.tb('[data-act="shape"]');
  await page.keyboard.press('Escape');
  await h.act('text'); await page.keyboard.type('라벨'); await page.keyboard.press('Escape'); await page.keyboard.press('Escape');
  await h.tb('[data-act="arrow"]'); await page.keyboard.press('Escape');
  const objs = () => page.evaluate(() => [...document.querySelectorAll('main.deck > .slide.dk-current > [style*="absolute"]')].map(e => [e.tagName, e.style.left, e.style.top]));
  const A = await objs();
  eq(A.length, 3, 'three objects on slide A');
  // pick them: Shift-click each
  await page.keyboard.down('Shift');
  for (const sel of ['.shape[data-shape="rect"]', 'p[style]', 'svg.shape']) {
    const b = await h.cur(sel).boundingBox();
    await page.mouse.click(b.x + Math.min(10, b.width / 2), b.y + b.height / 2);
  }
  await page.keyboard.up('Shift');
  eq((await h.state()).count, 3, 'three selected');
  const clip = await fireClip(page, 'copy');
  expect(clip.html.includes('data-dk-objects') && clip.text.includes('라벨'), 'clipboard has them');
  await h.go(2);
  const sb = await page.locator('main.deck > .slide.dk-current').boundingBox();
  await page.mouse.click(sb.x + sb.width - 20, sb.y + sb.height - 20);
  const n0 = await h.children();
  await fireClip(page, 'paste', { 'text/html': clip.html, 'text/plain': clip.text });
  eq(await h.children(), n0 + 3, 'three pasted');
  eq((await h.state()).count, 3, 'all selected');
  eq(await objs(), A, 'same left/top');
  await page.keyboard.press('Meta+z');
  eq(await h.children(), n0, 'one ⌘Z removes them');
  // ⌘X on slide A
  await h.go(1);
  await page.keyboard.down('Shift');
  for (const sel of ['.shape[data-shape="rect"]', 'p[style]', 'svg.shape']) {
    const b = await h.cur(sel).boundingBox();
    await page.mouse.click(b.x + Math.min(10, b.width / 2), b.y + b.height / 2);
  }
  await page.keyboard.up('Shift');
  await fireClip(page, 'cut');
  eq((await objs()).length, 0, 'cut removes them');
  await page.keyboard.press('Meta+z');
  eq((await objs()).length, 3, '⌘Z restores them');
  // text pasted with nothing selected
  await page.keyboard.press('Escape'); await page.keyboard.press('Escape');
  await fireClip(page, 'paste', { 'text/plain': 'hello' });
  const p = await page.evaluate(() => [...document.querySelectorAll('main.deck > .slide.dk-current > p[style*="absolute"]')].map(e => e.textContent));
  expect(p.includes('hello'), 'a text box with hello: ' + JSON.stringify(p));
});

test('R3-10 a copied display formula pastes onto another slide, renders, and saves as TeX', async ({ page, h }) => {
  await h.go(3); await h.edit();
  await page.waitForFunction(() => document.querySelector('main.deck > .slide.dk-current div.math .katex'), null, { timeout: 15000 });
  await page.mouse.click(...Object.values(await h.center(h.cur('div.math .katex'))));
  eq((await h.state()).selected, 'Equation', 'formula selected');
  const clip = await fireClip(page, 'copy');
  expect(!clip.html.includes('katex') && clip.html.includes('\\mathcal{L}'), 'the clipboard holds the TeX, not the rendering');
  await h.go(1);
  const sb = await page.locator('main.deck > .slide.dk-current').boundingBox();
  await page.mouse.click(sb.x + sb.width - 20, sb.y + sb.height - 20);
  await fireClip(page, 'paste', { 'text/html': clip.html, 'text/plain': clip.text });
  await page.waitForFunction(() => document.querySelector('main.deck > .slide.dk-current div.math .katex'), null, { timeout: 15000 });
  const d = await h.deck();
  expect((d.match(/<div class="math display">\\mathcal\{L\}\(\\theta\) = /g) || []).length === 2, 'saved twice as TeX');
});
const pngFile = `(async () => {
  const blob = await new Promise(r => { const c = document.createElement('canvas'); c.width = 2400; c.height = 1600; const g = c.getContext('2d'); g.fillStyle = '#c33'; g.fillRect(0, 0, 800, 600); c.toBlob(r, 'image/png'); });
  window.__png = new File([blob], 'plot.png', { type: 'image/png' });
  window.showOpenFilePicker = async () => [{ getFile: async () => window.__png }];
})()`;
test('R3-11 the figure placeholder is replaced by an image in the flow; deleting it then 이미지 fills the figure', async ({ page, h }) => {
  await h.go(2); await h.edit();
  await h.save();
  await page.evaluate(pngFile);
  const svg = h.cur('figure svg');
  const c = await h.center(svg);
  await page.mouse.click(c.x, c.y);
  eq((await h.state()).selected, 'Figure', 'the chart is selected');
  await h.tb('.otb [data-obj="image"]');
  await page.waitForFunction(() => document.querySelector('main.deck > .slide.dk-current figure img'), null, { timeout: 5000 });
  const fig = () => page.evaluate(() => { const f = document.querySelector('main.deck > .slide.dk-current figure'); return [...f.children].map(c => c.tagName + (c.getAttribute('style') ? '[style]' : '')); });
  eq(await fig(), ['IMG', 'FIGCAPTION'], 'image then caption, no position');
  await h.save();
  expect(/<figure>\s*<img src="assets\/plot\.png" alt="">\s*<figcaption>그림 설명<\/figcaption>\s*<\/figure>/.test(h.disk()), 'saved figure');
  // delete the picture, then 이미지
  await page.keyboard.press('Delete');
  eq(await fig(), ['FIGCAPTION'], 'only the caption left');
  await h.act('image');
  await page.waitForFunction(() => document.querySelector('main.deck > .slide.dk-current figure img'), null, { timeout: 5000 });
  eq(await fig(), ['IMG', 'FIGCAPTION'], 'image goes into the figure');
}, { http: true });
test('R3-11 a pasted image on a slide without a figure floats in free space, not over the text', async ({ page, h }) => {
  await h.go(1); await h.edit();
  await h.save();
  await page.evaluate(pngFile);
  await page.evaluate(() => { const dt = new DataTransfer(); dt.items.add(window.__png); document.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })); });
  await page.waitForFunction(() => document.querySelector('main.deck > .slide.dk-current > img'), null, { timeout: 5000 });
  await h.settle(300);
  const r = await page.evaluate(() => {
    const img = document.querySelector('main.deck > .slide.dk-current > img').getBoundingClientRect();
    const hit = [...document.querySelectorAll('main.deck > .slide.dk-current :is(h2, li)')].filter(e => {
      const rg = document.createRange(); rg.selectNodeContents(e); const t = rg.getBoundingClientRect();
      return t.left < img.right && img.left < t.right && t.top < img.bottom && img.top < t.bottom;
    }).map(e => e.textContent);
    return { hit, w: img.width };
  });
  eq(r.hit, [], 'covers no text');
  expect(r.w > 50, 'a real size: ' + r.w);
}, { http: true, fixture: FIXTURE.replace(/<li>(첫|두|세) 번째 요점<\/li>/g, '<li>$1 번째 요점은 꽤 길어서 슬라이드의 너비를 거의 다 차지하는 문장입니다 정말로 그렇습니다</li>') });

test('R3-12 tables: columns size to their text; whole-table align, bold, colour as one step; column align; menus in the same order', async ({ page, h }) => {
  await h.go(1); await h.edit();
  await h.tb('[data-menu="table"]');
  await h.tb('.menu [data-val="5×4"]');
  await page.keyboard.type('고정 horizon (ours-fixed) 방법');
  const widths = await page.evaluate(() => { const t = document.querySelector('main.deck > .slide.dk-current table'); return [...t.rows[0].cells].map(c => c.getBoundingClientRect().width); });
  expect(widths[0] > widths[1], 'column 1 is wider: ' + widths.map(Math.round));
  expect(!(await page.evaluate(() => document.querySelector('main.deck > .slide.dk-current table').style.tableLayout)), 'no fixed layout');
  // cell menus
  const vals = async menu => { await h.tb(`[data-menu="${menu}"]`); const v = await page.locator('#dk-chrome').evaluate(host => [...host.shadowRoot.querySelectorAll('.menu .item')].map(b => b.dataset.val)); await page.keyboard.press('Escape'); return v; };
  const rowCell = await vals('row'), colCell = await vals('col');
  // column align from the cell
  await page.keyboard.press('Tab');
  await h.pick('col', '[data-val="col-align-center"]');
  const al = () => page.evaluate(() => [...document.querySelector('main.deck > .slide.dk-current table').rows].map(r => [...r.cells].map(c => getComputedStyle(c).textAlign)));
  let a = await al();
  expect(a.every(r => r[1] === 'center') && a.every(r => r[0] !== 'center'), 'only column 2 centred: ' + JSON.stringify(a));
  await page.keyboard.press('Escape');
  eq((await h.state()).selected.startsWith('Table'), true, 'table selected');
  const rowT = await vals('trow'), colT = await vals('tcol');
  const kind = v => (/above|start|left/.test(v) ? 'first' : /below|end|right/.test(v) ? 'second' : /del/.test(v) ? 'del' : v);
  eq(rowT.map(kind), rowCell.map(kind), 'row menus in the same order');
  eq(colT.map(kind).slice(0, 3), colCell.map(kind).slice(0, 3), 'column menus in the same order');
  // whole table
  await h.pick('talign', '[data-val="center"]');
  a = await al();
  expect(a.flat().every(x => x === 'center'), 'every cell centred');
  await h.tb('.otb [data-obj="tbold"]');
  expect(await page.evaluate(() => [...document.querySelectorAll('main.deck > .slide.dk-current table :is(td,th)')].every(c => parseInt(getComputedStyle(c).fontWeight) >= 600)), 'every cell bold');
  await page.keyboard.press('Meta+z');
  await page.keyboard.press('Meta+z');
  a = await al();
  expect(a.every(r => r[1] === 'center') && a.every(r => r[0] !== 'center'), 'two ⌘Z: back to only column 2');
});

const R3_FORMATS = FIXTURE.replace('\n</main>', '\n  <section class="slide">\n    <h2>코드</h2>\n    <pre><code>x = 1</code></pre>\n  </section>\n\n</main>');
// The same deck without the template's rules for numbered lists, quotes, code and links: the editor's fallbacks apply.
const R3_BARE = R3_FORMATS.replace('.slide ul, .slide ol {', '.slide ul {').replace(/  \.slide (blockquote|code|pre|pre code|a) \{[^}]*\}\n/g, '');
for (const [label, fixture] of [['template rules', R3_FORMATS], ['no rules in the deck', R3_BARE]]) test(`R3-13 numbered lists, quotes, code and links look like the deck (${label})`, async ({ page, h }) => {
  await h.go(1); await h.edit();
  const before = await page.evaluate(() => { const ul = document.querySelector('main.deck > .slide.dk-current ul'); return [ul.firstElementChild.getBoundingClientRect().top, parseFloat(getComputedStyle(ul).paddingLeft)]; });
  await h.clickText(h.cur('li'));
  await page.keyboard.press('Meta+a');
  await h.pick('list', '[data-fmt="ol"]');
  const after = await page.evaluate(() => { const ol = document.querySelector('main.deck > .slide.dk-current ol'); return [ol.firstElementChild.getBoundingClientRect().top, parseFloat(getComputedStyle(ol).paddingLeft)]; });
  expect(Math.abs(after[0] - before[0]) <= 2 && Math.abs(after[1] - before[1]) <= 4, 'numbers where the bullets were: ' + JSON.stringify([before, after]));
  await page.keyboard.press('Escape');
  await h.go(0);
  await h.clickText(h.cur('.sub'));
  await h.pick('more', '[data-fmt="quote"]');
  expect(await page.evaluate(() => parseFloat(getComputedStyle(document.querySelector('main.deck blockquote')).borderLeftWidth)) > 0, 'quote has a rule');
  await h.go(5);
  expect(await page.evaluate(() => !/rgba\(0, 0, 0, 0\)|transparent/.test(getComputedStyle(document.querySelector('main.deck > .slide.dk-current pre')).backgroundColor)), 'code block has a background');
  expect(await page.evaluate(() => getComputedStyle(document.querySelector('main.deck > .slide.dk-current pre')).fontFamily.includes('mono')), 'code block in a monospace font');
}, { fixture });
const DARK = FIXTURE.replace('  .slide a { color: var(--accent); }\n', '').replace('    background: #fff;\n    color: var(--ink);', '    background: #15171c;\n    color: #e6e6e6;').replace('--accent: #2f5bea', '--accent: #ffb020');
test('R3-13 a dark deck with no link rule: links take the accent colour; code gets a background', async ({ page, h }) => {
  await h.go(1); await h.edit();
  await h.clickText(h.cur('li'));
  page.__dialog = d => d.accept('https://example.com');
  await page.keyboard.press('Meta+k');
  await h.settle(200);
  const [link, accent] = await page.evaluate(() => { const a = document.querySelector('main.deck > .slide.dk-current a'); const p = document.createElement('span'); p.style.color = 'var(--accent)'; document.body.appendChild(p); const r = [getComputedStyle(a).color, getComputedStyle(p).color]; p.remove(); return r; });
  eq(link, accent, 'link colour is the accent');
}, { fixture: DARK });
test('R3-13 Enter in a code block is a newline; 코드 at a caret then typing makes <code>; a link split and joined stays one', async ({ page, h }) => {
  await h.go(5); await h.edit();
  await h.clickText(h.cur('code'));
  await page.keyboard.press('Enter');
  await page.keyboard.type('y = 2');
  await page.keyboard.press('Escape');
  expect((await h.deck()).includes('<pre><code>x = 1\ny = 2</code></pre>'), 'newline, no <br>: ' + (await h.deck()).match(/<pre>[\s\S]*?<\/pre>/)[0]);
  // 코드 at the start of a bullet
  await h.go(1);
  await h.clickText(h.cur('li'), 'start');
  await page.keyboard.press('Home');
  await h.pick('more', '[data-fmt="code"]');
  await page.keyboard.type(' q');
  await page.keyboard.press('Escape');
  const li = (await h.deck()).match(/<li>.*?<\/li>/)[0];
  expect(li.includes('<code>') && !li.includes('<font'), 'code, not font: ' + li);
}, { fixture: R3_FORMATS });
test('R3-13 Enter then Backspace inside a link saves one link', async ({ page, h }) => {
  await h.go(5); await h.edit();
  const a = h.cur('a');
  await h.clickText(a, 'start');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Backspace');
  await page.keyboard.press('Escape');
  const d = await h.deck();
  eq((d.match(/<a href="https:\/\/example\.com\/x">/g) || []).length, 1, 'one link: ' + d.match(/<li>셋.*?<\/li>/)[0]);
}, { fixture: NIGHT });

test('R3-14 the move grip of a narrow box at the right edge is never under the text toolbar', async ({ page, h }) => {
  await h.go(1); await h.edit();
  await h.act('text');
  await page.keyboard.type('오른쪽 상자');
  await page.evaluate(() => { const p = document.activeElement; Object.assign(p.style, { left: '1650px', top: '300px', width: '250px' }); });
  await h.settle(200);
  const g = await h.handle('.sel .grip');
  const hit = await page.locator('#dk-chrome').evaluate((host, g) => { const e = host.shadowRoot.elementFromPoint(g.x, g.y); return e && e.className; }, g);
  eq(hit, 'grip', 'the grip is on top');
  const left0 = await page.evaluate(() => document.activeElement.style.left);
  await h.drag(g, { x: g.x - 60, y: g.y + 20 });
  const left1 = await page.evaluate(() => document.querySelector('main.deck > .slide.dk-current > p[style*="absolute"]').style.left);
  expect(left1 !== left0, 'dragging the grip moved it: ' + [left0, left1]);
}, { viewport: { width: 1280, height: 800 } });
test('R3-14 a short arrow can be dragged from its middle (the chip never catches it)', async ({ page, h }) => {
  await h.go(1); await h.edit();
  await h.tb('[data-act="arrow"]');
  // At the left edge with text boxes above and beside it, the chip has no room outside the arrow.
  await page.evaluate(() => {
    const s = document.querySelector('main.deck > .slide.dk-current'), a = s.querySelector('svg.shape');
    Object.assign(a.style, { width: '108px', left: '0px', top: '70px' });
    const p = document.createElement('p'); p.textContent = '옆 상자'; p.style.cssText = 'position:absolute; left:120px; top:60px; margin:0; width:max-content';
    const q = document.createElement('p'); q.textContent = '위 상자 위 상자 위 상자'; q.style.cssText = 'position:absolute; left:0px; top:0px; margin:0; width:max-content';
    s.append(p, q);
  });
  await page.keyboard.press('Escape');
  const ar = h.cur('svg.shape');
  const c = await h.center(ar);
  await page.mouse.click(c.x, c.y);
  eq((await h.state()).selected, 'Arrow', 'selected');
  const chip = await h.rect('.sel .tag');
  expect(chip.x <= c.x && c.x <= chip.right && chip.y <= c.y && c.y <= chip.bottom, 'the chip lies over the arrow\'s middle here: ' + JSON.stringify([chip, c]));
  const before = await ar.evaluate(e => [e.style.left, e.style.top]);
  await h.drag(c, { x: c.x + 80, y: c.y + 40 });
  const after = await ar.evaluate(e => [e.style.left, e.style.top]);
  expect(after[0] !== before[0] && after[1] !== before[1], 'moved: ' + JSON.stringify([before, after]));
});
test('R3-14 with the conflict banner up, ⌘S never covers it; 내 버전 stays clickable', async ({ page, h }) => {
  await h.edit();
  await h.save();
  await h.clickText(h.cur('h1'));
  await page.keyboard.type(' 내 수정');
  await h.settle();
  h.writeDisk(h.disk().replace('한 줄 부제', 'AI 부제'));
  await page.waitForFunction(() => document.querySelector('#dk-chrome').shadowRoot.querySelector('.banner').classList.contains('show'), null, { timeout: 6000 });
  // Typing in a box at the bottom: its toolbar sits where a toast would show, so a toast goes to the top.
  await h.act('text');
  await page.evaluate(() => { Object.assign(document.activeElement.style, { top: '1030px', left: '700px' }); });
  await page.keyboard.type('아래');
  await h.save();
  const r = await page.locator('#dk-chrome').evaluate(host => {
    const sr = host.shadowRoot, bn = sr.querySelector('.banner').getBoundingClientRect(), t = sr.querySelector('.toast');
    const tr = t.classList.contains('show') ? t.getBoundingClientRect() : null;
    const k = sr.querySelector('.banner [data-act="keep"]').getBoundingClientRect();
    const at = sr.elementFromPoint(k.x + k.width / 2, k.y + k.height / 2);
    return { overlap: !!tr && tr.left < bn.right && bn.left < tr.right && tr.top < bn.bottom && bn.top < tr.bottom, keep: at && at.dataset.act };
  });
  eq(r, { overlap: false, keep: 'keep' }, 'banner clear');
}, { http: true, viewport: { width: 1280, height: 640 } });

test('R3-15 small fixes: pill after a no-op edit, toast after undo, Home/End, arrow snap, formula space', async ({ page, h }) => {
  await h.go(1); await h.edit();
  // (a)
  await h.clickText(h.cur('h2'));
  await page.keyboard.type('x');
  await page.keyboard.press('Backspace');
  await h.settle(2000);
  expect(!(await h.shadow('.status')).text.includes('Unsaved changes'), 'pill: ' + (await h.shadow('.status')).text);
  await page.keyboard.press('Escape'); await page.keyboard.press('Escape');
  // (b)
  await h.menu('slide', 'del');
  await page.keyboard.press('Meta+z');
  const t = await h.shadow('.toast');
  expect(!(t.cls.includes('show') && t.text.includes('deleted')), 'no delete toast after ⌘Z');
  // (i)
  await page.keyboard.press('Escape');
  await h.go(0);
  await page.keyboard.press('End');
  eq((await h.state()).cur, 4, 'End: last slide');
  await page.keyboard.press('Home');
  eq((await h.state()).cur, 0, 'Home: first slide');
  // (g)
  await h.go(1);
  await h.tb('[data-act="arrow"]');
  const ends = await page.locator('#dk-chrome').evaluate(host => { const sr = host.shadowRoot; const c = e => { const r = sr.querySelector(e).getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; }; return [c('.endpt.tail'), c('.endpt.head')]; });
  await h.drag(ends[1], { x: ends[1].x + 40, y: ends[0].y + 0.4 });
  const st = await page.evaluate(() => document.querySelector('main.deck > .slide.dk-current svg.shape').getAttribute('style'));
  expect(!/rotate/.test(st), 'level arrow has no rotate: ' + st);
  // (h)
  await h.go(3);
  const m = h.cur('p .math');
  const mc = await h.center(m);
  await page.mouse.dblclick(mc.x, mc.y);
  await page.keyboard.press('Meta+a');
  await page.keyboard.press('Backspace');
  await page.keyboard.press('Escape'); await page.keyboard.press('Escape');
  const p = (await h.deck()).match(/<p>인라인 수식.*?<\/p>/)[0];
  expect(!/  /.test(p), 'no double space: ' + p);
});
test('R3-15 (f) Enter, Tab, Backspace in an empty sub-bullet goes back up a level; typing makes a top-level bullet', async ({ page, h }) => {
  await h.go(1); await h.edit();
  await h.clickText(h.cur('li:nth-child(2)'));
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Tab');
  await page.keyboard.press('Backspace');
  await h.ime('마바');
  eq(await page.evaluate(() => [...document.querySelectorAll('main.deck > .slide.dk-current > ul > li')].map(l => l.textContent)), ['첫 번째 요점', '두 번째 요점', '마바', '세 번째 요점'], 'top-level bullet after the parent');
});
const TITLED = FIXTURE.replace('<title>발표 제목</title>', '<title>My Talk</title>');
test('R3-15 titles: a template title becomes the first heading on save; a custom one stays; the AI\'s title shows in the tab', async ({ page, h }) => {
  await h.edit();
  await h.save();
  await h.clickText(h.cur('h1'));
  await page.keyboard.type(' 바뀜');
  await page.keyboard.press('Escape');
  await h.save();
  expect(h.disk().includes('<title>My Talk</title>'), 'custom title kept');
  h.writeDisk(h.disk().replace('<title>My Talk</title>', '<title>AI Talk</title>'));
  await page.waitForFunction(() => document.title === 'AI Talk', null, { timeout: 4000 });
}, { http: true, fixture: TITLED });
test('R3-15 a stylesheet link the AI adds while I have unsaved edits is loaded at once', async ({ page, h }) => {
  await h.edit();
  await h.save();
  await h.clickText(h.cur('h1'));
  await page.keyboard.type(' 내 것');
  await page.keyboard.press('Escape');
  await page.evaluate(() => { window.__marker = 1; });
  fs.writeFileSync(path.join(h.dir, 'extra.css'), '.slide h1 { letter-spacing: 3px; }');
  h.writeDisk(h.disk().replace('</head>', '<link rel="stylesheet" href="extra.css">\n</head>'));
  await page.waitForFunction(() => document.querySelector('head link[href="extra.css"]'), null, { timeout: 4000 });
  eq(await page.evaluate(() => window.__marker), 1, 'no reload');
  expect((await h.cur('h1').textContent()).includes('내 것'), 'my edit still there');
}, { http: true });
const FORTY = FIXTURE.replace('\n</main>', Array.from({ length: 35 }, (_, i) => `\n  <section class="slide">\n    <h2>추가 ${i + 1}</h2>\n  </section>\n`).join('') + '\n</main>');
test('R3-15 End on slide 1 of a 40-slide deck goes to 40 / 40', async ({ page, h }) => {
  await h.edit();
  await page.keyboard.press('End');
  eq((await h.shadow('.count')).text, '40 / 40', 'counter');
}, { fixture: FORTY });

// =====================================================================
// Round 4
// =====================================================================
const AIBR = FIXTURE.replace('\n</main>', `
  <section class="slide">
    <h2>AI 슬라이드</h2>
    <p>끝에 줄바꿈<br></p>
    <ul><li>하나</li><li></li></ul>
  </section>
\n</main>`);
const slideHTML = (page, i) => page.evaluate(i => deckEdit.deckHTML().match(/<section[\s\S]*?<\/section>/g)[i], i);
const undoOff = page => page.evaluate(() => document.querySelector('#dk-chrome').shadowRoot.querySelector('button[data-act=undo]').disabled);
test('R4-01 (a) a slide the AI wrote comes back byte for byte after delete + ⌘Z; saving writes nothing new; no false banner', async ({ page, h }) => {
  await h.edit();
  await h.save();
  await h.go(5);
  const orig = await slideHTML(page, 5);
  expect(orig.includes('끝에 줄바꿈<br></p>') && orig.includes('<li></li>'), 'fixture as written: ' + orig);
  await h.menu('slide', 'del');
  eq((await h.state()).slides, 5, 'deleted');
  await page.keyboard.press('Meta+z'); await h.settle(300);
  eq(await slideHTML(page, 5), orig, 'restored exactly');
  eq((await h.state()).dirty, false, 'clean');
  const before = h.disk();
  await h.save();
  eq(h.disk(), before, 'file unchanged');
  h.writeDisk(h.disk().replace('<li>하나</li>', '<li>하나 AI</li>'));
  await page.waitForFunction(() => document.body.textContent.includes('하나 AI'), null, { timeout: 6000 });
  await h.settle(300);
  expect(!(await h.shadow('.banner')).cls.includes('show'), 'no conflict banner');
}, { http: true, fixture: AIBR });
test('R4-01 (b) typing in the AI slide\'s heading, Esc, one ⌘Z takes it back; undoing all leaves the file as it was', async ({ page, h }) => {
  await h.edit();
  await h.save();
  const before = h.disk();
  await h.go(5);
  const orig = await slideHTML(page, 5);
  await h.clickText(h.cur('h2'));
  await page.keyboard.type('X');
  await h.settle(700);
  await page.keyboard.press('Escape');
  const mid = await slideHTML(page, 5);
  expect(mid.includes('끝에 줄바꿈<br></p>') && mid.includes('<li></li>'), 'Esc leaves untouched blocks alone: ' + mid);
  await page.keyboard.press('Meta+z'); await h.settle(200);
  expect(!(await h.cur('h2').textContent()).includes('X'), 'one ⌘Z removes X');
  for (let i = 0; i < 5; i++) await page.keyboard.press('Meta+z');
  await h.settle(200);
  eq(await slideHTML(page, 5), orig, 'slide as it was');
  eq((await h.state()).dirty, false, 'clean');
  await h.save();
  eq(h.disk(), before, 'file unchanged');
}, { http: true, fixture: AIBR });
test('R4-01 (c) a new bullet typed then undone: ⌘Z reaches the start and the undo button turns off', async ({ page, h }) => {
  await h.go(1); await h.edit();
  await h.clickText(h.cur('li:nth-child(3)'));
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await h.settle(700);
  await page.keyboard.type('넷째 요점');
  await h.settle(700);
  await page.keyboard.press('Escape');
  for (let i = 0; i < 6 && (await h.state()).hi > 0; i++) { await page.keyboard.press('Meta+z'); await h.settle(150); }
  eq((await h.state()).hi, 0, 'back at the start');
  eq(await undoOff(page), true, 'undo disabled');
  eq(await h.texts('li'), ['첫 번째 요점', '두 번째 요점', '세 번째 요점'], 'bullets as before');
});

const RESULTS = TEMPLATE_KO.replace(/<main class="deck"[^>]*>[\s\S]*<\/main>/, `<main class="deck" data-size="1920x1080">

  <!-- 1. 표지 -->
  <section class="slide title">
    <h1>세계 모델 발표</h1>
    <p class="sub">한 줄 부제</p>
  </section>

  <!-- 2. 배경 -->
  <section class="slide">
    <h2>배경</h2>
    <ul>
      <li>첫 번째 요점</li>
      <li>두 번째 요점</li>
    </ul>
  </section>

  <!-- 3. 방법 -->
  <section class="slide">
    <h2>방법</h2>
    <p>계층적 잠재 상태로 긴 롤아웃을 예측한다.</p>
  </section>

  <!-- 4. 실험 설정 -->
  <section class="slide">
    <h2>실험 설정</h2>
    <p>Maze-Long 과 Kitchen 두 환경, 5 seeds.</p>
  </section>

  <!-- 5. 결과 -->
  <section class="slide">
    <h2>결과</h2>
    <table>
      <thead>
        <tr><th>방법</th><th>Maze-Long</th><th>Kitchen</th><th>평균</th></tr>
      </thead>
      <tbody>
        <tr><td>DreamerV3</td><td>41.2</td><td>63.0</td><td>52.1</td></tr>
        <tr><td>TD-MPC2</td><td>48.7</td><td>70.4</td><td>59.6</td></tr>
        <tr><td><b>Ours</b></td><td><b>71.3</b></td><td><b>74.8</b></td><td><b>73.1</b></td></tr>
      </tbody>
    </table>
    <p class="muted">5 seeds 평균, 성공률(%)</p>
  </section>

  <!-- 6. 분석 -->
  <section class="slide">
    <h2>분석</h2>
    <p>평탄한 모델은 20스텝 이후 오차가 커진다.</p>
  </section>

</main>`);
const ablation = head => `  <!-- 5a. 결과 (ablation) -->
  <section class="slide">
    <h2>${head}</h2>
    <table>
      <thead>
        <tr><th>변형</th><th>Maze-Long</th></tr>
      </thead>
      <tbody>
        <tr><td>하위 목표 제거</td><td>53.1</td></tr>
      </tbody>
    </table>
  </section>

  <!-- 5. 결과 -->`;
const aiInsert = (text, head) => text.replace('  <!-- 5. 결과 -->', ablation(head)).replace('<h2>결과</h2>\n    <table>\n      <thead>\n        <tr><th>방법</th>', '<h2>주요 결과</h2>\n    <table>\n      <thead>\n        <tr><th>방법</th>');
for (const [tag, head] of [['a new heading', '추가 실험'], ['the same heading 결과', '결과']]) {
  test(`R4-02 the AI inserts a slide (${tag}) before the slide I edit and renames mine: 내 버전 keeps both, once each`, async ({ page, h }) => {
    await h.edit();
    await h.save();
    await h.go(4);
    await h.clickText(h.cur('tbody tr:nth-child(1) td:nth-child(2)'));
    await page.keyboard.type('9');
    await page.keyboard.press('Escape');
    await h.settle(1300);
    const ai = aiInsert(h.disk(), head);
    expect(ai.includes('<h2>주요 결과</h2>') && ai.includes('5a.'), 'AI edit applies');
    h.writeDisk(ai);
    await page.waitForFunction(() => document.querySelector('#dk-chrome').shadowRoot.querySelector('.banner').classList.contains('show'), null, { timeout: 6000 });
    const mineAt = await page.evaluate(() => [...document.querySelectorAll('main.deck > .slide')].findIndex(s => s.textContent.includes('41.29')));
    eq(mineAt, 5, 'my slide comes after the AI\'s new one');
    expect((await h.shadow('.banner .msg')).text.includes(`The AI also edited slide ${mineAt + 1}`), 'banner names my slide: ' + (await h.shadow('.banner .msg')).text);
    const shown = await page.evaluate(() => [...document.querySelectorAll('main.deck > .slide')].map(s => s.textContent.replace(/\s+/g, ' ').trim().slice(0, 30)));
    eq(shown.length, 7, 'seven slides: ' + JSON.stringify(shown));
    expect(shown.some(t => t.includes('하위 목표 제거')), 'the AI\'s slide is shown');
    await h.tb('.banner [data-act="keep"]'); await h.settle(300);
    await h.save();
    const d = h.disk();
    eq((d.match(/<section/g) || []).length, 7, 'seven slides saved');
    eq((d.match(/41\.29/g) || []).length, 1, 'my edit once');
    eq((d.match(/하위 목표 제거/g) || []).length, 1, 'the AI\'s slide once');
    expect(/<!-- 5a\. 결과 \(ablation\) -->\s*<section class="slide">\s*<h2>[^<]*<\/h2>\s*<table>\s*<thead>\s*<tr><th>변형/.test(d), 'the 5a comment stays on the AI\'s slide');
    expect(/<!-- 5\. 결과 -->\s*<section class="slide">\s*<h2>[^<]*<\/h2>\s*<table>\s*<thead>\s*<tr><th>방법[\s\S]*?41\.29/.test(d), 'my slide under its own comment');
  }, { http: true, fixture: RESULTS });
}
test('R4-02 with no edit of mine, the AI\'s inserted slide comes in cleanly', async ({ page, h }) => {
  await h.edit();
  await h.save();
  h.writeDisk(aiInsert(h.disk(), '결과'));
  await page.waitForFunction(() => document.querySelectorAll('main.deck > .slide').length === 7, null, { timeout: 6000 });
  await h.settle(300);
  expect(!(await h.shadow('.banner')).cls.includes('show'), 'no banner');
  eq(await page.evaluate(() => [...document.querySelectorAll('main.deck > .slide h2')].map(e => e.textContent)), ['배경', '방법', '실험 설정', '결과', '주요 결과', '분석'], 'headings');
  eq((await h.state()).dirty, false, 'nothing to save');
}, { http: true, fixture: RESULTS });

const rightOfMath = async (page, h) => { const b = await h.cur('p .math').boundingBox(); return { x: b.x + b.width + 1, y: b.y + b.height / 2 }; };
const caretInMath = page => page.evaluate(() => { const n = getSelection().anchorNode; return !!n && !!(n.nodeType === 1 ? n : n.parentElement).closest('.math'); });
const mathPara = async h => (await h.deck()).match(/<p>인라인 수식[\s\S]*?<\/p>/)[0];
for (const [tag, typeIt, want] of [['B', page => page.keyboard.type('B'), 'B'], ['한 (IME)', (page, h) => h.ime('한'), '한']]) {
  test(`R4-03 after ⌘Z next to an inline formula, typing ${tag} lands beside it, never inside`, async ({ page, h }) => {
    await h.go(3); await h.edit();
    const p = await rightOfMath(page, h);
    await page.mouse.click(p.x, p.y);
    await page.keyboard.type('A');
    await h.settle(600);
    await page.keyboard.press('Meta+z'); await h.settle(150);
    expect(!(await caretInMath(page)), 'caret not inside the formula');
    await typeIt(page, h);
    await h.settle(100);
    const d = await mathPara(h);
    expect(d.includes('<span class="math">\\mathcal{L}(\\theta)</span>' + want + ' 은 이렇게') && !d.includes('A'), 'typed after the formula: ' + d);
  });
}
test('R4-03 Backspace a formula, ⌘Z, type: the letter goes beside the restored formula', async ({ page, h }) => {
  await h.go(3); await h.edit();
  const p = await rightOfMath(page, h);
  await page.mouse.click(p.x, p.y);
  await page.keyboard.press('Backspace');
  await h.settle(100);
  if ((await h.deck()).includes('class="math">\\mathcal{L}(\\theta)</span> 은')) await page.keyboard.press('Backspace');
  await h.settle(600);
  expect(!(await mathPara(h)).includes('class="math"'), 'formula deleted: ' + await mathPara(h));
  await page.keyboard.press('Meta+z'); await h.settle(150);
  expect(!(await caretInMath(page)), 'caret not inside the formula');
  await page.keyboard.type('B');
  const d = await mathPara(h);
  expect(/<\/span>B|B<span class="math">/.test(d), 'B next to the formula: ' + d);
});

for (const [tag, doIt] of [['Tab', page => page.keyboard.press('Tab')], ['Remove list', (page, h) => h.pick('list', '[data-fmt="unlist"]')]]) {
  test(`R4-04 ${tag} then ⌘Z: typing goes on in the same bullet; E never starts presenting`, async ({ page, h }) => {
    await h.go(1); await h.edit();
    await h.clickText(h.cur('li:nth-child(2)'));
    await page.keyboard.press('End');
    await page.keyboard.press('ArrowLeft'); await page.keyboard.press('ArrowLeft');
    await doIt(page, h);
    await h.settle(200);
    await page.keyboard.press('Meta+z'); await h.settle(200);
    const st = await h.state();
    eq([st.mode, st.editing], ['edit', true], 'still typing');
    await page.keyboard.type('Qe');
    eq(await h.texts('ul > li'), ['첫 번째 요점', '두 번째 Qe요점', '세 번째 요점'], 'Q at the remembered place');
    eq((await h.state()).mode, 'edit', 'e typed, not presenting');
  });
}
test('R4-04 a shape\'s text undone away selects the shape; redo brings typing back into it', async ({ page, h }) => {
  await h.go(1); await h.edit();
  await h.tb('[data-act="shape"]');
  await page.keyboard.type('ab');
  await h.settle(700);
  await page.keyboard.type('cd');
  await h.settle(700);
  await page.keyboard.type('X');
  await h.settle(700);
  for (const k of ['Meta+z', 'Meta+z', 'Meta+z']) { await page.keyboard.press(k); await h.settle(150); }
  let st = await h.state();
  eq([st.mode, st.selected, st.editing], ['edit', 'Shape', false], 'the shape is selected');
  for (const k of ['Meta+Shift+z', 'Meta+Shift+z']) { await page.keyboard.press(k); await h.settle(150); }
  await page.keyboard.type('Y');
  expect((await h.cur('.shape').textContent()).includes('Y'), 'label has Y: ' + await h.cur('.shape').textContent());
  await page.keyboard.type('e');
  eq((await h.state()).mode, 'edit', 'no presenting');
});

const rightOfText = async (loc, slidePx) => loc.evaluate((el, d) => {
  const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT); let last = null; for (let n; (n = w.nextNode());) if (n.data.trim()) last = n;
  const r = document.createRange(); r.selectNodeContents(last); const rs = [...r.getClientRects()]; const b = rs[rs.length - 1];
  const sc = document.querySelector('main.deck > .slide.dk-current').getBoundingClientRect().width / 1920;
  return { x: b.right + d * sc, y: b.top + b.height / 2, inBox: b.right + d * sc < el.getBoundingClientRect().right };
}, slidePx);
for (const [tag, slide, sel, px, want] of [['the title', 0, 'h1', 200, '발표 제목X'], ['a bullet', 1, 'li:nth-child(2)', 60, '두 번째 요점X'], ['a slide heading', 1, 'h2', 120, '슬라이드 제목X']]) {
  test(`R4-05 a click beside the words of ${tag} types at the end of its line`, async ({ page, h }) => {
    await h.go(slide); await h.edit();
    const p = await rightOfText(h.cur(sel), px);
    expect(p.inBox, 'the click is inside the box');
    await page.mouse.move(p.x, p.y); await h.settle(120);
    eq((await h.shadow('.hover')).display, 'block', 'hover outline shows');
    await page.mouse.click(p.x, p.y); await h.settle(80);
    await page.keyboard.type('X');
    eq(await h.cur(sel).textContent(), want, 'typed at the end');
    eq((await h.state()).mode, 'edit', 'still editing');
  });
}
test('R4-05 letters typed with nothing to type into: no presenting, no paging, one hint; E alone later still presents', async ({ page, h }) => {
  await h.go(1); await h.edit();
  await page.keyboard.type('new result', { delay: 40 });
  const st = await h.state();
  eq([st.mode, st.cur], ['edit', 1], 'nothing happened');
  const t = await h.shadow('.toast');
  expect(t.cls.includes('show') && t.text.includes('Click the text to edit it'), 'hint: ' + t.text);
  await h.settle(2000);
  await page.keyboard.press('e');
  eq((await h.state()).mode, 'present', 'E presents');
});

test('R4-06 코드 over all three bullets: one <code> inside each bullet, never around them; again takes it off', async ({ page, h }) => {
  await h.go(1); await h.edit();
  await h.clickText(h.cur('li:nth-child(2)'));
  await page.keyboard.press('Meta+a');
  await h.pick('more', '[data-fmt="code"]');
  await page.keyboard.press('Escape');
  let ul = (await h.deck()).match(/<ul>[\s\S]*?<\/ul>/)[0];
  expect(!/<ul>\s*<code>/.test(ul) && !/<code>\s*<li/.test(ul), 'no code around bullets: ' + ul);
  eq(await page.evaluate(() => [...document.querySelectorAll('main.deck > .slide.dk-current ul > li')].map(li => [li.children.length, li.firstElementChild && li.firstElementChild.tagName, li.textContent === (li.querySelector('code') || {}).textContent])),
    [[1, 'CODE', true], [1, 'CODE', true], [1, 'CODE', true]], 'each bullet holds one code');
  await h.clickText(h.cur('li:nth-child(2) code'));
  await page.keyboard.press('Meta+a');
  await h.pick('more', '[data-fmt="code"]');
  await page.keyboard.press('Escape');
  ul = (await h.deck()).match(/<ul>[\s\S]*?<\/ul>/)[0];
  expect(!ul.includes('<code>'), 'code taken off: ' + ul);
});
const COLLIST = FIXTURE.replace('<p>왼쪽에 설명을 둡니다.</p>', '<p>왼쪽에 설명을 둡니다.</p>\n        <ul><li>항목 하나</li><li>항목 둘</li></ul>');
test('R4-06 코드 over a drag from a column paragraph into the list below wraps only the words', async ({ page, h }) => {
  await h.go(2); await h.edit();
  const mid = loc => loc.evaluate(el => { const r = document.createRange(); r.selectNodeContents(el); const b = r.getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; });
  const a = await mid(h.cur('.cols p')), b = await mid(h.cur('.cols li:first-child'));
  await h.clickText(h.cur('.cols p'));
  await h.drag(a, b, 8);
  await h.pick('more', '[data-fmt="code"]');
  await page.keyboard.press('Escape');
  const col = (await h.deck()).match(/<div class="cols">\s*<div>[\s\S]*?<\/div>/)[0];
  expect(/<p>[^<]*<code>[^<]+<\/code><\/p>/.test(col) && /<ul><li><code>[^<]+<\/code>[^<]*<\/li><li>항목 둘<\/li><\/ul>/.test(col), 'inline code in each block: ' + col);
}, { fixture: COLLIST });

// One pixel of a screenshot: a 1×1 PNG's only row needs no unfiltering.
import zlib from 'node:zlib';
const pixelAt = async (page, x, y) => {
  const png = await page.screenshot({ clip: { x: Math.round(x), y: Math.round(y), width: 1, height: 1 } });
  let i = 8; const idat = [];
  while (i < png.length) { const len = png.readUInt32BE(i), type = png.toString('ascii', i + 4, i + 8); if (type === 'IDAT') idat.push(png.subarray(i + 8, i + 8 + len)); i += 12 + len; }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  return [raw[1], raw[2], raw[3]];
};
test('R4-07 맨 뒤로 never writes a negative z-index; the shape still shows in print and in its thumbnail', async ({ page, h }) => {
  await h.go(1); await h.edit();
  await h.tb('[data-act="shape"]');
  await h.pick('objmore', '[data-obj="back"]');
  await page.keyboard.press('Escape');
  const st = await h.cur('.shape').getAttribute('style');
  expect(!/z-index:\s*-/.test(st), 'no negative z-index: ' + st);
  await h.settle(500);
  const fill = await h.cur('.shape').evaluate(e => getComputedStyle(e).backgroundColor.match(/\d+/g).slice(0, 3).map(Number));
  const t = await page.evaluate(() => { const e = document.querySelectorAll('#dk-sidebar .dk-thumb')[1].querySelector('.shape'); const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
  const px = await pixelAt(page, t.x, t.y);
  expect(px.every((v, k) => Math.abs(v - fill[k]) < 12), 'thumbnail shows the fill: ' + JSON.stringify([px, fill]));
  await page.emulateMedia({ media: 'print' });
  const top = await page.evaluate(() => { const e = document.querySelector('main.deck > .slide.dk-current .shape'); e.scrollIntoView({ block: 'center' }); const r = e.getBoundingClientRect(); const at = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2); return at === e || e.contains(at); });
  eq(top, true, 'on top of the slide in print');
  await page.emulateMedia({ media: 'screen' });
  expect(TEMPLATE.includes('isolation: isolate'), 'template slides isolate');
});

const selectAcrossMath = page => page.evaluate(() => {
  const p = document.querySelector('main.deck > .slide.dk-current p.withmath');
  const a = p.firstChild, z = [...p.childNodes].find(n => n.nodeType === 3 && n.data.includes('포함'));
  const s = getSelection(); s.setBaseAndExtent(a, 0, z, z.data.indexOf('포함') + 2);
});
test('R4-08 copying text with an inline formula and pasting it in the deck keeps the formula as TeX', async ({ page, h }) => {
  await h.go(4); await h.edit();
  await h.clickText(h.cur('p.withmath'));
  await selectAcrossMath(page);
  const clip = await fireClip(page, 'copy');
  expect(clip.text.includes('$x^2$') && !clip.text.includes('𝑥'), 'plain text has $x^2$: ' + JSON.stringify(clip.text));
  expect(clip.html.includes('data-dk-text') && clip.html.includes('<span class="math">x^2</span>'), 'html has the TeX: ' + clip.html);
  await h.clickText(h.cur('p.withmath'));
  await page.keyboard.press('End');
  await fireClip(page, 'paste', { 'text/html': clip.html, 'text/plain': clip.text });
  await h.settle(300);
  await page.keyboard.press('Escape');
  const p = (await h.deck()).match(/<p class="withmath">[\s\S]*?<\/p>/)[0];
  eq((p.match(/<span class="math">x\^2<\/span>/g) || []).length, 2, 'two formulas: ' + p);
  expect(!/<br>|&nbsp;|𝑥/.test(p), 'no KaTeX leftovers: ' + p);
  eq(await page.evaluate(() => document.querySelectorAll('main.deck > .slide.dk-current p.withmath .katex').length), 2, 'both rendered');
});
test('R4-08 ⌘X then ⌘V puts text with a formula back where it was', async ({ page, h }) => {
  await h.go(4); await h.edit();
  const before = (await h.deck()).match(/<p class="withmath">[\s\S]*?<\/p>/)[0];
  await h.clickText(h.cur('p.withmath'));
  await selectAcrossMath(page);
  const clip = await fireClip(page, 'cut');
  await h.settle(100);
  const mid = (await h.deck()).match(/<p class="withmath">[\s\S]*?<\/p>/)[0];
  expect(!mid.includes('class="math"') && mid.includes('문장'), 'cut: ' + mid);
  await fireClip(page, 'paste', { 'text/html': clip.html, 'text/plain': clip.text });
  await h.settle(300);
  await page.keyboard.press('Escape');
  eq((await h.deck()).match(/<p class="withmath">[\s\S]*?<\/p>/)[0], before, 'back as it was');
});

const SHAPE2 = FIXTURE.replace('\n</main>', `
  <section class="slide">
    <h2>도형 두 줄</h2>
    <div class="shape" data-shape="rect" style="position:absolute; left:400px; top:300px; width:600px; height:400px; background:#eef2fd;">
      <p>first</p>
      <p>second</p>
    </div>
  </section>
\n</main>`);
const textMid = loc => loc.evaluate(el => { const r = document.createRange(); r.selectNodeContents(el); const b = r.getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; });
const labels = page => page.evaluate(() => [...document.querySelector('main.deck > .slide.dk-current .shape').children].map(c => c.tagName + ':' + c.textContent.replace(/\s+/g, '')));
test('R4-09 a shape with two lines: double-click the second line selects its word and types there; typing on the selected shape goes to the end', async ({ page, h }) => {
  await h.go(5); await h.edit();
  const p = await textMid(h.cur('.shape p:nth-child(2)'));
  await page.mouse.dblclick(p.x, p.y);
  await h.settle(100);
  eq(await page.evaluate(() => getSelection().toString()), 'second', 'the word is selected');
  await page.keyboard.press('End');
  await page.keyboard.type('X');
  eq(await labels(page), ['P:first', 'P:secondX'], 'typed into the second line');
  await page.keyboard.press('Escape');
  eq((await h.state()).selected, 'Shape', 'shape selected');
  await page.keyboard.type('Y');
  eq(await labels(page), ['P:first', 'P:secondXY'], 'typing on the selected shape goes to the end');
}, { fixture: SHAPE2 });
test('R4-09 ⌘A in a shape covers every line: 글머리표 makes one list of both', async ({ page, h }) => {
  await h.go(5); await h.edit();
  const p = await textMid(h.cur('.shape p:nth-child(1)'));
  await page.mouse.dblclick(p.x, p.y);
  await page.keyboard.press('Meta+a');
  await h.pick('list', '[data-fmt="ul"]');
  await page.keyboard.press('Escape');
  eq(await labels(page), ['UL:firstsecond'], 'one list');
  eq(await page.evaluate(() => [...document.querySelectorAll('main.deck > .slide.dk-current .shape li')].map(l => l.textContent)), ['first', 'second'], 'two bullets');
}, { fixture: SHAPE2 });
test('R4-09 a drag from one line of a shape to the other selects text; Backspace removes only that text', async ({ page, h }) => {
  await h.go(5); await h.edit();
  const b = await textMid(h.cur('.shape p:nth-child(2)'));
  await page.mouse.dblclick(b.x, b.y);
  await page.keyboard.press('End');
  const a = await textMid(h.cur('.shape p:nth-child(1)'));
  await h.drag(a, b, 8);
  const st = await h.state();
  eq([st.editing, st.selected], [true, 'Shape'], 'still editing the shape text');
  await page.keyboard.press('Backspace');
  const t = await page.evaluate(() => { const s = document.querySelector('main.deck > .slide.dk-current .shape'); return s && s.textContent.replace(/\s+/g, ''); });
  expect(t && t.length > 2 && t.length < 'firstsecond'.length && t.startsWith('fi') && t.endsWith('nd'), 'only the selected text went: ' + t);
}, { fixture: SHAPE2 });

test('R4-10 a new text box sits at the content\'s left edge, grows past 900 with its text, and its side handle widens it', async ({ page, h }) => {
  await h.go(1); await h.edit();
  await h.menu('text', 'text');
  await page.keyboard.type('아주 긴 한국어 문장을 한 줄로 길게 적어서 상자가 구백 픽셀보다 넓어지는지 확인합니다');
  await page.keyboard.press('Escape');
  const box = h.cur('p[style*="absolute"]');
  const sc = await page.evaluate(() => document.querySelector('main.deck > .slide.dk-current').getBoundingClientRect().width / 1920);
  const info = () => box.evaluate((e, sc) => ({ left: parseFloat(e.style.left), w: e.getBoundingClientRect().width / sc, st: e.getAttribute('style') }), sc);
  let a = await info();
  eq(a.left, 140, 'at the content left: ' + a.st);
  expect(a.w > 900, 'wider than 900: ' + a.w);
  const ulBottom = await page.evaluate(sc => { const s = document.querySelector('main.deck > .slide.dk-current'); return (s.querySelector('ul').getBoundingClientRect().bottom - s.getBoundingClientRect().top) / sc; }, sc);
  const top = parseFloat(a.st.match(/top: ([\d.]+)px/)[1]);
  expect(top >= ulBottom + 40, 'under the list: ' + [top, ulBottom]);
  // narrower first, then wider again by the side handle
  let r = await h.handle('.sel .rw');
  await h.drag(r, { x: r.x - 400 * sc, y: r.y });
  const b = await info();
  expect(Math.abs(b.w - (a.w - 400)) < 6, 'narrower by 400: ' + JSON.stringify([a.w, b.w]));
  r = await h.handle('.sel .rw');
  await page.mouse.move(r.x, r.y); await page.mouse.down(); await page.mouse.move(r.x + 200 * sc, r.y, { steps: 5 });
  const badge = await h.shadow('.sizebadge');
  await page.mouse.up(); await h.settle(80);
  const c = await info();
  expect(Math.abs(c.w - (b.w + 200)) < 6, 'wider by 200: ' + JSON.stringify([b.w, c.w]));
  expect(badge.text.includes(String(Math.round(c.w))) || Math.abs(parseFloat(badge.text.replace(/[^\d.]/g, '')) - c.w) < 3, 'badge matches: ' + badge.text + ' ' + c.w);
  expect(!/max-width/.test(c.st), 'no max-width left: ' + c.st);
  // never past the right margin
  r = await h.handle('.sel .rw');
  await h.drag(r, { x: r.x + 900 * sc, y: r.y });
  const d = await info();
  expect(d.left + d.w <= 1920 - 140 + 2, 'stops at the right margin: ' + JSON.stringify(d));
});

const DIAGRAM = FIXTURE.replace('\n</main>', `
  <section class="slide">
    <h2>구조</h2>
    <div class="shape" data-shape="rect" style="position:absolute; left:300px; top:250px; width:400px; height:200px; background:#eef2fd;"><p>인코더</p></div>
    <div class="shape" data-shape="rect" style="position:absolute; left:1200px; top:250px; width:400px; height:200px; background:#eef2fd;"><p>디코더</p></div>
    <div class="math display" style="translate: 0px 40px;">z_{t+1}</div>
  </section>
\n</main>`);
const texOfSel = page => page.evaluate(() => { const e = deckEdit._sel()[0]; return e && (e.getAttribute('data-dk-tex') || e.textContent); });
const glyphs = (page, tex) => page.evaluate(tex => { const m = [...document.querySelectorAll('main.deck > .slide.dk-current .math')].find(e => e.getAttribute('data-dk-tex') === tex); const r = [...m.querySelectorAll('.katex-html > .base')].map(b => b.getBoundingClientRect()); return { x: (Math.min(...r.map(q => q.left)) + Math.max(...r.map(q => q.right))) / 2, y: (Math.min(...r.map(q => q.top)) + Math.max(...r.map(q => q.bottom))) / 2, left: Math.min(...r.map(q => q.left)), top: Math.min(...r.map(q => q.top)) }; }, tex);
test('R4-11 on a diagram slide a formula never steals clicks from the boxes; a new or dragged formula floats by left/top', async ({ page, h }) => {
  await h.go(5); await h.edit();
  await page.waitForFunction(() => document.querySelector('main.deck > .slide.dk-current .math .katex'));
  // the formula's box covers the upper part of the 인코더 box; a click there is on the box
  const sh = await h.cur('.shape').boundingBox();
  const at = { x: sh.x + 40, y: sh.y + 25 };
  const top = await page.evaluate(({ x, y }) => document.elementFromPoint(x, y).closest('.shape, .math').className, at);
  expect(top.includes('math'), 'the test needs the formula box on top here: ' + top);
  await page.mouse.click(at.x, at.y);
  eq((await h.state()).selected, 'Shape', 'the box is selected');
  await page.keyboard.press('Escape');
  // insert z_t: it floats
  page.__dialog = d => d.accept('z_t');
  await h.tb('[data-act="math"]');
  await page.waitForFunction(() => [...document.querySelectorAll('main.deck > .slide.dk-current .math')].some(e => e.getAttribute('data-dk-tex') === 'z_t'));
  await h.settle(200);
  let st = await page.evaluate(() => [...document.querySelectorAll('main.deck > .slide.dk-current .math')].find(e => e.getAttribute('data-dk-tex') === 'z_t').getAttribute('style'));
  expect(/position: absolute/.test(st) && /left: \d+px/.test(st), 'inserted floating: ' + st);
  // drag it to just above the arrow's place, between the boxes, inside the other formula's box row
  let g = await glyphs(page, 'z_t');
  const b = await glyphs(page, 'z_{t+1}');
  await page.mouse.click(g.x, g.y);
  await h.drag({ x: g.x, y: g.y }, { x: b.x - 180, y: b.y + 4 }, 8);
  await page.keyboard.press('Escape'); await page.keyboard.press('Escape');
  g = await glyphs(page, 'z_t');
  await page.mouse.click(g.x, g.y);
  eq(await texOfSel(page), 'z_t', 'clicking z_t selects z_t');
  st = await page.evaluate(() => deckEdit._sel()[0].getAttribute('style'));
  expect(/position: absolute/.test(st) && !/translate/.test(st), 'left/top, no translate: ' + st);
  // drag the in-flow z_{t+1} down by a lot: it floats where it was dropped
  await page.keyboard.press('Escape');
  const b0 = await glyphs(page, 'z_{t+1}');
  await page.mouse.click(b0.x, b0.y);
  eq(await texOfSel(page), 'z_{t+1}', 'z_{t+1} selected');
  await h.drag({ x: b0.x, y: b0.y }, { x: b0.x + 30, y: b0.y + 200 }, 8);
  await page.keyboard.press('Escape');
  const b1 = await glyphs(page, 'z_{t+1}');
  st = await page.evaluate(() => [...document.querySelectorAll('main.deck > .slide.dk-current .math')].find(e => e.getAttribute('data-dk-tex') === 'z_{t+1}').getAttribute('style'));
  expect(/position: absolute/.test(st) && /left: -?\d+px/.test(st) && !/translate/.test(st) && /width: max-content/.test(st), 'floated: ' + st);
  expect(Math.abs(b1.left - b0.left - 30) < 3 && Math.abs(b1.top - b0.top - 200) < 3, 'stays where dropped: ' + JSON.stringify([b0, b1]));
  // copy the whole diagram to another slide: the formulas keep their place by the boxes
  const pos = () => page.evaluate(() => [...document.querySelectorAll('main.deck > .slide.dk-current > [style*="absolute"]')].map(e => [e.style.left, e.style.top]));
  const p0 = await pos();
  await page.keyboard.press('Meta+a');
  const clip = await fireClip(page, 'copy');
  await h.go(1);
  await page.mouse.click(5, 5);
  await fireClip(page, 'paste', { 'text/html': clip.html, 'text/plain': clip.text });
  eq(await pos(), p0, 'same left/top on the other slide');
}, { fixture: DIAGRAM });

test('R4-12 발표 from the editor: full screen asked, click/Shift-click page, Esc comes back, no text selection, links still work', async ({ page, h }) => {
  await h.edit();
  await page.evaluate(() => { window.__fsCalls = 0; document.documentElement.requestFullscreen = () => { window.__fsCalls++; return Promise.resolve(); }; });
  await h.tb('[data-act="present"]');
  let st = await h.state();
  eq(st.mode, 'present', 'presenting');
  eq(await page.evaluate(() => window.__fsCalls), 1, 'full screen requested');
  const b = await page.locator('main.deck > .slide.dk-current').boundingBox();
  await page.mouse.click(b.x + b.width / 2, b.y + b.height * 0.8);
  eq((await h.state()).cur, 1, 'click: next');
  await page.keyboard.down('Shift');
  await page.mouse.click(b.x + b.width / 2, b.y + b.height * 0.8);
  await page.keyboard.up('Shift');
  eq((await h.state()).cur, 0, 'Shift-click: back');
  const w = await h.center(h.cur('h1'));
  await page.mouse.dblclick(w.x, w.y);
  eq(await page.evaluate(() => getSelection().toString()), '', 'no text selected');
  await page.keyboard.press('Escape');
  st = await h.state();
  eq([st.mode, st.cur], ['edit', 2], 'Esc: back to the editor on the slide shown');
  // a link on a slide is followed, not taken as "next"
  await page.evaluate(() => { const a = document.createElement('a'); a.href = '#3'; a.textContent = '링크'; a.id = 'lnk'; document.querySelector('main.deck > .slide.dk-current').appendChild(a); });
  await page.keyboard.press('Escape');
  await page.keyboard.press('e');
  eq((await h.state()).mode, 'present', 'E presents');
  const before = (await h.state()).cur;
  await page.click('#lnk');
  await h.settle(100);
  eq((await h.state()).cur, 2, 'link followed to slide 3, not one more: ' + before);
});

test('R4-13 a stretched text column and figure: frame and toolbar hug the content, not the empty column', async ({ page, h }) => {
  await h.go(2); await h.edit();
  await h.clickText(h.cur('.cols p'));
  await h.settle(100);
  const caret = await h.caretRect();
  const fmt = await h.rect('.fmt:not(.otb)');
  expect(Math.min(Math.abs(fmt.y - caret.y), Math.abs(fmt.bottom - caret.y), Math.abs(fmt.y - (caret.y + caret.h)), Math.abs(fmt.bottom - (caret.y + caret.h))) < 120, 'toolbar by the caret: ' + JSON.stringify([fmt, caret]));
  await page.keyboard.press('Escape');
  const last = await page.evaluate(() => { const r = document.createRange(); r.selectNodeContents(document.querySelector('main.deck > .slide.dk-current .cols li:last-child')); return r.getBoundingClientRect().bottom; });
  let sel = await h.rect('.sel');
  expect(Math.abs(sel.bottom - last) < 30, 'frame ends at the last line: ' + JSON.stringify([sel.bottom, last]));
  // clicking the empty column below selects nothing
  await page.mouse.click(sel.x + 40, sel.bottom + 120);
  eq((await h.state()).selected, null, 'nothing under the text');
  await page.evaluate(() => deckEdit.select(document.querySelector('main.deck > .slide.dk-current figure')));
  await h.settle(100);
  sel = await h.rect('.sel');
  const cap = await h.cur('figcaption').evaluate(e => { const r = document.createRange(); r.selectNodeContents(e); return r.getBoundingClientRect().bottom; });
  expect(Math.abs(sel.bottom - cap) < 30, 'figure frame ends at its caption: ' + JSON.stringify([sel.bottom, cap]));
}, { fixture: COLLIST, viewport: { width: 1440, height: 900 } });

test('R4-14 a list added under a shape floats in a free area instead of running under the shape', async ({ page, h }) => {
  await h.go(1); await h.edit();
  await h.tb('[data-act="shape"]');
  await page.keyboard.press('Escape');
  const geo = () => page.evaluate(() => {
    const s = document.querySelector('main.deck > .slide.dk-current'), sr = s.getBoundingClientRect(), k = sr.width / 1920;
    const r = e => { const b = e.getBoundingClientRect(); return { l: (b.left - sr.left) / k, t: (b.top - sr.top) / k, r: (b.right - sr.left) / k, b: (b.bottom - sr.top) / k }; };
    const uls = [...s.querySelectorAll(':scope > ul')];
    return { shape: r(s.querySelector('.shape')), first: r(uls[0]), added: uls[1] && r(uls[1]), abs: uls[1] && getComputedStyle(uls[1]).position };
  });
  let g = await geo();
  expect(g.shape.t >= g.first.b + 60, 'the shape leaves 60px under the list: ' + JSON.stringify(g));
  await h.menu('text', 'list');
  expect((await h.shadow('.toast')).text.includes('placed in a free spot'), 'toast: ' + (await h.shadow('.toast')).text);
  await page.keyboard.type('아주 긴 항목을 적어서 글이 오른쪽으로 길게 늘어나도 도형 밑으로 들어가지 않는지 봅니다');
  await h.settle(100);
  g = await geo();
  const meet = (a, b) => a.l < b.r && b.l < a.r && a.t < b.b && b.t < a.b;
  expect(g.abs === 'absolute' || !meet(g.added, g.shape), 'the list is clear of the shape: ' + JSON.stringify(g));
  expect(!meet({ ...g.added, r: g.added.l + 10 }, g.shape), 'the list does not start under the shape: ' + JSON.stringify(g));
});

test('R4-15 (a)(e) a shape pasted three times lands in three different places; the copy toast goes away on paste', async ({ page, h }) => {
  await h.go(1); await h.edit();
  await h.tb('[data-act="shape"]');
  const clip = await fireClip(page, 'copy');
  expect((await h.shadow('.toast')).cls.includes('show'), 'copy toast');
  for (let i = 0; i < 3; i++) await fireClip(page, 'paste', { 'text/html': clip.html, 'text/plain': clip.text });
  expect(!(await h.shadow('.toast')).cls.includes('show'), 'copy toast hidden after paste');
  const pos = await page.evaluate(() => [...document.querySelectorAll('main.deck > .slide.dk-current > .shape')].map(e => e.style.left + ',' + e.style.top));
  eq(pos.length, 4, 'original and three copies');
  eq(new Set(pos).size, 4, 'all in different places: ' + pos);
});
test('R4-15 (b) a figure caption copied alone is pasted with its figure', async ({ page, h }) => {
  await h.go(2); await h.edit();
  await page.evaluate(() => deckEdit.select(document.querySelector('main.deck > .slide.dk-current figcaption')));
  const clip = await fireClip(page, 'copy');
  await h.go(1);
  await page.mouse.click(5, 5);
  const n0 = await h.children();
  await fireClip(page, 'paste', { 'text/html': clip.html, 'text/plain': clip.text });
  eq(await h.children(), n0 + 1, 'one thing pasted');
  eq(await page.evaluate(() => { const s = document.querySelector('main.deck > .slide.dk-current'); return [...s.children].filter(c => c.tagName === 'FIGURE').map(f => !!f.querySelector('figcaption')); }), [true], 'a figure holding the caption');
  expect(!(await page.evaluate(() => !!document.querySelector('main.deck > .slide.dk-current > figcaption'))), 'no bare caption');
});
test('R4-15 (c) 내 버전 of a slide the AI deleted brings back its comment', async ({ page, h }) => {
  await h.edit();
  await h.save();
  await h.go(5);
  await h.clickText(h.cur('p'));
  await page.keyboard.type(' 내 수정');
  await page.keyboard.press('Escape');
  await h.settle(1300);
  const d0 = h.disk();
  const a = d0.indexOf('  <!-- 6. 분석 -->'), z = d0.indexOf('</section>', a) + 10;
  h.writeDisk(d0.slice(0, a).replace(/\n+$/, '\n') + d0.slice(z).replace(/^\n+/, ''));
  await page.waitForFunction(() => document.querySelector('#dk-chrome').shadowRoot.querySelector('.banner').classList.contains('show'), null, { timeout: 6000 });
  await h.tb('.banner [data-act="keep"]'); await h.settle(300);
  await h.save();
  expect(/<!-- 6\. 분석 -->\s*<section class="slide">\s*<h2>분석<\/h2>\s*<p>[^<]*내 수정<\/p>/.test(h.disk()), 'comment above the kept slide: ' + h.disk().slice(h.disk().indexOf('<!-- 5.')));
}, { http: true, fixture: RESULTS });
test('R4-15 (d) both of us reorder: my order stands and the toast never says the AI moved slides', async ({ page, h }) => {
  await h.edit();
  await h.save();
  await page.locator('#dk-sidebar .dk-thumb').nth(1).click({ button: 'right' });
  await h.tb('.menu [data-val="down"]');
  await h.settle(1300);
  const d0 = h.disk();
  const i4 = d0.indexOf('  <!-- 4. '), i5 = d0.indexOf('  <!-- 5. '), i6 = d0.indexOf('  <!-- 6. ');
  h.writeDisk(d0.slice(0, i4) + d0.slice(i5, i6) + d0.slice(i4, i5) + d0.slice(i6));
  await page.waitForFunction(() => document.querySelector('#dk-chrome').shadowRoot.querySelector('.toast.show'), null, { timeout: 6000 });
  const t = (await h.shadow('.toast')).text;
  expect(!t.includes('moved'), 'no move wording: ' + t);
}, { http: true, fixture: RESULTS });
test('R4-15 (f) a triple-click on a sentence with a formula selects all of it; typing replaces the line', async ({ page, h }) => {
  await h.go(3); await h.edit();
  const p = await h.cur('p').evaluate(e => { const r = document.createRange(); r.setStart(e.firstChild, 0); r.setEnd(e.firstChild, 2); const b = r.getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; });
  await page.mouse.click(p.x, p.y, { clickCount: 3 });
  await h.settle(80);
  await page.keyboard.type('새 문장');
  await page.keyboard.press('Escape');
  eq(await h.cur('p').textContent(), '새 문장', 'line replaced');
  eq(await h.cur('h2').textContent(), '수식', 'heading untouched');
});

test('R4-16 contract: SKILL.md notes, template comments and notes, white shape text saved as #fff, no pill when automated, column paragraph gap', async ({ page, h }) => {
  const skill = skillDocs();
  for (const w of ['rgb(', '⌘S once', 'reload', 'isolation: isolate']) expect(skill.includes(w), 'SKILL.md mentions ' + w);
  expect(TEMPLATE.includes('<!-- 1.') && TEMPLATE.includes('<aside class="notes">') && TEMPLATE.includes('.slide .cols > div > * + * { margin-top: 24px; }'), 'template conventions');
  expect(!(await h.shadow('.hint')).cls.includes('show'), 'no hint pill in an automated browser');
  await h.go(1); await h.edit();
  await h.tb('[data-act="shape"]');
  await h.pick('fill', '[data-val="var(--ink)"]');
  await page.keyboard.type('AB');
  await page.keyboard.press('Escape');
  const st = (await h.deck()).match(/<div class="shape"[^>]*>/)[0];
  expect(st.includes('color: #fff') && !st.includes('rgb(255, 255, 255)'), 'white text as #fff: ' + st);
  await h.go(2);
  const at = await h.cur('.cols p').evaluate(e => { const r = document.createRange(); r.setStart(e.firstChild, 4); r.setEnd(e.firstChild, 5); const b = r.getBoundingClientRect(); return { x: b.left + 1, y: b.top + b.height / 2 }; });
  await page.mouse.click(at.x, at.y);
  await page.keyboard.press('Enter');
  const gap = await page.evaluate(() => { const s = document.querySelector('main.deck > .slide.dk-current'), k = s.getBoundingClientRect().width / 1920; const ps = s.querySelectorAll('.cols > div > p'); return ps.length === 2 ? (ps[1].getBoundingClientRect().top - ps[0].getBoundingClientRect().bottom) / k : -1; });
  expect(gap >= 16, 'paragraph gap in a column: ' + gap);
});

// =====================================================================
// Interactive slides: live elements (custom elements, data-live)
// =====================================================================
// The deck's own script: a counter that builds its button in the light DOM, a text field in a shadow root, and a
// plain script that hides a quiz answer. None of what they do may reach the file.
const LIVE_SCRIPT = `<script type="module">
customElements.define('click-counter', class extends HTMLElement {
  connectedCallback() {
    if (this._ready) return;
    this._ready = true;
    const b = document.createElement('button');
    let n = 0;
    b.textContent = 'Clicked 0';
    b.onclick = () => { b.textContent = 'Clicked ' + (++n); };
    this.append(b);
  }
});
customElements.define('name-box', class extends HTMLElement {
  connectedCallback() { if (!this.shadowRoot) this.attachShadow({ mode: 'open' }).innerHTML = '<input placeholder="name">'; }
});
document.querySelectorAll('.quiz').forEach(q => {
  q.querySelector('.answer').hidden = true;
  q.querySelector('button').onclick = () => { q.querySelector('.answer').hidden = false; };
});
</script>`;
const LIVE_SLIDE = `
  <section class="slide">
    <h2>Live</h2>
    <p class="intro">Try these</p>
    <click-counter style="position:absolute; left:200px; top:760px;"><p>Counter</p></click-counter>
    <div class="quiz" data-live><p>2+2?</p><button>Show</button><p class="answer">4</p></div>
    <name-box></name-box>
  </section>
`;
const LIVE = FIXTURE.replace('</head>', LIVE_SCRIPT + '\n</head>').replace('\n</main>', LIVE_SLIDE + '\n</main>');
const LIVE_N = 5;
const LONG_TEX = 'a_1 + a_2 + a_3 + a_4 + a_5 + a_6 + a_7 + a_8 + a_9 + a_{10} + a_{11} + a_{12}';
const LONG_N = 5;
const LONG = FIXTURE.replace('\n</main>', `\n  <section class="slide">\n    <h2>Long</h2>\n    <div class="math display" style="width: 900px;">${LONG_TEX}</div>\n  </section>\n\n</main>`);
const buttons = page => page.evaluate(() => [...document.querySelectorAll('main.deck click-counter')].map(c => c.querySelectorAll('button').length));

test('live: what the deck\'s scripts do is never saved; an untouched deck composes byte for byte', async ({ page, h }) => {
  eq(await buttons(page), [1], 'the script built its button');
  eq(await page.evaluate(() => document.querySelector('.quiz .answer').hidden), true, 'and hid the answer');
  eq(await page.evaluate(t => deckEdit.composeFile(t), LIVE), LIVE, 'compose(file) === file');
  eq((await h.state()).dirty, false, 'not dirty');
  const d = await h.deck();
  expect(d.includes('<click-counter style="position:absolute; left:200px; top:760px;"><p>Counter</p></click-counter>') && d.includes('<p class="answer">4</p>') && !d.includes('<button>Clicked') && !d.includes('data-dk-src'), 'deck HTML is the file\'s');
}, { fixture: LIVE });

test('live: editing text on the slide saves the text and leaves live elements as written', async ({ page, h }) => {
  await h.go(LIVE_N); await h.edit();
  await h.save();
  await h.clickText(h.cur('.intro'));
  await page.keyboard.type('!');
  await page.keyboard.press('Escape');
  await h.save();
  const disk = h.disk();
  expect(disk.includes('Try these!'), 'text saved');
  expect(disk.includes('<click-counter style="position:absolute; left:200px; top:760px;"><p>Counter</p></click-counter>'), 'counter as written');
  expect(disk.includes('<div class="quiz" data-live=""><p>2+2?</p><button>Show</button><p class="answer">4</p></div>') || disk.includes('<div class="quiz" data-live><p>2+2?</p><button>Show</button><p class="answer">4</p></div>'), 'quiz as written: ' + disk.slice(disk.indexOf('quiz') - 12, disk.indexOf('quiz') + 110));
  expect(!disk.includes('<button>Clicked') && !disk.includes('hidden=""') && !disk.includes('data-dk-src'), 'nothing a script did');
  eq(disk.replace('Try these!', 'Try these'), LIVE.replace(/(<div class="quiz" data-live)(>)/, (m, a, b) => disk.includes('data-live=""') ? a + '=""' + b : m), 'the rest of the file unchanged');
}, { fixture: LIVE, http: true });

test('live: a press on a live element selects it whole; moving and sizing it saves only its style', async ({ page, h }) => {
  await h.go(LIVE_N); await h.edit();
  await h.save();
  const c = await h.center(h.cur('click-counter button'));
  await page.mouse.click(c.x, c.y);
  eq((await h.state()).selected, 'Interactive', 'selected as one object');
  eq((await h.state()).editing, false, 'no text editing inside');
  await h.drag(c, { x: c.x + 60, y: c.y + 30 });
  await page.keyboard.press('Meta+Shift+Period');
  await h.save();
  const disk = h.disk(), tag = disk.match(/<click-counter[^>]*>[\s\S]*?<\/click-counter>/)[0];
  expect(/left: 2\d\dpx/.test(tag) && /top: 7\d\dpx/.test(tag) && !tag.includes('left:200px;'), 'moved: ' + tag);
  expect(/zoom: 1\.1/.test(tag), 'grew with zoom: ' + tag);
  expect(tag.endsWith('><p>Counter</p></click-counter>'), 'content as written');
  eq(await buttons(page), [1], 'still one button on the page');
}, { fixture: LIVE, http: true });

test('live: while presenting, clicks and keys inside interactive elements are theirs', async ({ page, h }) => {
  await h.go(LIVE_N);
  await h.cur('click-counter button').click();
  await h.cur('click-counter button').click();
  eq(await h.cur('click-counter button').textContent(), 'Clicked 2', 'counter counts');
  await h.cur('.quiz button').click();
  eq(await page.evaluate(() => document.querySelector('.quiz .answer').hidden), false, 'answer shown');
  eq((await h.state()).cur, LIVE_N, 'clicks did not turn the page');
  await page.keyboard.press('ArrowRight');
  eq((await h.state()).cur, LIVE_N, 'last slide; arrow from a focused button still navigates (nowhere to go)');
  await page.keyboard.press('ArrowLeft');
  eq((await h.state()).cur, LIVE_N - 1, 'arrow keys still turn the page after clicking a button');
  await h.go(LIVE_N);
  await page.locator('name-box input').click();
  await page.keyboard.type('ed ');
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('Home');
  const s = await h.state();
  eq([s.mode, s.cur, await page.locator('name-box input').inputValue()], ['present', LIVE_N, 'ed '], 'typing in a field: no edit mode, no page turns');
  await page.keyboard.press('Escape');
  await page.keyboard.press('ArrowLeft');
  eq((await h.state()).cur, LIVE_N - 1, 'Escape leaves the field; arrows turn pages again');
  eq(await page.evaluate(t => deckEdit.composeFile(t), LIVE), LIVE, 'none of it saved');
}, { fixture: LIVE });

test('live: duplicate, undo and thumbnails start live elements afresh', async ({ page, h }) => {
  await h.go(LIVE_N);
  await h.cur('click-counter button').click();
  await h.edit();
  const c = await h.center(h.cur('click-counter button'));
  await page.mouse.click(c.x, c.y);
  await page.keyboard.press('Meta+d');
  await page.waitForTimeout(100);
  eq(await buttons(page), [1, 1], 'the copy has one button of its own');
  eq(await page.evaluate(() => [...document.querySelectorAll('main.deck click-counter button')].map(b => b.textContent)), ['Clicked 1', 'Clicked 0'], 'the copy starts at 0');
  await page.keyboard.press('Meta+z');
  await page.waitForTimeout(100);
  eq(await buttons(page), [1], 'undo: one counter, one button');
  await page.keyboard.press('Meta+Shift+z');
  await page.waitForTimeout(100);
  eq(await buttons(page), [1, 1], 'redo');
  await page.waitForTimeout(900);
  const thumb = await page.evaluate(n => [...document.querySelectorAll('.dk-thumb')][n].querySelectorAll('click-counter').length + ':' + [...document.querySelectorAll('.dk-thumb')][n].querySelectorAll('click-counter button').length, LIVE_N);
  eq(thumb, '2:2', 'the thumbnail shows each counter once');
  const d = await h.deck();
  eq((d.match(/<click-counter/g) || []).length, 2, 'two counters in the deck');
  expect(!d.includes('<button>Clicked') && !d.includes('data-dk-src'), 'saved as written');
}, { fixture: LIVE });

test('live: the AI rewriting a live element in the file shows it set up afresh', async ({ page, h }) => {
  await h.go(LIVE_N); await h.edit();
  await h.save();
  h.writeDisk(h.disk().replace('<p>Counter</p>', '<p>Clicks</p>'));
  await page.waitForFunction(() => document.querySelector('main.deck click-counter p')?.textContent === 'Clicks', null, { timeout: 5000 });
  eq(await buttons(page), [1], 'one button');
  eq((await h.state()).dirty, false, 'clean');
  await h.clickText(h.cur('.intro'));
  await page.keyboard.type('?');
  await page.keyboard.press('Escape');
  await h.save();
  expect(h.disk().includes('<p>Clicks</p></click-counter>') && h.disk().includes('Try these?') && !h.disk().includes('<button>Clicked'), 'saved with the AI\'s markup');
}, { fixture: LIVE, http: true });

test('a display formula too wide for its box is drawn smaller to fit, and the file keeps the TeX as written', async ({ page, h }) => {
  await h.go(LONG_N);
  await page.waitForFunction(() => document.querySelector('main.deck > .slide.dk-current .math.display .katex'));
  const r = await page.evaluate(() => {
    const m = document.querySelector('main.deck > .slide.dk-current .math.display'), k = m.querySelector('.katex');
    return { size: k.style.fontSize, fits: m.querySelector('.katex-html').scrollWidth <= m.clientWidth + 1 };
  });
  expect(/^\d+(\.\d+)?%$/.test(r.size) && parseFloat(r.size) < 100 && parseFloat(r.size) >= 60, 'shrunk: ' + r.size);
  expect(r.fits, 'fits its box at ' + r.size);
  const d = await h.deck();
  expect(d.includes(LONG_TEX.replace(/&/g, '&amp;')) && !d.includes('font-size: ' + r.size), 'saved as written');
}, { fixture: LONG });

// =====================================================================
// Single-file decks (deck export)
// =====================================================================
// The live-elements deck exported by the real `deck export`: editor packed in, assets/dot.png as a data: URL.
let SINGLE_CACHE = null;
function SINGLE() {
  if (SINGLE_CACHE) return SINGLE_CACHE;
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-single-'));
  fs.mkdirSync(path.join(d, 'talk', 'assets'), { recursive: true });
  fs.writeFileSync(path.join(d, 'talk', 'deck.html'), LIVE);
  fs.copyFileSync(path.join(SKILL, 'deck-edit.js'), path.join(d, 'talk', 'deck-edit.js'));
  fs.writeFileSync(path.join(d, 'talk', 'assets', 'dot.png'), PNG);
  const r = spawnSync('node', [path.join(SKILL, 'scripts', 'deck.mjs'), 'export', path.join(d, 'talk')], { encoding: 'utf8' });
  if (r.status) throw new Error('deck export failed: ' + r.stderr);
  SINGLE_CACHE = fs.readFileSync(path.join(d, 'talk.html'), 'utf8');
  fs.rmSync(d, { recursive: true, force: true });
  return SINGLE_CACHE;
}

test('single file: with nothing beside it, it presents, draws formulas and pictures, and runs its widgets', async ({ page, h }) => {
  const html = SINGLE();
  expect(!html.includes('src="deck-edit.js"') && !html.includes('assets/dot.png') && html.includes('data:image/png;base64,'), 'packed');
  const st = await h.state();
  eq([st.mode, st.slides], ['present', 6], 'the editor runs');
  eq(await page.evaluate(() => deckEdit.version), fs.readFileSync(path.join(SKILL, 'deck-edit.js'), 'utf8').match(/deck-edit\.js v([\w.-]+)/)[1], 'this version');
  await page.waitForFunction(() => document.querySelector('.math .katex'), null, { timeout: 15000 });
  eq(await page.evaluate(() => [...document.querySelectorAll('img.pic')].map(i => i.naturalWidth > 0)), [true], 'the picture shows');
  eq(await buttons(page), [1], 'the widget set itself up');
  eq(await page.evaluate(t => deckEdit.composeFile(t), html), html, 'an untouched file composes byte for byte');
  await page.keyboard.press('ArrowRight');
  eq((await h.state()).cur, 1, 'keys turn pages');
}, { fixture: SINGLE, bare: true });

test('single file: an edit saves into the same file; the packed editor, pictures and widgets stay as they were', async ({ page, h, dir }) => {
  const html = SINGLE();
  await h.edit();
  await h.save();
  await h.clickText(h.cur('h1'));
  await page.keyboard.type('!');
  await page.keyboard.press('Escape');
  await h.go(LIVE_N);
  await h.save();
  const got = h.disk(), want = html.replace('<h1>발표 제목</h1>', '<h1>발표 제목!</h1>').replace('<title>발표 제목</title>', '<title>발표 제목!</title>');   // the title follows the first heading
  let k = 0;
  while (k < got.length && got[k] === want[k]) k++;
  expect(got === want, `only the title changed; first difference at ${k}:\n      file: ${JSON.stringify(got.slice(k - 60, k + 80))}\n      want: ${JSON.stringify(want.slice(k - 60, k + 80))}`);
  eq(fs.readdirSync(dir).sort(), ['assets', 'deck.html'], 'nothing written beside it');
  eq(fs.readdirSync(path.join(dir, 'assets')), [], 'and nothing into assets/');
}, { fixture: SINGLE, bare: true, http: true });

// =====================================================================
// Folds (<details>)
// =====================================================================
const FOLDS = FIXTURE.replace('\n</main>', `
  <section class="slide">
    <h2>Folds</h2>
    <p class="intro">One sentence per step</p>
    <details><summary>Pseudocode</summary><pre>for step in range(K):
    update()</pre></details>
    <details open><summary>Shown</summary><p class="shown">Open as written</p></details>
  </section>

</main>`);
const FOLDS_N = 5;
const foldState = page => page.evaluate(() => [...document.querySelectorAll('main.deck > .slide.dk-current details')].map(d => d.open));

test('folds: opening and closing them while presenting is never saved', async ({ page, h }) => {
  await h.go(FOLDS_N); await h.edit();
  await h.save();
  await page.keyboard.press('Escape');
  await page.evaluate(() => deckEdit.setMode('present'));
  await h.go(FOLDS_N);
  await h.cur('details:not([open]) summary').click();
  await h.cur('details[open] summary >> nth=1').click();
  eq(await foldState(page), [true, false], 'toggled while presenting');
  eq((await h.state()).cur, FOLDS_N, 'a click on a fold does not turn the page');
  eq((await h.state()).dirty, false, 'not an edit');
  await h.edit();
  await h.clickText(h.cur('.intro'));
  await page.keyboard.type('!');
  await page.keyboard.press('Escape');
  await h.save();
  const disk = h.disk();
  expect(disk.includes('One sentence per step!'), 'the edit saved');
  expect(/<details><summary>Pseudocode<\/summary>/.test(disk) && /<details open(="")?><summary>Shown<\/summary>/.test(disk), 'folds saved as written: ' + (disk.match(/<details[^>]*>/g) || []).join(' '));
}, { fixture: FOLDS, http: true });

test('folds: while editing, a closed fold shows its content, and its text can be edited', async ({ page, h }) => {
  await h.go(FOLDS_N);
  const seen = () => page.evaluate(() => document.querySelector('main.deck > .slide.dk-current pre').checkVisibility());
  eq(await seen(), false, 'closed while presenting');
  await h.edit();
  eq(await seen(), true, 'shown while editing');
  await h.clickText(h.cur('summary'));
  eq(await foldState(page), [false, true], 'a click on its label edits it instead of opening it');
  await page.keyboard.type('s');
  await page.keyboard.press('Escape');
  expect((await h.deck()).includes('<summary>Pseudocodes</summary>'), 'label edited');
}, { fixture: FOLDS });

// =====================================================================
// Formulas: stylesheet failures and widgets
// =====================================================================
test('formulas: if KaTeX\'s stylesheet does not load, each formula still shows once', async ({ page, h, errors }) => {
  await page.route(/katex\.min\.css/, r => r.abort());
  await page.reload();
  await page.waitForFunction(() => document.querySelector('.math .katex'), null, { timeout: 15000 });
  await page.waitForFunction(() => document.documentElement.classList.contains('dk-mathml-only'), null, { timeout: 5000 });
  const shown = await page.evaluate(() => [...document.querySelectorAll('main.deck .katex')].map(k => [getComputedStyle(k.querySelector('.katex-html')).display, k.querySelector('.katex-mathml').getBoundingClientRect().width > 0]));
  expect(shown.length && shown.every(([d]) => d === 'none'), 'KaTeX\'s layout copy hidden: ' + JSON.stringify(shown));
  expect(!(await h.deck()).includes('katex'), 'nothing of it saved');
  errors.splice(0, errors.length, ...errors.filter(e => !/ERR_FAILED/.test(e)));   // the stylesheet this test blocked
});

const MATHWIDGET = FIXTURE.replace('</head>', `<script type="module">
customElements.define('copy-card', class extends HTMLElement {
  connectedCallback() { if (this.shadowRoot) return; const r = this.attachShadow({ mode: 'open' }); const draw = () => { r.innerHTML = '<button>next</button><div>' + this.innerHTML + '</div>'; r.querySelector('button').onclick = draw; }; draw(); }
});
</script>
</head>`).replace('\n</main>', `
  <section class="slide">
    <h2>Widget math</h2>
    <copy-card><div class="math display">\\Omega \\leftarrow \\Omega - \\eta \\nabla L</div></copy-card>
  </section>

</main>`);
test('formulas: a widget that copies its formulas into its shadow root shows each once, also after a click', async ({ page, h }) => {
  await h.go(5);
  const state = () => page.evaluate(() => { const r = document.querySelector('copy-card').shadowRoot; return { mathml: r.querySelectorAll('.katex math').length, html: r.querySelectorAll('.katex-html').length, raw: [...r.querySelectorAll('.math')].filter(m => !m.querySelector('.katex')).length }; });
  await page.waitForFunction(() => document.querySelector('copy-card').shadowRoot.querySelector('.katex'), null, { timeout: 15000 });
  eq(await state(), { mathml: 1, html: 0, raw: 0 }, 'drawn once, as MathML');
  await page.evaluate(() => document.querySelector('copy-card').shadowRoot.querySelector('button').click());
  await page.waitForTimeout(600);
  eq(await state(), { mathml: 1, html: 0, raw: 0 }, 'after the widget redraws');
  eq((await h.state()).cur, 5, 'still on the slide');
  expect((await h.deck()).includes('<copy-card><div class="math display">\\Omega \\leftarrow \\Omega - \\eta \\nabla L</div></copy-card>'), 'saved as written');
}, { fixture: MATHWIDGET });

// =====================================================================
// Saving by itself: deck serve (no folder prompt), autosave, view-only frames
// =====================================================================
// One real `deck serve` for these tests, with its own state folder and a free port.
let DECK_SERVER = null;
async function deckServer() {
  if (DECK_SERVER) return DECK_SERVER;
  const state = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-serve-'));
  const { spawn } = await import('node:child_process');
  const child = spawn('node', [path.join(SKILL, 'scripts', 'deck.mjs'), 'serve'], { env: { ...process.env, DECK_STATE_DIR: state, DECK_PORT: '0' }, stdio: 'ignore' });
  for (let i = 0; i < 50 && !fs.existsSync(path.join(state, 'server.json')); i++) await new Promise(r => setTimeout(r, 100));
  const st = JSON.parse(fs.readFileSync(path.join(state, 'server.json'), 'utf8'));
  process.on('exit', () => child.kill());
  DECK_SERVER = { ...st, url: file => `http://127.0.0.1:${st.port}/_deck/${st.token}${file.split(path.sep).map(encodeURIComponent).join('/')}` };
  return DECK_SERVER;
}
const viaServer = async dir => (await deckServer()).url(path.join(dir, 'deck.html'));
const pill = page => page.evaluate(() => document.querySelector('#dk-chrome').shadowRoot.querySelector('button.status').textContent);

test('deck serve: the deck is connected with no folder prompt and saves by itself a moment after an edit', async ({ page, h }) => {
  await page.waitForFunction(() => deckEdit.state.connected, null, { timeout: 5000 });
  eq(await pill(page), 'Saved ✓', 'connected from the start');
  await h.edit();
  await h.clickText(h.cur('h1'));
  await page.keyboard.type('!');
  await page.keyboard.press('Escape');
  expect((await pill(page)).includes('Edited'), 'edited: ' + await pill(page));
  await page.waitForFunction(() => !deckEdit.state.dirty, null, { timeout: 6000 });
  expect(h.disk().includes('<h1>발표 제목!</h1>'), 'on disk without ⌘S');
  eq(await pill(page), 'Saved ✓', 'saved');
  h.writeDisk(h.disk().replace('한 줄 부제', 'AI 부제'));
  await page.waitForFunction(() => document.querySelector('main.deck .sub')?.textContent === 'AI 부제', null, { timeout: 5000 });
  eq((await h.state()).dirty, false, 'the AI edit shows, nothing to save');
}, { url: viaServer, autosave: true, serial: true });

test('deck serve: typing keeps going while saves happen; every letter reaches the file', async ({ page, h }) => {
  await page.waitForFunction(() => deckEdit.state.connected, null, { timeout: 5000 });
  await h.edit();
  await h.clickText(h.cur('h1'));
  for (const w of [' 하나', ' 둘', ' 셋']) { await h.ime(w); await page.waitForTimeout(2200); }
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !deckEdit.state.dirty, null, { timeout: 6000 });
  expect(h.disk().includes('<h1>발표 제목 하나 둘 셋</h1>'), 'all of it saved: ' + (h.disk().match(/<h1>[^<]*<\/h1>/) || [])[0]);
  eq(await h.texts('h1'), ['발표 제목 하나 둘 셋'], 'and on screen');
}, { url: viaServer, autosave: true, serial: true });

test('autosave: after the folder is connected once (⌘S), later edits save by themselves', async ({ page, h }) => {
  await h.edit();
  await h.clickText(h.cur('h1'));
  await page.keyboard.type('!');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(2500);
  expect(!h.disk().includes('발표 제목!'), 'nothing written before the folder is connected');
  expect((await pill(page)).includes('Folder not connected'), 'the pill says why: ' + await pill(page));
  await h.save();
  expect(h.disk().includes('<h1>발표 제목!</h1>'), 'the first save connects and writes');
  await h.clickText(h.cur('h1'));
  await page.keyboard.type('?');
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !deckEdit.state.dirty, null, { timeout: 6000 });
  expect(h.disk().includes('<h1>발표 제목!?</h1>'), 'the next edit saved by itself');
  eq(await page.evaluate(() => window.__pickerCalls), 1, 'the picker came up once');
}, { http: true, autosave: true });

test('a deck shown inside another site\'s frame says it is view-only and never opens a folder picker', async ({ page, h, dir }) => {
  const frame = page.frames().find(f => f.url().includes('/deck.html'));
  const st = () => frame.evaluate(() => document.querySelector('#dk-chrome').shadowRoot.querySelector('button.status').textContent);
  await frame.waitForFunction(() => window.deckEdit && deckEdit.state.slides > 0);
  await frame.evaluate(() => deckEdit.setMode('edit'));
  eq(await st(), 'View only here', 'the pill');
  await frame.evaluate(() => deckEdit.save());
  eq(await frame.evaluate(() => window.__pickerCalls || 0), 0, 'no picker');
}, { http: true, noDeck: true, url: dir => {
  fs.writeFileSync(path.join(dir, 'frame.html'), `<!doctype html><iframe src="http://localhost:${port}/${path.basename(dir)}/deck.html" style="width:1400px;height:900px"></iframe>`);
  return `http://127.0.0.1:${port}/${path.basename(dir)}/frame.html`;
} });

// ---------- run ----------
// Tests run WORKERS at a time, each in its own browser context. Tests that use the clipboard (shared by every
// context of one browser) run one at a time afterwards. A test that fails is run once more on its own: if it passes
// then it is reported as flaky, so timing trouble under load stays visible instead of failing the run.
const WORKERS = Math.max(1, +(process.env.WORKERS || Math.min(6, os.cpus().length - 2)));
// (Synthetic ClipboardEvents carry their own DataTransfer and are safe to run in parallel.) `serial: true` also
// runs a test alone, for ones that time real idle timers.
const HTTP_WORKERS = Math.max(1, +(process.env.HTTP_WORKERS || 1));
const usesClipboard = t => t.serial || /navigator\.clipboard|press\(['"`]Meta\+[cxv]['"`]\)/.test(t.fn.toString());

async function runOne(t) {
  const t0 = performance.now();
  let env, error = null;
  try {
    env = await setup(t);
    env.h = helpers(env);
    env.h.dir = env.dir;
    env.h.cdp = env.cdp;
    await t.fn(env);
    const d = t.noDeck ? '' : await env.page.evaluate(() => deckEdit.deckHTML());
    expect(!/contenteditable|dk-|data-dk/.test(d), 'runtime residue in output');
    expect(!env.errors.length, 'console errors:\n      ' + env.errors.join('\n      '));
  } catch (e) {
    error = e instanceof Fail ? e.message : e.stack.split('\n').slice(0, 3).join('\n      ');
    if (env) await env.page.screenshot({ path: path.join(OUT, t.name.replace(/[^\w가-힣]+/g, '_').slice(0, 80) + '.png') }).catch(() => {});
  } finally {
    if (env) await env.ctx.close().catch(() => {});
  }
  return { t, error, ms: performance.now() - t0 };
}

(async () => {
  const started = performance.now();
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-edit-'));
  fs.mkdirSync(OUT, { recursive: true });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  port = server.address().port;
  browser = await chromium.launch({ executablePath: CHROME, headless: !process.env.HEADED });
  const picked = tests.filter(t => !FILTER || FILTER.split('|').some(f => t.name.toLowerCase().includes(f.trim())));
  const results = [];
  const report = r => {
    results.push(r);
    console.log(r.error ? `  ✗ ${r.t.name}\n      ${r.error}` : `  ✓ ${r.t.name}`);
  };
  // Save/merge tests wait on the file poller and real disk writes; they get their own phase with fewer lanes.
  const pool = async (list, n) => Promise.all(Array.from({ length: Math.min(n, list.length) }, async () => {
    while (list.length) report(await runOne(list.shift()));
  }));
  // Everything else first at full width; save/merge tests then run on their own, so other tests' load cannot slow
  // the poller and disk round trips they time.
  await pool(picked.filter(t => !usesClipboard(t) && !t.http), WORKERS);
  await pool(picked.filter(t => !usesClipboard(t) && t.http), HTTP_WORKERS);
  for (const t of picked.filter(usesClipboard)) report(await runOne(t));

  // One more try, alone, for anything that failed under load.
  const flaky = [], failed = [];
  for (const r of results.filter(r => r.error)) {
    const again = await runOne(r.t);
    if (again.error) { failed.push(again); console.log(`  ✗ ${r.t.name} (failed again on its own)\n      ${again.error}`); }
    else { flaky.push(r); console.log(`  ~ ${r.t.name} (passed on its own: flaky under load)`); }
  }

  await browser.close();
  server.close();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  fs.rmSync(path.join(os.homedir(), 'Library', 'Caches', 'deck-edit-test'), { recursive: true, force: true });
  const slow = results.slice().sort((a, b) => b.ms - a.ms).slice(0, 10);
  console.log(`\nslowest: ${slow.map(r => `${(r.ms / 1000).toFixed(1)}s ${r.t.name.slice(0, 60)}`).join('\n         ')}`);
  console.log(`\n${picked.length - failed.length} passed, ${failed.length} failed` +
    (flaky.length ? `, ${flaky.length} flaky (passed on retry):\n  - ${flaky.map(r => r.t.name).join('\n  - ')}` : '') +
    `\n${WORKERS} workers (${HTTP_WORKERS} for save/merge tests), ${((performance.now() - started) / 1000).toFixed(0)}s`);
  process.exit(failed.length ? 1 : 0);
})();
