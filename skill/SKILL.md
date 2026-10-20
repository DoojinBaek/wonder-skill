---
name: wonder
description: Makes HTML slide decks that explain a topic and that the user can present and edit by hand in the browser (presentation, slides, 발표자료, 슬라이드, 프레젠테이션). In the Wonder repo it turns every question (a paper link or arXiv ID, a method, model or system name, a blog post, "X 설명해줘", "X랑 Y가 어떻게 달라?") into an interactive Korean explainer deck, publishes it as a private Artifact and lists it in index.html. Use it for any request for an HTML presentation or deck, and for changing a deck folder that contains deck.html and deck-edit.js.
---

# Explaining with a deck

The user asks about something they have wondered about, and you answer with a deck they read alone in the browser, at their own pace. The deck has done its job when, after one reading, they can say what problem the thing solves, how it works and what the evidence shows, without having stopped once to wonder what a slide was talking about.

This user has rejected decks that read as AI-written, that hid the idea behind invented metaphors or catchy lines, that jumped into formulas before saying what they compute, and that piled up facts without saying how they connect. They approved decks that read like a knowledgeable person explaining step by step, with real numbers and one picture that keeps evolving. assets/example-deck.html is the AdaLN explanation the user approved (2026-10-17), rewritten in ~다 체 with this skill's theme and layouts.

