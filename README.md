# Slowpoke Pics ABn Blind Test

A Tampermonkey userscript for double-blind ABn source comparison testing on [slow.pics](https://slow.pics). Sources are shuffled and relabelled A, B, C… so you cannot tell which source you are viewing during the test. Statistics on the results are reported.

---

## Installation

1. Install [Tampermonkey](https://www.tampermonkey.net/) in your browser.
2. Open the Tampermonkey dashboard → **Create a new script**.
3. Paste the contents of `slowpics-abn.user.js` and save.
4. Navigate to any slow.pics comparison (`https://slow.pics/c/...`).

---

## Usage

### Starting a test

1. Click **🔀 ABn Mode** in the navbar (top-left).
2. A source selection dialog appears. Uncheck any sources you want to exclude. At least two are required. Click **Start ABn Test**.
3. **Mask setup:** Draw a rectangle over the source label area of the image to black it out during the test. Use the site's source switcher to verify the mask covers the label for every source, then click **✓ Confirm**. If there are no visible source labels, click **No labels — skip**.
4. The test begins. Sources are assigned random blind labels (A, B, C…) which stay fixed for the entire session.

### Voting

A floating panel appears on the left side of the screen showing the current blind label and frame number. It can be dragged to any position.

| Button | Meaning |
|---|---|
| ⭐ **Best** | This source is the best on this frame. Advances to the next frame automatically. |
| — **No preference** | You examined this frame carefully and could not pick a winner. Advances automatically. Clicking again on the same frame undoes the vote. |
| 📊 **Results** | Show results at any time. |
| ↺ **New Test** | Reset all votes and reshuffle. The mask is kept. |

Thumbnail borders indicate vote state: green = voted, grey = no preference, amber = current unvoted frame. You can navigate freely to revisit and change any vote.

### Exporting results

In the results modal, click **📋 Copy plain-text results** to copy a formatted summary suitable for pasting into a forum post.

---

## Voting discipline

The model depends on the two vote types being used consistently:

- **⭐ Best** — you can identify a winner on this frame.
- **— No preference** — you examined the frame and genuinely cannot tell the sources apart. Use this only on frames where a difference *could* exist but isn't detectable to you.
- **Unvoted frames** are excluded entirely. Simply navigate past any frame that isn't useful for comparison (flat areas, pure black, etc.) without voting.

**!!!IMPORTANT!!!** 

The distinction between "no preference" and skipping matters. No-preference votes are evidence that the sources are hard to distinguish; skipped frames are treated as if they never happened. Voting no-preference on non-discriminable content will inflate the tie rate and make results look less decisive than they are. No-preference should **not** be used on frames with content you do not deem important for comparison, e.g., intertitles, credits, black or highly blurry frames, etc.

---

## Output format

```
=== ABn Blind Test Results ===
https://slow.pics/c/oinwCqId

12 frames total | 9 preference | 1 no-preference | 2 not voted

Distinguishability: 87% [95% prediction interval: 66%–98%]
Sources clearly distinguishable in most frames

                    0%        25%       50%       75%       100%
                    |   :   : | :   :   |   :   : | :   :   |
FRA Blu-ray                   [══════════▌═════════]        E[φ]= 54% [28%–79%]      P(best)= 88% 6v
GER Blu-ray          [══════▌══════════]                    E[φ]= 23% [6%–49%]       P(best)=  9% 2v
USA Blu-ray         [════▌════════]                         E[φ]= 15% [2%–38%]       P(best)=  3% 1v
GBR Blu-ray        [══▌══════]                              E[φ]=  8% [0%–26%]       P(best)=  0% 0v
                    |   :   : | :   :   |   :   : | :   :   |
                    0%        25%       50%       75%       100%

 ▌ = E[φⱼ]: expected win-rate on a discriminable frame
 [═══] = 95% prediction interval on φⱼ
 P(best): posterior probability this source has the highest φⱼ of all sources

Per-frame (GBR Blu-ray (C) | FRA Blu-ray (D) | GER Blu-ray (B) | USA Blu-ray (A))
 D D B A = D D D D B | — —
 (=: no preference   —: not voted   |: every 10 frames)

Model: Dirichlet-Multinomial, uniform prior.
All intervals are 95% posterior prediction intervals via 10,000 Monte Carlo samples.
```

---

## Interpreting results

The script uses a Bayesian approach: before any votes are cast, all outcomes (source A wins, source B wins, no preference, etc.) are treated as equally likely. Each vote updates these probabilities — a source that wins often will accumulate evidence in its favour, while one that rarely wins will drift toward zero. With few votes the estimates are uncertain and the prediction intervals are wide; with more votes the intervals narrow and the results become more conclusive. There is no minimum vote count.

**Distinguishability** is the estimated fraction of your voted frames where the sources were perceptually different to you. Low distinguishability (below ~30%) means the sources are hard to tell apart and the win-rate estimates should be treated with caution.

**E[φ]** is the estimated win-rate for each source — the percentage of discriminable frames that source would win. The bracketed range is a 95% prediction interval: given the votes cast, the true win-rate most plausibly lies within that range.

**P(best)** is the probability that a given source has the highest true win-rate of all sources tested. A high P(best) (e.g. 90%+) means there is strong evidence that source is the best; a value near 1/N (where N is the number of sources) means the test is inconclusive.

---

## Statistical background

For readers with a statistics background: the model is a Dirichlet-Multinomial with a uniform prior over the outcome N+1 simplex (no-preference, source 1 wins, …, source N wins) = (θ₀,...). The posterior is conjugate and closed-form. Reported win-rates are φⱼ = θⱼ/(1−θ₀), the win-rate conditional on a discriminable frame. All intervals are 95% posterior prediction intervals computed via 10,000 Monte Carlo draws from the posterior Dirichlet. P(Source j best) is the posterior probability that φⱼ is the largest win-rate, estimated as the argmax frequency over MC draws.
