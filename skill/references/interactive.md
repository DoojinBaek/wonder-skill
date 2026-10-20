# Interactive slides

Everything a script changes must be inside a **live element**: a custom element (a tag name with a hyphen) or an element with `data-live`. The editor records each live element's markup before the deck's scripts run and always saves that markup, with only the `style` the user gave it (position, zoom). `deck check` fails when a script changes anything else on a slide.

## Rules

- Load scripts in `<head>` as `<script type="module">` (inline or `src="assets/…js"`), or libraries from jsDelivr. A plain `<script>` without `type="module"` or `defer` runs before the editor records the slides, so what it does would be taken for the deck's own markup.
- Write the element so it can be set up more than once: the editor re-creates it on undo, on copies and when your edits arrive live, and the sidebar thumbnails hold copies too.
  - Build in `connectedCallback`, and only once per element (`if (this.shadowRoot) return;`).
  - Stop timers and animation loops in `disconnectedCallback`.
  - Inside an editor thumbnail the element is under `[inert]`: skip animations there (`if (this.closest('[inert]')) return;` before starting one).
- Render into a shadow root. Its contents never reach the file, and the deck's CSS does not reach in, so style its buttons and fields there: `font: inherit` and the deck's palette (`var(--accent)` and the other custom properties are inherited). Text sizes are slide pixels: 28px and up.
- Keep what the user may want to change in the light DOM or attributes (labels, numbers, the answer). They cannot edit it in the browser, but you can when asked, and it stays readable in the file.
- Size it like a picture: give the element `display: block` (`:host { display: block; }`) and a width, or place it with `position: absolute; left/top`.
- The slide must make sense before anything is clicked: PDFs print the first state.
- **Formulas in a widget:** write them as `class="math"` elements (`<span class="math">…</span>`, `<div class="math display">…</div>`), in the element's own markup or in its shadow root, and let the editor draw them.
  - Inside widgets the editor draws them as MathML, which needs no stylesheet, so a widget may copy its content into its shadow root.
  - Never call KaTeX yourself, and never copy KaTeX's rendered HTML: its stylesheet does not reach a shadow root, and the formula then shows twice. `deck check` reports formulas drawn twice or left as raw TeX.
  - Give the widget's `.math` a font size in its own style (the deck's `.slide .math` rules don't reach inside).

## A step-by-step reveal

```html
<step-list>
  <li>Collect experience</li>
  <li>Fit the world model</li>
  <li>Learn the policy in imagination</li>
</step-list>
```

```js
customElements.define('step-list', class extends HTMLElement {
  connectedCallback() {
    if (this.shadowRoot) return;
    const root = this.attachShadow({ mode: 'open' });
    root.innerHTML = `<style>:host { display: block; } ol { margin: 0; padding-left: 1.1em; } li { margin-top: 18px; }
      li.off { opacity: .15; } button { font: inherit; font-size: .8em; margin-top: 24px; padding: .3em 1em; border: 3px solid var(--accent);
      border-radius: 14px; background: #fff; color: var(--accent); font-weight: 650; cursor: pointer; }</style><ol></ol><button>Next</button>`;
    const items = [...this.querySelectorAll('li')].map(li => li.textContent);
    const ol = root.querySelector('ol');
    let shown = 1;
    const draw = () => { ol.innerHTML = items.map((t, i) => `<li class="${i < shown ? '' : 'off'}">${t}</li>`).join(''); };
    root.querySelector('button').onclick = () => { shown = Math.min(items.length, shown + 1); draw(); };
    draw();
  }
});
```

## A chart from a library

```html
<script type="module">
import { Chart, registerables } from 'https://cdn.jsdelivr.net/npm/chart.js@4.4.4/+esm';
Chart.register(...registerables);
Chart.defaults.font.size = 28;   // slides are 1920px wide: the default 12px is unreadable
customElements.define('bar-chart', class extends HTMLElement {
  connectedCallback() {
    if (this.shadowRoot) return;
    const root = this.attachShadow({ mode: 'open' });
    root.innerHTML = '<style>:host { display: block; }</style><canvas></canvas>';
    const css = getComputedStyle(this);
    Chart.defaults.font.family = css.fontFamily;
    new Chart(root.querySelector('canvas'), {
      type: 'bar',
      data: { labels: this.dataset.labels.split(','), datasets: [{ data: this.dataset.values.split(',').map(Number), backgroundColor: css.getPropertyValue('--accent') }] },
      options: { animation: this.closest('[inert]') ? false : {}, plugins: { legend: { display: false } } },
    });
  }
});
</script>
```

```html
<bar-chart data-labels="PPO,SAC,Dreamer" data-values="42,57,81" style="width: 1100px;"></bar-chart>
```

## A slider that recomputes

```html
<gamma-slider data-start="0.9"></gamma-slider>
```

The element shows a range input and the resulting numbers (for example the discounted return for each γ); the formula itself stays as a `.math` paragraph next to it.

## Plain elements with data-live

A plain element marked `data-live` works the same way when saving, but a script that set it up with `document.querySelectorAll(…)` at load will not set up the copies the editor makes later (undo, duplicates, live updates). Use it only for something simple, and prefer a custom element.
