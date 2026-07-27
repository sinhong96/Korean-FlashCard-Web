# Multi-Word Lesson Requests Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let `단어1, 단어2 뜻` (any number of comma-separated words) teach multiple words
in one message, as a single cohesive lesson, while still creating one independent
flashcard row per word.

**Architecture:** `parseLessonRequest` now returns a `words: string[]` array instead of a
single `word` string. `LESSON_SCHEMA` nests the per-word structured fields (Chinese
options, hanja, English, pronunciation) under a new `entries` array, with `lesson` and
`sentence` staying shared/top-level. `finishLesson` — already the shared tail for both the
typed-word flow and the screenshot flow — becomes the one place that turns 1-or-more
`entries` into batch rows and per-word button blocks, so the screenshot flow (which always
produces exactly one entry) keeps working unchanged just by sharing the same nested schema
shape, no parallel code path.

**Tech Stack:** Plain Node.js (no dependencies, no build step), Vercel serverless function
`api/telegram.js`, Claude structured output (`output_config.format.type = "json_schema"`).

## Global Constraints

- No npm packages, bundlers, or build step (per project CLAUDE.md) — pure Node/JS edits only.
- `callback_data` must stay ≤ 64 bytes (Telegram API hard limit) — already guarded per-word
  in the existing code; preserve that guard per-entry.
- Screenshot-based lessons (`vocabLessonFromImage`) stay single-word — do not add multi-word
  extraction from images. They route through the same `finishLesson`, just always with
  exactly one entry.
- This repo has no automated test framework (confirmed in the prior plan too) —
  verification is `node --check` for syntax, targeted `node -e` sanity checks for pure
  logic (e.g. the comma-split), and a live Telegram round-trip before calling this done.
- Keep the existing lesson prose style/section headers (📖 뜻, 💬 문맥, 🗂 쓰이는 상황,
  💡 선생님의 팁, ✍️ 연습해 봅시다!) — extend them to cover multiple words, don't replace them.

---

### Task 1: `parseLessonRequest` returns a word array

**Files:**
- Modify: `api/telegram.js:589-597` (`parseLessonRequest`)
- Modify: `api/telegram.js:80,118-119` (dispatch site — confirm no change needed, see below)

**Interfaces:**
- Produces: `parseLessonRequest(text)` now returns `{ words: string[], sentence: string }`
  or `null` (previously `{ word: string, sentence: string }` or `null`). `words` is always
  an array, length 1 for a normal single-word request. Task 2's `vocabLesson` consumes this
  new shape.

- [ ] **Step 1: Replace `parseLessonRequest`**

Current code:
```js
function parseLessonRequest(text) {
  const cmd = text.match(/^\/(?:v|learn)\s+([\s\S]+)/i);
  const body = cmd ? cmd[1].trim() : text;
  const lines = body.split("\n");
  const m = lines[0].match(/^(.{1,40}?)\s*(?:뜻|의 뜻|뜻은)\s*\??$/);
  if (m) return { word: m[1].trim(), sentence: lines.slice(1).join("\n").trim() };
  if (cmd) return { word: lines[0].trim(), sentence: lines.slice(1).join("\n").trim() };
  return null;
}
```

Replace with:
```js
function parseLessonRequest(text) {
  const cmd = text.match(/^\/(?:v|learn)\s+([\s\S]+)/i);
  const body = cmd ? cmd[1].trim() : text;
  const lines = body.split("\n");
  const toWords = (s) => s.split(",").map((w) => w.trim()).filter(Boolean);
  const m = lines[0].match(/^(.{1,80}?)\s*(?:뜻|의 뜻|뜻은)\s*\??$/);
  if (m) return { words: toWords(m[1]), sentence: lines.slice(1).join("\n").trim() };
  if (cmd) return { words: toWords(lines[0]), sentence: lines.slice(1).join("\n").trim() };
  return null;
}
```

Note: the length cap on the first-line match went from 40 to 80 (comfortably fits a few
comma-separated words); `toWords` is shared between both return branches so `/v` and
`/learn` also get comma-splitting, consistent with the plain `단어 뜻` trigger.

