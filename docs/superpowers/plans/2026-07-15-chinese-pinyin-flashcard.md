# Chinese Pinyin Flashcard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up a new, separate flashcard project — `Chinese-Pinyin-FlashCard-Web` — that drills pinyin recall for Hanzi/words Sin Hong already understands but isn't sure how to pronounce, reusing the Korean flashcard app's SM-2 + Telegram-bot architecture.

**Architecture:** Static `index.html` (no build step) shows a Hanzi, takes a typed pinyin answer, grades it via a pure JS matcher (perfect / right-syllable-wrong-tone / wrong), and feeds that rating into the same SM-2 scheduler the Korean app uses. A Telegram bot (Vercel serverless, `claude-haiku-4-5`) accepts a Hanzi/word, generates every distinct reading as a structured lesson, batches rows in a private Gist, and auto-commits a session CSV at 15 rows — mirroring the Korean bot's batching flow. A daily cron push and a `/api/sync` endpoint reuse the Korean repo's Gist-store pattern almost verbatim.

**Tech Stack:** Plain HTML/CSS/JS (no frameworks), dependency-free Node serverless functions (Vercel), GitHub REST API (repo commits + Gists), Anthropic Messages API (`claude-haiku-4-5`), browser `speechSynthesis` (zh voice).

## Global Constraints

- No frameworks, no build step, no npm packages — plain HTML/CSS/JS and dependency-free `api/*.js`. (Design spec, "Non-goals" / repo layout.)
- Fully separate repo, Vercel project, Telegram bot token, and Gist from the Korean project — zero shared infrastructure. (Design spec, "Repo & deployment.")
- CSV schema is exactly `Hanzi,Pinyin,Meaning,Sentence` — `Pinyin` in tone marks, `Meaning` in Chinese. (Design spec, "CSV schema.")
- Bot model is `claude-haiku-4-5` — structured lookup, not a nuanced lesson. (Design spec, "Telegram bot & Claude prompt.")
- Grading is 3-tier (5 = perfect, 3 = right syllable/wrong tone, 1 = wrong), feeding the Korean app's unmodified SM-2 interval math. (Design spec, "Card & grading flow.")
- Reference doc: `docs/superpowers/specs/2026-07-15-chinese-pinyin-flashcard-design.md` in this repo.

---

### Task 1: New repo scaffold + external service setup

This task has no automated test cycle — it's one-time external setup (GitHub, Vercel, Telegram, a Gist) plus a placeholder deploy you verify by hand, matching how this project's own `CLAUDE.md` expects `api/*` work to be validated ("local invoke / manual curl / Telegram round-trip").

**Files:**
- Create (new repo, path of your choosing, e.g. `~/Claude/Projects/Chinese-Pinyin-FlashCard-Web/`):
  - `index.html` (placeholder)
  - `README.md`
  - `.gitignore`

**Interfaces:**
- Produces: a deployed Vercel URL, and these env vars available to every later task's `api/*` function — `TELEGRAM_BOT_TOKEN`, `TELEGRAM_SECRET_TOKEN`, `ANTHROPIC_API_KEY`, `GITHUB_TOKEN`, `GIST_ID`, `ALLOWED_CHAT_ID`, `CRON_SECRET`.

- [ ] **Step 1: Create the GitHub repo**

