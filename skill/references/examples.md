# Before and after

Real decks, the user's reaction in their own words, and what changed. Read these for the direction of a fix, not for phrases to reuse: the same mistake comes back in new words (a new metaphor, a new tagline), and only the direction carries over. Decks before 2026-10-19 were written in 해요체, and their quotes keep it; new decks use ~다 체. When feedback teaches something new, add a pair here rather than a rule to SKILL.md.

Contents: patterns · covers and titles · metaphors and literal objects · openings · terms and symbols · formulas · links between slides · simplifications that must stay true · depth for system papers · where the depth goes · emphasis and comparison · what the user approved

## Patterns across these pairs

- Every invented metaphor drew a complaint or was cut soon after (지문, 물결, 색칠, 구름, 문, 일꾼, 얼려). What worked was the literal object, a one-line definition and a computed number.
- An everyday example worked when it was an actual case of the concept: TV static and a book page really differ in how much there is to learn. It failed when it renamed the concept as something else.
- The first response to "이해가 안 돼" was often to drop the formula and add a metaphor, and that failed every time. Keeping the real terms and adding the missing step worked.
- Openings that started with a definition, the answer or a result failed. Accepted openings asked a question the reader could try, then showed the result.
- Accepted titles are short declarative claims that name what the slide shows or the problem still open. Rejected titles were long questions, labels, descriptions of the deck's device, or metaphors.
- Rewrites introduced new errors: wrong verbs, paraphrases false to the mechanism, text that no longer matched the figure. Re-read a rewritten slide against its figure and the source.

## Covers and titles

AdaLN, 2026-10-17. "너무 ai 티가 많이 나고 직관적이고 쉬운 설명이 아니야"
- Before: a "한 줄 답:" tag ("AdaLN은 … 조건(condition)에서 계산된 값으로 바꾼 것이다."), a "직관" label above a title, and an analogy slide about a mixing console's EQ knobs.
- After: "그림 그리는 모델은 지금이 몇 번째 단계인지 알아야 해요", "AdaLN은 γ와 β를 t를 보고 그때그때 정해요". Accepted: "지금 이런 설명 괜찮은거 같아".

ALLO, 2026-10-19. "이게 제목 맞냐... 너무 짜치고 추상적인 설명이잖아"
- Before: ALLO: 신경망이 격자 지도를 제대로 칠하게 하는 법
- After: ALLO: 라플라시안 고유벡터를 신경망으로 정확히 학습하는 목적함수

Diffusion, Flow Matching, CFG, 2026-10-19. "이런 표현 너무 짜치잖아"
- Before (cover subtitle): 노이즈를 데이터로 바꾸는 방법을 1차원 장난감 하나로 따라간다
- After: 생성 모델이 하는 일부터 VAE, diffusion, flow matching, classifier-free guidance까지
- A subtitle states what the deck covers, not the device it uses.

Ariadne, 2026-10-19. "슬라이드 제목이 좀 짜치지 않니?", then "각 페이지 제목은 그 페이지에서 핵심적으로 다루는 내용을 요약해서 제목만 보고도 뭘 이야기하려고 하는건지 알 수 있어야 해"
- Before: 칸은 다 봤는데, 처음 보는 출발·도착 쌍에서는 왜 길을 못 찾을까요?
- After: 궤적 모델은 처음 보는 출발·도착 쌍에서 막혀요

AI Scientist v3, 2026-10-18. "제목도 좀 이상한거 같고"
- Before: 결과는 문 두 개를 통과해야 최고 프로그램이 돼요 / 최고 프로그램을 고르면 얼려 놓고 증거를 만들어요
- After: 검사 두 개를 통과해야 최고 프로그램이 바뀌어요 / 고른 프로그램은 고정하고, 바꾼 걸 하나씩 빼 봐요

## Metaphors and literal objects

SIGReg, 2026-10-18. A slide with three formulas and an unfamiliar curve got "이거 너무 어렵고 뭔말인지 모르겠어". The fix explained it with metaphors ("그림자 모양을 숫자 줄 하나로 바꿔요", "이 곡선이 그림자 모양의 지문이에요"), and the user said: "이런식의 표현은 헷갈리게만 하고 도움이 안돼"
- After, over three slides: 평균과 분산만 보면 이런 구름도 통과해요 → N(0,1)이면 cos(t·z)의 평균이 정해져 있어요(t = 1이면 0.61, t = 2면 0.14예요) → 모든 t에서 그 차이를 더한 게 점수예요
- Claude's own diagnosis then: "지문, 숫자 줄, 물결 같은 말은 원래 개념 위에 해석할 것만 하나 더 얹었어요."

