# Natural TTS via voicebox (pre-generated audio) — Design

_Date: 2026-07-18_

## Problem

The app's TTS (`playTTS()` in `index.html`, ~line 1392) uses the browser's native
`speechSynthesis` API. Voice quality is robotic and depends entirely on whichever
OS voices happen to be installed — no control over it, and Korean/Chinese voices
are especially awkward.

[voicebox](https://github.com/jamiepine/voicebox) is a free, local, MIT-licensed
voice studio (Tauri desktop app + Python/FastAPI backend) offering multiple TTS
engines. Two of its bundled engines — **Qwen3-TTS** and **Chatterbox
Multilingual** — support both Korean and Chinese. It exposes a local REST API
(`http://127.0.0.1:17493`) for generation; no API key required, all processing
local.

Voicebox is not embeddable as a JS library — it's a separate local app. A
Vercel-deployed HTTPS static site cannot reliably call `http://localhost:17493`
at runtime (mixed-content / Private Network Access restrictions), and even if it
could, that only works when studying on the same Mac voicebox runs on — not from
a phone. So live server calls (Option B, rejected) don't fit this project's
static-site-on-Vercel, multi-device usage.

## Approach: pre-generate audio files (Option A)

Generate natural-voice MP3s **locally, offline, once per session**, commit them
as static assets, and have the app play the file instead of calling
`speechSynthesis` when one exists.

### Scope

Covers only the flashcard word/definition TTS (`playTTS()`), not the
Telegram-bot-generated reading passages (`speakReading()`, index.html:1374).
Readings are created dynamically by a Vercel serverless function
(`api/telegram.js`), which cannot invoke a local desktop app — that's a
separate problem for a future design if it comes up.

Only applies to **permanent sessions** (CSV saved to `vocablist_csv/` +
`sessions.json` entry). The "Quick way — Paste from Gemini" ad-hoc flow has no
session file to key audio off of, so it keeps using browser TTS as a fallback.

### Components

**`tts_gen.py`** (new, sibling to `ingest.py`)
- Input: path to a session CSV (`Word,Definition,Sentence`).
- For each row, extracts the Korean word (`Word` column) and the Chinese
  definition text (`Definition` column, stripped of Hanja/EN suffix — reuse
  whatever parsing `ingest.py` or the frontend already does for this).
- For each *unique* string not already in `audio-manifest.json`, calls
  `POST http://127.0.0.1:17493/generate` (voicebox must already be running
  locally) and writes the resulting MP3 to `audio/ko/<slug>.mp3` or
  `audio/zh/<slug>.mp3` (slug = stable hash or normalized-text slug of the
  source string).
- Updates `audio-manifest.json`: `{ "<normalized text>": "audio/ko/<slug>.mp3", ... }`.
- Fails loudly (non-zero exit, clear error message) if voicebox isn't reachable
  — no silent skip, so a session never gets committed with partially-missing
  audio without the author noticing.

**`audio-manifest.json`** (new, committed to repo)
- Flat map of normalized source text → relative audio file path.
- Shared across all sessions; deduplicates repeated vocab.

**`index.html` — `playTTS(side)`** (existing, ~line 1392)
- Before building a `SpeechSynthesisUtterance`, look up the card's text (front
  = Chinese definition, back = Korean word) in `audio-manifest.json` (fetched
  once at app load, same pattern as `sessions.json`/`readings.json`).
- If found: play via a plain `<audio>` element.
- If not found, or the referenced file 404s: fall back to the existing
  `speechSynthesis` path unchanged.

### Workflow

Extends the existing "Permanent way" from `README.md`:

1. Save the CSV to `vocablist_csv/`, add the `sessions.json` entry (unchanged).
2. Start voicebox locally (`just dev` or the prebuilt macOS app).
3. Run `python tts_gen.py vocablist_csv/<file>.csv`.
4. `git push` — CSV, `sessions.json` entry, new audio files, and updated
   `audio-manifest.json` all commit together.

### Testing plan

Manual (matches this repo's existing "explain how it was tested" rule for
`api/*`/`lib/*` — this touches root-level files instead, same bar applies):

1. Run `tts_gen.py` against one existing session CSV; confirm MP3s appear
   under `audio/` and `audio-manifest.json` has matching entries.
2. Serve the app locally, open a card from that session, confirm the Network
   tab shows the MP3 being fetched/played (not `speechSynthesis` firing).
3. Confirm a word with no manifest entry still falls back to
   `speechSynthesis` correctly (no error, no silent failure).
4. Confirm re-running `tts_gen.py` on a session with overlapping vocab does
   not regenerate already-manifested audio.

## Out of scope (explicitly deferred)

- Reading passages (`speakReading()`) — bot-generated, needs a cloud TTS API
  or different architecture, not voicebox.
- The "Quick way" paste flow getting natural audio.
- Choosing between Qwen3-TTS and Chatterbox Multilingual as the default engine
  — left as a script parameter/flag, decided by ear during setup rather than
  up front.
