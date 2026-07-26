# Memory.md — where to pick up next time

> **Not** a dump of everything — just what the *next* session must know to continue.
> Update this at the END of a work session. (Rules → CLAUDE.md · Knowledge → Wiki.md ·
> Lessons → Learning.md)

_Last updated: 2026-07-26_

## Current status
Project is live and actively developed. Front end + Telegram bot + daily review push all
working and deployed on Vercel. Most recent work: added a tap-to-type "Other" button to
lesson messages, and in the process discovered + fixed a long-standing gap where
`GIST_ID`/Gist auth had never actually been finished — see below.

## Recently done (from git, newest first)
- **`/def` "Other" button + the `GIST_TOKEN` fix (2026-07-26)**: lesson messages now show
  a 5th button, "✏️ Other", alongside the AI's suggested Chinese-gloss buttons. Tapping it
  parks the same pending state bare `/def` uses, then your next message supplies the
  Chinese directly — no more retyping `/def word 你的词` by hand. Building this surfaced a
  bigger pre-existing bug: `GIST_ID` had never actually been set in Vercel (`/batch` said
  so directly), so every Gist-backed feature — batch tracking, `/def`'s pending state, and
  probably `/weak`/the review queue — was silently degraded the whole time (every lesson
  auto-committed as its own 1-word session instead of batching to 15). Created a private
  Gist and set `GIST_ID`, then hit a second wall: `GITHUB_TOKEN` is a fine-grained PAT,
  and fine-grained PATs **cannot access the Gist API at all** (a hard GitHub platform
  limit, not a missing scope). Fix: `lib/store.js` now authenticates Gist calls with a
  separate `GIST_TOKEN` (classic PAT, `gist` scope only); `GITHUB_TOKEN` keeps doing repo
  commits as before. Verified live: `/batch` now shows real batch status, and tapping
  "Other" → typing a Chinese word → bot confirms the swap, all round-tripped through the
  real bot. Design/plan docs in `docs/superpowers/specs/` and `docs/superpowers/plans/`.
  Full env var details in Wiki.md; the classic-vs-fine-grained-PAT gotcha is in Learning.md.
- **Natural TTS via voicebox** (all sessions): `tts_gen.py` (new, stdlib-only) reads a
  session CSV, calls a locally-running [voicebox](https://github.com/jamiepine/voicebox)
  server to synthesize Korean word + Chinese definition audio, writes WAVs to `audio/` and
  records them in `audio-manifest.json`. `index.html`'s `playTTS()` plays the matching file
  when one exists, falls back to the original `speechSynthesis` otherwise. Batches
  Korean-then-Chinese (not interleaved) since voicebox reloads its model on every profile
  switch. Skips rows where the wrong language ended up in `Word`/`Definition` (a bot data
  bug — 2 rows in `20260713_01_LIST_Bot.csv`) instead of mis-generating audio. Ran once
  against all 29 sessions: 817 clips, 74MB, committed. Design/plan docs in
  `docs/superpowers/specs/` and `docs/superpowers/plans/`. Full details, including the
  two voice profile IDs needed to run it again, are in Wiki.md.
  Only the flashcard word/definition TTS is covered — `speakReading()` (bot-generated
  reading passages) still uses browser TTS; that'd need a cloud TTS API instead of
  voicebox since `api/telegram.js` can't reach a local desktop app. Out of scope for now.
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
- TTS audio is **pre-generated and committed as static files**, not synthesized live from
  the deployed site. Rejected calling voicebox's local server at request time: the site is
  HTTPS-on-Vercel and voicebox only runs on Sin Hong's Mac, so it wouldn't work from a
  phone or any other device, and HTTPS→localhost calls hit browser mixed-content/Private
  Network Access restrictions anyway. See the design doc for the full comparison.

## User preferences
- Sin Hong studies Korean; Chinese + English are his reference languages (trilingual CSV).
- Bot lessons should have nuance/wit (why sonnet is used there).
- The `k-vocab` skill is the front door for adding words; it batches to CSV in this repo.

## Open TODOs / ideas (unverified — confirm before acting)
- `api/sync.js` is a public endpoint (no auth); noted as low-stakes but could be locked
  down later with a CRON_SECRET-style key. Not urgent.
- (Add new items here as they come up.)

## Next entry point
Two independent threads, pick whichever the user raises:
1. Now that `GIST_ID`/`GIST_TOKEN` actually work, worth spot-checking the OTHER Gist-backed
   features that were likely silently degraded the same way for a while: `/weak` (weak
   words list) and the daily review push (`api/daily.js`, `api/sync.js`'s Forgot/Got-it
   taps). Not yet verified live — unlike `/def`'s pending flow and batch tracking, which
   *are* now confirmed working.
2. TTS: every *new* session going forward needs one extra manual step before it gets
   natural audio — run `tts_gen.py` with voicebox open locally (see Wiki.md for the exact
   command and profile IDs), then push. If a new session shows up without audio, that step
   was probably skipped, not a bug.

Otherwise no task in flight — skim recent `git log`, then ask what the goal is. If it's a
bot change, `api/telegram.js` is the hub; if it's the study UI, `index.html`.
