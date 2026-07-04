// Daily morning review push. Triggered by Vercel Cron (see vercel.json) at
// 22:30 UTC = 07:30 Asia/Seoul. Picks up to N words from the review queue
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
      await tgSend("🌱 Review queue is empty — mark some words 😢 Forgot in the app and they'll show up here tomorrow.");
      return res.status(200).json({ ok: true, sent: 0 });
    }

    // never-sent first (lastSent null sorts first), then least-recently sent,
    // then most-forgotten
    entries.sort((a, b) => {
      const la = a[1].lastSent || "";
      const lb = b[1].lastSent || "";
      if (la !== lb) return la < lb ? -1 : 1;
      return (b[1].count || 0) - (a[1].count || 0);
    });

    const due = entries.slice(0, N);
    const now = new Date().toISOString();
    await tgSend(`🌅 Morning review — ${due.length} word${due.length > 1 ? "s" : ""} you've been forgetting. Tap ✅ once you've got one.`);

    for (const [word, e] of due) {
      const body = `${word}\n${e.def || ""}${e.sentence ? "\n\n" + e.sentence : ""}`;
      await tgSendWord(word, body);
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

async function tgSendWord(word, text) {
  // Telegram callback_data caps at 64 bytes; Korean words are short, but guard.
  const safe = Buffer.byteLength(word, "utf8") <= 60;
  const reply_markup = safe
    ? {
        inline_keyboard: [[
          { text: "✅ Got it", callback_data: `m|${word}` },
          { text: "🔁 Still learning", callback_data: `k|${word}` },
        ]],
      }
    : undefined;
  await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: process.env.ALLOWED_CHAT_ID, text, reply_markup }),
  });
}
