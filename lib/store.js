// Shared review-queue store, kept in a private GitHub Gist so writes never
// touch the repo (a repo commit would trigger a Vercel redeploy on every tap).
//
// Data model — a map keyed by the Korean word:
//   { "<korean>": { def, sentence, count, forgotAt, lastSent } }
//   - count:    how many times it's been marked "forgot"
//   - forgotAt: ISO timestamp of the most recent forgot
//   - lastSent: ISO timestamp of the last daily push (null = never sent)
//
// Requires env: GIST_ID, and GITHUB_TOKEN with the "Gists" account permission.

const GIST_FILE = "weak_words.json";

function ghHeaders(extra = {}) {
  const h = { "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "vocab-bot", ...extra };
  if (process.env.GITHUB_TOKEN) h.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  return h;
}

// The gist holds one JSON file per concern (weak_words.json, vocab_batch.json, …)
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

// Back-compat wrappers for the review queue
const readGist = () => readGistFile(GIST_FILE);
const writeGist = (obj) => writeGistFile(GIST_FILE, obj);

module.exports = { ghHeaders, readGist, writeGist, readGistFile, writeGistFile };
