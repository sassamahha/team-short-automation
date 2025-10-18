// scripts/seed_to_yaml.js
// Seeds (by categories/weights) -> EN master YAML (robust)
// - JSON strict 出力 + バリデーション + リトライ + フォールバック
// - solo（個人習慣）/ team（チームハック）の両プロファイル対応
//
// usage:
//   node scripts/seed_to_yaml.js --count=3
//   node scripts/seed_to_yaml.js --count=5 --cats=habits8,steady
//   node scripts/seed_to_yaml.js --count=5 --cats=rituals:2,ops:1 --profile=team
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
const PROFILE = (process.argv.find(a=>a.startsWith("--profile="))||"").split("=")[1] || (process.env.PROFILE || "solo"); // "solo" | "team"

const POOL_ROOT = path.join("data","seeds");
const STATE_DIR = path.join("data","_state");
const USED_FILE = path.join(STATE_DIR, "used_seeds.json");

function outPathEN(date){ return path.join("data","en",`${date}.yaml`); }
function unique(arr){ return [...new Set(arr)]; }
const stripCtrl = s => String(s||"").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g,"");
const clean = s => stripCtrl(String(s||"").replace(/\u00A0/g," ")).trim();

const MIN_ITEMS = 3;
const MAX_ITEMS = 7;
const WORDS_MAX  = 10;

// ===== 判定・補正ユーティリティ =====
const PHYSICAL_VERBS = [
  "stand","walk","stretch","breathe","drink","move","sit","run","shake",
  "jump","squat","push","pull","hydrate","smile","clap"
];
const IMPERATIVE_SEEDS = [
  "Start","Stop","Set","Keep","Limit","Cut","Open","Close",
  "Write","Plan","List","Clear","Tidy","Clean","Mute","Silence",
  "Stand","Walk","Stretch","Breathe","Drink","Focus","Move","Pause","Share","Post","Schedule","Host","Celebrate","Rotate"
];

// チームハック固有
const RITUAL_KEYWORDS = [
  "standup","check-in","checkin","retro","retrospective","demo","sync","daily","weekly","round-robin","kudos","shoutouts","wins","rose","thorn","bud","icebreaker","heartbeat","huddle"
];
const TOOL_KEYWORDS = [
  "Slack","Notion","Jira","Miro","Docs","Drive","Calendar","Zoom","Meet","Trello","ClickUp","Asana"
];

const hasDigit = s => /\d/.test(String(s||""));
const hasBodyAction = s => new RegExp(`\\b(${PHYSICAL_VERBS.join("|")})\\b`,"i").test(String(s||""));
const hasRitual     = s => new RegExp(`\\b(${RITUAL_KEYWORDS.join("|")})\\b`,"i").test(String(s||""));
const hasTool       = s => new RegExp(`\\b(${TOOL_KEYWORDS.join("|")})\\b`,"i").test(String(s||""));

function imperativeize(line){
  const t = clean(line);
  if (!t) return t;
  const first = t.split(/\s+/)[0].replace(/[^A-Za-z\-]/g,"");
  const isVerbish = new RegExp(`^(${IMPERATIVE_SEEDS.join("|")})$`,"i").test(first);
  if (isVerbish) return t;
  return `Start ${t}`;
}

function wordTrim(line, max=WORDS_MAX){
  const parts = clean(line).split(/\s+/);
  if (parts.length <= max) return clean(line);
  return parts.slice(0, max).join(" ");
}

