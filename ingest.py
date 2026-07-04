#!/usr/bin/env python3
"""Auto-ingest Gemini vocab CSVs into the flashcard repo.

Scans the Downloads folder for CSV files whose header is
Word,Definition,Sentence (the Gemini export format), moves them into
vocablist_csv/ using the YYYYMMDD_NN_LIST.csv naming convention, updates
sessions.json, and commits + pushes so Vercel redeploys.

Also reconciles: any CSV already in vocablist_csv/ but missing from
sessions.json gets a manifest entry.

Usage:
  python3 ingest.py            # normal run
  python3 ingest.py --dry-run  # show what would happen, change nothing
  python3 ingest.py --no-git   # ingest + update manifest, skip commit/push

Env overrides (mainly for testing):
  VOCAB_DOWNLOADS  directory to scan instead of ~/Downloads
"""

import csv
import datetime
import fcntl
import hashlib
import io
import json
import os
import re
import shutil
import subprocess
import sys

REPO_DIR = os.path.dirname(os.path.abspath(__file__))
VOCAB_DIR = os.path.join(REPO_DIR, "vocablist_csv")
SESSIONS_JSON = os.path.join(REPO_DIR, "sessions.json")
DOWNLOADS = os.environ.get("VOCAB_DOWNLOADS", os.path.expanduser("~/Downloads"))
LOCK_FILE = os.path.join(REPO_DIR, ".ingest.lock")
EXPECTED_HEADER = ["word", "definition", "sentence"]
FILENAME_RE = re.compile(r"^(\d{8})_(\d{2})_LIST(?:_(.+))?\.csv$")

DRY_RUN = "--dry-run" in sys.argv
NO_GIT = "--no-git" in sys.argv or DRY_RUN


def log(msg):
    ts = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    print(f"[{ts}] {msg}", flush=True)


def read_csv_rows(path):
    """Return data rows if the file matches the Gemini vocab format, else None."""
    try:
        with open(path, "r", encoding="utf-8-sig", newline="") as f:
            reader = csv.reader(f)
            header = next(reader, None)
            if header is None:
                return None
            if [h.strip().lower() for h in header] != EXPECTED_HEADER:
                return None
            return [row for row in reader if row and row[0].strip()]
    except (OSError, UnicodeDecodeError, csv.Error):
        return None


def content_hash(path):
    with open(path, "rb") as f:
        return hashlib.sha256(f.read()).hexdigest()


def existing_hashes():
    hashes = {}
    for name in os.listdir(VOCAB_DIR):
        if name.endswith(".csv"):
            hashes[content_hash(os.path.join(VOCAB_DIR, name))] = name
    return hashes


def label_for(date, session):
    d = datetime.date.fromisoformat(date)
    base = f"{d.strftime('%b')} {d.day}"
    return base if session == 1 else f"{base} · #{session}"


def next_session_number(date_compact, manifest, pending):
    taken = [0]
    for name in list(os.listdir(VOCAB_DIR)) + pending:
        m = FILENAME_RE.match(name)
        if m and m.group(1) == date_compact:
            taken.append(int(m.group(2)))
    for entry in manifest:
        m = FILENAME_RE.match(os.path.basename(entry["file"]))
        if m and m.group(1) == date_compact:
            taken.append(int(m.group(2)))
    return max(taken) + 1


def write_sessions_json(manifest):
    manifest.sort(key=lambda e: (e["date"], e["session"]))
    lines = ",\n".join(
        "  " + json.dumps(e, ensure_ascii=False, separators=(", ", ": "))
        for e in manifest
    )
    with open(SESSIONS_JSON, "w", encoding="utf-8") as f:
        f.write("[\n" + lines + "\n]\n")


def git(*args, check=True):
    return subprocess.run(
        ["git", "-C", REPO_DIR, *args],
        check=check, capture_output=True, text=True,
    )


