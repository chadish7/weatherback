// Thin client for the National Weather Service API (https://www.weather.gov/documentation/services-web-api).
// No API key is needed, but NWS asks every client to send an identifying User-Agent.

import { cached, peek, put, once } from './cache.js';

const BASE = 'https://api.weather.gov';
const USER_AGENT = `WeatherBack (${process.env.WEATHERBACK_CONTACT || 'contact not set'})`;
const TIMEOUT_MS = 12_000;
const MAX_OBSERVATION_PAGES = 8;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const OBS_REFRESH_MS = 10 * MINUTE; // pull newer observations at most this often per station
const OBS_OVERLAP_MS = 2 * HOUR; // re-fetch this much before the last pull, for late or corrected reports
const OBS_KEEP_MS = 10 * 24 * HOUR; // NWS keeps ~7 days; we never need more than ~8.6

export class NwsError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

async function fetchJson(url) {
  if (!url.startsWith(BASE + '/')) throw new NwsError(`Refusing to fetch non-NWS URL: ${url}`, 500);
  const res = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/geo+json' },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) {
    let detail = '';
    try {
      detail = (await res.json()).detail || '';
    } catch {
      /* ignore */
    }
    throw new NwsError(`NWS ${res.status} for ${url}${detail ? `: ${detail}` : ''}`, res.status);
  }
  return res.json();
}

/** Grid point metadata: forecast URL, station list URL, time zone, nearest city. */
export function getPoint(lat, lon) {
  // NWS redirects requests with more than 4 decimal places.
  const key = `${lat.toFixed(4)},${lon.toFixed(4)}`;
  return cached(`point:${key}`, 24 * HOUR, async () => {
    const p = (await fetchJson(`${BASE}/points/${key}`)).properties;
    const rel = p.relativeLocation?.properties || {};
    return {
      forecastUrl: p.forecast,
      stationsUrl: p.observationStations,
      timeZone: p.timeZone,
      city: rel.city || null,
      state: rel.state || null,
    };
  });
}

/** Observation stations for a grid point, nearest first. */
export function getStations(stationsUrl) {
  return cached(`stations:${stationsUrl}`, 24 * HOUR, async () => {
    const json = await fetchJson(`${stationsUrl}?limit=6`);
    return json.features.map((f) => ({
      id: f.properties.stationIdentifier,
      name: f.properties.name,
    }));
  });
}

// Only the fields lib/weather.js reads, so cached observations stay small in SQLite.
const OBSERVATION_FIELDS = [
  'timestamp',
  'textDescription',
  'icon',
  'presentWeather',
  'temperature',
  'precipitationLastHour',
  'heatIndex',
  'windChill',
  'relativeHumidity',
  'windSpeed',
];

function trimObservation(p) {
  const out = {};
  for (const k of OBSERVATION_FIELDS) {
    const v = p[k];
    // Keep { value, qualityControl } but drop unitCode for measurements.
    out[k] = v && typeof v === 'object' && 'value' in v ? { value: v.value, qualityControl: v.qualityControl } : v;
  }
  return out;
}

/**
 * All observations for a station since `start` (Date), newest first.
 * Busy stations return 500 observations per page (~1.5 days), so follow pagination.
 *
 * Observations are stored per station together with the time span they cover (`coveredFrom`..`fetchedAt`).
 * On each call only the missing part is pulled from NWS: just the newest observations (with a 2 h overlap
 * for late or corrected reports) when the cache already covers `start`, or the whole span when it doesn't.
 * If NWS fails, whatever is cached is returned instead.
 */
export async function getObservations(stationId, start) {
  const key = `obs-store:${stationId}`;
  const startMs = start.getTime();
  const fresh = (s) => s && s.coveredFrom <= startMs && Date.now() - s.fetchedAt < OBS_REFRESH_MS;
  const since = (s) => s.observations.filter((o) => Date.parse(o.timestamp) >= startMs);

  let stored = peek(key);
  if (fresh(stored)) return since(stored);

  try {
    stored = await once(key, () => refreshObservations(key, stationId, startMs, peek(key)));
  } catch (err) {
    if (!stored) throw err;
    console.warn(`[nws] ${stationId}: using cached observations, refresh failed: ${err.message}`);
  }
  return since(stored);
}

async function refreshObservations(key, stationId, startMs, stored) {
  const now = Date.now();
  const incremental = stored && stored.coveredFrom <= startMs;
  const fromMs = incremental ? Math.max(startMs, stored.fetchedAt - OBS_OVERLAP_MS) : startMs;
  const fromIso = new Date(Math.floor(fromMs / MINUTE) * MINUTE).toISOString().replace('.000Z', 'Z');

  const fetched = [];
  let complete = false;
  let url = `${BASE}/stations/${encodeURIComponent(stationId)}/observations?start=${fromIso}`;
  for (let page = 0; url && page < MAX_OBSERVATION_PAGES; page++) {
    const json = await fetchJson(url);
    const features = json.features || [];
    fetched.push(...features.map((f) => trimObservation(f.properties)));
    const next = json.pagination?.next;
    const oldest = features.length ? Date.parse(features[features.length - 1].properties.timestamp) : -Infinity;
    // NWS pages hold up to 500 observations; a shorter page is the last one.
    if (!features.length || features.length < 500 || oldest <= fromMs || !next) {
      complete = true;
      break;
    }
    url = next;
  }

  // Merge: fetched observations replace stored ones with the same timestamp.
  const byTime = new Map();
  for (const o of incremental ? stored.observations : []) byTime.set(o.timestamp, o);
  for (const o of fetched) byTime.set(o.timestamp, o);
  const keepFrom = now - OBS_KEEP_MS;
  const observations = [...byTime.values()]
    .filter((o) => Date.parse(o.timestamp) >= keepFrom)
    .sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp));

  // If we hit the page cap, we only cover back to the oldest observation we actually received.
  const reachedMs = fetched.length ? Date.parse(fetched[fetched.length - 1].timestamp) : fromMs;
  const coveredFrom = incremental ? stored.coveredFrom : complete ? fromMs : reachedMs;
  const value = { coveredFrom: Math.max(coveredFrom, keepFrom), fetchedAt: now, observations };
  put(key, value, OBS_KEEP_MS);
  return value;
}

/** 12-hour forecast periods in metric units. Cached for 8 hours (owner's choice; keep it at or under 24 h). */
export function getForecast(forecastUrl) {
  return cached(`forecast:${forecastUrl}`, 8 * HOUR, async () => {
    const json = await fetchJson(`${forecastUrl}?units=si`);
    return json.properties.periods;
  });
}
