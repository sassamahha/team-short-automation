// seeds -> data/en/YYYY-MM-DD.yaml
// usage: node scripts/seed_to_yaml.js --date=2025-10-10
const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const yaml = require("js-yaml");
const { OpenAI } = require("openai");

const MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";
const DATE = (process.argv.find(a=>a.startsWith("--date="))||"").split("=")[1] || new Date().toISOString().slice(0,10);

function seedsPath(date) { return path.join("data","seeds",`${date}.txt`); }
function outPathEN(date)  { return path.join("data","en",`${date}.yaml`); }

async function main() {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY missing");
  const client = new OpenAI({ apiKey });

  const src = seedsPath(DATE);
  if (!fs.existsSync(src)) throw new Error(`seeds not found: ${src}`);
  const lines = (await fsp.readFile(src,"utf8")).split(/\r?\n/).map(s=>s.trim()).filter(Boolean);

  const entries = [];
  for (const seed of lines) {
    const prompt =
`You generate content for a 10-second self-help/mindset Short.
Seed (title idea, may be Japanese or English):
"${seed}"

Write YAML with keys: title, items (exactly 8 bullets), cta, tags (2-4).
Constraints:
- English output only.
- Bullets are concrete, short (≤ 10 words), actionable.
- No vague self-help.
- CTA: short imperative line.`;
    const res = await client.chat.completions.create({
      model: MODEL, temperature: 0.3,
      messages: [
        { role:"system", content:"Output only valid YAML. No extra text." },
        { role:"user", content: prompt }
      ]
    });
    const y = res.choices[0].message.content.trim();
    let obj;
    try { obj = yaml.load(y) || {}; } catch(e) { obj = {}; }
    const items = (obj.items || []).slice(0,8);
    while (items.length < 8) items.push("");
    entries.push({
      title: obj.title || seed,
      items,
      cta: obj.cta || "Save and try one today",
      tags: Array.isArray(obj.tags) ? obj.tags.slice(0,4) : ["mindset","small wins"]
    });
  }

  const outDir = path.join("data","en");
  await fsp.mkdir(outDir, { recursive:true });
  await fsp.writeFile(outPathEN(DATE), yaml.dump({ entries }, { lineWidth: 1000 }), "utf8");
  console.log(`[ok] wrote ${outPathEN(DATE)} (${entries.length} entries)`);
}

main().catch(e=>{ console.error(e); process.exit(1); });
