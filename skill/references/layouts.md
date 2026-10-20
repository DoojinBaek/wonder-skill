# Layouts

The theme (assets/theme.css, already in deck.html's `<style>` when the deck was started with new-deck.mjs) gives each slide a 1640×860 area, 36px body text and 56px titles, plus the blocks below. Pick the layout by the shape of the figure. assets/example-deck.html uses every one of them.

Contents: text above a wide figure · text beside a tall figure · stacked comparison · formula · fold · cover · last slide · widgets

## Text above a wide figure

The default. Use it for wide figures: a pipeline, a strip of examples, a timeline, a wide curve, a widget with its controls underneath. The figure takes the space the text leaves, so with a single sentence of text it fills the slide; use that for the moment when the running figure itself is the point.

```html
<section class="slide">
  <h2>Diffusion 모델은 지금이 몇 번째 단계인지 알아야 한다</h2>
  <div class="text">
    <p>…</p>
    <p>…</p>
  </div>
  <div class="fig">
    <noise-strip></noise-strip>
    <p class="note">같은 네트워크가 왼쪽에서 오른쪽으로 다섯 번 쓰인다.</p>
  </div>
</section>
```

## Text beside a tall figure

For square or tall figures, and widgets taller than they are wide. The text column is 660px wide, room for two or three short paragraphs.

```html
<section class="slide">
  <h2>…</h2>
  <div class="side">
    <div class="text">
      <p>…</p>
    </div>
    <div class="fig">…</div>
  </div>
</section>
```

## Stacked comparison

Rows of the same figure, each with a label, all visible at once. Use it whenever a slide compares (before and after, method A and method B), so the reader can compare without clicking. It goes inside a `.fig`, in either layout above.

```html
<div class="fig">
  <div class="stack">
    <p class="label">LayerNorm</p><dot-row data-x="…"></dot-row>
    <p class="label">AdaLN</p><dot-row data-x="…"></dot-row>
  </div>
</div>
```

## Formula

Placed after the text that says what it computes and why it is needed. Color each term like its counterpart in the figure, then say in one line what the colored terms are.

```html
<div class="eq">
  <div class="math display">\mathrm{AdaLN}(x, t) = \big(1 + \textcolor{#c05f0c}{\gamma(t)}\big) \odot \mathrm{LN}(x) + \textcolor{#c05f0c}{\beta(t)}</div>
  <p class="terms"><span class="orange">주황</span>은 t에서 계산한 값이다. LN(x)는 평균 0, 퍼짐 1로 맞춘 x다.</p>
</div>
```

The two colors: blue `#2f5fb3` (`--accent`, class `.blue`) and orange `#c05f0c` (`--alt`, class `.orange`). Say on the first slide that uses them what each one stands for, and keep that meaning for the whole deck. When a deck compares more than two things, add gray for a plain baseline and one more color (purple `#7c4dbd`) rather than reusing one: a test deck drew two different methods in the same gray, and the source check flagged that readers would take them for the same thing. Show every color's meaning in a legend inside the figure. Inline formulas in a sentence are `<span class="math">…</span>`.

## Fold

```html
<details><summary>α가 0이면 학습이 멈추지 않나?</summary>
  <p>…</p>
</details>
```

The summary names what is inside as a short phrase or the question it answers. A fold opens in place and pushes what follows down, so leave room under it; `deck check` opens every fold and reports what then sticks out.

## Cover

```html
<section class="slide title">
  <h1>AdaLN (Adaptive Layer Normalization)</h1>
  <p class="answer">두세 문장: 이것이 무엇이고, 무엇을 하고, 어디에 쓰이는지.</p>
  <p class="meta">출처 · 2026-10-17 · Wonder</p>
</section>
```

## Last slide

```html
<section class="slide">
  <h2>(기억할 한 가지를 주장으로)</h2>
  <div class="text"><p>…</p></div>
  <div class="refs">
    <p>저자. 제목. 학회 또는 arXiv 번호, 연도</p>
    <p>논문에서 온 것: … 직접 만들거나 계산한 것: …</p>
  </div>
</section>
```

## Widgets

new-deck.mjs puts six ready-made widgets into every deck (assets/widgets.js, inline). Use them before writing your own: they already read the theme, use large text, fit the slide, and explain in their first state, so they need no layout fixing. Data goes in attributes as JSON or comma lists; colors are names: accent (blue), alt (orange), gray, purple, ink.

Curves from data (static). `data-marks` puts labelled points on them.

```html
<line-chart data-x="0,1872" data-y="0,100" data-xlabel="실행한 층 수" data-ylabel="정확도 (%)"
  data-series='[{"name":"InfiLoop","color":"accent","x":[0,468,936,1872],"y":[0,79,86,90.9]},
                {"name":"TRM","color":"alt","dash":true,"x":[0,468,936,1872],"y":[0,62.2,60,58.1]}]'
  data-marks='[{"x":468,"y":62.2,"label":"62.2%","color":"alt"}]'></line-chart>
```

Horizontal bars (static), for results and ablations.

```html
<bar-chart data-max="100" data-unit="%" data-title="정확도, 1,872층"
  data-items='[{"label":"InfiLoop","value":90.9,"color":"accent"},{"label":"q = 0","value":84.1,"color":"gray"}]'></bar-chart>
```

Points on one number line, a row per case. A row with `expr` is computed from row `from` (v = each value, p = the slider), so one slider can move one row while the others stay put.

```html
<dot-rows data-range="-4,9" data-param="t" data-min="0" data-max="1" data-value="0.8"
  data-readout="'γ = ' + (0.5 + 1.2*p).toFixed(2)"
  data-rows='[{"label":"원래 숫자","values":[2.1,3.4,3.9,4.6,5.2,6.0,6.8,8.0],"color":"gray"},
              {"label":"AdaLN","expr":"(v-5)/1.8*(0.5+1.2*p)+2-2.5*p","from":0,"color":"alt"}]'></dot-rows>
```

A function of x with one parameter on a slider; `data-fn2` draws a gray reference curve.

```html
<slider-plot data-fn="Math.exp(-x*x/(2*s*s))/(s*Math.sqrt(2*Math.PI))" data-param="s"
  data-min="0.3" data-max="2" data-value="0.6" data-x="-4,4" data-y="0,1.4" data-xlabel="x"
  data-readout="'최댓값 = ' + (1/(s*Math.sqrt(2*Math.PI))).toFixed(2)"></slider-plot>
```

A pipeline walked step by step; `data-loop="4,2"` draws a return arrow from box 4 to box 2. Each `<li>` is a box name and the one sentence shown for that step.

```html
<step-through data-loop="4,2">
  <li data-box="아이디어">과제에서 가설 후보를 만든다.</li>
  <li data-box="실험">코드를 고치고 돌려 결과를 모은다.</li>
  <li data-box="검토">검토 에이전트가 점수를 매긴다.</li>
</step-through>
```

Predict, then see. The element's own text is the answer, shown after any choice; `data-answer` is 1-based.

```html
<predict-reveal data-question="468층에서 1,872층으로 늘리면 정확도는?" data-options="오른다|그대로다|떨어진다" data-answer="3">
  떨어진다. 468층에서 62.2%, 1,872층에서 58.1%다.
</predict-reveal>
```

When none of these fits (a grid of Sudoku boards, an image strip, a custom simulation), write a custom element the way references/deck-tool.md describes, inline in the deck: a browser blocks module files loaded from a file. Read colors from the page (`getComputedStyle(document.documentElement).getPropertyValue('--accent')`), keep text 28px or larger and sliders at least 600px wide, give it `:host { display: block; }`, put its data in attributes, and make its first state explain the slide. assets/example-deck.html has three custom ones.
