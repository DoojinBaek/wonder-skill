# Editing an existing deck

## Ground rules

- **Re-read `deck.html` before every change.** The user may have edited it in the browser since you last saw it.
- **Make targeted edits.** Never regenerate the whole file from memory.
- **Write the file in one go and always leave a complete file:** the whole `<main class="deck">`, every `</section>`, the `deck-edit.js` script tag and `</html>`. The browser ignores a file that looks cut off and waits for the complete one.
- **Keep untouched slides untouched.** Change only the slides you need to, and add new slides as new `<section>` elements. Never re-indent, reformat or rewrite slides you were not asked to touch: that makes each one count as changed and forces the user to throw away one side's work.
- **Keep the structure.** Keep the `<main class="deck">` structure, the slide comments and the `deck-edit.js` script tag.
- **Check afterwards.** Run `deck check <folder>` when you are done.

## What the user's hand edits look like

Treat all of these as deliberate and keep them. When the user asks you to clean up or re-lay-out a slide, you may fold them into proper CSS.

### Inline styles
- Anything the user moves, resizes, recolors or rotates gets its inline `style` rewritten in the browser's form:
  - `prop: value;` pairs separated by `; `;
  - `0px` rather than `0`;
  - colors as `rgb(…)`, with white text as `color: #fff`.
- Typical properties:
  - `translate`, `width`, `height`, `height: auto`, `font-size`, `zoom`, `text-align`, `rotate`, `flex: 0 0 auto`;
  - `z-index`, never negative: Send to back writes `0` and raises the floating things it overlaps to `1`.

### Moving things
- A floating element positioned by `left`/`top` in px gets new `left`/`top` values when moved.
- An in-flow element gets a `translate` instead.
- Something the deck's CSS places by class (for example a `.pageno` with `right`/`bottom`) gets a `translate`.
- Moving several objects at once, nudging them, the Align menu and snapping all write the same `left`/`top` or `translate`.
- Bullets never get a `translate` or `z-index`; the whole list moves instead.

### Inserted things
- **Shapes, arrows and images** are `position:absolute; left/top; margin:0` with a `width`.
- **Text boxes** are `position:absolute; left/top; margin:0` with `width: max-content; max-width`. They start at the slide's left padding and wrap at its right one. A text box widened by hand gets a plain `width` instead.
- **Headings, lists, tables and display math** go into the slide's normal flow, after the selected element or at the end before the notes. They carry no `position`, `left` or `top`, unless the slide had no room: then they float like a text box.
- **A display formula** dragged out of the flow, or added on a slide of floating boxes, becomes `position:absolute; left/top; margin:0; width:max-content`.
- **Copied and pasted objects** keep their markup, with fresh ids.

### Interactive elements
- Custom elements and `data-live` elements are saved exactly as the file had them. Only their `style` changes when the user moves or resizes them (`left`/`top` or `translate`, and `zoom`).
- The user cannot edit text inside them; when asked to change one, edit its markup or attributes in the file.

### Text formatting
- The text toolbar adds `<b>`, `<i>`, `<strike>`, `<code>`, `<a href>`, `<span style="font-size: …">` and `<span style="color: var(--theme-var)">`.
- It can turn paragraphs into lists, headings or `<blockquote>`.
- A color applied to text that is already bold or italic can land as a `style` on that `<b>`/`<i>`.
- Tab / Shift+Tab nest and un-nest bullets as nested lists.
- Alt+↑/↓ reorders paragraphs, bullets and in-flow elements in the markup itself, with no style.

### Tables
- Tables the user inserts look like `<table style="width: 100%; border-collapse: collapse;"><thead><tr><th>…</th></tr></thead><tbody><tr><td>…</td></tr></tbody></table>`. Columns size to their content, and empty cells are saved as `<td></td>`.
- Aligning, bolding or coloring a whole table or column writes `text-align`, `font-weight` or `color` on each cell.
- If the deck's CSS gives cells no border, new cells also get inline `border`/`padding` (and header cells a light background). A `.slide th, .slide td` rule in the deck avoids that.

## How edits are merged

- **Your edits appear by themselves.** With the deck folder connected, the open tab picks up your edits within a second or two: the slides you changed are swapped in place (their thumbnails flash), and the user keeps typing where they were.
- **Unsaved edits are merged, slide by slide.** If the user has unsaved edits, your edits are merged into theirs, and the user's undo never takes yours back.
- **Slides are followed by content, not position.** You may move a slide the user is editing, and the user may move one you edit. Adding or deleting a slide next to one the user edited is merged too.
- **Speaker notes merge on their own.** Editing only the notes of a slide the user is working on never clashes.
- **When the banner appears:** only when you and the user changed the same slide's content differently, or one of you deleted a slide the other edited. Your changes to every other slide are merged at once, and the user's choice applies to that slide only. If the user tells you they saw the banner, re-read `deck.html` after they save, and re-apply your change to that slide if it is missing.
- **What applies when:**
  - Applied live: `<style>` changes and a changed `<title>`.
  - Reloads the page: a new `<script>` or `<link>`, or a new `data-size`. While the user has unsaved edits, a new stylesheet `<link>` loads live instead, and other such changes take effect on the next load.
- **If the tab did not pick up your change:** the deck was probably not opened with `deck open`. Run `deck open <folder>`: the deck then reads and writes its folder through the local server, picks up your edits within a second or two, and saves the user's edits by itself. Opened from the file instead, ⌘S once connects the folder (after a browser restart it may need one click to allow access).
- **About `<title>`:** a `<title>` still equal to the template's `Presentation title`, or to the first slide's heading, is replaced by the first slide's heading when the user saves.

## How saved slides are written

- **Untouched slides:** a slide the user did not touch is saved byte for byte as you wrote it, comments and spacing included.
- **Edited slides:** a slide the user edits is written back the way the browser serializes HTML:
  - every `<li>`, `<p>`, `<td>`, `<th>` and `<tr>` is closed;
  - attributes are in double quotes;
  - void tags have no slash (`<br>`, `<img …>`);
  - `&amp;` is used for `&` in text and in TeX, and `&lt;`/`&gt;` in text;
  - other named entities become the characters themselves;
  - tables get an explicit `<tbody>`.
  
  Writing your markup that way keeps the diff small.
- **Whitespace:** an `&nbsp;` inside an edited paragraph, heading or bullet becomes a plain space. A `<br>` or empty bullet that you wrote stays; the editor removes only those its own typing left behind.

## Updating the editor

`deck update <folder>` replaces the deck's `deck-edit.js` with the latest version. An open tab keeps running the old editor until it is reloaded, so tell the user to reload (⌘R) after saving their work.
