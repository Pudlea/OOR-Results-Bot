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
//
// Fixes included:
// ✅ lastUpdated vs lastChecked treated separately
//    - lastUpdated: only changes when website scrape data changes (hash differs)
//    - lastChecked: updates every cron check (and manual /refresh check time)
// ✅ both timestamps always displayed as Discord user-local time (<t:...:F>)
// ✅ fix bug: render/update logic referenced `now` without defining it
// ✅ cleanup: remove unused/duplicated timestamp logic paths; single update pipeline

"use strict";

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
const { renderTripleStandingsPng, renderClassGridPng } = require("./render");

// ------------------ config ------------------
const configPath = path.join(__dirname, "config.json");
const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
const DEBUG_OOR = process.env.DEBUG_OOR === "1";

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
  if (DEBUG_OOR) console.log(`CHECK_AND_POST → ${msg}`);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function discordTimestamp(date, style = "F") {
  const unix = Math.floor(date.getTime() / 1000);
  return `<t:${unix}:${style}>`;
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

async function fetchSprintYellow() {
  const html = await fetchHtmlWithRetry(config.sprintSplitYellowStandingURL);
  const rows = parseStandingsTable(html, "PageContent_TeamsView_DXMainTable", "SprintYellow");
  validateRowsOrThrow(rows, "SprintYellow");

  const season = extractSeasonFromUrl(config.sprintSplitYellowStandingURL) || "??";
  return {
    title: `Split Yellow Sprint Standings — Season ${season} (${rows.length} drivers)`,
    subtitle: "Auto-updates when OOR standings change",
    rows,
  };
}

async function fetchSprintRed() {
  const html = await fetchHtmlWithRetry(config.sprintSplitRedStandingURL);
  const rows = parseStandingsTable(html, "PageContent_TeamsView_DXMainTable", "SprintRed");
  validateRowsOrThrow(rows, "SprintRed");

  const season = extractSeasonFromUrl(config.sprintSplitRedStandingURL) || "??";
  return {
    title: `Split Red Sprint Standings — Season ${season} (${rows.length} drivers)`,
    subtitle: "Auto-updates when OOR standings change",
    rows,
  };
}

// ---- Buttons ----
function buildButtonsRow() {
  const yellowBtn = new ButtonBuilder()
    .setCustomId("oor_class_yellow")
    .setLabel("🟡 Split Yellow Standings by Class")
    .setStyle(ButtonStyle.Secondary);

  const redBtn = new ButtonBuilder()
    .setCustomId("oor_class_red")
    .setLabel("🔴 Split Red Standings by Class")
    .setStyle(ButtonStyle.Secondary);

  return new ActionRowBuilder().addComponents(yellowBtn, redBtn);
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

async function scrapeAll() {
  const club50 = await fetchClub50();
  const yellow = await fetchSprintYellow();
  const red = await fetchSprintRed();
  return { club50, yellow, red };
}

function buildContent(lastUpdatedStr, lastCheckedStr) {
  const linkUrl = "https://results.octaneonlineracing.com/";
  const titleLink = "OCTANE ONLINE RACING STANDINGS - Click here for Full OOR Results Pages";

  return (
    `**[${titleLink}](${linkUrl})**\n` +
    `Last updated: **${lastUpdatedStr}**\n` +
    `Last checked: **${lastCheckedStr}**`
  );
}

/**
 * Update the Discord message in-place when possible.
 * - lastUpdated changes ONLY if dataHash changed
 * - lastChecked changes EVERY run (cron or /refresh)
 * - Render PNG ONLY when data changed OR message is missing.
 */
async function applyUpdate(channel, club50, yellow, red, nowDate) {
  const lastCheckedStr = discordTimestamp(nowDate, "F");
  const dataHash = sha1(JSON.stringify({ club50, yellow, red }));
  const unchanged = !!(config.lastHash && config.lastHash === dataHash);

  // lastUpdated: preserve on unchanged; set to "now" only when changed
  const lastUpdatedStr = unchanged
    ? (config.lastUpdated || lastCheckedStr)
    : discordTimestamp(nowDate, "F");

  // keep runtime cache fresh for buttons
  latest = {
    club50,
    yellow,
    red,
    lastCheckedStr,
    lastUpdatedStr,
    lastHash: dataHash,
  };

  // Try fetch existing message (if we have an ID)
  let existing = null;
  if (config.messageId) {
    try {
      existing = await channel.messages.fetch(config.messageId);
    } catch {
      existing = null;
    }
  }

  const content = buildContent(lastUpdatedStr, lastCheckedStr);

  // If message exists:
  // - unchanged: edit only content/components (keep old image attachment)
  // - changed: render and edit with new image
  if (existing) {
    if (unchanged) {
      logPath("UNCHANGED + message exists → edit content/components only");
      await existing.edit({
        content,
        components: [buildButtonsRow()],
      });
    } else {
      logPath("CHANGED + message exists → re-render and edit with new image");
      const png = await renderTripleStandingsPng(club50, yellow, red);
      const attachment = new AttachmentBuilder(png, { name: "standings.png" });

      await existing.edit({
        content,
        files: [attachment],
        components: [buildButtonsRow()],
      });
    }

    // Persist state
    config.lastChecked = lastCheckedStr;
    if (!unchanged) config.lastUpdated = lastUpdatedStr;
    config.lastHash = dataHash;
    saveConfig();

    return { unchanged, dataHash, lastUpdatedStr, lastCheckedStr };
  }

  // If message missing: must render and send a new message (even if unchanged)
  logPath(unchanged ? "UNCHANGED but message missing → render+send new" : "CHANGED + message missing → render+send new");
  const png = await renderTripleStandingsPng(club50, yellow, red);
  const attachment = new AttachmentBuilder(png, { name: "standings.png" });

  const sent = await channel.send({
    content,
    files: [attachment],
    components: [buildButtonsRow()],
  });

  config.messageId = sent.id;
  config.lastChecked = lastCheckedStr;
  if (!unchanged) config.lastUpdated = lastUpdatedStr; // only bump on changed
  else config.lastUpdated = config.lastUpdated || lastUpdatedStr; // ensure set if first ever run
  config.lastHash = dataHash;
  saveConfig();

  return { unchanged, dataHash, lastUpdatedStr, lastCheckedStr };
}

async function checkAndPost() {
  const channel = await client.channels.fetch(config.channelId);
  if (!channel || !channel.isTextBased()) {
    throw new Error("Configured channelId is not a text channel");
  }

  const nowDate = new Date();

  try {
    const { club50, yellow, red } = await scrapeAll();
    const result = await applyUpdate(channel, club50, yellow, red, nowDate);
    logPath(result.unchanged ? "DONE (unchanged)" : "DONE (changed)");
  } catch (e) {
    // still record the check time so you can see "we tried"
    try {
      config.lastChecked = discordTimestamp(nowDate, "F");
      saveConfig();
    } catch {}
    console.error("checkAndPost blocked (keeping existing Discord message):", e?.message || e);
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

  const splitLabel =
    which === "yellow" ? "Split Yellow Sprint Standings" : "Split Red Sprint Standings";

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

// ---- Slash command registration ----
async function registerSlashCommands() {
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
  await interaction.deferReply({ ephemeral: true });

  const nowMs = Date.now();
  if (nowMs - lastRefreshAt < REFRESH_COOLDOWN_MS) {
    const wait = Math.ceil((REFRESH_COOLDOWN_MS - (nowMs - lastRefreshAt)) / 1000);
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
  lastRefreshAt = nowMs;

  try {
    const channel = await client.channels.fetch(config.channelId);
    if (!channel || !channel.isTextBased()) throw new Error("Configured channelId is not a text channel");

    const nowDate = new Date();
    const { club50, yellow, red } = await scrapeAll();

    // Manual refresh still follows the same rules:
    // - lastChecked updates to now
    // - lastUpdated updates ONLY if data changed
    await applyUpdate(channel, club50, yellow, red, nowDate);

    await interaction.editReply("✅ Refreshed and updated the standings message (if data changed).");
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
    if (interaction.isButton()) {
      await safeAck(interaction);

      if (interaction.customId === "oor_class_yellow") {
        await handleClassButton(interaction, "yellow");
        return;
      }

      if (interaction.customId === "oor_class_red") {
        await handleClassButton(interaction, "red");
        return;
      }

      await interaction.editReply("Unknown button.");
      autoDeleteEphemeral(interaction, 10000);
      return;
    }

    if (interaction.isChatInputCommand()) {
      if (interaction.commandName === "refresh") {
        await handleRefreshCommand(interaction);
      }
    }
  } catch (e) {
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