ALLO, 2026-10-19. "초반에 수식이 나오는 순간부터 뭘 하려고 하는건지를 완전히 놓쳐버렸어"
- The fix folded the formulas, which helped, but renamed the objects: "칸마다 숫자 하나를 붙인 것을 색칠이라 부르겠다." Then: "색칠끼리 겹치지 않고 크기가 1이 되게 한다는게 무슨 말이지?"
- After: the literal objects, each with a one-line definition (벡터 u, 고유벡터 e_k, ⟨u, Lu⟩ = 이웃한 칸끼리 값 차이를 제곱해 더한 것), and a reason for each constraint: "크기 조건이 없으면 모든 값을 0으로 줄여 ①을 0으로 만들 수 있다."

Diffusion, 2026-10-19. "구름이 뭔말이야"
- Before: 인코더(encoder)는 x마다 z 공간에 작은 구름 q(z|x)를 정하고…
- After: 인코더(encoder)는 x를 받아 평균과 표준편차 s를 내고, z는 그 정규분포 q(z|x)에서 뽑는다.

Two that worked. Epiplexity's accepted opening asked "TV 지지직 화면과 책 한 페이지, 정보가 더 많은 쪽은 어디일까요?": both are real data with different amounts of learnable structure, so the example is the concept itself. AdaLN called γ and β "두 손잡이" only after both were drawn on the number line, as a light word for something already on screen.

## Openings

Epiplexity, 2026-10-18. Three openings in a row:
- "이미지는 텍스트보다 정보가 많은데, 왜 텍스트로 배운 모델이 더 멀리 갈까요?": "이게 지금 적절한 설명인지 모르겠는데??" It claimed more than the paper does.
- "텍스트로 사전학습하면 다른 일에도 통하는데, 이미지는 왜 덜할까요?": "직관적인 누구나 이해하기 좋은 설명인지 모르겠어." Jargon (사전학습, CIFAR, 토큰) before anything was explained.
- "TV 지지직 화면과 책 한 페이지, 정보가 더 많은 쪽은 어디일까요?": accepted.

Epiplexity, 2026-10-18, after a restart. "그냥 첫 도입부터 뭔소리를 하는건지 모르겠잖아", and about slide 2: "이거 말이야 뭐하자는거야"
- Before: a cover that answered in jargon ("모델이 데이터를 학습하면서 가중치에 담아 가는 정보의 양이에요. 손실 곡선에서 …넓이로 어림해요.") and a slide that showed loss curves with no question ("같은 모델로 세 가지 글을 학습시키면 손실 곡선이 이렇게 달라요").
- After: a plain answer ("데이터 안에 배울 거리가 얼마나 들어 있는지를 재요."), then the reader tries it ("둘을 가르려면 직접 다음 글자를 맞혀 보면 돼요"), then the same exercise for a model ("영어를 전혀 모르는 모델에게 같은 연습을 시켜 볼게요"). The user: "도입은 이해돼".

Ariadne, 2026-10-19. "핵심 문제는 여기서 어떻게 플래닝을 할까 인거잖아? 그걸 그냥 명시해야지"
- Before: 상태만 배워도 갈 수 있는 곳(매니폴드)은 알아요
- After: 매니폴드는 알지만, 그 위의 경로는 몰라요 / 출발점과 도착점이 주어졌을 때, … 두 점을 잇는 경로를 어떻게 만들까요?

Diffusion, 2026-10-19. "Generative Model이 뭐하는건지부터 설명해야지. 그리고 VAE가 뭔지 한페이지, 그런 뒤에 왜 diffusion이 필요한건지 설명하고 ... 지금 뭔가 구성은 피상적인데 안에 각 슬라이드에서는 막 수식 나오고"
- Before: 생성 모델은 뽑기 쉬운 노이즈를 데이터로 옮기는 규칙을 배워야 한다
- After: 생성 모델은 학습 데이터가 나온 분포에서 새 표본을 뽑는다, followed by a slide on VAE and its limit before diffusion.

