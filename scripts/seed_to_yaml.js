// scripts/seed_to_yaml.js
// Seeds (by categories/weights) -> EN master YAML (robust)
// - JSON strict 出力 + バリデーション + リトライ + フォールバック
// usage:
//   node scripts/seed_to_yaml.js --count=3
//   node scripts/seed_to_yaml.js --count=5 --cats=habits8,steady
//   node scripts/seed_to_yaml.js --count=5 --cats=habits8:2,steady:1
//
// env: OPENAI_API_KEY (required), OPENAI_MODEL (optional; default gpt-4o-mini)

const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const yaml = require("js-yaml");
const { OpenAI } = require("openai");

const MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";
const TODAY = new Date().toISOString().slice(0,10);
const COUNT = parseInt((process.argv.find(a=>a.startsWith("--count="))||"").split("=")[1] || "3", 10);
const CATS_ARG = (process.argv.find(a=>a.startsWith("--cats="))||"").split("=")[1] || "";

const POOL_ROOT = path.join("data","seeds");
const STATE_DIR = path.join("data","_state");
const USED_FILE = path.join(STATE_DIR, "used_seeds.json");

function outPathEN(date){ return path.join("data","en",`${date}.yaml`); }
function unique(arr){ return [...new Set(arr)]; }
const stripCtrl = s => String(s||"").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g,"");
const clean = s => stripCtrl(String(s||"").replace(/\u00A0/g," ")).trim();

function parseCats(arg){
  if (!arg) return null;
  const m = {};
  arg.split(",").map(s=>s.trim()).filter(Boolean).forEach(tok=>{
    const [name,wRaw] = tok.split(":");
    const w = Math.max(1, parseInt(wRaw||"1",10));
    m[name] = w;
  });
  return m;
}

async function listCategories(){
  if (!fs.existsSync(POOL_ROOT)) return [];
  return fs.readdirSync(POOL_ROOT).filter(d => fs.statSync(path.join(POOL_ROOT,d)).isDirectory());
}

async function loadPoolByCategory(cat){
  const dir = path.join(POOL_ROOT, cat);
  if (!fs.existsSync(dir)) return [];
  const files = fs.readdirSync(dir).filter(f=>f.endsWith(".txt"));
  let lines = [];
  for (const f of files){
    const txt = await fsp.readFile(path.join(dir,f),"utf8");
    const arr = txt.split(/\r?\n/).map(s=>s.trim()).filter(s=>s && !s.startsWith("#"));
    lines.push(...arr.map(x => ({ text:x, cat })));
  }
  const seen = new Set(); const out=[];
  for (const it of lines){
    const key = it.text;
    if (seen.has(key)) continue;
    seen.add(key); out.push(it);
  }
  return out;
}