function normalizeItems(rawItems, opts){
  const { requireDigit=true, requireBody=true, requireRitual=false, requireTool=false } = (opts||{});

  // 1) clean + dedupe（大小無視）
  let items = (Array.isArray(rawItems) ? rawItems : [])
      .map(clean).filter(Boolean);
  const seen = new Set();
  items = items.filter(x=>{
    const key = x.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // 2) imperativeize + trim length
  items = items.map(x => wordTrim(imperativeize(x), WORDS_MAX));

  // 3) 現状把握
  let anyDigit = items.some(hasDigit);
  let anyBody  = items.some(hasBodyAction);
  let anyRitual= items.some(hasRitual);
  let anyTool  = items.some(hasTool);

  // 4) 不足の注入（優先順：儀式→ツール→数字→体）
  if (requireRitual && !anyRitual) items.unshift("Run a 10-minute standup round-robin");
  if (requireTool   && !anyTool)   items.unshift("Post a daily check-in thread on Slack");
  if (requireDigit  && !anyDigit)  items.unshift("Set a 2-minute timer for focus");
  if (requireBody   && !anyBody)   items.unshift("Stand and stretch your back together");

  // 5) >MAX → 優先項目を残して絞る
  if (items.length > MAX_ITEMS){
    const keep = [];
    const pushUnique = x => { if (!keep.includes(x)) keep.push(x); };
    // 優先：儀式/ツール/体/数字/残り
    items.filter(hasRitual).forEach(pushUnique);
    items.filter(x => hasTool(x) && !keep.includes(x)).forEach(pushUnique);
    items.filter(x => hasBodyAction(x) && !keep.includes(x)).forEach(pushUnique);
    items.filter(x => hasDigit(x) && !keep.includes(x)).forEach(pushUnique);
    items.filter(x => !keep.includes(x)).forEach(pushUnique);
    items = keep.slice(0, MAX_ITEMS);
  }

  // 6) <MIN → パッド
  const padPool = [
    "Give three kudos in team channel",
    "Share one tiny win before lunch",
    "Schedule a weekly demo on Calendar",
    "Limit meetings to 25 minutes",
    "Write one-line goal in Notion"
  ];
  while (items.length < MIN_ITEMS){
    const cand = padPool[items.length % padPool.length];
    items.push(wordTrim(imperativeize(cand), WORDS_MAX));
  }

  return items;
}

// ====== seeds I/O ======
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

// ====== OpenAI ======
function buildUserPrompt(seed, profile){
  if (profile === "team"){
    // チームハック用：明確なターゲット/痛み/導線を指示
    return `
Seed (title idea; may be JP/EN):
"${seed}"

You write ultra-practical micro "Team Hacks" for 10–15s YouTube Shorts.
Target: hands-on leaders of hybrid/remote teams of 10–80 people
 (team leads, PMs, Scrum Masters, product managers, small founders).
Pains: scattered attention, fewer casual chats, low praise loop,
 too many meetings, rituals not sticking. Desired: a lightweight,
 visible "connection" gimmick they can test today (free), then
 upgrade later with a physical trigger (e.g., team tokens).

Return STRICT JSON with keys:
- "title": <= 60 chars, clear and engaging
- "items": array of 3–7 bullets, each 4–10 words
  * Each bullet MUST start with an imperative verb
  * Include at least ONE numeric digit (e.g., 2, 30s, 9 tabs)
  * Include at least ONE body-based micro action (stand, walk, stretch, breathe, drink)
  * Include at least ONE team ritual cue (standup, check-in, retro, demo, kudos)
  * Include at least ONE tool cue (Slack, Notion, Jira, Calendar, Zoom)
- "cta": very short imperative line that hints
  "Run free today → upgrade later"
- "tags": 2–4 simple tags (e.g., team, ritual, small wins)

Rules:
- Output MUST be English.
- No markdown or code fences. JSON object only.
- Keep everyday language. No corporate jargon. Avoid duplicates.
`.trim();
  }

  // 既存：個人習慣（Small Success Habits）
  return `
Seed (title idea; may be JP/EN):
"${seed}"

You generate concise, practical self-improvement content for 10–15s YouTube Shorts.

Return STRICT JSON with keys:
- "title": <= 60 chars, clear and engaging
- "items": array of 3–7 bullets, each 4–10 words
  * Each bullet MUST start with an imperative verb
  * Include at least ONE numeric digit (e.g., 2, 30s, 9 tabs)
  * Include at least ONE body-based micro action (stand, walk, stretch, breathe, drink)
- "cta": very short imperative line
- "tags": 2–4 simple tags

Rules:
- Output MUST be English.
- No markdown or code fences. JSON object only.
- Avoid duplicates. Keep everyday language. Use digits for numbers.
`.trim();
}

async function askOpenAI_JSON(client, seed, profile){
  const sys = profile === "team"
    ? "You generate ultra-practical micro 'Team Hacks' for hybrid/remote teams."
    : "You generate concise, practical self-improvement content for Shorts.";
  const user = buildUserPrompt(seed, profile);

  const r = await client.chat.completions.create({
    model: MODEL,
    temperature: 0.3,
    messages: [{role:"system",content:sys},{role:"user",content:user}],
    response_format: { type: "json_object" }
  });
  return r.choices?.[0]?.message?.content || "{}";
}

function hasCJK(s){ return /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(String(s||"")); }

function looksEnglishShort(s){
  if (!s || typeof s !== "string") return false;
  if (hasCJK(s)) return false;
  return true;
}

function validEnglishEntry(obj){
  if (!obj || typeof obj !== "object") return false;
  const title = clean(obj.title);
  const items = Array.isArray(obj.items) ? obj.items.map(clean).filter(Boolean) : [];
  if (!looksEnglishShort(title)) return false;
  if (!items.length) return false; // 数は後段で正規化
  if (items.some(hasCJK)) return false;
  return true;
}

// ====== フォールバック ======
function fallbackEntryFrom(seed, profile){
  const base = clean(seed) || (profile==="team" ? "Tiny team wins to try today" : "Tiny wins to reset your day");
  let title = base.length > 60 ? base.slice(0,57) + "..." : base;

  const itemsSolo = [
    "Set a 2-minute timer",
    "Drink a glass of water",
    "Stand and stretch your back",
    "Breathe slowly for 30 seconds",
    "Write one line in a journal"
  ];
  const itemsTeam = [
    "Post a daily check-in thread on Slack",
    "Run a 10-minute standup round-robin",
    "Give three kudos in team channel",
    "Limit meetings to 25 minutes",
    "Stand and stretch together for 60 seconds"
  ];

  const items = (profile==="team" ? itemsTeam : itemsSolo);
  const normalized = normalizeItems(items, {
    requireDigit: true,
    requireBody: true,
    requireRitual: profile==="team",
    requireTool:   profile==="team"
  });

  return {
    title,
    items: normalized,
    cta: profile==="team" ? "Run free today, upgrade later" : "Save and try one today",
    tags: profile==="team" ? ["team","ritual","small wins"] : ["mindset","small wins"]
  };
}

async function generateOne(client, seed, profile){
  for (let attempt=0; attempt<2; attempt++){
    try{
      const json = await askOpenAI_JSON(client, seed, profile);
      let obj;
      try { obj = JSON.parse(json); } catch { obj = {}; }
      if (!validEnglishEntry(obj)) throw new Error("validation failed");

      const items = normalizeItems(obj.items, {
        requireDigit: true,
        requireBody:  true,
        requireRitual: profile==="team",
        requireTool:   profile==="team"
      });

      const out = {
        title: clean(obj.title),
        items,
        cta: clean(obj.cta) || (profile==="team" ? "Run free today, upgrade later" : "Save and try one today"),
        tags: (Array.isArray(obj.tags) && obj.tags.length
                ? obj.tags.map(x=>clean(x)).slice(0,4)
                : (profile==="team" ? ["team","ritual","small wins"] : ["mindset","small wins"]))
      };
      return out;
    }catch(e){
      // retry
    }
  }
  return fallbackEntryFrom(seed, profile);
}

// ====== main ======
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
    const e = await generateOne(client, s.text, PROFILE);
    entries.push(e);
  }

  await fsp.mkdir(path.join("data","en"), { recursive:true });
  await fsp.writeFile(outPathEN(TODAY), yaml.dump({ entries }, { lineWidth: 1000 }), "utf8");
  console.log(`[ok] wrote ${outPathEN(TODAY)} (${entries.length} entries) [profile=${PROFILE}]`);

  const newUsed = unique([...used.map(u=>`${u.cat}::${u.text}`), ...picks.map(u=>`${u.cat}::${u.text}`)])
    .map(key => { const [cat,text] = key.split("::"); return { cat, text }; });
  await saveUsed(newUsed);
  console.log(`[state] used ${newUsed.length}/${poolAll.length} seeds tracked`);
}

main().catch(e=>{ console.error(e); process.exit(1); });
