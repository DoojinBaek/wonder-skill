# wonder

A skill for Claude Code and Codex that explains a topic as an HTML slide deck, and an editor for those decks that runs in the browser. Ask "X 설명해줘" or for a presentation, and the agent writes the explanation as a story first, has it reviewed on the text, builds the slides from a calm theme and ready-made interactive widgets, and checks every slide. In the Wonder repo (a folder with index.html and topics/) it also publishes each deck as a private Artifact and lists it.

The skill's method is in skill/SKILL.md; the deck format and the `deck` command are in skill/references/deck-tool.md. It grew out of html-deck, which it replaces.

## The editor

- Open `deck.html` in a Chromium browser (Aside, Chrome, Arc) and it starts in present mode
- `E` turns that same view into edit mode, and edits save to the same file by themselves a moment after you stop. Opened with `deck open`, no folder prompt ever: a small local server (`deck serve`, started on its own) does the reading and writing. Opened by double-clicking the file, the first ⌘S asks for the folder once
- While the folder is connected, the open tab picks up changes the moment Claude Code or Codex edits the file (only the changed slides change, and text you are typing carries on)

## Install

```bash
git clone https://github.com/DoojinBaek/wonder-skill.git ~/Developer/wonder-skill
~/Developer/wonder-skill/install.sh
```

`install.sh` installs the one dependency (playwright-core, used by `deck check`). It links `skill/` into `~/.claude/skills/wonder` (Claude Code) and `~/.codex/skills/wonder` (Codex), and puts the `deck` command in `~/.local/bin`. To update later, run `git pull`, then run `install.sh` again.

Keep the clone on the Mac's own disk. If it lives on an external drive, both agents lose the skill whenever the drive is unplugged.

Then ask Claude Code or Codex for "an HTML presentation about X" (in any language) and it makes one in this format.

## The `deck` command

