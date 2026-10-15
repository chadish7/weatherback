# WeatherBack

A web site that shows past weather in a nice way.

WeatherBack shows the **last 7 days** of observed weather for your location as Apple Weather–style
temperature range bars, followed by the NOAA forecast in a faded style. US locations only.

- Asks for your browser location, and falls back to a US zip code.
- Hero card with current conditions, today's high/low, feels-like, humidity, and wind.
- One row per day: past 7 days in full colour, then today (with a dot marking the current temperature),
  then the forecast days faded.
- Rain indicator under each bar: observed amount (or hours of rain/snow when the station doesn't report
  amounts) for past days, chance of precipitation for forecast days.
- °F by default, with a °C toggle that is remembered in the browser.
- **Load 7 more days** button at the top of the list fetches older days from NOAA's NCEI archive,
  7 at a time, as far back as you like.

## How it works

```
browser (public/)  ──►  Node/Express (server.js)  ──►  api.weather.gov (NOAA NWS): last ~7 days + forecast
                         │                         ──►  ncei.noaa.gov (NOAA NCEI): older days (Load more)
                         └─ data/zips.json (US Census ZCTA centroids)
```

| Endpoint | Purpose |
| --- | --- |
| `GET /api/weather?lat=&lon=` | Current conditions, 7 past days, today, forecast days. °C and mm. |
| `GET /api/history?lat=&lon=&end=YYYY-MM-DD&days=7` | Older days ending on `end` (inclusive, max 14), from NCEI daily summaries. |
| `GET /api/zip/:zip` | Zip code → `{ lat, lon }` from the bundled Census file. |

The server picks the nearest NWS observation station that has data for most of the week, groups
its observations by local calendar day to get each day's high and low, and merges in the NWS
12-hour forecast. Responses from NOAA are cached in memory (forecast for 30 min, observations for
10 min, grid and station lookups for 24 h).

**Data limits.** NWS only keeps about 7 days of station observations, so the oldest day is often
incomplete. Those days are marked with `*`. Many stations don't report precipitation amounts; in that
case the rain indicator shows hours with rain or snow observed.

**Older days** come from NCEI's GHCN-Daily dataset through its keyless
[Access Data Service](https://www.ncei.noaa.gov/support/access-data-service-api-user-documentation).
The server finds daily-reporting stations within about 50 km (widening to about 110 km), uses the nearest
one with good coverage, and fills gaps from the next nearest. The first "Load more" also replaces the
partial oldest NWS day with the full NCEI record (keeping its NWS sky icon). NCEI days have no cloud cover, so
icons come from rain/snow totals and NOAA's weather-event flags (thunder, fog, haze, high wind). A dry day with
no events shows a neutral 🌤️ "dry" icon. NCEI data lags a few days, which doesn't matter for these older dates.

## Run locally

Requires Node.js 20 or newer.

```bash
npm install
WEATHERBACK_CONTACT=you@example.com npm start   # http://127.0.0.1:3000
```

Browser geolocation only works on `https://` or `http://localhost`. On other plain-HTTP hosts the
app goes straight to the zip code prompt.

| Variable | Default | Notes |
| --- | --- | --- |
| `PORT` | `3000` | |
| `HOST` | `127.0.0.1` | Keep on loopback behind nginx. |
| `WEATHERBACK_CONTACT` | — | Email or URL sent in the User-Agent, as NOAA requests. |

### Refreshing zip code data

`data/zips.json` is committed. To rebuild it from a newer Census Gazetteer release
(needs `curl` and `unzip`):

```bash
npm run build-zips -- 2025
```

## Deploy on CloudPanel

1. In CloudPanel, choose **Add Site → Create a Node.js Site**. Pick Node.js 20 or newer and set
   **App Port** to `3000` (or another free port).
2. Under the site's **SSL/TLS** tab, issue a Let's Encrypt certificate. HTTPS is required for
   browser geolocation.
3. SSH in as the site user and put the code in the site root:
   ```bash
   cd htdocs/<your-domain>
   git clone <repo-url> .
   npm ci --omit=dev
   ```
4. Start it with PM2, passing the App Port and your contact (email or site URL), then save the
   process list so the settings survive restarts:
   ```bash
   npm install -g pm2@latest
   PORT=3000 WEATHERBACK_CONTACT=https://<your-domain> pm2 start ecosystem.config.cjs
   pm2 save
   ```
5. To restart after a reboot, run `echo $PATH`, then `crontab -e` and add:
   ```
   PATH=<output of echo $PATH>
   @reboot pm2 resurrect &> /dev/null
   ```

To update: `git pull && npm ci --omit=dev && pm2 restart weatherback`.

CloudPanel's nginx vhost already proxies the domain to the App Port; no extra nginx config is needed.
See the [CloudPanel PM2 guide](https://www.cloudpanel.io/docs/v2/nodejs/deployment/pm2/).

## Credits

Weather data: [NOAA National Weather Service API](https://www.weather.gov/documentation/services-web-api).
Zip code centroids: [US Census Bureau Gazetteer Files](https://www.census.gov/geographies/reference-files/time-series/geo/gazetteer-files.html).
