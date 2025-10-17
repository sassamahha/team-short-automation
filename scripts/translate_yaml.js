// scripts/translate_yaml.js
// EN -> target languages. Robust JSON round-trip, optional lang guard via data/lang_rules.yaml
// usage:
//   node scripts/translate_yaml.js --date=YYYY-MM-DD --langs=ja,es
// env: OPENAI_API_KEY (required), OPENAI_MODEL (optional; default gpt-4o-mini)

const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const yaml = require("js-yaml");
const { OpenAI } = require("openai");

// -------- args / defaults
const ARGS = Object.fromEntries(process.argv.slice(2).map(s => {
  const m = s.match(/^--([^=]+)=(.*)$/); return m ? [m[1], m[2]] : [s.replace(/^--/, ""), true];
}));

const DATE = ARGS.date || new Date().toISOString().slice(0,10);
const LANGS = (ARGS.langs ? String(ARGS.langs) : "ja").split(",").map(s=>s.trim()).filter(Boolean);
const MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";

if (!process.env.OPENAI_API_KEY) {
  console.error("OPENAI_API_KEY missing"); process.exit(1);
}

// -------- paths
const inPathEN  = (d)=> path.join("data","en",`${d}.yaml`);
const outPath   = (d,l)=> path.join("data", l, `${d}.yaml`);
const guardPath = ()=> path.join("data","lang_rules.yaml");

// -------- helpers
function langDisplayName(code){
  const map = {
    en:"English", es:"Spanish", pt:"Portuguese (Brazil)", fr:"French", it:"Italian", de:"German",
    tr:"Turkish", pl:"Polish", vi:"Vietnamese", tl:"Filipino", sw:"Swahili", fa:"Persian (Farsi)",
    ja:"Japanese", ko:"Korean",
    "zh-Hant":"Chinese (Traditional)", zhhant:"Chinese (Traditional)", zh_hant:"Chinese (Traditional)",
    id:"Indonesian", th:"Thai", uk:"Ukrainian",
    hi:"Hindi", bn:"Bengali", ur:"Urdu", ne:"Nepali",
    ar:"Arabic", ms:"Malay", km:"Khmer (Cambodia)", si:"Sinhala (Sri Lanka)", lo:"Lao",
  };
  return map[code] || code;
}

// guard rules loader (optional)
function loadLangRules(){
  const p = guardPath();
  if (!fs.existsSync(p)) {
    // default: only JA validates (CJK), others skip
    return {
      rules: {
        default: { validate: false, min_items_ratio: 0.6 },
        ja: { validate: true, any_scripts: ["Han","Hiragana","Katakana"] }
      }
    };
  }
  try {
    return yaml.load(fs.readFileSync(p,"utf8")) || { rules: { default:{ validate:false, min_items_ratio:0.6 } } };
  } catch {
    return { rules: { default:{ validate:false, min_items_ratio:0.6 } } };
  }
}

function makeScriptRegex(scripts){
  // Node 20+: Unicode property escapes available
  const parts = scripts.map(sc => `\\p{Script=${sc}}`);
  return new RegExp(`(?:${parts.join("|")})`, "u");
}

function validateByRules(rules, lang, title, items){
  const def = (rules.rules && rules.rules.default) || { validate:false, min_items_ratio:0.6 };
  const cfg = (rules.rules && rules.rules[lang]) || def;
  if (!cfg.validate) return true;
  const scripts = cfg.any_scripts || [];
  if (!scripts.length) return true;
  const re = makeScriptRegex(scripts);
  const hasInTitle = re.test(title || "");
  const arr = Array.isArray(items) ? items : [];
  const hits = arr.filter(s => re.test(s || "")).length;
  const ratio = arr.length ? (hits / arr.length) : 0;
  const minr = cfg.min_items_ratio ?? def.min_items_ratio ?? 0.6;
  return !!(hasInTitle && ratio >= minr);
}

function clamp(n, lo, hi){ return Math.max(lo, Math.min(hi, n)); }

// -------- translator
async function translateEntry(client, entry, target, rules){
  const itemsSrc = Array.isArray(entry.items) ? entry.items.filter(Boolean) : [];
  // “可変長”に備える：元が空なら8、あればその本数（3〜10にクランプ）
  const wanted = clamp(itemsSrc.length || 8, 3, 10);

  const sys = `You are a precise translator. Return STRICT JSON only (no markdown).`;
  const user = `
Translate the content from English into ${langDisplayName(target)}.
Keep EXACTLY ${wanted} bullet points (no more, no less).
Bullets must be concrete, actionable, and ≤ 12 words.
Return STRICT JSON with keys: title, items, cta, tags (2-4).

SOURCE(JSON):
${JSON.stringify({
  title: entry.title || "",
  items: itemsSrc.slice(0, wanted),
  cta: entry.cta || "Save and try one today",
  tags: Array.isArray(entry.tags) ? entry.tags.slice(0,4) : []
}, null, 2)}
`.trim();

  const r = await client.chat.completions.create({
    model: MODEL,
    temperature: 0.2,
    messages: [{ role:"system", content: sys }, { role:"user", content: user }],
    response_format: { type: "json_object" }
  });

  let obj;
  try { obj = JSON.parse(r.choices[0].message.content); }
  catch { throw new Error("JSON parse failed from model"); }

  // normalize
  const out = {
    title: String(obj.title || "").trim(),
    items: Array.isArray(obj.items) ? obj.items.map(s=>String(s||"").trim()).filter(Boolean).slice(0, wanted) : [],
    cta: String(obj.cta || "").trim() || "Save and try one today",
    tags: Array.isArray(obj.tags) ? obj.tags.map(s=>String(s||"").trim()).filter(Boolean).slice(0,4) : []
  };

  // language guard（外部設定があれば従う。無ければ ja のみCJKチェック相当）
  if (!validateByRules(rules, target, out.title, out.items)) {
    throw new Error(`lang guard failed for ${target}`);
  }

  return out;
}

// -------- main
(async function main(){
  const enFile = inPathEN(DATE);
  if (!fs.existsSync(enFile)) {
    console.error(`EN yaml not found: ${enFile}`);
    process.exit(0);
  }
  const enDoc = yaml.load(await fsp.readFile(enFile,"utf8")) || {};
  const entries = Array.isArray(enDoc.entries) ? enDoc.entries : [];
  if (!entries.length) {
    console.error("EN entries empty"); process.exit(0);
  }

  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const rules = loadLangRules();

  for (const lg of LANGS){
    const outs = [];
    for (let i=0; i<entries.length; i++){
      try {
        const t = await translateEntry(client, entries[i], lg, rules);
        outs.push(t);
      } catch (err) {
        console.warn(`[warn] translate failed idx=${i+1} lang=${lg}: ${err.message}`);
      }
    }
    if (!outs.length) { console.warn(`[skip] no translated entries for ${lg}`); continue; }

    const outFile = outPath(DATE, lg);
    await fsp.mkdir(path.dirname(outFile), { recursive:true });
    await fsp.writeFile(outFile, yaml.dump({ entries: outs }, { lineWidth: 1000 }), "utf8");
    console.log(`[ok] wrote ${outFile} (${outs.length} entries)`);
  }
})().catch(e=>{ console.error(e); process.exit(1); });
