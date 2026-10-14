// Thin client for the National Weather Service API (https://www.weather.gov/documentation/services-web-api).
// No API key is needed, but NWS asks every client to send an identifying User-Agent.

import { cached } from './cache.js';

const BASE = 'https://api.weather.gov';
const USER_AGENT = `WeatherBack (${process.env.WEATHERBACK_CONTACT || 'contact not set'})`;
const TIMEOUT_MS = 12_000;
const MAX_OBSERVATION_PAGES = 8;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

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

/**
 * All observations for a station since `start` (Date), newest first.
 * Busy stations return 500 observations per page (~1.5 days), so follow pagination.
 */
export function getObservations(stationId, start) {
  // Round start to the hour so the cache key is stable across requests.
  const startIso = new Date(Math.floor(start.getTime() / HOUR) * HOUR).toISOString().replace('.000Z', 'Z');
  return cached(`obs:${stationId}:${startIso}`, 10 * MINUTE, async () => {
    const out = [];
    let url = `${BASE}/stations/${encodeURIComponent(stationId)}/observations?start=${startIso}`;
    for (let page = 0; url && page < MAX_OBSERVATION_PAGES; page++) {
      const json = await fetchJson(url);
      const features = json.features || [];
      out.push(...features.map((f) => f.properties));
      if (features.length === 0) break;
      const oldest = Date.parse(features[features.length - 1].properties.timestamp);
      if (oldest <= Date.parse(startIso)) break;
      url = json.pagination?.next || null;
    }
    return out;
  });
}

/** 12-hour forecast periods in metric units. */
export function getForecast(forecastUrl) {
  return cached(`forecast:${forecastUrl}`, 30 * MINUTE, async () => {
    const json = await fetchJson(`${forecastUrl}?units=si`);
    return json.properties.periods;
  });
}
