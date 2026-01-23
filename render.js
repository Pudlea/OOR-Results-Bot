// render.js
// Requires: npm i @napi-rs/canvas
// Node 18+ (uses global fetch). Node 24 OK.
//
// Exports:
// - renderTripleStandingsPng(club50, yellow, red)
// - renderClassGridPng(panels[4])  // Pro/Silver/Pro-Am/Am
// - renderSeriesOnlyPng(panel, opts) // single series; auto-splits into 2 columns when >30 drivers

const { createCanvas, loadImage } = require("@napi-rs/canvas");

const DEBUG_OOR = process.env.DEBUG_OOR === "1";

// ---- External assets ----
const UN_FLAG_URL =
  "https://icons.iconarchive.com/icons/wikipedia/flags/64/UN-United-Nations-Flag-icon.png";

const OOR_WATERMARK_URL =
  "https://octaneonlineracing.com/wp-content/uploads/2022/12/cropped-OOR-HEADER-2.0-01.png";

// ---- Global styling ----
const BG_GRAD_TOP = "#0b1220";
const BG_GRAD_BOT = "#050a12";

// Class tints
const TINT_PRO     = "#f2f4f8";
const TINT_SILVER  = "#8fa1b8";
const TINT_PROAM   = "#1f2a36";
const TINT_AM      = "#ff3b3b";

// subtle tint strength
const TINT_ALPHA = 0.08;      // overall wash strength
const TINT_EDGE_ALPHA = 0.14; // slightly stronger on edges

// Option B: make cards/rows more transparent so watermark shows through
const CARD_BG_TOP = "rgba(18, 27, 43, 0.55)";
const CARD_BG_BOT = "rgba(11, 18, 32, 0.45)";
const CARD_STROKE = "rgba(255,255,255,0.06)";

// Slightly more transparent rows/header strip
const ROW_ODD = "rgba(255,255,255,0.015)";
const ROW_EVEN = "rgba(255,255,255,0.007)";
const GRID = "rgba(255,255,255,0.055)";

const TEXT = "rgba(255,255,255,0.92)";
const MUTED = "rgba(255,255,255,0.62)";
const HEADER = "rgba(255,255,255,0.74)";

// ---- Layout ----
const OUTER_PAD = 22;
const GAP = 22;

const PAD_INNER = 18;
const HEADER_H = 58;
const HEAD_ROW_H = 26;
const ROW_H = 26;

// ---- Single-series rendering ----
// If a series has more than MAX_ROWS_PER_COL drivers, it overflows into a second panel column.
const MAX_ROWS_PER_COL = 30;

// ---- Watermark tuning ----
const WATERMARK_WIDTH_PCT = 0.75;
// slight bump vs previous (0.12 -> 0.16)
const WATERMARK_OPACITY = 0.18;
const WATERMARK_Y_OFFSET = 0;

// ---- Helpers ----
function parseNum(value) {
  if (value === null || value === undefined) return 0;
  const s = String(value).replace(/,/g, "").trim();
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
}

function formatDiff(n) {
  if (!Number.isFinite(n)) return "0";
  // Avoid trailing .0
  if (Math.abs(n - Math.round(n)) < 1e-9) return String(Math.round(n));
  return String(Number(n.toFixed(1)));
}

// ---- Caches ----
const imgCache = new Map(); // url -> Image | null
let unFlagImage = null;
let watermarkImage = null;

// ---- image loading ----
async function loadImageFromUrl(url, { attempts = 4 } = {}) {
  if (!url) return null;
  if (imgCache.has(url)) return imgCache.get(url);

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  let lastErr = null;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url, {
        redirect: "follow",
        headers: {
          // Some CDNs (and Wikimedia) can reject requests without a UA/Accept.
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) OORBot/1.0",
          Accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
          "Cache-Control": "no-cache",
          Pragma: "no-cache",
        },
      });

      // Handle rate limiting gracefully
      if (res.status === 429 || res.status === 503) {
        const ra = res.headers?.get?.("retry-after");
        const raMs = ra && /^\d+$/.test(ra) ? Number(ra) * 1000 : 0;
        const backoff = Math.min(8000, 800 * Math.pow(2, i));
        const waitMs = Math.max(raMs, backoff);
        lastErr = new Error(`HTTP ${res.status}`);
        if (i < attempts - 1) {
          if (DEBUG_OOR) console.warn(`LOGO LOAD RETRY: ${url} → HTTP ${res.status} (wait ${waitMs}ms)`);
          await sleep(waitMs);
          continue;
        }
      }

      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const buf = Buffer.from(await res.arrayBuffer());
      const img = await loadImage(buf);
      imgCache.set(url, img);
      return img;
    } catch (e) {
      lastErr = e;
      if (i < attempts - 1) {
        await sleep(Math.min(4000, 500 * Math.pow(2, i)));
        continue;
      }
    }
  }

  if (DEBUG_OOR) {
    console.warn(`LOGO LOAD FAIL: ${url} → ${lastErr?.message || lastErr}`);
  }
  imgCache.set(url, null);
  return null;
}

