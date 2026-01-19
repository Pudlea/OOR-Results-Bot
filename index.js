// index.js
// Full replacement with slash command: /refresh
// Node 18+/24 compatible (uses global fetch).
// Discord.js v14 compatible.
//
// Features:
// - Main standings message with 3 panels: Club50 | Split Yellow | Split Red
// - Two buttons (grey) to render class-split 2x2 grid for Yellow or Red
// - Button interactions are ACK'd exactly once
// - Class render posts as a new channel message and deletes after 5 minutes
// - If interaction fails, ephemeral error is auto-deleted after 10 seconds
// - Slash command: /refresh (forces immediate scrape+render)

// ------------------ imports ------------------
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const {
  Client,
  GatewayIntentBits,
  AttachmentBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Events,
  REST,
  Routes,
  SlashCommandBuilder,
} = require("discord.js");

const cron = require("node-cron");
const cheerio = require("cheerio");
const {
  renderTripleStandingsPng,
  renderDoubleStandingsPng,
  renderSeriesOnlyPng,
  renderClassGridPng,
} = require("./render");

const { fetchSimgridStandings } = require("./standings");

// ------------------ config ------------------
const configPath = path.join(__dirname, "config.json");
const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
const DEBUG_OOR = process.env.DEBUG_OOR === "1";

// ------------------ button spam protection (v2.0+) ------------------
// Per-user, per-button cooldown. Set to 5 minutes to match render auto-delete.
const BUTTON_COOLDOWN_MS = 5 * 60 * 1000;
const buttonCooldowns = new Map(); // key: `${userId}:${buttonId}` -> last timestamp (ms)

function getButtonCooldownSeconds(userId, buttonId) {
  const key = `${userId}:${buttonId}`;
  const now = Date.now();
  const last = buttonCooldowns.get(key) || 0;

  if (now - last < BUTTON_COOLDOWN_MS) {
    return Math.ceil((BUTTON_COOLDOWN_MS - (now - last)) / 1000);
  }

  buttonCooldowns.set(key, now);
  return 0;
}

// ------------------ Sprint penalty sheet (v1.044+) ------------------
// Public Google Sheet with two tabs: Split Yellow / Split Red
// We scrape three columns and attach to Sprint standings rows:
// - Total -> penPoints
// - Qualifying Ban -> qualiBan
// - Ban Served -> banServed
const PENALTY_SHEET_ID = "1SJ3Sp-E-qFSxpR6caThRYBCH-Hm0YuOhT7jpINHTcKQ";
const PENALTY_TABS = {
  yellow: "Split Yellow",
  red: "Split Red",
};

function saveConfig() {
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), "utf8");
}

function mustConfig(value, name) {
  if (!value || typeof value !== "string" || !value.trim()) {
    throw new Error(`Missing ${name} in config.json`);
  }
}

// ---- Config migration / compatibility ----
if (
  (!config.sprintSplitYellowStandingURL || !String(config.sprintSplitYellowStandingURL).trim()) &&
  config.sprintStandingsURL &&
  String(config.sprintStandingsURL).trim()
) {
  config.sprintSplitYellowStandingURL = config.sprintStandingsURL;
  delete config.sprintStandingsURL;
  saveConfig();
  console.log("Migrated config: sprintStandingsURL -> sprintSplitYellowStandingURL");
}

mustConfig(config.token, "token");
mustConfig(config.channelId, "channelId");
mustConfig(config.standingsUrl, "standingsUrl");
mustConfig(config.sprintSplitYellowStandingURL, "sprintSplitYellowStandingURL");
mustConfig(config.sprintSplitRedStandingURL, "sprintSplitRedStandingURL");
mustConfig(config.checkCron, "checkCron");

// ------------------ discord client ------------------
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages],
});

// ------------------ helpers ------------------
function sha1(s) {
  return crypto.createHash("sha1").update(s).digest("hex");
}

function logPath(msg) {
  if (DEBUG_OOR) {
    console.log(`CHECK_AND_POST → ${msg}`);
  }
}

function logPathSimgrid(msg) {
  if (DEBUG_OOR) {
    console.log(`SIMGRID_CHECK_AND_POST → ${msg}`);
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchHtmlWithRetry(url, attempts = 3) {
  if (typeof fetch !== "function") {
    throw new Error("Global fetch() not available (Node 18+ required).");
  }

  let lastErr = null;

  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) OORBot/1.0",
          Accept: "text/html,application/xhtml+xml",
          "Accept-Language": "en-AU,en;q=0.9",
          "Cache-Control": "no-cache",
          Pragma: "no-cache",
        },
      });

      if (!res.ok) throw new Error(`Fetch failed (${res.status}) for ${url}`);
      const text = await res.text();

      if (!text.includes("PageContent_TeamsView_DXMainTable")) {
        throw new Error("HTML response missing expected standings table marker");
      }

      return text;
    } catch (e) {
      lastErr = e;
      if (DEBUG_OOR) console.warn(`Fetch attempt ${i + 1}/${attempts} failed:`, e?.message || e);
      if (i < attempts - 1) await sleep(700 + i * 500);
    }
  }

  throw lastErr || new Error("Fetch failed");
}

function normalize(s) {
  return String(s || "").replace(/\s+/g, " ").trim();
}

function normalizeNameKey(s) {
  return normalize(s).toLowerCase();
}

function normalizeCarNoKey(s) {
  // Keep only digits to avoid mismatches like "#27" vs "27"
  const t = normalize(s);
  const digits = t.replace(/[^0-9]/g, "");
  return digits || t;
}