Go to github.com → New repository → name it `Chinese-Pinyin-FlashCard-Web` → private or public, your call → do **not** initialize with a README (you'll push one).

- [ ] **Step 2: Scaffold locally and push**

```bash
mkdir -p ~/Claude/Projects/Chinese-Pinyin-FlashCard-Web
cd ~/Claude/Projects/Chinese-Pinyin-FlashCard-Web
git init
mkdir -p api lib vocablist_csv
```

`.gitignore`:
```
.DS_Store
*.json.bak
.ingest.lock
```

`README.md`:
```markdown
# Chinese Pinyin Flashcard

Pinyin-recall flashcards for Hanzi/words you already understand but aren't
sure how to pronounce. Sibling project to the Korean TOPIK flashcard app —
same SM-2 + Telegram-bot architecture, fully separate deploy.

See `docs/superpowers/specs/2026-07-15-chinese-pinyin-flashcard-design.md`
in the Korean-FlashCard-Web repo for the original design rationale.

## Env vars (set in Vercel, never committed)
| Var | Used by | Purpose |
|-----|---------|---------|
| `TELEGRAM_BOT_TOKEN` | telegram, daily | Bot auth (from @BotFather) |
| `TELEGRAM_SECRET_TOKEN` | telegram | Verifies webhook calls |
| `ANTHROPIC_API_KEY` | telegram | Claude API for lessons |
| `GITHUB_TOKEN` | telegram, store | PAT — repo Contents R/W + Gists |
| `GIST_ID` | sync, daily, store, telegram | Private Gist holding batch/review state |
| `ALLOWED_CHAT_ID` | telegram, daily | Restricts bot to your chat |
| `CRON_SECRET` | daily | Protects the cron endpoint |
```

`index.html` (placeholder, replaced in Task 7):
```html
<!doctype html>
<html><body><h1>Chinese Pinyin Flashcard — under construction</h1></body></html>
```

```bash
git add -A
git commit -m "Scaffold Chinese Pinyin Flashcard repo"
git remote add origin https://github.com/<your-username>/Chinese-Pinyin-FlashCard-Web.git
git push -u origin main
```

- [ ] **Step 3: Create the Vercel project**

Go to vercel.com → Add New → Project → import `Chinese-Pinyin-FlashCard-Web` → deploy with defaults (static site, no build command needed since there's no framework).

- [ ] **Step 4: Create the Telegram bot**

Message @BotFather on Telegram → `/newbot` → follow prompts → save the token it gives you.

- [ ] **Step 5: Create the private Gist**

Go to gist.github.com → New secret gist → filename `weak_words.json`, content `{}` → Create secret gist → copy the Gist ID from its URL (`gist.github.com/<user>/<GIST_ID>`).

- [ ] **Step 6: Create a GitHub PAT**

Go to github.com/settings/personal-access-tokens/new (fine-grained) → repository access limited to `Chinese-Pinyin-FlashCard-Web` → permissions: Contents Read/Write. Separately, this token also needs Gist read/write — fine-grained PATs don't cover Gists, so either use a **classic** PAT with `gist` + `repo` scopes, or create two tokens and use the classic one for `GITHUB_TOKEN`. (This mirrors whatever choice the Korean repo made — check its Vercel env vars if unsure which token type it uses.)

- [ ] **Step 7: Set all env vars in Vercel**

Vercel project → Settings → Environment Variables → add all 7 vars from the README table above (`TELEGRAM_SECRET_TOKEN` and `CRON_SECRET` can be any random strings you generate, e.g. `openssl rand -hex 20`). Redeploy after saving.

- [ ] **Step 8: Verify the placeholder deploy**

```bash
curl -s https://<your-vercel-url>/ | grep "under construction"
```
Expected: the placeholder `<h1>` text comes back.

- [ ] **Step 9: Commit**

(Already committed/pushed in Step 2 — nothing further here. Confirm with `git log --oneline -1` and `git status` showing a clean tree.)

---

### Task 2: Pinyin normalization & matching (`lib/pinyin.js`)

This is the one genuinely new piece of logic in the whole project (everything else is an adapted copy). It's pure, dependency-free JS with no DOM — write it TDD, test it directly with `node`.

**Files:**
- Create: `lib/pinyin.js`
- Test: `test/pinyin.test.js`

**Interfaces:**
- Produces: `matchPinyin(input, answer) -> 1 | 3 | 5` and `analyzePinyin(str) -> { toneless: string, tones: number[] }`, both attached to `window` in the browser and exported via `module.exports` in Node (no bundler — same file loads both ways).
- Consumed by: Task 7 (`index.html`, via `<script src="lib/pinyin.js">`) and this task's own test file (via `require`).

- [ ] **Step 1: Write the failing test**

`test/pinyin.test.js`:
```javascript
const assert = require("assert");
const { analyzePinyin, matchPinyin } = require("../lib/pinyin.js");

// analyzePinyin: tone-mark and tone-number inputs normalize to the same shape
assert.deepStrictEqual(analyzePinyin("xíng"), { toneless: "xing", tones: [2] });
assert.deepStrictEqual(analyzePinyin("xing2"), { toneless: "xing", tones: [2] });
assert.deepStrictEqual(analyzePinyin("yínháng"), { toneless: "yinhang", tones: [2, 2] });
assert.deepStrictEqual(analyzePinyin("yin2hang2"), { toneless: "yinhang", tones: [2, 2] });
assert.deepStrictEqual(analyzePinyin("lǜ"), { toneless: "lv", tones: [4] });
assert.deepStrictEqual(analyzePinyin("nǚ"), { toneless: "nv", tones: [3] });
assert.deepStrictEqual(analyzePinyin("de"), { toneless: "de", tones: [] }); // neutral tone, no digit/mark

// matchPinyin: 5 = perfect, 3 = right syllable(s) wrong tone(s), 1 = wrong
assert.strictEqual(matchPinyin("xíng", "xíng"), 5);
assert.strictEqual(matchPinyin("xing2", "xíng"), 5); // tone-number input accepted
assert.strictEqual(matchPinyin("xing4", "xíng"), 3); // right syllable, wrong tone
assert.strictEqual(matchPinyin("xin", "xíng"), 1); // wrong syllable
assert.strictEqual(matchPinyin("yínháng", "yínháng"), 5);
assert.strictEqual(matchPinyin("yīnháng", "yínháng"), 3); // one syllable's tone wrong
assert.strictEqual(matchPinyin("de", "de"), 5); // both neutral, no tones to compare
assert.strictEqual(matchPinyin("nǚ", "nǚ"), 5); // ü/v handling round-trips

console.log("All pinyin.js tests passed.");
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node test/pinyin.test.js`
Expected: `Error: Cannot find module '../lib/pinyin.js'`

- [ ] **Step 3: Write the implementation**

`lib/pinyin.js`:
```javascript
// Pinyin normalization + tone-aware matching. No dependencies, no build step —
// loaded both as a Node module (bot/tests, via require) and as a plain
// <script> tag in the browser (functions attach to window). Same file, same
// logic, so the front end and any future tooling can never drift apart.
//
// The core idea: scan the string once, left to right. A tone-marked vowel
// contributes its plain vowel to `toneless` and its tone number (1-4) to
// `tones`; a trailing digit (tone-number input style, e.g. "xing2")
// contributes only to `tones`, nothing to `toneless`. Neutral-tone syllables
// (no mark, no digit — e.g. "de") contribute nothing to `tones` at all. This
// means tone-mark and tone-number input normalize to the identical shape
// without needing a real pinyin syllable dictionary.

const TONE_CHARS = { a: "āáǎà", e: "ēéěè", i: "īíǐì", o: "ōóǒò", u: "ūúǔù", v: "ǖǘǚǜ" };

function analyzePinyin(str) {
  const s = String(str || "").trim().toLowerCase().replace(/ü/g, "v").replace(/u:/g, "v");
  let toneless = "";
  const tones = [];
  for (const ch of s) {
    if (/[1-5]/.test(ch)) {
      tones.push(Number(ch));
      continue;
    }
    let matched = false;
    for (const base in TONE_CHARS) {
      const idx = TONE_CHARS[base].indexOf(ch);
      if (idx !== -1) {
        toneless += base;
        tones.push(idx + 1);
        matched = true;
        break;
      }
    }
    if (!matched && /[a-z]/.test(ch)) toneless += ch;
  }
  return { toneless, tones };
}

function matchPinyin(input, answer) {
  const a = analyzePinyin(input);
  const b = analyzePinyin(answer);
  if (a.toneless !== b.toneless) return 1;
  const toneMatch = a.tones.length === b.tones.length && a.tones.every((t, i) => t === b.tones[i]);
  return toneMatch ? 5 : 3;
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { analyzePinyin, matchPinyin };
}
if (typeof window !== "undefined") {
  window.analyzePinyin = analyzePinyin;
  window.matchPinyin = matchPinyin;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node test/pinyin.test.js`
Expected: `All pinyin.js tests passed.`

- [ ] **Step 5: Commit**

```bash
git add lib/pinyin.js test/pinyin.test.js
git commit -m "Add tone-aware pinyin normalization and matching"
```

---

### Task 3: Gist-backed store (`lib/store.js`)

Near-verbatim copy of the Korean repo's `lib/store.js` — the Gist read/write pattern is generic (keyed by filename within one Gist), nothing here is Chinese-specific.

**Files:**
- Create: `lib/store.js`

**Interfaces:**
- Produces: `readGistFile(file) -> Promise<object>`, `writeGistFile(file, obj) -> Promise<void>`, `readGist()` / `writeGist(obj)` (aliases for the `weak_words.json` file), `ghHeaders(extra)`.
- Consumed by: Task 4 (`api/sync.js`), Task 5 (`api/daily.js`), Task 6 (`api/telegram.js`).
- Requires env: `GIST_ID`, `GITHUB_TOKEN`.

- [ ] **Step 1: Write the file**

`lib/store.js`:
```javascript
// Shared review-queue/batch store, kept in a private GitHub Gist so writes
// never touch the repo (a repo commit would trigger a Vercel redeploy on
// every tap). Same pattern as the Korean flashcard project's lib/store.js.
//
// Data model — a map keyed by "<hanzi>|<pinyin>" (composite key, since one
// Hanzi can have multiple readings/rows):
//   { "<hanzi>|<pinyin>": { meaning, sentence, count, forgotAt, lastSent } }
//   - count:    how many times it's been marked "still learning"
//   - forgotAt: ISO timestamp of the most recent "still learning"
//   - lastSent: ISO timestamp of the last daily push (null = never sent)
//
// Requires env: GIST_ID, and GITHUB_TOKEN with Gist read/write.

const GIST_FILE = "weak_words.json";

function ghHeaders(extra = {}) {
  const h = { "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "cn-pinyin-bot", ...extra };
  if (process.env.GITHUB_TOKEN) h.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  return h;
}

async function readGistFile(file) {
  const r = await fetch(`https://api.github.com/gists/${process.env.GIST_ID}`, { headers: ghHeaders() });
  if (!r.ok) throw new Error(`Gist read: ${r.status}`);
  const data = await r.json();
  const f = data.files && data.files[file];
  if (!f || !f.content) return {};
  try {
    return JSON.parse(f.content);
  } catch {
    return {};
  }
}

async function writeGistFile(file, obj) {
  const r = await fetch(`https://api.github.com/gists/${process.env.GIST_ID}`, {
    method: "PATCH",
    headers: ghHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ files: { [file]: { content: JSON.stringify(obj, null, 2) } } }),
  });
  if (!r.ok) throw new Error(`Gist write: ${r.status}`);
}

