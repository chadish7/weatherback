#!/usr/bin/env node
// Builds data/zips.json from the US Census Bureau ZCTA Gazetteer file.
// Output format: { "80202": [lat, lon], ... }
// Requires `curl` and `unzip` on PATH. Usage: npm run build-zips [-- <year>]

import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const year = process.argv[2] || '2025';
if (!/^\d{4}$/.test(year)) {
  console.error('Year must be four digits, e.g. 2025');
  process.exit(1);
}

const url = `https://www2.census.gov/geo/docs/maps-data/data/gazetteer/${year}_Gazetteer/${year}_Gaz_zcta_national.zip`;
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outFile = join(root, 'data', 'zips.json');
const tmp = mkdtempSync(join(tmpdir(), 'weatherback-zips-'));

try {
  const zipPath = join(tmp, 'zcta.zip');
  console.log(`Downloading ${url}`);
  execFileSync('curl', ['-sSfL', '-o', zipPath, url], { stdio: 'inherit' });
  const text = execFileSync('unzip', ['-p', zipPath], { maxBuffer: 64 * 1024 * 1024 }).toString('utf8');

  const lines = text.split(/\r?\n/).filter(Boolean);
  // Older Gazetteer files are tab-delimited; 2025+ uses "|".
  const sep = lines[0].includes('|') ? '|' : '\t';
  const header = lines[0].split(sep).map((h) => h.trim());
  const iZip = header.indexOf('GEOID');
  const iLat = header.indexOf('INTPTLAT');
  const iLon = header.indexOf('INTPTLONG');
  if (iZip < 0 || iLat < 0 || iLon < 0) throw new Error(`Unexpected header: ${header.join(',')}`);

  const zips = {};
  for (const line of lines.slice(1)) {
    const cols = line.split(sep);
    const zip = cols[iZip].trim();
    const lat = Number(cols[iLat]);
    const lon = Number(cols[iLon]);
    if (/^\d{5}$/.test(zip) && Number.isFinite(lat) && Number.isFinite(lon)) {
      zips[zip] = [Math.round(lat * 1e4) / 1e4, Math.round(lon * 1e4) / 1e4];
    }
  }

  mkdirSync(dirname(outFile), { recursive: true });
  writeFileSync(outFile, JSON.stringify(zips));
  console.log(`Wrote ${Object.keys(zips).length} zip codes to ${outFile}`);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