| Command | What it does |
|---|---|
| `deck build <folder> [--no-open]` | Turns a short `deck.html` (an optional `<title>` and `<style>`, then just the slides) into a full deck: adds the base CSS, slide comments, `deck-edit.js` and `assets/`, merges any `parts/*.html` written in parallel, checks every slide and opens the deck if there are no errors. This is the fast path agents use |
| `deck new <folder> --title "…"` | New deck from the template: `deck.html`, `deck-edit.js`, `assets/`. Refuses folders the browser can't save into (home, Desktop, Documents or Downloads themselves, anything under `~/Library`) |
| `deck check <folder> [--shots [dir]] [--open]` | Checks the format, renders every slide at 1920×1080, and reports things sticking out of a slide, overlapping or touching text, a live element drawing over text, broken TeX, missing images, tiny text and figure labels too small to read. `--shots` also writes `sheet.png`, every slide in one image; screenshots go to a temp folder unless a dir is given. `--open` opens the deck when there are no errors. Exit code 1 on errors |
| `deck export <folder> [--out file.html]` | Writes the deck as one `.html` next to the folder, to send or keep: the editor goes in packed (about 90 KB) and the files from `assets/` as data URLs (pictures over 1920px are scaled down). The file presents, edits and saves (⌘S) by itself. Fonts and KaTeX still load from their CDNs |
| `deck unpack <file.html> <folder>` | Turns an exported file back into a deck folder (`deck.html`, `deck-edit.js`, `assets/`), to edit it with an AI |
| `deck update <folder>...` | Replaces a deck's `deck-edit.js` with the latest version (each deck keeps its own copy) |
| `deck open <folder>` | Opens the deck in Aside, or in the default browser |
| `deck docs <editing\|markup\|skill>` | Prints a reference from the skill, or SKILL.md itself (agents that can't read files outside their project use this) |

The agents call the same script (`skill/scripts/deck.mjs`), so Claude Code and Codex create and check decks the same way.

## Contents

| Path | Role |
|---|---|
| `skill/SKILL.md` | The skill for Claude Code / Codex: format contract and workflow |
| `skill/references/` | Details read only when needed: editing an existing deck (`editing.md`), markup for diagrams, figures and tables (`markup.md`) |
| `skill/deck-edit.js` | The present, edit and save script. Copied into each deck folder |
| `skill/template.html` | The deck template |
| `skill/scripts/deck.mjs` | The `deck` command |
| `tests/` | End-to-end tests |

## Edit mode

### Adding: one click in the top bar

| Button | Click | Click ▾ |
|---|---|---|
| New slide | A title + list slide after the current one | Blank slide, Duplicate slide, Delete slide |
| Text | A text box (type right away; it goes under the content, or under the selection, lined up with the slide's left margin, and grows with its text until it wraps at the right margin) | Title, Bulleted list |
| Table | A 3 × 3 table (first row is the header), typing in the first cell | Pick a size (up to 6 × 8), header row on or off |
| Image | Pick a file. Before the folder is connected, a card explains why the folder is needed. It goes into a `<figure>` that lost its picture (only the caption is left) if there is one, else into a free spot at a size that fits (never larger than the original) | |
| Shape | The shape picked last (a rectangle at first) | Rectangle, Rounded rectangle, Circle, Line |
| Arrow · Equation | An arrow · a TeX equation (on a slide of only floating shapes and arrows, or with a floating thing selected, the equation floats too, near it) | |

- Titles, lists, tables and equations go into the slide's flow (under the content) with no position styles. If there is no room, they float in a free spot and a note says so. A floating title, list or equation is as wide as its text (`max-width`) and grows as you type. A table that doesn't fit at its natural width is narrowed.
- With no free spot anywhere, the new thing overlaps where it covers the least, and a note says "No free spot, so it overlaps".
- Text boxes, shapes, arrows and images go into a free spot that overlaps nothing, 60px below the content when placed under it. Text counts only where its letters are (the space right of a short bullet is free).
- Things also float in a free spot when adding them to the flow would shrink the existing content (say, a two-column layout with a figure), push it off the slide, or put the new line (including the room its text will grow into) under a floating shape.
- Inserted HTML is broken into lines and indented like its neighbours (a table gets one row per line).
- `＋ New slide` at the bottom of the thumbnails adds a slide at the end.

### Editing

| Action | How |
|---|---|
| Edit text | Click (Esc to finish). In a title, paragraph or item box, clicking the empty space right of the text types at the end of that line. A triple-click selects that paragraph (equations included). Typing with nothing selected says "Click the text to edit it" once and does nothing else (an E typed after other letters doesn't start presenting). Typing with a title, paragraph, list or text box selected (Korean IME input included) continues at its end. Links don't open in edit mode (they do in present mode) |
| Text formatting | The toolbar next to the text: paragraph style, size, color (the deck's theme colors included), bold · italic · strikethrough, Align ▾, List ▾, link (⌘K), equation (∑), ⋯ (code · quote · clear formatting · remove link). Applies to the selected text, or to the whole paragraph with no selection |
| Line breaks | In paragraphs and bullets, Enter starts a new paragraph or item and Shift+Enter breaks the line within it. In titles, text boxes and cells, Enter is a line break. Enter on an empty last item of a list on the slide ends the list and makes a paragraph. Empty bullets are removed when you finish editing |
| Line start and end | Home · End go to the start · end of the caret's line; with Shift they select within that line (not the whole list or box). With nothing selected, they go to the first · last slide |
| Merge paragraphs | Backspace at the start of a paragraph or item (nothing happens at the start of the first paragraph, and it never merges with a floating text box) |
| Bullet levels | In a list, Tab indents one level (a sub-item of the item above) and Shift+Tab outdents one level (the items after it follow underneath). Backspace at the start of a sub-item outdents too. Indent · Outdent under `List ▾` in the toolbar do the same |
| Paste several lines | In lists and paragraphs, each line becomes an item or paragraph; in titles, text boxes, cells and captions, a line break |
| Delete across lines | Titles, paragraphs and lists running on the slide (a title slide's title, subtitle and name; a title + paragraph + paragraph slide), lists, and boxes holding only text are edited together. Drag across several lines, then Backspace, Delete, type (Korean IME included) or paste: the first and last lines merge and keep the first line's kind (title and so on). Enter deletes only the selected text and keeps the first and last lines apart (caret at the start of the last). Images, tables, equations and floating text boxes are never caught in between; select them on their own. Text in different boxes is never selected together (drag from empty space to select whole boxes) |
| Paragraph and item order | Alt+↑ · Alt+↓ while editing text. With a box selected, it swaps places with its neighbour (order only, no position styles) |
| Tables | Click a cell to type. Tab · Shift+Tab go to the next · previous cell (Tab in the last cell adds a row), ↑↓ to the cell above or below. `Row ▾` · `Column ▾` in the toolbar add above, below, left or right, or delete; `Delete table`; and under `Column ▾`, align this column left, center or right. With merged cells (rowspan, colspan), rows and columns are added and deleted as they look (merged cells widen or narrow). A new table's column widths follow its text |
| Paste into a table | Excel, Google Sheets, tab-separated text, Markdown tables and CSV pasted into a cell fill cell by cell (adding rows and columns if needed). Pasted with nothing selected, they make a new table |
| Whole table | One Esc from a cell selects the whole table. Move it by the ✥ handle, Delete to delete it, Enter to edit the first cell, `Row ▾` · `Column ▾` in the toolbar to add at the top or bottom (far left or far right) or delete the last one, and Align ▾ · B · text color for all cells at once (one undo step). Cells are edited one at a time (no dragging across cells) |
| Move images and boxes | Click, then drag (text and tables by the ✥ handle). Hovering outlines what a click would grab. In a two-column layout, a text box or figure is outlined and grabbed by its content, not by the stretched empty column. Dragging an equation in the flow more than half its height away (or always, on a slide of only floating boxes and arrows) makes it float where you leave it (`left`/`top`). The empty part of a wide equation box doesn't catch clicks |
| Select several | Drag from empty space (what it touches is shown before you let go), Shift · ⌘-click to add or remove, ⌘A for the whole slide |
| Several at once | Drag together, arrow keys, Delete, ⌘D. `Align ▾` in the toolbar lines them up left, center, right, top or bottom. If they are all shapes, their color too |
| Resize | The bottom-right handle resizes proportionally: equations, text and tables scale their text, images keep their ratio, shapes resize freely (Shift: keep ratio). The size shows while dragging (the toolbar hides for a moment). The right handle changes only the width (text up to the slide's right margin, and the width you set is saved as is); the bottom handle only the height (shapes only). Rotated things resize along their own width and height |
| Snapping | While moving, things snap to the slide's center and margins and to other objects' edges and centers, and a pink line shows. Hold ⌘ while moving to move freely |
| Center on the slide | `Align ▾ › Relative to slide` in the selection's toolbar: Center horizontally, Center vertically, Center on slide (several things as one piece) |
| Lines and arrows | Dragging the round dot at either end moves that end; the other stays put, so the direction and length change (Shift: 15° steps). The length and angle show while dragging |
| Step resizing | `− number ＋` in the selection's toolbar (10% at a time) or ⌘⇧. · ⌘⇧,. With several selected, each grows or shrinks in place (about its center). Text changes only its letters; the box width and vertical center stay. The number is the font size, the width (images, shapes) or `Size` (figure groups) |
| Resize several | With several selected, the group's corner resizes them all proportionally, layout included |
| Select the group | Esc, or the `⤴ Select whole …` button next to the selection chip (to move a figure with its caption, say). From a cell or list item, one Esc selects the whole table or list. Esc clears a multiple selection |
| Selection toolbar | Duplicate and Delete always. Shapes get a color (`No fill` keeps an outline in that color, so the shape stays visible and grabbable), images get Replace image (example pictures and charts in a `<figure>` too: the new image takes their place in the flow and the caption stays), equations get Edit equation. Freely placed things get Bring to front/back and rotate under ⋯ (Send to back never writes a negative `z-index`, so things stay visible in PDFs and thumbnails) |
| Text in a shape | Double-click the shape (the word you clicked is selected), or with the shape selected press Enter or type (Korean IME included) to type at the end of the last line. Several lines (paragraphs, a list) are edited together: drag across lines, ⌘A for all, turn them into a list. The text is centered, wraps inside the shape, and moves and resizes with it. Text on a dark shape is white. Emptied, it goes away. Clicking a selected shape again also starts typing |
| Copy and paste | ⌘C · ⌘X the selection (several things too), then ⌘V on another slide: it lands in the same spot and stays selected (30px off on the same slide; things in the flow go after the selection). Equations come along as they are. Pasting the same thing again keeps shifting it by 30px. Copying just a caption or just a picture pastes the whole figure. Text pasted with nothing selected becomes a new text box in a free spot. While editing text, ⌘C · ⌘X · ⌘V keep bold, code, links and equations, equations as TeX (as `$TeX$` text in other apps) |
| Delete and duplicate | Delete · ⌘D (the copy goes on the line right below the original) |
| Nudge | Arrow keys (Shift: 10px) |
| Font size | The size menu in the toolbar, or ⌘⇧. · ⌘⇧, |
| Images | Double-click to replace; drop a file or ⌘V to add (saved in `assets/`). ⌘V with an image selected replaces that image |
| Equations | Double-click to edit the TeX |
| Slides | Drag thumbnails on the left to reorder. Click a thumbnail, then Delete · ⌘D to delete · duplicate it (⌘Z to undo; the last slide can't be deleted). Right-click a thumbnail: Duplicate, Delete, Move up, Move down |
| Undo | ⌘Z · ⌘⇧Z. If you were typing, you can keep typing in the same spot (one step per stretch of typing, as typed; the editor's tidying is not a step), and the selection stays selected. If something of another kind now sits there (an equation where a paragraph was), it is only selected, not typed into. If the undone change is on another slide, it goes to that slide. Slides you are not on keep none of the empty bullets or trailing line breaks the editor left (ones the AI wrote on purpose stay, and an undone slide is restored to the letter). Undoing a list indent, Remove list or shape text keeps you typing in the same text (if the shape text goes away, the shape is selected). The AI's edits are never undone (only yours) |
| Code · quote · numbers | Code under ⋯ applies to the selected text, or with no selection to what you type next. Enter in a code block (`<pre>`) is a line break. Numbered lists, quotes, code and links look like the deck even when its CSS has no rules for them (numbers where the bullets were, quotes with a line on the left, monospaced code on a background, links in the accent color; none of this is saved) |

⌘S while typing saves without the editing leftovers: empty bullets, trailing line breaks, `&nbsp;` and so on.

### Presenting

- The `Present` button starts presenting in full screen (`E` stays in the window). Click, → or Space for the next slide, Shift-click or ← for the previous one (links open as links). Presenting started from the editor goes back to editing with Esc (in full screen, the first Esc leaves full screen and goes back). Text can't be selected while presenting.
- Opening the file directly starts in present mode, and a hint `E edit · F full screen · ? shortcuts` shows briefly at the bottom.

The pill next to the Save button tells you where things stand: `Saved ✓`, `● Edited` (saves itself in a moment), `Saving…`, `AI edits applied`, `Folder not connected` (opened from the file: ⌘S picks the folder once, then edits save by themselves), `View only here` (inside another app's viewer, such as Claude's artifact view, which cannot write your files), `Not saving` (the local server stopped: open the deck again with `deck open`).

The local server listens only on 127.0.0.1, answers only URLs carrying a random token kept in `~/.cache/html-deck/server.json` (readable by you alone), refuses writes from any other web page, writes only a deck's own HTML file and its `assets/`, writes each file whole (temp file, then rename), and stops after four hours without requests.

⌘P makes a PDF (the caret and selection marks are never printed, even while editing). The tab and PDF name follow the first slide's title when `<title>` is still the template's (`Presentation title`, or the older Korean `발표 제목`) or matches the first slide's title, and saving changes the file's `<title>` to that title too. A title you set yourself stays. Shape colors and slide backgrounds print without the background-graphics option, one slide per page. Korean text never breaks in the middle of a word (when the deck's CSS sets no `word-break` of its own).

## Tests

Over 280 scenarios run in real Chrome (or Aside). Korean input is simulated with composition events over the Chrome DevTools Protocol, and saving and auto-reload are checked against real files on disk.

```bash
npm install && npm test
```

- The `deck` command (build, check, export, unpack): `npm run test:build` (about 20 seconds)
- After changing `deck-edit.js`, run `npm run build` to rebuild `skill/deck-edit.min.js` (the copy `deck export` packs); `test:build` fails until you do
- Only some tests: `npm test -- enter` (several: `npm test -- "enter|table:"`)
- Watch it in a browser window: `HEADED=1 npm test`
- Run in Aside: `npm run test:aside`
- Failures leave screenshots in `tests/.out/`.
- Runs take about 3.5 minutes. Most tests run 6 at a time (`WORKERS=n` to change). Save/merge tests and tests that time idle timers then run one at a time (`HTTP_WORKERS=n`), because they wait on the file poller and real disk writes.
- A test that fails is run once more on its own. If it then passes, it is listed as flaky at the end instead of failing the run. The 10 slowest tests are listed too.
- KaTeX and Pretendard are downloaded once into `tests/.cache/` and served from there, so tests don't hit the CDN every time.
- The tests build their deck from `tests/fixture-template-ko.html`, the original Korean template, so their Korean content and IME scenarios stay as they were.

Things that can't be automated and need a manual check: the macOS folder picker and permission prompts, and a real Korean input method.

## Editing alongside an AI

- While the folder is connected, when the AI changes `deck.html`, only the changed slides are swapped in, with no reload. The thumbnails flash and a note such as "AI edited slide 4 · added slide 6" says what it edited, added, moved or deleted. If you were typing, the caret, selection and IME composition stay, so you just keep typing. Even if the AI edited that very slide, you keep typing if the paragraph you were in is unchanged; if not, a note says "AI edited this slide" and for a moment the letters you type aren't taken as shortcuts. While you are dragging or resizing, the change is applied after you let go. If only comments or whitespace changed, nothing happens. If the script or stylesheet links the deck loads, or its `data-size`, change, the page reloads (after presenting ends, if presenting in full screen). With unsaved edits, only a new stylesheet link is loaded right away instead of reloading, and the rest takes effect the next time the page opens.
- Unsaved edits are merged slide by slide. If the AI edited slide 3 and you edited slide 1, both stay. Style (CSS) changes apply right away too. A merge is not an undo step: ⌘Z undoes only your edits and the AI's stay.
- If the AI adds or deletes a slide next to one you edited, or you both add a slide at the end, the edits merge as they are. If the AI adds a similar slide (another table with the same title, say) before one you edited and renames your slide, the one with the most content in common counts as the same slide. If nothing is similar enough, the slide counts as deleted and the banner asks (nothing is swapped behind your back). Slides are followed by content, not position, so the AI moving a slide you edited, or you moving one it edited, is not a conflict and never doubles a slide (the order is the mover's, or yours if you both moved it). Speaker notes (`aside.notes`) merge on their own, so if you edited the body and the AI the notes, both stay.
- Only when both sides edited the same slide (or one side edited a slide the other deleted) does the banner at the top name the slide (its thumbnail gets a yellow border; "The AI deleted slide 7, which you edited"; if only the notes differ, "Only the speaker notes differ on slide 7") and ask which version to keep. Changes to other slides from both sides are already merged, and `Keep mine` · `Use AI's` apply to that slide only (no reload). After `Use AI's`, ⌘Z still brings your version back. Nothing is saved until you choose. If the AI puts that slide back the way it was, the banner goes away by itself.
- While the AI is still writing the file (a cut-off file), nothing happens until it finishes.
- On save, slides you didn't touch stay exactly as they were in the file, so git diff shows only what you changed. The comment right above a slide (`<!-- 3. Results -->` and so on) moves with that slide (also for a slide you moved and edited, and one the AI deleted that you kept with Keep mine), and new slides get only a blank line.
- Moving a floating box, shape or image changes its `left`/`top` values (`translate` is only for things in the flow).

## Interactive slides

Quizzes, sliders, demos and live charts go in a custom element (`<quiz-card>`) or any element with `data-live`, driven by the deck's own `<script type="module">` in `<head>`. The editor records each one's markup before the scripts run and always saves that markup, so whatever a script does on the page (buttons it builds, answers it hides, charts it draws) never reaches the file. Only the position and size you give it are saved. In edit mode an interactive element is one object you can select, move, resize (zoom), copy and delete. While presenting, its clicks and keys are its own: clicking its buttons doesn't turn the page, and typing in its fields doesn't trigger shortcuts (Esc leaves the field). `deck check` fails when a script changes a slide anywhere else. See `skill/references/interactive.md`.

## Known limits

- Safari and Firefox can't overwrite files, so they save as a download.
- The browser never grants write access to the home, Desktop, Documents or Downloads folders themselves, or to anything under `~/Library` (the iCloud Drive app folders `~/Library/Mobile Documents/…`, Google Drive and others under `~/Library/CloudStorage/…`). Use a separate folder per deck, in a project or under `~/Documents` or `~/Desktop`. With iCloud's "Desktop & Documents Folders" sync on, `~/Documents/deck-name/` also syncs to your other Macs.
- Interactive elements can't be edited as text in the browser (ask the AI to change their markup), and a plain `data-live` element set up by a load-time script isn't set up again on its copies; custom elements are.
