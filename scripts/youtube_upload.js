// Upload from videos/{lang}/queue -> move to sent
// usage:
//   single: node scripts/youtube_upload.js --file=videos/en/queue/2025-10-10/0001.mp4 --lang=en
//   batch : node scripts/youtube_upload.js --lang=en --max=2
const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const { google } = require("googleapis");

// ---------- channel meta (title/desc/tags per language) ----------
async function readChannelMeta(lang) {
  const p = path.join("data", "channel_meta", `${lang}.txt`);
  const out = { title_suffix: "", description: "", tags: [] };
  if (!fs.existsSync(p)) return out;

  const txt = await fsp.readFile(p, "utf8");
  const lines = txt.split(/\r?\n/);

  let curKey = null;
  for (let raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = line.match(/^([a-zA-Z_]+)\s*=\s*(.*)$/);
    if (m) {
      curKey = m[1];
      const val = m[2];
      if (curKey === "description") {
        out.description = val; // ここから次のキーが来るまで追記
      } else if (curKey === "title_suffix") {
        out.title_suffix = val || "";
      } else if (curKey === "tags") {
        out.tags = val.split(",").map(s=>s.trim()).filter(Boolean);
      } else if (curKey === "tags_extra") {
        // 使うなら説明文の後ろに追記したいときに利用
        out.tags_extra = val;
      }
      continue;
    }
    // description 追記モード
    if (curKey === "description") {
      out.description += "\n" + line;
    }
  }
  return out;
}

// ---------- youtube auth (ID/SECRET + refresh_token_{CC}) ----------
function ytClientForLang(lang) {
  const cc = (lang || "en").toUpperCase(); // en -> EN, fr -> FR
  const clientId = process.env.YT_CLIENT_ID;
  const clientSecret = process.env.YT_CLIENT_SECRET;
  const refreshToken = process.env[`YT_REFRESH_TOKEN_${cc}`] || process.env.YT_REFRESH_TOKEN;

  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error(`YouTube creds missing. Need YT_CLIENT_ID / YT_CLIENT_SECRET / YT_REFRESH_TOKEN_${cc}`);
  }

  const auth = new google.auth.OAuth2(clientId, clientSecret);
  auth.setCredentials({ refresh_token: refreshToken });
  return google.youtube({ version: "v3", auth });
}

async function uploadOne(yt, file, lang, meta = {}) {
  const chMeta = await readChannelMeta(lang);
  const suffix = chMeta.title_suffix || "";
  const title = meta.title ? `${meta.title}${suffix}` : path.basename(file);
  let description = chMeta.description || "📌 Daily 10s ‘Small Wins’. Save and try one today.";
  if (chMeta.tags_extra) description += `\n${chMeta.tags_extra}`;

  const tags = Array.isArray(meta.tags) && meta.tags.length
    ? meta.tags.slice(0,10)
    : (chMeta.tags && chMeta.tags.length ? chMeta.tags.slice(0,10) : ["small wins","mindset","self help"]);

  const res = await yt.videos.insert({
    part: "snippet,status",
    requestBody: {
      snippet: { title, description, tags, categoryId: "27" },
      status: { privacyStatus: "public", selfDeclaredMadeForKids: false }
    },
    media: { body: fs.createReadStream(file) }
  });
  console.log("[uploaded]", path.basename(file), res.data.id);
}

async function metaFor(file) {
  const j = file.replace(/\.mp4$/, ".json");
  if (fs.existsSync(j)) {
    try { return JSON.parse(await fsp.readFile(j,"utf8")); } catch(_) {}
  }
  return {};
}

async function moveToSent(file) {
  const dateDir = path.basename(path.dirname(file)); // YYYY-MM-DD
  const lang = file.split(path.sep)[1]; // videos/{lang}/queue/...
  const destDir = path.join("videos", lang, "sent", dateDir);
  await fsp.mkdir(destDir, { recursive: true });
  const base = path.basename(file);
  await fsp.rename(file, path.join(destDir, base)).catch(async () => {
    await fsp.copyFile(file, path.join(destDir, base)); await fsp.unlink(file);
  });
  const j = file.replace(/\.mp4$/, ".json");
  if (fs.existsSync(j)) {
    const destJ = path.join(destDir, path.basename(j));
    await fsp.rename(j, destJ).catch(async ()=>{
      await fsp.copyFile(j, destJ); await fsp.unlink(j);
    });
  }
}

async function pickBatch(lang, max=1) {
  const dir = path.join("videos", lang, "queue");
  if (!fs.existsSync(dir)) return [];
  const dates = fs.readdirSync(dir).filter(d=>/^\d{4}-\d{2}-\d{2}$/.test(d)).sort(); // oldest first
  const files = [];
  for (const d of dates) {
    const p = path.join(dir, d);
    const ls = fs.readdirSync(p).filter(f=>f.endsWith(".mp4")).sort();
    for (const f of ls) { files.push(path.join(p,f)); if (files.length >= max) return files; }
  }
  return files;
}

async function main() {
  const fileArg = (process.argv.find(a=>a.startsWith("--file="))||"").split("=")[1];
  const langArg = (process.argv.find(a=>a.startsWith("--lang="))||"").split("=")[1] || "en";
  const maxArg  = parseInt((process.argv.find(a=>a.startsWith("--max="))||"").split("=")[1] || "1", 10);

  const yt = ytClientForLang(langArg);

  if (fileArg) {
    const meta = await metaFor(fileArg);
    await uploadOne(yt, fileArg, langArg, meta);
    await moveToSent(fileArg);
    return;
  }

  const batch = await pickBatch(langArg, maxArg);
  if (!batch.length) { console.log("[skip] no files"); return; }

  for (const f of batch) {
    const meta = await metaFor(f);
    await uploadOne(yt, f, langArg, meta);
    await moveToSent(f);
  }
  console.log(`[done] uploaded ${batch.length} file(s) for ${langArg}`);
}

main().catch(e=>{ console.error(e); process.exit(1); });
