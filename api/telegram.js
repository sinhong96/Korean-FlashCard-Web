// Telegram vocab bot — Vercel serverless function, no dependencies.
//
// What it does:
//   - "what does X mean?" / any question  -> recall check against your vocab lists
//   - "quiz" or "quiz me"                 -> quick quiz from random words
//   - "add: word1, word2"                 -> generates entries in the trilingual
//     format and commits a new/updated Bot session CSV to GitHub (Vercel redeploys)
//
// Required Vercel env vars:
//   TELEGRAM_BOT_TOKEN     from @BotFather
//   TELEGRAM_SECRET_TOKEN  any random string; also passed when setting the webhook
//   ANTHROPIC_API_KEY      from console.anthropic.com
//   GITHUB_TOKEN           fine-grained PAT, Contents read/write on this repo
// Optional:
//   ALLOWED_CHAT_ID        your Telegram chat id; if set, other chats are ignored

const REPO = "sinhong96/Korean-FlashCard-Web";
const BRANCH = "main";
const TIMEZONE = "Asia/Singapore";
const MODEL = "claude-haiku-4-5";

module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(200).send("ok");
  if (
    process.env.TELEGRAM_SECRET_TOKEN &&
    req.headers["x-telegram-bot-api-secret-token"] !== process.env.TELEGRAM_SECRET_TOKEN
  ) {
    return res.status(401).send("bad secret");
  }

  const msg = req.body && req.body.message;
  const text = msg && msg.text && msg.text.trim();
  const chatId = msg && msg.chat && msg.chat.id;
  if (!text || !chatId) return res.status(200).send("ignored");
  if (process.env.ALLOWED_CHAT_ID && String(chatId) !== process.env.ALLOWED_CHAT_ID) {
    return res.status(200).send("ignored");
  }

  try {
    let reply;
    const addMatch = text.match(/^\/?add[:\s]+(.+)/is);
    const relMatch = text.match(/^\/?related[:\s]+(.+)/is);
    if (/^\/(start|help)\b/i.test(text)) {
      reply = helpText();
    } else if (addMatch) {
      reply = await addWords(addMatch[1]);
    } else if (relMatch) {
      reply = await relatedWords(relMatch[1]);
    } else if (/^\/?related\b/i.test(text)) {
      reply = "Usage: /related 단어 — I'll find words you've already learned that connect to it.";
    } else if (/^\/?(quiz|test)( me)?\b/i.test(text)) {
      reply = await quiz();
    } else if (/^\/weak\b/i.test(text)) {
      reply = await weakWords();
    } else {
      reply = await recallCheck(text);
    }
    await sendTelegram(chatId, reply);
  } catch (err) {
    console.error(err);
    await sendTelegram(chatId, "Something went wrong: " + err.message).catch(() => {});
  }
  // Always 200 so Telegram doesn't retry the same update
  return res.status(200).send("ok");
};

// ---------- vocab loading (reads the repo's CSVs, always current) ----------

async function githubRaw(path) {
  const r = await fetch(
    `https://api.github.com/repos/${REPO}/contents/${encodeURIComponent(path).replace(/%2F/g, "/")}?ref=${BRANCH}`,
    { headers: ghHeaders({ Accept: "application/vnd.github.raw+json" }) }
  );
  if (!r.ok) throw new Error(`GitHub read ${path}: ${r.status}`);
  return r.text();
}