const readGist = () => readGistFile(GIST_FILE);
const writeGist = (obj) => writeGistFile(GIST_FILE, obj);

module.exports = { ghHeaders, readGist, writeGist, readGistFile, writeGistFile };
```

- [ ] **Step 2: Verify it loads**

Run: `node -e "require('./lib/store.js'); console.log('lib/store.js loads OK')"`
Expected: `lib/store.js loads OK`

- [ ] **Step 3: Commit**

```bash
git add lib/store.js
git commit -m "Add Gist-backed store (adapted from Korean flashcard project)"
```

---

### Task 4: `api/sync.js` — forgot/remove endpoint

Adapted from the Korean repo's `api/sync.js`: same public POST endpoint, same `forgot`/`remove` actions, field names changed to match the Chinese CSV schema and the composite `hanzi|pinyin` key.

**Files:**
- Create: `api/sync.js`

**Interfaces:**
- Consumes: `readGist`, `writeGist` from Task 3's `lib/store.js`.
- Produces: `POST /api/sync` accepting `{ action: "forgot"|"remove", hanzi, pinyin, meaning?, sentence? }`.
- Consumed by: Task 7's `index.html` (fires on every grading submission).

- [ ] **Step 1: Write the file**

`api/sync.js`:
```javascript
// Receives forgot/remove events from the flashcard app and updates the
// review queue in the Gist. Called by the browser after each graded card.
//
// POST body: { action: "forgot" | "remove", hanzi, pinyin, meaning?, sentence? }
//
// Public endpoint (the flashcard page is public, so it can't hold
// credentials). Worst case someone finds the URL and adds junk to the review
// list — low stakes, bounded by MAX_WORDS.

const { readGist, writeGist } = require("../lib/store");
const MAX_WORDS = 2000;

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ ok: false });
  if (!process.env.GIST_ID) return res.status(200).json({ ok: false, reason: "no GIST_ID" });

  try {
    const { action, hanzi, pinyin, meaning = "", sentence = "" } = req.body || {};
    if (!hanzi || !pinyin || !action) return res.status(400).json({ ok: false });
    const key = `${hanzi}|${pinyin}`;

    const state = await readGist();
    if (action === "forgot") {
      if (Object.keys(state).length >= MAX_WORDS && !state[key]) {
        return res.status(200).json({ ok: false, reason: "queue full" });
      }
      const e = state[key] || { count: 0, lastSent: null };
      e.meaning = meaning;
      e.sentence = sentence;
      e.count = (e.count || 0) + 1;
      e.forgotAt = new Date().toISOString();
      if (!("lastSent" in e)) e.lastSent = null;
      state[key] = e;
    } else {
      delete state[key];
    }
    await writeGist(state);
    res.status(200).json({ ok: true });
  } catch (e) {
    console.error("sync", e.message);
    res.status(200).json({ ok: false, error: e.message });
  }
};
```

- [ ] **Step 2: Manual verification (no local Vercel dev needed — deploy and curl)**

```bash
git add api/sync.js
git commit -m "Add /api/sync forgot/remove endpoint"
git push
```

After Vercel redeploys:
```bash
curl -s -X POST https://<your-vercel-url>/api/sync \
  -H "Content-Type: application/json" \
  -d '{"action":"forgot","hanzi":"行","pinyin":"háng","meaning":"银行的行","sentence":"他在银行工作。"}'
