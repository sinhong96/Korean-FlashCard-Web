# Learning.md — lessons, so we don't fall in the same hole twice

> **Memory tracks progress; Learning tracks lessons.** When something surprises you, breaks,
> or turns out counter-intuitive, write it here with the fix. Format each entry:
> **Problem → Cause → Fix/Rule.**

## Pitfalls already baked into this codebase
These are lessons the current code encodes — read them before "improving" things.

- **Writing per-tap state to the repo triggers a Vercel redeploy.**
  → Cause: every push to `main` auto-deploys. → Rule: high-frequency state (the review
  queue) goes to the **Gist** via `lib/store.js`, never a repo commit.

- **New CSV in `vocablist_csv/` doesn't show up in the app.**
  → Cause: the app reads `sessions.json`, not the folder. → Rule: always add a matching
  `sessions.json` row when adding a session (see Wiki.md).

- **Claude API can return transient 529/429/5xx.**
  → Fix already in place: retry with backoff. Don't remove it; extend the same pattern for
  any new Claude call.

- **Runaway Claude cost is a real risk on a public bot.**
  → Fix: `DAILY_MESSAGE_CAP = 60` + token caps + `ALLOWED_CHAT_ID`. Keep these; if you raise
  a cap, note the cost trade-off.

- **`api/sync.js` is intentionally public (no auth).**
  → Reason: the flashcard page is public and can't hold credentials. Worst case = junk words
  in the queue, bounded by `MAX_WORDS`. Don't "fix" it by leaking a token into the front end.

- **Timezone bugs on the daily push.**
  → Cause: mixing UTC and local time. → Rule: cron is UTC (22:30) but everything user-facing
  is `Asia/Seoul`. Keep the two straight when touching `api/daily.js`.

## New lessons (add below as you hit them)
<!-- Problem → Cause → Fix/Rule -->

- **Tapping a command from Telegram's "/" suggestion menu sends it immediately** — it
  doesn't just pre-fill the input box for you to keep typing.
  → Cause: Telegram client behavior, not something the bot controls. Any command that
  needs inline args (like the old `/def 단어 你的词`) breaks when invoked via tap.
  → Fix/Rule: for arg-taking commands, park a short-lived "pending" state per chat in the
  Gist (`pending.json`, via `lib/store.js`) when the bare command arrives, prompt for the
  missing piece, and treat the user's next non-slash message as the answer. See `/def` in
  `api/telegram.js` (`getPending`/`setPending`/`resolveDefPending`) for the pattern —
  reuse it for any future command that needs args.