- [ ] **Step 2: Confirm the dispatch site needs no change**

```bash
grep -n "lessonMatch" api/telegram.js
```

Expected: shows `const lessonMatch = parseLessonRequest(text);` (line ~80) and
`} else if (lessonMatch) { reply = await vocabLesson(lessonMatch); ... }` (lines ~118-119).
No edit needed here — `vocabLesson` is being changed in Task 2 to destructure `{ words,
sentence }` instead of `{ word, sentence }`, so this call site keeps working by forwarding
whatever shape `parseLessonRequest` produces.

- [ ] **Step 3: Sanity-check the comma split logic in isolation**

```bash
node -e '
const toWords = (s) => s.split(",").map((w) => w.trim()).filter(Boolean);
console.log(JSON.stringify(toWords("날려버리다")));
console.log(JSON.stringify(toWords("날려버리다, 훌쩍")));
console.log(JSON.stringify(toWords("날려버리다,  훌쩍 ,")));
'
```

Expected output (three lines):
```
["날려버리다"]
["날려버리다","훌쩍"]
["날려버리다","훌쩍"]
```
The third line confirms extra whitespace and a trailing comma both get cleaned up without
producing an empty-string entry.

- [ ] **Step 4: `node --check` and commit**

```bash
node --check api/telegram.js
git add api/telegram.js
git commit -m "$(cat <<'EOF'
parseLessonRequest: split comma-separated words into an array

First step of multi-word lesson support — words is now always an
array (length 1 for the normal case), comma-split and trimmed, so a
single message can name more than one word to teach.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Nest the lesson schema under `entries`, update the prompt

**Files:**
- Modify: `api/telegram.js:599-612` (`LESSON_SCHEMA`)
- Modify: `api/telegram.js:614-656` (`LESSON_SYSTEM`)
- Modify: `api/telegram.js:658-663` (`vocabLesson`)

**Interfaces:**
- Consumes: `parseLessonRequest`'s `{ words, sentence }` shape from Task 1.
- Produces: Claude now returns `{ lesson: string, sentence: string, entries: [{ word,
  chinese_options, hanja, english, pronunciation }, ...] }` (previously flat `{ lesson,
  word, chinese_options, hanja, english, pronunciation, sentence }`). Task 3's
  `finishLesson` consumes `out.entries` and `out.lesson`/`out.sentence`.

- [ ] **Step 1: Factor out a reusable per-entry schema and nest it**

Current code:
```js
const LESSON_SCHEMA = {
  type: "object",
  properties: {
    lesson: { type: "string" },
    word: { type: "string" },
    chinese_options: { type: "array", items: { type: "string" } },
    hanja: { type: "string" },
    english: { type: "string" },
    pronunciation: { type: "string" },
    sentence: { type: "string" },
  },
  required: ["lesson", "word", "chinese_options", "hanja", "english", "pronunciation", "sentence"],
  additionalProperties: false,
};
```

Replace with:
```js
const LESSON_ENTRY_SCHEMA = {
  type: "object",
  properties: {
    word: { type: "string" },
    chinese_options: { type: "array", items: { type: "string" } },
    hanja: { type: "string" },
    english: { type: "string" },
    pronunciation: { type: "string" },
  },
  required: ["word", "chinese_options", "hanja", "english", "pronunciation"],
  additionalProperties: false,
};

