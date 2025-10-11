// scripts/seed_to_yaml.js
// Seeds (optionally by categories with weights) -> EN master YAML (random, non-repeating)
// usage:
//   node scripts/seed_to_yaml.js --count=3
//   node scripts/seed_to_yaml.js --count=5 --cats=habits8,steady
//   node scripts/seed_to_yaml.js --count=5 --cats=habits8:2,steady:1
// env: OPENAI_API_KEY (required), OPENAI_MODEL (optional; default gpt-4o-mini)

const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const yaml = require("js-yaml");
const { OpenAI } = require("openai");

const MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";
const TODAY = new Date().toISOString().slice(0,10);
const COUNT = parseInt((process.argv.find(a=>a.startsWith("--count="))||"").split("=")[1] || "3", 10);

// --cats=catA,catB  or  --cats=catA:2,catB:1
const CATS_ARG = (process.argv.find(a=>a.startsWith("--cats="))||"").split("=")[1] || "";

const POOL_ROOT = path.join("data","seeds");
const STATE_DIR = path.join("data","_state");
const USED_FILE = path.join(STATE_DIR, "used_seeds.json");

function outPathEN(date){ return path.join("data","en",`${date}.yaml`); }
function unique(arr){ return [...new Set(arr)]; }

function parseCats(arg){
  if (!arg) return null; // 全カテゴリ
  const m = {};
  arg.split(",").map(s=>s.trim()).filter(Boolean).forEach(tok=>{
    const [name,wRaw] = tok.split(":");
    const w = Math.max(1, parseInt(wRaw||"1",10));
    m[name] = w;
  });
  return m; // { habits8:2, steady:1 }
}

async function listCategories(){
  if (!fs.existsSync(POOL_ROOT)) return [];
  return fs.readdirSync(POOL_ROOT)
    .filter(d => fs.statSync(path.join(POOL_ROOT,d)).isDirectory());
}

async function loadPoolByCategory(cat){
  const dir = path.join(POOL_ROOT, cat);
  if (!fs.existsSync(dir)) return [];
  const files = fs.readdirSync(dir).filter(f=>f.endsWith(".txt"));
  let lines = [];
  for (const f of files){
    const txt = await fsp.readFile(path.join(dir,f),"utf8");
    const arr = txt.split(/\r?\n/).map(s=>s.trim()).filter(s=>s && !s.startsWith("#"));
    // seed文面にカテゴリを結合して一意管理
    lines.push(...arr.map(x => ({ text:x, cat })));
  }
  // 重複テキストでもカテゴリが違えば別物として扱う
  // 同一カテゴリ内の重複は落とす
  const seen = new Set();
  const out = [];
  for (const it of lines){
    const key = it.text; // 同カテゴリ内は text 一意
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(it);
  }
  return out;
}

async function loadPoolFiltered(catsWeights){
  // catsWeights=null のとき、全カテゴリ対象
  const cats = catsWeights ? Object.keys(catsWeights) : await listCategories();
  let pool = [];
  for (const c of cats){
    pool.push(...await loadPoolByCategory(c));
  }
  return pool;
}

async function loadUsed(){
  try { return JSON.parse(await fsp.readFile(USED_FILE,"utf8")); }
  catch { return []; }
}
async function saveUsed(used){
  await fsp.mkdir(STATE_DIR, { recursive:true });
  await fsp.writeFile(USED_FILE, JSON.stringify(used,null,2), "utf8");
}

function buildRemaining(pool, used){
  const usedSet = new Set(used.map(u => `${u.cat}::${u.text}`));
  return pool.filter(s => !usedSet.has(`${s.cat}::${s.text}`));
}

// 重み付きサンプリング（カテゴリ重み）→ カテゴリを先に引いてからそのカテゴリの未使用を1件取る
function weightedPickCategory(remaining, catsWeights){
  if (!catsWeights) return null; // 使わない
  const byCat = {};
  for (const it of remaining){
    (byCat[it.cat] ||= []).push(it);
  }
  const entries = Object.entries(byCat).filter(([cat,arr]) => arr.length>0);
  if (!entries.length) return null;

  // 重み表（カテゴリ未指定は重み=1）
  const weighted = [];
  for (const [cat, arr] of entries){
    const w = (catsWeights[cat] || 1);
    if (w <= 0) continue;
    weighted.push({ cat, weight:w, size:arr.length });
  }
  if (!weighted.length) return null;

  const sum = weighted.reduce((a,b)=>a+b.weight,0);
  let r = Math.random() * sum;
  for (const w of weighted){
    if ((r -= w.weight) <= 0) return w.cat;
  }
  return weighted[weighted.length-1].cat;
}

