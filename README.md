# WeatherBack

A web site that shows past weather in a nice way.

WeatherBack shows the **last 7 days** of observed weather for your location as Apple Weather–style
temperature range bars, followed by the NOAA forecast in a faded style. US locations only.

- Opens on a location screen: search for a US city (suggestions appear as you type) or zip code, or tap
  **Use my current location**. The browser only asks for location permission when you tap that button.
- The chosen location is saved in a cookie, so return visits go straight to the weather. **Change location**
  in the top bar goes back to the search.
- Hero card with current conditions, today's high/low, feels-like, humidity, and wind.
- One row per day: past 7 days in full colour, then today (with a dot marking the current temperature),
  then the forecast days faded.
- Rain indicator under each bar: observed amount (or hours of rain/snow when the station doesn't report
  amounts) for past days, chance of precipitation for forecast days.
- °F by default, with a °C toggle that is remembered in the browser.
- **Load 7 more days** button at the top of the list fetches older days from NOAA's NCEI archive,
  7 at a time, as far back as you like. New rows fade and slide in, and their bars grow from the low end.

## How it works

```
browser (public/)  ──►  Node/Express (server.js)  ──►  api.weather.gov (NOAA NWS): last ~7 days + forecast
                         │                         ──►  ncei.noaa.gov (NOAA NCEI): older days (Load more)
                         └─ data/zips.json, places.json, zip-names.json (US Census zip and city data)
```

| Endpoint | Purpose |
| --- | --- |
| `GET /api/weather?lat=&lon=` | Current conditions, 7 past days, today, forecast days. °C and mm. |
| `GET /api/history?lat=&lon=&end=YYYY-MM-DD&days=7` | Older days ending on `end` (inclusive, max 14), from NCEI daily summaries. |
| `GET /api/zip/:zip` | Zip code → `{ lat, lon, label }` from the bundled Census files. |
| `GET /api/places?q=` | Up to 8 location suggestions for typed text: city names ("denv", "portland or", "st louis"), or a zip code once 5 digits are typed. |

The server picks the nearest NWS observation station that has data for most of the week, groups
its observations by local calendar day to get each day's high and low, and merges in the NWS
12-hour forecast. NOAA responses are cached in memory and in a SQLite file (`cache/weatherback.sqlite`, using
Node's built-in `node:sqlite`), so the cache survives restarts and deploys. Cache times: forecast 8 h,
observations 10 min, grid and station lookups 24 h. Expired rows are purged hourly. Deleting the file is safe;
it's rebuilt on demand.

The cache fills gaps rather than refetching everything:
- **Older days** are cached per station per day. A request uses the days already cached and asks NCEI only for
  the missing date range. Days NCEI hadn't published yet are re-checked after 3 hours, complete recent days after
  24 hours, and days over a month old are kept for 30 days.
- **Recent observations** are stored per station with the time span they cover. A refresh (at most every 10 min)
  fetches only observations since the last pull, with a 2-hour overlap for late reports, and fetches the whole week
  only if older data is missing. If NWS is down, the cached observations are used.

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

Requires Node.js 22.13 or newer (for the built-in `node:sqlite`).

```bash
npm install
WEATHERBACK_CONTACT=you@example.com npm start   # http://127.0.0.1:3000
```

Browser geolocation only works on `https://` or `http://localhost`. On other plain-HTTP hosts the
"Use my current location" button is hidden and only search is offered.

| Variable | Default | Notes |
| --- | --- | --- |
| `PORT` | `3000` | |
| `HOST` | `127.0.0.1` | Keep on loopback behind nginx. |
| `WEATHERBACK_CONTACT` | — | Email or URL sent in the User-Agent, as NOAA requests. |
| `WEATHERBACK_DB` | `cache/weatherback.sqlite` | SQLite cache file. If it can't be opened, the app logs a warning and caches in memory only. |

### Refreshing zip code and city data

The files in `data/` are committed. To rebuild them from newer Census releases (needs `curl` and `unzip`):

```bash
npm run build-zips -- 2025     # data/zips.json: zip code centroids (Gazetteer ZCTA file)
npm run build-places -- 2025   # data/places.json: cities with population; data/zip-names.json: town name per zip
```

City suggestions are ranked by population (Census city and town estimates). Unincorporated communities
(CDPs) are included but have no population figure, so they rank below incorporated towns of the same name.

## Deploy on CloudPanel

1. In CloudPanel, choose **Add Site → Create a Node.js Site**. Pick Node.js 22 (22.13+) or newer and set
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
Zip codes, cities and populations: [US Census Bureau Gazetteer Files](https://www.census.gov/geographies/reference-files/time-series/geo/gazetteer-files.html),
[population estimates](https://www.census.gov/programs-surveys/popest.html), and the 2020 ZCTA-to-place relationship file.