const LESSON_SCHEMA = {
  type: "object",
  properties: {
    lesson: { type: "string" },
    sentence: { type: "string" },
    entries: { type: "array", items: LESSON_ENTRY_SCHEMA, minItems: 1 },
  },
  required: ["lesson", "sentence", "entries"],
  additionalProperties: false,
};
```

`minItems: 1` means Claude's structured-output validation rejects a response with zero
entries outright — no manual empty-array guard needed later.

- [ ] **Step 2: Update `LESSON_SYSTEM`**

Current code (full current value, to replace in one piece):
```js
const LESSON_SYSTEM =
  "You are Sin Hong's expert, witty Korean teacher, replying inside Telegram. He is a Chinese " +
  "speaker learning Korean.\n\n" +
  "Formatting: the lesson is sent with Telegram HTML parse mode. No markdown (no ##, no **). " +
  "The ONLY tags allowed are <b> and <i>: wrap the target word and 2-4 genuinely key terms in " +
  "<b>…</b>, and Korean example sentences in <i>…</i>. Never use other tags, and write any " +
  "literal &, < or > as &amp;, &lt;, &gt;.\n\n" +
  "Given a Korean word (and optionally a context sentence he met it in), return JSON with:\n\n" +
  '"lesson" — a lesson in exactly this layout:\n\n' +
  "'단어'는 [brief, clear definition in Korean]. — when the pronunciation differs from the " +
  "spelling, write the word as '단어' [발음], e.g. '대통령' [대ː통녕].\n" +
  "[If a context sentence was given: 1-2 sentences of witty or culturally insightful commentary on it.]\n\n" +
  "📖 뜻\n" +
  "- 사전적 정의: [Korean definition(s), numbered if several]\n" +
  "- English: [translations, comma-separated]\n" +
  "- Chinese: [translations with pinyin, comma-separated]\n\n" +
  "💬 문맥\n" +
  "[The specific nuance, cultural context, or humor of his sentence. If no sentence was given, " +
  "explain the most common colloquial usage instead.]\n\n" +
  "🗂 쓰이는 상황\n" +
  '1. [Situation] — "[Korean example]" (中文翻译)\n' +
  '2. [Situation] — "[Korean example]" (中文翻译)\n\n' +
  "💡 선생님의 팁\n" +
  "[Short, personalized tip using a practical real-world scenario.]\n" +
  '"[Korean example]" (中文)\n\n' +
  "✍️ 연습해 봅시다!\n" +
  "[A question in Korean prompting him to practice the word.]\n" +
  '(예: "[sample answer]")\n\n' +
  'Keep the lesson under 3000 characters.\n\n' +
  '"word" — the target Korean word/phrase only. No HTML in any field except "lesson".\n' +
  '"chinese_options" — 2-4 candidate Chinese glosses for the flashcard, each a concise everyday ' +
  "Mandarin term (join close synonyms with /). Sin Hong is MALAYSIAN Chinese: order by what a " +
  "Malaysian/SEA Mandarin speaker actually says — e.g. for 왕세자 put 王储 first and the literal " +
  "hanja reading 王世子 later; include a literal reading only when it is real, natural Chinese. " +
  "NEVER write template labels such as 现代中文核心解释 or 原生韩文汉字.\n" +
  '"hanja" — the word\'s hanja: --- if none, - for each non-hanja syllable (e.g. 事情--, 嫌惡--).\n' +
  '"english" — brief English definition, comma-separated senses.\n' +
  '"pronunciation" — the word\'s 표준 발음 in hangul with length marks, NO brackets (e.g. for ' +
  "대통령: 대ː통녕; for 밥값: 밥깝). ONLY when it differs from the spelling — empty string \"\" when " +
  "reading the spelling as written is already correct. Apply real sound rules (비음화, 경음화, " +
  "연음, 자음동화, vowel length); do not invent differences.\n" +
  '"sentence" — one natural Korean example sentence followed by its Chinese translation in parentheses. ' +
  "If he gave a context sentence, prefer it (cleaned up / completed) as the example.";
