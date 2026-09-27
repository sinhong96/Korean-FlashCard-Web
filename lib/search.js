// Vocab-corpus search — "have I asked this word before?". Pure functions, no I/O,
// no dependencies, so it can be unit-tested against the real CSVs without touching
// GitHub or the Gist.
//
// Every function takes the flat row array loadVocab() builds in api/telegram.js:
//   { word, definition, sentence, pron, session, date }
// Callers supply the corpus; nothing here fetches anything.
//
// Why this matters: a word you've asked more than once is a word that didn't stick,
// so repeat count is the weak-vocab signal the bot's /find and the app's search box
// both surface.
//
// NOTE: index.html carries a small copy of the matching rules for the in-app search
// box — the front end has no build step and can't require() this file. If you change
// how matching or ranking works here, change it there too (search "corpus search").

// A word asked twice in the SAME session counts as 2 asks but shows that session
// once: 경신하다 really was asked twice on 2026-07-13, both rows in one CSV.

// Session labels can themselves contain " · " (e.g. "Jun 28 · #2" for a day's 2nd session),
// so the fields of a result line are separated by " | " to stay readable.
const FIELD_SEP = "  |  ";

function normalize(s) {
  return String(s == null ? "" : s).toLowerCase().trim();
}

// Substring match on the Korean word and on the Chinese/English definition — so 짜릿,
// 刺激 and "thrilling" all find 짜릿하다. Deliberately NOT the example sentence: common
// words appear in dozens of other words' sentences, which buries the real hit.
function matchesQuery(entry, query) {
  const q = normalize(query);
  if (!q) return false;
  return normalize(entry.word).includes(q) || normalize(entry.definition).includes(q);
}

// Collapse a row list into one entry per word, carrying every session it appeared in.
// definition/sentence come from the most recent occurrence, so a later /def edit wins.
function groupByWord(rows) {
  const byWord = new Map();
  for (const row of rows) {
    const word = String(row.word || "").trim();
    if (!word) continue;
    let e = byWord.get(word);
    if (!e) {
      e = { word, definition: "", sentence: "", count: 0, dates: [], sessions: [], lastDate: "" };
      byWord.set(word, e);
    }
    e.count++;
    const date = row.date || "";
    if (!e.dates.includes(date)) {
      e.dates.push(date);
      e.sessions.push(row.session || date);
    }
    // ">=" so that among same-dated rows the last one read wins (CSV order = ask order)
    if (date >= e.lastDate) {
      e.lastDate = date;
      e.definition = row.definition || "";
      e.sentence = row.sentence || "";
    }
  }
  for (const e of byWord.values()) {
    const order = e.dates.map((d, i) => [d, e.sessions[i]]).sort((a, b) => a[0].localeCompare(b[0]));
    e.dates = order.map((p) => p[0]);
    e.sessions = order.map((p) => p[1]);
  }
  return [...byWord.values()];
}

// Most-likely-what-you-meant first: an exact word match, then the words you've asked
// most often (the weak ones), then the most recently studied.
function rank(entries, query) {
  const q = normalize(query);
  return entries.sort((a, b) => {
    const ax = normalize(a.word) === q ? 0 : 1;
    const bx = normalize(b.word) === q ? 0 : 1;
    if (ax !== bx) return ax - bx;
    if (b.count !== a.count) return b.count - a.count;
    if (b.lastDate !== a.lastDate) return b.lastDate.localeCompare(a.lastDate);
    return a.word.localeCompare(b.word);
  });
}

// Group over every row of a matching word, not just the rows that matched — otherwise
// a query hitting only the newest definition would report the word as asked once.
function searchCorpus(rows, query, { limit = 15 } = {}) {
  if (!normalize(query)) return [];
  const hits = new Set();
  for (const row of rows) if (matchesQuery(row, query)) hits.add(String(row.word || "").trim());
  if (!hits.size) return [];
  const entries = groupByWord(rows.filter((r) => hits.has(String(r.word || "").trim())));
  return rank(entries, query).slice(0, limit);
}

// Every word asked 2+ times, worst first — the standing weak-vocab list. This is what
// bare /find and an empty search box show, so you don't have to guess what to look up.
function repeatWords(rows, { limit = Infinity } = {}) {
  const entries = groupByWord(rows).filter((e) => e.count > 1);
  return rank(entries, "").slice(0, limit);
}

module.exports = { normalize, matchesQuery, groupByWord, searchCorpus, repeatWords, FIELD_SEP };
