# CLAUDE.md — how to work in this repo

> This file defines **how** to work here, not what's been done. It's the rulebook Claude
> reads on every startup. Keep it short and stable. (Progress → Memory.md · Knowledge →
> Wiki.md · Lessons → Learning.md)

## ⭐ Session protocol (do this automatically)
**At the START of every session in this repo:**
1. Read `Memory.md` — where the last session left off and what's in flight.
2. Read `Wiki.md` — the project's architecture and terms (skim if already familiar).
3. Check `Learning.md` before changing `api/*` or `lib/*` — avoid known pitfalls.

**During work:** if you hit a bug, a surprise, or a counter-intuitive fact, append a
`Problem → Cause → Fix/Rule` entry to `Learning.md` right then.

**At the END of a session (before finishing or when the user wraps up):**
1. Update `Memory.md` — refresh "Current status", "Recently done", TODOs, and the
   "Next entry point"; bump the `_Last updated:_` date.
2. Update `Wiki.md` only if the *design/architecture* changed (not routine progress).

Keep updates terse. If nothing changed in a file, leave it. Don't ask permission to
read these files — just do it as step one.

## What this project is (one line)
Personal Korean/TOPIK vocab system: a static flashcard web app **plus** a Telegram bot
(Vercel serverless) that teaches words, tracks weak ones, and pushes a daily review.

## Behavior rules
- **No frameworks, no build step.** Plain HTML/CSS/JS on the front end; dependency-free
  Node serverless functions in `api/`. Do not introduce npm packages, bundlers, or a build
  pipeline without asking.
- **Every push to `main` auto-deploys to Vercel.** Treat `main` as production. Don't push
  half-finished work; branch if a change needs iteration.
- **Secrets live in Vercel env vars only** (see Wiki.md for the list). Never hardcode a
  token, API key, chat id, or Gist id in committed files.
- **The review queue lives in a private GitHub Gist, not the repo** — because a repo commit
  triggers a redeploy. Per-tap state must go through `lib/store.js`, never a repo write.
- **Claude API cost is capped on purpose** (`DAILY_MESSAGE_CAP`, token limits). Don't raise
  caps or swap models to save effort without flagging the cost trade-off.

## Code style
- Match the existing files: top-of-file comment block explaining *what it does* + env vars.
- Small, readable functions; no clever abstractions. This is a solo hobby codebase.
- Model choice is deliberate: `claude-haiku-4-5` for cheap tasks, `claude-sonnet-5` for
  lessons that need nuance. Preserve that split.

## Before you claim "done"
- If you touched `api/*` or `lib/*`, explain how it was tested (local invoke / manual curl /
  Telegram round-trip). Don't assert it works without evidence.
- If you added a session CSV, confirm `sessions.json` has a matching entry (app reads that).

## Prohibitions
- Don't delete or rewrite past session CSVs in `vocablist_csv/` — they're study history.
- Don't commit `.ingest.lock`, `*.json.bak`, or `.DS_Store` (already gitignored — keep it so).
- Don't reformat `sessions.json` / `readings.json` wholesale; the bot appends to them.
