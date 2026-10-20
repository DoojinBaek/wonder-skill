#!/usr/bin/env node
// Adds a deck to the list in the Wonder repo's index.html, at the top, or updates its entry
// if the deck is already listed (run it again with --artifact once the deck is published).
//
// usage: node add-index.mjs <deck-folder> --title "<제목>" --summary "<한두 문장 요약>" [--artifact <url>]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const skill = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
// The Wonder repo is the nearest folder, from where you run this, that has index.html and topics/.
const findRepo = () => {
  for (let d = process.cwd(); ; d = path.dirname(d)) {
    if (fs.existsSync(path.join(d, 'index.html')) && fs.existsSync(path.join(d, 'topics'))) return d;
    if (path.dirname(d) === d) return null;
  }
};
const repo = findRepo();
if (!repo) { console.error('run this inside the Wonder repo (a folder with index.html and topics/)'); process.exit(1); }
const index = path.join(repo, 'index.html');
const args = process.argv.slice(2);
const opt = name => { const i = args.indexOf('--' + name); return i >= 0 ? args.splice(i, 2)[1] : undefined; };
const title = opt('title'), summary = opt('summary'), artifact = opt('artifact');
const deck = args[0] && path.resolve(args[0]);
if (!deck || !fs.existsSync(path.join(deck, 'deck.html'))) {
  console.error('usage: node add-index.mjs <deck-folder> --title "…" --summary "…" [--artifact <url>]');
  process.exit(1);
}
const href = path.relative(repo, path.join(deck, 'deck.html')).split(path.sep).join('/');
const date = (path.basename(deck).match(/^\d{4}-\d\d-\d\d/) || [''])[0];
const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

let html = fs.readFileSync(index, 'utf8');
const at = html.indexOf(`<li><a href="${href}">`);
let old = null;
if (at >= 0) old = html.slice(at, html.indexOf('</li>', at) + 5);
const keep = (re, fallback) => (old && (old.match(re) || [])[1]) || fallback;
const t = title ? esc(title) : keep(/<div class="t">([\s\S]*?)<\/div>/);
const s = summary ? esc(summary) : keep(/<a href="[^"]*">[\s\S]*?<div class="s">([\s\S]*?)<\/div>/);
const a = artifact || keep(/<a href="(https:\/\/claude\.ai\/[^"]+)"/);
if (!t || !s) { console.error('a new entry needs --title and --summary'); process.exit(1); }

const entry = `<li><a href="${href}">
      <div class="date">${date}</div>
      <div class="t">${t}</div>
      <div class="s">${s}</div>
    </a>${a ? `
    <div class="s" style="margin:-4px 0 0 16px"><a href="${a}" style="display:inline;border:0;padding:0;margin:0;background:none;color:var(--accent)">Artifact로 보기 ↗</a></div>` : ''}</li>`;

if (old) html = html.replace(old, () => entry);
else {
  const ul = html.indexOf('<ul>');
  if (ul < 0) { console.error('no <ul> list in index.html'); process.exit(1); }
  html = html.slice(0, ul + 4) + '\n    ' + entry + html.slice(ul + 4);
}
fs.writeFileSync(index, html);
console.log(`${old ? 'updated' : 'added'} ${href} in index.html${a ? '' : ' (no Artifact link yet: run again with --artifact <url>)'}`);