```

Replace with:
```js
const LESSON_SYSTEM =
  "You are Sin Hong's expert, witty Korean teacher, replying inside Telegram. He is a Chinese " +
  "speaker learning Korean.\n\n" +
  "Formatting: the lesson is sent with Telegram HTML parse mode. No markdown (no ##, no **). " +
  "The ONLY tags allowed are <b> and <i>: wrap each target word and 2-4 genuinely key terms in " +
  "<b>…</b>, and Korean example sentences in <i>…</i>. Never use other tags, and write any " +
  "literal &, < or > as &amp;, &lt;, &gt;.\n\n" +
  "You'll be given one or more Korean words (comma-separated when there's more than one), and " +
  "optionally a shared context sentence he met them in. Return JSON with:\n\n" +
  '"lesson" — a lesson in exactly this layout. For a single word:\n\n' +
  "'단어'는 [brief, clear definition in Korean]. — when the pronunciation differs from the " +
  "spelling, write the word as '단어' [발음], e.g. '대통령' [대ː통녕].\n" +
  "[If a context sentence was given: 1-2 sentences of witty or culturally insightful commentary on it.]\n\n" +
  "📖 뜻\n" +
  "- 사전적 정의: [Korean definition(s), numbered if several]\n" +
  "- English: [translations, comma-separated]\n" +
  "- Chinese: [translations with pinyin, comma-separated]\n\n" +
  "💬 문맥\n" +
  "[The specific nuance, cultural context, or humor of his sentence. If no sentence was given, " +
  "explain the most common colloquial usage instead.]\n\n" +
  "🗂 쓰이는 상황\n" +
  '1. [Situation] — "[Korean example]" (中文翻译)\n' +
  '2. [Situation] — "[Korean example]" (中文翻译)\n\n' +
  "💡 선생님의 팁\n" +
  "[Short, personalized tip using a practical real-world scenario.]\n" +
  '"[Korean example]" (中文)\n\n' +
  "✍️ 연습해 봅시다!\n" +
  "[A question in Korean prompting him to practice the word.]\n" +
  '(예: "[sample answer]")\n\n' +
  "For two or more words: keep the SAME section headers (📖 뜻, 💬 문맥, 🗂 쓰이는 상황, " +
  "💡 선생님의 팁, ✍️ 연습해 봅시다!) but cover every word together under each header instead of " +
  "repeating the whole layout per word — one 📖 뜻 section listing each word's meaning in turn, " +
  "one 💬 문맥 section discussing how the words work together in the shared sentence, one shared " +
  "practice question using all of them. Open with each word's core definition ('단어1'는 ..., " +
  "'단어2'는 ...) before those sections. Write ONE cohesive lesson, never separate back-to-back " +
  "lessons.\n\n" +
  "Keep the lesson under 3000 characters regardless of word count.\n\n" +
  '"sentence" — one natural Korean example sentence covering all the words together, followed by ' +
  "its Chinese translation in parentheses. If he gave a context sentence, prefer it (cleaned up / " +
  "completed) as the example.\n\n" +
  '"entries" — one object per input word, in the SAME order they were given, each with:\n' +
  '  "word" — that entry\'s target Korean word/phrase only. No HTML in any field except "lesson".\n' +
  '  "chinese_options" — 2-4 candidate Chinese glosses for the flashcard, each a concise everyday ' +
  "Mandarin term (join close synonyms with /). Sin Hong is MALAYSIAN Chinese: order by what a " +
  "Malaysian/SEA Mandarin speaker actually says — e.g. for 왕세자 put 王储 first and the literal " +
  "hanja reading 王世子 later; include a literal reading only when it is real, natural Chinese. " +
  "NEVER write template labels such as 现代中文核心解释 or 原生韩文汉字.\n" +
  '  "hanja" — the word\'s hanja: --- if none, - for each non-hanja syllable (e.g. 事情--, 嫌惡--).\n' +
  '  "english" — brief English definition, comma-separated senses.\n' +
  '  "pronunciation" — the word\'s 표준 발음 in hangul with length marks, NO brackets (e.g. for ' +
  "대통령: 대ː통녕; for 밥값: 밥깝). ONLY when it differs from the spelling — empty string \"\" when " +
  "reading the spelling as written is already correct. Apply real sound rules (비음화, 경음화, " +
  "연음, 자음동화, vowel length); do not invent differences.";