function getHeaderCaption($, td) {
  const $td = $(td);
  const cap1 = normalize($td.find(".dx-ellipsis").first().text());
  if (cap1) return cap1;
  return normalize($td.text());
}

function findColumnIndex(headers, possibleNames) {
  const want = possibleNames.map((x) => x.toLowerCase());
  for (let i = 0; i < headers.length; i++) {
    const h = normalize(headers[i]).toLowerCase();
    if (want.includes(h)) return i;
  }
  return -1;
}

function getBestTextFromCell($, td) {
  const $td = $(td);
  const a = normalize($td.find("a").first().text());
  if (a) return a;
  const t = normalize($td.text());
  if (t) return t;
  const title = normalize($td.attr("title"));
  if (title) return title;
  const aria = normalize($td.attr("aria-label"));
  if (aria) return aria;
  return "";
}

function getImgSrcFromCell($, td) {
  const src = $(td).find("img").first().attr("src");
  return src ? String(src).trim() : "";
}

function parseStandingsTable(html, tableId, label) {
  const $ = cheerio.load(html);

  const table = $(`table#${tableId}`);
  if (!table.length) throw new Error(`Could not find table#${tableId}`);

  const headerRow = table.find("tr[id$='_DXHeadersRow0']").first();
  if (!headerRow.length) throw new Error(`Could not find header row for ${label}`);

  // ✅ ONLY direct header TDs
  const headerCells = headerRow.children("td").toArray();
  const headers = headerCells.map((td) => getHeaderCaption($, td));

  const idx = {
    pos: findColumnIndex(headers, ["#", "pos", "position"]),
    driver: findColumnIndex(headers, ["driver"]),
    carNo: findColumnIndex(headers, ["car#", "car #", "carno", "car no"]),
    className: findColumnIndex(headers, ["class"]),
    carImg: findColumnIndex(headers, ["car"]),
    countryImg: findColumnIndex(headers, ["country", "cou..."]),
    racePts: findColumnIndex(headers, ["race points", "race"]),
    qualiPts: findColumnIndex(headers, ["quali points", "quali"]),
    flPts: findColumnIndex(headers, ["fastest lap points", "fastest lap", "fl"]),
    total: findColumnIndex(headers, ["total"]),
    nett: findColumnIndex(headers, ["nett points", "nett"]),
    diff: findColumnIndex(headers, ["diff.", "diff"]),
  };

  const dataRows = table.find("tr[id^='PageContent_TeamsView_DXDataRow']").toArray();
  const rows = [];

  for (const tr of dataRows) {
    // ✅ ONLY direct TDs
    const tds = $(tr).children("td").toArray();
    if (!tds.length) continue;

    const safeText = (i) => (i >= 0 && i < tds.length ? normalize($(tds[i]).text()) : "");

    rows.push({
      pos: safeText(idx.pos),
      driver: idx.driver >= 0 ? getBestTextFromCell($, tds[idx.driver]) : "",
      carNo: safeText(idx.carNo),
      className: idx.className >= 0 ? safeText(idx.className) : "",
      carImg: idx.carImg >= 0 ? getImgSrcFromCell($, tds[idx.carImg]) : "",
      countryImg: idx.countryImg >= 0 ? getImgSrcFromCell($, tds[idx.countryImg]) : "",
      racePts: safeText(idx.racePts),
      qualiPts: safeText(idx.qualiPts),
      flPts: safeText(idx.flPts),
      total: safeText(idx.total),
      nett: safeText(idx.nett),
      diff: safeText(idx.diff),
    });
  }

  if (DEBUG_OOR) {
    console.log("\n==============================");
    console.log(`DEBUG_OOR: ${label}`);
    console.log("Headers:", headers);
    console.log("Column Map:", idx);
    console.log("Parsed rows:", rows.length);
    console.log("Sample row:", rows[0]);
  }

  return rows;
}

function validateRowsOrThrow(rows, label) {
  if (!rows || rows.length === 0) throw new Error(`${label}: parsed 0 rows`);

  const nonEmptyDrivers = rows.filter((r) => r.driver && r.driver.trim()).length;
  const nonEmptyCars = rows.filter((r) => r.carImg && r.carImg.trim()).length;

  if (nonEmptyDrivers < 3) throw new Error(`${label}: scrape looks empty (drivers missing).`);
  if (nonEmptyCars < 3) throw new Error(`${label}: scrape looks empty (car images missing).`);
}

// ------------------ Penalty sheet scraping ------------------
function parseGvizJson(text) {
  // Google gviz response looks like:
  //   /*O_o*/\ngoogle.visualization.Query.setResponse({...});
  const s = String(text || "");
  const marker = "google.visualization.Query.setResponse(";
  const start = s.indexOf(marker);
  if (start < 0) throw new Error("GVIZ: missing setResponse marker");
  const jsonStart = s.indexOf("{", start);
  const jsonEnd = s.lastIndexOf("}");
  if (jsonStart < 0 || jsonEnd < 0 || jsonEnd <= jsonStart) {
    throw new Error("GVIZ: could not locate JSON braces");
  }
  const payload = s.slice(jsonStart, jsonEnd + 1);
  return JSON.parse(payload);
}