async function loadPoolFiltered(catsWeights){
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

function weightedPickCategory(remaining, catsWeights){
  if (!catsWeights) return null;
  const byCat = {};
  for (const it of remaining){ (byCat[it.cat] ||= []).push(it); }
  const entries = Object.entries(byCat).filter(([_,arr])=>arr.length>0);
  if (!entries.length) return null;
  const weighted = entries.map(([cat]) => ({ cat, weight: catsWeights[cat] || 1 }));
  const sum = weighted.reduce((a,b)=>a+b.weight,0);
  let r = Math.random() * sum;
  for (const w of weighted){ if ((r -= w.weight) <= 0) return w.cat; }
  return weighted[weighted.length-1].cat;
}
function pickOneFromCategory(remaining, cat){
  const arr = remaining.filter(s => s.cat === cat);
  if (!arr.length) return null;
  return arr[Math.floor(Math.random()*arr.length)];
}
function sampleWithCategoryWeights(pool, count, catsWeights){
  const picks = []; let remaining = pool.slice();
  while (picks.length < Math.min(count, pool.length)){
    let chosenCat = weightedPickCategory(remaining, catsWeights);
    let pick = chosenCat
      ? (pickOneFromCategory(remaining, chosenCat) || remaining[Math.floor(Math.random()*remaining.length)])
      : remaining[Math.floor(Math.random()*remaining.length)];
    picks.push(pick);
    remaining = remaining.filter(s => !(s.cat===pick.cat && s.text===pick.text));
  }
  return picks;
}

// ---------- OpenAI ----------
async function askOpenAI_JSON(client, seed){
  const sys = "You generate concise, practical self-improvement content for 10-second YouTube Shorts.";
  const user = `
Seed (title idea, may be JP/EN):
"${seed}"

Return STRICT JSON with keys:
- "title" (<= 60 chars, clear, engaging)
- "items" (array of EXACTLY 8 short bullets, each <= 10 words, concrete & actionable)
- "cta" (very short imperative line)
- "tags" (2-4 simple tags)

Requirements:
- Output MUST be English.
- No markdown or code fences. JSON object only.
  `.trim();

  const r = await client.chat.completions.create({
    model: MODEL,
    temperature: 0.3,
    messages: [{role:"system",content:sys},{role:"user",content:user}],
    response_format: { type: "json_object" }
  });
  return r.choices?.[0]?.message?.content || "{}";
}

function hasCJK(s){ return /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(String(s||"")); }
function validEnglishEntry(obj){
  if (!obj || typeof obj !== "object") return false;
  const title = clean(obj.title);
  const items = Array.isArray(obj.items) ? obj.items.map(clean).filter(Boolean) : [];
  if (!title || items.length !== 8) return false;
  // 英語ガード（CJK が多いなら弾く）
  if (hasCJK(title) || items.some(hasCJK)) return false;
  return true;
}

// ---------- フォールバック（安全テンプレ） ----------
const FALLBACK_ACTIONS = [
  "Write one line in a journal",
  "Drink a glass of water",
  "Breathe slowly for 30 seconds",
  "Tidy one small spot on desk",
  "Stand and stretch your back",
  "Send a thank-you message",
  "Walk for two minutes",
  "Plan one tiny next step"
];
function fallbackEntryFrom(seed){
  const base = clean(seed) || "8 tiny steps to reset your day";
  // タイトル調整
  let title = base;
  if (title.length > 60) title = title.slice(0,57) + "...";
  const items = [];
  // 8個になるまでローテーション
  let i = 0;
  while (items.length < 8){
    items.push(FALLBACK_ACTIONS[i % FALLBACK_ACTIONS.length]);
    i++;
  }
  return {
    title,
    items,
    cta: "Save and try one today",
    tags: ["mindset","small wins"]
  };
}

async function generateOne(client, seed){
  // 最大2回リトライ → フォールバック
  for (let attempt=0; attempt<2; attempt++){
    try{
      const json = await askOpenAI_JSON(client, seed);
      let obj;
      try { obj = JSON.parse(json); } catch { obj = {}; }
      if (!validEnglishEntry(obj)) throw new Error("validation failed");
      // 最終整形
      const out = {
        title: clean(obj.title),
        items: obj.items.map(x => clean(x)).slice(0,8),
        cta: clean(obj.cta) || "Save and try one today",
        tags: (Array.isArray(obj.tags) && obj.tags.length ? obj.tags : ["mindset","small wins"])
                .map(x=>clean(x)).slice(0,4)
      };
      return out;
    }catch(e){
      // 次のループで再試行
    }
  }
  // だめならフォールバック
  return fallbackEntryFrom(seed);
}

async function main(){
  if (!process.env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY missing");
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  const catsWeights = parseCats(CATS_ARG);
  const poolAll = await loadPoolFiltered(catsWeights);
  if (!poolAll.length) throw new Error("no seeds found under data/seeds");

  let used = await loadUsed();
  let remaining = buildRemaining(poolAll, used);
  if (remaining.length < COUNT){ used = []; remaining = poolAll.slice(); }

  const picks = sampleWithCategoryWeights(remaining, COUNT, catsWeights || null);

  const entries = [];
  for (const s of picks){
    const e = await generateOne(client, s.text);
    entries.push(e);
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
