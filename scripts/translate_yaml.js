// EN YAML -> data/{lang}/YYYY-MM-DD.yaml
// usage: node scripts/translate_yaml.js --date=2025-10-10 --langs=ja
const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const yaml = require("js-yaml");
const { OpenAI } = require("openai");

const MODEL = process.env.OPENAI_MODEL || "gpt-5";
const DATE  = (process.argv.find(a=>a.startsWith("--date=")) || "").split("=")[1] || new Date().toISOString().slice(0,10);
const LANGS = ((process.argv.find(a=>a.startsWith("--langs=")) || "").split("=")[1] || "ja").split(",").map(s=>s.trim()).filter(Boolean);

function inPathEN(date) { return path.join("data","en",`${date}.yaml`); }
function outPath(date, lang) { return path.join("data", lang, `${date}.yaml`); }

const LANG_NAMES = { ja:"Japanese", es:"Spanish", pt:"Portuguese", de:"German", fr:"French", it:"Italian", nl:"Dutch", sv:"Swedish", da:"Danish", no:"Norwegian", fi:"Finnish", pl:"Polish", tr:"Turkish", ar:"Arabic", hi:"Hindi", id:"Indonesian", th:"Thai" };

async function main() {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY missing");
  const client = new OpenAI({ apiKey });

  const src = inPathEN(DATE);
  if (!fs.existsSync(src)) throw new Error(`EN yaml not found: ${src}`);
  const en = yaml.load(await fsp.readFile(src,"utf8"));

  for (const lg of LANGS) {
    const out = outPath(DATE, lg);
    await fsp.mkdir(path.dirname(out), { recursive:true });

    const arr = [];
    for (const e of en.entries || []) {
      const prompt =
`Translate to ${LANG_NAMES[lg] || lg}.
Return YAML with keys: title, items (exactly 8 bullets), cta, tags.
Keep bullets short, concrete, and natural for ${LANG_NAMES[lg] || lg} speakers.
Source JSON:
${JSON.stringify({ title:e.title, items:e.items, cta:e.cta, tags:e.tags })}`;
      const res = await client.chat.completions.create({
        model: MODEL, temperature: 0.2,
        messages: [
          { role:"system", content:"Output only valid YAML. No extra text." },
          { role:"user", content: prompt }
        ]
      });
      let obj; 
      try { obj = yaml.load(res.choices[0].message.content.trim()) || {}; } catch(_) { obj = {}; }
      let items = (obj.items || []).slice(0,8);
      while (items.length < 8) items.push("");
      arr.push({
        title: obj.title || e.title,
        items, cta: obj.cta || e.cta,
        tags: Array.isArray(obj.tags) ? obj.tags.slice(0,4) : e.tags || []
      });
    }
    await fsp.writeFile(out, yaml.dump({ entries: arr }, { lineWidth: 1000 }), "utf8");
    console.log(`[ok] wrote ${out} (${arr.length} entries)`);
  }
}

main().catch(e=>{ console.error(e); process.exit(1); });
