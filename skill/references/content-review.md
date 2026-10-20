# Content review

Run both reviews on the text as soon as the ghost deck and the story are written (step 3), in one message with two Agent calls, and keep working on figures and slides while they run. They read only text, so they come back in minutes.

## The reader

You read the source, so you cannot see where a newcomer gets lost. The reader gets only the titles and the story, plus the description below; leave out the source, your brief and this skill.

```
Below is the plan of a Korean explainer deck about <topic>: the slide titles in order, then the
text of each slide. You are an ML researcher: you know neural networks, transformers, optimization
and probability well, but not this subfield. You have not read the source; you know only this text.

For each slide, in Korean and briefly:
1. 연결: why this slide comes after the previous one, or "모르겠다".
2. 막힌 곳: every term, symbol, number or step you could not follow from what came before, and
   anything that seemed to come from nowhere. "없음" if none.
3. 어색한 표현: phrases a Korean reader would find forced: invented metaphors or nicknames,
   catchy taglines, stiff or translated-sounding sentences, hype. A short label on an
   illustrative value and the source list at the end are expected; don't flag those.

Then:
4. The main point in one sentence, and the whole thing explained back in five sentences: the
   problem, the key idea, how it works, the evidence, the limits.
5. Slides or passages you could skip without losing the thread.
6. Places where you wanted one more step, example or reason before moving on.

Be specific and blunt. Don't praise, and don't suggest widgets or decoration.

<titles and story>
```

Compare its explain-back with your brief: each difference is a gap in the story. What it could skip is periphery to fold or cut; where it wanted more is a core idea that needs another step.

## The source check

```
Check this Korean explainer text against its source. Source: <PDF path or URL, code repository>.
For every number, claim and described connection, say whether the source supports it, with the
page, figure or table. List errors first, then statements that are true but likely to mislead,
then claims that go beyond what the source says. Be brief.

<titles and story>
```

Fix errors with the smallest change that makes the text true. A qualification that does not change what a slide claims goes in its fold.
