#!/usr/bin/env node
// Prepares a deck for the Artifact tool. The app's preview panel does not run scripts,
// so decks are shown as private Artifacts instead.
//
// Writes <out-dir>/<slug>/<slug>.html: deck.html without <!doctype>, <html>, <head> and <body>
// (the Artifact is wrapped in its own document when published), plus the viewport meta next
// to <title>. Prints that path and the `files` map (deck-edit.js and assets/) to pass along.
// The deck folder itself is not changed.
//
// The Artifact takes its name from <title>, which should be a short name ("InfiLoop", not the whole cover
// title): the copy keeps only the part before a colon, or uses --title.
//
// usage: node publish-copy.mjs <deck-folder> <out-dir> [--title "<short name>"]     (out-dir: your scratchpad)
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const ti = args.indexOf('--title');
const titleArg = ti >= 0 ? args.splice(ti, 2)[1] : null;
const [deckArg, outArg] = args;
if (!deckArg || !outArg) { console.error('usage: node publish-copy.mjs <deck-folder> <out-dir>'); process.exit(1); }
const deck = path.resolve(deckArg);
const src = path.join(deck, 'deck.html');
if (!fs.existsSync(src)) { console.error(`no deck.html in ${deck}`); process.exit(1); }
const slug = path.basename(deck).replace(/-deck$/, '');

let html = fs.readFileSync(src, 'utf8');
if (!/<main class="deck"/.test(html)) { console.error('deck.html is still in short form: run  deck build  first'); process.exit(1); }
html = html
  .replace(/<!doctype[^>]*>\s*/i, '')
  .replace(/<\/?(html|head|body)(\s[^>]*)?>\s*/gi, '');
html = html.replace(/<title>([\s\S]*?)<\/title>/i, (m, t) => `<title>${titleArg ? titleArg.replace(/</g, '&lt;') : t.split(/[:：]/)[0].trim()}</title>`);
const meta = '<meta name="claude:viewport-fit-sides" content="cover">';
if (!html.includes('claude:viewport-fit-sides')) html = /<\/title>/i.test(html) ? html.replace(/<\/title>/i, m => `${m}\n${meta}`) : `${meta}\n${html}`;

const outDir = path.join(path.resolve(outArg), slug);
fs.mkdirSync(outDir, { recursive: true });
const page = path.join(outDir, `${slug}.html`);
fs.writeFileSync(page, html);

const files = { 'deck-edit.js': path.join(deck, 'deck-edit.js') };
const walk = (dir, rel) => {
  if (!fs.existsSync(dir)) return;
  for (const f of fs.readdirSync(dir)) {
    if (f.startsWith('.')) continue;
    const p = path.join(dir, f), r = `${rel}/${f}`;
    if (fs.statSync(p).isDirectory()) walk(p, r); else files[r] = p;
  }
};
walk(path.join(deck, 'assets'), 'assets');

console.log(JSON.stringify({ file_path: page, files }, null, 2));