async function fetchPenaltyTab(tabName) {
  const url =
    `https://docs.google.com/spreadsheets/d/${PENALTY_SHEET_ID}/gviz/tq?tqx=out:json&sheet=${encodeURIComponent(
      tabName
    )}`;

  const res = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) OORBot/1.0",
      Accept: "text/plain,*/*",
      "Cache-Control": "no-cache",
      Pragma: "no-cache",
    },
  });
  if (!res.ok) throw new Error(`Penalty sheet fetch failed (${res.status}) for tab ${tabName}`);
  const text = await res.text();
  const json = parseGvizJson(text);

  const table = json?.table;
  const cols = table?.cols || [];
  const rows = table?.rows || [];

  const colLabels = cols.map((c) => normalize(c?.label));
  const idxTotal = colLabels.findIndex((h) => h.toLowerCase() === "total");
  const idxQualiBan = colLabels.findIndex((h) => h.toLowerCase() === "qualifying ban");
  const idxBanServed = colLabels.findIndex((h) => h.toLowerCase() === "ban served");

  if (idxTotal < 0) throw new Error(`Penalty sheet tab ${tabName}: missing 'Total' column`);
  if (idxQualiBan < 0) throw new Error(`Penalty sheet tab ${tabName}: missing 'Qualifying Ban' column`);
  if (idxBanServed < 0) throw new Error(`Penalty sheet tab ${tabName}: missing 'Ban Served' column`);

  const byCarNo = new Map();
  const byName = new Map();

  const cellV = (r, i) => {
    const c = r?.c?.[i];
    const v = c?.f !== undefined && c?.f !== null ? c.f : c?.v;
    return v === null || v === undefined ? "" : String(v);
  };

  for (const r of rows) {
    // Car# is column A (0), Name is column B (1)
    const carNo = normalizeCarNoKey(cellV(r, 0));
    const name = normalize(cellV(r, 1));
    if (!carNo && !name) continue;

    const rec = {
      penPoints: normalize(cellV(r, idxTotal)) || "0",
      qualiBan: normalize(cellV(r, idxQualiBan)),
      banServed: normalize(cellV(r, idxBanServed)),
      _srcTab: tabName,
    };

    if (carNo) byCarNo.set(carNo, rec);
    if (name) byName.set(normalizeNameKey(name), rec);
  }

  if (DEBUG_OOR) {
    console.log(
      `DEBUG_OOR: Penalty Sheet loaded tab='${tabName}' rows=${rows.length} (carKeys=${byCarNo.size}, nameKeys=${byName.size})`
    );
  }

  return { tabName, byCarNo, byName };
}

async function fetchPenaltyIndex() {
  const [yellow, red] = await Promise.all([
    fetchPenaltyTab(PENALTY_TABS.yellow),
    fetchPenaltyTab(PENALTY_TABS.red),
  ]);
  return { yellow, red };
}

function attachPenaltiesToSprintRows(rows, penaltyTab, splitLabel) {
  if (!Array.isArray(rows)) return rows;
  for (const r of rows) {
    const carKey = normalizeCarNoKey(r?.carNo);
    const nameKey = normalizeNameKey(r?.driver);

    let rec = null;
    let method = "";
    if (carKey && penaltyTab?.byCarNo?.has?.(carKey)) {
      rec = penaltyTab.byCarNo.get(carKey);
      method = "car#";
    } else if (nameKey && penaltyTab?.byName?.has?.(nameKey)) {
      rec = penaltyTab.byName.get(nameKey);
      method = "name";
    }

    const penPoints = String(rec?.penPoints ?? "0");
    const qualiBan = String(rec?.qualiBan ?? "");
    const banServed = String(rec?.banServed ?? "");

    r.penPoints = penPoints || "0";
    r.qualiBan = qualiBan;
    r.banServed = banServed;
    r.qbActive = !!(normalize(qualiBan) && !normalize(banServed));

    if (DEBUG_OOR) {
      if (rec) {
        console.log(
          `DEBUG_OOR: Penalty match (${splitLabel}) ${method} car='${r.carNo}' driver='${r.driver}' -> penPoints='${r.penPoints}', qualiBan='${r.qualiBan}', banServed='${r.banServed}', qbActive=${r.qbActive}`
        );
      } else {
        console.log(
          `DEBUG_OOR: Penalty default (${splitLabel}) car='${r.carNo}' driver='${r.driver}' -> penPoints='0'`
        );
      }
    }
  }
  return rows;
}

function extractSeasonFromUrl(url) {
  try {
    const u = new URL(url);
    return u.searchParams.get("s") || "";
  } catch {
    return "";
  }
}

async function fetchClub50() {
  const html = await fetchHtmlWithRetry(config.standingsUrl);
  const rows = parseStandingsTable(html, "PageContent_TeamsView_DXMainTable", "Club50");
  validateRowsOrThrow(rows, "Club50");

  const season = extractSeasonFromUrl(config.standingsUrl) || "??";
  return {
    title: `Club 50 Standings — Season ${season} (${rows.length} drivers)`,
    subtitle: "Auto-updates when OOR standings change",
    rows,
  };
}

async function fetchSprintYellow(penaltyTab = null) {
  const html = await fetchHtmlWithRetry(config.sprintSplitYellowStandingURL);
  const rows = parseStandingsTable(html, "PageContent_TeamsView_DXMainTable", "SprintYellow");
  validateRowsOrThrow(rows, "SprintYellow");

  // v1.044+: attach penalty points + quali ban info
  if (penaltyTab) attachPenaltiesToSprintRows(rows, penaltyTab, "Yellow");

  const season = extractSeasonFromUrl(config.sprintSplitYellowStandingURL) || "??";
  return {
    title: `Split Yellow Sprint Standings — Season ${season} (${rows.length} drivers)`,
    subtitle: "Auto-updates when OOR standings change",
    rows,
  };
}

