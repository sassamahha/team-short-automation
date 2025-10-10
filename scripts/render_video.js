// scripts/render_video.js
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

function escText(s="") {
  return String(s)
    .replace(/\\/g, "\\\\")
    .replace(/:/g, "\\:")
    .replace(/,/g, "\\,")
    .replace(/%/g, "\\%")
    .replace(/\n/g, "\\n")
    .replace(/'/g, "\\\\'");
}

// 単純ラップ（英語=単語 / CJK=文字数）
function wrapByLimit(text, limit, isCJK){
  if (!text) return [""];
  if (isCJK) {
    const lines=[];
    let cur="";
    for (const ch of text) {
      if (cur.length>=limit){ lines.push(cur); cur=ch; } else cur+=ch;
    }
    if (cur) lines.push(cur);
    return lines;
  } else {
    const words = String(text).split(/\s+/);
    const lines = [];
    let cur = "";
    for (const w of words) {
      const next = (cur ? cur + " " : "") + w;
      if (next.length > limit && cur) { lines.push(cur); cur = w; }
      else { cur = next; }
    }
    if (cur) lines.push(cur);
    return lines;
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

  const mX = S.panel_margin_x ?? 0;
  const mY = S.panel_margin_y ?? 64;
  const pX = S.panel_padding_x ?? 64;
  const pY = S.panel_padding_y ?? 120;
  const panelAlpha = S.panel_alpha ?? 0.55;

  const tSize = S.title_size ?? 88;
  const iSize = S.item_size ?? 54;
  const cSize = S.cta_size ?? 52;
  const gap   = S.line_gap ?? 86;
  const titleGap = S.title_line_gap ?? 72;
  const titleBottomGap = S.title_bottom_gap ?? 64;

  const bullet= (S.bullet ?? "•") + " ";
  const font  = S.font || (LANG==="ja" ? "assets/fonts/NotoSansJP-Regular.ttf" : "assets/fonts/NotoSans-Regular.ttf");
  const fontQ = `'${font.replace(/'/g, "'\\''")}'`;

  const isCJK = /[\u3040-\u30ff\u3400-\u9fff\uff66-\uff9f]/.test(LANG==="ja" ? "あ" : "");
  const tWrapEn = S.title_wrap_chars_en ?? 28;
  const tWrapJa = S.title_wrap_chars_ja ?? 16;
  const iWrapEn = S.item_wrap_chars_en ?? 36;
  const iWrapJa = S.item_wrap_chars_ja ?? 18;

  const tLimit = (LANG==="ja") ? tWrapJa : tWrapEn;
  const iLimit = (LANG==="ja") ? iWrapJa : iWrapEn;

  const odir = outDir(DATE, LANG);
  await fsp.mkdir(odir, { recursive:true });

  const px = mX;
  const py = mY;
  const pw = W - mX*2;
  const ph = H - mY*2;

  const ix = px + pX;                         // テキスト左
  const iyTitle = py + pY;                    // タイトル開始Y
  const iyItemsStart = iyTitle + tSize + titleGap + titleBottomGap;
  const iyCta   = py + ph - pY - cSize - 12;

  let idx = 0;
  for (const e of (doc.entries || [])) {
    idx += 1;
    const outFile = path.join(odir, `${String(idx).padStart(4,"0")}.mp4`);

    // タイトル折返し
    const titleLines = wrapByLimit(String(e.title || ""), tLimit, LANG==="ja");

    // 箇条書き：それぞれ折返し、2行目以降はインデント
    const itemLines = [];
    const indent = (LANG==="ja") ? "　" : "   "; // 全角/半角空白で軽くインデント
    for (const raw of (e.items || []).slice(0,8).map(s=>String(s||"").trim()).filter(Boolean)) {
      const lines = wrapByLimit(raw, iLimit, LANG==="ja");
      lines.forEach((line, li) => {
        itemLines.push(li===0 ? (bullet+line) : (indent+line));
      });
    }

    const parts = [];
    // 背景 + パネル
    parts.push(`[0:v]scale=${W}:${H},format=rgba,drawbox=x=${px}:y=${py}:w=${pw}:h=${ph}:color=black@${panelAlpha}:t=fill[v0]`);

    // タイトル複数行
    let vi = 0;
    titleLines.forEach((line, k) => {
      const y = iyTitle + k * (tSize + Math.max(0, titleGap - tSize + 10));
      parts.push(`[v${vi}]drawtext=fontfile=${fontQ}:text='${escText(line)}':x=${ix}:y=${y}:fontsize=${tSize}:fontcolor=white:shadowcolor=black@0.6:shadowx=2:shadowy=2[v${vi+1}]`);
      vi += 1;
    });

    // 箇条書き（1行ずつ）
    const startY = iyItemsStart;
    itemLines.forEach((line, k) => {
      const y = startY + k * gap;
      parts.push(`[v${vi}]drawtext=fontfile=${fontQ}:text='${escText(line)}':x=${ix}:y=${y}:fontsize=${iSize}:fontcolor=white:shadowcolor=black@0.5:shadowx=1:shadowy=1[v${vi+1}]`);
      vi += 1;
    });

    // CTA
    const ctaText = escText(e.cta || "");
    parts.push(`[v${vi}]drawtext=fontfile=${fontQ}:text='${ctaText}':x=(w-text_w)/2:y=${iyCta}:fontsize=${cSize}:fontcolor=0xE0FFC8:box=1:boxcolor=black@0.55:boxborderw=24[vout]`);
    const filtergraph = parts.join(";");

    const bgArgs = BG.match(/\.(jpe?g|png)$/i) ? ["-loop","1","-t", String(DUR), "-i", BG] : ["-stream_loop","-1","-t", String(DUR), "-i", BG];
    const audioArgs = (AUDIO && fs.existsSync(AUDIO)) ? ["-i", AUDIO] : ["-f","lavfi","-t", String(DUR), "-i","anullsrc=cl=stereo:r=44100"];

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