```
Expected: `{"ok":true}`. Then check the Gist (gist.github.com, your `weak_words.json` file) shows a `"行|háng"` key.

- [ ] **Step 3: Commit**

(Committed in Step 2 before the deploy — this step is the push, already done.)

---

### Task 5: `api/daily.js` — morning review push

Adapted from the Korean repo's `api/daily.js`: same cron-triggered logic, message text adjusted for Hanzi + Chinese meaning instead of Korean word + gloss.

**Files:**
- Create: `api/daily.js`
- Modify: `vercel.json` (created fresh here — cron schedule, same 07:30 KST timing as the Korean bot)

**Interfaces:**
- Consumes: `readGist`, `writeGist` from Task 3.
- Produces: `GET /api/daily` (also cron-triggered), sends Telegram messages with "✅ Got it" / "🔁 Still learning" buttons via `callback_data` `m|<key>` / `k|<key>`.
- Consumed by: Task 6's `handleCallback` (button taps arrive at `api/telegram.js`).

- [ ] **Step 1: Write `api/daily.js`**

```javascript
// Daily morning review push. Triggered by Vercel Cron (see vercel.json) at
// 22:30 UTC = 07:30 Asia/Seoul. Picks up to N entries from the review queue
// (never-sent first, then least-recently-sent) and sends each to Telegram
// with "Got it" / "Still learning" buttons. Button taps are handled in
// api/telegram.js.
//
// Also callable by GET for manual testing. If CRON_SECRET is set, requests
// must present it (Vercel Cron sends it automatically as a Bearer token).

const { readGist, writeGist } = require("../lib/store");
const N = 10;

module.exports = async (req, res) => {
  if (process.env.CRON_SECRET) {
    const auth = req.headers.authorization || "";
    const key = req.query && req.query.key;
    if (auth !== `Bearer ${process.env.CRON_SECRET}` && key !== process.env.CRON_SECRET) {
      return res.status(401).json({ ok: false });
    }
  }
  if (!process.env.GIST_ID || !process.env.TELEGRAM_BOT_TOKEN || !process.env.ALLOWED_CHAT_ID) {
    return res.status(200).json({ ok: false, reason: "missing env" });
  }

  try {
    const state = await readGist();
    const entries = Object.entries(state);
    if (!entries.length) {
      await tgSend("🌱 Review queue is empty — mark some cards 🔁 Still learning in the app and they'll show up here tomorrow.");
      return res.status(200).json({ ok: true, sent: 0 });
    }

    entries.sort((a, b) => {
      const la = a[1].lastSent || "";
      const lb = b[1].lastSent || "";
      if (la !== lb) return la < lb ? -1 : 1;
      return (b[1].count || 0) - (a[1].count || 0);
    });

    const due = entries.slice(0, N);
    const now = new Date().toISOString();
    await tgSend(`🌅 Morning review — ${due.length} reading${due.length > 1 ? "s" : ""} you've been forgetting. Tap ✅ once you've got one.`);

    for (const [key, e] of due) {
      const [hanzi] = key.split("|");
      const body = `${hanzi}\n${e.meaning || ""}${e.sentence ? "\n\n" + e.sentence : ""}`;
      await tgSendCard(key, hanzi, body);
      e.lastSent = now;
    }
    await writeGist(state);
    res.status(200).json({ ok: true, sent: due.length });
  } catch (e) {
    console.error("daily", e.message);
    res.status(200).json({ ok: false, error: e.message });
  }
};

async function tgSend(text) {
  await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: process.env.ALLOWED_CHAT_ID, text }),
  });
}

async function tgSendCard(key, hanzi, text) {
  // Telegram callback_data caps at 64 bytes; guard against long composite keys
  const safe = Buffer.byteLength(key, "utf8") <= 60;
  const reply_markup = safe
    ? {
        inline_keyboard: [[
          { text: "✅ Got it", callback_data: `m|${key}` },
          { text: "🔁 Still learning", callback_data: `k|${key}` },
        ]],
      }
    : undefined;
  await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: process.env.ALLOWED_CHAT_ID, text, reply_markup }),
  });
}
```

- [ ] **Step 2: Write `vercel.json`**

```json
{
  "crons": [
    { "path": "/api/daily", "schedule": "30 22 * * *" }
  ]
}
```

- [ ] **Step 3: Deploy and verify manually**

```bash
git add api/daily.js vercel.json
git commit -m "Add daily review push (cron + manual GET)"
git push
```

After redeploy:
```bash
curl -s "https://<your-vercel-url>/api/daily?key=<your-CRON_SECRET>"
```
Expected: `{"ok":true,"sent":1}` (using the `行|háng` entry from Task 4's test), and a Telegram message with ✅/🔁 buttons should arrive in your chat.

---

### Task 6: `api/telegram.js` — bot (lesson intake + batching)

The bot's job, per the design spec: message a Hanzi/word, Claude returns every distinct reading as a structured row (Pinyin in tone marks, Meaning in Chinese, one disambiguating Sentence per reading), rows batch in the Gist, and at 15 rows the batch auto-commits as a new session CSV — mirroring the Korean bot's `vocabLesson`/`flushBatch`/`commitEntries` flow. Deliberately smaller in scope than the Korean bot: no quiz, no `/related`, no recall-check — those weren't asked for (YAGNI), so this bot does exactly one thing: intake and batch.

**Files:**
- Create: `api/telegram.js`

**Interfaces:**
- Consumes: `readGistFile`, `writeGistFile` from Task 3.
- Produces: `POST /api/telegram` (webhook), also handles `callback_query` for Task 5's ✅/🔁 buttons.
- Requires env: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_SECRET_TOKEN`, `ANTHROPIC_API_KEY`, `GITHUB_TOKEN`, `GIST_ID`, `ALLOWED_CHAT_ID`.

- [ ] **Step 1: Write the file**

