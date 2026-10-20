#!/usr/bin/env node
// deck: create, update, check and open HTML slide decks that use deck-edit.js.
//   deck build <folder> [--no-open]            turn a short deck.html (just slides) into a full deck, check it, open it
//   deck new <folder> [--title "Talk title"]   new deck from the template
//   deck update <folder>...                     replace a deck's deck-edit.js with this skill's version
//   deck check <folder> [--shots [dir]] [--open] check the format and render every slide (needs Chrome or Aside)
//   deck open <folder>                          open the deck in Aside (or the default browser)
//   deck serve                                  the small local server deck open uses, so the page saves without a folder prompt
//   deck export <folder> [--out file.html]      one .html with the editor and images inside, to share
//   deck unpack <file.html> <folder>            turn such a file back into a deck folder
//   deck docs <editing|markup>                  print a reference from the skill (for agents that may not read files outside the project)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import zlib from 'node:zlib';
import http from 'node:http';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';

const SKILL = path.resolve(path.dirname(fs.realpathSync(new URL(import.meta.url).pathname)), '..');
const EDITOR = path.join(SKILL, 'deck-edit.js');
const TEMPLATE = path.join(SKILL, 'template.html');
const HOME = os.homedir();

const versionOf = file => {
  try { return (fs.readFileSync(file, 'utf8').slice(0, 400).match(/deck-edit\.js v([\w.-]+)/) || [])[1] || 'unknown'; }
  catch (_) { return null; }
};
const die = msg => { console.error('deck: ' + msg); process.exit(1); };
// Accept a deck folder or the deck.html inside it.
function deckFile(arg) {
  if (!arg) die('which deck? give its folder');
  const p = path.resolve(arg);
  const file = fs.existsSync(p) && fs.statSync(p).isDirectory() ? path.join(p, 'deck.html') : p;
  if (!fs.existsSync(file)) die(`no deck.html at ${file}`);
  return file;
}
// Chromium refuses write access to ~/Library (iCloud Drive's real location, cloud-storage mounts) and to the
// home, Desktop, Documents and Downloads folders themselves.
function blockedReason(dir) {
  const real = path.resolve(dir);
  if (real.startsWith(path.join(HOME, 'Library') + path.sep)) return 'it is under ~/Library (iCloud Drive app folder or cloud storage), where the browser cannot save';
  if ([HOME, ...['Desktop', 'Documents', 'Downloads'].map(d => path.join(HOME, d))].includes(real)) return 'the browser cannot save directly into your home, Desktop, Documents or Downloads folder; use a subfolder';
  return null;
}

function cmdNew(args) {
  const dir = args.find(a => !a.startsWith('--'));
  if (!dir) die('usage: deck new <folder> [--title "Talk title"]');
  const ti = args.indexOf('--title');
  const title = ti >= 0 ? args[ti + 1] : null;
  const why = blockedReason(dir);
  if (why) die(`not here: ${why}. Example: deck new ~/Documents/talks/${path.basename(dir) || 'my-talk'}`);
  const file = path.join(path.resolve(dir), 'deck.html');
  if (fs.existsSync(file)) die(`${file} already exists`);
  fs.mkdirSync(path.join(path.dirname(file), 'assets'), { recursive: true });
  let html = fs.readFileSync(TEMPLATE, 'utf8');
  if (title) html = html.replace(/<title>[^<]*<\/title>/, `<title>${title.replace(/[<&]/g, c => ({ '<': '&lt;', '&': '&amp;' })[c])}</title>`);
  fs.writeFileSync(file, html);
  fs.copyFileSync(EDITOR, path.join(path.dirname(file), 'deck-edit.js'));
  console.log(`created ${file}\n  deck-edit.js v${versionOf(EDITOR)}, assets/ for images\n  next: edit deck.html, then  deck check ${dir}  and  deck open ${dir}`);
}

