// YAML + style -> videos/{lang}/queue/YYYY-MM-DD/####.mp4
// usage: node scripts/render_video.js --lang=en --date=2025-10-10 --dur=10 --bg=assets/bg/loop.mp4 --audio=assets/bgm/ambient01.mp3

const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const yaml = require("js-yaml");
const { spawnSync } = require("child_process");

const LANG = (process.argv.find(a=>a.startsWith("--lang="))||"").split("=")[1] || "en";
const DATE = (process.argv.find(a=>a.startsWith("--date="))||"").split("=")[1] || new Date().toISOString().slice(0,10);
const DUR  = (process.argv.find(a=>a.startsWith("--dur=")) || "").split("=")[1] || (process.env.DURATION || "10");
const BG   = (process.argv.find(a=>a.startsWith("--bg="))  || "").split("=")[1] || "assets/bg/loop.mp4";
const AUDIO= (process.argv.find(a=>a.startsWith("--audio="))||"").split("=")[1] || "assets/bgm/ambient01.mp3";

function yamlPath(date, lang){ return path.join("data", lang, `${date}.yaml`); }
function stylePath(){ return path.join("data","style.yaml"); }
function outDir(date, lang){ return path.join("videos", lang, "queue", date); }

// drawtext 用に最低限必要な文字をエスケープ（: , ' \ % と改行）
function escText(s="") {
  return String(s)
    .replace(/\\/g, "\\\\")
    .replace(/:/g, "\\:")
    .replace(/,/g, "\\,")
    .replace(/%/g, "\\%")
    .replace(/\n/g, "\\n")
    .replace(/'/g, "\\\\'");
}

// 単純な折返し（英語=単語、CJK=文字数）
function wrapTitle(title, lang, maxEn=28, maxJa=16) {
  const isCJK = /[\u3040-\u30ff\u3400-\u9fff\uff66-\uff9f]/.test(title);
  const max = isCJK ? maxJa : maxEn;
  if (!title || title.length <= max) return title;
  if (!isCJK) {
    const words = title.split(/\s+/);
    const lines = [];
    let buf = "";
    for (const w of words) {
      const next = (buf ? buf + " " : "") + w;
      if (next.length > max && buf) { lines.push(buf); buf = w; }
      else { buf = next; }
    }
    if (buf) lines.push(buf);
    return lines.join("\n");
  } else {
    const lines = [];
    for (let i=0; i<title.length; i+=max) lines.push(title.slice(i, i+max));
    return lines.join("\n");
  }
}

async function main(){
  const yml = yamlPath(DATE, LANG);
  if (!fs.existsSync(yml)) throw new Error(`content not found: ${yml}`);
  const doc = yaml.load(await fsp.readFile(yml, "utf8")) || {};
  const st  = yaml.load(await fsp.readFile(stylePath(), "utf8")) || {};
  const S0  = (st.styles && st.styles.default) || {};
  const S   = Object.assign({}, S0, (st.styles && st.styles[LANG]) || {});

  const W = S.width ?? 1080;
  const H = S.height ?? 1920;

  const panelMargin  = S.panel_margin ?? 48;
  const panelPadding = S.panel_padding ?? 64;
  const panelAlpha   = S.panel_alpha ?? 0.55;

  const tSize = S.title_size ?? 88;
  const iSize = S.item_size ?? 54;
  const cSize = S.cta_size ?? 52;
  const gap   = S.line_gap ?? 86;
  const titleGap = S.title_line_gap ?? 72;

  const bullet= (S.bullet ?? "•") + " ";
  const font  = S.font || (LANG==="ja" ? "assets/fonts/NotoSansJP-Regular.ttf" : "assets/fonts/NotoSans-Regular.ttf");
  const fontQ = `'${font.replace(/'/g, "'\\''")}'`; // パス全体をクォート、安全側

  const wrapEn = S.title_wrap_chars_en ?? 28;
  const wrapJa = S.title_wrap_chars_ja ?? 16;

  const odir = outDir(DATE, LANG);
  await fsp.mkdir(odir, { recursive:true });

  // パネル矩形
  const px = panelMargin;
  const py = panelMargin;
  const pw = W - panelMargin*2;
  const ph = H - panelMargin*2;

  const ix = px + panelPadding;
  const iyTitle = py + panelPadding;
  const iyItems = iyTitle + tSize + titleGap;
  const iyCta   = py + ph - panelPadding - cSize - 12;

  let idx = 0;
  for (const e of (doc.entries || [])) {
    idx += 1;
    const outFile = path.join(odir, `${String(idx).padStart(4,"0")}.mp4`);

    const titleWrapped = wrapTitle(e.title || "", LANG, wrapEn, wrapJa);
    const TITLE = escText(titleWrapped);
    const items = (e.items || []).map(s => String(s || "").trim()).filter(Boolean).slice(0,8);
    const CTA   = escText(e.cta || "");

    // ---- フィルタ：ラベルで逐次接続 ----
    const parts = [];
    parts.push(`[0:v]scale=${W}:${H},format=rgba,drawbox=x=${px}:y=${py}:w=${pw}:h=${ph}:color=black@${panelAlpha}:t=fill[v0]`);
    parts.push(`[v0]drawtext=fontfile=${fontQ}:text='${TITLE}':x=${ix}:y=${iyTitle}:fontsize=${tSize}:fontcolor=white:line_spacing=${Math.max(0, titleGap - tSize + 10)}:shadowcolor=black@0.6:shadowx=2:shadowy=2[v1]`);
    let vi = 1;
    items.forEach((it, k) => {
      const txt = escText(bullet + it);
      parts.push(`[v${vi}]drawtext=fontfile=${fontQ}:text='${txt}':x=${ix}:y=${iyItems}+${k}*${gap}:fontsize=${iSize}:fontcolor=white:shadowcolor=black@0.5:shadowx=1:shadowy=1[v${vi+1}]`);
      vi += 1;
    });
    parts.push(`[v${vi}]drawtext=fontfile=${fontQ}:text='${CTA}':x=(w-text_w)/2:y=${iyCta}:fontsize=${cSize}:fontcolor=0xE0FFC8:box=1:boxcolor=black@0.55:boxborderw=24[vout]`);
    const filtergraph = parts.join(";");

    const bgArgs = BG.match(/\.(jpe?g|png)$/i) ? ["-loop","1","-t", String(DUR), "-i", BG] : ["-stream_loop","-1","-t", String(DUR), "-i", BG];
    const audioArgs = (AUDIO && fs.existsSync(AUDIO))
      ? ["-i", AUDIO]
      : ["-f","lavfi","-t", String(DUR), "-i","anullsrc=cl=stereo:r=44100"];

    const args = [
      "-y",
      ...bgArgs,
      ...audioArgs,
      "-filter_complex", filtergraph,
      "-map","[vout]","-map","1:a?",
      "-shortest",
      "-r","30","-c:v","libx264","-pix_fmt","yuv420p","-c:a","aac",
      outFile
    ];

    const r = spawnSync("ffmpeg", args, { stdio:"inherit" });
    if (r.status !== 0) throw new Error("ffmpeg failed");
    console.log("[mp4]", outFile);
  }
}

main().catch(e=>{ console.error(e); process.exit(1); });
