// Turns raw NWS data into the shape the frontend renders:
// current conditions + one row per day (7 past days, today, forecast days).
// All temperatures are °C and precipitation is mm; the browser converts units.

import { getPoint, getStations, getObservations, getForecast } from './nws.js';

export const PAST_DAYS = 7;
const DAY_MS = 86_400_000;
const MAX_STATIONS_TRIED = 3;

const PRECIP_WEATHER = {
  rain: 'rain',
  drizzle: 'rain',
  showers: 'rain',
  thunderstorms: 'thunder',
  snow: 'snow',
  snow_grains: 'snow',
  ice_pellets: 'snow',
  ice_crystals: 'snow',
  hail: 'rain',
  small_hail: 'rain',
};

/** YYYY-MM-DD for a timestamp in the given IANA time zone. */
function localDate(ms, timeZone) {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(ms);
}

/** Calendar math on YYYY-MM-DD strings (time-zone independent). */
function addDays(isoDate, n) {
  const d = new Date(`${isoDate}T12:00:00Z`);
  return new Date(d.getTime() + n * DAY_MS).toISOString().slice(0, 10);
}

/** Local hour (0-23) for a timestamp in the given IANA time zone. */
function localHour(ms, timeZone) {
  return Number(new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', hourCycle: 'h23' }).format(ms));
}

function round1(n) {
  return n == null ? null : Math.round(n * 10) / 10;
}

/** Map NWS text ("Light Rain Likely", "Mostly Cloudy") to a small set of icon categories. */
export function categorize(text = '') {
  const t = text.toLowerCase();
  if (/thunder|t-storm/.test(t)) return 'thunder';
  if (/snow|sleet|ice|flurr|blizzard|freezing/.test(t)) return 'snow';
  if (/rain|shower|drizzle/.test(t)) return 'rain';
  if (/fog|haze|smoke|mist|dust/.test(t)) return 'fog';
  if (/overcast|^cloudy|mostly cloudy/.test(t)) return 'cloudy';
  if (/partly|mostly sunny|mostly clear|few clouds|scattered|broken/.test(t)) return 'partly';
  if (/wind|breezy|blustery/.test(t)) return 'wind';
  if (/sunny|clear|fair/.test(t)) return 'clear';
  return 'cloudy';
}

function precipKind(obs) {
  for (const w of obs.presentWeather || []) {
    const kind = PRECIP_WEATHER[w.weather];
    if (kind) return kind;
  }
  return null;
}

/** Aggregate observations into per-local-day stats. */
function summarizeObservations(observations, timeZone) {
  const days = new Map();
  for (const o of observations) {
    const ms = Date.parse(o.timestamp);
    const date = localDate(ms, timeZone);
    let d = days.get(date);
    if (!d) {
      d = { temps: [], first: ms, last: ms, precipByHour: new Map(), precipHours: new Set(), kinds: {}, sky: {} };
      days.set(date, d);
    }
    const temp = o.temperature?.value;
    if (temp != null && o.temperature.qualityControl !== 'X') {
      d.temps.push(temp);
      d.first = Math.min(d.first, ms);
      d.last = Math.max(d.last, ms);
    }

    // Several reports per hour can each carry "precip since last routine report";
    // take the max per clock hour so specials aren't double counted.
    const hourKey = Math.floor(ms / 3_600_000);
    const mm = o.precipitationLastHour?.value;
    if (mm != null) d.precipByHour.set(hourKey, Math.max(d.precipByHour.get(hourKey) || 0, mm));

    const kind = precipKind(o);
    if (kind) {
      d.precipHours.add(hourKey);
      d.kinds[kind] = (d.kinds[kind] || 0) + 1;
    }
    if (o.textDescription && o.icon?.includes('/day/')) {
      const cat = categorize(o.textDescription);
      d.sky[cat] = (d.sky[cat] || 0) + 1;
    }
  }

  const out = new Map();
  for (const [date, d] of days) {
    const amounts = [...d.precipByHour.values()];
    const precipMm = amounts.length ? amounts.reduce((a, b) => a + b, 0) : null;
    const topKind = Object.entries(d.kinds).sort((a, b) => b[1] - a[1])[0]?.[0] || null;
    const topSky = Object.entries(d.sky).sort((a, b) => b[1] - a[1])[0]?.[0] || null;
    const hadPrecip = d.precipHours.size > 0 || (precipMm ?? 0) > 0;
    out.set(date, {
      high: d.temps.length ? Math.max(...d.temps) : null,
      low: d.temps.length ? Math.min(...d.temps) : null,
      readings: d.temps.length,
      // Hours of the local day the readings span; NWS keeps only ~7 days, so the oldest day is often cut short.
      startHour: localHour(d.first, timeZone),
      endHour: localHour(d.last, timeZone),
      precip: {
        mm: precipMm == null ? null : round1(precipMm),
        hours: d.precipHours.size,
        kind: topKind || (hadPrecip ? 'rain' : null),
      },
      category: hadPrecip ? topKind || 'rain' : topSky || 'cloudy',
    });
  }
  return out;
}

/** Pick the nearest station that actually has data for most of the past week. */
async function pickStation(stations, start, pastDates, timeZone) {
  let best = null;
  for (const station of stations.slice(0, MAX_STATIONS_TRIED)) {
    let observations;
    try {
      observations = await getObservations(station.id, start);
    } catch {
      continue;
    }
    const summary = summarizeObservations(observations, timeZone);
    const covered = pastDates.filter((d) => (summary.get(d)?.readings || 0) >= 8).length;
    const candidate = { station, observations, summary, covered };
    if (!best || covered > best.covered) best = candidate;
    if (covered >= pastDates.length - 1) break;
  }
  return best;
}

/** Latest observation; gaps (some stations omit text/icon) are filled from the current forecast period. */
function currentFrom(observations, period) {
  const o = observations.find((x) => x.temperature?.value != null);
  if (!o) return null;
  const feels = o.heatIndex?.value ?? o.windChill?.value ?? o.temperature.value;
  const text = o.textDescription || period?.shortForecast || '';
  const isDaytime = o.icon ? !o.icon.includes('/night/') : period ? period.isDaytime : true;
  return {
    time: o.timestamp,
    temp: round1(o.temperature.value),
    feelsLike: round1(feels),
    text,
    category: categorize(text),
    isDaytime,
    humidity: o.relativeHumidity?.value == null ? null : Math.round(o.relativeHumidity.value),
    windKph: o.windSpeed?.value == null ? null : Math.round(o.windSpeed.value),
  };
}

function forecastByDate(periods) {
  const byDate = new Map();
  for (const p of periods) {
    // startTime carries the local offset, so the first 10 chars are the local date.
    const date = p.startTime.slice(0, 10);
    const d = byDate.get(date) || {};
    if (p.isDaytime) d.day = p;
    else d.night = p;
    byDate.set(date, d);
  }
  return byDate;
}

export async function getWeather(lat, lon) {
  const point = await getPoint(lat, lon);
  const { timeZone } = point;
  const now = Date.now();
  const today = localDate(now, timeZone);
  const pastDates = Array.from({ length: PAST_DAYS }, (_, i) => addDays(today, i - PAST_DAYS));
  // Start a little before the first local midnight we need, whatever the zone offset.
  const start = new Date(now - (PAST_DAYS + 1) * DAY_MS - 14 * 3_600_000);

  const [stations, periods] = await Promise.all([
    getStations(point.stationsUrl),
    getForecast(point.forecastUrl).catch(() => []),
  ]);
  if (!stations.length) throw new Error('No observation stations near this location');

  const picked = await pickStation(stations, start, pastDates, timeZone);
  if (!picked) throw new Error('Could not load observations from nearby stations');
  const { station, observations, summary } = picked;
  const forecast = forecastByDate(periods);

  const days = [];

  for (const date of pastDates) {
    const s = summary.get(date);
    days.push({
      date,
      kind: 'past',
      high: round1(s?.high),
      low: round1(s?.low),
      partial: !s || s.readings < 8 || s.startHour > 3 || s.endHour < 20,
      category: s?.category || null,
      precip: s ? { observed: true, ...s.precip } : null,
    });
  }

  // Today: observed so far, topped up with today's forecast high if it hasn't happened yet.
  const s = summary.get(today);
  const f = forecast.get(today) || {};
  const todayPeriod = f.day || f.night;
  const highs = [s?.high, f.day?.temperature].filter((v) => v != null);
  const lows = [s?.low].filter((v) => v != null);
  if (!lows.length && f.night) lows.push(f.night.temperature);
  days.push({
    date: today,
    kind: 'today',
    high: highs.length ? round1(Math.max(...highs)) : null,
    low: lows.length ? round1(Math.min(...lows)) : null,
    category: todayPeriod ? categorize(todayPeriod.shortForecast) : s?.category || null,
    precip: {
      observed: !!s,
      ...(s?.precip || { mm: null, hours: 0, kind: null }),
      chance: todayPeriod?.probabilityOfPrecipitation?.value ?? null,
    },
  });

  for (const [date, { day, night }] of [...forecast].sort()) {
    if (date <= today || !day || !night) continue;
    const chance = Math.max(day.probabilityOfPrecipitation?.value ?? 0, night.probabilityOfPrecipitation?.value ?? 0);
    days.push({
      date,
      kind: 'forecast',
      high: day.temperature,
      low: night.temperature,
      category: categorize(day.shortForecast),
      text: day.shortForecast,
      precip: { observed: false, chance, kind: categorize(day.shortForecast) === 'snow' ? 'snow' : 'rain' },
    });
  }

  // The forecast can be cached for hours, so its first period may already be over; use the one covering now.
  const nowPeriod =
    periods.find((p) => Date.parse(p.startTime) <= now && now < Date.parse(p.endTime)) ||
    periods.find((p) => Date.parse(p.startTime) > now);

  return {
    location: { city: point.city, state: point.state, timeZone, lat, lon },
    station: { id: station.id, name: station.name },
    current: currentFrom(observations, nowPeriod),
    days,
    generatedAt: new Date(now).toISOString(),
  };
}
