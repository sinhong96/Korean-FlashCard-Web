# Design: "Other" button for changing a flashcard's Chinese gloss

## Problem

After a lesson, the bot shows tap buttons for the 2-4 Chinese glosses the AI suggested
(`finishLesson()`, callback kind `"d"`), plus a text hint to type `/def word 你的词` for
anything else. If none of the suggested options is right, the user still has to type the
full `/def word chinese` command by hand — there's no tap-then-type path.

## Solution

Add one more inline button, "✏️ Other", on its own row below the suggested options, shown
on every lesson message (even when the AI only offered one option). Tapping it parks a
pending state for that specific word — reusing the existing `pending.json` mechanism that
already backs bare `/def` — and prompts the user to send just the Chinese as their next
message. That message is then applied via the existing `resolveDefPending` →
`applyDefinition` path. No new storage, no new TTL logic, no new apply logic — this wires
one new button into plumbing that already exists.

## Changes (`api/telegram.js` only)

### `finishLesson()`
- Always build an `otherButton`: `{ text: "✏️ Other", callback_data: "e|<word>" }`
  (byte-length-checked against Telegram's 64-byte `callback_data` cap, same guard style
  already used for the `"d"` buttons).
- `buttons` layout becomes: row 1 = up to 4 AI-suggested Chinese options (if any), row 2 =
  the "Other" button alone. Previously, buttons were omitted entirely when the AI gave
  ≤1 option; now the "Other" row still appears in that case.
- The `hint` text (`🀄 Flashcard 中文 = ... — tap to change`) is shown whenever `buttons`
  exists, i.e. now essentially always. Drop the `/def word 你的词` mention from the hint
  since the button covers it — the `/def` command itself is untouched and still works for
  anyone who prefers typing it directly.

### `handleCallback()`
New `kind === "e"` branch, modeled directly on the existing bare-`/def` branch
(around line 111-117):
```js
if (kind === "e") {
  await setPending(cq.message.chat.id, { command: "def", word, expiresAt: Date.now() + PENDING_TTL_MS });
  await answerCallback(cq.id, `✏️ ${word}`);
  if (cq.message) await sendTelegram(cq.message.chat.id, `What should ${word}'s Chinese say? Send just the word.`);
  return;
}
```
No message editing — the original lesson message's buttons stay tappable afterward, in
case the user changes their mind and picks a suggested option instead. Buttons are only
ever cleared once a definition is actually applied via the `"d"` callback path (existing
behavior, unchanged).

## Data flow

```
Lesson sent (buttons: [chinese options...], [Other])
        │
        ▼ tap "Other"
setPending(chatId, {command:"def", word, expiresAt})   [pending.json in Gist]
        │
        ▼ toast + new chat message: "What should X's Chinese say? Send just the word."
        │
        ▼ user's next plain-text message
resolveDefPending()  →  applyDefinition(word, chinese)   [existing, unchanged]
```

## Error handling

Identical to the existing bare-`/def` pending flow: 5-minute expiry (`PENDING_TTL_MS`),
Gist-backed (`pending.json`), already-tested logic. No new failure modes.

## Out of scope

- No equivalent button on `/weak` or `/batch` listings — this only covers the
  right-after-a-lesson message, per explicit scope decision.
- No change to `/def`'s existing typed syntax — it keeps working as-is.