```

- [ ] **Step 3: Update `vocabLesson`**

Current code:
```js
async function vocabLesson({ word, sentence }) {
  const userText = sentence ? `Word: ${word}\nContext sentence: ${sentence}` : `Word: ${word}`;
  const gen = await claude(LESSON_SYSTEM, userText, LESSON_SCHEMA, { model: LESSON_MODEL, maxTokens: 6000 });
  const out = JSON.parse(gen);
  return finishLesson(out, word);
}
```

Replace with:
```js
async function vocabLesson({ words, sentence }) {
  const wordList = words.join(", ");
  const userText = sentence ? `Words: ${wordList}\nContext sentence: ${sentence}` : `Words: ${wordList}`;
  const gen = await claude(LESSON_SYSTEM, userText, LESSON_SCHEMA, { model: LESSON_MODEL, maxTokens: 6000 });
  const out = JSON.parse(gen);
  return finishLesson(out, words);
}
```

Note `finishLesson(out, words)` now passes the whole array as the fallback source (Task 3
indexes into it per-entry), replacing the old single-word fallback.

- [ ] **Step 4: `node --check` and commit**

```bash
node --check api/telegram.js
git add api/telegram.js
git commit -m "$(cat <<'EOF'
Nest lesson schema under entries[], update prompt for multi-word

LESSON_SCHEMA now returns { lesson, sentence, entries: [...] } instead
of one flat object, so a single Claude call can teach several words
sharing one cohesive lesson and one example sentence while still
returning distinct per-word structured data (Chinese glosses, hanja,
English, pronunciation) for the flashcard rows.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: `finishLesson` iterates entries; wire up the image-lesson flow

**Files:**
- Modify: `api/telegram.js:665-709` (`finishLesson`)
- Modify: `api/telegram.js:716-729` (`IMAGE_LESSON_INTRO`)
- Modify: `api/telegram.js:740-754` (`vocabLessonFromImage`)

**Interfaces:**
- Consumes: `out.entries` (array, from Task 2), `out.lesson`, `out.sentence`; the
  `fallbackWords` array from Task 2's `vocabLesson` call (or `undefined` from the image
  flow, matching today's behavior of not passing a fallback there).
- Produces: `finishLesson(out, fallbackWords)` returns `{ text, buttons }` same as before —
  callers don't need to change how they use the return value, only how they build `out`.

- [ ] **Step 1: Replace `finishLesson`**

Current code:
```js
// Shared tail for both the typed-word lesson flow and the image lesson flow below:
// batches the row (or commits it straight away if the Gist batch isn't set up) and
// builds the Chinese-gloss picker buttons. fallbackWord only matters if the model's
// "word" field is somehow empty, which the schema makes very unlikely for text input.
async function finishLesson(out, fallbackWord) {
  const options = (out.chinese_options || []).map((s) => s.trim()).filter(Boolean);
  const row = {
    word: (out.word || fallbackWord || "").trim(),
    definition: `${options[0] || ""} (${(out.hanja || "---").trim()}) / [EN] ${(out.english || "").trim()}`,
    sentence: out.sentence,
    pronunciation: (out.pronunciation || "").trim().replace(/^\[|\]$/g, ""),
  };

  // One tap swaps the flashcard's Chinese gloss (callback_data caps at 64 bytes)
  const choices = options
    .filter((t) => Buffer.byteLength(`d|${row.word}|${t}`, "utf8") <= 64)
    .slice(0, 4)
    .map((t) => ({ text: t, callback_data: `d|${row.word}|${t}` }));
  // "Other" lets him type a gloss the AI didn't suggest, without retyping /def word by hand
  const otherButton =
    Buffer.byteLength(`e|${row.word}`, "utf8") <= 64
      ? { text: "✏️ Other", callback_data: `e|${row.word}` }
      : null;
  const buttons = otherButton ? [choices, [otherButton]].filter((row) => row.length) : undefined;
  const hint = buttons ? `\n🀄 Flashcard 中文 = ${options[0]} — tap a button to change it` : "";

  if (!process.env.GIST_ID) {
    // No batch store yet — save the word straight to today's Bot session instead
    const saved = await commitEntries([row]);
    return { text: out.lesson + "\n\n(Batch tracking needs GIST_ID — saved this word directly.)\n" + saved + hint, buttons };
  }

  const batch = await readGistFile(BATCH_FILE);
  const rows = batch.rows || [];
  const idx = rows.findIndex((r) => r.word === row.word);
  if (idx >= 0) rows[idx] = row; // re-asking a word updates its row, no duplicate
  else rows.push(row);
  await writeGistFile(BATCH_FILE, { rows, startedAt: batch.startedAt || new Date().toISOString() });

  if (rows.length >= BATCH_SIZE) {
    const saved = await flushBatch();
    return { text: out.lesson + `\n\n🚨 Batch complete (${BATCH_SIZE}/${BATCH_SIZE})! Auto-saving…\n` + saved + hint, buttons };
  }
  return { text: out.lesson + `\n\n[Batch ${rows.length}/${BATCH_SIZE}]` + hint, buttons };
}
```

