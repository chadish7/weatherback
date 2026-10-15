// Client for NOAA NCEI's Access Data Service (https://www.ncei.noaa.gov/support/access-data-service-api-user-documentation).
// Used for days older than the ~7 days the NWS API keeps. Dataset: GHCN-Daily ("daily-summaries").
// No API key needed. Data typically lags a few days, which is fine for older days.

import { cached } from './cache.js';

const BASE = 'https://www.ncei.noaa.gov/access/services';
const USER_AGENT = `WeatherBack (${process.env.WEATHERBACK_CONTACT || 'contact not set'})`;
const TIMEOUT_MS = 20_000;
const HOUR = 3_600_000;

export class NceiError extends Error {}

async function fetchJson(url) {
  if (!url.startsWith(BASE + '/')) throw new NceiError(`Refusing to fetch non-NCEI URL: ${url}`);
  const res = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new NceiError(`NCEI ${res.status} for ${url}`);
  return res.json();
}

function distanceKm(lat1, lon1, lat2, lon2) {
  const rad = Math.PI / 180;
  const a =
    Math.sin(((lat2 - lat1) * rad) / 2) ** 2 +
    Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(((lon2 - lon1) * rad) / 2) ** 2;
  return 12_742 * Math.asin(Math.sqrt(a));
}

/**
 * Stations near a point that record daily highs and lows and were reporting at or after `startDate`.
 * Nearest first. Searches a ~50 km box, widening to ~110 km if nothing is found.
 */
export function findStations(lat, lon, startDate, endDate) {
  const key = `ncei-stations:${lat.toFixed(2)},${lon.toFixed(2)}:${startDate}:${endDate}`;
  return cached(key, 24 * HOUR, async () => {
    for (const pad of [0.45, 1]) {
      const bbox = [lat + pad, lon - pad, lat - pad, lon + pad].map((n) => n.toFixed(3)).join(',');
      const url =
        `${BASE}/search/v1/data?dataset=daily-summaries&bbox=${bbox}` +
        `&startDate=${startDate}T00:00:00&endDate=${endDate}T23:59:59&dataTypes=TMAX,TMIN&limit=50`;
      const json = await fetchJson(url);
      const stations = [];
      for (const r of json.results || []) {
        const s = r.stations?.[0];
        const [slon, slat] = r.location?.coordinates || [];
        if (!s?.id || slat == null) continue;
        const types = new Map((s.dataTypes || []).map((t) => [t.id, t]));
        const tmax = types.get('TMAX');
        const tmin = types.get('TMIN');
        if (!tmax || !tmin) continue;
        if (tmax.endDate.slice(0, 10) < startDate || tmin.endDate.slice(0, 10) < startDate) continue;
        stations.push({ id: s.id, name: s.name, km: Math.round(distanceKm(lat, lon, slat, slon)) });
      }
      if (stations.length) return stations.sort((a, b) => a.km - b.km);
    }
    return [];
  });
}

/**
 * Daily TMAX/TMIN/PRCP/SNOW (metric: °C, mm) plus GHCN weather-type flags for several stations.
 * Returns Map<stationId, Map<date, row>>. `row.weather` is a Set of flags present that day, e.g. "WT03" (thunder).
 */
export const WEATHER_TYPES = ['WT01', 'WT02', 'WT03', 'WT05', 'WT08', 'WT11', 'WT16', 'WT18'];

export function getDailySummaries(stationIds, startDate, endDate, ttlMs) {
  const key = `ncei-daily:${stationIds.join(',')}:${startDate}:${endDate}`;
  return cached(key, ttlMs, async () => {
    const url =
      `${BASE}/data/v1?dataset=daily-summaries&stations=${stationIds.map(encodeURIComponent).join(',')}` +
      `&startDate=${startDate}&endDate=${endDate}&dataTypes=TMAX,TMIN,PRCP,SNOW,${WEATHER_TYPES.join(',')}` +
      `&units=metric&format=json`;
    const rows = await fetchJson(url);
    const out = new Map();
    for (const r of Array.isArray(rows) ? rows : []) {
      const id = r.STATION?.trim();
      if (!out.has(id)) out.set(id, new Map());
      const num = (v) => (v == null || v.trim() === '' ? null : Number(v));
      out.get(id).set(r.DATE, {
        high: num(r.TMAX),
        low: num(r.TMIN),
        precipMm: num(r.PRCP),
        snowMm: num(r.SNOW),
        weather: new Set(WEATHER_TYPES.filter((t) => r[t] != null)),
      });
    }
    return out;
  });
}
