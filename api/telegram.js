// Telegram vocab bot — Vercel serverless function, no dependencies.
//
// What it does:
//   - "단어 뜻" (+ optional context line)  -> full structured teacher lesson; the
//     word's CSV row is generated in the same call and stored in the gist batch.
//     At 15/15 the batch auto-commits as a new session CSV. /v 단어 also works.
//   - /batch                              -> show the current lesson batch
//   - /csv                                -> flush the batch to a CSV session now
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

const { readGist, writeGist, readGistFile, writeGistFile } = require("../lib/store");

const REPO = "sinhong96/Korean-FlashCard-Web";
const BRANCH = "main";
const TIMEZONE = "Asia/Singapore";
const MODEL = "claude-haiku-4-5";
const LESSON_MODEL = "claude-sonnet-5"; // lessons need nuance/wit; haiku stays for cheap tasks
const BATCH_FILE = "vocab_batch.json";
const BATCH_SIZE = 15;

module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(200).send("ok");
  if (
    process.env.TELEGRAM_SECRET_TOKEN &&
    req.headers["x-telegram-bot-api-secret-token"] !== process.env.TELEGRAM_SECRET_TOKEN
  ) {
    return res.status(401).send("bad secret");
  }

  // Button taps from the daily review push arrive as callback queries
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
    let reply;
    let html = false; // lessons use Telegram HTML formatting; everything else stays plain
    const addMatch = text.match(/^\/?add[:\s]+(.+)/is);
    const relMatch = text.match(/^\/?related[:\s]+(.+)/is);
    const defMatch = text.match(/^\/?def[:\s]+(\S+)\s+(.+)/is);
    const lessonMatch = parseLessonRequest(text);
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
    } else if (/^\/csv\b/i.test(text)) {
      reply = await flushBatch();
    } else if (/^\/batch\b/i.test(text)) {
      reply = await batchStatus();
    } else if (defMatch) {
      reply = await applyDefinition(defMatch[1], defMatch[2].trim());
    } else if (/^\/def\b/i.test(text)) {
      reply = "Usage: /def 단어 你的词 — sets the Chinese shown on that word's flashcard.";
    } else if (lessonMatch) {
      reply = await vocabLesson(lessonMatch);
      html = true;
    } else {
      reply = await recallCheck(text);
    }
    const payload = typeof reply === "string" ? { text: reply } : reply;
    await sendTelegram(chatId, payload.text, { html, buttons: payload.buttons });
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

