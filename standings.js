// standings.js
const axios = require("axios");
const cheerio = require("cheerio");

const DEBUG = process.env.DEBUG_OOR === "1";

function norm(s) {
  return String(s || "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function extractHeaderCells($, $headerRow) {
  const tds = $headerRow.children("td").toArray();
  return tds.map((td) => {
    const $td = $(td);
    let txt = $td.find(".dx-ellipsis").first().text();
    if (!txt) txt = $td.text();
    return String(txt).replace(/\s+/g, " ").trim();
  });
}

function findHeaderRow($, $table) {
  let $headerRow = $table.find("tr[id$='_DXHeadersRow0']").first();
  if ($headerRow.length) return $headerRow;

  return $table
    .find("tr")
    .filter((_, tr) => {
      const $tr = $(tr);
      const headerCells = $tr.find("td.dxgvHeader_Moderno, td.dxgvHeader").length;
      if (headerCells < 3) return false;
      return norm($tr.text()).includes("driver");
    })
    .first();
}

function pickBestDxGridTable($) {
  const dxTables = $("table[id$='_DXMainTable']");
  if (!dxTables.length) return null;

  let best = null;
  let bestScore = -1;

  dxTables.each((_, t) => {
    const $t = $(t);
    const dataRows = $t.find("tr.dxgvDataRow_Moderno, tr.dxgvDataRow");
    if (dataRows.length < 2) return;

    const $headerRow = findHeaderRow($, $t);
    if (!$headerRow.length) return;

    const headers = extractHeaderCells($, $headerRow);
    const hn = headers.map(norm);

    const hasDriver = hn.some((h) => h === "driver" || h.includes("driver"));
    if (!hasDriver) return;

    const score =
      (hn.some((h) => h.includes("car#") || h.includes("car #")) ? 2 : 0) +
      (hn.some((h) => h === "class" || h.includes("class")) ? 2 : 0) +
      (hn.some((h) => h === "car") ? 1 : 0) +
      (hn.some((h) => h.includes("race")) ? 1 : 0) +
      (hn.some((h) => h.includes("quali") || h.includes("qual")) ? 1 : 0) +
      (hn.some((h) => h.includes("fastest") || h === "fl") ? 1 : 0) +
      (hn.some((h) => h.includes("nett") || h.includes("net")) ? 2 : 0) +
      (hn.some((h) => h.includes("total")) ? 1 : 0) +
      (hn.some((h) => h.includes("diff")) ? 1 : 0) +
      Math.min(dataRows.length, 50) / 50;

    if (score > bestScore) {
      bestScore = score;
      best = $t;
    }
  });

  return best;
}

function mapColumnIndexes(headers) {
  const h = headers.map(norm);
  const findIndex = (fn) => {
    const idx = h.findIndex(fn);
    return idx >= 0 ? idx : -1;
  };

  return {
    pos: findIndex((x) => x === "#" || x === "pos" || x === "position"),
    driver: findIndex((x) => x === "driver" || x.includes("driver")),
    carNo: findIndex((x) => x.includes("car#") || x.includes("car #")),
    className: findIndex((x) => x === "class" || x.includes("class")),
    carImg: findIndex((x) => x === "car"),
    racePts: findIndex((x) => x === "race" || x.includes("race points")),
    qualiPts: findIndex((x) => x === "quali" || x.includes("quali points") || x.includes("qualifying")),
    flPts: findIndex((x) => x === "fl" || x.includes("fastest lap")),
    total: findIndex((x) => x === "total" || x.includes("total")),
    nett: findIndex((x) => x.includes("nett") || x === "net" || x.includes("net points")),
    diff: findIndex((x) => x.includes("diff"))
  };
}

function cleanWeirdDevExpressText(txt) {
  const s = String(txt || "").trim();
  // DevExpress sometimes leaves script/comment junk in "utility" columns
  if (!s) return "";
  if (s.startsWith("<!--") || s.includes("ASPx.AddDisabledItems")) return "";
  return s.replace(/\s+/g, " ").trim();
}

function cellText($cell) {
  if (!$cell || !$cell.length) return "";

  const aTxt = $cell.find("a").first().text().trim();
  if (aTxt) return cleanWeirdDevExpressText(aTxt);

  const raw = $cell.text();
  return cleanWeirdDevExpressText(raw);
}

function cellImageSrc($cell) {
  if (!$cell || !$cell.length) return "";
  const img = $cell.find("img").first();
  const src = img.attr("src");
  return src ? String(src).trim() : "";
}

function alignHeadersToData(headers, dataTdCount) {
  const aligned = headers.slice();
  while (aligned.length > dataTdCount) aligned.pop();
  while (aligned.length < dataTdCount) aligned.push("");
  return aligned;
}

function trimTrailingUtilityColumn(headers, firstRowTds) {
  // If the last header is blank AND the last cell is basically the DX button/script column,
  // drop it from both header mapping and row indexing by ignoring it later.
  if (!headers.length) return { headers, trimLast: false };
  const lastHeaderBlank = !String(headers[headers.length - 1] || "").trim();
  if (!lastHeaderBlank) return { headers, trimLast: false };

  const lastTd = firstRowTds.eq(firstRowTds.length - 1);
  const lastTxt = norm(lastTd.text());
  const hasDxScript = lastTxt.includes("aspx.adddisableditems") || lastTxt.includes("dxr.axd") || lastTd.find("a, img, script").length > 0;

  if (hasDxScript) {
    return { headers: headers.slice(0, -1), trimLast: true };
  }
  return { headers, trimLast: false };
}

function parseRows($, $table, colMap, trimLast) {
  const out = [];
  const $rows = $table.find("tr.dxgvDataRow_Moderno, tr.dxgvDataRow");

  $rows.each((_, tr) => {
    const $tr = $(tr);
    let $tds = $tr.children("td");
    if (trimLast && $tds.length > 0) $tds = $tds.slice(0, -1);

    const getCell = (idx) => (idx >= 0 ? $tds.eq(idx) : null);

    const row = {
      pos: cellText(getCell(colMap.pos)),
      driver: cellText(getCell(colMap.driver)),
      carNo: cellText(getCell(colMap.carNo)),
      className: cellText(getCell(colMap.className)),
      carImg: cellImageSrc(getCell(colMap.carImg)),
      racePts: cellText(getCell(colMap.racePts)),
      qualiPts: cellText(getCell(colMap.qualiPts)),
      flPts: cellText(getCell(colMap.flPts)),
      total: cellText(getCell(colMap.total)),
      nett: cellText(getCell(colMap.nett)),
      diff: cellText(getCell(colMap.diff))
    };

    if (!row.driver && !row.pos) return;
    out.push(row);
  });

  return out;
}

async function fetchStandingsGeneric(url, labelForLogs) {
  const res = await axios.get(url, {
    timeout: 30000,
    headers: {
      "User-Agent": "Mozilla/5.0",
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
    }
  });

  const $ = cheerio.load(res.data);

  const $table = pickBestDxGridTable($);
  if (!$table) throw new Error("Could not locate the main DevExpress standings table.");

  const $headerRow = findHeaderRow($, $table);
  if (!$headerRow.length) throw new Error("Could not find header row in standings table.");

  let headers = extractHeaderCells($, $headerRow);

  const $firstDataRow = $table.find("tr.dxgvDataRow_Moderno, tr.dxgvDataRow").first();
  let $firstTds = $firstDataRow.children("td");
  const dataTdCount = $firstTds.length;

  headers = alignHeadersToData(headers, dataTdCount);

  // Optionally trim the trailing utility column
  const trimmed = trimTrailingUtilityColumn(headers, $firstTds);
  headers = trimmed.headers;
  const trimLast = trimmed.trimLast;

  if (trimLast && $firstTds.length > 0) {
    $firstTds = $firstTds.slice(0, -1);
  }

  const colMap = mapColumnIndexes(headers);

  if (DEBUG) {
    console.log("\n==============================");
    console.log(`DEBUG_OOR: ${labelForLogs || "Standings"}: ${url}`);
    console.log(`Header TDs: ${headers.length} | Data TDs: ${dataTdCount} | trimLast: ${trimLast}`);
    headers.forEach((h, i) => console.log(`${String(i).padStart(2, "0")}: "${h}"`));
    console.log("Column Map:", colMap);

    const cells = [];
    $firstTds.each((i, td) => {
      const $td = $(td);
      const t = cellText($td);
      const img = cellImageSrc($td);
      cells.push({ i, text: t, img: img ? "[img]" : "" });
    });
    console.log("First row cells:", cells);
  }

  if (colMap.driver < 0) {
    throw new Error(`Couldn't map Driver column. Headers: ${headers.join(" | ")}`);
  }

  const rows = parseRows($, $table, colMap, trimLast);

  if (DEBUG) {
    console.log(`Parsed rows: ${rows.length}`);
    console.log("Sample row:", rows[0]);
  }

  return rows;
}

async function fetchClub50Standings(url) {
  return fetchStandingsGeneric(url, "Club50");
}

async function fetchSprintStandings(url) {
  return fetchStandingsGeneric(url, "SprintYellow");
}


// ------------------------------
// Shared HTML fetch helper (used by SimGrid parsing)
// ------------------------------
async function fetchHtml(url, { attempts = 3, timeoutMs = 30000 } = {}) {
  let lastErr = null;
  for (let i = 0; i < attempts; i++) {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        signal: controller.signal,
        headers: {
          "user-agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "accept-language": "en-US,en;q=0.9",
          "cache-control": "no-cache",
          "pragma": "no-cache",
          "referer": "https://www.thesimgrid.com/",
        },
      });

      if (!res.ok) {
        throw new Error(`HTTP ${res.status} ${res.statusText}`);
      }

      return await res.text();
    } catch (err) {
      lastErr = err;
      // small backoff
      await new Promise((r) => setTimeout(r, 250 * (i + 1)));
    } finally {
      clearTimeout(t);
    }
  }
  throw lastErr || new Error("fetchHtml failed");
}

