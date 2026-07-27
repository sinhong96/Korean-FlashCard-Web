# Design: multi-word lesson requests

## Problem

Today, teaching a word requires one message per word: `단어 뜻` (+ optional example
sentence on the next line) triggers a single Claude call that returns a lesson for that
one word, and it becomes one row in the lesson batch. If a single example sentence
introduces two unfamiliar words, Sin Hong currently has to ask about them in two separate
messages, even though they share the same context sentence and would read more naturally
taught together.

## Solution

Extend the existing typed-message lesson trigger to accept a comma-separated list of
words before `뜻`: `단어1, 단어2 뜻` (any number of words, not just two) followed by the
shared example sentence on the next line. One Claude call produces a single cohesive
lesson discussing all the words together in that sentence's context, but still returns
per-word structured data (Chinese gloss candidates, hanja, English, pronunciation) so each
word still becomes its own independent flashcard row in the batch — asking for N words in
one message is equivalent to asking N times, just in one exchange with one shared
narrative.

Single-word requests (no comma) work exactly as today — this is purely additive.

Screenshot-based lessons (`vocabLessonFromImage`) are explicitly **out of scope**: a
screenshot already deliberately picks a single hardest word (see `IMAGE_LESSON_SYSTEM`),
and multi-word extraction from an image is a different problem not requested here.

## Changes (`api/telegram.js` only)

### `parseLessonRequest(text)`
Currently returns `{ word, sentence }` (or `null`). Changes to return `{ words: string[],
sentence }` (or `null`) — `words` always an array, length 1 for the normal single-word
case. The first-line match `(.{1,40}?)\s*(?:뜻|의 뜻|뜻은)\s*\??$` has its length cap raised
from 40 to 80 to comfortably fit a few comma-separated words; the captured group is then
split on `,`, trimmed, and empty entries filtered out.

### `LESSON_SCHEMA` / `LESSON_SYSTEM`
Restructured from one flat object (`word`, `chinese_options`, `hanja`, `english`,
`pronunciation` at the top level alongside `lesson` and `sentence`) to:
```
{
  lesson: string,       // one cohesive narrative covering every word together
  sentence: string,     // shared example sentence + translation
  entries: [
    { word, chinese_options, hanja, english, pronunciation },
    ...                  // one object per input word, same order as input
  ]
}
```
`LESSON_SYSTEM`'s instructions are updated to: given a list of one or more words (and
optionally a shared context sentence), write ONE lesson that — when there's more than one
word — explicitly discusses how the words relate/appear together in the sentence, not N
separate back-to-back mini-lessons. The per-word structured fields keep their existing
per-field instructions (Chinese gloss ordering for a Malaysian Chinese speaker, hanja
notation, pronunciation rules), just nested under `entries[i]` instead of the top level.

### `vocabLesson({ words, sentence })`
Takes the array from `parseLessonRequest`, builds the user-content string listing all
words (e.g. `Words: 단어1, 단어2\nContext sentence: ...`), calls Claude with the new
schema, and passes `out.entries` (plus `out.lesson`) to `finishLesson`.

### `finishLesson(out, fallbackWords)`
Currently takes one flat `out` object and returns `{ text, buttons }` for exactly one
word. Changes to iterate `out.entries` (an array): for each entry, build its batch row
(word/definition/sentence/pronunciation — `sentence` now comes from the shared top-level
`out.sentence` for every entry, not a per-entry field) and its own two-row button block
(Chinese-gloss options + the existing "✏️ Other" button), inserting/updating each into the
batch same as today (find-by-word, upsert). The per-entry hint line gains the word itself
for clarity when there's more than one block stacked in the same message: `🀄 <word> 中文 =
<option[0]> — tap a button to change it` (previously omitted the word since only one block
ever existed). Auto-flush still checks `rows.length >= BATCH_SIZE` once after all entries
are inserted — bulk-inserting N words can overshoot 15 by up to N-1; not worth guarding
further (YAGNI, matches this being a low-stakes personal batch size, not a hard cap).

`fallbackWords` (renamed from `fallbackWord`) is only used when the model's own `word`
field for an entry is empty, mirroring today's fallback behavior per-entry instead of once.

### `vocabLessonFromImage`
Still produces exactly one word (unchanged `IMAGE_LESSON_SCHEMA`/`IMAGE_LESSON_SYSTEM`),
but now wraps its single result into a one-entry `entries: [...]` array before calling the
now-shared `finishLesson`, so the image flow keeps working unchanged from the user's
perspective — one word, one button block — while sharing the same tail code as the text
flow instead of a parallel implementation.

### Dispatch site (`lessonMatch` handling)
`else if (lessonMatch) { reply = await vocabLesson(lessonMatch); ... }` is unchanged in
shape — `vocabLesson` now expects `{ words, sentence }` instead of `{ word, sentence }`,
matching `parseLessonRequest`'s new return shape.

## Data flow

```
"단어1, 단어2 뜻\n예문..."
        │
parseLessonRequest → { words: ["단어1","단어2"], sentence: "예문..." }
        │
vocabLesson → claude(LESSON_SYSTEM, "Words: 단어1, 단어2\nContext sentence: 예문...")
        │
        ▼
{ lesson: "<one narrative>", sentence: "...", entries: [{word:"단어1",...}, {word:"단어2",...}] }
        │
finishLesson(out) → for each entry: batch row + button block
        │
        ▼
Telegram message: lesson text + [Chinese options row, Other row] × 2 (one per word)
```

## Error handling

`entries` is declared in `LESSON_SCHEMA` with `minItems: 1`, so Claude's structured-output
enforcement (`claude()`'s existing JSON-schema validation) rejects a response with zero
entries the same hard way it already rejects any other missing required field — no new
failure mode, just one more schema constraint. Beyond that, no new error handling is
needed: `finishLesson`'s per-entry fallback (`fallbackWords`, for an empty per-entry `word`
field) mirrors today's single-entry fallback, just applied inside the loop instead of once.

## Out of scope

- Screenshot/image-based multi-word extraction.
- Capping or truncating word count in one message (comma-split handles as many as typed;
  Telegram's 4096-char message chunking already handles arbitrarily long combined lessons,
  see `sendTelegram`'s existing chunking loop).
- Deduplicating identical words typed twice in one request (existing upsert-by-word logic
  already naturally coalesces this as a side effect, not a designed feature).