function pickOneFromCategory(remaining, cat){
  const arr = remaining.filter(s => s.cat === cat);
  if (!arr.length) return null;
  const i = Math.floor(Math.random()*arr.length);
  return arr[i];
}

function sampleWithCategoryWeights(pool, count, catsWeights){
  const picks = [];
  let remaining = pool.slice();

  while (picks.length < Math.min(count, pool.length)){
    // 1) 重みでカテゴリを選ぶ（未指定なら null）
    let chosenCat = weightedPickCategory(remaining, catsWeights);

    // 2) カテゴリ未指定 or そのカテゴリが空：全体からランダム
    let pick = null;
    if (!chosenCat){
      const i = Math.floor(Math.random()*remaining.length);
      pick = remaining[i];
    }else{
      pick = pickOneFromCategory(remaining, chosenCat) || remaining[Math.floor(Math.random()*remaining.length)];
    }

    // 3) 追加 & remaining から除外
    picks.push(pick);
    remaining = remaining.filter(s => !(s.cat===pick.cat && s.text===pick.text));
  }
  return picks;
}

async function askOpenAI(client, seed){
  const prompt = `You generate content for a 10-second mindset/self-help YouTube Short.

Seed (title idea, may be Japanese or English):
"${seed}"

Write YAML with keys: title, items (exactly 8 bullets), cta, tags (2-4).
Constraints:
- English output only (natural and concise).
- Bullets are concrete, ≤ 10 words, actionable.
- Avoid vague platitudes. CTA is a short imperative line.`;

  const r = await client.chat.completions.create({
    model: MODEL,
    temperature: 0.3,
    messages: [
      { role: "system", content: "Output only valid YAML. No explanations." },
      { role: "user", content: prompt }
    ]
  });
  return r.choices?.[0]?.message?.content?.trim() || "";
}

function normalizeEntry(yamlStr, fallbackTitle){
  let obj = {};
  try { obj = yaml.load(yamlStr) || {}; } catch { obj = {}; }

  let items = Array.isArray(obj.items) ? obj.items.slice(0,8) : [];
  while (items.length < 8) items.push("");

  const tags = Array.isArray(obj.tags) && obj.tags.length
    ? obj.tags.slice(0,4) : ["mindset","small wins"];

  return {
    title: obj.title || fallbackTitle,
    items,
    cta: obj.cta || "Save and try one today",
    tags
  };
}

async function main(){
  if (!process.env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY missing");
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  const catsWeights = parseCats(CATS_ARG);                      // null or {cat:weight}
  const poolAll = await loadPoolFiltered(catsWeights);          // [{text,cat},...]
  if (!poolAll.length) throw new Error("no seeds found under data/seeds");

  let used = await loadUsed();                                  // [{text,cat},...]
  let remaining = buildRemaining(poolAll, used);
  if (remaining.length < COUNT){
    // リセット（全プールから）
    used = [];
    remaining = poolAll.slice();
  }

  const picks = catsWeights
    ? sampleWithCategoryWeights(remaining, COUNT, catsWeights)
    : sampleWithCategoryWeights(remaining, COUNT, null);

  const entries = [];
  for (const s of picks){
    const y = await askOpenAI(client, s.text);
    const norm = normalizeEntry(y, s.text);
    entries.push(norm);
  }

  await fsp.mkdir(path.join("data","en"), { recursive:true });
  await fsp.writeFile(outPathEN(TODAY), yaml.dump({ entries }, { lineWidth: 1000 }), "utf8");
  console.log(`[ok] wrote ${outPathEN(TODAY)} (${entries.length} entries)`);

  const newUsed = unique([...used.map(u=>`${u.cat}::${u.text}`), ...picks.map(u=>`${u.cat}::${u.text}`)])
    .map(key => { const [cat,text] = key.split("::"); return { cat, text }; });
  await saveUsed(newUsed);
  console.log(`[state] used ${newUsed.length}/${poolAll.length} seeds tracked`);
}

main().catch(e=>{ console.error(e); process.exit(1); });