async function claude(system, userText, outputSchema, opts = {}) {
  const body = {
    model: opts.model || MODEL,
    max_tokens: opts.maxTokens || 1500,
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
  return claude(TUTOR_SYSTEM, `${context}\n\nHis message: ${question}`);
}

function helpText() {
  return (
    "Korean vocab bot — what I can do:\n\n" +
    "• \"단어 뜻\" (+ context sentence on the next line) — full teacher lesson; the word " +
    "joins your current batch and auto-saves to the flashcard app at 15/15\n" +
    "• /batch — see the current lesson batch\n" +
    "• /csv — save the batch to a CSV session right now\n" +
    "• /def 단어 你的词 — change the Chinese shown on that word's flashcard\n" +
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

// ---------- review queue (words marked 😢 Forgot in the flashcard app) ----------
// Stored in a private Gist so updates never trigger a repo redeploy. The app
// syncs forgot/mastered taps here via /api/sync; the daily cron pushes words
// from it; button taps below remove or keep them. Needs GIST_ID + a
// GITHUB_TOKEN with the "Gists" account permission.

async function weakWords() {
  if (!process.env.GIST_ID) {
    return "Review tracking isn't switched on yet — it needs a GIST_ID env var. Ask Claude to finish setting it up.";
  }
  const state = await readGist();
  const entries = Object.entries(state);
  if (!entries.length) {
    return "Nothing in your review queue. Mark words 😢 Forgot in the flashcard app and they'll show up here (and in your 7:30am review).";
  }
  entries.sort((a, b) => (b[1].count || 0) - (a[1].count || 0) || (b[1].forgotAt || "").localeCompare(a[1].forgotAt || ""));
  return (
    `You have ${entries.length} word${entries.length > 1 ? "s" : ""} in your review queue — top ones:\n\n` +
    entries.slice(0, 15).map(([w, e], i) => `${i + 1}. ${w} — ${e.def || ""}  (forgot ${e.count || 1}×)`).join("\n")
  );
}

// Handle the ✅ Got it / 🔁 Still learning buttons on the daily push
async function handleCallback(cq) {
  const fromId = cq.from && cq.from.id;
  if (process.env.ALLOWED_CHAT_ID && String(fromId) !== process.env.ALLOWED_CHAT_ID) {
    return answerCallback(cq.id, "Not allowed");
  }
  const data = cq.data || "";
  const sep = data.indexOf("|");
  const kind = data.slice(0, sep);
  const word = data.slice(sep + 1);

  // "d|단어|中文" — a Chinese-gloss choice tapped under a lesson
  if (kind === "d") {
    const p = word.indexOf("|");
    const w = word.slice(0, p);
    const term = word.slice(p + 1);
    let result;
    try { result = await applyDefinition(w, term); } catch (e) { result = "Failed: " + e.message; }
    await answerCallback(cq.id, result.slice(0, 190));
    if (cq.message) {
      await editMessage(cq.message.chat.id, cq.message.message_id, `${cq.message.text}\n\n— 🀄 ${w} → ${term}`);
    }
    return;
  }

  if (kind === "m" && process.env.GIST_ID) {
    const state = await readGist();
    delete state[word]; // mastered — remove from the queue
    await writeGist(state);
  }
  await answerCallback(cq.id, kind === "m" ? `✅ ${word} — mastered!` : `🔁 ${word} — kept for next time`);
  if (cq.message) {
    const tag = kind === "m" ? "✅ mastered" : "🔁 still learning";
    await editMessage(cq.message.chat.id, cq.message.message_id, `${cq.message.text}\n\n— ${tag}`);
  }
}

async function answerCallback(id, text) {
  await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/answerCallbackQuery`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ callback_query_id: id, text }),
  });
}

async function editMessage(chatId, messageId, text) {
  // Omitting reply_markup removes the inline buttons
  await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/editMessageText`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, message_id: messageId, text }),
  });
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

// ---------- vocab lessons: structured teacher reply + batched CSV rows ----------
// The CSV row is generated in the SAME call as the lesson (no re-extraction pass,
// so translations can't drift). Rows accumulate in the gist; at 15 the batch
// auto-commits as a session CSV, exactly like the old Gemini download flow.

// "튼실하다 뜻" (+ optional context lines below) or "/v 튼실하다" / "/learn ..."
function parseLessonRequest(text) {
  const cmd = text.match(/^\/(?:v|learn)\s+([\s\S]+)/i);
  const body = cmd ? cmd[1].trim() : text;
  const lines = body.split("\n");
  const m = lines[0].match(/^(.{1,40}?)\s*(?:뜻|의 뜻|뜻은)\s*\??$/);
  if (m) return { word: m[1].trim(), sentence: lines.slice(1).join("\n").trim() };
  if (cmd) return { word: lines[0].trim(), sentence: lines.slice(1).join("\n").trim() };
  return null;
}

const LESSON_SCHEMA = {
  type: "object",
  properties: {
    lesson: { type: "string" },
    word: { type: "string" },
    chinese_options: { type: "array", items: { type: "string" } },
    hanja: { type: "string" },
    english: { type: "string" },
    sentence: { type: "string" },
  },
  required: ["lesson", "word", "chinese_options", "hanja", "english", "sentence"],
  additionalProperties: false,
};

