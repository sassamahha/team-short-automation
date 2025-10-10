// scripts/seed_to_yaml.js
// Seeds pool -> EN master YAML (random, non-repeating, with retry/validation)
// usage: node scripts/seed_to_yaml.js --count=3
// env: OPENAI_API_KEY (required), OPENAI_MODEL (optional; default gpt-4o-mini)

const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const yaml = require("js-yaml");
const { OpenAI } = require("openai");

const MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";
const TODAY = new Date().toISOString().slice(0, 10);
const COUNT = parseInt((process.argv.find(a => a.startsWith("--count=")) || "").split("=")[1] || "3", 10);

const POOL_DIR = path.join("data", "seeds");
const STATE_DIR = path.join("data", "_state");
const USED_FILE = path.join(STATE_DIR, "used_seeds.json");

function outPathEN(date) {
  return path.join("data", "en", `${date}.yaml`);
}
function unique(arr) { return [...new Set(arr)]; }

async function loadPool() {
  if (!fs.existsSync(POOL_DIR)) throw new Error(`seeds dir not found: ${POOL_DIR}`);
  const files = fs.readdirSync(POOL_DIR).filter(f => f.endsWith(".txt"));
  let lines = [];
  for (const f of files) {
    const txt = await fsp.readFile(path.join(POOL_DIR, f), "utf8");
    const arr = txt.split(/\r?\n/).map(s => s.trim()).filter(s => s && !s.startsWith("#"));
    lines.push(...arr);
  }
  return unique(lines);
}
async function loadUsed() { try { return JSON.parse(await fsp.readFile(USED_FILE, "utf8")); } catch { return []; } }
async function saveUsed(used) {
  await fsp.mkdir(STATE_DIR, { recursive: true });
  await fsp.writeFile(USED_FILE, JSON.stringify(used, null, 2), "utf8");
}
function sampleNoReplace(arr, k) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a.slice(0, Math.min(k, a.length));
}

async function askOpenAI(client, seed) {
  const prompt = `You generate content for a 10-second mindset/self-help YouTube Short.

Seed (title idea, may be Japanese or English):
"${seed}"

Write YAML with keys: title, items (exactly 8 bullets), cta, tags (2-4).
Constraints:
- English output only (natural and concise).
- Bullets are concrete, <= 10 words, actionable.
- Avoid vague platitudes. CTA is a short imperative line.`;

  const r = await client.chat.completions.create({
    model: MODEL,
    temperature: 0.3,
    messages: [
      { role: "system", content: "Output only valid YAML. No explanations." },
      { role: "user", content: prompt }
    ]
  });
  return (r.choices?.[0]?.message?.content || "").trim();
}

function normalizeEntry(yamlStr, fallbackTitle) {
  let obj = {};
  try { obj = yaml.load(yamlStr) || {}; } catch { obj = {}; }
  let items = Array.isArray(obj.items) ? obj.items.map(s => String(s || "").trim()).filter(Boolean).slice(0, 8) : [];
  const tags = Array.isArray(obj.tags) ? obj.tags.map(s => String(s || "").trim()).filter(Boolean).slice(0, 4) : ["mindset", "small wins"];
  return {
    title: (obj.title && String(obj.title).trim()) || fallbackTitle,
    items,
    cta: (obj.cta && String(obj.cta).trim()) || "Save and try one today",
    tags
  };
}
function isValid(entry) {
  if (!entry) return false;
  if (!entry.title) return false;
  const n = Array.isArray(entry.items) ? entry.items.filter(Boolean).length : 0;
  return n >= 4; // 最低4行は欲しい。満たさなければNG
}
async function genOne(client, seed) {
  for (let i = 0; i < 2; i++) {            // 最大2回再生成
    const y = await askOpenAI(client, seed);
    const e = normalizeEntry(y, seed);
    if (isValid(e)) return e;
  }
  console.warn("[warn] generation invalid, skip:", seed);
  return null;
}

async function main() {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY missing");
  const client = new OpenAI({ apiKey });

  const pool = await loadPool();
  let used = await loadUsed();

  // pick from remaining; if insufficient, reset usage
  const remaining = pool.filter(s => !used.includes(s));
  const source = remaining.length >= COUNT ? remaining : pool;
  if (remaining.length < COUNT) used = []; // reset

  const picks = sampleNoReplace(source, COUNT);

  const entries = [];
  for (const seed of picks) {
    const e = await genOne(client, seed);
    if (e) entries.push(e);
  }
  if (!entries.length) throw new Error("no valid entries generated");

  await fsp.mkdir(path.join("data", "en"), { recursive: true });
  await fsp.writeFile(outPathEN(TODAY), yaml.dump({ entries }, { lineWidth: 1000 }), "utf8");
  console.log(`[ok] wrote ${outPathEN(TODAY)} (${entries.length} entries)`);

  const newUsed = unique([...used, ...picks]);
  await saveUsed(newUsed);
  console.log(`[state] used ${newUsed.length}/${pool.length} seeds tracked`);
}

main().catch(e => { console.error(e); process.exit(1); });