function flagEmojiToTwemojiPng(flagEmoji) {
  if (!flagEmoji) return "";
  // Twemoji uses lowercase hex codepoints joined by '-'
  const code = Array.from(flagEmoji)
    .map((ch) => ch.codePointAt(0).toString(16))
    .join("-")
    .toLowerCase();
  return `https://cdnjs.cloudflare.com/ajax/libs/twemoji/14.0.2/72x72/${code}.png`;
}

// ------------------------------
// SimGrid standings
// ------------------------------

function cleanText(t) {
  return (t || "")
    .replace(/\s+/g, " ")
    .replace(/\u00a0/g, " ")
    .trim();
}

function simgridMakeKeyFromText(t) {
  const s = cleanText(t).toLowerCase();
  if (!s) return "";

  const has = (k) => s.includes(k);

  // Hypercar / LMGT3 common makes
  if (has("mclaren")) return "mclaren";
  if (has("toyota") || has("gazoo")) return "toyota_gazoo";
  if (has("ferrari")) return "ferrari";
  if (has("porsche")) return "porsche";
  if (has("bmw")) return "bmw";
  if (has("mercedes") || has("amg")) return "mercedes";
  if (has("cadillac")) return "cadillac";
  if (has("peugeot")) return "peugeot";
  if (has("alpine")) return "alpine";
  if (has("lamborghini")) return "lamborghini";
  if (has("aston")) return "astonmartin";
  if (has("lexus")) return "lexus";
  if (has("honda") || has("acura")) return "honda";
  if (has("chevrolet") || has("corvette")) return "corvette";

  return "";
}