```javascript
// Chinese pinyin bot — Vercel serverless function, no dependencies.
//
// What it does:
//   - Message a Hanzi/word (1-4 CJK characters), or "/py <word>" -> Claude
//     returns every distinct reading as a structured row (pinyin, Chinese
//     meaning, disambiguating sentence). Rows batch in the Gist; at 15 the
//     batch auto-commits as a new session CSV.
//   - /batch  -> show the current batch
//   - /csv    -> flush the batch to a CSV session now
//   - ✅/🔁 button taps from the daily push mark a card mastered/still-learning
//
// Required Vercel env vars: TELEGRAM_BOT_TOKEN, TELEGRAM_SECRET_TOKEN,
// ANTHROPIC_API_KEY, GITHUB_TOKEN. Optional: ALLOWED_CHAT_ID, GIST_ID.

const { readGist, writeGist, readGistFile, writeGistFile } = require("../lib/store");

const REPO = "<your-username>/Chinese-Pinyin-FlashCard-Web";
const BRANCH = "main";
const TIMEZONE = "Asia/Seoul";
const MODEL = "claude-haiku-4-5";
const BATCH_FILE = "vocab_batch.json";
const BATCH_SIZE = 15;
const USAGE_FILE = "usage.json";
const DAILY_MESSAGE_CAP = 60;

module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(200).send("ok");
  if (
    process.env.TELEGRAM_SECRET_TOKEN &&
    req.headers["x-telegram-bot-api-secret-token"] !== process.env.TELEGRAM_SECRET_TOKEN
  ) {
    return res.status(401).send("bad secret");
  }

  const cq = req.body && req.body.callback_query;
  if (cq) {
    try { await handleCallback(cq); } catch (e) { console.error("callback", e.message); }
    return res.status(200).send("ok");
  }

  const msg = req.body && req.body.message;
  const text = msg && msg.text && msg.text.trim();
  const chatId = msg && msg.chat && msg.chat.id;
  if (!text || !chatId) return res.status(200).send("ignored");
  if (process.env.ALLOWED_CHAT_ID && String(chatId) !== process.env.ALLOWED_CHAT_ID) {
    return res.status(200).send("ignored");
  }

  try {
    sendChatAction(chatId);
    const typingTimer = setInterval(() => sendChatAction(chatId), 4000);
    try {
      let reply;
      const wordMatch = parseLookupRequest(text);
      if (/^\/(start|help)\b/i.test(text)) {
        reply = helpText();
      } else if (/^\/csv\b/i.test(text)) {
        reply = await flushBatch();
      } else if (/^\/batch\b/i.test(text)) {
        reply = await batchStatus();
      } else if (wordMatch) {
        reply = await lookupWord(wordMatch);
      } else {
        reply = "Send a Hanzi/word (e.g. 行 or 银行), or /py <word>. /batch to see progress, /csv to save now.";
      }
      const payload = typeof reply === "string" ? { text: reply } : reply;
      if (payload.text) await sendTelegram(chatId, payload.text, { buttons: payload.buttons });
    } finally {
      clearInterval(typingTimer);
    }
  } catch (err) {
    console.error(err);
    await sendTelegram(chatId, "Something went wrong: " + err.message).catch(() => {});
  }
  return res.status(200).send("ok");
};

// "行" (bare 1-4 char Hanzi message) or "/py 银行"
function parseLookupRequest(text) {
  const cmd = text.match(/^\/py\s+(.+)/i);
  if (cmd) return cmd[1].trim();
  if (/^[一-鿿]{1,4}$/.test(text)) return text;
  return null;
}

function helpText() {
  return (
    "Send a Hanzi/word to look up its pinyin (e.g. 行 or 银行), or /py <word>.\n" +
    "/batch — show the current lesson batch\n" +
    "/csv — save the batch to a CSV session now"
  );
}

// ---------- Claude lookup: every distinct reading, structured ----------

const READING_SCHEMA = {
  type: "object",
  properties: {
    readings: {
      type: "array",
      items: {
        type: "object",
        properties: {
          pinyin: { type: "string" },
          meaning: { type: "string" },
          sentence: { type: "string" },
        },
        required: ["pinyin", "meaning", "sentence"],
        additionalProperties: false,
      },
    },
  },
  required: ["readings"],
  additionalProperties: false,
};

const READING_SYSTEM =
  "You give pinyin readings for Chinese characters/words, replying inside Telegram, plain text only " +
  "(no HTML, no markdown).\n\n" +
  "Given a Hanzi character or word, return JSON with 'readings': an array with ONE ENTRY PER DISTINCT " +
  "READING the character/word actually has in real usage (most single characters have one reading; " +
  "polyphonic characters like 行 or 银行 have more — include every genuinely common one, not obscure " +
  "classical-only readings).\n\n" +
  "For each reading:\n" +
  '"pinyin" — that reading, with tone marks (e.g. xíng, háng). No tone numbers, no brackets.\n' +
  '"meaning" — a concise Chinese explanation of that specific reading (近义词/解释 style), e.g. 走、去、可以.\n' +
  '"sentence" — one natural Chinese example sentence using the word WITH THIS READING, so the sentence ' +
  "itself disambiguates which reading is meant.";

async function lookupWord(word) {
  const gen = await claude(READING_SYSTEM, `Word: ${word}`, READING_SCHEMA, { maxTokens: 1500 });
  const out = JSON.parse(gen);
  const readings = (out.readings || []).filter((r) => r.pinyin && r.meaning);
  if (!readings.length) return `Couldn't find a reading for ${word}.`;

  const rows = readings.map((r) => ({ hanzi: word, pinyin: r.pinyin.trim(), meaning: r.meaning.trim(), sentence: (r.sentence || "").trim() }));

  if (!process.env.GIST_ID) {
    const saved = await commitRows(rows);
    return `${saved}\n\n(Batch tracking needs GIST_ID — saved directly.)`;
  }

  const batch = await readGistFile(BATCH_FILE);
  const batchRows = batch.rows || [];
  for (const row of rows) {
    const idx = batchRows.findIndex((r) => r.hanzi === row.hanzi && r.pinyin === row.pinyin);
    if (idx >= 0) batchRows[idx] = row;
    else batchRows.push(row);
  }
  await writeGistFile(BATCH_FILE, { rows: batchRows, startedAt: batch.startedAt || new Date().toISOString() });

  const summary = rows.map((r) => `${r.hanzi} — ${r.pinyin} — ${r.meaning}`).join("\n");
  if (batchRows.length >= BATCH_SIZE) {
    const saved = await flushBatch();
    return `${summary}\n\n🚨 Batch complete (${BATCH_SIZE}/${BATCH_SIZE})! Auto-saving…\n${saved}`;
  }
  return `${summary}\n\n[Batch ${batchRows.length}/${BATCH_SIZE}]`;
}

