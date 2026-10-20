// Tests for `deck build`: node tests/build.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const DECK = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../skill/scripts/deck.mjs');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-build-'));
let failed = 0;
const ok = (cond, what) => { console.log(`  ${cond ? '✓' : '✗'} ${what}`); if (!cond) failed++; };
const build = dir => spawnSync('node', [DECK, 'build', dir, '--no-open'], { encoding: 'utf8' });
const deckIn = (name, files) => {
  const dir = path.join(tmp, name);
  for (const [f, text] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), text); }
  return dir;
};

console.log('short deck.html → full deck');
{
  const dir = deckIn('short', { 'deck.html': `<title>Talk</title>
<style>
:root { --accent: #0f766e; --new: #123456; }
.slide .tag { font-size: 28px; }
</style>
<section class="slide title"><h1>월드 모델</h1></section>

<!-- 2. Kept name -->
<section class="slide"><h2>Second</h2></section>
` });
  const r = build(dir);
  const html = fs.readFileSync(path.join(dir, 'deck.html'), 'utf8');
  ok(r.status === 0, 'exit 0');
  ok(/<main class="deck" data-size="1920x1080">/.test(html) && html.trimEnd().endsWith('</html>'), 'full document with the deck <main>');
  ok(html.includes('<script src="deck-edit.js"></script>\n</body>'), 'editor script is the last line of the body');
  ok(fs.existsSync(path.join(dir, 'deck-edit.js')) && fs.existsSync(path.join(dir, 'assets')), 'deck-edit.js and assets/');
  ok(html.includes('<title>Talk</title>') && html.includes('<html lang="ko">'), 'title and lang');
  ok(html.includes('<!-- 1. 월드 모델 -->') && html.includes('<!-- 2. Kept name -->') && !html.includes('<!-- 2. Second'), 'slides named from headings; written names kept');
  ok((html.match(/:root\s*\{/g) || []).length === 1 && /--accent: #0f766e;/.test(html) && !/--accent: #2f5bea/.test(html) && html.includes('--new: #123456;'), 'palette merged into the one :root');
  ok((html.match(/<style>/g) || []).length === 1 && html.includes('.slide .tag { font-size: 28px; }'), 'deck CSS in the one <style>');
  ok(r.stdout.includes('sheet.png') || r.stdout.includes('rendering skipped'), 'reports the contact sheet');
  ok(!html.includes('Presentation title') && !html.includes('First point'), 'no template sample slides');
}

console.log('parts written in parallel');
{
  const dir = deckIn('parts', {
    'deck.html': '<title>P</title>\n<section class="slide title"><h1>Cover</h1></section>\n',
    'parts/10.html': '<section class="slide"><h2>Ten</h2></section>\n',
    'parts/2.html': '<style>.slide .two { color: red; }</style>\n<section class="slide"><h2>Two</h2></section>\n<section class="slide"><h2>Three</h2></section>\n',
  });
  ok(build(dir).status === 0, 'exit 0');
  const html = fs.readFileSync(path.join(dir, 'deck.html'), 'utf8');
  const names = [...html.matchAll(/<!-- (\d+\. \w+) -->/g)].map(m => m[1]);
  ok(JSON.stringify(names) === JSON.stringify(['1. Cover', '2. Two', '3. Three', '4. Ten']), 'parts in numeric name order: ' + names.join(', '));
  ok(html.includes('.slide .two { color: red; }'), 'part CSS merged');
  ok(!fs.existsSync(path.join(dir, 'parts')), 'parts/ removed');
  fs.mkdirSync(path.join(dir, 'parts'));
  fs.writeFileSync(path.join(dir, 'parts/01.html'), '<section class="slide"><h2>Later</h2></section>');
  const before = html;
  ok(build(dir).status === 0, 'parts appended to a built deck');
  const after = fs.readFileSync(path.join(dir, 'deck.html'), 'utf8');
  ok(after.startsWith(before.slice(0, before.indexOf('\n</main>'))) && after.includes('<!-- 5. Later -->'), 'existing slides untouched; new slide numbered after them');
}

console.log('mistakes');
{
  const dir = deckIn('wrapped', { 'deck.html': '<!DOCTYPE html><html><head><title>W</title></head><body>\n<section class="slide"><h2>One</h2></section>\n<script src="deck-edit.js"></script></body></html>' });
  ok(build(dir).status === 0, 'a full-page wrapper without <main> still builds');
  const html = fs.readFileSync(path.join(dir, 'deck.html'), 'utf8');
  ok((html.match(/<script/g) || []).length === 1 && (html.match(/<body>/g) || []).length === 1, 'one script, one body');
  const bad = deckIn('bad', { 'deck.html': '<section><h2>No class</h2></section>' });
  const r = build(bad);
  ok(r.status === 1 && r.stderr.includes('class="slide"'), 'a section without class="slide" is refused');
  ok(fs.readFileSync(path.join(bad, 'deck.html'), 'utf8') === '<section><h2>No class</h2></section>', 'and the file is left as it was');
  ok(build(path.join(tmp, 'empty')).status === 1, 'no deck.html and no parts: refused');
  ok(build(path.join(os.homedir(), 'Documents')).status === 1, 'refuses ~/Documents itself');
}

console.log('interactive slides');
{
  const script = `<script type="module">
customElements.define('tap-count', class extends HTMLElement { connectedCallback() { if (!this.shadowRoot) this.attachShadow({ mode: 'open' }).innerHTML = '<button>0</button>'; } });
document.querySelectorAll('[data-live] .answer').forEach(a => { a.hidden = true; });
</script>`;
  const good = deckIn('live-good', { 'deck.html': `<title>L</title>\n${script}\n<section class="slide"><h2>Quiz</h2><tap-count></tap-count><div data-live><p class="answer">4</p></div></section>\n` });
  const r = build(good);
  const html = fs.readFileSync(path.join(good, 'deck.html'), 'utf8');
  ok(r.status === 0, 'scripts that change only live elements pass the check' + (r.status ? ': ' + r.stdout : ''));
  ok(html.indexOf('<script type="module">') > 0 && html.indexOf('<script type="module">') < html.indexOf('</head>'), 'the deck\'s script goes in <head>');
  ok((html.match(/<script/g) || []).length === 2 && html.includes('<script src="deck-edit.js"></script>\n</body>'), 'and the editor\'s stays last');
  const bad = deckIn('live-bad', { 'deck.html': `${script.replace('[data-live] .answer', '.answer')}\n<section class="slide"><h2>Quiz</h2><div><p class="answer">4</p></div></section>\n` });
  const r2 = build(bad);
  ok(r2.status === 1 && /slide 1: a script changed the slide/.test(r2.stdout) && r2.stdout.includes('data-live'), 'a script changing a slide outside live elements is an error');
  const inMain = deckIn('live-main', { 'deck.html': '<section class="slide"><h2>X</h2><script>1</script></section>' });
  const r3 = build(inMain);
  ok(r3.status === 0 && !fs.readFileSync(path.join(inMain, 'deck.html'), 'utf8').match(/<main[\s\S]*<script[\s\S]*<\/main>/), 'a script written inside a slide is moved to <head>');
}

console.log('clicked-through checks');
{
  const shots = path.join(tmp, 'after-shots');
  const dir = deckIn('after', { 'deck.html': `<script type="module">
customElements.define('show-more', class extends HTMLElement { connectedCallback() { if (this.shadowRoot) return; const r = this.attachShadow({ mode: 'open' }); r.innerHTML = '<button>more</button><div hidden style="height: 2000px">long</div>'; r.querySelector('button').onclick = () => { r.querySelector('div').hidden = false; }; } });
</script>
<section class="slide"><h2>Fold</h2><details><summary>Open</summary><div style="height: 1400px">tall</div></details></section>
<section class="slide"><h2>Widget</h2><show-more></show-more></section>
<section class="slide"><h2>Plain</h2></section>
` });
  build(dir);
  const r = spawnSync('node', [DECK, 'check', dir, '--shots', shots], { encoding: 'utf8' });
  ok(r.status === 1 && /slide 1 after clicking through it: .*sticks out/.test(r.stdout) && /slide 2 after clicking through it: .*sticks out/.test(r.stdout), 'what sticks out once a fold is opened or a button pressed is an error');
  ok(!/slide 1: "tall" sticks out/.test(r.stdout), 'a closed fold is not measured as if it were open');
  ok(fs.existsSync(path.join(shots, 'slide-01-after.png')) && fs.existsSync(path.join(shots, 'slide-02-after.png')) && !fs.existsSync(path.join(shots, 'slide-03-after.png')), 'clicked-through shots for the slides that have something to click');
}

console.log('formulas in widgets');
{
  // A widget that copies its own content (formulas included) into its shadow root, now and on every click.
  const widget = `<script type="module">
customElements.define('copy-card', class extends HTMLElement {
  connectedCallback() { if (this.shadowRoot) return; const r = this.attachShadow({ mode: 'open' }); const draw = () => { r.innerHTML = '<button>next</button><div>' + this.innerHTML + '</div>'; r.querySelector('button').onclick = draw; }; draw(); }
});
// A widget that draws KaTeX itself into its shadow root, without the stylesheet.
customElements.define('own-katex', class extends HTMLElement {
  connectedCallback() { if (this.shadowRoot) return; const r = this.attachShadow({ mode: 'open' }); const t = setInterval(() => { if (!window.katex) return; clearInterval(t); r.innerHTML = '<div></div>'; window.katex.render('x^2 + y^2', r.firstChild, { displayMode: true }); }, 50); }
});
</script>`;
  const good = deckIn('math-good', { 'deck.html': `${widget}\n<section class="slide"><h2>Copy</h2><div class="math display">a = b</div><copy-card><div class="math display">\\Omega \\leftarrow \\Omega - \\eta</div></copy-card></section>\n` });
  const r = build(good);
  ok(r.status === 0, 'a widget that copies its formulas draws them once, before and after clicks' + (r.status ? ': ' + r.stdout.split('\n').filter(l => l.includes('✗')).join(' | ') : ''));
  const bad = deckIn('math-bad', { 'deck.html': `${widget}\n<section class="slide"><h2>Own</h2><p>See <span class="math">x</span></p><own-katex></own-katex></section>\n` });
  const r2 = build(bad);
  ok(r2.status === 1 && /formula drawn twice/.test(r2.stdout), 'a widget drawing KaTeX without its stylesheet is reported');
}

console.log('export and unpack');
{
  const crypto = await import('node:crypto');
  const SKILL = path.dirname(path.dirname(DECK));
  const src = fs.readFileSync(path.join(SKILL, 'deck-edit.js'), 'utf8');
  const hash = crypto.createHash('sha256').update(src).digest('hex').slice(0, 16);
  ok(fs.readFileSync(path.join(SKILL, 'deck-edit.min.js'), 'utf8').includes(`minified from source ${hash}`), 'deck-edit.min.js is built from this deck-edit.js (else: npm run build)');
  const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==', 'base64');
  const dir = deckIn('exp/talk', { 'deck.html': '<title>E</title>\n<style>.slide.bg { background: url(assets/dot.png); }</style>\n<section class="slide bg"><h2>Pic</h2><img src="assets/dot.png" alt="dot" style="width: 40px"><img src="./assets/big.png" alt="big" style="width: 600px"></section>\n', 'assets/dot.png': PNG });
  spawnSync('sips', ['-z', '2400', '3600', path.join(dir, 'assets/dot.png'), '--out', path.join(dir, 'assets/big.png')], { stdio: 'ignore' });
  ok(build(dir).status === 0, 'built');
  const folderHtml = fs.readFileSync(path.join(dir, 'deck.html'), 'utf8');
  const r = spawnSync('node', [DECK, 'export', dir], { encoding: 'utf8' });
  const out = path.join(tmp, 'exp', 'talk.html');
  ok(r.status === 0 && fs.existsSync(out), 'exported next to the folder: ' + (r.stderr || r.stdout.split('\n')[0]));
  const one = fs.readFileSync(out, 'utf8');
  ok(!one.includes('assets/') && (one.match(/data:image\/png;base64,/g) || []).length === 3, 'every picture inside, the CSS one too');
  ok(one.includes('<script data-deck-edit="') && !one.includes('src="deck-edit.js"'), 'editor inside');
  const editorKB = (one.match(/<script data-deck-edit[\s\S]*?<\/script>/) || [''])[0].length / 1024;
  ok(editorKB < 100, `the packed editor is small: ${editorKB.toFixed(0)} KB`);
  const big = one.match(/<img src="data:image\/png;base64,([^"]+)" alt="big"/);
  if (big && process.platform === 'darwin') {
    const f = path.join(tmp, 'big-out.png');
    fs.writeFileSync(f, Buffer.from(big[1], 'base64'));
    const w = +(spawnSync('sips', ['-g', 'pixelWidth', f], { encoding: 'utf8' }).stdout.match(/pixelWidth: (\d+)/) || [])[1];
    ok(w === 1920, 'a picture bigger than a slide is scaled to 1920px: ' + w);
  }
  const c = spawnSync('node', [DECK, 'check', out], { encoding: 'utf8' });
  ok(c.status === 0 && c.stdout.includes('1 slides rendered'), 'deck check passes on the single file: ' + c.stdout.split('\n').slice(1).join(' | '));
  ok(spawnSync('node', [DECK, 'export', out.replace('.html', ''), '--out', path.join(dir, 'x.html')]).status === 1, 'refuses to write into the deck folder');
  const back = path.join(tmp, 'exp', 'back');
  const u = spawnSync('node', [DECK, 'unpack', out, back], { encoding: 'utf8' });
  ok(u.status === 0, 'unpacked: ' + (u.stderr || u.stdout.trim()));
  const again = fs.readFileSync(path.join(back, 'deck.html'), 'utf8');
  ok(again.includes('<script src="deck-edit.js"></script>') && fs.existsSync(path.join(back, 'deck-edit.js')) && !again.includes('data-deck-edit'), 'the editor back as a file');
  ok(fs.readdirSync(path.join(back, 'assets')).length === 2 && !again.includes('base64'), 'pictures back in assets/ (the same picture once)');
  const norm = h => h.replace(/(\.\/)?assets\/[\w.-]+/g, 'assets/X');
  { const a = norm(again), b = norm(folderHtml); let k = 0; while (k < a.length && a[k] === b[k]) k++; ok(a === b, 'the same deck as the folder it came from' + (a === b ? '' : ': ' + JSON.stringify([a.slice(k - 40, k + 60), b.slice(k - 40, k + 60)]))); }
  ok(build(back).status === 0, 'and it checks clean');
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(failed ? `${failed} failed` : 'all passed');
process.exit(failed ? 1 : 0);
