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

module.exports = {
  fetchClub50Standings,
  fetchSprintStandings
};