async function batchStatus() {
  if (!process.env.GIST_ID) return "Batch tracking needs GIST_ID configured.";
  const rows = (await readGistFile(BATCH_FILE)).rows || [];
  if (!rows.length) return "Batch is empty — send a Hanzi/word to start one.";
  return (
    `Current batch (${rows.length}/${BATCH_SIZE}):\n` +
    rows.map((r, i) => `${i + 1}. ${r.hanzi} — ${r.pinyin} — ${r.meaning}`).join("\n") +
    "\n\n/csv to save it now."
  );
}

async function flushBatch() {
  if (!process.env.GIST_ID) return "Batch tracking needs GIST_ID configured.";
  const rows = (await readGistFile(BATCH_FILE)).rows || [];
  if (!rows.length) return "Nothing to save — the batch is empty.";
  const saved = await commitRows(rows);
  await writeGistFile(BATCH_FILE, { rows: [], startedAt: null });
  return saved;
}

// ---------- commit rows [{hanzi, pinyin, meaning, sentence}] to a session CSV ----------

async function commitRows(rows) {
  const csvEscape = (s) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  const lines = rows.map((r) => [r.hanzi, r.pinyin, r.meaning, r.sentence].map(csvEscape).join(","));

  const manifest = JSON.parse(await githubRaw("sessions.json"));
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: TIMEZONE }).format(new Date());
  const compact = today.replace(/-/g, "");
  let entry = manifest.find((e) => e.date === today && e.tag === "Bot");

  if (entry) {
    const existing = await githubRaw(entry.file);
    await ghPut(entry.file, existing.replace(/\n?$/, "\n") + lines.join("\n") + "\n", `Bot: add ${rows.length} row(s)`);
    entry.count += rows.length;
  } else {
    const session = Math.max(0, ...manifest.filter((e) => e.date === today).map((e) => e.session)) + 1;
    const file = `vocablist_csv/${compact}_${String(session).padStart(2, "0")}_LIST_Bot.csv`;
    await ghPut(file, "Hanzi,Pinyin,Meaning,Sentence\n" + lines.join("\n") + "\n", `Bot: new session with ${rows.length} row(s)`);
    const d = new Date(today + "T00:00:00");
    const label = d.toLocaleString("en-US", { month: "short" }) + " " + d.getDate() + (session > 1 ? ` · #${session}` : "");
    entry = { file, date: today, session, tag: "Bot", label, count: rows.length };
    manifest.push(entry);
    manifest.sort((a, b) => (a.date + a.session).localeCompare(b.date + b.session));
  }
  await ghPut("sessions.json", "[\n" + manifest.map((e) => "  " + JSON.stringify(e)).join(",\n") + "\n]\n", "Bot: update sessions.json");

  return (
    `Added ${rows.length} row(s) to ${entry.label} (Bot):\n` +
    rows.map((r) => `• ${r.hanzi} — ${r.pinyin} — ${r.meaning}`).join("\n") +
    "\n\nVercel is redeploying — it'll be in the flashcard app in ~1 min."
  );
}

async function githubRaw(path) {
  const r = await fetch(
    `https://api.github.com/repos/${REPO}/contents/${encodeURIComponent(path).replace(/%2F/g, "/")}?ref=${BRANCH}`,
    { headers: ghHeaders({ Accept: "application/vnd.github.raw+json" }) }
  );
  if (!r.ok) throw new Error(`GitHub read ${path}: ${r.status}`);
  return r.text();
}

function ghHeaders(extra = {}) {
  const h = { "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "cn-pinyin-bot", ...extra };
  if (process.env.GITHUB_TOKEN) h.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  return h;
}

async function ghPut(path, content, message) {
  const url = `https://api.github.com/repos/${REPO}/contents/${path}`;
  let sha;
  const head = await fetch(`${url}?ref=${BRANCH}`, { headers: ghHeaders() });
  if (head.ok) sha = (await head.json()).sha;
  const r = await fetch(url, {
    method: "PUT",
    headers: ghHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({
      message,
      branch: BRANCH,
      content: Buffer.from(content, "utf-8").toString("base64"),
      ...(sha ? { sha } : {}),
    }),
  });
  if (!r.ok) throw new Error(`GitHub write ${path}: ${r.status} ${(await r.text()).slice(0, 200)}`);
}

// ---------- daily-push button taps ----------

async function handleCallback(cq) {
  const chatId = cq.message && cq.message.chat && cq.message.chat.id;
  const data = cq.data || "";
  const [action, key] = [data[0], data.slice(2)];
  if (!chatId || !key) return;
  const state = await readGist();
  if (action === "m") delete state[key];
  else if (action === "k") {
    const e = state[key] || { count: 0, lastSent: null };
    e.count = (e.count || 0) + 1;
    e.forgotAt = new Date().toISOString();
    state[key] = e;
  }
  await writeGist(state);
  await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/answerCallbackQuery`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ callback_query_id: cq.id, text: action === "m" ? "Marked mastered ✅" : "Back in the queue 🔁" }),
  }).catch(() => {});
}

// ---------- Telegram send ----------

function sendChatAction(chatId, action = "typing") {
  return fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendChatAction`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, action }),
  }).catch(() => {});
}

async function sendTelegram(chatId, text, opts = {}) {
  const post = (payload) =>
    fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  for (let i = 0; i < text.length; i += 4000) {
    const chunk = text.slice(i, i + 4000);
    const markup = opts.buttons && i + 4000 >= text.length ? { reply_markup: { inline_keyboard: opts.buttons } } : {};
    const r = await post({ chat_id: chatId, text: chunk, ...markup });
    if (!r.ok) throw new Error(`Telegram send: ${r.status}`);
  }
}

