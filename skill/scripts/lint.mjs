#!/usr/bin/env node
// Flags the patterns that past Wonder decks were criticized for, so you can look at those
// slides again before the reader test. It only reads deck.html (short or full form) and never
// fails: a flag is a place to look, and some flags will be fine on a second look.
//
// usage: node lint.mjs <deck-folder | deck.html>
import fs from 'node:fs';
import path from 'node:path';

const arg = process.argv[2];
if (!arg) { console.error('usage: node lint.mjs <deck-folder | deck.html>'); process.exit(1); }
const file = fs.existsSync(arg) && fs.statSync(arg).isDirectory() ? path.join(arg, 'deck.html') : arg;
const src = fs.readFileSync(file, 'utf8');
const main = src.includes('<main') ? src.slice(src.indexOf('<main')) : src;
const slides = main.split(/(?=<section class="slide)/).slice(1).map(s => s.split('</section>')[0]);

const strip = h => h.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
// The main reading path: no speaker notes, folds, scripts, figure labels, live elements or TeX.
const mainPath = h => h
  .replace(/<aside class="notes">[\s\S]*?<\/aside>/g, '')
  .replace(/<details[\s\S]*?<\/details>/g, '')
  .replace(/<(script|style|svg)\b[\s\S]*?<\/\1>/g, '')
  .replace(/<([a-z]+-[a-z0-9-]+)\b[^>]*>[\s\S]*?<\/\1>/g, '')
  .replace(/<(span|div)[^>]*class="math[^"]*"[^>]*>[\s\S]*?<\/\1>/g, ' [수식] ');
const hangul = t => (t.match(/[가-힣]/g) || []).length;
const title = h => strip((h.match(/<h[12][^>]*>([\s\S]*?)<\/h[12]>/) || [, ''])[1]
  .replace(/<span[^>]*class="math[^"]*"[^>]*>[\s\S]*?<\/span>/g, '[수식]'));

const flags = [];
const flag = (i, msg) => flags.push(`slide ${i + 1}${i >= 0 && title(slides[i]) ? ` 「${title(slides[i]).slice(0, 28)}…」` : ''}: ${msg}`);
const layouts = [];

slides.forEach((s, i) => {
  const cover = i === 0, last = i === slides.length - 1;
  const body = mainPath(s), text = strip(body);
  const t = title(s);

  if (/\(2~3문장|\(출처 한 줄\)/.test(s)) flag(i, 'the cover placeholders from new-deck.mjs are still there');
  if (/class="kicker"/.test(s)) flag(i, 'small label above the title (.kicker): the user reads these as template habit');
  if (/—/.test(text) || /—/.test(t)) flag(i, 'em dash (—): use a comma, a period or parentheses');
  if (/[!！]/.test(text.replace(/!=|\\!/g, ''))) flag(i, 'exclamation mark on the slide');
  if (/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(text)) flag(i, 'emoji on the slide');
  if (/핵심\s*:|한 줄 답\s*:|요약\s*:/.test(text)) flag(i, 'a "핵심:"-style tag: say the point as a sentence');
  if (/이 덱(은|에서|의)/.test(t)) flag(i, 'a title about the deck itself: say what the slide shows about the topic');
  if (/하나로 따라간다|하는 법$|여정|비밀/.test(t)) flag(i, `title reads like a tagline ("${t}"): say what the thing is or what the slide shows`);
  if (/(가|이) 아니라/.test(t)) flag(i, 'title in "X가 아니라 Y" form: state Y');
  if (cover) return;

  if (!last) {
    const hasFig = /class="fig"|<svg|<img|<[a-z]+-[a-z0-9-]+[\s>]/.test(s);
    const limit = hasFig ? 200 : 300, n = hangul(text);
    if (n > limit) flag(i, `${n} Korean characters on the main path; with ${hasFig ? 'a figure, about 200' : 'no figure, about 300'} is the most that fits at 36px: cut, or move detail into a fold`);
    for (const m of s.matchAll(/<p class="note">([\s\S]*?)<\/p>/g)) if (hangul(strip(m[1])) > 70) { flag(i, 'a long .note under the figure: keep it to one line; put the legend in the figure and caveats on the last slide'); break; }
    const bs = (body.match(/<b>/g) || []).length;
    if (bs === 0) flag(i, 'no emphasized phrase: mark the claim or number that carries the slide with <b>');
    if (bs > 2) flag(i, `${bs} emphasized phrases: keep the one or two that carry the slide`);
    if (t.length > 58) flag(i, `title is ${t.length} characters, likely more than two lines: shorten it to the slide's point`);
    const firstMath = body.search(/class="math display/);
    const firstProse = body.search(/<p[^>]*>[^<]*[가-힣]/);
    if (firstMath >= 0 && (firstProse < 0 || firstMath < firstProse)) flag(i, 'opens with a formula: first say in words what it computes and why it is needed');
    const cites = (text.match(/\d+(\.\d+)*\s?절|부록\s?[A-Z]|식\s?\(\d+\)|(Figure|Fig\.|Table|그림|표)\s?\d+/g) || []).length;
    if (cites > 1) flag(i, `${cites} references to sections, equations or figures of the source: keep one short tag under a figure, move the rest to the last slide`);
    layouts.push(/class="side"/.test(s) ? 'side' : /class="stack"/.test(s) ? 'stack' : /class="eq"/.test(s) ? 'formula' : 'flow');
  }
});

if (layouts.length >= 6) {
  const top = ['side', 'stack', 'formula', 'flow'].map(k => [k, layouts.filter(x => x === k).length]).sort((a, b) => b[1] - a[1])[0];
  if (top[1] / layouts.length >= 0.8) flags.push(`deck: ${top[1]} of ${layouts.length} content slides use the same "${top[0]}" layout; choose each slide's layout by its figure`);
}
if (slides.length > 16) flags.push(`deck: ${slides.length} slides; cover what the question needs and fold the rest`);

console.log(path.relative(process.cwd(), file) || file);
console.log(flags.length ? flags.map(f => '  ! ' + f).join('\n') : '  ✓ nothing to flag');
