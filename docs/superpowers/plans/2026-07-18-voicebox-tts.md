# Voicebox Natural TTS for Flashcards Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace robotic browser `speechSynthesis` playback with pre-generated, natural-sounding [voicebox](https://github.com/jamiepine/voicebox) audio for permanent flashcard sessions' Korean words and Chinese definitions.

**Architecture:** A local Python script (`tts_gen.py`) calls voicebox's local REST API (`POST /generate/stream`) to synthesize a WAV clip per unique word/definition, writes them under `audio/`, and records them in `audio-manifest.json`. `index.html`'s `playTTS()` plays the matching file when one exists and falls back to the existing `speechSynthesis` behavior otherwise.

**Tech Stack:** Python 3 stdlib only (`csv`, `urllib`, `hashlib`, `json`, `argparse`) for the script; plain JS (no framework) for the frontend change; [voicebox](https://github.com/jamiepine/voicebox) (external, local-only, MIT-licensed, FastAPI backend on `http://127.0.0.1:17493`) as the TTS engine.

Full rationale and rejected alternative (live server calls from the deployed site) are in `docs/superpowers/specs/2026-07-18-voicebox-tts-design.md`.

## Global Constraints

- No frameworks, no build step, no new npm packages — plain HTML/CSS/JS on the frontend (`CLAUDE.md`).
- Python script stays dependency-free (stdlib only), matching `ingest.py`'s existing convention — no `pip install requests`.
- Every push to `main` auto-deploys to Vercel — don't push a session with audio files but no matching manifest entry, or vice versa.
- Don't reformat `sessions.json` wholesale — this feature doesn't touch it at all.
- **Task 1 and the live-generation half of Task 4 require voicebox actually running on your Mac** (a GUI desktop app that downloads multi-GB models). These cannot be executed by a sandboxed coding subagent. If running this plan via subagent-driven-development, expect to do those two parts yourself; a subagent can handle Tasks 2 and 3 (pure code) unattended.

---

### Task 1: Install voicebox and create Korean + Chinese voice profiles

**Manual — human action, no repo files change.** A coding agent cannot install a GUI desktop app or download multi-GB model weights inside its sandbox; do this yourself.

- [ ] **Step 1: Install voicebox**

Simplest path — download the prebuilt macOS app instead of building from source:
1. Go to https://github.com/jamiepine/voicebox/releases
2. Download the latest `.dmg` for your Mac (Apple Silicon or Intel)
3. Install and launch it

(Building from source is also possible — `git clone https://github.com/jamiepine/voicebox.git && cd voicebox && just setup && just dev` — but needs Python 3.11+, Rust, Bun, and Xcode Command Line Tools. The prebuilt app avoids all of that.)

- [ ] **Step 2: Confirm the backend is reachable**

Run: `curl -s http://127.0.0.1:17493/health`
Expected: JSON containing `"status":"healthy"`. If this fails, voicebox isn't running — open the app.

- [ ] **Step 3: Create a Korean voice profile and a Chinese voice profile**

In the app, create two voice profiles using bundled preset voices (no need to clone your own voice):
- One with language **Korean**
- One with language **Chinese**

Recommended engine to start with: **Qwen3-TTS** (`qwen`) — it's CJK-trained. Chatterbox Multilingual (`chatterbox`) is worth A/B-ing by ear too, since both are free and local.

Generate one test line for each profile from the app's own Generate tab first — this forces the model to download/load now (a one-time multi-GB fetch) rather than mid-batch later, and lets you confirm the voice sounds right before scripting anything.

- [ ] **Step 4: Note the two profile IDs**

Run: `curl -s http://127.0.0.1:17493/profiles | python3 -m json.tool`
Find the Korean profile's `"id"` and the Chinese profile's `"id"` in the output — you'll pass these to `tts_gen.py` in Task 4 as `--ko-profile` / `--zh-profile`.

---

### Task 2: `tts_gen.py` — generation script

**Files:**
- Create: `/Users/sinhongtan/Claude/Projects/Topik flash card/tts_gen.py`
- Create: `/Users/sinhongtan/Claude/Projects/Topik flash card/test_tts_gen.py`

**Interfaces:**
- Produces: `extract_chinese_definition(raw_def: str) -> str` — pure text parser, importable, used by Task 4's manual verification and covered by tests here.
- Produces: `tts_gen.py` CLI — `python3 tts_gen.py <csv_path> --ko-profile <id> --zh-profile <id> [--engine qwen] [--host http://127.0.0.1:17493] [--dry-run]`.
- Produces: `audio-manifest.json` at repo root, shape `{"<word or definition text>": "audio/ko/<slug>.wav", ...}`.

The only genuinely unit-testable piece is the text parser (it must exactly mirror `index.html`'s `parseCSV()` `chDef` extraction, or manifest keys won't match what the frontend looks up). The network/filesystem parts are covered manually in this task's Step 5 and end-to-end in Task 4, matching this repo's existing convention (`ingest.py` has no automated tests either — just a `--dry-run` flag).

- [ ] **Step 1: Write the failing test**

Create `test_tts_gen.py`:

```python
"""Unit tests for the pure text-parsing logic in tts_gen.py.

Run: python3 -m unittest test_tts_gen -v
"""

import unittest

from tts_gen import extract_chinese_definition


class ExtractChineseDefinitionTests(unittest.TestCase):
    def test_plain_definition(self):
        self.assertEqual(extract_chinese_definition("顺利"), "顺利")

    def test_strips_hanja_parenthetical(self):
        self.assertEqual(extract_chinese_definition("顺利 (順利)"), "顺利")

    def test_strips_english_suffix(self):
        self.assertEqual(
            extract_chinese_definition("顺利 (順利) / [EN] To go well"),
            "顺利",
        )

    def test_strips_dash_placeholder(self):
        self.assertEqual(extract_chinese_definition("难过 (---)"), "难过")

    def test_strips_trailing_slash(self):
        self.assertEqual(extract_chinese_definition("顺利/"), "顺利")

    def test_leaves_non_cjk_parenthetical_alone(self):
        self.assertEqual(extract_chinese_definition("顺利 (adj)"), "顺利 (adj)")


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd "/Users/sinhongtan/Claude/Projects/Topik flash card" && python3 -m unittest test_tts_gen -v`
Expected: `ModuleNotFoundError: No module named 'tts_gen'` (the file doesn't exist yet).

- [ ] **Step 3: Write the implementation**

Create `tts_gen.py`:

```python
#!/usr/bin/env python3
"""Pre-generate natural Korean/Chinese TTS audio for a vocab session CSV via a local voicebox server.

Reads a session CSV (Word,Definition,Sentence), extracts each row's Korean
word and Chinese definition (mirroring index.html's parseCSV() chDef
extraction so manifest keys match what the frontend looks up), and for every
string not already in audio-manifest.json, calls voicebox's local REST API
to synthesize a WAV clip.

Requires voicebox running locally with a Korean and a Chinese voice profile
already created (see docs/superpowers/plans/2026-07-18-voicebox-tts.md, Task 1).

Usage:
  python3 tts_gen.py vocablist_csv/20260718_01_LIST.csv --ko-profile <id> --zh-profile <id>
  python3 tts_gen.py vocablist_csv/20260718_01_LIST.csv --ko-profile <id> --zh-profile <id> --engine chatterbox
  python3 tts_gen.py vocablist_csv/20260718_01_LIST.csv --ko-profile <id> --zh-profile <id> --dry-run

Env overrides:
  VOICEBOX_HOST  base URL of the voicebox server (default http://127.0.0.1:17493)
"""

import argparse
import csv
import hashlib
import json
import os
import re
import urllib.error
import urllib.request

REPO_DIR = os.path.dirname(os.path.abspath(__file__))
MANIFEST_PATH = os.path.join(REPO_DIR, "audio-manifest.json")
AUDIO_DIR = os.path.join(REPO_DIR, "audio")
DEFAULT_HOST = os.environ.get("VOICEBOX_HOST", "http://127.0.0.1:17493")

EN_SPLIT_RE = re.compile(r"/\s*\[EN\]", re.IGNORECASE)
HANJA_RE = re.compile(r"\(([^)]*[一-龥][^)]*)\)")
DASH_PLACEHOLDER_RE = re.compile(r"\s*\(---\)\s*")
TRAILING_SLASH_RE = re.compile(r"/\s*$")


def extract_chinese_definition(raw_def):
    """Mirror index.html's parseCSV() chDef extraction so manifest keys match the frontend exactly."""
    ch_def = raw_def.strip()
    m = EN_SPLIT_RE.search(ch_def)
    if m:
        ch_def = ch_def[:m.start()].strip()
    hm = HANJA_RE.search(ch_def)
    if hm:
        ch_def = (ch_def[:hm.start()] + ch_def[hm.end():]).strip()
    ch_def = DASH_PLACEHOLDER_RE.sub("", ch_def)
    ch_def = TRAILING_SLASH_RE.sub("", ch_def).strip()
    return ch_def


def read_session_rows(csv_path):
    """Return [(korean_word, chinese_definition), ...], skipping rows missing either."""
    with open(csv_path, "r", encoding="utf-8-sig", newline="") as f:
        reader = csv.reader(f)
        header = next(reader, None)
        if header is None or [h.strip().lower() for h in header] != ["word", "definition", "sentence"]:
            raise SystemExit(f"{csv_path}: expected header Word,Definition,Sentence")
        pairs = []
        for row in reader:
            if len(row) < 2:
                continue
            korean = row[0].strip()
            chinese = extract_chinese_definition(row[1])
            if korean and chinese:
                pairs.append((korean, chinese))
        return pairs


def slug_for(text):
    return hashlib.sha1(text.encode("utf-8")).hexdigest()[:16]


def load_manifest():
    if not os.path.exists(MANIFEST_PATH):
        return {}
    with open(MANIFEST_PATH, "r", encoding="utf-8") as f:
        return json.load(f)


def write_manifest(manifest):
    with open(MANIFEST_PATH, "w", encoding="utf-8") as f:
        json.dump(manifest, f, ensure_ascii=False, indent=2, sort_keys=True)
        f.write("\n")


def check_server(host):
    try:
        with urllib.request.urlopen(f"{host}/health", timeout=5) as r:
            body = json.loads(r.read())
    except (urllib.error.URLError, OSError) as e:
        raise SystemExit(
            f"Cannot reach voicebox at {host} ({e}).\n"
            "Start voicebox first (open the app), then re-run."
        )
    if body.get("status") != "healthy":
        raise SystemExit(f"voicebox at {host} reports unhealthy status: {body.get('status')!r}")


def generate_audio(host, profile_id, text, language, engine):
    payload = json.dumps({
        "profile_id": profile_id,
        "text": text,
        "language": language,
        "engine": engine,
    }).encode("utf-8")
    req = urllib.request.Request(
        f"{host}/generate/stream",
        data=payload,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            return r.read()
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", errors="replace")
        raise SystemExit(f"voicebox generation failed for {text!r}: HTTP {e.code} {detail}")


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("csv_path", help="path to a session CSV (vocablist_csv/*.csv)")
    parser.add_argument("--ko-profile", required=True, help="voicebox profile id for Korean")
    parser.add_argument("--zh-profile", required=True, help="voicebox profile id for Chinese")
    parser.add_argument("--engine", default="qwen", choices=[
        "qwen", "qwen_custom_voice", "luxtts", "chatterbox", "chatterbox_turbo", "tada", "kokoro",
    ])
    parser.add_argument("--host", default=DEFAULT_HOST)
    parser.add_argument("--dry-run", action="store_true", help="show what would be generated, write nothing")
    args = parser.parse_args()

    pairs = read_session_rows(args.csv_path)
    if not pairs:
        print(f"No rows with both a Korean word and Chinese definition found in {args.csv_path}")
        return

    manifest = load_manifest()
    if not args.dry_run:
        check_server(args.host)

    todo = []
    seen = set()
    for korean, chinese in pairs:
        for text, lang, profile_id in ((korean, "ko", args.ko_profile), (chinese, "zh", args.zh_profile)):
            if text not in manifest and text not in seen:
                seen.add(text)
                todo.append((text, lang, profile_id))

    if not todo:
        print("Nothing new to generate — every word/definition already in audio-manifest.json")
        return

    print(f"{len(todo)} new clip(s) to generate" + (" (dry run)" if args.dry_run else ""))
    for text, lang, profile_id in todo:
        rel_path = os.path.join("audio", lang, f"{slug_for(text)}.wav")
        print(f"  [{lang}] {text!r} -> {rel_path}")
        if args.dry_run:
            continue
        audio_bytes = generate_audio(args.host, profile_id, text, lang, args.engine)
        out_path = os.path.join(REPO_DIR, rel_path)
        os.makedirs(os.path.dirname(out_path), exist_ok=True)
        with open(out_path, "wb") as f:
            f.write(audio_bytes)
        manifest[text] = rel_path

    if not args.dry_run:
        write_manifest(manifest)
        print(f"Wrote {len(todo)} audio file(s), updated {MANIFEST_PATH}")


if __name__ == "__main__":
    main()
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd "/Users/sinhongtan/Claude/Projects/Topik flash card" && python3 -m unittest test_tts_gen -v`
Expected: 6 tests, all `ok`.

- [ ] **Step 5: Manual dry-run smoke test (no voicebox required)**

Run: `cd "/Users/sinhongtan/Claude/Projects/Topik flash card" && python3 tts_gen.py vocablist_csv/20260712_01_LIST_Bot.csv --ko-profile dummy --zh-profile dummy --dry-run`
Expected: a list of `[ko] '...' -> audio/ko/....wav` / `[zh] '...' -> audio/zh/....wav` lines, no errors, no files written (`--dry-run` skips `check_server`, so this works even with voicebox closed).

- [ ] **Step 6: Commit**

```bash
git add tts_gen.py test_tts_gen.py
git commit -m "Add tts_gen.py: pre-generate natural voicebox TTS audio for vocab sessions"
```

---

### Task 3: Wire pre-generated audio into `index.html`'s `playTTS()`

**Files:**
- Modify: `index.html:874` (STATE section — add `audioManifest` variable)
- Modify: `index.html:888-904` (INIT section — fetch the manifest at load)
- Modify: `index.html:1389-1406` (TTS section — check manifest before falling back to `speechSynthesis`)

**Interfaces:**
- Consumes: `audio-manifest.json` (produced by Task 2's `tts_gen.py`, shape `{"<text>": "audio/<lang>/<slug>.wav"}`) — falls back to `{}` if the file doesn't exist yet or fails to load, which is the state before Task 4 has generated anything.
- Consumes: `card.front` / `card.korean` (already defined by `parseCSV()`, unchanged).

No JS test runner exists in this project (no build step, per `CLAUDE.md`) — verification here is manual, matching the "test in a browser" bar this repo already uses for frontend changes.

- [ ] **Step 1: Add the `audioManifest` state variable**

In `index.html`, in the STATE block, change:

```js
let srs          = {};        // { korean: { rating, rep, interval, efactor, dueDate } }
```

to:

```js
let srs          = {};        // { korean: { rating, rep, interval, efactor, dueDate } }
let audioManifest = {};       // { text: 'audio/ko/<slug>.wav' } — pre-generated natural TTS, from tts_gen.py
```

- [ ] **Step 2: Fetch the manifest at startup**

In `index.html`, change:

```js
window.addEventListener('DOMContentLoaded', async () => {
  loadSRS();
  loadLocalSessions();
  setupListeners();
  await fetchSessions();
  restoreLastState();
});

async function fetchSessions() {
  try {
    const r = await fetch('sessions.json');
    sessions = await r.json();
  } catch {
    sessions = [];
  }
  renderSessionList();
}
```

to:

```js
window.addEventListener('DOMContentLoaded', async () => {
  loadSRS();
  loadLocalSessions();
  setupListeners();
  await Promise.all([fetchSessions(), fetchAudioManifest()]);
  restoreLastState();
});

async function fetchSessions() {
  try {
    const r = await fetch('sessions.json');
    sessions = await r.json();
  } catch {
    sessions = [];
  }
  renderSessionList();
}

async function fetchAudioManifest() {
  try {
    const r = await fetch('audio-manifest.json');
    audioManifest = await r.json();
  } catch {
    audioManifest = {};
  }
}
```

- [ ] **Step 3: Check the manifest in `playTTS()` before falling back to `speechSynthesis`**

In `index.html`, change:

```js
// ════════════════════════════════════════
//  TTS
// ════════════════════════════════════════
function playTTS(side) {
  if (!('speechSynthesis' in window) || !activeIdxs.length) return;
  const card = cards[activeIdxs[idx]];
  const text = side === 'back' ? card.korean : card.front;
  const lang = side === 'back' ? 'ko-KR' : 'zh-CN';
  window.speechSynthesis.cancel();
  const utt = new SpeechSynthesisUtterance(text);
  utt.lang = lang; utt.rate = 0.85;
  const voices = window.speechSynthesis.getVoices();
  const v = voices.find(v => v.lang.startsWith(lang.slice(0, 2)));
  if (v) utt.voice = v;
  window.speechSynthesis.speak(utt);
}
if (window.speechSynthesis.onvoiceschanged !== undefined)
  window.speechSynthesis.onvoiceschanged = () => window.speechSynthesis.getVoices();
```

to:

```js
// ════════════════════════════════════════
//  TTS
// ════════════════════════════════════════
let ttsAudio = null; // currently playing pre-generated clip, if any

function playTTS(side) {
  if (!activeIdxs.length) return;
  const card = cards[activeIdxs[idx]];
  const text = side === 'back' ? card.korean : card.front;
  const lang = side === 'back' ? 'ko-KR' : 'zh-CN';

  window.speechSynthesis && window.speechSynthesis.cancel();
  if (ttsAudio) { ttsAudio.pause(); ttsAudio = null; }

  const file = audioManifest[text];
  if (file) {
    ttsAudio = new Audio(file);
    ttsAudio.play().catch(() => speakBrowserTTS(text, lang));
    return;
  }
  speakBrowserTTS(text, lang);
}

function speakBrowserTTS(text, lang) {
  if (!('speechSynthesis' in window)) return;
  const utt = new SpeechSynthesisUtterance(text);
  utt.lang = lang; utt.rate = 0.85;
  const voices = window.speechSynthesis.getVoices();
  const v = voices.find(v => v.lang.startsWith(lang.slice(0, 2)));
  if (v) utt.voice = v;
  window.speechSynthesis.speak(utt);
}
if (window.speechSynthesis.onvoiceschanged !== undefined)
  window.speechSynthesis.onvoiceschanged = () => window.speechSynthesis.getVoices();
```

- [ ] **Step 4: Manual verification (fallback path — no audio files exist yet)**

Run: `cd "/Users/sinhongtan/Claude/Projects/Topik flash card" && python3 -m http.server 8000`
Open `http://localhost:8000` in a browser, open any session, flip a card, click the speaker button on both faces.
Expected: since `audio-manifest.json` doesn't exist yet (Task 4 creates it), `fetch('audio-manifest.json')` 404s, `audioManifest` stays `{}`, and both buttons fall back to the original `speechSynthesis` behavior — same as before this change, no console errors.

- [ ] **Step 5: Commit**

```bash
git add index.html
git commit -m "Play pre-generated voicebox audio in playTTS() when available, fall back to speechSynthesis"
```

---

### Task 4: Generate real audio for one session, verify end-to-end, update the docs

**Manual — requires voicebox running with the profile IDs from Task 1.** This is the first real integration test; a coding subagent cannot run it (needs live voicebox on your Mac).

**Files:**
- Creates: `audio-manifest.json`, `audio/ko/*.wav`, `audio/zh/*.wav`
- Modify: `README.md` (Adding New Sessions → Permanent way)

- [ ] **Step 1: Generate audio for one existing session**

Pick a small existing session, e.g. `vocablist_csv/20260712_01_LIST_Bot.csv`. With voicebox running:

Run: `cd "/Users/sinhongtan/Claude/Projects/Topik flash card" && python3 tts_gen.py vocablist_csv/20260712_01_LIST_Bot.csv --ko-profile <your-ko-id> --zh-profile <your-zh-id>`
Expected: one `.wav` per unique word/definition appears under `audio/ko/` and `audio/zh/`, and `audio-manifest.json` is created with matching entries. No errors.

- [ ] **Step 2: Verify playback in the browser**

Run: `python3 -m http.server 8000` (if not already running), open `http://localhost:8000`, open the session from Step 1, flip a card, open DevTools → Network tab, click both speaker buttons.
Expected: Network tab shows a `.wav` request under `audio/ko/` or `audio/zh/` for each click (not a `speechSynthesis` call) — and the voice sounds natural, not robotic.

- [ ] **Step 3: Verify the fallback still works for un-generated text**

Open a *different* session (one you haven't run `tts_gen.py` against) and click its speaker buttons.
Expected: falls back to browser `speechSynthesis` exactly as before — no errors, no missing audio.

- [ ] **Step 4: Verify dedup — re-run against overlapping vocab**

Run the same Step 1 command again.
Expected: output is `Nothing new to generate — every word/definition already in audio-manifest.json`, no new files written, no duplicate API calls.

- [ ] **Step 5: Update `README.md`'s "Permanent way" instructions**

In `README.md`, change:

```markdown
**Permanent way (shows in session list):**
1. Save the CSV file into `vocablist_csv/`
2. Add one entry to `sessions.json`:
   ```json
   { "file": "vocablist_csv/YYYYMMDD_01_LIST.csv", "date": "YYYY-MM-DD", "session": 1, "tag": null, "label": "Mon DD", "count": 15 }
   ```
3. `git push` — Vercel auto-redeploys
```

to:

```markdown
**Permanent way (shows in session list):**
1. Save the CSV file into `vocablist_csv/`
2. Add one entry to `sessions.json`:
   ```json
   { "file": "vocablist_csv/YYYYMMDD_01_LIST.csv", "date": "YYYY-MM-DD", "session": 1, "tag": null, "label": "Mon DD", "count": 15 }
   ```
3. (Optional, for natural TTS instead of the robotic browser voice) With voicebox
   running locally: `python3 tts_gen.py vocablist_csv/YYYYMMDD_01_LIST.csv --ko-profile <id> --zh-profile <id>`
4. `git push` — Vercel auto-redeploys
```

- [ ] **Step 6: Commit**

```bash
git add audio-manifest.json audio/ README.md
git commit -m "Generate natural voicebox audio for the 2026-07-12 session, document the workflow"
```
