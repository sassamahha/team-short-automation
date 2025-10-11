// scripts/render_video.js
// YAML + style -> videos/{lang}/queue/YYYY-MM-DD/####.mp4 (+ ####.json sidecar)
// - drawtext は textfile=... を使用（エスケープ事故を防止）
// - フィルタグラフは ; 区切りで 1 本の -filter_complex
// - style.yaml の panel_margin/padding 指定（上下左右個別）に対応
// - アップロード用メタ (title/description/tags) を sidecar JSON に保存

const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const os = require("os");
const yaml = require("js-yaml");
const { spawnSync } = require("child_process");

// ---- args / env
const LANG  = (process.argv.find(a=>a.startsWith("--lang="))  || "").split("=")[1] || "en";
const DATE  = (process.argv.find(a=>a.startsWith("--date="))  || "").split("=")[1] || new Date().toISOString().slice(0,10);
const DUR   = (process.argv.find(a=>a.startsWith("--dur="))   || "").split("=")[1] || (process.env.DURATION || "10");
const BG    = (process.argv.find(a=>a.startsWith("--bg="))    || "").split("=")[1] || "assets/bg/loop.mp4";
const AUDIO = (process.argv.find(a=>a.startsWith("--audio=")) || "").split("=")[1] || "assets/bgm/ambient01.mp3";

// ---- paths
const yamlPath  = (d,lang)=> path.join("data", lang, `${d}.yaml`);
const stylePath = ()          => path.join("data", "style.yaml");
const outDir    = (d,lang)=>   path.join("videos", lang, "queue", d);
const chMetaTxt = (lang)=>     path.join("data","channel_meta",`${lang}.txt`);

// ---- util: simple wrapping (EN=word, CJK=char)
function wrapByLimit(text, limit, isCJK){
  if (!text) return [""];
  if (isCJK){
    const lines=[]; let cur="";
    for (const ch of text){
      if (cur.length>=limit){ lines.push(cur); cur=ch; } else cur+=ch;
    }
    if (cur) lines.push(cur);
    return lines;
  } else {
    const words = String(text).trim().split(/\s+/);
    const lines=[]; let cur="";
    for (const w of words){
      const next = (cur?cur+" ":"")+w;
      if (next.length>limit && cur){ lines.push(cur); cur=w; }
      else cur=next;
    }
    if (cur) lines.push(cur);
    return lines;
  }
}

// ---- channel meta (title suffix / desc / default tags)
function readChannelMeta(lang){
  let suffix = "", desc = "📌 Daily 10s ‘Small Wins’. Save and try one today.", tags = ["small wins","mindset","self help"];
  const p = chMetaTxt(lang);
  if (fs.existsSync(p)){
    const [l1="", l2="", l3=""] = fs.readFileSync(p,"utf8").split(/\r?\n/);
    suffix = (l1||"").trim() || suffix;
    desc   = (l2||"").trim() || desc;
    if (l3) tags = l3.split(",").map(s=>s.trim()).filter(Boolean).slice(0,10);
  }
  return { suffix, desc, tags };
}

