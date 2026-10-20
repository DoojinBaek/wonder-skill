# The deck format and the `deck` command

This was the html-deck skill; it is now part of wonder. SKILL.md decides what to say and how decks look; this page is how a deck file works.

A deck is a folder with `deck.html`, a copy of `deck-edit.js` and `assets/`, and nothing else (no READMEs, previews or notes in it). The user opens `deck.html` in a Chromium browser (Chrome, Aside, Arc, Edge) to present it, presses E to edit it in place, and edits are written back to the same file by themselves. You and the user take turns editing that one file, and while the deck is open the browser merges your edits into the user's live. The format below is a contract: the editor works only when it is followed.

SKILL.md's method, theme and widgets come first; the defaults in "What goes on the slides" below are for decks where they don't apply. The format contract always holds.

## The `deck` command

Use `node <this skill's directory>/scripts/deck.mjs` (below: `deck`). Do not read its source or `deck-edit.js`; everything you need is on this page.

- `deck build <folder> [--no-open]`: turns a short `deck.html` (just your slides) into the full deck, adds `deck-edit.js` and `assets/`, checks every slide and opens the deck when there are no errors (`--no-open` skips that, for example when the user views the deck somewhere else).
- `deck check <folder> --shots [--open]`: checks the format, renders every slide at 1920×1080 and reports anything that sticks out of a slide, text that overlaps or touches other text, a live element that draws over text, broken formulas, missing images, tiny text and figure labels too small to read. Exit code 1 means there are errors. It prints the path of `sheet.png`, one image with every slide; screenshots go to a temp folder, never into the deck. `--open` opens the deck if there are no errors. If it says the browser would not start (a sandbox), only the file checks ran.
- `deck open <folder>`: opens the deck in Aside or the default browser, through a local server it starts on its own, so the deck saves itself with no folder prompt.
- `deck update <folder>`: replaces an older deck's `deck-edit.js` with this skill's version.
- `deck export <folder> [--out file.html]`: writes the whole deck as one `.html` next to the folder, with the editor (packed, about 90 KB) and the pictures inside. Use it when the user wants a single file to send or keep; the file presents, edits and saves by itself. Keep working in the folder.
- `deck unpack <file.html> <folder>`: turns such a file back into a deck folder. A file with a `<script data-deck-edit…>` is an exported deck: unpack it before editing, and do not read that script (it is the packed editor).
- `deck docs markup` / `deck docs editing` / `deck docs interactive` / `deck docs deck-tool` / `deck docs skill`: prints a reference (or SKILL.md). Use it when you cannot read files outside the project.