// Load an image from a local file (relative to this file) if it exists.
// Used to avoid external rate limits for logo overrides.
async function loadImageFromLocal(relPath) {
  try {
    const fs = require("fs");
    const path = require("path");
    const abs = path.isAbsolute(relPath) ? relPath : path.join(__dirname, relPath);
    if (!fs.existsSync(abs)) return null;
    const buf = fs.readFileSync(abs);
    return await loadImage(buf);
  } catch {
    return null;
  }
}

// ---- drawing helpers ----
function hexToRgb(hex) {
  const h = String(hex || "").replace("#", "").trim();
  if (h.length !== 6) return null;
  const n = parseInt(h, 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

function roundRect(ctx, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

function fitContain(srcW, srcH, dstW, dstH) {
  const s = Math.min(dstW / srcW, dstH / srcH);
  const w = srcW * s;
  const h = srcH * s;
  return { w, h, x: (dstW - w) / 2, y: (dstH - h) / 2 };
}

function normalizeText(v) {
  if (v === null || v === undefined) return "";
  return String(v).replace(/\s+/g, " ").trim();
}

// ---- Sprint penalties (v1.045) ----
function isSprintSplitTitle(title) {
  const t = String(title || "");
  return /Split\s+(Yellow|Red)\s+Sprint/i.test(t);
}

// Split a trailing penalty suffix from a driver label.
// Examples:
//   "Name (3)" -> { base:"Name", suffix:" (3)" }
//   "Name (3 - QB)" -> { base:"Name", suffix:" (3 - QB)" }
// If no suffix present, returns { base:label, suffix:"" }.
function splitPenaltySuffix(label) {
  const s = normalizeText(label);
  // Match a trailing parenthesized suffix, e.g. " (3)" or " (3 - QB)".
  const m = s.match(/^(.*?)(\s*\([^)]*\))\s*$/);
  if (!m) return { base: s, suffix: "" };
  return { base: normalizeText(m[1]), suffix: m[2] };
}

function buildPenaltySuffixFromRow(r) {
  // Implements v1.045 logic based on row fields:
  // - If penPoints <= 0: no suffix
  // - If qualiBan set and banServed blank: " (<pen> - QB)"
  // - Otherwise, if penPoints > 0: " (<pen>)"
  const pen = Number(String(r?.penPoints ?? "0").replace(/[^0-9.-]/g, "")) || 0;
  if (!(pen > 0)) return "";
  const qualiBan = normalizeText(r?.qualiBan);
  const banServed = normalizeText(r?.banServed);
  if (qualiBan && !banServed) {
    return ` (${pen} - QB)`;
  }
  return ` (${pen})`;
}

function hasAnyClass(rows) {
  return (rows || []).some((r) => normalizeText(r.className));
}

function columnsFor(rows, opts = {}) {
  const mode = opts.mode || "default";
  const showClass = hasAnyClass(rows);

  const cols = [
    { key: "pos", label: "#", w: 34, align: "right" },
    {
      key: "driver",
      label: opts.isSprint ? "Driver - Pen Points in ()" : "Driver",
      w: 240,
      align: "left",
    },
    { key: "carNo", label: "Car#", w: 46, align: "right" },
  ];

  // SimGrid driver strings include a separate rating value; show it as its own column.
  if (mode === "simgrid") {
    cols[1].w = 190;
    cols.splice(2, 0, { key: "rating", label: "rating", w: 60, align: "right" });
  }

  if (showClass) cols.push({ key: "className", label: "Class", w: 64, align: "left" });

  cols.push({ key: "carImg", label: "Car", w: 44, align: "center", isIcon: true });

  // For SimGrid renders we don't want Race/Quali/FL/Total.
  if (mode !== "simgrid") {
    cols.push({ key: "racePts", label: "Race", w: 48, align: "right" });
    cols.push({ key: "qualiPts", label: "Qu", w: 48, align: "right" });
    cols.push({ key: "flPts", label: "FL", w: 34, align: "right" });
    cols.push({ key: "total", label: "Total", w: 44, align: "right" });
  }

  cols.push({ key: "nett", label: "Nett", w: 44, align: "right" });
  cols.push({ key: "diff", label: "Diff", w: 44, align: "right" });

  return cols;
}

function sumCols(cols) {
  return cols.reduce((a, c) => a + c.w, 0);
}

function drawText(ctx, text, x, y, align = "left") {
  ctx.textAlign = align;
  ctx.textBaseline = "middle";
  ctx.fillText(text, x, y);
}

function classBadgeStyle(className) {
  const c = String(className || "").toLowerCase();

  if (c === "pro") {
    return { bg: "#ffffff", fg: "#000000" };
  }
  if (c === "silver") {
    return { bg: "#c0c0c0", fg: "#000000" }; // true silver
  }
  if (c === "pro-am" || c === "proam" || c === "pro-am") {
    return { bg: "#000000", fg: "#ffffff" };
  }
  if (c === "am") {
    return { bg: "#ff0000", fg: "#ffffff" };
  }
  return null;
}

function splitDriversSuffix(title) {
  // Splits "... Season 24 (42 drivers)" into:
  // base = "... Season 24", drivers = "(42 drivers)"
  const t = String(title || "");
  const m = t.match(/^(.*?)(\s*\(\d+\s+drivers\))\s*$/i);
  if (!m) return { base: t, drivers: "" };
  return { base: m[1].trim(), drivers: m[2].trim() };
}

function splitTitleLeadingClass(title) {
  // expects: "Pro — Split Yellow Sprint Standings — Season 24 ..."
  const t = String(title || "");
  const m = t.match(/^\s*(Pro-Am|Pro|Silver|Am)\s*[—-]\s*(.+)$/i);
  if (!m) return null;
  return { classLabel: m[1], rest: m[2] };
}

function drawPill(ctx, x, yBaseline, text, style) {
  const padX = 12;     // wider padding
  const h = 26;        // taller pill
  const r = 12;

  ctx.save();
  ctx.font = "900 17px system-ui, -apple-system, Segoe UI, Roboto, Arial";
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";

  const textW = Math.ceil(ctx.measureText(text).width);
  const w = textW + padX * 2;

  // Convert alphabetic baseline -> pill top
  // 17px font: a good cap-height placement is baseline - ~18
  const yTop = Math.round(yBaseline - 20);

  // background
  ctx.fillStyle = style.bg;
  roundRect(ctx, x, yTop, w, h, r);
  ctx.fill();

  // text sits on the same baseline as the title
  ctx.fillStyle = style.fg;
  ctx.fillText(text, x + padX, yBaseline);

  ctx.restore();
  return w;
}

// ---- logo visibility corrections ----

const fs = require("fs");
const path = require("path");

// SimGrid often serves tiny/low-contrast manufacturer icons.
// Instead of fetching a dozen external brand marks (which can trigger HTTP 429), we:
// 1) **Override only the worst offenders** (McLaren + Toyota Gazoo) to known-good sources.
// 2) For all other makes, we keep the SimGrid icon but optionally apply a color treatment by make.
//
// You can also drop local PNGs into ./assets/logos/ to avoid *any* external fetch:
// - assets/logos/mclaren.png
// - assets/logos/toyota_gazoo.png
// IMPORTANT:
// - Wikimedia is rate-limiting you (HTTP 429), so **do not depend on it at runtime**.
// - For Toyota Gazoo Racing (and any other make you want to standardise), put a local PNG in:
//     ./assets/logos/<makeKey>.png
//   Example: ./assets/logos/toyota_gazoo.png
// - McLaren is additionally allowed to fall back to the OOR-hosted team logo (works reliably).
const LOGO_OVERRIDES = {
  // Honda (Sprint series): always use local logo to avoid external scraping / rate limits
  honda: { local: "assets/logos/honda.png", remote: "" },

  // Toyota Gazoo: use local file if present (recommended)
  toyota_gazoo: { local: "assets/logos/toyota_gazoo.png", remote: "" },

  // McLaren: local preferred, but safe remote fallback using the same McLaren logo as pane 1
  mclaren: {
    local: "assets/logos/mclaren.png",
    remote: "https://octaneonlineracing.com.au/wp-content/uploads/2021/09/TEAMS-2021_McLaren.png",
  },
};

function tryLoadLocalPng(relPath) {
  try {
    const abs = path.join(__dirname, relPath);
    if (!fs.existsSync(abs)) return null;
    const buf = fs.readFileSync(abs);
    // Cache by absolute path so we don't re-read each row
    const cacheKey = `file:${abs}`;
    if (imgCache.has(cacheKey)) return imgCache.get(cacheKey);
    // loadImage() can take a Buffer
    return loadImage(buf)
      .then((img) => {
        imgCache.set(cacheKey, img);
        return img;
      })
      .catch(() => {
        imgCache.set(cacheKey, null);
        return null;
      });
  } catch {
    return null;
  }
}

function detectLogoKey(url, makeKey) {
  // If the scraper provided a make key, trust it.
  const mk = String(makeKey || "").trim().toLowerCase();
  if (mk) return mk;

  const u = String(url || "").toLowerCase();

  // Team / series specific first
  if (u.includes("toyota") && (u.includes("gazoo") || u.includes("gr"))) return "toyota_gazoo";
  if (u.includes("toyota")) return "toyota_gazoo";

  // Marques
  if (u.includes("mclaren")) return "mclaren";
  if (u.includes("ferrari")) return "ferrari";
  if (u.includes("porsche")) return "porsche";
  if (u.includes("mercedes") || u.includes("amg")) return "mercedes";
  if (u.includes("bmw")) return "bmw";
  if (u.includes("cadillac")) return "cadillac";
  if (u.includes("peugeot")) return "peugeot";
  if (u.includes("alpine")) return "alpine";
  if (u.includes("lamborghini") || u.includes("lambo")) return "lamborghini";
  if (u.includes("aston")) return "aston_martin";
  if (u.includes("lexus")) return "lexus";
  if (u.includes("honda") || u.includes("acura")) return "honda";
  if (u.includes("chevrolet") || u.includes("chevy")) return "chevrolet";
  if (u.includes("corvette")) return "corvette";

  return null;
}

function logoTargetColorByKey(key) {
  const k = String(key || "").toLowerCase();
  if (!k) return null;

  // Keep it minimal: mostly white so icons read on dark backgrounds.
  if (k === "mclaren") return { r: 255, g: 106, b: 0 }; // orange accent
  if (k === "ferrari") return { r: 255, g: 215, b: 0 }; // yellow-ish

  if (
    [
      "mercedes",
      "bmw",
      "porsche",
      "aston_martin",
      "lexus",
      "honda",
      "lamborghini",
      "corvette",
      "chevrolet",
      "cadillac",
      "peugeot",
      "alpine",
      "toyota_gazoo",
    ].includes(k)
  ) {
    return { r: 255, g: 255, b: 255 };
  }

  return null;
}

function drawColorizedLogo(ctx, img, x, y, w, h, rgb) {
  const off = createCanvas(Math.max(1, Math.floor(w)), Math.max(1, Math.floor(h)));
  const octx = off.getContext("2d");
  octx.clearRect(0, 0, off.width, off.height);

  octx.imageSmoothingEnabled = true;
  octx.imageSmoothingQuality = "high";
  octx.drawImage(img, 0, 0, off.width, off.height);

  const id = octx.getImageData(0, 0, off.width, off.height);
  const data = id.data;

  for (let i = 0; i < data.length; i += 4) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    const a = data[i + 3] / 255;

    const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
    const mask = Math.max(0, 1 - lum);

    const outA = Math.min(1, a * (0.35 + 0.85 * mask));

    data[i] = rgb.r;
    data[i + 1] = rgb.g;
    data[i + 2] = rgb.b;
    data[i + 3] = Math.round(outA * 255);
  }

  octx.putImageData(id, 0, 0);
  ctx.drawImage(off, x, y);
}

// ---- Column scaling that DOES NOT drift ----
function buildScaledColumns(cols, tableW) {
  const baseW = sumCols(cols);
  const scale = Math.min(1, tableW / baseW);

  const floatCols = cols.map((c) => ({ ...c, wf: c.w * scale }));
  const widths = floatCols.map((c) => Math.floor(c.wf));

  let used = widths.reduce((a, n) => a + n, 0);
  let remain = tableW - used;

  const order = floatCols
    .map((c, i) => ({ i, frac: c.wf - Math.floor(c.wf) }))
    .sort((a, b) => b.frac - a.frac);

  for (let k = 0; k < order.length && remain > 0; k++) {
    widths[order[k].i] += 1;
    remain -= 1;
  }

  return floatCols.map((c, i) => ({ ...c, w: widths[i] }));
}

// ---- Watermark ----
async function drawWatermark(ctx, W, H) {
  if (!watermarkImage) watermarkImage = await loadImageFromUrl(OOR_WATERMARK_URL);
  if (!watermarkImage) return;

  const targetW = Math.floor(W * WATERMARK_WIDTH_PCT);
  const targetH = Math.floor(H * 0.6);
  const fit = fitContain(watermarkImage.width, watermarkImage.height, targetW, targetH);

  const x = Math.floor((W - targetW) / 2 + fit.x);
  const y = Math.floor((H - targetH) / 2 + fit.y + WATERMARK_Y_OFFSET);

  ctx.save();
  ctx.globalAlpha = WATERMARK_OPACITY;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(watermarkImage, x, y, fit.w, fit.h);
  ctx.restore();
}

async function drawPanel(ctx, panel) {
  const { x, y, w, h, title, subtitle, rows, tint, mode } = panel;

  // Card background
  const g = ctx.createLinearGradient(0, y, 0, y + h);
  g.addColorStop(0, CARD_BG_TOP);
  g.addColorStop(1, CARD_BG_BOT);

  roundRect(ctx, x, y, w, h, 18);
  ctx.fillStyle = g;
  ctx.fill();
  ctx.strokeStyle = CARD_STROKE;
  ctx.lineWidth = 1;
  ctx.stroke();

  // optional tint overlay (very subtle)
  if (tint) {
    const rgb = hexToRgb(tint);
    if (rgb) {
      // ---- per-class alpha tuning ----
     let baseAlpha = TINT_ALPHA;
     let edgeAlpha = TINT_EDGE_ALPHA;

     if (tint === "#1f2a36") {        // Pro-Am (dark charcoal)
       baseAlpha *= 1.65;
       edgeAlpha *= 1.65;
     } else if (tint === "#8fa1b8") { // Silver
       baseAlpha *= 1.35;
       edgeAlpha *= 1.35;
     }

      ctx.save();
      roundRect(ctx, x, y, w, h, 18);
      ctx.clip();

      // soft radial glow from top-left + slight edge wash
      const rad = ctx.createRadialGradient(x + w * 0.22, y + h * 0.18, 10, x + w * 0.22, y + h * 0.18, Math.max(w, h));
      rad.addColorStop(0, `rgba(${rgb.r},${rgb.g},${rgb.b},${edgeAlpha})`);
      rad.addColorStop(0.55, `rgba(${rgb.r},${rgb.g},${rgb.b},${baseAlpha})`);
      rad.addColorStop(1, `rgba(${rgb.r},${rgb.g},${rgb.b},0)`);
      ctx.fillStyle = rad;
      ctx.fillRect(x, y, w, h);

      ctx.restore();
    }
  }


  const pad = PAD_INNER;

  ctx.save();
  roundRect(ctx, x, y, w, h, 18);
  ctx.clip();

 // Title / subtitle
 ctx.textAlign = "left";

 // Try class badge only if title starts with a class (your class grid titles do)
 const split = splitTitleLeadingClass(title);
if (split) {
  const style = classBadgeStyle(split.classLabel);
  const yTitle = y + 25;

  // split "(x drivers)" to a second line
  const { base, drivers } = splitDriversSuffix(split.rest);

  const badgeW = style ? drawPill(ctx, x + pad, yTitle, split.classLabel, style) : 0;

  // main title text (without drivers)
  ctx.font = "700 19px system-ui, -apple-system, Segoe UI, Roboto, Arial";
  ctx.fillStyle = TEXT;
  ctx.textBaseline = "alphabetic";
  ctx.fillText(base, x + pad + badgeW + 10, yTitle);

  // drivers count on second line (smaller/muted)
  if (drivers) {
    ctx.font = "600 13px system-ui, -apple-system, Segoe UI, Roboto, Arial";
    ctx.fillStyle = MUTED;
    ctx.fillText(drivers, x + pad + badgeW + 10, yTitle + 18);
  }
} else {
  // Normal (main render titles)
  const { base, drivers } = splitDriversSuffix(title);

  ctx.font = "700 19px system-ui, -apple-system, Segoe UI, Roboto, Arial";
  ctx.fillStyle = TEXT;
  ctx.textBaseline = "alphabetic";
  ctx.fillText(base, x + pad, y + 25);

  if (drivers) {
    ctx.font = "600 13px system-ui, -apple-system, Segoe UI, Roboto, Arial";
    ctx.fillStyle = MUTED;
    ctx.fillText(drivers, x + pad, y + 43);
  }
}

  ctx.font = "500 12.5px system-ui, -apple-system, Segoe UI, Roboto, Arial";
  ctx.fillStyle = MUTED;
  ctx.fillText(subtitle || "", x + pad, y + 64);

  // Table layout
  let drawRows = rows;
  const panelMode = mode || "default";

  // SimGrid: we show fewer columns, and the Diff column is calculated from Nett
  // (top driver = 0, everyone else = their Nett - top Nett).
  if (panelMode === "simgrid" && Array.isArray(rows) && rows.length > 0) {
    const topNett = parseNum(rows[0]?.nett);
    drawRows = rows.map((r, idx) => {
      const thisNett = parseNum(r?.nett);
      const d = idx === 0 ? 0 : (thisNett - topNett);
      return { ...r, diff: formatDiff(d) };
    });
  }

  // Sprint Yellow/Red panels (all renders): detect via title so index.js doesn't need changes.
  const sprintSplit = panelMode !== "simgrid" && isSprintSplitTitle(title);

  const cols = columnsFor(drawRows, { mode: panelMode, isSprint: sprintSplit });
  const tableX = x + pad;
  const tableY = y + HEADER_H + 8;
  const tableW = w - pad * 2;

  const scaledCols = buildScaledColumns(cols, tableW);

  // Header row bg (more transparent)
  ctx.fillStyle = "rgba(255,255,255,0.020)";
  ctx.fillRect(tableX, tableY, tableW, HEAD_ROW_H);

  // Header labels
  ctx.font = "600 12.5px system-ui, -apple-system, Segoe UI, Roboto, Arial";
  ctx.fillStyle = HEADER;

  let cx = tableX;
  for (const c of scaledCols) {
    const tx =
      c.align === "left"
        ? cx + 8
        : c.align === "center"
        ? cx + c.w / 2
        : cx + c.w - 8;
    drawText(ctx, c.label, tx, tableY + HEAD_ROW_H / 2, c.align);
    cx += c.w;
  }

  // Grid lines
  ctx.strokeStyle = GRID;
  ctx.lineWidth = 1;

  const maxRows = drawRows.length;
  const gridH = HEAD_ROW_H + ROW_H * maxRows;

  cx = tableX;
  for (let i = 0; i < scaledCols.length - 1; i++) {
    cx += scaledCols[i].w;
    ctx.beginPath();
    ctx.moveTo(cx + 0.5, tableY);
    ctx.lineTo(cx + 0.5, tableY + gridH);
    ctx.stroke();
  }

  // Rows
  ctx.font = "500 12.5px system-ui, -apple-system, Segoe UI, Roboto, Arial";

  for (let i = 0; i < maxRows; i++) {
    const r = drawRows[i] || {};
    const ry = tableY + HEAD_ROW_H + i * ROW_H;

    // Sprint QB highlight (bright red) when Qualifying Ban is set and Ban Served is blank.
    // Prefer the explicit flag if index.js provided it.
    const qbActive =
      sprintSplit &&
      (r?.qbActive === true || (!!normalizeText(r?.qualiBan) && !normalizeText(r?.banServed)));
    const rowTextColor = qbActive ? "#ff0000" : TEXT;

    ctx.fillStyle = i % 2 === 0 ? ROW_EVEN : ROW_ODD;
    ctx.fillRect(tableX, ry, tableW, ROW_H);

    let cellX = tableX;
    for (const c of scaledCols) {
      const midY = ry + ROW_H / 2;

      if (c.key === "driver") {
        const name = normalizeText(r.driver);
        const flagUrl = normalizeText(r.countryImg);
        const flagImg = (await loadImageFromUrl(flagUrl)) || unFlagImage;

        const iconSize = 14;
        const iconPad = 6;
        const ix = cellX + 8;
        const iy = ry + (ROW_H - iconSize) / 2;

        if (flagImg) {
          const fit = fitContain(flagImg.width, flagImg.height, iconSize, iconSize);
          ctx.imageSmoothingEnabled = true;
          ctx.imageSmoothingQuality = "high";
          ctx.drawImage(flagImg, ix + fit.x, iy + fit.y, fit.w, fit.h);
        }

        const textX = ix + iconSize + iconPad;

        // For Sprint splits, draw the penalty suffix in bright red, but keep the driver name white.
        // If QB is active, the whole row stays bright red (per previous requirement).
        if (sprintSplit && !qbActive) {
          const parts = splitPenaltySuffix(name);
          const dynSuffix = buildPenaltySuffixFromRow(r);
          const base = parts.base;
          const suffix = dynSuffix || parts.suffix;

          ctx.textAlign = "left";
          ctx.textBaseline = "middle";

          // Base name (white)
          ctx.fillStyle = TEXT;
          ctx.fillText(base, textX, midY);

          // Suffix (bright red) if present
          if (suffix) {
            const baseW = ctx.measureText(base).width;
            ctx.fillStyle = "#ff0000";
            ctx.fillText(suffix, textX + baseW, midY);
          }
        } else {
          // QB-active rows stay fully red; just include the penalty suffix text.
          let displayName = name;

          if (sprintSplit && qbActive) {
            const parts = splitPenaltySuffix(name);
            const dynSuffix = buildPenaltySuffixFromRow(r); // "(X - QB)" or ""
            displayName = parts.base + (dynSuffix || parts.suffix);
          }

          ctx.fillStyle = rowTextColor;
          ctx.textAlign = "left";
          ctx.textBaseline = "middle";
          ctx.fillText(displayName, textX, midY);
        }
      } else if (c.isIcon && c.key === "carImg") {
        const url = normalizeText(r.carImg);

        // Decide the brand key (prefer the scraper-provided make key).
        const key = detectLogoKey(url, r.carMakeKey);

        // Override only where it matters (McLaren + Toyota Gazoo). Others are handled via color treatment.
        let img = null;
        let isOverride = false;

        const ov = key && LOGO_OVERRIDES[key] ? LOGO_OVERRIDES[key] : null;
        if (ov) {
          // Try local file first (if present), then remote.
          img = await tryLoadLocalPng(ov.local);
          if (!img) img = await loadImageFromUrl(ov.remote);

          if (img) {
            isOverride = true;
          } else if (DEBUG_OOR) {
            console.warn(
              `LOGO OVERRIDE MISS: key='${key}' local='${ov.local}' remote='${ov.remote}' (falling back to SimGrid icon)`
            );
          }
        }

        // Fall back to the original SimGrid/OOR icon.
        if (!img) img = await loadImageFromUrl(url);

        if (img) {
          const iconBox = 16;
          const ix = cellX + (c.w - iconBox) / 2;
          const iy = ry + (ROW_H - iconBox) / 2;

          const fit = fitContain(img.width, img.height, iconBox, iconBox);
          const dx = ix + fit.x;
          const dy = iy + fit.y;

          ctx.imageSmoothingEnabled = true;
          ctx.imageSmoothingQuality = "high";

          // McLaren must ALWAYS be papaya, even when using override logos.
          if (key === "mclaren") {
            drawColorizedLogo(ctx, img, dx, dy, fit.w, fit.h, { r: 255, g: 106, b: 0 });
          } else if (isOverride) {
            // Other overrides (Toyota Gazoo etc.) render as-is.
            ctx.drawImage(img, dx, dy, fit.w, fit.h);
          } else {
            // All other makes: render the original icon as-is (no recolour).
            ctx.drawImage(img, dx, dy, fit.w, fit.h);
          }
        }
      } else {
        const v = normalizeText(r[c.key]);
        ctx.fillStyle = rowTextColor;

        const tx =
          c.align === "left"
            ? cellX + 8
            : c.align === "center"
            ? cellX + c.w / 2
            : cellX + c.w - 8;
        drawText(ctx, v, tx, midY, c.align);
      }

      cellX += c.w;
    }
  }

  ctx.restore();
}

// ---- compute height so we show ALL drivers ----
function panelHeightForRows(rows) {
  const n = (rows || []).length;
  const innerTableH = HEAD_ROW_H + ROW_H * n;
  const total = OUTER_PAD * 2 + HEADER_H + 8 + innerTableH + 18;
  return Math.max(420, total);
}

// ---- Render: Triple main ----
async function renderTripleStandingsPng(club50, yellow, red) {
  if (!unFlagImage) unFlagImage = await loadImageFromUrl(UN_FLAG_URL);

  const W = 1720;
  const H = Math.max(
    panelHeightForRows(club50.rows),
    panelHeightForRows(yellow.rows),
    panelHeightForRows(red.rows)
  );

  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext("2d");

  const bg = ctx.createLinearGradient(0, 0, 0, H);
  bg.addColorStop(0, BG_GRAD_TOP);
  bg.addColorStop(1, BG_GRAD_BOT);
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);

  await drawWatermark(ctx, W, H);

  const panelW = Math.floor((W - OUTER_PAD * 2 - GAP * 2) / 3);
  const panelH = H - OUTER_PAD * 2;

  await drawPanel(ctx, {
    x: OUTER_PAD,
    y: OUTER_PAD,
    w: panelW,
    h: panelH,
    title: club50.title,
    subtitle: club50.subtitle,
    rows: club50.rows,
    tint: "#2b6cff", // optional / neutral blue for Club50
  });

  await drawPanel(ctx, {
    x: OUTER_PAD + panelW + GAP,
    y: OUTER_PAD,
    w: panelW,
    h: panelH,
    title: yellow.title,
    subtitle: yellow.subtitle,
    rows: yellow.rows,
    tint: "#f6c343", // Split Yellow tint
  });

  await drawPanel(ctx, {
    x: OUTER_PAD + (panelW + GAP) * 2,
    y: OUTER_PAD,
    w: panelW,
    h: panelH,
    title: red.title,
    subtitle: red.subtitle,
    rows: red.rows,
    tint: "#ff3b3b", // Split Red tint
  });

  return canvas.toBuffer("image/png");
}