async function main(){
  // ---- load contents / style
  const yml = yamlPath(DATE, LANG);
  if (!fs.existsSync(yml)) throw new Error(`content not found: ${yml}`);

  const doc = yaml.load(await fsp.readFile(yml,"utf8")) || {};
  const st  = yaml.load(await fsp.readFile(stylePath(),"utf8")) || {};
  const S0  = (st.styles && st.styles.default) || {};
  const S   = Object.assign({}, S0, (st.styles && st.styles[LANG]) || {});

  // canvas
  const W = S.width ?? 1080;
  const H = S.height ?? 1920;

  // margins / paddings（上下左右を個別指定）
  // じゅんちゃん指定：上下=64の外側 / 内側 上下=120、左右はスタイル通り
  const mX = (S.panel_margin_x ?? 0);      // 左右外側
  const mY = (S.panel_margin_y ?? 64);     // 上下外側
  const pX = (S.panel_padding_x ?? 64);    // 左右内側
  const pY = (S.panel_padding_y ?? 120);   // 上下内側
  const panelAlpha = (S.panel_alpha ?? 0.55);

  // typography
  const tSize = S.title_size ?? 88;
  const iSize = S.item_size  ?? 54;
  const cSize = S.cta_size   ?? 52;
  const gap   = S.line_gap   ?? 86;
  const titleGap = S.title_line_gap    ?? 72;
  const titleBottomGap = S.title_bottom_gap ?? 64;

  const bullet = (S.bullet ?? "•") + " ";
  const font   = S.font || (LANG==="ja" ? "assets/fonts/NotoSansJP-Regular.ttf" : "assets/fonts/NotoSans-Regular.ttf");

  const tLimit = (LANG==="ja") ? (S.title_wrap_chars_ja ?? 16) : (S.title_wrap_chars_en ?? 28);
  const iLimit = (LANG==="ja") ? (S.item_wrap_chars_ja  ?? 18) : (S.item_wrap_chars_en  ?? 36);

  // positions
  const px = mX, py = mY, pw = W - mX*2, ph = H - mY*2; // black panel
  const ix = px + pX;                                   // text left
  const iyTitle = py + pY;                              // title top
  const iyItemsStart = iyTitle + tSize + titleGap + titleBottomGap;
  const iyCta = py + ph - pY - cSize - 12;              // cta bottom

  // output dir & tmp text dir
  const odir = outDir(DATE, LANG);
  await fsp.mkdir(odir, { recursive:true });
  const tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "srshort-"));

  const CH = readChannelMeta(LANG);

  let idx = 0;
  for (const e of (doc.entries || [])){
    idx++;
    const outMp4  = path.join(odir, `${String(idx).padStart(4,"0")}.mp4`);
    const outJson = path.join(odir, `${String(idx).padStart(4,"0")}.json`);

    // ---- wrap
    const titleLines = wrapByLimit(String(e.title||""), tLimit, LANG==="ja");
    const rawItems   = (e.items || []).map(s=>String(s||"").trim()).filter(Boolean).slice(0,8);

    const itemLines=[];
    const indent = (LANG==="ja") ? "　" : "   ";
    for (const it of rawItems){
      const arr = wrapByLimit(it, iLimit, LANG==="ja");
      arr.forEach((line, li)=> itemLines.push(li===0 ? (bullet+line) : (indent+line)));
    }
    const ctaLine = String(e.cta || "Save and try one today");

    // ---- textfiles
    const textFiles = [];
    const makeTxt = async (base, txt)=>{
      const p = path.join(tmpRoot, `${base}.txt`);
      await fsp.writeFile(p, txt, "utf8");
      textFiles.push(p);
      return p;
    };

    // ---- filtergraph
    const parts = [];
    parts.push(`[0:v]scale=${W}:${H},format=rgba,drawbox=x=${px}:y=${py}:w=${pw}:h=${ph}:color=black@${panelAlpha}:t=fill[v0]`);

    // title lines
    const titleLineSpace = Math.max(0, titleGap - tSize + 10);
    let vi = 0;
    for (let k=0; k<titleLines.length; k++){
      const tf = await makeTxt(`title_${idx}_${k}`, titleLines[k]);
      const y  = `${iyTitle}+${k}*(${tSize}+${titleLineSpace})`;
      parts.push(`[v${vi}]drawtext=fontfile=${font}:textfile=${tf}:x=${ix}:y=${y}:fontsize=${tSize}:fontcolor=white:shadowcolor=black@0.6:shadowx=2:shadowy=2[v${vi+1}]`);
      vi++;
    }
    // items
    for (let k=0; k<itemLines.length; k++){
      const tf = await makeTxt(`item_${idx}_${k}`, itemLines[k]);
      const y  = `${iyItemsStart}+${k}*${gap}`;
      parts.push(`[v${vi}]drawtext=fontfile=${font}:textfile=${tf}:x=${ix}:y=${y}:fontsize=${iSize}:fontcolor=white:shadowcolor=black@0.5:shadowx=1:shadowy=1[v${vi+1}]`);
      vi++;
    }
    // CTA
    {
      const tf = await makeTxt(`cta_${idx}`, ctaLine);
      parts.push(`[v${vi}]drawtext=fontfile=${font}:textfile=${tf}:x=(w-text_w)/2:y=${iyCta}:fontsize=${cSize}:fontcolor=0xE0FFC8:box=1:boxcolor=black@0.55:boxborderw=24[v]`);
    }
    const filtergraph = parts.join(";");

    // ---- inputs
    const bgArgs = BG.match(/\.(jpe?g|png)$/i)
      ? ["-loop","1","-t", String(DUR), "-i", BG]
      : ["-stream_loop","-1","-t", String(DUR), "-i", BG];

    const audioArgs = (AUDIO && fs.existsSync(AUDIO))
      ? ["-i", AUDIO]
      : ["-f","lavfi","-t", String(DUR), "-i","anullsrc=cl=stereo:r=44100"];

    // ---- run ffmpeg
    const args = [
      "-y",
      ...bgArgs,
      ...audioArgs,
      "-filter_complex", filtergraph,
      "-map","[v]","-map","1:a?",
      "-shortest",
      "-r","30","-c:v","libx264","-pix_fmt","yuv420p","-c:a","aac",
      outMp4
    ];
    const r = spawnSync("ffmpeg", args, { stdio:"inherit" });
    if (r.status !== 0) throw new Error("ffmpeg failed");

    // ---- sidecar meta for uploader
    const titleText = `${String(e.title||"Small Wins")}${CH.suffix || ""}`;
    const tags = (Array.isArray(e.tags) && e.tags.length) ? e.tags.slice(0,10) : CH.tags;
    const sidecar = { title: titleText, description: CH.desc, tags };
    await fsp.writeFile(outJson, JSON.stringify(sidecar, null, 2), "utf8");

    // cleanup temp text files
    for (const p of textFiles){ try { await fsp.unlink(p); } catch(_){} }

    console.log("[mp4]", outMp4);
    console.log("[meta]", outJson);
  }

  // temp dirを片付け（空なら削除）
  try { await fsp.rmdir(tmpRoot); } catch(_) {}
}

main().catch(e=>{ console.error(e); process.exit(1); });