// ---- deck build: a short deck.html (optional <title>, <link>s and <style>, then the slides) becomes a full deck.
const esc = t => t.replace(/[<&]/g, c => ({ '<': '&lt;', '&': '&amp;' })[c]);
const textOf = html => html.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
function parseShort(src) {
  const out = { title: null, links: [], css: [], scripts: [], body: '' };
  let rest = src.replace(/<!doctype[^>]*>/gi, '')
    // The deck's own scripts (interactive slides) go in <head>; the editor's script tag is added by build.
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, m => { if (!/src\s*=\s*["']deck-edit\.js["']/.test(m)) out.scripts.push(m.trim()); return ''; })
    .replace(/<\/?(html|head|body)\b[^>]*>|<meta\b[^>]*>/gi, '');
  rest = rest.replace(/<title>([\s\S]*?)<\/title>/i, (_, t) => { out.title = t.trim(); return ''; });
  rest = rest.replace(/<style[^>]*>([\s\S]*?)<\/style>/gi, (_, c) => { out.css.push(c); return ''; });
  rest = rest.replace(/<link\b[^>]*>/gi, l => { out.links.push(l); return ''; });
  out.body = rest.trim();
  return out;
}
// Give every slide the comment that names it (<!-- 3. Results -->) unless it already has one.
function nameSlides(body, from, errors) {
  const parts = body.split(/(?=<section\b)/i);
  let n = from;
  return parts.map((part, i) => {
    if (!/^<section\b/i.test(part)) return part;
    const tag = part.match(/^<section\b[^>]*>/i)[0];
    if (!/class\s*=\s*["'][^"']*\bslide\b/.test(tag)) errors.push(`${tag} needs class="slide"`);
    n++;
    if (/<!--[\s\S]*-->\s*$/.test(i ? parts[i - 1] : '')) return part;
    const h = part.match(/<h[1-3]\b[^>]*>([\s\S]*?)<\/h[1-3]>/i);
    const name = (h && textOf(h[1]).slice(0, 60)) || 'Slide';
    return `<!-- ${n}. ${name.replace(/--/g, '-')} -->\n` + part;
  }).join('');
}
// The :root custom properties a deck sets replace the template's palette, so the color menu lists each once.
function mergeCss(html, cssList) {
  let extra = cssList.join('\n');
  const vars = [];
  extra = extra.replace(/:root\s*\{([^}]*)\}/g, (_, d) => { vars.push(...d.split(';').map(x => x.trim()).filter(Boolean)); return ''; });
  html = html.replace(/:root\s*\{([^}]*)\}/, (m, d) => {
    let decl = d;
    for (const v of vars) {
      const name = v.split(':')[0].trim();
      const re = new RegExp(`(\\n\\s*)${name.replace(/[-]/g, '\\-')}\\s*:[^;]*;`);
      decl = re.test(decl) ? decl.replace(re, `$1${v};`) : decl.replace(/\s*$/, `\n    ${v};\n  `);
    }
    return `:root {${decl}}`;
  });
  extra = extra.split('\n').map(l => l.trim() ? '  ' + l.trim() : '').join('\n').replace(/\n{3,}/g, '\n\n').trim();
  if (extra) html = html.replace(/<\/style>/i, `\n${html.includes('/* this deck */') ? '' : '  /* this deck */\n'}  ${extra}\n</style>`);
  return html;
}
const indent = body => body.split('\n').map(l => l.trim() ? '  ' + l.replace(/^ {0,2}/, '') : '').join('\n');

async function cmdBuild(args) {
  const dir = args.find(a => !a.startsWith('--'));
  if (!dir) die('usage: deck build <folder> [--no-open]');
  const why = blockedReason(dir);
  if (why) die(`not here: ${why}. Example: ~/Documents/talks/${path.basename(dir) || 'my-talk'}`);
  const root = path.resolve(dir), file = path.join(root, 'deck.html'), partsDir = path.join(root, 'parts');
  const parts = fs.existsSync(partsDir) ? fs.readdirSync(partsDir).filter(f => f.endsWith('.html'))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).map(f => path.join(partsDir, f)) : [];
  const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
  if (!existing && !parts.length) die(`write ${file} first (just the slides), or slide files in ${partsDir}/`);
  const full = existing && /<main\b/i.test(existing);
  const shorts = [...(existing && !full ? [existing] : []), ...parts.map(f => fs.readFileSync(f, 'utf8'))].map(parseShort);
  const errors = [];
  let html;
  if (shorts.length) {
    const base = full ? existing : fs.readFileSync(TEMPLATE, 'utf8').replace(/(<main\b[^>]*>)[\s\S]*(<\/main>)/i, '$1\n$2');
    const have = full ? (existing.match(/<section\b[^>]*\bslide\b/gi) || []).length : 0;
    const body = nameSlides(shorts.map(s => s.body).filter(Boolean).join('\n\n'), have, errors);
    if (!/<section\b/i.test(body)) errors.push('no <section class="slide"> found');
    if (errors.length) die(errors.join('\n  '));
    html = base.replace(/\n?<\/main>/i, `\n${indent(body)}\n\n</main>`);
    html = mergeCss(html, shorts.flatMap(s => s.css));
    const links = [...new Set(shorts.flatMap(s => s.links))].filter(l => !html.includes(l));
    if (links.length) html = html.replace(/<style>/i, links.join('\n') + '\n<style>');
    const scripts = [...new Set(shorts.flatMap(s => s.scripts))].filter(x => !html.includes(x));
    if (scripts.length) html = html.replace(/<\/head>/i, scripts.join('\n') + '\n</head>');
    if (!full) {
      const h1 = body.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i);
      const title = shorts.map(s => s.title).find(Boolean) || (h1 && esc(textOf(h1[1]))) || 'Presentation title';
      html = html.replace(/<title>[^<]*<\/title>/, `<title>${title}</title>`);
      if (/[가-힣]/.test(body)) html = html.replace('<html lang="en">', '<html lang="ko">');
    }
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(file, html);
    if (parts.length) fs.rmSync(partsDir, { recursive: true, force: true });
  } else html = existing;
  fs.mkdirSync(path.join(root, 'assets'), { recursive: true });
  if (versionOf(path.join(root, 'deck-edit.js')) !== versionOf(EDITOR)) fs.copyFileSync(EDITOR, path.join(root, 'deck-edit.js'));
  const n = (html.match(/<section\b[^>]*\bslide\b/gi) || []).length;
  console.log(shorts.length ? `built ${file} (${n} slides${parts.length ? `, ${parts.length} part files merged` : ''})` : `${file} is already a full deck; checking it`);
  await check(file, { shots: path.join(os.tmpdir(), 'deck-shots', path.basename(root)), open: !args.includes('--no-open') });
}

// ---- deck export / unpack: a whole deck in one .html file.
// The editor goes in compressed (minified, deflated, base64) with a small synchronous inflater, so it still runs at the
// end of <body>, before the deck's module scripts, exactly like <script src="deck-edit.js">. Images and other files
// from assets/ become data: URLs. Fonts and KaTeX still come from their CDNs, as in the folder.
const LOADER = `(b=>{const d=Uint8Array.from(atob(b),c=>c.charCodeAt(0)),o=[];let p=0,t=0;
const r=n=>{let v=0;for(let i=0;i<n;i++){v|=(d[p]>>t&1)<<i;if(++t==8){t=0;p++}}return v};
const h=l=>{const c=new Uint16Array(16),f=new Uint16Array(16),s=new Uint16Array(l.length);for(const x of l)c[x]++;c[0]=0;for(let i=1;i<16;i++)f[i]=f[i-1]+c[i-1];l.forEach((x,i)=>{if(x)s[f[x]++]=i});return[c,s]};
const g=([c,s])=>{let a=0,f=0,k=0;for(let n=1;n<16;n++){a|=r(1);const m=c[n];if(a-m<f)return s[k+a-f];k+=m;f+=m;f<<=1;a<<=1}throw Error('bad data')};
const LB=[3,4,5,6,7,8,9,10,11,13,15,17,19,23,27,31,35,43,51,59,67,83,99,115,131,163,195,227,258],LE=[0,0,0,0,0,0,0,0,1,1,1,1,2,2,2,2,3,3,3,3,4,4,4,4,5,5,5,5,0],
DB=[1,2,3,4,5,7,9,13,17,25,33,49,65,97,129,193,257,385,513,769,1025,1537,2049,3073,4097,6145,8193,12289,16385,24577],DE=[0,0,0,0,1,1,2,2,3,3,4,4,5,5,6,6,7,7,8,8,9,9,10,10,11,11,12,12,13,13];
let last;do{last=r(1);const y=r(2);if(y==0){if(t){t=0;p++}const n=d[p]|d[p+1]<<8;p+=4;for(let i=0;i<n;i++)o.push(d[p++]);continue}
let L,D;if(y==1){const l=[];for(let i=0;i<288;i++)l.push(i<144?8:i<256?9:i<280?7:8);L=h(l);D=h(Array(30).fill(5))}
else{const nl=r(5)+257,nd=r(5)+1,nc=r(4)+4,O=[16,17,18,0,8,7,9,6,10,5,11,4,12,3,13,2,14,1,15],cl=Array(19).fill(0);for(let i=0;i<nc;i++)cl[O[i]]=r(3);
const C=h(cl),l=[];while(l.length<nl+nd){const x=g(C);if(x<16)l.push(x);else if(x==16){const v=l[l.length-1];for(let i=r(2)+3;i--;)l.push(v)}else for(let i=x==17?r(3)+3:r(7)+11;i--;)l.push(0)}
L=h(l.slice(0,nl));D=h(l.slice(nl))}
for(;;){const x=g(L);if(x<256)o.push(x);else if(x==256)break;else{const n=LB[x-257]+r(LE[x-257]),k=g(D),z=DB[k]+r(DE[k]);for(let i=0;i<n;i++)o.push(o[o.length-z])}}}while(!last);
(0,eval)(new TextDecoder().decode(new Uint8Array(o))+'\\n//# sourceURL=deck-edit.js')})`;
const MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', avif: 'image/avif',
  mp4: 'video/mp4', webm: 'video/webm', mp3: 'audio/mpeg', wav: 'audio/wav', js: 'text/javascript', mjs: 'text/javascript', css: 'text/css',
  json: 'application/json', woff2: 'font/woff2', woff: 'font/woff', ttf: 'font/ttf', pdf: 'application/pdf' };