async function fetchSprintRed(penaltyTab = null) {
  const html = await fetchHtmlWithRetry(config.sprintSplitRedStandingURL);
  const rows = parseStandingsTable(html, "PageContent_TeamsView_DXMainTable", "SprintRed");
  validateRowsOrThrow(rows, "SprintRed");

  // v1.044+: attach penalty points + quali ban info
  if (penaltyTab) attachPenaltiesToSprintRows(rows, penaltyTab, "Red");

  const season = extractSeasonFromUrl(config.sprintSplitRedStandingURL) || "??";
  return {
    title: `Split Red Sprint Standings — Season ${season} (${rows.length} drivers)`,
    subtitle: "Auto-updates when OOR standings change",
    rows,
  };
}

function discordTimestamp(date, style = "F") {
  const unix = Math.floor(date.getTime() / 1000);
  return `<t:${unix}:${style}>`;
}

// ---- display names for 'These results are for' lines ----
const DISPLAY_NAME = {
  club50: "Club 50",
  yellow: "Sprints Split Yellow",
  red: "Sprints Split Red",
  hypercar: "LMU Hypercar",
  lmgt3: "LMU LMGT3",
};

const CONTAINS_MAIN = `${DISPLAY_NAME.club50}, ${DISPLAY_NAME.yellow}, ${DISPLAY_NAME.red}`;



async function upsertMessage(channel, payload, messageId) {
  if (messageId) {
    try {
      const existing = await channel.messages.fetch(messageId);
      await existing.edit(payload);
      return existing.id;
    } catch {
      // deleted/unknown -> send new
    }
  }
  const sent = await channel.send(payload);
  return sent.id;
}

// ---- Buttons ----
function buildMainActionRows() {
  // Row 1: series-only renders (match tints)
  const clubBtn = new ButtonBuilder()
    .setCustomId("oor_series_club50")
    .setLabel("🔵 Club 50 Only")
    .setStyle(ButtonStyle.Secondary);

  const yellowOnlyBtn = new ButtonBuilder()
    .setCustomId("oor_series_yellow")
    .setLabel("🟡 Split Yellow Only")
    .setStyle(ButtonStyle.Secondary);

  const redOnlyBtn = new ButtonBuilder()
    .setCustomId("oor_series_red")
    .setLabel("🔴 Split Red Only")
    .setStyle(ButtonStyle.Secondary);

  // Row 2: class split buttons (keep grouped together under the render)
  const yellowClassBtn = new ButtonBuilder()
    .setCustomId("oor_class_yellow")
    .setLabel("🟡 Split Yellow by Class")
    .setStyle(ButtonStyle.Secondary);

  const redClassBtn = new ButtonBuilder()
    .setCustomId("oor_class_red")
    .setLabel("🔴 Split Red by Class")
    .setStyle(ButtonStyle.Secondary);

  return [
    new ActionRowBuilder().addComponents(clubBtn, yellowOnlyBtn, redOnlyBtn),
    new ActionRowBuilder().addComponents(yellowClassBtn, redClassBtn),
  ];
}

function buildSimgridActionRows() {
  const hyperOnly = new ButtonBuilder()
    .setCustomId("oor_series_hypercar")
    .setLabel("🔴 Hypercar Only")
    .setStyle(ButtonStyle.Secondary);

  const lmgt3Only = new ButtonBuilder()
    .setCustomId("oor_series_lmgt3")
    .setLabel("🟢 LMGT3 Only")
    .setStyle(ButtonStyle.Secondary);

  return [new ActionRowBuilder().addComponents(hyperOnly, lmgt3Only)];
}

// ---- Class split logic ----
function toNumber(v) {
  const n = Number(String(v || "").replace(/[^\d.-]/g, ""));
  return Number.isFinite(n) ? n : 0;
}

function buildClassPanels(standings, splitLabel) {
  const rows = standings.rows || [];
  const seasonText = (standings.title || "").match(/Season\s+(\d+)/i)?.[1] || "??";

  const order = ["Pro", "Silver", "Pro-Am", "Am"];
  const panels = [];

  for (const cls of order) {
    const clsRows = rows
      .filter((r) => (r.className || "").trim().toLowerCase() === cls.toLowerCase())
      .sort((a, b) => toNumber(a.pos) - toNumber(b.pos));

    const seasonTitle = `${cls} — ${splitLabel} — Season ${seasonText} (${clsRows.length} drivers)`;

    if (!clsRows.length) {
      panels.push({
        title: seasonTitle,
        subtitle: "Auto-generated (Diff reset per class leader)",
        rows: [],
      });
      continue;
    }

    const leaderNett = toNumber(clsRows[0].nett);
    const rebuilt = clsRows.map((r, i) => {
      const nett = toNumber(r.nett);
      const diff = i === 0 ? 0 : nett - leaderNett;
      return { ...r, pos: String(i + 1), diff: String(diff) };
    });

    panels.push({
      title: `${cls} — ${splitLabel} — Season ${seasonText} (${rebuilt.length} drivers)`,
      subtitle: "Auto-generated (Diff reset per class leader)",
      rows: rebuilt,
    });
  }

  return panels;
}

// ---- runtime cache so buttons and /refresh use latest scraped data ----
let latest = {
  club50: null,
  yellow: null,
  red: null,
  lastCheckedStr: null,
  lastUpdatedStr: null,
  lastHash: null,
};

let latestSimgrid = {
  hyper: null,
  lmgt3: null,
};