// ---- Render: 2x2 class grid ----
async function renderClassGridPng(panels) {
  if (!unFlagImage) unFlagImage = await loadImageFromUrl(UN_FLAG_URL);

  const cellMinH = 360;

  function cellHeightFor(rows) {
    const n = (rows || []).length;
    return Math.max(cellMinH, HEADER_H + 8 + HEAD_ROW_H + ROW_H * n + 28);
  }

  const p = (i) => (panels[i] ? panels[i] : { title: "—", subtitle: "", rows: [] });

  const h0 = cellHeightFor(p(0).rows);
  const h1 = cellHeightFor(p(1).rows);
  const h2 = cellHeightFor(p(2).rows);
  const h3 = cellHeightFor(p(3).rows);

  const topH = Math.max(h0, h1);
  const botH = Math.max(h2, h3);

  const W = 1200;
  const H = OUTER_PAD * 2 + topH + GAP + botH;

  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext("2d");

  const bg = ctx.createLinearGradient(0, 0, 0, H);
  bg.addColorStop(0, BG_GRAD_TOP);
  bg.addColorStop(1, BG_GRAD_BOT);
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);

  await drawWatermark(ctx, W, H);

  const cellW = Math.floor((W - OUTER_PAD * 2 - GAP) / 2);

  const p0 = p(0);
  const p1 = p(1);
  const p2 = p(2);
  const p3 = p(3);

  await drawPanel(ctx, { x: OUTER_PAD,                 y: OUTER_PAD,               w: cellW, h: h0, tint: TINT_PRO,    ...p0 });
  await drawPanel(ctx, { x: OUTER_PAD + cellW + GAP,   y: OUTER_PAD,               w: cellW, h: h1, tint: TINT_SILVER, ...p1 });
  await drawPanel(ctx, { x: OUTER_PAD,                 y: OUTER_PAD + topH + GAP,  w: cellW, h: h2, tint: TINT_PROAM,  ...p2 });
  await drawPanel(ctx, { x: OUTER_PAD + cellW + GAP,   y: OUTER_PAD + topH + GAP,  w: cellW, h: h3, tint: TINT_AM,     ...p3 });

  return canvas.toBuffer("image/png");
}

