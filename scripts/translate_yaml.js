// scripts/translate_yaml.js（差し替え）
const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const yaml = require("js-yaml");
const { OpenAI } = require("openai");

const DATE  = new Date().toISOString().slice(0,10);
const LANGS = ((process.argv.find(a=>a.startsWith("--langs="))||"").split("=")[1] || "ja").split(",").map(s=>s.trim()).filter(Boolean);
const MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";

const LANG_NAMES = { ja:"Japanese" };

function hasLatin(s){ return /[A-Za-z]/.test(s || ""); }

function toYamlObject(src){
  return { title: src.title, items: src.items, cta: src.cta, tags: src.tags };
}

async function translateOne(client, target, src){
  const langName = LANG_NAMES[target] || target;
  const sys = `You are a professional translator. Output ONLY valid YAML, no code fences. Translate into ${langName} that is natural, concise, and culturally neutral.`;
  const prompt =
`Translate this JSON into ${langName}. Keep exactly 8 bullets. Keep tags short (2-4). Do not add explanations.
JSON:
${JSON.stringify(toYamlObject(src))}`;

  const run = async (temp)=> {
    const r = await client.chat.completions.create({
      model: MODEL, temperature: temp,
      messages: [{role:"system",content:sys},{role:"user",content:prompt}]
    });
    return (r.choices?.[0]?.message?.content || "").trim();
  };

  // 1st try
  let out = await run(0.2);
  let obj;
  try { obj = yaml.load(out) || {}; } catch { obj = {}; }

  const isJA = target === "ja";
  const bad = isJA && (
    hasLatin(obj?.title) ||
    (Array.isArray(obj?.items) && obj.items.some(hasLatin)) ||
    (obj?.cta && hasLatin(obj.cta))
  );

  if (bad) {
    // retry with harder constraint
    const sys2 = `You are a translation engine. Return YAML only. All output MUST be in ${langName} characters. Latin letters are NOT allowed except common tags.`;
    const r2 = await client.chat.completions.create({
      model: MODEL, temperature: 0.1,
      messages: [{role:"system",content:sys2},{role:"user",content:prompt}]
    });
    out = (r2.choices?.[0]?.message?.content || "").trim();
    try { obj = yaml.load(out) || {}; } catch { obj = {}; }
  }

  // fallback: dumb transliteration using the model
  if (isJA && (hasLatin(obj?.title) || (obj?.items||[]).some(hasLatin) || hasLatin(obj?.cta))) {
    const r3 = await client.chat.completions.create({
      model: MODEL, temperature: 0.1,
      messages: [
        {role:"system",content:"Return plain JSON only."},
        {role:"user",content:`Translate every field into Japanese. Keep 8 items. JSON:\n${JSON.stringify(toYamlObject(src))}`}
      ]
    });
    try { obj = JSON.parse(r3.choices?.[0]?.message?.content || "{}"); } catch { obj = {}; }
  }

  // sanitize
  const items = Array.isArray(obj.items) ? obj.items.map(s=>String(s||"").trim()).filter(Boolean).slice(0,8) : src.items;
  while (items.length < 8) items.push("");
  const tags = Array.isArray(obj.tags) ? obj.tags.map(s=>String(s||"").trim()).filter(Boolean).slice(0,4) : (src.tags||[]);
  return {
    title: (obj.title && String(obj.title).trim()) || src.title,
    items,
    cta: (obj.cta && String(obj.cta).trim()) || src.cta,
    tags
  };
}

async function main(){
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY missing");
  const client = new OpenAI({ apiKey });

  const enPath = path.join("data","en",`${DATE}.yaml`);
  if (!fs.existsSync(enPath)) throw new Error(`EN yaml not found: ${enPath}`);
  const en = yaml.load(await fsp.readFile(enPath, "utf8")) || { entries:[] };

  for (const lg of LANGS) {
    const outPath = path.join("data", lg, `${DATE}.yaml`);
    await fsp.mkdir(path.dirname(outPath), { recursive:true });

    const arr = [];
    for (const e of en.entries) {
      arr.push(await translateOne(client, lg, e));
    }
    await fsp.writeFile(outPath, yaml.dump({ entries: arr }, { lineWidth: 1000 }), "utf8");
    console.log(`[ok] wrote ${outPath} (${arr.length} entries)`);
  }
}

main().catch(e=>{ console.error(e); process.exit(1); });
