// Receives forgot/remove events from the flashcard app and updates the review
// queue in the Gist. Called by the browser on each Forgot/Got-it tap.
//
// POST body: { action: "forgot" | "remove", word, def?, sentence? }
//
// Note: this is a public endpoint (the flashcard page is public, so it can't
// hold credentials). Worst case someone finds the URL and adds junk words to
// your review list — low stakes. Bounded by MAX_WORDS. Can be locked down
// later with a CRON_SECRET-style key if desired.

const { readGist, writeGist } = require("../lib/store");
const MAX_WORDS = 2000;

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ ok: false });
  if (!process.env.GIST_ID) return res.status(200).json({ ok: false, reason: "no GIST_ID" });

  try {
    const { action, word, def = "", sentence = "" } = req.body || {};
    if (!word || !action) return res.status(400).json({ ok: false });

    const state = await readGist();
    if (action === "forgot") {
      if (Object.keys(state).length >= MAX_WORDS && !state[word]) {
        return res.status(200).json({ ok: false, reason: "queue full" });
      }
      const e = state[word] || { count: 0, lastSent: null };
      e.def = def;
      e.sentence = sentence;
      e.count = (e.count || 0) + 1;
      e.forgotAt = new Date().toISOString();
      if (!("lastSent" in e)) e.lastSent = null;
      state[word] = e;
    } else {
      // "remove" / mastered — drop it from the review queue
      delete state[word];
    }
    await writeGist(state);
    res.status(200).json({ ok: true });
  } catch (e) {
    console.error("sync", e.message);
    res.status(200).json({ ok: false, error: e.message });
  }
};