// ---- Render: 2-wide row (used for SimGrid second pane) ----
// IMPORTANT: This intentionally has NO overall heading.
// Each panel carries its own title + subtitle so it matches the main 3-panel layout.
async function renderDoubleStandingsPng(leftPanel, rightPanel) {
  if (!unFlagImage) unFlagImage = await loadImageFromUrl(UN_FLAG_URL);

  const cellMinH = 360;
  const heightFor = (rows) => {
    const n = (rows || []).length;
    return Math.max(cellMinH, HEADER_H + 8 + HEAD_ROW_H + ROW_H * n + 28);
  };

  const L = leftPanel || { title: "—", subtitle: "", rows: [], tint: undefined };
  const R = rightPanel || { title: "—", subtitle: "", rows: [], tint: undefined };

  const W = 1200;
  const panelW = Math.floor((W - OUTER_PAD * 2 - GAP) / 2);
  const panelH = Math.max(heightFor(L.rows), heightFor(R.rows));
  const H = OUTER_PAD * 2 + panelH;

  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext("2d");

  const bg = ctx.createLinearGradient(0, 0, 0, H);
  bg.addColorStop(0, BG_GRAD_TOP);
  bg.addColorStop(1, BG_GRAD_BOT);
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);

  await drawWatermark(ctx, W, H);

  await drawPanel(ctx, {
    x: OUTER_PAD,
    y: OUTER_PAD,
    w: panelW,
    h: panelH,
    title: L.title,
    subtitle: L.subtitle,
    rows: L.rows,
    tint: L.tint,
    mode: "simgrid",
  });

  await drawPanel(ctx, {
    x: OUTER_PAD + panelW + GAP,
    y: OUTER_PAD,
    w: panelW,
    h: panelH,
    title: R.title,
    subtitle: R.subtitle,
    rows: R.rows,
    tint: R.tint,
    mode: "simgrid",
  });

  return canvas.toBuffer("image/png");
}