// ---------- Claude API (raw fetch, no SDK) ----------

async function checkDailyCap() {
  if (!process.env.GIST_ID) return;
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: TIMEZONE }).format(new Date());
  const usage = await readGistFile(USAGE_FILE);
  const count = usage.date === today ? usage.count || 0 : 0;
  if (count >= DAILY_MESSAGE_CAP) {
    throw new Error(`Daily Claude usage cap reached (${DAILY_MESSAGE_CAP}/day) — try again after midnight ${TIMEZONE}.`);
  }
  await writeGistFile(USAGE_FILE, { date: today, count: count + 1 });
}

async function claude(system, userText, outputSchema, opts = {}) {
  await checkDailyCap();
  const body = {
    model: opts.model || MODEL,
    max_tokens: opts.maxTokens || 1500,
    system,
    messages: [{ role: "user", content: userText }],
  };
  if (outputSchema) body.output_config = { format: { type: "json_schema", schema: outputSchema } };
  let r;
  for (let attempt = 0; ; attempt++) {
    r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (r.ok || attempt >= 2 || (r.status < 429 && r.status !== 408)) break;
    await new Promise((res) => setTimeout(res, 1500 * (attempt + 1)));
  }
  if (r.status === 529) throw new Error("Anthropic's API is overloaded right now — try again in a minute 🙏");
  if (!r.ok) throw new Error(`Claude API ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const data = await r.json();
  if (data.stop_reason === "refusal") throw new Error("Claude declined the request");
  const textBlock = data.content.find((b) => b.type === "text");
  const text = textBlock ? textBlock.text : "";
  if (outputSchema) {
    if (data.stop_reason === "max_tokens") throw new Error("Claude response hit the token limit — try again");
    if (!text.trim()) throw new Error(`Claude returned no text (stop: ${data.stop_reason})`);
  }
  return text;
};
```

Replace `<your-username>` in the `REPO` constant with your actual GitHub username before deploying.

- [ ] **Step 2: Deploy and register the webhook**

```bash
git add api/telegram.js
git commit -m "Add Telegram bot: lesson intake + batching"
git push
```

After redeploy:
```bash
curl -s "https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/setWebhook?url=https://<your-vercel-url>/api/telegram&secret_token=<TELEGRAM_SECRET_TOKEN>"
```
Expected: `{"ok":true,"result":true,"description":"Webhook was set"}`

- [ ] **Step 3: Telegram round-trip test**

In Telegram, message your bot `行`. Expected reply lists both readings (xíng and háng) with meanings and sentences, ending `[Batch 2/15]`. Then message `/batch` — expect it to list those 2 rows. This is the manual verification this task's `api/*` change requires, per this project's own testing convention.

---

### Task 7: `index.html` — pinyin-drill front end

New, focused front end (not a copy of the Korean app's 1500-line file — this is the "lightweight" project the design spec called for). Reuses the Korean app's exact SM-2 math and TTS mechanism, built around typed-pinyin grading instead of tap-to-flip.

**Files:**
- Modify: `index.html` (replace Task 1's placeholder)

**Interfaces:**
- Consumes: `matchPinyin` from Task 2's `lib/pinyin.js` (via `<script src="lib/pinyin.js">`), `POST /api/sync` from Task 4.
- Produces: the deployed study UI.

- [ ] **Step 1: Write `index.html`**

```html
<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Chinese Pinyin Flashcard</title>
<style>
  body { font-family: system-ui, sans-serif; max-width: 480px; margin: 40px auto; padding: 0 16px; text-align: center; }
  #hanzi { font-size: 72px; margin: 24px 0; }
  #answer { font-size: 24px; padding: 8px; width: 200px; text-align: center; }
  #result { margin-top: 16px; min-height: 90px; }
  .tier-5 { color: #1a7f37; }
  .tier-3 { color: #9a6700; }
  .tier-1 { color: #cf222e; }
  #progress { color: #666; margin-top: 24px; }
  button { font-size: 16px; padding: 6px 14px; margin: 0 4px; }
</style>
</head>
<body>
  <div id="progress">Loading…</div>
  <div id="hanzi">…</div>
  <form id="answer-form">
    <input id="answer" autocomplete="off" placeholder="pinyin, e.g. xing2 or xíng">
    <button type="submit">Check</button>
  </form>
  <div id="result"></div>

<script src="lib/pinyin.js"></script>
<script>
const LS = { cards: 'cn_cards', session: 'cn_session', idx: 'cn_idx', srs: 'cn_srs' };
let cards = [], sessionKey = null, idx = 0, srs = {};

function parseCSV(text) {
  const lines = [];
  let row = [''], inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i], nx = text[i + 1];
    if (c === '"') { if (inQ && nx === '"') { row[row.length - 1] += '"'; i++; } else inQ = !inQ; }
    else if (c === ',' && !inQ) row.push('');
    else if ((c === '\n' || c === '\r') && !inQ) { if (c === '\r' && nx === '\n') i++; lines.push(row); row = ['']; }
    else row[row.length - 1] += c;
  }
  if (row.length > 1 || row[0]) lines.push(row);
  if (lines.length < 2) return [];
  return lines.slice(1)
    .filter(l => l.length >= 4 && l[0].trim())
    .map(l => ({ hanzi: l[0].trim(), pinyin: l[1].trim(), meaning: l[2].trim(), sentence: (l[3] || '').trim() }));
}

async function loadLatestSession() {
  const manifest = await (await fetch('sessions.json')).json();
  if (!manifest.length) { document.getElementById('progress').textContent = 'No sessions yet — add words via the Telegram bot.'; return; }
  const latest = manifest[manifest.length - 1];
  const text = await (await fetch(latest.file)).text();
  cards = parseCSV(text);
  sessionKey = latest.file;
  loadSRS();
  idx = parseInt(localStorage.getItem(LS.idx), 10) || 0;
  if (idx >= cards.length) idx = 0;
  renderCard();
}

function loadSRS() {
  const raw = localStorage.getItem(LS.srs);
  srs = raw ? JSON.parse(raw) : {};
}
function saveSRS() { localStorage.setItem(LS.srs, JSON.stringify(srs)); }
function cardKey(card) { return `${card.hanzi}|${card.pinyin}`; }

// Same SM-2 math as the Korean flashcard app's rateCard(), driven here by
// matchPinyin()'s 1/3/5 tier instead of a tap.
function rateCard(card, rating) {
  const key = cardKey(card);
  const stat = srs[key] || (srs[key] = { rating: 0, rep: 0, interval: 0, efactor: 2.5, dueDate: 0 });
  stat.rating = rating;
  if (rating >= 3) {
    stat.interval = stat.rep === 0 ? 1 : stat.rep === 1 ? 6 : Math.round(stat.interval * stat.efactor);
    stat.rep++;
  } else {
    stat.rep = 0; stat.interval = 1;
  }
  stat.efactor = Math.max(1.3, stat.efactor + 0.1 - (5 - rating) * (0.08 + (5 - rating) * 0.02));
  stat.dueDate = Date.now() + stat.interval * 86400000;
  saveSRS();
  syncReview(card, rating);
}

let syncChain = Promise.resolve();
function syncReview(card, rating) {
  const body = JSON.stringify({
    action: rating <= 2 ? 'forgot' : 'remove',
    hanzi: card.hanzi, pinyin: card.pinyin, meaning: card.meaning, sentence: card.sentence,
  });
  syncChain = syncChain.then(() =>
    fetch('/api/sync', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body }).catch(() => {})
  );
}

function speak(text) {
  if (!('speechSynthesis' in window)) return;
  window.speechSynthesis.cancel();
  const utt = new SpeechSynthesisUtterance(text);
  const voices = window.speechSynthesis.getVoices();
  const v = voices.find(v => v.lang.startsWith('zh'));
  if (v) utt.voice = v;
  utt.lang = 'zh-CN';
  window.speechSynthesis.speak(utt);
}

function renderCard() {
  if (!cards.length) return;
  const card = cards[idx];
  document.getElementById('hanzi').textContent = card.hanzi;
  document.getElementById('answer').value = '';
  document.getElementById('result').innerHTML = '';
  document.getElementById('progress').textContent = `${idx + 1} / ${cards.length}`;
  localStorage.setItem(LS.idx, idx);
  document.getElementById('answer').focus();
}

document.getElementById('answer-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const card = cards[idx];
  const input = document.getElementById('answer').value;
  const rating = window.matchPinyin(input, card.pinyin);
  rateCard(card, rating);
  speak(card.hanzi);

  const label = rating === 5 ? 'Correct!' : rating === 3 ? 'Close — right sound, wrong tone' : 'Not quite';
  document.getElementById('result').innerHTML = `
    <div class="tier-${rating}"><b>${label}</b></div>
    <div>${card.pinyin} — ${card.meaning}</div>
    <div>${card.sentence}</div>
    <button id="tts-btn" type="button">🔊 Play</button>
    <div style="margin-top:12px"><button id="next-btn" type="button">Next →</button></div>
  `;
  document.getElementById('tts-btn').onclick = () => speak(card.hanzi);
  document.getElementById('next-btn').onclick = () => { idx = (idx + 1) % cards.length; renderCard(); };
});

if (window.speechSynthesis && window.speechSynthesis.onvoiceschanged !== undefined) {
  window.speechSynthesis.onvoiceschanged = () => window.speechSynthesis.getVoices();
}

loadLatestSession();
</script>
</body>
</html>
```

- [ ] **Step 2: Add `sessions.json` and a starter CSV so there's something to load**

`sessions.json`:
```json
[
  { "file": "vocablist_csv/20260715_01_LIST_Bot.csv", "date": "2026-07-15", "session": 1, "tag": "Bot", "label": "Jul 15", "count": 2 }
]
```

`vocablist_csv/20260715_01_LIST_Bot.csv`:
```
Hanzi,Pinyin,Meaning,Sentence
行,xíng,走、去、可以,你行不行？
行,háng,排、行业（如银行）,他在银行工作。
```

- [ ] **Step 3: Deploy and browser-test**

```bash
git add index.html sessions.json vocablist_csv/20260715_01_LIST_Bot.csv
git commit -m "Add pinyin-drill front end"
git push
```

Open `https://<your-vercel-url>/` in a browser. Expected: 行 shows, progress reads "1 / 2". Type `xing2` and submit — expect green "Correct!" with xíng's meaning/sentence and a working 🔊 button. Click Next, on the second card type `xing2` (wrong tone for this row, which is háng) — expect amber "Close — right sound, wrong tone". Reload the page — expect it resumes at the second card (via `LS.idx` in `localStorage`).

---

### Task 8: End-to-end verification

No new files — this is the final manual check tying Tasks 1–7 together, matching this project's "explain how it was tested" convention for anything touching `api/*`.

- [ ] **Step 1: Full loop test**

1. In Telegram, message the bot a new word not yet in your CSVs (e.g. `谁`).
2. Confirm the reply shows its reading(s) and `[Batch N/15]`.
3. Run `/csv` to flush immediately (don't wait for 15).
4. Confirm the bot replies with the commit summary, and within ~1 minute the new row appears in `vocablist_csv/*.csv` and `sessions.json` on GitHub (Vercel will auto-redeploy).
5. Reload the flashcard app, confirm the new card appears, grade it via typed pinyin, confirm the SM-2 rating persists across a page reload.
6. Grade a card with rating ≤ 2 (wrong answer), then run `curl -s "https://<your-vercel-url>/api/daily?key=<CRON_SECRET>"` and confirm that card's Hanzi arrives in Telegram with ✅/🔁 buttons; tap 🔁 and confirm the bot's `answerCallbackQuery` toast appears.

- [ ] **Step 2: Confirm no cross-contamination with the Korean bot**

Check the Korean bot's Vercel project env vars and Gist are untouched (different `GIST_ID`, different `TELEGRAM_BOT_TOKEN`) — this was set up as fully separate infrastructure in Task 1, so there should be nothing to fix here; this step is just confirming that.