def main():
    try:
        os.listdir(DOWNLOADS)
    except PermissionError:
        log(
            "cannot read Downloads (macOS privacy). One-time fix: System Settings"
            " > Privacy & Security > Full Disk Access > add /usr/bin/python3,"
            " then run: launchctl kickstart gui/$(id -u)/com.sinhong.vocab-ingest"
        )
        sys.exit(0)

    with open(SESSIONS_JSON, "r", encoding="utf-8") as f:
        manifest = json.load(f)
    manifest_files = {e["file"] for e in manifest}
    changed_paths = []
    labels = []

    # 1. Reconcile: CSVs already in vocablist_csv/ but missing from sessions.json
    for name in sorted(os.listdir(VOCAB_DIR)):
        rel = f"vocablist_csv/{name}"
        m = FILENAME_RE.match(name)
        if not m or rel in manifest_files:
            continue
        rows = read_csv_rows(os.path.join(VOCAB_DIR, name))
        if rows is None:
            log(f"skip {name}: not a valid vocab CSV")
            continue
        date_compact, session, tag = m.group(1), int(m.group(2)), m.group(3)
        date = f"{date_compact[:4]}-{date_compact[4:6]}-{date_compact[6:]}"
        entry = {
            "file": rel, "date": date, "session": session,
            "tag": tag, "label": label_for(date, session), "count": len(rows),
        }
        log(f"reconcile: adding {name} to sessions.json ({len(rows)} cards)")
        if not DRY_RUN:
            manifest.append(entry)
            manifest_files.add(rel)
        changed_paths.append(rel)
        labels.append(entry["label"])

    # 2. Ingest new downloads
    known = existing_hashes()
    pending_names = []
    for name in sorted(os.listdir(DOWNLOADS)):
        if not name.lower().endswith(".csv"):
            continue
        src = os.path.join(DOWNLOADS, name)
        rows = read_csv_rows(src)
        if rows is None:
            continue  # some other CSV, not ours
        h = content_hash(src)
        if h in known:
            trash = os.path.expanduser("~/.Trash")
            log(f"duplicate of {known[h]}: moving {name} to Trash")
            if not DRY_RUN:
                shutil.move(src, os.path.join(trash, name))
            continue
        today = datetime.date.today()
        date_compact = today.strftime("%Y%m%d")
        session = next_session_number(date_compact, manifest, pending_names)
        new_name = f"{date_compact}_{session:02d}_LIST.csv"
        rel = f"vocablist_csv/{new_name}"
        entry = {
            "file": rel, "date": today.isoformat(), "session": session,
            "tag": None, "label": label_for(today.isoformat(), session),
            "count": len(rows),
        }
        log(f"ingest: {name} -> {new_name} ({len(rows)} cards)")
        if not DRY_RUN:
            shutil.move(src, os.path.join(VOCAB_DIR, new_name))
            manifest.append(entry)
            known[h] = new_name
        pending_names.append(new_name)
        changed_paths.append(rel)
        labels.append(entry["label"])

    if changed_paths and not DRY_RUN:
        write_sessions_json(manifest)

    # 3. Commit and push
    if NO_GIT:
        if changed_paths:
            log(f"{'dry-run' if DRY_RUN else 'no-git'}: skipping commit/push")
        else:
            log("nothing to ingest")
        return

    if changed_paths:
        git("add", "sessions.json", *changed_paths)
        msg = "Add vocab session(s): " + ", ".join(labels)
        git("commit", "-m", msg)
        log(f"committed: {msg}")

    ahead = git("rev-list", "--count", "origin/main..main").stdout.strip()
    if ahead != "0":
        result = git("push", check=False)
        if result.returncode == 0:
            log(f"pushed {ahead} commit(s) — Vercel will redeploy")
        else:
            log(f"push failed (will retry next run): {result.stderr.strip()}")
    elif not changed_paths:
        log("nothing to ingest")


if __name__ == "__main__":
    lock = open(LOCK_FILE, "w")
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        sys.exit(0)  # another run is in progress
    main()
