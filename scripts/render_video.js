// YAML + style -> videos/{lang}/queue/YYYY-MM-DD/####.mp4 （PNGは作らない）
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

// ffmpeg drawtext escaping (rough but practical)
function esc(s="") {
  // escape backslash, colon, commas, single quotes, newlines
  return String(s)
    .replace(/\\/g, "\\\\")
    .replace(/:/g, '\\:')
    .replace(/,/g, '\\,')
    .replace(/\n/g, ' ')
    .replace(/'/g, "\\\\'");
}

async function main(){
  const yml = yamlPath(DATE, LANG);
  if (!fs.existsSync(yml)) throw new Error(`content not found: ${yml}`);
  const doc = yaml.load(await fsp.readFile(yml, "utf8")) || {};
  const st  = yaml.load(await fsp.readFile(stylePath(), "utf8")) || {};
  const S0  = (st.styles && st.styles.default) || {};
  const S   = Object.assign({}, S0, (st.styles && st.styles[LANG]) || {});

  const pad   = S.pad ?? 64;
  const tY    = S.title_y ?? 240;
  const iY    = S.items_y ?? 520;
  const gap   = S.line_gap ?? 86;
  const ctaY  = S.cta_y ?? 1720;
  const tSize = S.title_size ?? 88;
  const iSize = S.item_size ?? 54;
  const cSize = S.cta_size ?? 52;
  const bullet= (S.bullet ?? "•") + " ";
  const font  = S.font || (LANG==="ja" ? "assets/fonts/NotoSansJP-Bold.otf" : "assets/fonts/NotoSans-Bold.ttf");
  const overlayAlpha = S.overlay_alpha ?? 0.47;

  const odir = outDir(DATE, LANG);
  await fsp.mkdir(odir, { recursive:true });

  let idx = 0;
  for (const e of (doc.entries || [])) {
    idx += 1;
    const base = path.join(odir, `${String(idx).padStart(4,"0")}.mp4`);
    const TITLE = esc(e.title || "");
    const items = (e.items || []).slice(0,8).map(s=>esc(s));
    const CTA   = esc(e.cta || "");
    const draw = [
      `format=rgba`,
      `drawbox=x=0:y=0:w=iw:h=ih:color=black@${overlayAlpha}:t=fill`,
      `drawtext=fontfile=${font}:text='${TITLE}':x=${pad}:y=${tY}:fontsize=${tSize}:fontcolor=white:shadowcolor=black@0.6:shadowx=2:shadowy=2`,
      ...items.map((it, k)=>`drawtext=fontfile=${font}:text='${esc(bullet)+it}':x=${pad}:y=${iY}+${k}*${gap}:fontsize=${iSize}:fontcolor=white:shadowcolor=black@0.5:shadowx=1:shadowy=1`),
      `drawtext=fontfile=${font}:text='${CTA}':x=(w-text_w)/2:y=${ctaY}:fontsize=${cSize}:fontcolor=0xE0FFC8:box=1:boxcolor=black@0.55:boxborderw=24`,
      `format=yuv420p,scale=1080:1920`
    ].join(",");

    // inputs
    const bgArgs = BG.endsWith(".jpg") || BG.endsWith(".png")
      ? ["-loop","1","-i", BG]
      : ["-stream_loop","-1","-i", BG];

    const audioArgs = (AUDIO && fs.existsSync(AUDIO))
      ? ["-i", AUDIO]
      : ["-f","lavfi","-i","anullsrc=cl=stereo:r=44100"];

    const args = [
      "-y", ...bgArgs, ...audioArgs,
      "-t", String(DUR),
      "-filter_complex", draw,
      "-r","30","-c:v","libx264","-pix_fmt","yuv420p","-c:a","aac","-shortest",
      base
    ];
    const r = spawnSync("ffmpeg", args, { stdio:"inherit" });
    if (r.status !== 0) throw new Error("ffmpeg failed");
    console.log("[mp4]", base);
  }
}

main().catch(e=>{ console.error(e); process.exit(1); });