const EXT = Object.fromEntries(Object.entries(MIME).reverse().map(([e, m]) => [m, e]));
const INLINE_EDITOR = /<script\b[^>]*\bdata-deck-edit\b[^>]*>[\s\S]*?<\/script>/i;
// The editor as it goes into a single file: the minified build when it matches deck-edit.js, else deck-edit.js itself.
function editorCode() {
  const src = fs.readFileSync(EDITOR, 'utf8'), min = path.join(SKILL, 'deck-edit.min.js');
  const hash = crypto.createHash('sha256').update(src).digest('hex').slice(0, 16);
  if (fs.existsSync(min)) { const m = fs.readFileSync(min, 'utf8'); if (m.includes(`minified from source ${hash}`)) return m; }
  return src;
}
// A picture far bigger than a slide is scaled down to 1920px on its long side (macOS sips); anything else goes in as it is.
function assetBytes(file) {
  const ext = path.extname(file).slice(1).toLowerCase();
  if (process.platform === 'darwin' && ['png', 'jpg', 'jpeg'].includes(ext)) {
    try {
      const info = execFileSync('sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', file], { encoding: 'utf8' });
      const [w, h] = ['pixelWidth', 'pixelHeight'].map(k => +(info.match(new RegExp(k + ': (\\d+)')) || [])[1]);
      if (Math.max(w, h) > 1920) {
        const out = path.join(os.tmpdir(), `deck-export-${process.pid}-${path.basename(file)}`);
        execFileSync('sips', ['-Z', '1920', ...(ext === 'png' ? [] : ['-s', 'formatOptions', '82']), file, '--out', out], { stdio: 'ignore' });
        const b = fs.readFileSync(out);
        fs.rmSync(out, { force: true });
        if (b.length < fs.statSync(file).size) return b;
      }
    } catch (_) { /* fall back to the original file */ }
  }
  return fs.readFileSync(file);
}
function cmdExport(args) {
  const file = deckFile(args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--out'));
  const root = path.dirname(file);
  const oi = args.indexOf('--out');
  const out = path.resolve(oi >= 0 && args[oi + 1] ? args[oi + 1] : path.join(path.dirname(root), path.basename(root) + '.html'));
  if (path.dirname(out) === root) die('write the single file outside the deck folder (the folder holds only deck.html, deck-edit.js and assets/)');
  let html = fs.readFileSync(file, 'utf8');
  if (INLINE_EDITOR.test(html)) die(`${file} already has the editor inside`);
  if (!/<script\s+src=["']deck-edit\.js["']\s*><\/script>/.test(html)) die('no <script src="deck-edit.js"></script> in deck.html');
  const code = editorCode();
  const version = (code.match(/deck-edit\.js v([\w.-]+)/) || [])[1] || 'unknown';
  const packed = zlib.deflateRawSync(Buffer.from(code), { level: 9 }).toString('base64');
  const sizes = { images: 0, n: 0 }, missing = [];
  // src="assets/…", href="assets/…" and url(assets/…), with or without ./ and quotes.
  html = html.replace(/(\b(?:src|href)\s*=\s*)(["'])(?:\.\/)?(assets\/[^"']+)\2|(url\(\s*)(["']?)(?:\.\/)?(assets\/[^"')]+)\5(\s*\))/gi, (m, a1, q, p1, a2, q2, p2, close) => {
    const rel = decodeURIComponent((p1 || p2).split(/[?#]/)[0]), f = path.join(root, rel);
    if (!fs.existsSync(f)) { missing.push(rel); return m; }
    const b = assetBytes(f), mime = MIME[path.extname(f).slice(1).toLowerCase()] || 'application/octet-stream';
    sizes.images += b.length; sizes.n++;
    const url = `data:${mime};base64,${b.toString('base64')}`;
    return p1 ? `${a1}${q}${url}${q}` : `${a2}${q2}${url}${q2}${close}`;
  });
  const tag = `<script data-deck-edit="${version}">/* deck-edit.js v${version}, packed into this file by \`deck export\`. To edit this deck with an AI, unpack it first: deck unpack <this file> <folder> */\n${LOADER}("${packed}")</script>`;
  html = html.replace(/<script\s+src=["']deck-edit\.js["']\s*><\/script>/, () => tag);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, html);
  const kb = n => (n / 1024).toFixed(0) + ' KB';
  console.log(`exported ${out}\n  ${kb(Buffer.byteLength(html))}: editor ${kb(tag.length)}${sizes.n ? `, ${sizes.n} file(s) from assets/ ${kb(sizes.images * 4 / 3)}` : ''}, the rest ${kb(Buffer.byteLength(html) - tag.length - sizes.images * 4 / 3)}`);
  missing.forEach(m => console.log(`  ! not found, left as a link: ${m}`));
  console.log('  open it in Chrome or Aside: it presents, edits and saves (⌘S) by itself. Fonts and formulas load from the internet, as in the folder.');
}
function cmdUnpack(args) {
  const [src, dir] = args.filter(a => !a.startsWith('--'));
  if (!src || !dir) die('usage: deck unpack <file.html> <folder>');
  const why = blockedReason(dir);
  if (why) die(`not here: ${why}`);
  const root = path.resolve(dir), file = path.join(root, 'deck.html');
  if (fs.existsSync(file)) die(`${file} already exists`);
  let html = fs.readFileSync(path.resolve(src), 'utf8');
  if (!/<main\b[^>]*\bdeck\b/i.test(html)) die(`${src} is not a deck (no <main class="deck">)`);
  html = html.replace(INLINE_EDITOR, '<script src="deck-edit.js"></script>');
  if (!html.includes('<script src="deck-edit.js"></script>')) html = html.replace(/<\/body>/i, '<script src="deck-edit.js"></script>\n</body>');
  fs.mkdirSync(path.join(root, 'assets'), { recursive: true });
  const seen = new Map();
  let n = 0;
  html = html.replace(/data:([\w.+-]+\/[\w.+-]+);base64,([A-Za-z0-9+/=]+)/g, (m, mime, b64) => {
    if (b64.length < 2000 && !mime.startsWith('image/')) return m;   // small inline data stays where it is
    const key = crypto.createHash('sha1').update(b64).digest('hex');
    if (!seen.has(key)) {
      const name = `file-${++n}.${EXT[mime] || 'bin'}`;
      fs.writeFileSync(path.join(root, 'assets', name), Buffer.from(b64, 'base64'));
      seen.set(key, 'assets/' + name);
    }
    return seen.get(key);
  });
  fs.writeFileSync(file, html);
  fs.copyFileSync(EDITOR, path.join(root, 'deck-edit.js'));
  console.log(`unpacked into ${root}: deck.html, deck-edit.js v${versionOf(EDITOR)}${n ? `, ${n} file(s) in assets/` : ''}`);
}

function cmdUpdate(args) {
  if (!args.length) die('usage: deck update <folder>...');
  const latest = versionOf(EDITOR);
  for (const a of args) {
    const target = path.join(path.dirname(deckFile(a)), 'deck-edit.js');
    const before = versionOf(target);
    if (before === latest && fs.readFileSync(target).equals(fs.readFileSync(EDITOR))) { console.log(`${target}: already v${latest}`); continue; }
    fs.copyFileSync(EDITOR, target);
    console.log(`${target}: ${before ? 'v' + before : 'missing'} → v${latest}`);
  }
}

function findChrome() {
  const candidates = [process.env.CHROME, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Aside.app/Contents/MacOS/Aside', '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge', '/usr/bin/google-chrome', '/usr/bin/chromium'];
  return candidates.find(c => c && fs.existsSync(c));
}

// Format rules that can be read from the file itself.
function staticChecks(file, html, errors, warnings) {
  const mains = html.match(/<main\b[^>]*>/gi) || [];
  if (mains.length !== 1 || !/class\s*=\s*["'][^"']*\bdeck\b/.test(mains[0] || '')) errors.push('need exactly one <main class="deck" data-size="1920x1080">');
  const packed = INLINE_EDITOR.test(html);
  if (!packed && !/<script\s+src=["']deck-edit\.js["']\s*><\/script>/.test(html)) errors.push('missing <script src="deck-edit.js"></script> before </body>');
  const scripts = (html.match(/<script\b[^>]*>/gi) || []).filter(s => !/src=["']deck-edit\.js["']|data-deck-edit/.test(s));
  const loc = html.search(/<main\b/i), end = html.search(/<\/main>/i);
  if (loc >= 0 && /<script\b/i.test(html.slice(loc, end))) errors.push('a <script> inside <main>; put the deck\'s scripts in <head> as <script type="module">');
  const classic = scripts.filter(s => !/type\s*=\s*["']?module|\bdefer\b|\basync\b|type\s*=\s*["']?(application\/(ld\+)?json|text\/(template|plain))/i.test(s));
  if (classic.length) warnings.push(`${classic.length} script(s) without type="module" or defer: they run before the editor records the slides; use <script type="module">`);
  const css = (html.match(/<style[^>]*>[\s\S]*?<\/style>/gi) || []).join('\n');
  if (/(\.deck|main)\s*>?\s*\.slide\b/.test(css)) warnings.push('CSS selects slides through .deck/main (e.g. ".deck > .slide"); write ".slide …" so thumbnails get the same styles');
  if (/\$[^$\n]{1,80}\$/.test(html.replace(/<(style|script)[\s\S]*?<\/\1>/gi, ''))) warnings.push('found $…$; write math as <span class="math">…</span> or <div class="math display">…</div>');
  if (/<img[^>]+src=["']https?:/i.test(html)) warnings.push('remote images; put images in assets/ and use relative paths');
  const local = path.join(path.dirname(file), 'deck-edit.js');
  const have = packed ? (html.match(/data-deck-edit="([^"]+)"/) || [])[1] : versionOf(local), latest = versionOf(EDITOR);
  if (!have) errors.push('deck-edit.js is missing next to deck.html (deck update <folder>)');
  else if (have !== latest) warnings.push(`deck-edit.js is v${have}; latest is v${latest} (deck update <folder>)`);
}

async function cmdCheck(args) {
  const file = deckFile(args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--shots'));
  const si = args.indexOf('--shots');
  const given = si >= 0 && args[si + 1] && !args[si + 1].startsWith('--') ? args[si + 1] : null;
  // Screenshots never go into the deck folder: by default they go to a temp folder named after the deck.
  const shots = si < 0 ? null : path.resolve(given || path.join(os.tmpdir(), 'deck-shots', path.basename(path.dirname(file))));
  await check(file, { shots, open: args.includes('--open') });
}

// Formulas drawn twice (KaTeX's layout and its MathML copy both showing: no stylesheet where they are, e.g. copied
// into a widget's shadow root) or not drawn at all (raw TeX), on the current slide, shadow roots included.
const MATH_PROBLEMS = `(() => {
  const s = document.querySelector('main.deck > .slide.dk-current'), twice = [], raw = [];
  const seen = el => { const r = el.getBoundingClientRect(); return r.width > 2 && r.height > 2 && el.checkVisibility({ visibilityProperty: true }); };
  const name = el => (el.getAttribute('data-dk-tex') || el.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 40);
  const walk = root => root.querySelectorAll('*').forEach(e => {
    if (e.classList.contains('katex')) {
      const m = e.querySelector(':scope > .katex-mathml'), h = e.querySelector(':scope > .katex-html');
      if (m && h && seen(m) && seen(h)) twice.push(name(e.closest('.math') || e));
    } else if (e.classList.contains('math') && !e.querySelector('.katex') && /\\[a-zA-Z]/.test(e.textContent) && seen(e)) raw.push(name(e));
    if (e.shadowRoot) walk(e.shadowRoot);
  });
  walk(s);
  return { twice: twice.slice(0, 3), raw: raw.slice(0, 3) };
})()`;
// Problems inside live elements that the text checks cannot see: a widget whose drawing spills over the slide's
// text (its shadow content can outgrow its own box), and figure labels in SVG drawn too small to read, which
// happens when a figure shrinks to make room (an opened fold, a narrow column).
const WIDGET_PROBLEMS = `(() => {
  const s = document.querySelector('main.deck > .slide.dk-current'), S = s.getBoundingClientRect(), k = S.width / 1920;
  const covers = [], tiny = [];
  const label = el => (el.textContent || el.localName).trim().replace(/\\s+/g, ' ').slice(0, 40) || el.localName;
  const all = [...s.querySelectorAll('*')].filter(e => e.hasAttribute('data-live') || e.localName.includes('-'));
  const live = all.filter(l => !all.some(o => o !== l && o.contains(l)) && l.checkVisibility({ visibilityProperty: true }));
  const each = (root, f) => root.querySelectorAll('*').forEach(e => { f(e); if (e.shadowRoot) each(e.shadowRoot, f); });
  const blocks = [...s.querySelectorAll('h1,h2,h3,p,li,td,th,figcaption,div.math')]
    .filter(b => !b.closest('.notes') && !live.some(l => l.contains(b)) && b.checkVisibility({ visibilityProperty: true }));
  const lineRects = b => {
    const rg = document.createRange(), rs = [], w = document.createTreeWalker(b, NodeFilter.SHOW_TEXT);
    let t;
    while ((t = w.nextNode())) {
      if (!t.textContent.trim() || t.parentElement.closest('.katex-mathml')) continue;
      rg.selectNodeContents(t);
      for (const r of rg.getClientRects()) if (r.width > 1 && r.height > 1) rs.push(r);
    }
    return rs;
  };
  for (const l of live) {
    const boxes = [l.getBoundingClientRect()];
    if (l.shadowRoot) each(l.shadowRoot, e => { const r = e.getBoundingClientRect(); if (r.width > 1 && r.height > 1) boxes.push(r); });
    const b = blocks.find(b => lineRects(b).some(t => boxes.some(r => Math.min(r.right, t.right) - Math.max(r.left, t.left) > 8 && Math.min(r.bottom, t.bottom) - Math.max(r.top, t.top) > 8 * k)));
    if (b && covers.length < 3) covers.push('<' + l.localName + '> covers "' + label(b) + '"');
  }
  each(s, e => {
    if (e.localName !== 'text' || !(e instanceof SVGElement) || !e.textContent.trim() || tiny.length >= 3) return;
    const r = e.getBoundingClientRect();
    if (r.width && r.height && r.height / k < 20) tiny.push('"' + label(e) + '" (' + Math.round(r.height / k) + 'px tall)');
  });
  const undefinedTags = [...new Set(all.filter(e => e.localName.includes('-') && !customElements.get(e.localName)).map(e => e.localName))];
  return { covers, tiny, undefinedTags };
})()`;
const widgetErrors = (n, w, errors, warnings, when = '') => {
  if (!when) (w.undefinedTags || []).forEach(t => errors.push(`slide ${n}: <${t}> is never defined, so it shows nothing: its script did not run (a module file loaded with src= is blocked when the deck is opened from a file; put the script inline)`));
  w.covers.forEach(c => errors.push(`slide ${n}${when}: a live element draws over text: ${c}`));
  if (w.tiny.length) warnings.push(`slide ${n}${when}: figure labels too small to read: ${w.tiny.join(', ')}`);
};
const mathErrors = (n, m, when = '') => [
  ...m.twice.map(t => `slide ${n}${when}: formula drawn twice ("${t}"): KaTeX's stylesheet does not reach it. In a widget, keep formulas as class="math" elements and let the editor draw them; never call KaTeX yourself`),
  ...m.raw.map(t => `slide ${n}${when}: formula not drawn, raw TeX shows ("${t}")`),
];

async function check(file, { shots, open }) {
  const html = fs.readFileSync(file, 'utf8');
  const errors = [], warnings = [];
  staticChecks(file, html, errors, warnings);
  const why = blockedReason(path.dirname(file));
  if (why) warnings.push(`saving from the browser will not work here: ${why}`);

  let chromium;
  try { ({ chromium } = createRequire(path.join(SKILL, '..', 'package.json'))('playwright-core')); }
  catch (_) { warnings.push(`rendering skipped: run  npm install  in ${path.resolve(SKILL, '..')}`); }
  const exe = findChrome();
  if (chromium && !exe) warnings.push('rendering skipped: no Chrome, Aside or Chromium found (set CHROME=/path/to/browser)');
  let slidesN = 0, browser = null;
  if (chromium && exe && !errors.length) {
    try { browser = await chromium.launch({ executablePath: exe, headless: true }); }
    catch (e) {
      warnings.push(`rendering skipped: ${path.basename(exe)} would not start here (a sandbox that blocks browsers?). ` +
        'Only the file checks ran; run deck check again where a browser can start, or check the slides by eye');
    }
  }
  if (browser) {
    const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
    const pageErrors = [];
    page.on('pageerror', e => pageErrors.push(e.message));
    await page.goto('file://' + file);
    await page.waitForFunction(() => window.deckEdit && window.deckEdit.state.slides > 0, null, { timeout: 15000 }).catch(() => {});
    await page.evaluate(() => document.fonts && document.fonts.ready);
    await page.waitForTimeout(800);   // KaTeX from the CDN
    await page.waitForFunction(() => window.katex || !document.querySelector('main.deck .math'), null, { timeout: 10000 }).catch(() => {});
    slidesN = await page.evaluate(() => (window.deckEdit ? window.deckEdit.state.slides : 0));
    if (!slidesN) errors.push('the page did not start the editor (no slides found)');
    if (shots) { fs.mkdirSync(shots, { recursive: true }); for (const f of fs.readdirSync(shots)) if (/^(slide-\d+(-after)?|sheet)\.png$/.test(f)) fs.rmSync(path.join(shots, f)); }
    const pngs = [];
    for (let i = 0; i < slidesN; i++) {
      await page.evaluate(i => window.deckEdit.go(i), i);
      await page.waitForTimeout(60);
      const r = await page.evaluate(() => {
        const s = document.querySelector('main.deck > .slide.dk-current');
        const S = s.getBoundingClientRect(), k = S.width / 1920;
        const out = { overflow: [], small: [], mathErrors: 0, broken: [] };
        const name = el => (el.textContent || el.getAttribute('alt') || el.tagName.toLowerCase()).trim().replace(/\s+/g, ' ').slice(0, 50) || el.tagName.toLowerCase();
        for (const el of s.querySelectorAll('*')) {
          if (el.closest('.notes, .katex') && !el.classList.contains('katex')) continue;
          if (el instanceof SVGElement && el.ownerSVGElement) continue;
          const r = el.getBoundingClientRect();
          // Hidden is hidden, closed folds included (their content keeps a box but is not drawn).
          if (!r.width || !r.height || !el.checkVisibility({ visibilityProperty: true })) continue;
          const off = Math.max(S.left - r.left, r.right - S.right, S.top - r.top, r.bottom - S.bottom) / k;
          if (off > 2 && !out.overflow.some(o => el.closest && o.el && o.el.contains(el))) out.overflow.push({ el, what: name(el), by: Math.round(off) });
          const own = [...el.childNodes].some(n => n.nodeType === 3 && n.textContent.trim());
          const fs = parseFloat(getComputedStyle(el).fontSize);
          if (own && fs < 22 && !el.closest('figure svg, table') ) out.small.push(`${name(el)} (${Math.round(fs)}px)`);
        }
        // Text that runs into other text: line boxes of different blocks that overlap by more than a sliver.
        const blocks = [...s.querySelectorAll('h1,h2,h3,h4,h5,h6,p,li,td,th,figcaption,blockquote,div.math,span.math')]
          .filter(b => !b.closest('.notes') && b.checkVisibility({ visibilityProperty: true }));
        const lines = b => {
          const rg = document.createRange(), rs = [];
          const w = document.createTreeWalker(b, NodeFilter.SHOW_TEXT);
          let t;
          while ((t = w.nextNode())) {
            if (!t.textContent.trim() || t.parentElement.closest('.katex-mathml')) continue;
            rg.selectNodeContents(t);
            for (const r of rg.getClientRects()) if (r.width > 1 && r.height > 1) rs.push(r);
          }
          return rs;
        };
        const boxes = blocks.map(b => ({ b, rs: lines(b) })).filter(x => x.rs.length);
        const hit = (a, c) => Math.min(a.right, c.right) - Math.max(a.left, c.left) > 4 && Math.min(a.bottom, c.bottom) - Math.max(a.top, c.top) > 3 * k;
        out.overlaps = [];
        for (let i = 0; i < boxes.length && out.overlaps.length < 4; i++) {
          for (let j = i + 1; j < boxes.length; j++) {
            const A = boxes[i], B = boxes[j];
            if (A.b.contains(B.b) || B.b.contains(A.b)) continue;
            if (A.rs.some(a => B.rs.some(c => hit(a, c)))) { out.overlaps.push(`"${name(A.b)}" and "${name(B.b)}"`); break; }
          }
        }
        // Text stacked with no breathing room: one block's lines end less than 6px above another's start.
        out.cramped = [];
        const cell = b => /^T[DH]$/.test(b.tagName);
        for (let i = 0; i < boxes.length && out.cramped.length < 3; i++) {
          for (let j = 0; j < boxes.length; j++) {
            const A = boxes[i], B = boxes[j];
            if (i === j || A.b.contains(B.b) || B.b.contains(A.b) || (cell(A.b) && cell(B.b))) continue;
            if (A.b.tagName === 'LI' && B.b.tagName === 'LI' && A.b.parentElement === B.b.parentElement) continue;
            // A label's lines inside one shape or card are set tight on purpose.
            const shapeA = A.b.closest('.shape, [class*="card"], [class*="box"], [class*="node"]');
            if (shapeA && shapeA.contains(B.b)) continue;
            const a = A.rs[A.rs.length - 1], c = B.rs[0];
            const gap = (c.top - a.bottom) / k, side = Math.min(a.right, c.right) - Math.max(a.left, c.left);
            if (side > 4 && gap > -3 && gap < 6 && !out.overlaps.some(o => o.includes(name(A.b)))) { out.cramped.push(`"${name(A.b)}" sits right on "${name(B.b)}"`); break; }
          }
        }
        out.mathErrors = s.querySelectorAll('.katex-error').length;
        out.broken = [...s.querySelectorAll('img')].filter(i => i.complete && !i.naturalWidth).map(i => i.getAttribute('src'));
        out.overflow = out.overflow.map(o => `"${o.what}" sticks out ${o.by}px`);
        return out;
      });
      const n = i + 1;
      r.overflow.slice(0, 4).forEach(o => errors.push(`slide ${n}: ${o}`));
      if (r.overflow.length > 4) errors.push(`slide ${n}: ${r.overflow.length - 4} more things stick out`);
      if (r.mathErrors) errors.push(`slide ${n}: ${r.mathErrors} formula(s) failed to render (bad TeX)`);
      r.broken.forEach(src => errors.push(`slide ${n}: image not found: ${src}`));
      r.overlaps.forEach(o => errors.push(`slide ${n}: text overlaps: ${o}`));
      mathErrors(n, await page.evaluate(MATH_PROBLEMS)).forEach(e => errors.push(e));
      widgetErrors(n, await page.evaluate(WIDGET_PROBLEMS), errors, warnings);
      r.cramped.forEach(o => warnings.push(`slide ${n}: no space between text: ${o}`));
      if (r.small.length) warnings.push(`slide ${n}: small text, hard to read when presenting: ${r.small.slice(0, 3).join(', ')}`);
      if (shots) pngs.push(await page.screenshot({ path: path.join(shots, `slide-${String(n).padStart(2, '0')}.png`) }));
    }
    // One image with every slide, so a look at the whole deck is a single read.
    if (shots && pngs.length) {
      const cols = pngs.length <= 4 ? 2 : 3, W = 640, H = 360, G = 12;
      const sheet = await browser.newPage({ viewport: { width: cols * W + (cols + 1) * G, height: 400 } });
      await sheet.setContent(`<body style="margin:0;padding:${G}px;background:#777;display:grid;grid-template-columns:repeat(${cols},${W}px);gap:${G}px">` +
        pngs.map((b, i) => `<div style="position:relative;width:${W}px;height:${H}px"><img src="data:image/png;base64,${b.toString('base64')}" style="width:100%;height:100%;display:block">` +
          `<b style="position:absolute;left:0;top:0;background:#000c;color:#fff;font:700 20px sans-serif;padding:2px 10px">${i + 1}</b></div>`).join('') + '</body>');
      await sheet.screenshot({ path: path.join(shots, 'sheet.png'), fullPage: true });
    }
    // The deck's scripts must leave the slides as written, except inside live elements (custom elements, data-live):
    // the editor saves a slide the user edits from the page, so anything else a script changes would end up in the file.
    if (slidesN) {
      const drift = await page.evaluate(text => {
        const parse = h => { const t = document.createElement('template'); t.innerHTML = h || ''; return [...t.content.children].filter(e => e.classList.contains('slide')).map(e => e.outerHTML); };
        const live = parse(window.deckEdit.deckHTML()), file = parse(window.deckEdit.deckFromText(text));
        for (let i = 0; i < Math.max(live.length, file.length); i++) {
          const a = file[i] || '', b = live[i] || '';
          if (a === b) continue;
          let k = 0;
          while (k < a.length && a[k] === b[k]) k++;
          const at = Math.max(0, k - 30), cut = x => x.slice(at, k + 50).replace(/\s+/g, ' ');
          return { n: i + 1, file: cut(a), page: cut(b) };
        }
        return null;
      }, html);
      if (drift) errors.push(`slide ${drift.n}: a script changed the slide, and the editor would save that change. ` +
        `File: …${drift.file}…  Page: …${drift.page}…  Keep what scripts change inside a custom element (<my-widget>) or an element with data-live, and load scripts as <script type="module">`);
    }
    // Slides with folds or interactive elements are also checked (and shot) after a viewer uses them: every fold
    // opened, every button in a live element pressed once, every slider moved to its end.
    const after = [];
    for (let i = 0; i < slidesN; i++) {
      const hit = await page.evaluate(i => {
        window.deckEdit.go(i);
        const s = document.querySelector('main.deck > .slide.dk-current');
        const all = [...s.querySelectorAll('*')].filter(e => e.hasAttribute('data-live') || e.localName.includes('-'));
        const live = all.filter(l => !all.some(o => o !== l && o.contains(l)));
        const folds = [...s.querySelectorAll('details')];
        if (!live.length && !folds.length) return false;
        folds.forEach(d => { d.open = true; });
        const each = (root, f) => root.querySelectorAll('*').forEach(e => { f(e); if (e.shadowRoot) each(e.shadowRoot, f); });
        const visit = (el, f) => { f(el); if (el.shadowRoot) each(el.shadowRoot, f); each(el, f); };
        for (const l of live) visit(l, e => {
          if (e.matches('button, [role=button]') && !e.disabled) e.click();
          else if (e.matches('input[type=range]')) { e.value = e.max || 100; e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); }
        });
        return true;
      }, i);
      if (!hit) continue;
      await page.waitForTimeout(700);   // widgets redraw, and the editor draws their formulas
      const n = i + 1;
      const out = await page.evaluate(() => {
        const s = document.querySelector('main.deck > .slide.dk-current'), S = s.getBoundingClientRect(), k = S.width / 1920, o = [];
        const each = (root, f) => root.querySelectorAll('*').forEach(e => { f(e); if (e.shadowRoot) each(e.shadowRoot, f); });
        each(s, el => {
          if (el instanceof SVGElement && el.ownerSVGElement) return;
          const r = el.getBoundingClientRect();
          if (!r.width || !r.height || o.length >= 3) return;
          const off = Math.max(S.left - r.left, r.right - S.right, S.top - r.top, r.bottom - S.bottom) / k;
          if (off > 2) o.push(`"${(el.textContent || el.localName).trim().replace(/\s+/g, ' ').slice(0, 40) || el.localName}" sticks out ${Math.round(off)}px`);
        });
        return o;
      });
      out.forEach(o => errors.push(`slide ${n} after clicking through it: ${o}`));
      mathErrors(n, await page.evaluate(MATH_PROBLEMS), ' after clicking through it').forEach(e => errors.push(e));
      widgetErrors(n, await page.evaluate(WIDGET_PROBLEMS), errors, warnings, ' after clicking through it');
      if (shots) await page.screenshot({ path: path.join(shots, `slide-${String(n).padStart(2, '0')}-after.png`) });
      after.push(n);
    }
    if (shots && after.length) warnings.push(`look at the clicked-through state too: slide-NN-after.png for slide${after.length > 1 ? 's' : ''} ${after.join(', ')} (folds open, buttons pressed, sliders at their end)`);
    pageErrors.forEach(m => errors.push('page error: ' + m));
    await browser.close();
  }
  console.log(`${file}\n  ${slidesN ? slidesN + ' slides rendered' : 'not rendered'}`);
  if (shots && slidesN) console.log(`  all slides in one image: ${path.join(shots, 'sheet.png')}  (full size: slide-01.png … in the same folder)`);
  errors.forEach(e => console.log('  ✗ ' + e));
  warnings.forEach(w => console.log('  ! ' + w));
  if (!errors.length && !warnings.length) console.log('  ✓ no problems found');
  if (open && !errors.length) await cmdOpen([file]);
  else if (open) console.log('  not opened yet: fix the errors in deck.html, then  deck check <folder> --shots --open');
  process.exit(errors.length ? 1 : 0);
}

function cmdDocs(args) {
  const dir = path.join(SKILL, 'references');
  const names = fs.readdirSync(dir).filter(f => f.endsWith('.md')).map(f => f.slice(0, -3));
  const name = (args[0] || '').replace(/\.md$/, '');
  if (name === 'skill') return process.stdout.write(fs.readFileSync(path.join(SKILL, 'SKILL.md'), 'utf8'));
  if (!names.includes(name)) die(`usage: deck docs <${[...names, 'skill'].join('|')}>`);
  process.stdout.write(fs.readFileSync(path.join(dir, name + '.md'), 'utf8'));
}

// ---- deck serve: a local server so an open deck reads and writes its own folder with no folder prompt.
// It serves http://127.0.0.1:<port>/_deck/<token>/<absolute path>; the token (in a file only this user can read) keeps other
// web pages from reaching it. It writes only a deck's own .html file and files under that deck's assets/, and stops
// after a while with no requests (an open deck asks every second or so).
const STATE_DIR = process.env.DECK_STATE_DIR || path.join(HOME, '.cache', 'html-deck');
const STATE_FILE = path.join(STATE_DIR, 'server.json');
const TYPES = { html: 'text/html; charset=utf-8', ...MIME, js: 'text/javascript; charset=utf-8', css: 'text/css; charset=utf-8' };
const readState = () => { try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch (_) { return null; } };
const isDeckHtml = f => { try { const t = fs.readFileSync(f, 'utf8'); return /<main\b[^>]*\bdeck\b/i.test(t) && /deck-edit\.js|data-deck-edit/.test(t); } catch (_) { return false; } };
function writable(f) {
  if (f.endsWith('.html')) return fs.existsSync(f) ? isDeckHtml(f) : false;
  const parts = f.split(path.sep), a = parts.lastIndexOf('assets');
  if (a < 1) return false;
  const deckDir = parts.slice(0, a).join(path.sep) || path.sep;
  return fs.readdirSync(deckDir).some(n => n.endsWith('.html') && isDeckHtml(path.join(deckDir, n)));
}
async function cmdServe() {
  const token = crypto.randomBytes(18).toString('base64url');
  let last = Date.now();
  const server = http.createServer((req, res) => {
    last = Date.now();
    const u = new URL(req.url, 'http://x'), segs = u.pathname.split('/');
    const send = (code, body = '', headers = {}) => { res.writeHead(code, { 'cache-control': 'no-store', ...headers }); res.end(body); };
    if (u.pathname === '/favicon.ico') return send(204);
    if (segs[1] !== '_deck' || segs[2] !== token) return send(404);
    const rest = segs.slice(3).map(decodeURIComponent).join('/');
    if (rest === '__deck') return send(200, JSON.stringify({ deck: true, version: versionOf(EDITOR) }), { 'content-type': 'application/json' });
    const f = path.resolve('/', rest);
    if (req.method === 'PUT') {
      // Only this server's own pages may write (a page elsewhere sends its own Origin), and only deck files.
      if (req.headers.origin !== `http://127.0.0.1:${server.address().port}`) return send(403, 'wrong origin');
      if (!writable(f)) return send(403, 'not a deck file');
      const chunks = [];
      let size = 0;
      req.on('data', c => { size += c.length; if (size > 64 * 1024 * 1024) req.destroy(); else chunks.push(c); });
      req.on('end', () => {
        try {
          fs.mkdirSync(path.dirname(f), { recursive: true });
          const tmp = path.join(path.dirname(f), `.${path.basename(f)}.${process.pid}.tmp`);
          fs.writeFileSync(tmp, Buffer.concat(chunks));
          fs.renameSync(tmp, f);   // whole or not at all: the AI never reads a half-written file
          send(200, '', { 'x-mtime': String(Math.round(fs.statSync(f).mtimeMs)) });
        } catch (e) { send(500, String(e.message)); }
      });
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(405);
    let st;
    try { st = fs.statSync(f); } catch (_) { return send(404); }
    if (!st.isFile()) return send(404);
    send(200, req.method === 'HEAD' ? '' : fs.readFileSync(f), {
      'content-type': TYPES[path.extname(f).slice(1).toLowerCase()] || 'application/octet-stream',
      'x-mtime': String(Math.round(st.mtimeMs)), 'content-length': st.size,
    });
  });
  const ports = process.env.DECK_PORT ? [+process.env.DECK_PORT] : Array.from({ length: 20 }, (_, i) => 47111 + i);
  for (const port of ports) {
    const ok = await new Promise(res => { server.once('error', () => res(false)); server.listen(port, '127.0.0.1', () => res(true)); });
    if (ok) break;
  }
  if (!server.listening) die('no free port for the deck server');
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify({ port: server.address().port, token, pid: process.pid, version: versionOf(EDITOR) }), { mode: 0o600 });
  console.log(`deck server on http://127.0.0.1:${server.address().port}/ (state in ${STATE_FILE})`);
  const idle = +(process.env.DECK_IDLE_MINUTES || 240) * 60000;
  setInterval(() => { if (Date.now() - last > idle) { try { if (readState()?.pid === process.pid) fs.rmSync(STATE_FILE); } catch (_) {} process.exit(0); } }, 30000).unref();
}
async function ping(st) {
  if (!st) return false;
  try {
    const r = await fetch(`http://127.0.0.1:${st.port}/_deck/${st.token}/__deck`, { signal: AbortSignal.timeout(800) });
    return r.ok && (await r.json()).deck === true;
  } catch (_) { return false; }
}
// The running server (started in the background if needed), or null where none can run (a sandbox).
async function ensureServer() {
  let st = readState();
  if (await ping(st) && st.version === versionOf(EDITOR)) return st;
  if (st && st.pid) { try { process.kill(st.pid); } catch (_) {} }   // an older version, or a stale file
  try {
    const child = spawn(process.execPath, [fs.realpathSync(new URL(import.meta.url).pathname), 'serve'], { detached: true, stdio: 'ignore', env: process.env });
    child.unref();
  } catch (_) { return null; }
  for (let i = 0; i < 40; i++) {
    await new Promise(r => setTimeout(r, 100));
    st = readState();
    if (st && await ping(st)) return st;
  }
  return null;
}
const serverUrl = (st, file) => `http://127.0.0.1:${st.port}/_deck/${st.token}${file.split(path.sep).map(encodeURIComponent).join('/')}`;

async function cmdOpen(args) {
  const file = deckFile(args[0]);
  // Through the local server the deck saves by itself, with no folder prompt; straight from the file it asks once.
  const st = args.includes('--file') ? null : await ensureServer();
  const target = st ? serverUrl(st, file) : file;
  const aside = '/Applications/Aside.app';
  const tries = process.platform === 'darwin' ? [...(fs.existsSync(aside) ? [['-a', aside, target]] : []),
    ['-a', 'Google Chrome', target], [target]] : [];
  const how = st ? 'edits save by themselves' : 'the first ⌘S asks for the folder once, then edits save by themselves';
  for (const t of tries) {
    try { execFileSync('open', t, { stdio: 'ignore' }); console.log(`opened ${file}${t[0] === '-a' ? ' in ' + path.basename(t[1], '.app') : ''} (${how})`); return; }
    catch (_) { /* try the next browser */ }
  }
  console.log(`could not open a browser from here; open this in a Chromium browser (Chrome, Aside): ${st ? target : 'file://' + file}`);
}

const [cmd, ...rest] = process.argv.slice(2);
const run = { serve: cmdServe, export: cmdExport, unpack: cmdUnpack, build: cmdBuild, new: cmdNew, update: cmdUpdate, check: cmdCheck, open: cmdOpen, docs: cmdDocs }[cmd];
if (cmd === 'version' || cmd === '--version') console.log(versionOf(EDITOR));
else if (!run) {
  console.log(`deck ${versionOf(EDITOR)}
  deck build <folder> [--no-open]            turn a short deck.html (just the slides) into a full deck, check and open it
  deck new <folder> [--title "Talk title"]   new deck from the template
  deck update <folder>...                     update a deck's deck-edit.js to this version
  deck check <folder> [--shots [dir]] [--open] check the format and render every slide
  deck open <folder>                          open in Aside (or the default browser)
  deck export <folder> [--out file.html]      one .html with the editor and images inside, to share
  deck serve                                  the local server deck open starts by itself (saving with no folder prompt)
  deck unpack <file.html> <folder>            turn such a file back into a deck folder
  deck docs <editing|markup|interactive|skill> print a reference (editing a deck · diagram/table markup · interactive slides · the whole skill)`);
  process.exit(cmd ? 1 : 0);
} else await run(rest);