## Terms and symbols

Ariadne, 2026-10-19. "s(x) = 0 이라서 점수만으로 어느쪽이 밖인지 모른다...?? 점수 낮은게안이고 높은게 밖아니야?"
- "점수" for the score function reads as a single number, high or low. It is a vector.
- After: 스코어 s(x)는 매니폴드 쪽을 가리키는 화살표다
- Translating a term into an everyday word can change what it means. Keep the field's term and say what kind of object it is.

Ariadne, 2026-10-19. "여기서 t=1이 뭘 말하는거야? 고정된 스텝이 있는거야?"
- Before: t가 1이 돼도 반원 왼쪽 위에서 멈춘다.
- After: 출발을 t=0, 도착을 t=1로 두고, t를 Δt=0.005씩 200걸음 늘린다. / 200걸음을 다 쓴 t=1에 아직 반원 왼쪽 위에 있다.

DiscoveryRSI, 2026-10-19. "이 페이지 잘 이해가 안되는데"
- The slide relied on "행동을 강화한다" without saying what it means. After: "…어느 에이전트의 어떤 행동을 학습시킬지 알 수 없다", then "이것이 행동을 강화한다는 말이다."

## Formulas

Epiplexity, 2026-10-18. "앞 페이지들에서 하이레벨로 이해를 했었는데, 식이 왜 저렇게 수식이 되는지는 모르겠잖아"
- Before: 식으로 쓰면 두 토막의 합이 가장 짧은 모델을 찾는 거예요 / 두 토막으로 적는 생각은 최소 기술 길이(MDL)에서 왔고…
- Naming where an idea comes from is not a bridge. Each term needs its own step from the picture: 확률이 p인 칸을 적는 데는 log₂(1/p)비트가 든다. 확률 1/2이면 1비트, 1/4이면 2비트, 1/8이면 3비트다.

Ariadne, 2026-10-19. "저 점수의 의미가 뭔지 이런거를 잘 설명해야지. 수식은 그리고 latex으로 렌더링 해야 예쁨"
- Define every symbol before the formula that uses it (p(x)는 상태 x가 학습 데이터에 얼마나 자주 나오는지 나타내는 밀도다), and render formulas with KaTeX.

InfiLoop, 2026-10-19 (a one-shot deck from the old skill; no complaint recorded)
- Before: 점수 s_i = q^⊤RMSNorm(z_i)는 후보를 얼마나 믿을지다. q는 학습되는 벡터(pseudo-query) 하나이고 모든 루프가 같이 쓴다.
- After: 그러면 지난 후보 가운데 무엇을 얼마나 섞을지 정해야 한다. InfiLoop은 후보마다 점수를 매기고, 점수가 높은 후보를 많이 섞는다. 점수는 후보 벡터와 학습된 벡터 q 하나의 내적이다.

## Links between slides

Ariadne, 2026-10-19. "앞장이랑 다 잘 이어지는 느낌이 없는데? 뭔가 이래서 이런게 필요하다라던가 그런거 말이야... 제목도 직관적이지도 않고." Earlier: "왜 회색이랑 파란색이랑 비교하려고 하는지도 모르겟고, 저 식의 의미도 모르겠고.. 고유값은 왜 갑자기 나오는지도 모르겠고.."
- Before: 경로 수가 폭발해서 궤적 데이터로는 다 덮을 수 없다 / 매니폴드 위에 머물려면 어느 쪽이 매니폴드 밖인지 알아야 한다.
- After: 경로는 다 모을 수 없지만, 상태는 다 모을 수 있다 / 걸음마다 벗어나는 성분을 지우려면, 먼저 각 점에서 어느 쪽이 매니폴드 밖인지 알아야 한다.

## Simplifications that must stay true

Ariadne, 2026-10-19. "지운 양은 지운 이유가 있어서 지운건데, 그걸 모아둔다는게 일단 말이 되는건지도 잘 모르겠고.."
- Before: 지운 양을 버리지 않고 모아 두었다가 끝에서 돌려준다
- After: 뒤처진 양을 기억해 두고 따라잡게 밀면 t=1에 도착한다
- The simple version gave a wrong picture of the mechanism. A paraphrase has to stay true.

