// Older days for "Load more", from NCEI daily summaries (GHCN-Daily).
// Returns the same day shape as lib/weather.js past days, so the frontend renders them the same way.

import { findStations, getDailySummaries } from './ncei.js';

const DAY_MS = 86_400_000;
const STATIONS_TRIED = 5;

function addDays(isoDate, n) {
  return new Date(Date.parse(`${isoDate}T12:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
}

const hasTemps = (row) => row && row.high != null && row.low != null;

/**
 * `count` days ending on `end` (inclusive, YYYY-MM-DD), oldest first.
 * Uses the nearby station with the best coverage and fills gaps from the next nearest ones.
 */
export async function getHistory(lat, lon, end, count) {
  const start = addDays(end, -(count - 1));
  const dates = Array.from({ length: count }, (_, i) => addDays(start, i));

  const stations = (await findStations(lat, lon, start, end)).slice(0, STATIONS_TRIED);
  if (!stations.length) return { days: [], stations: [], start, end };

  // Recent data can still be revised or filled in; older data is final.
  const ageDays = (Date.now() - Date.parse(`${end}T00:00:00Z`)) / DAY_MS;
  const ttl = ageDays > 30 ? 24 * 3_600_000 : 3 * 3_600_000;
  const data = await getDailySummaries(stations.map((s) => s.id), start, end, ttl);

  const coverage = (s) => dates.filter((d) => hasTemps(data.get(s.id)?.get(d))).length;
  const best = Math.max(...stations.map(coverage));
  // Nearest station within one day of the best coverage; then the rest by distance as gap fillers.
  const primary = stations.find((s) => coverage(s) >= best - 1);
  const order = [primary, ...stations.filter((s) => s !== primary)];

  const used = new Map();
  const days = dates.map((date) => {
    const station = order.find((s) => hasTemps(data.get(s.id)?.get(date)));
    if (!station) return { date, kind: 'past', source: 'ncei', high: null, low: null, category: null, precip: null };
    const row = data.get(station.id).get(date);
    used.set(station.id, station);
    const snowy = (row.snowMm ?? 0) > 0;
    const wet = (row.precipMm ?? 0) > 0;
    return {
      date,
      kind: 'past',
      source: 'ncei',
      station: station.id,
      high: row.high,
      low: row.low,
      category: snowy ? 'snow' : wet ? 'rain' : null,
      precip: { observed: true, mm: row.precipMm, hours: 0, kind: snowy ? 'snow' : wet ? 'rain' : null },
    };
  });

  return { days, stations: [...used.values()], start, end };
}
