// scripts/seed_to_yaml.js
// Seeds pool -> EN master YAML (random, retry, hard-validated, with fallback)
// usage: node scripts/seed_to_yaml.js --count=3
// env: OPENAI_API_KEY (required), OPENAI_MODEL (optional; default gpt-4o-mini), DEBUG_LOG=1

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

function outPathEN(date) { return path.join("data", "en", `${date}.yaml`); }
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
async function saveUsed(used) { await fsp.mkdir(STATE_DIR, { recursive: true }); await fsp.writeFile(USED_FILE, JSON.stringify(used, null, 2), "utf8"); }

function sampleNoReplace(arr, k) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a.slice(0, Math.min(k, a.length));
}

function stripCodeFence(s="") {
  const m = s.match(/```(?:yaml|yml)?\s*([\s\S]*?)```/i);
  return m ? m[1].trim() : s.trim();
}

function fallbackFromSeed(seed) {
  // 失敗時に最低限の弾を作る（超シンプル・確実）
  const base = [
    "Breathe slowly for ten counts",
    "Name the feeling, not the story",
    "Drink water and stand up",
    "Do one tiny task now",
    "Put phone away for two minutes",
    "Write three true sentences",
    "Ask: what helps future me?",
    "Choose one next step only"
  ];
  return {
    title: seed.replace(/^\s*8\s*/i, "8 ").trim() || "8 small resets that help",
    items: base.slice(0, 8),
    cta: "Save and try one today",
    tags: ["mindset","small wins"]
  };
}

function normalizeEntry(yamlStr, fallbackTitle) {
  let obj = {};
  try { obj = yaml.load(yamlStr) || {}; } catch { obj = {}; }
  let items = Array.isArray(obj.items) ? obj.items.map(s => String(s || "").trim()).filter(Boolean).slice(0, 8) : [];
  const tags = Array.isArray(obj.tags) ? obj.tags.map(s => String(s || "").trim()).filter(Boolean).slice(0, 4) : ["mindset","small wins"];
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
  return n >= 6; // 6行以上は欲しい（品質担保）
}

async function askOpenAI(client, seed, temperature=0.3) {
  const prompt =
`You write content for a 10-second mindset/self-help YouTube Short.

SEED (may be Japanese or English):
"${seed}"

Return ONLY YAML with these keys:
- title: (English)
- items: (exactly 8 concise, concrete, actionable bullets, <=10 words)
- cta: (short imperative line)
- tags: (2-4 short tags)

Example:
title: 8 Habits That End Meetings Fast
items:
  - Say the goal in one sentence
  - Name the decision owner first
  - Use pre-reads for info
  - Start from the key issue
  - Surface objections early
  - Stop at three options
  - Assign who & by when
  - Repeat the agreement
cta: Save and apply one today
tags: [productivity, small wins]`;

  const r = await client.chat.completions.create({
    model: MODEL,
    temperature,
    messages: [
      { role: "system", content: "Output only valid YAML. No explanations. No code fences unless it's YAML." },
      { role: "user", content: prompt }
    ]
  });
  const raw = (r.choices?.[0]?.message?.content || "").trim();
  if (process.env.DEBUG_LOG === "1") {
    console.log("---- RAW MODEL OUTPUT ----\n" + raw + "\n--------------------------");
  }
  return stripCodeFence(raw);
}

async function genOne(client, seed) {
  // 最大3回（温度を下げていく）
  for (const t of [0.3, 0.2, 0.1]) {
    const y = await askOpenAI(client, seed, t);
    const e = normalizeEntry(y, seed);
    if (isValid(e)) return e;
  }
  console.warn("[warn] model failed; using fallback for:", seed);
  return fallbackFromSeed(seed);
}

async function main() {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY missing");
  const client = new OpenAI({ apiKey });

  const pool = await loadPool();
  let used = await loadUsed();

  const remaining = pool.filter(s => !used.includes(s));
  const source = remaining.length >= COUNT ? remaining : pool;
  if (remaining.length < COUNT) used = []; // reset

  const picks = sampleNoReplace(source, COUNT);

  const entries = [];
  for (const seed of picks) {
    const e = await genOne(client, seed);
    entries.push(e);
  }

  await fsp.mkdir(path.join("data", "en"), { recursive: true });
  await fsp.writeFile(outPathEN(TODAY), yaml.dump({ entries }, { lineWidth: 1000 }), "utf8");
  console.log(`[ok] wrote ${outPathEN(TODAY)} (${entries.length} entries)`);

  const newUsed = unique([...used, ...picks]);
  await saveUsed(newUsed);
  console.log(`[state] used ${newUsed.length}/${pool.length} seeds tracked`);
}

main().catch(e => { console.error(e); process.exit(1); });
