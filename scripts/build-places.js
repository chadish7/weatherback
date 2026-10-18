#!/usr/bin/env node
// Builds data/places.json for city search, and data/zip-names.json for zip code labels, from US Census Bureau files:
//   - Gazetteer places: name, state, coordinates for every incorporated place and CDP.
//   - Population estimates (SUB-EST): population for incorporated places, used to rank suggestions.
//   - 2020 ZCTA-to-place relationship file: which place covers most of each zip code's land.
// Output: { states: { "CO": "Colorado", ... }, places: [[name, state, lat, lon, population], ...] }
//         and { "80202": "Denver, CO", ... }
// Requires `curl` and `unzip` on PATH. Usage: npm run build-places [-- <year>]

import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const year = process.argv[2] || '2025';
if (!/^\d{4}$/.test(year)) {
  console.error('Year must be four digits, e.g. 2025');
  process.exit(1);
}

const gazUrl = `https://www2.census.gov/geo/docs/maps-data/data/gazetteer/${year}_Gazetteer/${year}_Gaz_place_national.zip`;
const popUrl = `https://www2.census.gov/programs-surveys/popest/datasets/2020-${year}/cities/totals/sub-est${year}.csv`;
// ZCTA-to-place overlap areas (2020 boundaries; the Census only publishes these per decade).
const relUrl = 'https://www2.census.gov/geo/docs/maps-data/data/rel2020/zcta520/tab20_zcta520_place20_natl.txt';
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outFile = join(root, 'data', 'places.json');
const zipNamesFile = join(root, 'data', 'zip-names.json');
const tmp = mkdtempSync(join(tmpdir(), 'weatherback-places-'));

// Legal/statistical descriptors the Census appends to place names ("Denver city", "Aspen Hill CDP").
const DESCRIPTOR =
  / (city and borough|consolidated government|metropolitan government|metro government|unified government|urban county|city|town|township|village|borough|municipality|plantation|CDP|zona urbana|comunidad|corporation)( \(balance\))?$/;

function cleanName(name) {
  // Consolidated city-counties: "Athens-Clarke County unified government (balance)" -> "Athens",
  // "Lexington-Fayette urban county" -> "Lexington", "Butte-Silver Bow (balance)" -> "Butte".
  // Ordinary hyphenated names ("Winston-Salem city") don't carry these markers and are left alone.
  const consolidated = /(government|urban county)( \(balance\))?$|\(balance\)$|^[^-]+-.* County$/.test(name);
  let n = name.replace(/ \(balance\)$/, '');
  for (let i = 0; i < 2; i++) n = n.replace(DESCRIPTOR, '');
  n = n.replace(/\/.*$/, ''); // "Louisville/Jefferson County" -> "Louisville"
  if (consolidated) n = n.replace(/-.*$/, '');
  return n.replace(/^Urban (?=Honolulu$)/, '').trim();
}

/** Minimal CSV line parser that handles quoted fields. */
function parseCsvLine(line) {
  const out = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quoted) {
      if (c === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cur += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      out.push(cur);
      cur = '';
    } else cur += c;
  }
  out.push(cur);
  return out;
}

