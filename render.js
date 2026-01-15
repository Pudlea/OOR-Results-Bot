// render.js
// Requires: npm i @napi-rs/canvas
// Node 18+ (uses global fetch). Node 24 OK.
//
// Exports:
// - renderTripleStandingsPng(club50, yellow, red)
// - renderClassGridPng(panels[4])  // Pro/Silver/Pro-Am/Am

const { createCanvas, loadImage } = require("@napi-rs/canvas");

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

// ---- Watermark tuning ----
const WATERMARK_WIDTH_PCT = 0.75;
// slight bump vs previous (0.12 -> 0.16)
const WATERMARK_OPACITY = 0.18;
const WATERMARK_Y_OFFSET = 0;

// ---- Caches ----
const imgCache = new Map(); // url -> Image | null
let unFlagImage = null;
let watermarkImage = null;

// ---- image loading ----
async function loadImageFromUrl(url) {
  if (!url) return null;
  if (imgCache.has(url)) return imgCache.get(url);
  try {
    const res = await fetch(url, { redirect: "follow" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    const img = await loadImage(buf);
    imgCache.set(url, img);
    return img;
  } catch {
    imgCache.set(url, null);
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

function hasAnyClass(rows) {
  return (rows || []).some((r) => normalizeText(r.className));
}

function columnsFor(rows) {
  const showClass = hasAnyClass(rows);

  const cols = [
    { key: "pos", label: "#", w: 34, align: "right" },
    { key: "driver", label: "Driver", w: 240, align: "left" },
    { key: "carNo", label: "Car#", w: 46, align: "right" },
  ];

  if (showClass) cols.push({ key: "className", label: "Class", w: 64, align: "left" });

  cols.push({ key: "carImg", label: "Car", w: 44, align: "center", isIcon: true });

  cols.push({ key: "racePts", label: "Race", w: 48, align: "right" });
  cols.push({ key: "qualiPts", label: "Qu", w: 48, align: "right" });
  cols.push({ key: "flPts", label: "FL", w: 34, align: "right" });
  cols.push({ key: "total", label: "Total", w: 44, align: "right" });
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
function logoTargetColor(url) {
  const u = String(url || "").toLowerCase();

  if (u.includes("mclaren")) return { r: 255, g: 106, b: 0 }; // orange
  if (u.includes("mercedes")) return { r: 255, g: 255, b: 255 };
  if (u.includes("bmw")) return { r: 255, g: 255, b: 255 };
  if (u.includes("honda")) return { r: 255, g: 255, b: 255 };

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
  const { x, y, w, h, title, subtitle, rows, tint } = panel;

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
  const cols = columnsFor(rows);
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

  const maxRows = rows.length;
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
    const r = rows[i] || {};
    const ry = tableY + HEAD_ROW_H + i * ROW_H;

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

        ctx.fillStyle = TEXT;
        ctx.textAlign = "left";
        ctx.textBaseline = "middle";
        ctx.fillText(name, ix + iconSize + iconPad, midY);
      } else if (c.isIcon && c.key === "carImg") {
        const url = normalizeText(r.carImg);
        const img = await loadImageFromUrl(url);
        if (img) {
          const iconBox = 16;
          const ix = cellX + (c.w - iconBox) / 2;
          const iy = ry + (ROW_H - iconBox) / 2;

          const fit = fitContain(img.width, img.height, iconBox, iconBox);
          const dx = ix + fit.x;
          const dy = iy + fit.y;

          ctx.imageSmoothingEnabled = true;
          ctx.imageSmoothingQuality = "high";

          const rgb = logoTargetColor(url);
          if (rgb) drawColorizedLogo(ctx, img, dx, dy, fit.w, fit.h, rgb);
          else ctx.drawImage(img, dx, dy, fit.w, fit.h);
        }
      } else {
        const v = normalizeText(r[c.key]);
        ctx.fillStyle = TEXT;

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

module.exports = {
  renderTripleStandingsPng,
  renderClassGridPng,
};