Replace with:
```js
// Shared tail for both the typed-word lesson flow and the image lesson flow below:
// batches each entry's row (or commits it straight away if the Gist batch isn't set up)
// and builds each entry's Chinese-gloss picker buttons. fallbackWords (an array, matched
// by position) only matters if an entry's own "word" field is somehow empty; the image
// flow passes no fallbackWords since it doesn't know the word ahead of time.
async function finishLesson(out, fallbackWords) {
  const rows = [];
  const buttonBlocks = [];
  const hints = [];

  out.entries.forEach((entry, i) => {
    const options = (entry.chinese_options || []).map((s) => s.trim()).filter(Boolean);
    const row = {
      word: (entry.word || (fallbackWords && fallbackWords[i]) || "").trim(),
      definition: `${options[0] || ""} (${(entry.hanja || "---").trim()}) / [EN] ${(entry.english || "").trim()}`,
      sentence: out.sentence,
      pronunciation: (entry.pronunciation || "").trim().replace(/^\[|\]$/g, ""),
    };
    rows.push(row);

    // One tap swaps the flashcard's Chinese gloss (callback_data caps at 64 bytes)
    const choices = options
      .filter((t) => Buffer.byteLength(`d|${row.word}|${t}`, "utf8") <= 64)
      .slice(0, 4)
      .map((t) => ({ text: t, callback_data: `d|${row.word}|${t}` }));
    // "Other" lets him type a gloss the AI didn't suggest, without retyping /def word by hand
    const otherButton =
      Buffer.byteLength(`e|${row.word}`, "utf8") <= 64
        ? { text: "✏️ Other", callback_data: `e|${row.word}` }
        : null;
    if (otherButton) {
      buttonBlocks.push(choices, [otherButton]);
      hints.push(`\n🀄 ${row.word} 中文 = ${options[0]} — tap a button to change it`);
    }
  });

  const buttons = buttonBlocks.length ? buttonBlocks.filter((row) => row.length) : undefined;
  const hint = hints.join("");

  if (!process.env.GIST_ID) {
    // No batch store yet — save the words straight to today's Bot session instead
    const saved = await commitEntries(rows);
    return { text: out.lesson + "\n\n(Batch tracking needs GIST_ID — saved directly.)\n" + saved + hint, buttons };
  }

  const batch = await readGistFile(BATCH_FILE);
  const batchRows = batch.rows || [];
  for (const row of rows) {
    const idx = batchRows.findIndex((r) => r.word === row.word);
    if (idx >= 0) batchRows[idx] = row; // re-asking a word updates its row, no duplicate
    else batchRows.push(row);
  }
  await writeGistFile(BATCH_FILE, { rows: batchRows, startedAt: batch.startedAt || new Date().toISOString() });

  if (batchRows.length >= BATCH_SIZE) {
    const saved = await flushBatch();
    return { text: out.lesson + `\n\n🚨 Batch complete (${BATCH_SIZE}/${BATCH_SIZE})! Auto-saving…\n` + saved + hint, buttons };
  }
  return { text: out.lesson + `\n\n[Batch ${batchRows.length}/${BATCH_SIZE}]` + hint, buttons };
}
```

- [ ] **Step 2: Update `IMAGE_LESSON_INTRO`'s wording for the nested schema**