The user's own words in the conversation win over this skill. The deck file format, the `deck` command (`deck build`, `deck check`, `deck open`, `deck export`), live elements, folds and the rules for editing an existing deck are in references/deck-tool.md: read it before writing slides, and keep its format contract, which the in-browser editor depends on. `deck` is on the PATH; otherwise run `node <this skill's directory>/scripts/deck.mjs`.

Outside the Wonder repo (a talk, a lab meeting, a deck in another project), use the same explanation method, theme and widgets, but skip index.html and the Artifact unless asked, follow the project's own guide where it differs, and for a deck presented by a speaker keep the reasoning in speaker notes as references/deck-tool.md describes.

## The reader

The reader is the user, an ML researcher. Assume graduate-level machine learning (neural networks, transformers, optimization, probability, linear algebra, the common losses) and nothing more specific: a subfield's machinery (diffusion samplers, RL theory, a statistical test, robot control) and a paper's own terms are built up when the topic needs them. They want expert depth that is easy to follow: the real mechanism, why it is designed that way, what the evidence shows and where it stops. A deck that oversimplifies fails them as surely as one that dumps the paper. This description settles depth and format, so don't stop to ask about them; ask only when the question itself is ambiguous (two different things share the name).

## Making a deck

Put these steps in your task list and keep it current. The order matters: a deck written straight into slides never gets checked as a story, and that is where past decks failed. The content is reviewed on the text, before slides exist, because that is where problems are cheap to fix and the review takes minutes instead of the half hour a review of finished slides took; design is covered by the theme, the layouts and the checks.

```
- [ ] 1. Read the source (and its code); write a brief: takeaway, 2-3 core ideas, what the reader can do afterwards, concepts and prerequisites, periphery and where it goes
- [ ] 2. Ghost deck of claim titles (no gaps, nothing unneeded), then the story as Korean prose, one paragraph per title
- [ ] 3. Content review: start the reader and source subagents on the story text (references/content-review.md), and keep working
- [ ] 4. Running figure and interactions, numbers computed with code; scripts/new-deck.mjs, slides (references/layouts.md), deck build --no-open
- [ ] 5. Fold in the review, then deck check --shots and scripts/lint.mjs, and look at the slides
- [ ] 6. scripts/publish-copy.mjs → Artifact (reuse the URL in index.html) → scripts/add-index.mjs → reply
```

Each step is described under "The steps" below.

## What makes an explanation work

These are the user's own writing principles, from their paper-writing guide, applied to slides. They hold for the whole deck and for every revision.

Spend depth where the reader's understanding changes, not where the paper spends its pages. Before the story, decide the takeaway: the answer as one sentence someone could disagree with, and the two or three ideas the reader must understand to believe it. Those core ideas get slides of their own, usually about half the deck: the question, a small computed case, the obvious fix failing, the paper's move, and only then the formula and the evidence. What the reader needs only to follow along gets a sentence at the moment it is used. Everything else is periphery: implementation tricks (a memory-saving recurrence, an algebraic rewrite), training schedules and exact settings, how each baseline is built, secondary results, details of checkpoints and settings (when one changes what a claim means, it is one short clause on that slide, as below). Periphery gets a fold, a line on the last slide, or nothing, never main-path sentences, however accurate or interesting it is. One or two numbers carry a slide; the rest go in its fold. A test deck on InfiLoop spent four slides on the memory recurrence, the step-size rewrite and the two-loop training schedule and three sentences on why a looped model loses answers it had; the user found detail in odd places and gaps where it mattered.

Give the reason before the thing. A concept enters only when the story needs it, in this order: the situation, what is missing, the operation in plain words, then its name and definition, then a formula if one is needed. After that, use the name directly, one name per concept. Units need the same care: when a method counts repetition or compute in several ways (block calls, updates, segments, layers), define the one unit the deck uses, say how it converts to the others once, and keep it; both readers of a test deck named mixed units as their biggest obstacle. Nothing on a slide (term, symbol, number, figure element) appears before the slide that explains it: a reader who meets an unexplained eigenvalue stops to wonder where it came from and loses the thread.

Open with the problem, and say it out loud. The first slides show what someone wants, what current approaches already achieve, and where they still fail, concretely. For a paper, take this from its own introduction and first figure; an opening example of your own tends to motivate a different, easier problem. Don't open with a definition, a result or the answer in technical words: the accepted epiplexity opening asked a question the reader could try ("TV 지지직 화면과 책 한 페이지, 정보가 더 많은 쪽은 어디일까?") and only then showed the measurement. Once the setup is laid out, state the core problem in one explicit sentence ("manifold는 알고 있다. 남은 문제는 그 위에서 어떻게 경로를 계획하느냐다."). For a broad topic, build the field from the ground: what it is trying to do, the first approach and its limit, why the next one was needed. Asked about diffusion, flow matching and CFG, the user wanted exactly this: what a generative model does, then VAE and its limit, then why diffusion was needed, before any diffusion formula.

Connect every slide to the one before. Each slide takes one step and starts from what the previous slide left open, and its last sentence makes the next slide necessary. Write the link: a question ("그러면 t를 네트워크 안에 어떻게 넣을까?") or a connective (그런데, 그래서, 그러면, 문제는). These sentences are how a reader follows a chain of reasoning, so when you shorten, cut repetition and side details and keep them.

Say literally what is computed. Use the real objects (the vector, the score, the loss, the curve) with numbers you computed or read from the source: "N(0,1)이면 cos(t·z)의 평균은 t = 1에서 0.61, t = 2에서 0.14다." An invented metaphor or nickname adds a second thing to decode, and it has been rejected every time it was tried. An everyday example is different when it is an actual case of the concept: TV static and a book page really differ in how much there is to learn, so that example is the idea itself, while calling a distribution a "구름" only renames it. An example earns its place when it lets the reader check the logic by hand.

Meaning before formula. Show the idea in the figure, say in words what the formula computes and why it is needed, then give it with each term colored like its counterpart in the figure, and afterwards say what is given, what is learned and what each term changes. Derivations go in a fold. When the main contribution is an objective or an algorithm, it still belongs on the main path; only its derivation is folded.

Show the real structure. For a method or a system, the reader should be able to trace one example through the whole thing: what goes in, which components act in which order, what loops and when it stops, what is trained, frozen or chosen, where a human steps in, and how training differs from evaluation. Say what each design choice prevents, and mark it as expected when no ablation shows it. A row of neat boxes is enough only when it is the actual mechanism.

Keep claims honest without burying them. Stay within what the source claims, and keep apart its claims, its measured results (with task, condition and measure) and your own illustrations. Mark an illustrative value once, briefly, where it appears. A condition that changes what a claim means (the effect appears in one checkpoint only, one dataset, one setting) stays with the claim as a short clause, because a reader who meets it only at the end stops trusting everything before it. Section numbers, how you redrew a chart and minor caveats go on the last slide: caveats on every slide bury each slide's point. Search the web for anything you are unsure of or that may have changed.

## Voice

Write the slides in 설명하는 ~다 체: the plain declarative of a good textbook or lecture note, in short direct sentences, with the questions and connectives that carry the reasoning. It should sound like a colleague who knows the field explaining at a whiteboard, neither a press release nor a paper abstract. Titles, body, folds and widget labels all use it; your chat reply is ordinary Korean. Give a technical term its English original at first mention, then keep one name.

A passage in this voice, from the example deck:

> Diffusion 모델은 노이즈로 가득한 그림에서 시작해 노이즈를 조금씩 걷어 낸다. 단계마다 다른 네트워크를 쓰지 않고, 같은 네트워크를 수십 번 다시 쓴다.
>
> 그런데 단계마다 할 일이 다르다. 초반에는 큰 윤곽을 잡고, 막바지에는 가는 선과 질감을 다듬는다. 그래서 네트워크는 지금이 몇 번째 단계인지(timestep, t)를 알아야 한다. 그러면 t를 네트워크 안에 어떻게 넣을까?

### Gotchas

Each of these came from the user's reaction to a real deck. references/examples.md has more before/after pairs.

- Catchy covers and taglines read as cringe ("짜치다"): "노이즈를 데이터로 바꾸는 방법을 1차원 장난감 하나로 따라간다", "ALLO: 신경망이 격자 지도를 제대로 칠하게 하는 법". A cover names what the thing literally is ("라플라시안 고유벡터를 신경망으로 정확히 학습하는 목적함수"), and its paragraph answers the question directly.
- Coined metaphors and nicknames ("지문", "물결", "구름", "색칠", "그림자 모양을 숫자 줄 하나로 바꾼다") confused more than they helped. Use the literal object and a number.
- Compressed report sentences stack definitions without their reason: "점수 s_i = q^⊤RMSNorm(z_i)는 후보를 얼마나 믿을지다." Write the step that creates the need first: "그러면 지난 후보 가운데 무엇을 얼마나 섞을지 정해야 한다. InfiLoop은 후보마다 점수를 매기고, 점수가 높은 후보를 많이 섞는다."
- A slide that drops a result or a formula without the question it answers ("이거 말이야, 뭐 하자는 거야"). Every slide makes clear what it is answering.
- Template devices that read as machine-made: small labels above titles, "핵심:" or "한 줄 답:" tags, card grids with nothing to compare, bullet dumps, comparison tables, "X가 아니라 Y" sentences, em dashes, exclamation marks, sentences about the deck itself ("이 덱은 …").
- 번역투: ~에 대해, ~를 통해 used everywhere, ~에 있어서, ~에 의해 생성된, 되어진다. Write it the way a Korean speaker would say it.
- Everyday translations that change a term's meaning: "점수" for the score function reads as a single number to rank, but the score is a vector. Keep the field's term (스코어) and say what kind of object it is.
- Long question titles ("칸은 다 봤는데, 처음 보는 출발·도착 쌍에서는 왜 길을 못 찾을까요?"). A title is a short declarative claim: "궤적 모델은 처음 보는 출발·도착 쌍에서 막힌다".
- Formulas typed as Unicode in body text (s_i = q^T …). Use KaTeX: `<span class="math">…</span>`.
- Answering "이해가 안 돼" with more widgets, or by dropping the formula and adding a metaphor. Both were tried and failed; the cause is almost always the explanation's order or a missing step.

## The steps

### 1. Read the source and write the brief

Read the whole source. For a paper, fetch the PDF and read the introduction, the first figure, the method, the experiments and the tables the claims rest on; cite figure and equation numbers as the PDF has them (arXiv's HTML version can differ). Check hyperparameters stated in the text against the experiment tables, and use the values the experiments used. When there is code, read its README and configs for how the headline numbers were produced: a test deck found there that a table's best score was picked from 39 runs with a rule checker, which changed what the comparison means. For a broad or recent topic, search.

Then write a brief in your scratchpad (never in the deck folder): the user's question in their words; the takeaway (the answer in one sentence and the two or three core ideas it rests on); what the reader should be able to do afterwards ("predict what happens when β grows", "say why carry-last fails"), which decides where interactions go; the concepts the core ideas need, each with its prerequisites, minus what an ML researcher already knows; the periphery, each item with where it goes (fold, last slide, cut); the problem (what is wanted, what current approaches do, what fails, why it matters); the key idea in one plain sentence; one example traced through the mechanism; the evidence and what it does not show; and what the reader needs first. If you cannot write the key idea in one plain sentence, keep reading before you write slides.

### 2. Write the story as prose

First write only the slide titles, in order, as claims: a ghost deck. Read them alone; they should prove the takeaway with no gap. Each concept appears on the slide just before the first one that uses it, never earlier and never after. A title that nothing later depends on is periphery; a step the next title assumes but no title gives is a gap. Then, before any HTML, write the whole explanation as Korean prose in the deck's voice, in your scratchpad: one paragraph per title, usually 8 to 12. The explanation is decided here, where fixing it is cheap. A typical order: the question and a short direct answer; the situation and what is wanted; what existing approaches achieve and where they fail; the core problem in one sentence; the key idea; the mechanism, whole first and then its parts with their reasons; the evidence; the limits and what is open.

Then read it alone, as the user would. By the third or fourth paragraph, is it clear what problem is being solved? Does each paragraph start from the previous one's open question? Is any term, symbol or number used before it is introduced? Does a formula appear before the reader knows what it computes? Does anything appear without a reason to appear now? Then try cutting each paragraph: if the takeaway still stands without it, it is periphery, so fold it or drop it. Finally read only the first sentence of each paragraph in order; together they should read as one argument. Fix the prose until all of this holds; the slides inherit it.

### 3. Content review on the text

As soon as the ghost deck and the story are written, start two subagents in the same message (Agent tool), and go on with the figures and slides while they run:

- A reader (the faster model "sonnet" is enough), with the prompt in references/content-review.md: it gets the titles and the story, plus the reader description, but not the source or your brief. It reports where it got lost, what it could skip and where it wanted another step.
- A source check: it gets the story and the source (PDF, code) and checks every number, claim and connection.

Both read only text, so they return in a few minutes. Fold their findings into the story first, then into the slides. Apply a source correction with the smallest change that makes the text true; a qualification that does not change the claim goes in a fold. There is no second round unless the takeaway or the order of the story changed.

### 4. Figures, interactions and slides

Choose one figure that can carry the deck and change from slide to slide: points on a number line, a small 2-D dataset, a real training curve, the method's pipeline. Reusing it lets each slide show only what changed and makes the link between slides visible; AdaLN's number line and epiplexity's real loss curve worked this way. For a method or a system, draw one whole-pipeline schematic and highlight the part each slide discusses. One plain sentence per step under the schematic reads better than pseudocode, which goes in a fold. When the source's own figure shows the structure well, use it: crop it from the PDF into assets/, enlarge the part that matters and add highlights. Redraw only when the original does not read at slide size, and check every connection against the original afterwards. A chart in a PDF is often vector graphics: extract its curve coordinates (PyMuPDF) and check them against numbers in the text, instead of reading values off a picture.

The figure shows real data from the source or an exact computation. Compute every number you will show by running code, now, and keep the script in your scratchpad.

Point each interaction at what its slide claims: the reader varies the parameter the claim depends on, or tries the obvious fix and sees it fail. An interaction on a side detail spends the reader's attention where the takeaway doesn't need it. Build interactions from the ready-made widgets in references/layouts.md (line and bar charts, number-line rows, a slider plot, a step-through pipeline, predict-then-reveal); writing a custom widget is where test decks lost most of their time. Plan one wherever the reader learns by changing something: a slider tied to the real formula (λ, t, K, a speed), predicting before revealing, stepping one example through the pipeline. The user has asked for more interaction in several decks, so give each core idea one, as long as it teaches: know what the reader changes, what changes on screen, and which relationship that shows. Two exceptions: a comparison shows every compared item at once (stacked rows of the same figure), because a comparison behind buttons shows one item at a time; and results are static charts. Every slide must explain in its first state, since decks print as they first appear.

#### Building the slides

Start the deck with the bundled script. It creates topics/<date>-<slug>-deck/deck.html with the fonts, the theme and a cover to fill in:

```
node <this skill's directory>/scripts/new-deck.mjs <kebab-slug> "<cover title>"
```

Read references/layouts.md, write the live elements and the slides into that deck.html (the short form in references/deck-tool.md), and run `deck build <folder> --no-open`. The user reads the deck as an Artifact, often from another machine, so a browser window opened here only gets in the way. Write every slide yourself, so the deck keeps one voice.

Each slide is one paragraph of the story. Its title states the paragraph's point in one sentence of at most two lines, in words already introduced, so the titles alone tell the story. Its body is that paragraph, split into two or three short paragraphs at most, and short enough to leave the figure room: about 200 Korean characters on a slide with a figure (four lines above a wide figure; a side column wraps at about 18 characters a line), about 300 without one. A `.note` under a figure is one line; legends belong in the figure itself. Its figure is the running figure in this slide's state. Mark the one phrase or number that carries the slide with `<b>` (the theme draws a marker underline; the user asked for it), two at most. Depth the main path does not need goes in folds: derivations, pseudocode, extra results, related methods, parameter counts, likely questions, quiz answers. A figure taken from the source gets a short tag ("논문 Figure 3") and nothing more.

Choose each slide's layout by the shape of its figure: text above a wide figure, text beside a tall one, a stacked comparison, a formula with colored terms. A deck where every slide is the same text column next to a figure reads like a report; every three or four slides, let one slide be mostly figure with a sentence or two.

The cover gives the topic's name (what it literally is), a two- or three-sentence direct answer in plain words, and the source. The epiplexity cover that worked said "데이터 안에 배울 거리가 얼마나 들어 있는지를 잰다"; the technical how (areas under loss curves, formulas) comes later in the story. The last slide says in a short paragraph what to remember, then lists the sources, with one line on what came from the source and what you computed or made for illustration. Aim for eight to ten slides; cover what the takeaway needs and fold the rest.

### 5. Fold in the review and look at every slide

When the two reviews come back, fix the story, then carry the changes into the slides you built meanwhile. Then run `deck check <folder> --shots <your scratchpad>/shots` and look at sheet.png for the whole deck. Open full size (slide-NN.png, and slide-NN-after.png for folds and buttons) only the slides `deck check` or the lint flags and the slides with a custom widget; the ready-made widgets are already checked, and `deck check` reports a widget whose script did not run. Then run:

```
node <this skill's directory>/scripts/lint.mjs <folder>
```

It flags what past decks were criticized for: too much text for the slide (about 200 Korean characters with a figure, 300 without), long notes under figures, missing or excess emphasis, a formula before any explanation, section and figure citations on content slides, long or tagline-like titles, one layout everywhere, em dashes and template devices. A flag is a place to look again; fix what is really wrong.

### 6. Publish, list, reply

The app's preview panel does not run scripts, so the user sees the deck as a private Artifact, never through SendUserFile:

1. `node <this skill's directory>/scripts/publish-copy.mjs <deck folder> <your scratchpad>` prints the page path and the `files` map for the Artifact tool. The Artifact is named after `<title>`, which the copy shortens to the part before a colon ("InfiLoop"); pass `--title` for another short name.
2. If index.html already links an Artifact for this deck, read it and publish with that `url` so the link stays the same; otherwise publish a new one (icon: "slides").
3. `node <this skill's directory>/scripts/add-index.mjs <deck folder> --title "…" --summary "…" --artifact <url>` adds or updates the deck's entry in index.html.

Reply in Korean: what the deck covers in a line or two, the link, and anything you could not verify. `deck open <folder>` opens it locally for editing (E to edit; it saves by itself).

## Revising after feedback

The user's feedback is usually short: "이해가 안 돼", "짜치다", "뭐 하자는 거야", "인터랙션이 부족해". Work out what they reacted to and why before changing anything. Most often it is a missing step in the story, a concept without its reason, or a formula before its meaning, and rarely the decoration. Fix the story first, then the slides. Rewrites have introduced new errors before (a paraphrase that was false to the mechanism, text that no longer matched its figure), so re-read each changed slide against its figure and the source. Then run step 5 on what changed (and step 3 if the story itself changed), and republish to the same URL.

When a reaction teaches something that will matter for other decks, add a before/after pair to references/examples.md, or sharpen the reason of the principle it belongs to. Avoid adding a rule per piece of feedback: this skill was rewritten because a pile of such rules pulled decks in opposite directions. If you add a line, look for one to remove.
