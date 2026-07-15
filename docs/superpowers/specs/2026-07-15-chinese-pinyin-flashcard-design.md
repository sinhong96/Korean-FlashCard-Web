# Chinese Pinyin Flashcard — design

_2026-07-15 — sketched from the Korean TOPIK flashcard project's pattern._

## Problem

Sin Hong reads/speaks Chinese fluently but hits characters and words where he
knows the meaning yet isn't sure how to pronounce them. The gap is plain
unknown pronunciation (not primarily 多音字 disambiguation, though polyphonic
words still get handled — see Card model). Existing project (`Topik flash
card` / Korean-FlashCard-Web) already solves this shape of problem for
Korean vocab; this is the same architecture retargeted at a different pain
point.

## Non-goals

- Not a general Chinese-learning app (grammar, listening, HSK curriculum).
- Not for someone starting Chinese from zero — meaning is usually already
  known; pinyin recall is the thing being drilled.
- No shared infrastructure with the Korean bot — fully separate repo/deploy/
  bot token, so nothing here can affect the Korean bot's cost caps or code.

## Repo & deployment

New repo: `Chinese-Pinyin-FlashCard-Web`, own Vercel project, own Telegram
bot (own BotFather token), own private Gist for review-queue state. File
layout mirrors the Korean repo:

```
Chinese-Pinyin-FlashCard-Web/
  index.html            — pinyin-drill front end (typed-answer variant of the Korean flip-card UI)
  api/telegram.js        — bot: character in, structured lesson out, batches to CSV
  api/sync.js             — forgot/remove taps → Gist review queue
  api/daily.js             — cron morning push
  lib/store.js              — Gist read/write (same pattern, own Gist)
  vocablist_csv/*.csv        — Hanzi,Pinyin,Meaning,Sentence
  sessions.json                — index the app reads
```

## CSV schema

```
Hanzi,Pinyin,Meaning,Sentence
行,xíng,走、去、可以,你行不行？
行,háng,排、行业（如银行）,他在银行工作。
```

- `Pinyin` — tone marks (not tone numbers); canonical answer used for
  matching and rendering.
- `Meaning` — Chinese explanation (近义词/解释), not an English gloss — the
  gap being drilled is pronunciation, and a Chinese explanation keeps the
  card in-language.
- A character with multiple readings is multiple rows, one per reading, each
  with its own Meaning/Sentence disambiguating which reading applies. SM-2
  then tracks each reading's recall independently.

## Card & grading flow

Front: Hanzi only. You type the pinyin. Submit compares your input against
the CSV `Pinyin` field, derives a rating, then reveals Meaning + Sentence +
the correct Pinyin, plus a TTS button (browser `speechSynthesis`, `zh` voice,
same mechanism the Korean app uses for `ko`).

**Input normalization** (both sides, before comparing): strip whitespace,
lowercase, accept `ü` typed as `v`, accept tone marks or trailing tone
numbers (`xíng` or `xing2`) as equivalent input formats.

**3-tier rating** (feeds the existing SM-2 `rateCard()` unchanged — interval
growth, e-factor, `dueDate`, Gist sync of weak words all reused as-is):

| Match | Rating | Effect |
|---|---|---|
| Syllable + tone both correct | 5 | full interval growth, same as "Got it" today |
| Syllable correct, tone wrong | 3 | partial credit — shortens next interval rather than resetting, since the sound is known, just not the tone |
| Syllable wrong | 1 | full reset, same as "Forgot" today |

This tone-vs-syllable split is the one new piece of grading logic; everything
downstream of the rating number is a straight reuse of the Korean app's SM-2
code.

## Telegram bot & Claude prompt

Same conversational batching pattern as the Korean bot's `k-vocab` flow: you
message a Hanzi/word, Claude returns a structured lesson, it batches to CSV
every 15 words and auto-commits a session (mirrors `BATCH_SIZE = 15` /
`pending.json` / `vocab_batch.json` conventions in `lib/store.js`).

Prompt differences from the Korean bot, driven by this deck's actual job
(pronunciation, not nuance):

- Return **every distinct reading** if the character/word is polyphonic —
  each becomes its own CSV row with its own Meaning/Sentence, so 银行/行走
  don't collapse into one card.
- Pinyin returned with tone marks; Meaning written in Chinese; one natural
  example Sentence per reading that disambiguates which reading is meant.
- Model: `claude-haiku-4-5` — this is structured lookup/formatting, not a
  lesson needing wit or nuance, so it doesn't warrant the sonnet cost the
  Korean bot's lesson-writing uses.

## What's reused vs. new

| Reused as-is | New |
|---|---|
| SM-2 interval/e-factor math (`rateCard`) | Typed-input UI (vs. tap-to-flip) |
| Gist-based review queue + daily push (`lib/store.js`, `api/sync.js`, `api/daily.js`) | Pinyin normalization + 3-tier match logic |
| Telegram batching-to-CSV bot pattern | Claude prompt (polyphonic rows, Chinese gloss, haiku) |
| `sessions.json` index / CSV-session convention | `zh` TTS voice selection |

## Open questions for implementation time

- Exact tone-number → tone-mark conversion table (standard pinyin numeral
  scheme, straightforward but needs a lookup table).
- Whether `v` for `ü` needs to also accept literal `ü`/`u:` as input.
