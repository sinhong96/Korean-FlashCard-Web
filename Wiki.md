# Wiki.md — project knowledge base

> **What's always true** about this project: architecture, APIs, terms, structure. The stuff
> you'd otherwise re-explain in every chat. Update it when the *design* changes — not when you
> make day-to-day progress (that's Memory.md).

## Project background
"Hong's Korean Vocab Flashcard" — a personal tool for studying TOPIK vocabulary. Words are
generated from Gemini/Claude, drilled with SM-2 spaced repetition in the browser, and
reinforced by a Telegram bot with a daily morning review push.

- **Local folder:** `Topik flash card`
- **GitHub repo:** `sinhong96/Korean-FlashCard-Web` (branch `main`)
- **Hosting:** Vercel (auto-deploy on every push to `main`)

## Architecture at a glance
```
Browser (index.html)  ──Forgot/Got-it taps──►  api/sync.js  ──►  GitHub Gist (weak_words.json)
        ▲                                                              │
        │ study sessions (CSV)                                         │ daily 07:30 KST (cron)
        │                                                              ▼
  vocablist_csv/*.csv  ◄──bot commits new sessions──  api/telegram.js ◄─ api/daily.js pushes review
        │                                                    ▲
   sessions.json (index the app reads)                Telegram  ◄── you chat "단어 뜻", /quiz, etc.
```

## Components
| Path | Role |
|------|------|
| `index.html` | The whole front end — session picker, flashcard flip, SM-2 SRS, TTS, backup/restore. Plain HTML/CSS/JS, no build. |
| `sessions.json` | Index of study sessions the app lists in the sidebar. **App only sees a CSV if it's listed here.** |
| `vocablist_csv/*.csv` | The actual word lists. Header: `Word,Definition,Sentence`. |
| `readings.json` | Stored reading passages (the bot's `/read` feature). |
| `api/telegram.js` | Telegram webhook. Lessons, `/batch`, `/csv`, quiz, recall check, `add:`. Auto-commits a session CSV when the lesson batch hits 15/15. |
| `api/sync.js` | Public endpoint. Browser posts `forgot`/`remove`; updates the Gist review queue. |
| `api/daily.js` | Cron-triggered morning push (up to 10 words, never-sent first). Manual GET works for testing. |
| `lib/store.js` | Shared Gist read/write (`weak_words.json`, `vocab_batch.json`, `pending.json`, …). All per-tap state goes here, never the repo. |
| `ingest.py` | Local pipeline for ingesting word data (see file for details). |
| `graphify-out/` | Knowledge-graph output of the project (from the graphify skill). |

## CSV format
```
Word,Definition,Sentence
```
| Column | Meaning | Example |
|--------|---------|---------|
| Word | Korean word/phrase | `잘 되다` |
| Definition | Chinese meaning, optional Hanja in `()`, optional English after `/ [EN]` | `顺利 (順利) / [EN] To go well` |
| Sentence | Korean example sentence | `사랑으로 보면 잘 됩니다.` |

## Adding a session (permanent, shows in sidebar)
1. Save CSV into `vocablist_csv/YYYYMMDD_NN_LIST.csv`.
2. Append one row to `sessions.json`:
   `{ "file": "vocablist_csv/…​.csv", "date": "YYYY-MM-DD", "session": 1, "tag": null, "label": "Mon DD", "count": 15 }`
3. `git push` → Vercel redeploys.

## Environment variables (set in Vercel, never committed)
| Var | Used by | Purpose |
|-----|---------|---------|
| `TELEGRAM_BOT_TOKEN` | telegram, daily | Bot auth (from @BotFather) |
| `TELEGRAM_SECRET_TOKEN` | telegram | Verifies webhook calls |
| `ANTHROPIC_API_KEY` | telegram | Claude API for lessons/quiz |
| `GITHUB_TOKEN` | telegram, store | PAT — repo Contents R/W (commits) + Gists |
| `GIST_ID` | sync, daily, store | Private Gist holding the review queue |
| `ALLOWED_CHAT_ID` | telegram, daily | Restricts bot to your chat |
| `CRON_SECRET` | daily | Protects the cron endpoint |

## Key models & caps (deliberate)
- `claude-haiku-4-5` — cheap tasks (quiz, recall). `claude-sonnet-5` — lessons (need nuance/wit).
- `BATCH_SIZE = 15` — lesson batch auto-commits a session CSV at 15 words.
- `DAILY_MESSAGE_CAP = 60` — backstop against runaway Claude cost, resets midnight KST.
- Timezone is **Asia/Seoul**; daily push fires 22:30 UTC = 07:30 KST.

## Glossary
- **Review queue / weak words** — words you marked *Forgot*; stored in the Gist, drip-fed by the daily push.
- **Batch** — an in-progress set of ≤15 lesson words in the Gist; flushes to a CSV session at 15 or via `/csv`.
- **SM-2** — the spaced-repetition scheduling algorithm the front end uses.
- **Pending state** — a short-lived (5 min) per-chat "waiting for your next message" marker in `pending.json`
  (the Gist), used so a bare `/def` can ask a follow-up question instead of erroring. See Learning.md.
