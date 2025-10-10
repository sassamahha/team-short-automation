// 置き換え版：panel枠+paddingで描画、タイトルは簡易折返し
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

function esc(s="") {
  return String(s)
    .replace(/\\/g, "\\\\")
    .replace(/:/g, '\\:')
    .replace(/,/g, '\\,')
    .replace(/\n/g, '\\n')
    .replace(/'/g, "\\\\'");
}

// 単純な折返し（空白区切り / CJKは文字数で）
function wrapTitle(title, lang, maxEn=28, maxJa=16) {
  const isCJK = /[\u3040-\u30ff\u3400-\u9fff\uff66-\uff9f]/.test(title);
  const max = isCJK ? maxJa : maxEn;
  if (!title || title.length <= max) return title;
  if (!isCJK) {
    const words = title.split(/\s+/);
    const lines = [];
    let buf = "";
    for (const w of words) {
      if ((buf + " " + w).trim().length > max && buf) {
        lines.push(buf);
        buf = w;
      } else {
        buf = (buf ? buf + " " : "") + w;
      }
    }
    if (buf) lines.push(buf);
    return lines.join("\\n");
  } else {
    // CJKは雑にmaxごと
    const lines = [];
    for (let i=0; i<title.length; i+=max) lines.push(title.slice(i, i+max));
    return lines.join("\\n");
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

  const wrapEn = S.title_wrap_chars_en ?? 28;
  const wrapJa = S.title_wrap_chars_ja ?? 16;

  const odir = outDir(DATE, LANG);
  await fsp.mkdir(odir, { recursive:true });

  // パネル矩形（外側マージンを残す）
  const px = panelMargin;
  const py = panelMargin;
  const pw = W - panelMargin*2;
  const ph = H - panelMargin*2;

  // パネル内の起点
  const ix = px + panelPadding;
  const iyTitle = py + panelPadding;
  const iyItems = iyTitle + tSize + titleGap;
  const iyCta   = py + ph - panelPadding - cSize - 12;

  let idx = 0;
  for (const e of (doc.entries || [])) {
    idx += 1;
    const base = path.join(odir, `${String(idx).padStart(4,"0")}.mp4`);
    const titleWrapped = wrapTitle(e.title || "", LANG, wrapEn, wrapJa);
    const TITLE = esc(titleWrapped);
    const items = (e.items || []).slice(0,8).map(s=>esc(s)).filter(s=>s && s !== ""); // 空行は出さない
    const CTA   = esc(e.cta || "");

    // 画面→スケール→描画の順で
    const filters = [
      `format=rgba`,
      // 背景の上にパネル（黒半透明）
      `drawbox=x=${px}:y=${py}:w=${pw}:h=${ph}:color=black@${panelAlpha}:t=fill`,
      // タイトル（折返し対応）
      `drawtext=fontfile=${font}:text='${TITLE}':x=${ix}:y=${iyTitle}:fontsize=${tSize}:fontcolor=white:line_spacing=${titleGap- tSize + 10}:shadowcolor=black@0.6:shadowx=2:shadowy=2`,
      // 箇条書き（空を除外）
      ...items.map((it,k)=>`drawtext=fontfile=${font}:text='${esc(bullet)+it}':x=${ix}:y=${iyItems}+${k}*${gap}:fontsize=${iSize}:fontcolor=white:shadowcolor=black@0.5:shadowx=1:shadowy=1`),
      // CTA（パネル内、中央揃え＋黒ボックス）
      `drawtext=fontfile=${font}:text='${CTA}':x=(w-text_w)/2:y=${iyCta}:fontsize=${cSize}:fontcolor=0xE0FFC8:box=1:boxcolor=black@0.55:boxborderw=24`,
      // 最後に縦長へ整形
      `scale=${W}:${H},format=yuv420p`
    ].join(",");

    const bgArgs = BG.endsWith(".jpg") || BG.endsWith(".png") ? ["-loop","1","-i", BG] : ["-stream_loop","-1","-i", BG];
    const audioArgs = (AUDIO && fs.existsSync(AUDIO)) ? ["-i", AUDIO] : ["-f","lavfi","-i","anullsrc=cl=stereo:r=44100"];

    const args = ["-y", ...bgArgs, ...audioArgs, "-t", String(DUR), "-filter_complex", filters, "-r","30","-c:v","libx264","-pix_fmt","yuv420p","-c:a","aac","-shortest", base];
    const r = spawnSync("ffmpeg", args, { stdio:"inherit" });
    if (r.status !== 0) throw new Error("ffmpeg failed");
    console.log("[mp4]", base);
  }
}

main().catch(e=>{ console.error(e); process.exit(1); });