The folder must not be the home, Desktop, Documents or Downloads folder itself, or anything under `~/Library` (iCloud Drive's app folder, cloud-storage mounts): the browser cannot save there. A subfolder such as `~/Documents/talks/<name>` works and still syncs with iCloud.

## What goes on the slides

These defaults apply when the project has no guide of its own. First settle whether the deck will be presented by a speaker or read alone, because that decides where the reasoning lives. A presented deck keeps the claim and its evidence on the slide and the reasoning in the speaker notes, as short cue points in spoken words that end with the transition to the next slide. A deck read alone has no speaker, so the reasoning it needs goes on the slide or in a fold the reader is clearly invited to open. Either way, give each slide one job and a title that states its point as a sentence, so that the titles read in order tell the whole story. Use real numbers with their source. Keep working text (the request, TODOs, template labels) off the slides, and use a small label above a title only when it says something the title doesn't. Reply to the user in the language they write in.

## Creating a deck: the fast path

1. **Write `<folder>/deck.html` directly, in one go, in short form**, after an outline of one line per slide (the question it answers): an optional `<title>`, `<link>`s for fonts, one `<style>` with only what this deck adds, then the slides. Leave out `<html>`, `<head>`, the script tag and the base CSS: `deck build` adds them. Do not read the template first, and write the slides yourself instead of writing a program that generates them.
2. **Run `deck build <folder>`.** It prints problems and the path of `sheet.png`.
3. **Look at the slides.**
   - `sheet.png` shows the whole deck at a glance.
   - Then open the full-size `slide-NN.png` of every slide with a diagram, plot, formula or widget.
   - Also open `slide-NN-after.png`: the same slide with its folds open, buttons pressed and sliders moved.
   - Fix every error and warning with targeted edits to `deck.html` (now the full deck), then run `deck check <folder> --shots --open`.
   - Fix overflow by trimming text or tightening the layout, not by shrinking text below about 28px.
   - If the project's guide has its own review steps, do them now.
   - When there is nothing to fix, you are done: the deck is already open.
4. Tell the user: press E to edit, and edits save by themselves; ⌘P makes a PDF. `deck open` (and `deck build`, `deck check --open`) open the deck through a small local server that `deck` starts on its own, so the browser never asks for a folder. Opened any other way (double-clicking the file), the first ⌘S asks for the folder once. The Claude app's viewer cannot save at all: send the user to the browser for editing.

Short form:

```html
<title>World models in RL</title>
<style>
:root { --accent: #0f766e; --soft: #e6f4f1; }
.slide .side { flex: 1; min-height: 0; display: grid; grid-template-columns: 640px 1fr; gap: 72px; }
</style>

<section class="slide title">
  <h1>World models in RL</h1>
  <p class="sub">An agent learns a model of its environment and practices inside it</p>
  <p class="meta">Name · Lab · Date</p>
</section>

<section class="slide">
  <h2>A learned model lets the agent practice without the real environment</h2>
  <div class="side">
    <div>
      <p>Model-free agents need millions of real steps. A world model learns from those steps to predict what happens next, and the policy then learns from imagined rollouts.</p>
      <details><summary>How imagined rollouts are scored</summary><p>The model also predicts the reward of each imagined step.</p></details>
    </div>
    <figure>
      <svg viewBox="0 0 800 480"><!-- the diagram --></svg>
      <figcaption>Real steps train the model; imagined steps train the policy.</figcaption>
    </figure>
  </div>
  <aside class="notes">Speaker notes</aside>
</section>
```

`deck build` names each slide with a comment from its heading (`<!-- 2. Why a model? -->`) unless you wrote one.

### Built-in styles

The base CSS already styles headings, lists, tables, code, quotes, figures, formulas and shapes. Use these classes instead of writing your own CSS:

- Slides: `title` (cover, with `.sub` and `.meta`), `section` (divider in the accent color), `center` (centred statement). A plain slide is a column with 40px gaps.
- Text: `.kicker` (small accent label above a heading, only when it adds something), `.lead` (larger muted intro), `.small` (32px), `.muted`, `.hl` (accent color), `.callout` (key message with an accent bar), `.stat` (big number), `.foot` (source line pinned to the bottom).
- Layout: `.cols` (equal columns that fill the rest of the slide; `.wide` makes one 1.6× wider), `.card` (soft panel; `.card.alt` in the second color).
- Formulas: `.eqs` holds rows of `<div><p class="eqlabel">Name</p><div class="math display">…</div></div>`.
- Tables: `<tr class="hl">` highlights a row.
- Folds: `<details><summary>Label</summary>…</details>` keeps depth one click away (pseudocode, a derivation, an answer). The editor saves each fold open or closed as you wrote it, and shows its content while editing. A fold opens in place and pushes what follows down, so leave room for it: `deck check` opens every fold and reports what then sticks out. Do not restyle folds as pop-overs; use a widget for that.
- Palette: `--ink`, `--muted`, `--accent`, `--soft` (light accent), `--line`, `--alt`, `--alt-soft`. Override them in `:root` in your `<style>`; they appear in the user's color menu.

The usable area of a slide is 1640×860px (140px side and 110px top and bottom padding). Diagrams with boxes and arrows use the editor's shape markup: read `deck docs markup` first.

### Long decks: write slides in parallel

For about 12 slides or more, if you can run subagents in parallel (for example Claude Code's Agent tool), split the writing:

1. Plan the whole outline. Write `deck.html` in short form yourself with the `<title>`, the `<style>` and the cover.
2. In one message, start the subagents together. Give each the outline, its slide numbers, the palette and classes you chose, and tell it to run `deck docs skill`, then write only its slides as `<section class="slide">` elements to `<folder>/parts/NN.html`, numbered by first slide so the names sort in order (`02.html`, `07.html`, `12.html`), and to run nothing else.
3. When all have finished, run `deck build <folder>` once. It appends the parts in name order after `deck.html`'s slides and deletes `parts/`.

Without subagents, write every slide in `deck.html`.

## Format contract

- Exactly one `<main class="deck" data-size="1920x1080">`, and it is the only `<main>`. Its children are only `<section class="slide">` elements, each preceded by a comment naming it (`<!-- 3. Results -->`). The comment stays with its slide.
- Every slide is a fixed 1920×1080 canvas in px: no `vw`/`vh`, no media queries, and nothing may stick out.
- All CSS goes in one `<style>` in `<head>`, with selectors written as `.slide …`. Never use `.deck > .slide`, `main .slide` or `.deck .slide`, because thumbnails render slides outside `main`. Keep the base `.slide` rules (`isolation: isolate`, `word-break: keep-all`) and the rules for `ol`, `blockquote`, `code`, `pre`, `a`, `table` and `div.shape[data-shape]`, because the user's toolbar produces those elements. Do not set `transform` or `position: fixed` on `.slide`.
- `<script src="deck-edit.js"></script>` is the last line before `</body>`. The deck's own scripts go in `<head>` as `<script type="module">` and may change only the inside of live elements (below): the editor saves edited slides from the page, so anything else a script changes would end up in the file. `deck check` reports it if one does.
- Text goes in `h1`–`h3`, `p`, `ul/ol > li` (a sub-bullet is a nested `<ul>` in its `<li>`), `figcaption` and `td`, so a click edits it. Keep text that belongs together in one wrapper, or as a run of blocks directly on the slide, so it edits as one text box.
- Math is TeX in `<span class="math">…</span>` (inline) or `<div class="math display">…</div>`, rendered by KaTeX. Never use `$…$`. Do not name your own classes after KaTeX's (`accent`, `mord`, `base` …).
- Charts and diagrams are inline `<svg>` with a `viewBox`, or images in `assets/` with relative paths.
- Speaker notes go in `<aside class="notes">…</aside>`, the last child of a slide.
- Google Fonts or jsDelivr stylesheets are fine.

## Interactive slides

Quizzes, sliders, demos, live charts and anything else that responds go in a **live element**: a custom element (`<quiz-card>`, its name needs a hyphen), or any element with `data-live`. The editor saves a live element exactly as you wrote it, whatever its script does to it on the page; the user can move, resize (zoom) and delete it, but does not edit text inside it. While presenting, its clicks and keys are its own.

```html
<script type="module">
customElements.define('reveal-answer', class extends HTMLElement {
  connectedCallback() {
    if (this.shadowRoot) return;              // runs again when the element is moved or re-created
    const root = this.attachShadow({ mode: 'open' });
    root.innerHTML = `<style>button { font: inherit; font-size: .8em; padding: .3em 1em; border: 3px solid var(--accent);
      border-radius: 14px; background: #fff; color: var(--accent); }</style><button>Show answer</button><p hidden><slot></slot></p>`;
    root.querySelector('button').onclick = () => { root.querySelector('p').hidden = false; };
  }
});
</script>