Current code:
```js
const IMAGE_LESSON_INTRO =
  "You are given a screenshot from a Korean YouTube video, taken by Sin Hong on his phone " +
  "because it contains a Korean subtitle with a word he doesn't understand. The frame may " +
  "contain a stylized/handwritten caption overlay AND a separate standard subtitle line — " +
  "read ALL visible Korean text. From it, pick the SINGLE word or short phrase a Chinese-" +
  "speaking TOPIK 3-4 learner is LEAST likely to already know — prefer advanced, idiomatic, " +
  "or onomatopoeic vocabulary (e.g. 느릿느릿, 훌쩍) over basic particles or elementary words. " +
  'Return "word" in its dictionary form (기본형), not as conjugated in the subtitle. If a ' +
  'genuinely strong second candidate exists, name it in "runner_up"; otherwise "runner_up" ' +
  'is "". If NO Korean text is legible in the image at all, set "word" to "" and every other ' +
  "field to \"\" (or [] for array fields) — do not guess or hallucinate a word. He may also " +
  "send a caption alongside the photo — if present, treat it as a hint about which word he " +
  "means, but don't require it. Otherwise, produce the SAME lesson JSON described below, " +
  'using the picked word and the Korean sentence it appeared in as the "sentence" context.\n\n';
```

Replace with:
```js
const IMAGE_LESSON_INTRO =
  "You are given a screenshot from a Korean YouTube video, taken by Sin Hong on his phone " +
  "because it contains a Korean subtitle with a word he doesn't understand. The frame may " +
  "contain a stylized/handwritten caption overlay AND a separate standard subtitle line — " +
  "read ALL visible Korean text. From it, pick the SINGLE word or short phrase a Chinese-" +
  "speaking TOPIK 3-4 learner is LEAST likely to already know — prefer advanced, idiomatic, " +
  "or onomatopoeic vocabulary (e.g. 느릿느릿, 훌쩍) over basic particles or elementary words. " +
  'Return exactly one object in "entries", with its "word" in dictionary form (기본형), not ' +
  "as conjugated in the subtitle. If a genuinely strong second candidate exists, name it in " +
  '"runner_up"; otherwise "runner_up" is "". If NO Korean text is legible in the image at ' +
  'all, return a single entry with "word" set to "" and every other field "" (or [] for ' +
  "array fields) — do not guess or hallucinate a word. He may also send a caption alongside " +
  "the photo — if present, treat it as a hint about which word he means, but don't require " +
  "it. Otherwise, produce the SAME lesson JSON described below, using the picked word and " +
  'the Korean sentence it appeared in as the "sentence" context.\n\n';
```

- [ ] **Step 3: Update `vocabLessonFromImage`'s empty-word check**

Current code:
```js
async function vocabLessonFromImage(photos, caption) {
  const imageBlock = await fetchTelegramPhotoAsBase64(photos[photos.length - 1].file_id);
  const hintBlock = { type: "text", text: caption ? `User hint: ${caption}` : "No caption" };
  const gen = await claude(IMAGE_LESSON_SYSTEM, [imageBlock, hintBlock], IMAGE_LESSON_SCHEMA, {
    model: LESSON_MODEL,
    maxTokens: 6000,
  });
  const out = JSON.parse(gen);
  if (!out.word || !out.word.trim()) {
    return "Couldn't read a Korean subtitle in that screenshot — try a clearer or closer crop.";
  }
  const result = await finishLesson(out);
  const runnerUp = (out.runner_up || "").trim();
  if (!runnerUp || typeof result === "string") return result;
  return {
    ...result,
    text: result.text + `\n\n👀 Also spotted: ${runnerUp} — send "${runnerUp} 뜻" if you meant that one instead.`,
  };
}
```