Diffusion, 2026-10-19. "표준편차 s가 작은데, 왜 데이터 공간에서 생성하는 데이터의 분포가 왜 저래?", then "핵심만"
- Before: 빈 곳의 z는 학습 때 본 적이 없어서 디코더가 덩어리 사이의 점을 만든다.
- After: 빈 곳의 z에서 디코더는 가장 가까운 덩어리의 규칙을 그대로 늘려 쓴다. 그래서 z를 약 1.5배 키운 둥근 분포가 나온다.
- The text described something the figure did not show. Say what the figure shows, in two sentences.

## Depth for system papers

AI Scientist v3, 2026-10-18. "디자인이, 설명, 인터렉션이 다 너무 별로잖아"
- Before: v3는 여러 코딩 에이전트에게 단계를 나눠 맡겨요 / 칸 안의 점수는 지어낸 예시예요.
- After: MATH 예시 하나가 네 단계를 지나 논문이 돼요 / 단계를 눌러 보면 그 단계가 끝났을 때 무엇이 남는지 보여요. Accepted ("Rework the other slides … the same way").

AI Scientist v3, 2026-10-18. "전반적으로 이해는 다 되는데 ... 너무 전문성이 떨어지는 슬라이드인거 같아 ... 사람이 어디에 개입을 해야한다거나, 전체 파이프라인의 반복 구조라던가"
- After: 연구를 여섯 단계로 나누고 … 사람은 과제 정의와 마지막 검증을 맡아요 / 반복은 세 겹으로 들어 있고, 겹마다 멈추는 조건이 달라요
- Then "전체 파이프라인에 대한 알고리즘 모식도" was wanted. With pseudocode under it: "밑에 코드도 있어서 좀 빡세네". What stayed: the schematic with one plain sentence per step, the pseudocode in a fold.
- "이거 hill climbing하는 visual이 더 좋았는데": a curve the reader can see beat a text log of the same events.

Harness², 2026-10-19. After the deck: "지금 이 연구의 핵심이 그래서 뭐야?" then "근데 결국 그냥 llm이 다 판단하는거네?"
- Before: the mechanism slides said what each stage does (Propose, Probe, Compose, library) but not who makes each decision; that every choice is the editor LLM's appeared only as a clause on the last slide.
- After: a slide "판단은 결국 LLM이 하고, 실행은 그 판단의 재료를 준다" sorting what comes from execution (facts), what an LLM decides, and who evaluates, with what the evidence does and does not show. Accepted ("응 좋아").
- When a method replaces a verifier or a human, the reader's first question is who decides now. Answer it on the main path, next to the mechanism, not among the limits.

## Where the depth goes

InfiLoop v2, 2026-10-19 (the first one-shot deck of this skill). "뭔가 흐름을 따라가는 느낌이 딱 쉽게 느껴져야 하는데, 그렇지 않아. 그리고 이상한 곳에서 디테일하게 설명하고, 필요한 곳은 빠져있는 거 같아"
- Main-path space went to periphery: FPRM's internals (pre-norm, learned residual scale, damping) on the slide that only needed "a fixed ratio", the memory-saving recurrence N_t, D_t, the algebraic rewrite into a step size γ, the two-loop training schedule (L = 6, 12 segments, 504 layers), two TRM checkpoints reconciled on the problem slide.
- Thin where it mattered: why a looped model loses an answer it already had, what the learned score responds to and how it is trained without labels.
- Each fix from the source check and the reader tests was added to the main text, so every slide grew a clause. Decide the takeaway first, keep the main path for what it rests on, and send accurate side detail to folds.

## Emphasis and comparison

DiscoveryRSI, 2026-10-19. "중요한 부분은 강조를 하고 해야지"
- One or two phrases per slide in `<b>`, the claim or number that carries it.
- On the same deck, a comparison of several systems shown one system per click was not what the user wanted: compare them all at once in one static figure.

## What the user approved

AdaLN, 2026-10-17. The rewrite that got "지금 이런 설명 괜찮은거 같아" opened with why a diffusion model needs to know its timestep, introduced LayerNorm only as the base the idea changes, kept one number-line figure across slides (the same points normalized, scaled, shifted, then moved by t), put related methods and the parameter count in folds, and labelled illustrative values once. assets/example-deck.html is that explanation in ~다 체.