<section class="slide">
  <h2>Quick check</h2>
  <p>What does the critic estimate?</p>
  <reveal-answer>The value of the current state, V(s).</reveal-answer>
</section>
```

- Prefer custom elements: the browser sets them up again by itself when the editor re-creates a slide (undo, the user's copies, your edits arriving live). Build in `connectedCallback`, render into a shadow root, and keep the content (labels, data, the answer) in the element's own markup or attributes, so the user and you can change it in the file.
- Put the data in the element's attributes or children, such as `<bar-chart data-values="3,5,8" data-labels="A,B,C">`.
- Scripts and libraries (Chart.js, D3 from jsDelivr) load in `<head>` as `<script type="module">`; with `deck build`, write them before the slides.
- Slides must look complete without interaction: they are printed to PDF as they first appear.
- Formulas inside a widget are `class="math"` elements the editor draws. Never call KaTeX yourself, or they show twice.
- For more patterns (charts, sliders with formulas, step-by-step reveals), read `deck docs interactive`.

`deck new <folder> --title "…"` still creates a full deck from the template, if you would rather start from one.

## Editing an existing deck

Before changing a deck that already exists, read `deck docs editing` (or [references/editing.md](references/editing.md)). It describes what the user's hand edits look like in the file, how your edits are merged with theirs, and how to write so the merge stays clean. The short version:

- Re-read `deck.html` before every change.
- Change only the slides you were asked to, with targeted edits (replace one slide's markup, not the whole file), and never reformat other slides. To add many slides at once, you can write them to `<folder>/parts/NN.html` and run `deck build <folder>`: they are appended at the end.
- Keep the user's inline styles.
- Never leave the file half-written: every edit must leave a complete deck.
- Run `deck check <folder>` afterwards. If it warns that `deck-edit.js` is old, run `deck update` and ask the user to reload the tab after saving their work.
