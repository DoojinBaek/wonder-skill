# Markup for diagrams, figures, tables and formulas

These are the shapes the editor itself creates. Use them, so the user can move, resize, recolor and relabel what you draw.

## Labelled boxes

A labelled box in a diagram is a shape with its text inside:

```html
<div class="shape" data-shape="rect" style="position:absolute; left:…px; top:…px; width:…px; height:…px; margin:0; background:var(--accent)"><p>Observation encoder</p></div>
```

- `data-shape` is `rect`, `round` or `circle`.
- The deck's `.slide div.shape[data-shape]` rule centres the text and wraps it inside the box, so the label moves and resizes with the box.
- Several `<p>` (or a `<ul>`) inside one shape are edited together as its label.
- Do not lay separate text boxes over shapes.
- A dark shape needs `color: #fff`.
- A shape with no fill is `background: transparent; border: 4px solid …`.

## Lines and arrows

A line or arrow is `<svg class="shape" data-shape="arrow">` (or `"line"`):

- Its `width` is its length.
- Its `rotate` is its angle.
- It runs along the middle of its box, from the tail on the left to the head on the right.

This is exactly what the editor's Arrow button inserts. Copy it and change only `left`, `top`, `width` (the length), `rotate` and the color:

```html
<svg class="shape" data-shape="arrow" style="position: absolute; left: 660px; top: 497px; width: 600px; height: 40px; margin: 0px;" viewBox="0 0 600 40"><line x1="0" y1="20" x2="574.8" y2="20" style="stroke:var(--ink, #222);stroke-width:7"/><polygon points="572,4.6 600,20 572,35.4" style="fill:var(--ink, #222)"/></svg>
```

- **Direction:** add `rotate: 90deg;` to the style to point it down, `180deg` for left, and so on. The arrow turns around its centre, so place the centre midway between the two boxes it joins.
- **Length:** set `width` and the viewBox width to the length, and keep the head 28 units long. The editor redraws the head when the user drags the ends.
- **Plain line:** use `data-shape="line"` and drop the `<polygon>`.
- **Connectors with bends:** these are not editable as arrows. Draw them as plain inline `<svg>` in the background, and use separate arrows for the parts the user is likely to move.

## Formulas in diagrams

A formula that labels part of a diagram floats like the shapes:

```html
<div class="math display" style="position:absolute; left:…px; top:…px; margin:0; width:max-content">…</div>
```

## Figures

- A placeholder picture goes inside `<figure>`, before its `<figcaption>`.
- The user can replace it with an image file; the `<img>` takes its place in the flow.
- Images live in `assets/` and are referenced by relative path. Never use remote images.

## Tables

Write tables plainly:

```html
<table><thead><tr><th>…</th></tr></thead><tbody><tr><td>…</td></tr></tbody></table>
```

Give the deck a `.slide th, .slide td` rule. Without one, cells the user adds get inline border and padding styles.

## Coordinates

`left` and `top` are measured from the slide's top-left corner, padding included: the slide is 1920×1080 and its content area runs from x 140 to 1780 and y 110 to 970. Below an `<h2>` title, a diagram has about y 280 to 970. Leave at least 40px between boxes, and make boxes tall enough for their label at 32–36px.