function simgridMakeKeyFromSrc(src) {
  const u = String(src || "").toLowerCase();
  if (!u) return "";

  // Some CDNs put the make in the filename/path
  if (u.includes("mclaren")) return "mclaren";
  if (u.includes("toyota")) return "toyota_gazoo";
  if (u.includes("gazoo")) return "toyota_gazoo";
  if (u.includes("ferrari")) return "ferrari";
  if (u.includes("porsche")) return "porsche";
  if (u.includes("bmw")) return "bmw";
  if (u.includes("mercedes") || u.includes("amg")) return "mercedes";
  if (u.includes("cadillac")) return "cadillac";
  if (u.includes("peugeot")) return "peugeot";
  if (u.includes("alpine")) return "alpine";
  if (u.includes("lamborghini")) return "lamborghini";
  if (u.includes("aston")) return "astonmartin";
  if (u.includes("lexus")) return "lexus";
  if (u.includes("honda") || u.includes("acura")) return "honda";
  if (u.includes("chevrolet") || u.includes("corvette")) return "corvette";

  return "";
}

/**
 * Fetch and parse a SimGrid standings table.
 * Returns rows compatible with render.js (pos, driver, carNo, className, carImg, countryImg, total, etc.).
 */
async function fetchSimgridStandings(url, label = "SimGrid") {
  const DEBUG_OOR_SIMGRID = process.env.DEBUG_OOR === "1";
  const html = await fetchHtml(url);
  const $ = cheerio.load(html);

  const table = $("table.table-results");
  if (!table.length) {
    throw new Error(`${label}: standings table not found`);
  }

  const rows = [];
  table.find("tbody tr").each((_, tr) => {
    const $tr = $(tr);

    // Position
    const pos =
      cleanText($tr.find("td.result-position strong").first().text()) ||
      cleanText($tr.find("td").first().text());

    // Driver name (sometimes includes a leading flag emoji). SimGrid also appends a rating like "Name 2,202".
    const driverTextRaw = cleanText($tr.find("a.entrant-name").first().text());
    const flagMatch = driverTextRaw.match(/^([\p{Regional_Indicator}]{2})\s+/u);
    const flagEmoji = flagMatch ? flagMatch[1] : "";
    let driverText = flagMatch ? driverTextRaw.slice(flagMatch[0].length).trim() : driverTextRaw;

    let rating = "";
    const ratingMatch = driverText.match(/\s(\d{1,3}(?:,\d{3})+)\s*$/);
    if (ratingMatch) {
      rating = ratingMatch[1];
      driverText = driverText.slice(0, ratingMatch.index).trim();
    }

    const driver = driverText;
    const countryImg = flagEmoji ? flagEmojiToTwemojiPng(flagEmoji) : "";

    // Car number
    const carNo = cleanText($tr.find("span.badge-number-board .car-number").first().text());

    // Vehicle icon + manufacturer hint
    const $carCell = $tr.find("td.nowrap").first();
    const $carImg = $carCell.find("img").first();

    // Icon
    let carImg = $carImg.attr("src") || "";
    if (carImg && carImg.startsWith("/")) {
      carImg = `https://www.thesimgrid.com${carImg}`;
    }

    // Make key detection: prefer alt/title/tooltip text; fall back to src
    const hint =
      cleanText($carImg.attr("alt")) ||
      cleanText($carImg.attr("title")) ||
      cleanText($carImg.attr("data-bs-original-title")) ||
      cleanText($carCell.attr("title")) ||
      cleanText($carCell.text());

    const carMakeKey = simgridMakeKeyFromText(hint) || simgridMakeKeyFromSrc(carImg);

    // Points: the last td.fw-bold in the row
    const pts = cleanText($tr.find("td.fw-bold").last().text()) || "0";

    if (!driver) return; // skip empty rows

    rows.push({
      pos: pos || "",
      driver,
      rating,
      carNo: carNo || "",
      className: "",
      carImg: carImg || "",
      carMakeKey: carMakeKey || "",
      countryImg,
      racePts: "",
      qualiPts: "",
      flPts: "",
      total: pts,
      nett: pts,
      diff: "",
    });
  });

  if (DEBUG_OOR_SIMGRID) {
    console.log("\n==============================");
    console.log(`DEBUG_OOR: ${label}`);
    console.log("Parsed rows:", rows.length);
    console.log("Sample row:", rows[0]);
  }

  return { rows };
}

module.exports = {
  fetchSimgridStandings,
  fetchClub50Standings,
  fetchSprintStandings
};
