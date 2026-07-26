# /def "Other" Button Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a tap-to-type "Other" button to lesson messages so an unlisted Chinese gloss
can be entered without retyping the full `/def word chinese` command.

**Architecture:** One new inline button in `finishLesson()`'s existing button row, plus one
new `callback_data` kind (`"e"`) handled in the existing `handleCallback()` dispatcher.
Tapping it reuses the existing `pending.json`/`resolveDefPending`/`applyDefinition` chain
that already backs bare `/def` — no new storage, no new apply logic.

**Tech Stack:** Plain Node.js (no dependencies, no build step), Vercel serverless function
`api/telegram.js`, state in a private GitHub Gist via `lib/store.js`.

## Global Constraints

- No npm packages, bundlers, or build step (per project CLAUDE.md) — pure Node/JS edits only.
- `callback_data` must stay ≤ 64 bytes (Telegram API hard limit) — check with
  `Buffer.byteLength(str, "utf8")`, same guard style already used for the `"d"` buttons.
- Don't touch `/def`'s existing typed syntax, `PENDING_TTL_MS` (5 min), or the
  `pending.json` / Gist plumbing — reuse as-is.
- This repo has no automated test framework (confirmed: no `package.json`, no test files
  for `api/telegram.js`). Verification is a local Node script that stubs `fetch` (mirroring
  how the bare-`/def` pending flow was verified per `Memory.md`), plus a manual live-bot
  round-trip before calling this done.

---

### Task 1: Add the "Other" button and its callback handler

**Files:**
- Modify: `api/telegram.js` — `finishLesson()` (currently lines 660-695) and
  `handleCallback()` (new branch alongside the existing `"d"` branch at lines 387-399)

**Interfaces:**
- Consumes: `setPending(chatId, pendingObj)` (line 777), `answerCallback(id, text)`
  (line 413), `sendTelegram(chatId, text, opts)` (line 959), `PENDING_TTL_MS` (line 37) —
  all existing, unchanged.
- Produces: a `callback_data` of the form `"e|<word>"` that `handleCallback()` must parse
  the same way the `"d"` and `"w"` branches already do (`data.indexOf("|")` split).

- [ ] **Step 1: Read the current `finishLesson()` button-building block**

Confirm the exact current text before editing (it may have shifted slightly from the line
numbers above):

```bash
grep -n "One tap swaps the flashcard" -A 15 api/telegram.js
```

- [ ] **Step 2: Replace the button-building block in `finishLesson()`**

Find this existing block:

```js
  // One tap swaps the flashcard's Chinese gloss (callback_data caps at 64 bytes)
  const choices = options
    .filter((t) => Buffer.byteLength(`d|${row.word}|${t}`, "utf8") <= 64)
    .slice(0, 4)
    .map((t) => ({ text: t, callback_data: `d|${row.word}|${t}` }));
  const buttons = choices.length > 1 ? [choices] : undefined;
  const hint = buttons ? `\n🀄 Flashcard 中文 = ${options[0]} — tap to change, or /def ${row.word} 你的词` : "";
```

Replace it with:

```js
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
```

Note: `[choices, [otherButton]].filter((row) => row.length)` drops the `choices` row
entirely when the AI gave 0 usable options (keeping only the `["Other"]` row), while still
producing `[choices, [otherButton]]` (two rows) in the normal case.

- [ ] **Step 3: Add the `"e"` branch to `handleCallback()`**

Find the existing `"d"` branch (the block starting `// "d|단어|中文" — a Chinese-gloss choice
tapped under a lesson`) and insert a new branch immediately after its closing `}` (before
the `if (kind === "m" ...` block):

```js
  // "e|단어" — "Other" tapped: park a pending state so the user's next plain-text
  // message supplies the new Chinese, same flow as sending a bare /def.
  if (kind === "e") {
    await setPending(cq.message.chat.id, { command: "def", word, expiresAt: Date.now() + PENDING_TTL_MS });
    await answerCallback(cq.id, `✏️ ${word}`);
    if (cq.message) await sendTelegram(cq.message.chat.id, `What should ${word}'s Chinese say? Send just the word.`);
    return;
  }
