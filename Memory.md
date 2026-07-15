# Memory.md — where to pick up next time

> **Not** a dump of everything — just what the *next* session must know to continue.
> Update this at the END of a work session. (Rules → CLAUDE.md · Knowledge → Wiki.md ·
> Lessons → Learning.md)

_Last updated: 2026-07-15_

## Current status
Project is live and actively developed. Front end + Telegram bot + daily review push all
working and deployed on Vercel. Most recent work has been on the Telegram bot side.

## Recently done (from git, newest first)
- `/def` is now conversational: bare `/def` (e.g. tapped from Telegram's "/" suggestion
  menu, which sends immediately with no chance to type args) parks a pending state in the
  Gist (`pending.json`) and the next message supplies the missing word/Chinese. Tested
  locally against a mocked Gist/Telegram fetch (not yet verified against the live bot).
- Telegram typing indicator while Claude generates a reply.
- Added a daily Claude-call cap; switched daily push to Korea time (07:30 KST).
- Raised token caps on structured Claude calls; bounded `/related` context.
- `/read` feature: tap-to-check word buttons; hardened structured-output calls.
- Transient Claude API errors (529/429/5xx) now retry with backoff.

## Confirmed decisions (don't relitigate)
- No frameworks / no build step — stays plain HTML/JS + dependency-free serverless.
- Review-queue state lives in a **private Gist**, not the repo (avoids redeploy per tap).
- Model split is intentional: haiku = cheap tasks, sonnet = lessons.
- Cost caps (`DAILY_MESSAGE_CAP`, token limits) are on purpose — keep them.

## User preferences
- Sin Hong studies Korean; Chinese + English are his reference languages (trilingual CSV).
- Bot lessons should have nuance/wit (why sonnet is used there).
- The `k-vocab` skill is the front door for adding words; it batches to CSV in this repo.

## Open TODOs / ideas (unverified — confirm before acting)
- `api/sync.js` is a public endpoint (no auth); noted as low-stakes but could be locked
  down later with a CRON_SECRET-style key. Not urgent.
- (Add new items here as they come up.)

## Next entry point
`/def`'s new conversational flow (see Recently done) hasn't been round-tripped through the
real Telegram bot yet — worth a live test (tap `/def` from the suggestion menu, confirm the
follow-up message applies correctly) next time you're in the chat. Otherwise no task in
flight — skim recent `git log`, then ask what the goal is. If it's a bot change,
`api/telegram.js` is the hub; if it's the study UI, `index.html`.
