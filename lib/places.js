// City search over data/places.json (US Census places, largest first; built by scripts/build-places.js),
// plus zip code lookup over data/zips.json.

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const MAX_RESULTS = 8;

const zips = JSON.parse(readFileSync(join(root, 'data', 'zips.json'), 'utf8'));
const zipNames = JSON.parse(readFileSync(join(root, 'data', 'zip-names.json'), 'utf8'));
const { states, places: rawPlaces } = JSON.parse(readFileSync(join(root, 'data', 'places.json'), 'utf8'));

/** Lowercase, strip accents and punctuation, and spell out "St"/"Ft"/"Mt" so "st louis" finds "St. Louis". */
export function normalize(s) {
  return s
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[.'’]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\b(st|saint)\b/g, 'saint')
    .replace(/\b(ft|fort)\b/g, 'fort')
    .replace(/\b(mt|mount)\b/g, 'mount')
    .trim();
}

const places = rawPlaces.map(([name, state, lat, lon, pop]) => {
  const norm = normalize(name);
  return { name, state, lat, lon, pop, norm, words: ` ${norm}` };
});
const stateEntries = Object.entries(states).map(([abbr, name]) => ({ abbr, abbrLc: abbr.toLowerCase(), nameLc: normalize(name) }));

/** States whose abbreviation or name starts with `text` (e.g. "o" -> OH, OK, OR; "new y" -> NY). */
function matchStates(text) {
  const t = normalize(text);
  if (!t) return null;
  const hits = stateEntries.filter((s) => s.abbrLc === t || s.nameLc.startsWith(t) || (t.length === 1 && s.abbrLc.startsWith(t)));
  return hits.length ? new Set(hits.map((s) => s.abbr)) : null;
}

function toResult(p) {
  return { label: `${p.name}, ${p.state}`, name: p.name, state: p.state, stateName: states[p.state] || p.state, lat: p.lat, lon: p.lon };
}

/** Places whose name starts with `name` (then names with a later word starting with it), optionally in `stateSet`. */
function findByName(name, stateSet) {
  const q = normalize(name);
  if (!q) return [];
  const prefix = [];
  const word = [];
  const inState = (p) => !stateSet || stateSet.has(p.state);
  for (const p of places) {
    if (prefix.length >= MAX_RESULTS) break;
    if (!inState(p)) continue;
    if (p.norm.startsWith(q)) prefix.push(p);
    else if (word.length < MAX_RESULTS && p.words.includes(` ${q}`)) word.push(p);
  }
  return [...prefix, ...word].slice(0, MAX_RESULTS);
}

/**
 * Suggestions for what the user has typed so far: "denv", "denver co", "portland, or", "raleigh north carolina".
 * The whole text is tried as a city name first (so "st louis" and "new york" work). If that finds nothing,
 * a trailing state (abbreviation or name, possibly partial, e.g. "portland o") narrows the search.
 */
export function searchPlaces(query) {
  const text = query.trim();
  if (!text) return [];

  if (text.includes(',')) {
    const i = text.lastIndexOf(',');
    const stateSet = matchStates(text.slice(i + 1));
    const results = findByName(text.slice(0, i), stateSet);
    if (results.length || !stateSet) return results.map(toResult);
  }

  const whole = findByName(text.replace(/,/g, ' '));
  if (whole.length) return whole.map(toResult);

  const tokens = text.split(/\s+/);
  for (const n of [2, 1]) {
    if (tokens.length <= n) continue;
    const stateSet = matchStates(tokens.slice(-n).join(' '));
    if (!stateSet) continue;
    const results = findByName(tokens.slice(0, -n).join(' '), stateSet);
    if (results.length) return results.map(toResult);
  }
  return [];
}

/** Zip code centroid plus the place covering most of its land, for a "Denver, CO 80202" label. */
export function lookupZip(zip) {
  const hit = zips[zip];
  if (!hit) return null;
  const [lat, lon] = hit;
  const town = zipNames[zip];
  return { zip, lat, lon, label: town ? `${town} ${zip}` : zip };
}