```

- [ ] **Step 4: Sanity-check with Node's syntax checker (no test framework in this repo)**

```bash
node --check api/telegram.js
```

Expected: no output (exit code 0). This only checks JS syntax validity, not behavior —
behavior is verified in Task 2.

- [ ] **Step 5: Commit**

```bash
git add api/telegram.js
git commit -m "$(cat <<'EOF'
Add "Other" button to lesson messages for typing an unlisted Chinese gloss

Reuses the existing /def pending-state plumbing so tapping the button
parks the word, then the user's next message supplies the Chinese —
no more retyping /def word by hand for glosses the AI didn't suggest.
EOF
)"
```

---

### Task 2: Verify the flow (local mock + live round-trip)

**Files:**
- No files created or modified in this task except `Memory.md` (Step 5) — this task only
  verifies Task 1's changes via a one-off shell command and a live bot round-trip.

**Interfaces:**
- Consumes: `finishLesson(out, fallbackWord)` and the module's exported handler
  (`module.exports = async (req, res) => {...}` at the top of `api/telegram.js`) — both
  already defined by the existing file, untouched by Task 1 beyond the edits above.

- [ ] **Step 1: Sanity-check the `callback_data` encoding for realistic words**

`finishLesson()` isn't exported and its full path touches GitHub/Gist network calls, so
there's no practical way to unit-test it in isolation in this dependency-free codebase
(consistent with there being no test framework here at all). What *is* worth checking
mechanically, since it's a hard Telegram API rejection if wrong: that the `"e|<word>"`
encoding stays within the 64-byte `callback_data` cap for realistic multi-syllable Korean
words/phrases (e.g. ones containing a space, like `잘 되다`).

```bash
node -e '
const word = "잘 되다";
const data = `e|${word}`;
const bytes = Buffer.byteLength(data, "utf8");
console.log("callback_data:", data, "bytes:", bytes);
if (bytes > 64) { console.error("TOO LONG"); process.exit(1); }
console.log("OK");
'
```

- [ ] **Step 2: Confirm the output**

Expected: prints the `callback_data` string, a byte count under 64, and `OK`. This is a
narrow mechanical check, not a substitute for Step 4's real round-trip below — it only
rules out the one failure mode (`callback_data` too long) that Telegram would reject
silently-ish (a `400` on `answerCallbackQuery`/button send) rather than something visible
in normal use.

- [ ] **Step 3: Grep-diff the two touched functions against the plan**

```bash
grep -n "otherButton\|kind === \"e\"" api/telegram.js
```

Expected: both the `finishLesson()` button block and the new `handleCallback()` branch show
up, confirming Task 1's edits landed in both places (a common mistake is editing the button
row but forgetting the callback handler, or vice versa).

- [ ] **Step 4: Push and do a live Telegram round-trip**

```bash
git push
```

Wait for Vercel to redeploy (auto-deploy on push to `main`, per project CLAUDE.md), then in
the actual Telegram chat:
1. Send a lesson request for any word (e.g. `단어 뜻` or `/v 단어`).
2. Confirm the reply now shows the AI's Chinese-option buttons **plus** a second row with
   "✏️ Other".
3. Tap "✏️ Other". Confirm a new message arrives: `What should <word>'s Chinese say? Send
   just the word.`
4. Send a plain Chinese word as the next message. Confirm the bot replies confirming the
   swap (e.g. `<word> → <chinese> ✓ (in current batch)`), matching the existing
   `applyDefinition()` confirmation format.
5. Optionally re-check the original lesson message's buttons are still tappable (per the
   design's "don't clear buttons on Other tap" decision) — tap one of the AI-suggested
   options afterward and confirm it still applies normally.

- [ ] **Step 5: Update Memory.md's "Recently done" and "Next entry point" sections**

Per this project's CLAUDE.md session protocol, append a bullet to `Memory.md`'s "Recently
done" list noting the `/def` "Other" button (mirroring how the existing `/def` conversational
flow was documented in the current file), and clear the "Two independent threads" item #1 in
"Next entry point" if this verification round-trip succeeded (it referenced the same `/def`
flow). Then commit:

```bash
git add Memory.md
git commit -m "Update Memory.md: /def Other button added and round-tripped live"
```
