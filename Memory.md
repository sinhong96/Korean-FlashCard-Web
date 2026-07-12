# Memory.md — where to pick up next time

> **Not** a dump of everything — just what the *next* session must know to continue.
> Update this at the END of a work session. (Rules → CLAUDE.md · Knowledge → Wiki.md ·
> Lessons → Learning.md)

_Last updated: 2026-07-12_

## Current status
Project is live and actively developed. Front end + Telegram bot + daily review push all
working and deployed on Vercel. Most recent work has been on the Telegram bot side.

## Recently done (from git, newest first)
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
No task in flight. When you start next: skim recent `git log`, then ask what the goal is.
If it's a bot change, `api/telegram.js` is the hub; if it's the study UI, `index.html`.
