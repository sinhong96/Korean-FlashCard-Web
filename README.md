# 🐟 Hong's Korean Vocab Flashcard

A personal Korean vocabulary flashcard web app with spaced repetition, built for studying TOPIK vocabulary generated from Gemini AI sessions.

## Features

- **Session picker** — choose from dated study sessions in the sidebar
- **Paste from Gemini** — paste CSV output directly from Gemini without downloading a file
- **Flashcard flip** — click the card to reveal the Korean word, Hanja, and English meaning
- **Spaced repetition (SRS)** — rate each card as Forgot / Good / Mastered; the app tracks your progress using the SM-2 algorithm
- **Manual rating** — click the colored dot next to any card in the sidebar to hand-set its rating
- **Auto-saved** — progress is automatically saved in your browser (no account needed)
- **Backup & Restore** — download your ratings as a JSON file to transfer between devices
- **TTS** — click the speaker button to hear the Chinese definition or Korean word read aloud
- **Retry weak cards** — after finishing a session, re-drill only the cards you forgot or found difficult

## CSV Format

Sessions are stored in `vocablist_csv/` as `.csv` files with the following header:

```
Word,Definition,Sentence
```

| Column | Description | Example |
|---|---|---|
| Word | Korean word or phrase | `잘 되다` |
| Definition | Chinese meaning, optional Hanja in `()`, optional English after `/ [EN]` | `顺利 (順利) / [EN] To go well` |
| Sentence | Korean example sentence | `사랑으로 보면 잘 됩니다.` |

## Adding New Sessions

**Quick way (no file needed):**
1. Get CSV output from Gemini
2. Click **✦ Paste from Gemini** in the app header
3. Paste and load — ready to study

**Permanent way (shows in session list):**
1. Save the CSV file into `vocablist_csv/`
2. Add one entry to `sessions.json`:
   ```json
   { "file": "vocablist_csv/YYYYMMDD_01_LIST.csv", "date": "YYYY-MM-DD", "session": 1, "tag": null, "label": "Mon DD", "count": 15 }
   ```
3. `git push` — Vercel auto-redeploys

## Tech Stack

Plain HTML, CSS, and JavaScript — no frameworks, no build step. Deployable as a static site.

## Deployment

Hosted on [Vercel](https://vercel.com) via GitHub integration. Every push to `main` triggers an automatic redeploy.

## How this repo's memory works

This repo carries its own context for AI coding sessions (Claude Code) in four Markdown files:

| File | Holds | Question it answers |
|------|-------|--------------------|
| `CLAUDE.md` | Rules & working style | *How* do we work here? |
| `Wiki.md` | Architecture, APIs, terms | *What* is always true? |
| `Memory.md` | Current progress & next step | *Where* did we leave off? |
| `Learning.md` | Bugs & pitfalls, with fixes | *What* went wrong before? |

`CLAUDE.md` loads automatically and tells the assistant to read the others at the start of a
session and update `Memory.md` / `Learning.md` at the end — so context survives across chats
instead of being re-explained each time.
