// scripts/youtube_upload.js
// Upload from videos/{lang}/queue -> move to sent
// usage:
//   single: node scripts/youtube_upload.js --file=videos/en/queue/2025-10-10/0001.mp4 --lang=en
//   batch : node scripts/youtube_upload.js --lang=en --max=2
//   YT_REFRESH_TOKEN_EN / YT_REFRESH_TOKEN_JA / ...（なければ YT_REFRESH_TOKEN をフォールバック）

const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const { google } = require("googleapis");

// ---------------- utils ----------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clamp = (s, n) => (s && s.length > n ? s.slice(0, n) : s);

// ---------------- channel meta (title/desc/tags per language) ----------------
async function readChannelMeta(lang) {
  const p = path.join("data", "channel_meta", `${lang}.txt`);
  const out = {
    title_suffix: "",                              // 例: "｜小さく勝つ習慣 ch."
    description: "📌 Daily 10s ‘Small Wins’. Save and try one today.", // デフォルト
    tags: ["small wins", "mindset", "self help"],
    tags_extra: "",
  };
  if (!fs.existsSync(p)) return out;

  const txt = await fsp.readFile(p, "utf8");
  const lines = txt.split(/\r?\n/);

  let curKey = null;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;

    const m = line.match(/^([a-zA-Z_]+)\s*=\s*(.*)$/);
    if (m) {
      curKey = m[1];
      const val = m[2] ?? "";
      if (curKey === "title_suffix") out.title_suffix = val;
      else if (curKey === "description") out.description = val;
      else if (curKey === "tags") out.tags = val.split(",").map((s) => s.trim()).filter(Boolean);
      else if (curKey === "tags_extra") out.tags_extra = val;
      continue;
    }
    if (curKey === "description") out.description += `\n${line}`;
  }
  // 整形（上限対策）
  out.description = clamp(out.description, 4900);
  out.tags = out.tags.slice(0, 10);
  return out;
}

// ---------------- youtube auth (ID/SECRET + refresh_token_{CC}) ----------------
function ytClientForLang(lang) {
  const cc = (lang || "en").toUpperCase(); // en -> EN
  const clientId = process.env.YT_CLIENT_ID;
  const clientSecret = process.env.YT_CLIENT_SECRET;
  const refreshToken =
    process.env[`YT_REFRESH_TOKEN_${cc}`] || process.env.YT_REFRESH_TOKEN;

  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error(
      `YouTube creds missing. Need YT_CLIENT_ID / YT_CLIENT_SECRET / YT_REFRESH_TOKEN_${cc} (or YT_REFRESH_TOKEN)`
    );
  }

  const auth = new google.auth.OAuth2(clientId, clientSecret);
  auth.setCredentials({ refresh_token: refreshToken });
  return google.youtube({ version: "v3", auth });
}

// ---------------- sidecar meta (####.json) ----------------
async function readSidecar(file) {
  const j = file.replace(/\.mp4$/i, ".json");
  if (fs.existsSync(j)) {
    try {
      const obj = JSON.parse(await fsp.readFile(j, "utf8"));
      return obj || {};
    } catch (_) {}
  }
  return {};
}

// ---------------- move to sent ----------------
async function moveToSent(file) {
  const dateDir = path.basename(path.dirname(file)); // YYYY-MM-DD
  const lang = file.split(path.sep)[1];              // videos/{lang}/queue/...
  const destDir = path.join("videos", lang, "sent", dateDir);
  await fsp.mkdir(destDir, { recursive: true });

  const base = path.basename(file);
  const dest = path.join(destDir, base);
  await fsp.rename(file, dest).catch(async () => {
    await fsp.copyFile(file, dest);
    await fsp.unlink(file);
  });

  const j = file.replace(/\.mp4$/i, ".json");
  if (fs.existsSync(j)) {
    const destJ = path.join(destDir, path.basename(j));
    await fsp.rename(j, destJ).catch(async () => {
      await fsp.copyFile(j, destJ);
      await fsp.unlink(j);
    });
  }
}

// ---------------- pick batch ----------------
async function pickBatch(lang, max = 1) {
  const dir = path.join("videos", lang, "queue");
  if (!fs.existsSync(dir)) return [];
  const dates = fs
    .readdirSync(dir)
    .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))
    .sort(); // oldest first

  const files = [];
  for (const d of dates) {
    const p = path.join(dir, d);
    const ls = fs.readdirSync(p).filter((f) => f.endsWith(".mp4")).sort();
    for (const f of ls) {
      files.push(path.join(p, f));
      if (files.length >= max) return files;
    }
  }
  return files;
}

// ---------------- uploader (with small retry) ----------------
async function uploadOne(yt, file, lang, sidecar = {}) {
  const ch = await readChannelMeta(lang);

  // タイトル（sidecar.title を優先。suffix は重複防止）
  const baseTitle = sidecar.title || path.basename(file, ".mp4");
  const suffix = ch.title_suffix || "";
  const hasSuffix =
    suffix && (baseTitle.endsWith(suffix) || baseTitle.includes(suffix));
  const title = clamp(hasSuffix ? baseTitle : `${baseTitle}${suffix}`, 100);

  // 説明文＆タグ
  let description = sidecar.description || ch.description;
  if (ch.tags_extra) description = clamp(`${description}\n${ch.tags_extra}`, 4900);
  const tags =
    Array.isArray(sidecar.tags) && sidecar.tags.length
      ? sidecar.tags.slice(0, 10)
      : ch.tags;

  const req = {
    part: "snippet,status",
    requestBody: {
      snippet: { title, description, tags, categoryId: "27" }, // HowTo & Style
      status: { privacyStatus: "public", selfDeclaredMadeForKids: false },
    },
    media: { body: fs.createReadStream(file) },
  };

  // 軽いリトライ（429/5xx）
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await yt.videos.insert(req);
      console.log("[uploaded]", path.basename(file), res.data.id);
      return res.data.id;
    } catch (e) {
      const code = e?.code || e?.response?.status;
      const retriable = code === 429 || (code >= 500 && code < 600);
      console.warn(`[upload fail] ${path.basename(file)} (attempt ${attempt})`, code, e?.message || e);
      if (retriable && attempt < 3) {
        await sleep(1500 * attempt);
        continue;
      }
      throw e;
    }
  }
}

// ---------------- main ----------------
async function main() {
  const fileArg = (process.argv.find((a) => a.startsWith("--file=")) || "").split("=")[1];
  const langArg = (process.argv.find((a) => a.startsWith("--lang=")) || "").split("=")[1] || "en";
  const maxArg  = parseInt((process.argv.find((a) => a.startsWith("--max=")) || "").split("=")[1] || "1", 10);

  const yt = ytClientForLang(langArg);

  if (fileArg) {
    const sidecar = await readSidecar(fileArg);
    await uploadOne(yt, fileArg, langArg, sidecar);
    await moveToSent(fileArg);
    return;
  }

  const batch = await pickBatch(langArg, maxArg);
  if (!batch.length) {
    console.log("[skip] no files in queue");
    return;
  }

  let done = 0;
  for (const f of batch) {
    const sidecar = await readSidecar(f);
    await uploadOne(yt, f, langArg, sidecar);
    await moveToSent(f);
    done++;
    // 連投を少し間引く（好みで調整）
    if (done < batch.length) await sleep(1200);
  }
  console.log(`[done] uploaded ${done} file(s) for ${langArg}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