function ghHeaders(extra = {}) {
  const h = { "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "vocab-bot", ...extra };
  if (process.env.GITHUB_TOKEN) h.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  return h;
}

function parseCSV(txt) {
  // Minimal CSV parser handling quoted fields
  const rows = [];
  let field = "", row = [], inQ = false;
  for (let i = 0; i < txt.length; i++) {
    const c = txt[i];
    if (inQ) {
      if (c === '"' && txt[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') inQ = false;
      else field += c;
    } else if (c === '"') inQ = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && txt[i + 1] === "\n") i++;
      row.push(field); field = "";
      if (row.some((f) => f.trim())) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some((f) => f.trim())) rows.push(row);
  return rows;
}

async function loadVocab() {
  const manifest = JSON.parse(await githubRaw("sessions.json"));
  const all = [];
  await Promise.all(
    manifest.map(async (entry) => {
      const rows = parseCSV(await githubRaw(entry.file)).slice(1); // drop header
      for (const r of rows) {
        if (r[0] && r[0].trim()) {
          all.push({ word: r[0].trim(), definition: r[1] || "", sentence: r[2] || "", session: entry.label });
        }
      }
    })
  );
  return { manifest, all };
}

// ---------- Claude API (raw fetch, no SDK) ----------

async function claude(system, userText, outputSchema) {
  const body = {
    model: MODEL,
    max_tokens: 1500,
    system,
    messages: [{ role: "user", content: userText }],
  };
  if (outputSchema) body.output_config = { format: { type: "json_schema", schema: outputSchema } };
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`Claude API ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const data = await r.json();
  if (data.stop_reason === "refusal") throw new Error("Claude declined the request");
  const textBlock = data.content.find((b) => b.type === "text");
  return textBlock ? textBlock.text : "";
}

// ---------- features ----------

const TUTOR_SYSTEM =
  "You are a Korean vocab recall assistant for Sin Hong, replying inside Telegram. " +
  "Definitions in his flashcards use the format: Chinese / Hanja / [EN] English. " +
  "Keep replies short and plain text (no markdown). When his own flashcard entry is " +
  "provided, base your answer on it and mention which session it came from. If he " +
  "guesses a meaning, say clearly whether he is right or wrong, then give the correct " +
  "meaning and the example sentence.";

async function recallCheck(question) {
  const { all } = await loadVocab();
  // Find flashcard entries mentioned in the question (Korean or English match)
  const matches = all.filter(
    (v) =>
      question.includes(v.word) ||
      (v.word.length > 1 && v.word.includes(question)) ||
      v.definition.toLowerCase().includes(question.toLowerCase())
  ).slice(0, 8);
  const context = matches.length
    ? "His flashcard entries:\n" +
      matches.map((m) => `- ${m.word} | ${m.definition} | ${m.sentence} | (session: ${m.session})`).join("\n")
    : "No matching entry found in his flashcards — say so, then answer from your own knowledge.";
  const reply = await claude(TUTOR_SYSTEM, `${context}\n\nHis message: ${question}`);
  await logWeak(matches); // remember what he keeps asking about, for /weak
  return reply;
}

function helpText() {
  return (
    "Korean vocab bot — what I can do:\n\n" +
    "• Just ask, e.g. \"what does 밥값 mean?\" or guess a meaning and I'll check you\n" +
    "• /related 단어 — words you've already learned that connect to this one\n" +
    "• /weak — the words you keep asking about (your weak spots)\n" +
    "• /quiz — a quick 5-question drill from your vocab\n" +
    "• /add 단어1, 단어2 — add new words to your flashcard app from here"
  );
}

async function relatedWords(word) {
  const target = word.trim();
  const { all } = await loadVocab();
  const vocabList = all.map((v) => `${v.word} = ${v.definition}`).join("\n");
  const sys =
    "You help a Korean learner find connections between words he has already studied. " +
    "Given a target word and his full vocab list, pick up to 6 words FROM HIS LIST that are " +
    "meaningfully related to the target — same theme, synonyms, antonyms, shared Hanja/root, or " +
    "words commonly used together. Only choose words that actually appear in his list. For each, " +
    "give: the Korean word, a short English gloss, and a few words on how it relates to the target. " +
    "Plain text, no markdown. If nothing in his list relates, say so plainly and suggest 2-3 new " +
    "related words he could learn next (mark those clearly as 'not in your list yet').";
  return claude(sys, `Target word: ${target}\n\nHis vocab list:\n${vocabList}`);
}

// ---------- weak-word tracking (optional: needs GIST_ID env var) ----------
// Stored in a private GitHub Gist so updates never touch the repo / trigger a
// Vercel redeploy. GITHUB_TOKEN must have the "Gists" account permission.

async function readGist() {
  const r = await fetch(`https://api.github.com/gists/${process.env.GIST_ID}`, { headers: ghHeaders() });
  if (!r.ok) throw new Error(`Gist read: ${r.status}`);
  const data = await r.json();
  const f = data.files && data.files["weak_words.json"];
  if (!f || !f.content) return {};
  try { return JSON.parse(f.content); } catch { return {}; }
}

async function writeGist(obj) {
  const r = await fetch(`https://api.github.com/gists/${process.env.GIST_ID}`, {
    method: "PATCH",
    headers: ghHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ files: { "weak_words.json": { content: JSON.stringify(obj, null, 2) } } }),
  });
  if (!r.ok) throw new Error(`Gist write: ${r.status}`);
}

async function logWeak(matches) {
  if (!process.env.GIST_ID || !matches.length) return;
  try {
    const state = await readGist();
    const now = new Date().toISOString();
    for (const m of matches) {
      const e = state[m.word] || { definition: m.definition, count: 0 };
      e.count += 1;
      e.last = now;
      e.definition = m.definition;
      state[m.word] = e;
    }
    await writeGist(state);
  } catch (err) {
    console.error("logWeak", err.message); // best-effort; never block the reply
  }
}