const LESSON_SYSTEM =
  "You are Sin Hong's expert, witty Korean teacher, replying inside Telegram. He is a Chinese " +
  "speaker learning Korean.\n\n" +
  "Formatting: the lesson is sent with Telegram HTML parse mode. No markdown (no ##, no **). " +
  "The ONLY tags allowed are <b> and <i>: wrap the target word and 2-4 genuinely key terms in " +
  "<b>…</b>, and Korean example sentences in <i>…</i>. Never use other tags, and write any " +
  "literal &, < or > as &amp;, &lt;, &gt;.\n\n" +
  "Given a Korean word (and optionally a context sentence he met it in), return JSON with:\n\n" +
  '"lesson" — a lesson in exactly this layout:\n\n' +
  "'단어'는 [brief, clear definition in Korean].\n" +
  "[If a context sentence was given: 1-2 sentences of witty or culturally insightful commentary on it.]\n\n" +
  "📖 뜻\n" +
  "- 사전적 정의: [Korean definition(s), numbered if several]\n" +
  "- English: [translations, comma-separated]\n" +
  "- Chinese: [translations with pinyin, comma-separated]\n\n" +
  "💬 문맥\n" +
  "[The specific nuance, cultural context, or humor of his sentence. If no sentence was given, " +
  "explain the most common colloquial usage instead.]\n\n" +
  "🗂 쓰이는 상황\n" +
  '1. [Situation] — "[Korean example]" (中文翻译)\n' +
  '2. [Situation] — "[Korean example]" (中文翻译)\n\n' +
  "💡 선생님의 팁\n" +
  "[Short, personalized tip using a practical real-world scenario.]\n" +
  '"[Korean example]" (中文)\n\n' +
  "✍️ 연습해 봅시다!\n" +
  "[A question in Korean prompting him to practice the word.]\n" +
  '(예: "[sample answer]")\n\n' +
  'Keep the lesson under 3000 characters.\n\n' +
  '"word" — the target Korean word/phrase only. No HTML in any field except "lesson".\n' +
  '"chinese_options" — 2-4 candidate Chinese glosses for the flashcard, each a concise everyday ' +
  "Mandarin term (join close synonyms with /). Sin Hong is MALAYSIAN Chinese: order by what a " +
  "Malaysian/SEA Mandarin speaker actually says — e.g. for 왕세자 put 王储 first and the literal " +
  "hanja reading 王世子 later; include a literal reading only when it is real, natural Chinese. " +
  "NEVER write template labels such as 现代中文核心解释 or 原生韩文汉字.\n" +
  '"hanja" — the word\'s hanja: --- if none, - for each non-hanja syllable (e.g. 事情--, 嫌惡--).\n' +
  '"english" — brief English definition, comma-separated senses.\n' +
  '"sentence" — one natural Korean example sentence followed by its Chinese translation in parentheses. ' +
  "If he gave a context sentence, prefer it (cleaned up / completed) as the example.";

async function vocabLesson({ word, sentence }) {
  const userText = sentence ? `Word: ${word}\nContext sentence: ${sentence}` : `Word: ${word}`;
  const gen = await claude(LESSON_SYSTEM, userText, LESSON_SCHEMA, { model: LESSON_MODEL, maxTokens: 4000 });
  const out = JSON.parse(gen);
  const options = (out.chinese_options || []).map((s) => s.trim()).filter(Boolean);
  const row = {
    word: (out.word || word).trim(),
    definition: `${options[0] || ""} (${(out.hanja || "---").trim()}) / [EN] ${(out.english || "").trim()}`,
    sentence: out.sentence,
  };

  // One tap swaps the flashcard's Chinese gloss (callback_data caps at 64 bytes)
  const choices = options
    .filter((t) => Buffer.byteLength(`d|${row.word}|${t}`, "utf8") <= 64)
    .slice(0, 4)
    .map((t) => ({ text: t, callback_data: `d|${row.word}|${t}` }));
  const buttons = choices.length > 1 ? [choices] : undefined;
  const hint = buttons ? `\n🀄 Flashcard 中文 = ${options[0]} — tap to change, or /def ${row.word} 你的词` : "";

  if (!process.env.GIST_ID) {
    // No batch store yet — save the word straight to today's Bot session instead
    const saved = await commitEntries([row]);
    return { text: out.lesson + "\n\n(Batch tracking needs GIST_ID — saved this word directly.)\n" + saved + hint, buttons };
  }

  const batch = await readGistFile(BATCH_FILE);
  const rows = batch.rows || [];
  const idx = rows.findIndex((r) => r.word === row.word);
  if (idx >= 0) rows[idx] = row; // re-asking a word updates its row, no duplicate
  else rows.push(row);
  await writeGistFile(BATCH_FILE, { rows, startedAt: batch.startedAt || new Date().toISOString() });

  if (rows.length >= BATCH_SIZE) {
    const saved = await flushBatch();
    return { text: out.lesson + `\n\n🚨 Batch complete (${BATCH_SIZE}/${BATCH_SIZE})! Auto-saving…\n` + saved + hint, buttons };
  }
  return { text: out.lesson + `\n\n[Batch ${rows.length}/${BATCH_SIZE}]` + hint, buttons };
}