async function scrapeAll() {
  const penaltyIndex = await fetchPenaltyIndex();
  const club50 = await fetchClub50();
  const yellow = await fetchSprintYellow(penaltyIndex?.yellow);
  const red = await fetchSprintRed(penaltyIndex?.red);
  return { club50, yellow, red };
}

async function renderAndPostToMainMessage(channel, club50, yellow, red, lastCheckedStr) {
  const now = new Date();
  const png = await renderTripleStandingsPng(club50, yellow, red);
  const dataHash = sha1(JSON.stringify({ club50, yellow, red }));

  const lastUpdatedStr =
    config.lastHash === dataHash ? (config.lastUpdated || lastCheckedStr) : discordTimestamp(now, "F");

  config.lastHash = dataHash;
  config.lastUpdated = lastUpdatedStr;
  config.lastChecked = lastCheckedStr;

  latest = { club50, yellow, red, lastCheckedStr, lastUpdatedStr, lastHash: dataHash };

  const attachment = new AttachmentBuilder(png, { name: "standings.png" });

  const linkUrl = "https://results.octaneonlineracing.com/";
  const titleLink = `OCTANE ONLINE RACING STANDINGS - Click here for Full OOR Results Pages`;

  const content =
    `**[${titleLink}](${linkUrl})**\n` +
    `Last updated: **${lastUpdatedStr}**\n` +
    `Last checked: **${lastCheckedStr}**\nThese results are for: **${CONTAINS_MAIN}**`;

  const payload = {
    content,
    files: [attachment],
    components: buildMainActionRows(),
  };

  const newMessageId = await upsertMessage(channel, payload, config.messageId || "");
  config.messageId = newMessageId;

  saveConfig();
  return { lastUpdatedStr, dataHash };
}