async function weakWords() {
  if (!process.env.GIST_ID) {
    return "Weak-word tracking isn't switched on yet — it needs a GIST_ID env var. Ask Claude to finish setting it up.";
  }
  const state = await readGist();
  const entries = Object.entries(state);
  if (!entries.length) {
    return "No weak words tracked yet. Ask me about words you're unsure of and they'll start showing up here.";
  }
  entries.sort((a, b) => b[1].count - a[1].count || (b[1].last || "").localeCompare(a[1].last || ""));
  return (
    "Words you keep asking about — most-forgotten first:\n\n" +
    entries.slice(0, 12).map(([w, e], i) => `${i + 1}. ${w} — ${e.definition}  (asked ${e.count}×)`).join("\n")
  );
}

async function quiz() {
  const { all } = await loadVocab();
  const picks = all.sort(() => Math.random() - 0.5).slice(0, 5);
  const list = picks.map((m) => `- ${m.word} | ${m.definition}`).join("\n");
  return claude(
    TUTOR_SYSTEM,
    `Make a quick 5-question recall quiz from these words (ask meaning or usage, mix directions KR->EN and EN->KR). Put the answer key at the bottom.\n${list}`
  );
}

// ---------- add words: generate entries + commit to GitHub ----------

const ENTRY_SCHEMA = {
  type: "object",
  properties: {
    entries: {
      type: "array",
      items: {
        type: "object",
        properties: {
          word: { type: "string" },
          definition: { type: "string" },
          sentence: { type: "string" },
        },
        required: ["word", "definition", "sentence"],
        additionalProperties: false,
      },
    },
  },
  required: ["entries"],
  additionalProperties: false,
};

async function addWords(input) {
  const gen = await claude(
    "You create Korean flashcard entries. For each word: 'definition' must follow the exact format " +
      "'中文含义 / 汉字词源 (漢字) / [EN] English meaning' (if no hanja exists use ---), and 'sentence' must be " +
      "a natural Korean example sentence followed by its Chinese translation in parentheses. " +
      "Match this style: 혐오하다 -> '厌恶 / 嫌恶 / 仇恨 (嫌惡--) / [EN] To hate, to loathe' with sentence " +
      "'저는 소년범을 혐오합니다. (我厌恶少年犯。)'",
    `Create flashcard entries for: ${input}`,
    ENTRY_SCHEMA
  );
  const entries = JSON.parse(gen).entries;
  if (!entries.length) return "No entries generated.";

  const csvEscape = (s) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  const lines = entries.map((e) => [e.word, e.definition, e.sentence].map(csvEscape).join(","));

  const manifest = JSON.parse(await githubRaw("sessions.json"));
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: TIMEZONE }).format(new Date()); // YYYY-MM-DD
  const compact = today.replace(/-/g, "");
  let entry = manifest.find((e) => e.date === today && e.tag === "Bot");

  if (entry) {
    // Append to today's Bot session
    const existing = await githubRaw(entry.file);
    await ghPut(entry.file, existing.replace(/\n?$/, "\n") + lines.join("\n") + "\n", `Bot: add ${entries.length} word(s)`);
    entry.count += entries.length;
  } else {
    const session = Math.max(0, ...manifest.filter((e) => e.date === today).map((e) => e.session)) + 1;
    const file = `vocablist_csv/${compact}_${String(session).padStart(2, "0")}_LIST_Bot.csv`;
    await ghPut(file, "Word,Definition,Sentence\n" + lines.join("\n") + "\n", `Bot: new session with ${entries.length} word(s)`);
    const d = new Date(today + "T00:00:00");
    const label = d.toLocaleString("en-US", { month: "short" }) + " " + d.getDate() + (session > 1 ? ` · #${session}` : "");
    entry = { file, date: today, session, tag: "Bot", label, count: entries.length };
    manifest.push(entry);
    manifest.sort((a, b) => (a.date + a.session).localeCompare(b.date + b.session));
  }
  await ghPut("sessions.json", "[\n" + manifest.map((e) => "  " + JSON.stringify(e)).join(",\n") + "\n]\n", "Bot: update sessions.json");

  return (
    `Added ${entries.length} word(s) to ${entry.label} (Bot):\n` +
    entries.map((e) => `• ${e.word} — ${e.definition}`).join("\n") +
    "\n\nVercel is redeploying — it'll be in the flashcard app in ~1 min."
  );
}

async function ghPut(path, content, message) {
  const url = `https://api.github.com/repos/${REPO}/contents/${path}`;
  // Get current sha if the file exists (required for updates)
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

// ---------- Telegram ----------

async function sendTelegram(chatId, text) {
  // Telegram messages cap at 4096 chars
  for (let i = 0; i < text.length; i += 4000) {
    const r = await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: text.slice(i, i + 4000) }),
    });
    if (!r.ok) throw new Error(`Telegram send: ${r.status}`);
  }
}