Replace with:
```js
async function vocabLessonFromImage(photos, caption) {
  const imageBlock = await fetchTelegramPhotoAsBase64(photos[photos.length - 1].file_id);
  const hintBlock = { type: "text", text: caption ? `User hint: ${caption}` : "No caption" };
  const gen = await claude(IMAGE_LESSON_SYSTEM, [imageBlock, hintBlock], IMAGE_LESSON_SCHEMA, {
    model: LESSON_MODEL,
    maxTokens: 6000,
  });
  const out = JSON.parse(gen);
  const picked = out.entries[0];
  if (!picked || !picked.word || !picked.word.trim()) {
    return "Couldn't read a Korean subtitle in that screenshot — try a clearer or closer crop.";
  }
  const result = await finishLesson(out);
  const runnerUp = (out.runner_up || "").trim();
  if (!runnerUp || typeof result === "string") return result;
  return {
    ...result,
    text: result.text + `\n\n👀 Also spotted: ${runnerUp} — send "${runnerUp} 뜻" if you meant that one instead.`,
  };
}
```

(`out.entries[0]` is always present because `IMAGE_LESSON_SCHEMA` inherits `entries`'s
`minItems: 1` from `LESSON_SCHEMA` via its property spread — Claude cannot return zero
entries.)

- [ ] **Step 4: `node --check` and commit**

```bash
node --check api/telegram.js
git add api/telegram.js
git commit -m "$(cat <<'EOF'
finishLesson: iterate entries[] for multi-word batching + buttons

finishLesson now loops over out.entries instead of handling one flat
object, producing one batch row and one Chinese-gloss button block
(with a word-labeled hint) per entry. The image-lesson flow updates
its wording and empty-word check for the nested schema but is
otherwise unaffected — it always produces exactly one entry, so it
gets one row and one button block same as before.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Verify (mechanical checks + live round-trip)

**Files:**
- No files created or modified except `Memory.md` (Step 4).

**Interfaces:**
- Consumes: the full `api/telegram.js` module as edited in Tasks 1-3.

- [ ] **Step 1: Full-file syntax check and structural grep**

```bash
node --check api/telegram.js && echo SYNTAX_OK
grep -n "words: toWords\|LESSON_ENTRY_SCHEMA\|entries: { type: \"array\"\|out.entries.forEach\|out.entries\[0\]" api/telegram.js
```

Expected: `SYNTAX_OK`, plus grep hits in `parseLessonRequest`, `LESSON_SCHEMA`,
`finishLesson`, and `vocabLessonFromImage` — confirming all four edited spots landed (a
common mistake here would be updating the schema but forgetting one of the two functions
that build/consume it).

- [ ] **Step 2: Push and do a live Telegram round-trip**

```bash
git fetch origin
git log HEAD..origin/main --oneline   # check for new "Bot: ..." auto-commits first
git rebase origin/main                # only if the previous command showed anything
node --check api/telegram.js && echo SYNTAX_OK   # re-check after any rebase
git push
```

Wait for Vercel to redeploy, then in the actual Telegram chat:
1. **Single-word regression check first**: send a normal single-word request, e.g.
   `단어 뜻`. Confirm it behaves exactly as before — one lesson, one button block, one
   batch row. This is the most important check, since it confirms the refactor didn't
   break the common case.
2. **Multi-word**: send `날려버리다, 훌쩍 뜻` (or two real words you want to learn) followed
   by a shared example sentence on the next line. Confirm:
   - One cohesive lesson mentioning both words (not two separate back-to-back lessons).
   - Two button blocks, each labeled with its own word in the hint line (e.g. `🀄 날려버리다
     中文 = ...` and `🀄 훌쩍 中文 = ...`).
   - `/batch` shows two new rows, one per word.
3. **Other-button spot-check on a multi-word result**: tap "✏️ Other" under one of the two
   words' button blocks, reply with a Chinese term, confirm only *that* word's definition
   changes (check via `/batch`), not the other word's.
4. **Screenshot flow spot-check**: send a Korean-subtitle screenshot as before. Confirm it
   still teaches exactly one word with one button block — this is the regression check for
   Task 3's `vocabLessonFromImage` changes.

- [ ] **Step 3: Update `Memory.md`**

Add a bullet to "Recently done" (newest first) describing the multi-word lesson feature,
referencing this plan and the design spec. Then commit:

```bash
git add Memory.md
git commit -m "Update Memory.md: multi-word lesson requests added and round-tripped live"
```