// ---- Render: Single series (auto 1 or 2 columns) ----
// panel: { title, subtitle, rows, tint, mode }
// opts: { maxRowsPerCol }
async function renderSeriesOnlyPng(panel, opts = {}) {
  if (!unFlagImage) unFlagImage = await loadImageFromUrl(UN_FLAG_URL);

  const maxRowsPerCol = Number.isFinite(opts.maxRowsPerCol)
    ? Math.max(5, Math.floor(opts.maxRowsPerCol))
    : MAX_ROWS_PER_COL;

  const P = panel || { title: "—", subtitle: "", rows: [], tint: undefined, mode: "default" };
  const rows = Array.isArray(P.rows) ? P.rows : [];
  const mode = P.mode || "default";

  const needsTwo = rows.length > maxRowsPerCol;

  // Split rows while keeping original positions.
  const leftRows = rows.slice(0, maxRowsPerCol);
  const rightRows = needsTwo ? rows.slice(maxRowsPerCol, maxRowsPerCol * 2) : [];

  const cellMinH = 360;
  const heightFor = (rs) => {
    const n = (rs || []).length;
    return Math.max(cellMinH, HEADER_H + 8 + HEAD_ROW_H + ROW_H * n + 28);
  };

  if (!needsTwo) {
    // Single panel render (narrower than 2-up)
    const W = 900;
    const panelW = W - OUTER_PAD * 2;
    const panelH = heightFor(leftRows);
    const H = OUTER_PAD * 2 + panelH;

    const canvas = createCanvas(W, H);
    const ctx = canvas.getContext("2d");

    const bg = ctx.createLinearGradient(0, 0, 0, H);
    bg.addColorStop(0, BG_GRAD_TOP);
    bg.addColorStop(1, BG_GRAD_BOT);
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, W, H);

    await drawWatermark(ctx, W, H);

    await drawPanel(ctx, {
      x: OUTER_PAD,
      y: OUTER_PAD,
      w: panelW,
      h: panelH,
      title: P.title,
      subtitle: P.subtitle,
      rows: leftRows,
      tint: P.tint,
      mode,
    });

    return canvas.toBuffer("image/png");
  }

  // Two-panel render
  const W = 1200;
  const panelW = Math.floor((W - OUTER_PAD * 2 - GAP) / 2);
  const panelH = Math.max(heightFor(leftRows), heightFor(rightRows));
  const H = OUTER_PAD * 2 + panelH;

  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext("2d");

  const bg = ctx.createLinearGradient(0, 0, 0, H);
  bg.addColorStop(0, BG_GRAD_TOP);
  bg.addColorStop(1, BG_GRAD_BOT);
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);

  await drawWatermark(ctx, W, H);

  await drawPanel(ctx, {
    x: OUTER_PAD,
    y: OUTER_PAD,
    w: panelW,
    h: panelH,
    title: P.title,
    subtitle: P.subtitle,
    rows: leftRows,
    tint: P.tint,
    mode,
  });

  await drawPanel(ctx, {
    x: OUTER_PAD + panelW + GAP,
    y: OUTER_PAD,
    w: panelW,
    h: panelH,
    title: P.title,
    subtitle: P.subtitle,
    rows: rightRows,
    tint: P.tint,
    mode,
  });

  return canvas.toBuffer("image/png");
}

module.exports = {
  renderTripleStandingsPng,
  renderDoubleStandingsPng,
  renderSeriesOnlyPng,
  renderClassGridPng,
};