// Swap the Chinese part of a stored definition, keeping (hanja) / [EN] intact
function swapChinese(def, chinese) {
  const m = (def || "").match(/^.*?(\([^)]*\))\s*\/\s*\[EN\]\s*(.*)$/);
  return m ? `${chinese} ${m[1]} / [EN] ${m[2]}` : `${chinese} (---) / [EN] ${def || ""}`;
}

// Update a word's flashcard Chinese — in the pending batch if it's there,
// otherwise in the committed session CSVs (newest first).
async function applyDefinition(word, chinese) {
  if (process.env.GIST_ID) {
    const batch = await readGistFile(BATCH_FILE);
    const rows = batch.rows || [];
    const r = rows.find((x) => x.word === word);
    if (r) {
      r.definition = swapChinese(r.definition, chinese);
      await writeGistFile(BATCH_FILE, batch);
      return `${word} → ${chinese} ✓ (in current batch)`;
    }
  }
  const manifest = JSON.parse(await githubRaw("sessions.json"));
  const csvEscape = (s) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  for (const entry of [...manifest].reverse()) {
    const rows = parseCSV(await githubRaw(entry.file));
    const idx = rows.findIndex((r, i) => i > 0 && (r[0] || "").trim() === word);
    if (idx > 0) {
      rows[idx][1] = swapChinese(rows[idx][1], chinese);
      const csv = rows.map((r) => r.map(csvEscape).join(",")).join("\n") + "\n";
      await ghPut(entry.file, csv, `Bot: set ${word} 中文 to ${chinese}`);
      return `${word} → ${chinese} ✓ (updated in ${entry.label}; app refreshes in ~1 min)`;
    }
  }
  return `Couldn't find ${word} in the batch or any session.`;
}

async function batchStatus() {
  if (!process.env.GIST_ID) return "Batch tracking needs GIST_ID set up first — ask Claude to finish Phase 0.";
  const rows = (await readGistFile(BATCH_FILE)).rows || [];
  if (!rows.length) return 'Batch is empty — send a word (e.g. "튼실하다 뜻") to start one.';
  return (
    `Current batch (${rows.length}/${BATCH_SIZE}):\n` +
    rows.map((r, i) => `${i + 1}. ${r.word} — ${r.definition}`).join("\n") +
    "\n\n/csv to save it to the flashcard app now."
  );
}

async function flushBatch() {
  if (!process.env.GIST_ID) return "Batch tracking needs GIST_ID set up first — ask Claude to finish Phase 0.";
  const rows = (await readGistFile(BATCH_FILE)).rows || [];
  if (!rows.length) return "Nothing to save — the batch is empty.";
  const saved = await commitEntries(rows);
  await writeGistFile(BATCH_FILE, { rows: [], startedAt: null });
  return saved;
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
  return commitEntries(entries);
}

// Commit entries [{word, definition, sentence}] to today's Bot session
// (creating the CSV + manifest entry if needed). Shared by /add and batch flush.
async function commitEntries(entries) {
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

async function sendTelegram(chatId, text, opts = {}) {
  // Telegram messages cap at 4096 chars
  const post = (payload) =>
    fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  for (let i = 0; i < text.length; i += 4000) {
    const chunk = text.slice(i, i + 4000);
    // Inline buttons (e.g. Chinese-gloss choices) attach to the last chunk only
    const markup = opts.buttons && i + 4000 >= text.length ? { reply_markup: { inline_keyboard: opts.buttons } } : {};
    let r = await post({ chat_id: chatId, text: chunk, ...markup, ...(opts.html ? { parse_mode: "HTML" } : {}) });
    if (!r.ok && opts.html) {
      // Model produced invalid HTML (or a tag got split across chunks) — strip tags, send plain
      r = await post({ chat_id: chatId, text: chunk.replace(/<\/?(b|i|u|s|code|pre)>/gi, ""), ...markup });
    }
    if (!r.ok) throw new Error(`Telegram send: ${r.status}`);
  }
}
