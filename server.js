import express from 'express';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getWeather } from './lib/weather.js';
import { getHistory } from './lib/history.js';
import { NwsError } from './lib/nws.js';

const root = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '127.0.0.1';

const zips = JSON.parse(readFileSync(join(root, 'data', 'zips.json'), 'utf8'));

const app = express();
app.disable('x-powered-by');
// CloudPanel puts nginx in front of the app.
app.set('trust proxy', 'loopback');

app.use((req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'same-origin',
    'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'",
    'Permissions-Policy': 'geolocation=(self)',
  });
  next();
});

app.get('/api/zip/:zip', (req, res) => {
  const { zip } = req.params;
  if (!/^\d{5}$/.test(zip)) return res.status(400).json({ error: 'Enter a 5-digit US zip code.' });
  const hit = zips[zip];
  if (!hit) return res.status(404).json({ error: `Zip code ${zip} not found.` });
  res.set('Cache-Control', 'public, max-age=86400');
  res.json({ zip, lat: hit[0], lon: hit[1] });
});

function parseLatLon(query) {
  const lat = Number(query.lat);
  const lon = Number(query.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return { lat, lon };
}

app.get('/api/weather', async (req, res) => {
  const point = parseLatLon(req.query);
  if (!point) return res.status(400).json({ error: 'lat and lon are required.' });
  const { lat, lon } = point;
  try {
    const data = await getWeather(lat, lon);
    res.set('Cache-Control', 'public, max-age=300');
    res.json(data);
  } catch (err) {
    console.error(`[weather] ${lat},${lon}:`, err.message);
    if (err instanceof NwsError && err.status === 404) {
      return res.status(404).json({ error: 'NOAA has no data for this location. WeatherBack covers the US only.' });
    }
    res.status(502).json({ error: 'Could not reach NOAA right now. Please try again shortly.' });
  }
});

// Older days (beyond what NWS keeps) from NCEI daily summaries. `end` is inclusive.
app.get('/api/history', async (req, res) => {
  const point = parseLatLon(req.query);
  const { end } = req.query;
  const days = Number(req.query.days ?? 7);
  if (!point || typeof end !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(end) || Number.isNaN(Date.parse(end))) {
    return res.status(400).json({ error: 'lat, lon and end (YYYY-MM-DD) are required.' });
  }
  if (!Number.isInteger(days) || days < 1 || days > 14) {
    return res.status(400).json({ error: 'days must be between 1 and 14.' });
  }
  if (end < '1900-01-01' || Date.parse(end) > Date.now()) {
    return res.status(400).json({ error: 'end must be a past date.' });
  }
  try {
    const data = await getHistory(point.lat, point.lon, end, days);
    res.set('Cache-Control', 'public, max-age=3600');
    res.json(data);
  } catch (err) {
    console.error(`[history] ${point.lat},${point.lon} ${end}:`, err.message);
    res.status(502).json({ error: 'Could not load older weather from NOAA right now.' });
  }
});

app.use(express.static(join(root, 'public'), { maxAge: '1h' }));

app.listen(PORT, HOST, () => {
  console.log(`WeatherBack listening on http://${HOST}:${PORT}`);
  if (!process.env.WEATHERBACK_CONTACT) {
    console.warn('Set WEATHERBACK_CONTACT (email or URL) so NOAA can identify this app\'s User-Agent.');
  }
});