async function checkAndPostSimgrid(channel, force = false) {
  // Optional: if URLs not configured, skip quietly
  const hyperUrl = (config.simgridHypercarUrl || "").trim();
  const lmgt3Url = (config.simgridLmgt3Url || "").trim();
  if (!hyperUrl || !lmgt3Url) {
    if (DEBUG_OOR) console.log("SimGrid URLs not configured (simgridHypercarUrl/simgridLmgt3Url) — skipping.");
    return;
  }

  // Scrape + parse
  const hyper = await fetchSimgridStandings(hyperUrl, "SimGrid Hypercar");
  const lmgt3 = await fetchSimgridStandings(lmgt3Url, "SimGrid LMGT3");

  // Track check/updated timestamps for pane 2 independently of pane 1
  const now = new Date();
  const lastCheckedStr = discordTimestamp(now, "F");

  // Basic validation: driver names must not look like URLs
  const bad = (rows) => (rows || []).filter(r => /https?:\/\//i.test(String(r.driver||""))).length;
  if (bad(hyper.rows) > 0 || bad(lmgt3.rows) > 0) {
    throw new Error("SimGrid: scrape parsed but driver names look wrong (URL text)");
  }

  if (DEBUG_OOR) {
    console.log("\n==============================");
    console.log("DEBUG_OOR: SimGrid Hypercar");
    console.log("Parsed rows:", hyper.rows.length);
    console.log("Sample row:", hyper.rows[0]);
    console.log("\n==============================");
    console.log("DEBUG_OOR: SimGrid LMGT3");
    console.log("Parsed rows:", lmgt3.rows.length);
    console.log("Sample row:", lmgt3.rows[0]);
  }

  const dataHash = sha1(JSON.stringify({ hyper: hyper.rows, lmgt3: lmgt3.rows }));
  const unchanged = !!(config.simgridLastHash && config.simgridLastHash === dataHash);

  // For pane 2: only bump "Last updated" when the SimGrid standings hash changes.
  const lastUpdatedStr = unchanged
    ? (config.simgridLastUpdated || lastCheckedStr)
    : discordTimestamp(now, "F");

  logPathSimgrid(unchanged ? "DATA UNCHANGED (hash match)" : "DATA CHANGED (hash differs)");

  // Re-render when data changed OR message missing OR we explicitly force a refresh (e.g. /refresh)
  let shouldRender = force || !unchanged || !config.simgridMessageId;

  // Prepare message content (pane 2)
  const contains = `${DISPLAY_NAME.hypercar}, ${DISPLAY_NAME.lmgt3}`;
  const content =
    `Last updated: **${lastUpdatedStr}**\n` +
    `Last checked: **${lastCheckedStr}**\n` +
    `These results are for: **${contains}**`;

  // Keep runtime cache fresh so series buttons work
  latestSimgrid = {
    hyper: {
      title: `OOR WEC SERIES 6 — Hypercar (${hyper.rows.length} Drivers)`,
      subtitle: "Auto-updates when SimGrid standings change",
      rows: hyper.rows,
      tint: "#ff3b3b",
      mode: "simgrid",
    },
    lmgt3: {
      title: `OOR WEC SERIES 6 — LMGT3 (${lmgt3.rows.length} Drivers)`,
      subtitle: "Auto-updates when SimGrid standings change",
      rows: lmgt3.rows,
      tint: "#34c759",
      mode: "simgrid",
    },
  };

  // If unchanged and not forced, we can cheaply update text only
  if (!shouldRender && unchanged && config.simgridMessageId) {
    try {
      logPathSimgrid(`UNCHANGED + messageId present (${config.simgridMessageId}) → attempting edit`);
      const existing = await channel.messages.fetch(config.simgridMessageId);
      await existing.edit({ content, components: buildSimgridActionRows() });
      logPathSimgrid("UNCHANGED + edit SUCCESS → updated text only");

      config.simgridLastChecked = lastCheckedStr;
      // Preserve prior simgridLastUpdated when unchanged
      config.simgridLastUpdated = config.simgridLastUpdated || lastUpdatedStr;
      saveConfig();
      return;
    } catch {
      // message missing -> fall through and re-render/post
      logPathSimgrid("UNCHANGED but message MISSING → will POST NEW message");
      shouldRender = true;
    }
  }

  // Render image
  const titleHyperBase = "OOR WEC SERIES 6 — Hypercar";
  const titleLmgt3Base = "OOR WEC SERIES 6 — LMGT3";
  const titleHyperWithCount = `${titleHyperBase} (${hyper.rows.length} Drivers)`;
  const titleLmgt3WithCount = `${titleLmgt3Base} (${lmgt3.rows.length} Drivers)`;
  const png = await renderDoubleStandingsPng(
    {
      title: titleHyperWithCount,
      subtitle: "Auto-updates when SimGrid standings change",
      rows: hyper.rows,
      // tint is applied by render.js at the panel level
      tint: "#ff3b3b",
    },
    {
      title: titleLmgt3WithCount,
      subtitle: "Auto-updates when SimGrid standings change",
      rows: lmgt3.rows,
      tint: "#34c759",
    },
    {
      titleLeft: titleHyperWithCount,
      titleRight: titleLmgt3WithCount,
      // SimGrid pane tinting (subtle overlay applied in render.js)
      // Hypercar = red tint, LMGT3 = green tint
      tintLeft: "#ff3b3b",
      tintRight: "#34c759",
    }
  );

  const attachment = new AttachmentBuilder(png, { name: "simgrid.png" });

  // Prefer editing the existing message (keeps channel tidy). If it's missing, post a new one.
  if (config.simgridMessageId) {
    try {
      logPathSimgrid(`POST/EDIT path + messageId present (${config.simgridMessageId}) → attempting edit`);
      const existing = await channel.messages.fetch(config.simgridMessageId);
      await existing.edit({ content, files: [attachment], components: buildSimgridActionRows() });
      config.simgridLastHash = dataHash;
      config.simgridLastUpdated = lastUpdatedStr;
      config.simgridLastChecked = lastCheckedStr;
      saveConfig();

      logPathSimgrid("edit SUCCESS → updated image/content");
      return;
    } catch {
      // fall through to post new
      logPathSimgrid("existing message missing/failed → will POST NEW message");
    }
  }

  logPathSimgrid("POSTING NEW message");
  const sent = await channel.send({ content, files: [attachment], components: buildSimgridActionRows() });
  logPathSimgrid(`NEW message posted → id=${sent.id}`);
  config.simgridMessageId = sent.id;
  config.simgridLastHash = dataHash;
  config.simgridLastUpdated = lastUpdatedStr;
  config.simgridLastChecked = lastCheckedStr;
  saveConfig();
}

async function checkAndPost() {
  const channel = await client.channels.fetch(config.channelId);
  if (!channel || !channel.isTextBased()) {
    throw new Error("Configured channelId is not a text channel");
  }

  const now = new Date();
  const lastCheckedStr = discordTimestamp(now, "F"); // relative time


  try {
    const penaltyIndex = await fetchPenaltyIndex();
    const club50 = await fetchClub50();
    const yellow = await fetchSprintYellow(penaltyIndex?.yellow);
    const red = await fetchSprintRed(penaltyIndex?.red);

    const dataHash = sha1(JSON.stringify({ club50, yellow, red }));
    const unchanged = !!(config.lastHash && config.lastHash === dataHash);

    logPath(unchanged ? "DATA UNCHANGED (hash match)" : "DATA CHANGED (hash differs)");

    const titleLink = `OCTANE ONLINE RACING STANDINGS - Click here for Full OOR Results Pages`;
    const linkUrl = "https://results.octaneonlineracing.com/";

    // Always keep runtime cache fresh so buttons work
    const lastUpdatedStrForCache = unchanged
      ? (config.lastUpdated || lastCheckedStr)
      : discordTimestamp(now, "F");

    latest = {
      club50,
      yellow,
      red,
      lastCheckedStr,
      lastUpdatedStr: lastUpdatedStrForCache,
      lastHash: dataHash,
    };

    // ---------- UNCHANGED PATH: try edit existing message ----------
    if (unchanged && config.messageId) {
      logPath(`UNCHANGED + messageId present (${config.messageId}) → attempting edit`);

      const content =
        `**[${titleLink}](${linkUrl})**\n` +
        `Last updated: **${config.lastUpdated || lastCheckedStr}**\n` +
        `Last checked: **${lastCheckedStr}**\nThese results are for: **${CONTAINS_MAIN}**`;

      try {
        const existing = await channel.messages.fetch(config.messageId);
        await existing.edit({
          content,
          components: buildMainActionRows(),
        });

        logPath("UNCHANGED + edit SUCCESS → updated last checked only");

        config.lastChecked = lastCheckedStr;
        saveConfig();

        if (DEBUG_OOR) console.log("No change; updated last checked only.");
        try {
          await checkAndPostSimgrid(channel);
        } catch (e) {
          console.error("SimGrid checkAndPost failed (non-fatal):", e?.message || e);
        }
        return; // ✅ only return if edit succeeded
      } catch (e) {
        // Message missing/unknown -> fall through and post new
        logPath("UNCHANGED but message MISSING → will POST NEW message");
        console.warn("Existing message missing, will post new.");
        // do NOT wipe messageId yet; keep it for optional delete attempts
      }
    }

    // ---------- POST NEW MESSAGE PATH (changed OR message missing) ----------
    logPath(
      unchanged
        ? "POSTING NEW message (message missing but data unchanged)"
        : "POSTING NEW message (data changed)"
    );

    const oldMessageId = config.messageId || ""; // keep for deletion attempt

    const png = await renderTripleStandingsPng(club50, yellow, red);
    const attachment = new AttachmentBuilder(png, { name: "standings.png" });

    const lastUpdatedStr = unchanged
      ? (config.lastUpdated || lastCheckedStr) // unchanged but missing message → preserve lastUpdated
      : discordTimestamp(now, "F");

    const content =
      `**[${titleLink}](${linkUrl})**\n` +
      `Last updated: **${lastUpdatedStr}**\n` +
      `Last checked: **${lastCheckedStr}**\nThese results are for: **${CONTAINS_MAIN}**`;

    const sent = await channel.send({
      content,
      files: [attachment],
      components: buildMainActionRows(),
    });

    logPath(`NEW message posted → id=${sent.id}`);

    // If CHANGED: try delete old message to avoid duplicates
    if (!unchanged && oldMessageId) {
      try {
        const old = await channel.messages.fetch(oldMessageId);
        await old.delete();
        logPath(`Deleted old message → id=${oldMessageId}`);
      } catch (e) {
        const msg = String(e?.message || e);
        const code = String(e?.code || "");
        // If the message was manually deleted, Discord returns "Unknown Message" (code 10008).
        if (code === "10008" || /Unknown Message/i.test(msg)) {
          if (DEBUG_OOR) console.log("Old message already deleted (skipping)");
        } else {
          console.warn("Could not delete old message:", msg);
        }
      }
    }

    config.messageId = sent.id;
    config.lastHash = dataHash;
    config.lastUpdated = lastUpdatedStr;
    config.lastChecked = lastCheckedStr;
    saveConfig();

    try {
      await checkAndPostSimgrid(channel);
    } catch (e) {
      console.error("SimGrid checkAndPost failed (non-fatal):", e?.message || e);
    }

    if (DEBUG_OOR) {
      console.log(
        unchanged
          ? "Message missing but no data change; posted new message to restore it."
          : "Changed; posted new message and updated tracking."
      );
    }
  } catch (e) {
    console.error("checkAndPost blocked (keeping existing Discord message):", e?.message || e);
    config.lastChecked = lastCheckedStr;
    saveConfig();
  }
}

// ---- Interaction handler (buttons) ----
async function safeAck(interaction) {
  if (interaction.deferred || interaction.replied) return false;
  await interaction.deferReply({ ephemeral: true });
  return true;
}

function autoDeleteEphemeral(interaction, ms = 10000) {
  setTimeout(async () => {
    try {
      if (interaction.deferred || interaction.replied) {
        await interaction.deleteReply();
      }
    } catch {
      // ignore
    }
  }, ms);
}

async function handleClassButton(interaction, which) {
  const channel = interaction.channel;
  if (!channel || !channel.isTextBased()) throw new Error("Not a text channel");

  const data = which === "yellow" ? latest.yellow : which === "red" ? latest.red : null;
  if (!data) throw new Error("No cached standings yet — wait for the next scrape.");

  const splitLabel = which === "yellow" ? "Split Yellow Sprint Standings" : "Split Red Sprint Standings";
  const panels = buildClassPanels(data, splitLabel);
  const png = await renderClassGridPng(panels);

  const attachment = new AttachmentBuilder(png, { name: `class-${which}.png` });

  const posted = await channel.send({
    content: `**${splitLabel} by Class** (auto-generated)\nThis message will self-delete in **5 minutes**.`,
    files: [attachment],
  });

  setTimeout(async () => {
    try {
      await posted.delete();
    } catch {}
  }, 5 * 60 * 1000);

  await interaction.editReply("Posted the class standings render (will self-delete in 5 minutes).");
  autoDeleteEphemeral(interaction, 10000);
}

async function handleSeriesButton(interaction, which) {
  const channel = interaction.channel;
  if (!channel || !channel.isTextBased()) throw new Error("Not a text channel");

  let panel = null;
  let fileName = "series.png";

  if (which === "club50") {
    panel = { ...latest.club50, tint: "#2b6cff", mode: "default" };
    fileName = "club50-only.png";
  } else if (which === "yellow") {
    panel = { ...latest.yellow, tint: "#f6c343", mode: "default" };
    fileName = "yellow-only.png";
  } else if (which === "red") {
    panel = { ...latest.red, tint: "#ff3b3b", mode: "default" };
    fileName = "red-only.png";
  } else if (which === "hypercar") {
    panel = latestSimgrid.hyper ? { ...latestSimgrid.hyper } : null;
    fileName = "hypercar-only.png";
  } else if (which === "lmgt3") {
    panel = latestSimgrid.lmgt3 ? { ...latestSimgrid.lmgt3 } : null;
    fileName = "lmgt3-only.png";
  }

  if (!panel) throw new Error("No cached standings yet — wait for the next scrape.");

  const png = await renderSeriesOnlyPng(panel, { maxRowsPerCol: 30 });
  const attachment = new AttachmentBuilder(png, { name: fileName });

  const posted = await channel.send({
    content: `**${panel.title}** (series-only render)\nThis message will self-delete in **5 minutes**.`,
    files: [attachment],
  });

  setTimeout(async () => {
    try {
      await posted.delete();
    } catch {}
  }, 5 * 60 * 1000);

  await interaction.editReply("Posted the series-only render (will self-delete in 5 minutes).");
  autoDeleteEphemeral(interaction, 10000);
}

// ---- Slash command registration ----
async function registerSlashCommands() {
  // You MUST set guildId in config.json for instant updates:
  // "guildId": "YOUR_SERVER_ID"
  // If you don't set it, we fall back to global commands (can take ages to appear).
  const commands = [
    new SlashCommandBuilder().setName("refresh").setDescription("Force a standings refresh now"),
  ].map((c) => c.toJSON());

  const rest = new REST({ version: "10" }).setToken(config.token);

  if (config.guildId && String(config.guildId).trim()) {
    await rest.put(Routes.applicationGuildCommands(client.user.id, config.guildId), { body: commands });
    console.log("Registered guild slash commands.");
  } else {
    await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
    console.log("Registered GLOBAL slash commands (may take time to appear).");
  }
}

// ---- /refresh handling ----
let refreshLock = false;
let lastRefreshAt = 0;
const REFRESH_COOLDOWN_MS = 30_000;

async function handleRefreshCommand(interaction) {
  // ACK once
  await interaction.deferReply({ ephemeral: true });

  const now = Date.now();
  if (now - lastRefreshAt < REFRESH_COOLDOWN_MS) {
    const wait = Math.ceil((REFRESH_COOLDOWN_MS - (now - lastRefreshAt)) / 1000);
    await interaction.editReply(`Please wait ${wait}s before refreshing again.`);
    autoDeleteEphemeral(interaction, 10000);
    return;
  }

  if (refreshLock) {
    await interaction.editReply("A refresh is already running, try again in a moment.");
    autoDeleteEphemeral(interaction, 10000);
    return;
  }

  refreshLock = true;
  lastRefreshAt = now;

  try {
    const channel = await client.channels.fetch(config.channelId);
    if (!channel || !channel.isTextBased()) throw new Error("Configured channelId is not a text channel");

    // Use Discord timestamp so each viewer sees it in their own local timezone.
    const stamp = discordTimestamp(new Date(), "F");
    const { club50, yellow, red } = await scrapeAll();
    await renderAndPostToMainMessage(channel, club50, yellow, red, stamp);

    // Also refresh the SimGrid (second pane) immediately.
    // Force=true so /refresh always re-scrapes and re-renders the SimGrid message.
    let simgridOk = true;
    try {
      await checkAndPostSimgrid(channel, true);
    } catch (e) {
      simgridOk = false;
      console.warn("/refresh: SimGrid refresh failed (non-fatal):", e?.message || e);
    }

    await interaction.editReply(
      simgridOk
        ? "✅ Refreshed and updated both standings panels."
        : "⚠️ Refreshed the main standings panel, but SimGrid refresh failed. Check console logs."
    );
    autoDeleteEphemeral(interaction, 10000);
  } catch (e) {
    await interaction.editReply(`❌ Refresh failed: ${e?.message || e}`);
    autoDeleteEphemeral(interaction, 10000);
  } finally {
    refreshLock = false;
  }
}

// ---- startup ----
client.once(Events.ClientReady, async () => {
  console.log(`Logged in as ${client.user.tag}`);

  // Register slash commands after login (so client.user.id exists)
  try {
    await registerSlashCommands();
  } catch (e) {
    console.warn("Slash command registration failed:", e?.message || e);
  }

  await checkAndPost();

  cron.schedule(config.checkCron, async () => {
    await checkAndPost();
  });
});

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    // Buttons
    if (interaction.isButton()) {
      await safeAck(interaction);

      // ---- cooldown: stop command button spam (per-user, per-button) ----
      const wait = getButtonCooldownSeconds(interaction.user.id, interaction.customId);
      if (wait > 0) {
        await interaction.editReply(`⏳ Please wait ${wait}s before using this button again.`);
        autoDeleteEphemeral(interaction, 5000);
        return;
      }

      if (interaction.customId === "oor_class_yellow") {
        await handleClassButton(interaction, "yellow");
        return;
      }

      if (interaction.customId === "oor_class_red") {
        await handleClassButton(interaction, "red");
        return;
      }

      if (interaction.customId === "oor_series_club50") {
        await handleSeriesButton(interaction, "club50");
        return;
      }
      if (interaction.customId === "oor_series_yellow") {
        await handleSeriesButton(interaction, "yellow");
        return;
      }
      if (interaction.customId === "oor_series_red") {
        await handleSeriesButton(interaction, "red");
        return;
      }
      if (interaction.customId === "oor_series_hypercar") {
        await handleSeriesButton(interaction, "hypercar");
        return;
      }
      if (interaction.customId === "oor_series_lmgt3") {
        await handleSeriesButton(interaction, "lmgt3");
        return;
      }

      await interaction.editReply("Unknown button.");
      autoDeleteEphemeral(interaction, 10000);
      return;
    }

    // Slash commands
    if (interaction.isChatInputCommand()) {
      if (interaction.commandName === "refresh") {
        await handleRefreshCommand(interaction);
      }
    }
  } catch (e) {
    // best-effort fail-safe
    try {
      if (!interaction.deferred && !interaction.replied) {
        await interaction.deferReply({ ephemeral: true });
      }
      await interaction.editReply(`Failed: ${e?.message || e}`);
      autoDeleteEphemeral(interaction, 10000);
    } catch {}
  }
});

client.login(config.token);