try {
  const zipPath = join(tmp, 'gaz.zip');
  const popPath = join(tmp, 'pop.csv');
  console.log(`Downloading ${gazUrl}`);
  execFileSync('curl', ['-sSfL', '--retry', '3', '-o', zipPath, gazUrl], { stdio: 'inherit' });
  console.log(`Downloading ${popUrl}`);
  execFileSync('curl', ['-sSfL', '--retry', '3', '-o', popPath, popUrl], { stdio: 'inherit' });

  // Population and state names, keyed by 7-digit place GEOID (state FIPS + place code).
  const popLines = readFileSync(popPath, 'latin1').split(/\r?\n/).filter(Boolean);
  const popHeader = parseCsvLine(popLines[0]);
  const col = (name) => popHeader.indexOf(name);
  const [iLev, iState, iPlace, iStName, iPop] = ['SUMLEV', 'STATE', 'PLACE', 'STNAME', `POPESTIMATE${year}`].map(col);
  if ([iLev, iState, iPlace, iStName, iPop].some((i) => i < 0)) throw new Error('Unexpected population file header');
  const population = new Map();
  const stateNameByFips = new Map();
  for (const line of popLines.slice(1)) {
    const r = parseCsvLine(line);
    if (r[iLev] === '040') stateNameByFips.set(r[iState], r[iStName]);
    if (r[iLev] === '162') population.set(r[iState] + r[iPlace], Number(r[iPop]) || 0);
  }

  const text = execFileSync('unzip', ['-p', zipPath], { maxBuffer: 64 * 1024 * 1024 }).toString('utf8');
  const lines = text.split(/\r?\n/).filter(Boolean);
  const sep = lines[0].includes('|') ? '|' : '\t';
  const header = lines[0].split(sep).map((h) => h.trim());
  const [gUsps, gGeoid, gName, gLat, gLon] = ['USPS', 'GEOID', 'NAME', 'INTPTLAT', 'INTPTLONG'].map((h) => header.indexOf(h));
  if ([gUsps, gGeoid, gName, gLat, gLon].some((i) => i < 0)) throw new Error(`Unexpected header: ${header.join(',')}`);

  const states = { PR: 'Puerto Rico' }; // the population file covers the 50 states and DC only
  const places = [];
  const placeByGeoid = new Map();
  for (const line of lines.slice(1)) {
    const c = line.split(sep).map((s) => s.trim());
    const lat = Number(c[gLat]);
    const lon = Number(c[gLon]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const usps = c[gUsps];
    const stName = stateNameByFips.get(c[gGeoid].slice(0, 2));
    if (stName) states[usps] = stName;
    const name = cleanName(c[gName]);
    placeByGeoid.set(c[gGeoid], `${name}, ${usps}`);
    places.push([
      name,
      usps,
      Math.round(lat * 1e4) / 1e4,
      Math.round(lon * 1e4) / 1e4,
      population.get(c[gGeoid]) || 0,
    ]);
  }
  // Largest first, so the server's search can stop early once it has enough matches.
  places.sort((a, b) => b[4] - a[4] || a[0].localeCompare(b[0]));

  mkdirSync(dirname(outFile), { recursive: true });
  writeFileSync(outFile, JSON.stringify({ states, places }));
  const withPop = places.filter((p) => p[4] > 0).length;
  console.log(`Wrote ${places.length} places (${withPop} with population) to ${outFile}`);

  // Name each zip after the place covering the most of its land area.
  const relPath = join(tmp, 'rel.txt');
  console.log(`Downloading ${relUrl}`);
  execFileSync('curl', ['-sSfL', '--retry', '3', '-o', relPath, relUrl], { stdio: 'inherit' });
  const relLines = readFileSync(relPath, 'utf8').split(/\r?\n/).filter(Boolean);
  const relHeader = relLines[0].split('|');
  const [rZip, rPlace, rArea] = ['GEOID_ZCTA5_20', 'GEOID_PLACE_20', 'AREALAND_PART'].map((h) => relHeader.indexOf(h));
  if ([rZip, rPlace, rArea].some((i) => i < 0)) throw new Error('Unexpected ZCTA-place relationship header');
  const bestByZip = new Map();
  for (const line of relLines.slice(1)) {
    const c = line.split('|');
    const zip = c[rZip];
    const label = placeByGeoid.get(c[rPlace]);
    const area = Number(c[rArea]) || 0;
    if (!/^\d{5}$/.test(zip) || !label || area <= 0) continue;
    const cur = bestByZip.get(zip);
    if (!cur || area > cur.area) bestByZip.set(zip, { label, area });
  }
  const zipNames = Object.fromEntries([...bestByZip].sort().map(([zip, { label }]) => [zip, label]));
  writeFileSync(zipNamesFile, JSON.stringify(zipNames));
  console.log(`Wrote ${bestByZip.size} zip names to ${zipNamesFile}`);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
