// npm run build: writes skill/deck-edit.min.js, the copy of the editor that `deck export` packs into single-file decks.
// Its first line names the source it was built from; the tests fail when deck-edit.js changed since.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { transform } from 'esbuild';

const SKILL = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', 'skill');
const src = fs.readFileSync(path.join(SKILL, 'deck-edit.js'), 'utf8');
export const sourceHash = s => crypto.createHash('sha256').update(s).digest('hex').slice(0, 16);
const version = (src.match(/deck-edit\.js v([\w.-]+)/) || [])[1];
const { code } = await transform(src, { minify: true, legalComments: 'none', target: 'chrome110' });
const out = `/*! deck-edit.js v${version} · minified from source ${sourceHash(src)} · https://github.com/DoojinBaek/html-deck */\n${code}`;
fs.writeFileSync(path.join(SKILL, 'deck-edit.min.js'), out);
console.log(`skill/deck-edit.min.js: v${version}, ${(out.length / 1024).toFixed(0)} KB (source ${(src.length / 1024).toFixed(0)} KB)`);
