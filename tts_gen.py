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
HANGUL_RE = re.compile(r"[가-힣]")
CJK_RE = re.compile(r"[一-龥]")


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
        norm_header = [h.strip().lower() for h in header] if header else []
        if norm_header[:3] != ["word", "definition", "sentence"]:
            raise SystemExit(f"{csv_path}: expected header starting Word,Definition,Sentence")
        pairs = []
        for row in reader:
            if len(row) < 2:
                continue
            korean = row[0].strip()
            chinese = extract_chinese_definition(row[1])
            if not korean or not chinese:
                continue
            if not HANGUL_RE.search(korean) or not CJK_RE.search(chinese):
                # Bot data bug: word/definition occasionally swapped or both end up
                # in the same language. Sending the wrong language to a voice
                # profile produces garbage audio, so skip rather than mis-generate.
                print(f"  SKIP (not Korean/Chinese as expected): {korean!r} / {chinese!r}")
                continue
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
        with urllib.request.urlopen(req, timeout=300) as r:
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

    # Grouped by language (all Korean, then all Chinese) rather than interleaved —
    # voicebox reloads its model on every profile switch, so alternating per-row
    # would pay that reload cost on nearly every clip instead of just once.
    todo = []
    seen = set()
    for lang, profile_id, index in (("ko", args.ko_profile, 0), ("zh", args.zh_profile, 1)):
        for pair in pairs:
            text = pair[index]
            if text not in manifest and text not in seen:
                seen.add(text)
                todo.append((text, lang, profile_id))

    if not todo:
        print("Nothing new to generate — every word/definition already in audio-manifest.json")
        return

    print(f"{len(todo)} new clip(s) to generate" + (" (dry run)" if args.dry_run else ""))
    done = 0
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
        write_manifest(manifest)  # persist after every clip so a later failure doesn't strand finished work
        done += 1

    if not args.dry_run:
        print(f"Wrote {done}/{len(todo)} audio file(s), {MANIFEST_PATH} is up to date")


if __name__ == "__main__":
    main()
