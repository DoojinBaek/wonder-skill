#!/usr/bin/env node
// Starts a Wonder deck: topics/<date>-<slug>-deck/deck.html in the short form (references/deck-tool.md),
// with the fonts, the theme and a cover to fill in. Write the slides after the cover,
// then run `deck build` on the folder.
//
// In the Wonder repo (or a folder inside it) the deck goes to topics/; elsewhere, into --dir or the current folder.
//
// usage: node new-deck.mjs <kebab-slug> "<cover title>" [--date YYYY-MM-DD] [--dir <parent folder>]
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
const args = process.argv.slice(2);
let date = new Date().toLocaleDateString('sv-SE');   // local YYYY-MM-DD
const d = args.indexOf('--date');
if (d >= 0) { date = args[d + 1]; args.splice(d, 2); }
const di = args.indexOf('--dir');
const dirArg = di >= 0 ? args.splice(di, 2)[1] : null;
const [slug, title] = args;
if (!slug || !title || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug) || !/^\d{4}-\d\d-\d\d$/.test(date)) {
  console.error('usage: node new-deck.mjs <kebab-slug> "<cover title>" [--date YYYY-MM-DD]');
  process.exit(1);
}

const repo = findRepo();
const parent = dirArg ? path.resolve(dirArg) : repo ? path.join(repo, 'topics') : process.cwd();
const dir = path.join(parent, `${date}-${slug}-deck`);
const file = path.join(dir, 'deck.html');
if (fs.existsSync(file)) { console.error(`already exists: ${file}`); process.exit(1); }
fs.mkdirSync(dir, { recursive: true });
// The ready-made widgets (references/layouts.md) go inline: a browser blocks module files loaded from file://,
// and an inline copy also keeps the deck whole when it is published or exported.
const widgets = fs.readFileSync(path.join(skill, 'assets', 'widgets.js'), 'utf8').trim();

const theme = fs.readFileSync(path.join(skill, 'assets', 'theme.css'), 'utf8').trim();
const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
// The <title> becomes the Artifact's name, which should be short: the part before a colon.
const short = title.split(/[:：]/)[0].trim();
fs.writeFileSync(file, `<title>${esc(short)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;600&family=IBM+Plex+Sans+KR:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
${theme}

/* this deck */
</style>

<script type="module">
/* wonder widgets: copied from the skill's assets/widgets.js; documented in references/layouts.md */
${widgets}
</script>
<!-- this deck's own live elements, if any: module scripts go here, before the slides -->

<section class="slide title">
  <h1>${esc(title)}</h1>
  <p class="answer">(2~3문장: 이것이 무엇이고 무엇을 하는지, 바로 답한다)</p>
  <p class="meta">(출처 한 줄) · ${date} · Wonder</p>
</section>
`);
console.log(`created ${path.relative(process.cwd(), file)}
  next: replace the cover placeholders, write the slides after it, then  deck build ${path.relative(process.cwd(), dir) || '.'}`);
