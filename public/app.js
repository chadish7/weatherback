// WeatherBack frontend. The API returns °C and mm; everything is converted here for display.

const $ = (sel) => document.querySelector(sel);

const UNIT_KEY = 'weatherback-unit';
let unit = localStorage.getItem(UNIT_KEY) === 'C' ? 'C' : 'F';
let lastData = null;
let lastPlaceLabel = null;
// Older days from /api/history, oldest first, shown above lastData.days.
let olderDays = [];
let olderStations = new Map();
let historyToken = 0;

const LOAD_MORE_DAYS = 7;

const ICONS = {
  clear: '☀️',
  partly: '⛅',
  cloudy: '☁️',
  rain: '🌧️',
  snow: '🌨️',
  thunder: '⛈️',
  fog: '🌫️',
  wind: '💨',
  dry: '🌤️',
};
const NIGHT_ICONS = { clear: '🌙', partly: '☁️' };
const PRECIP_WORD = { rain: 'Rain', snow: 'Snow', thunder: 'Storms' };

// Apple-style temperature colours, keyed by °C.
const TEMP_STOPS = [
  [-15, [124, 92, 214]],
  [-5, [80, 132, 240]],
  [3, [74, 178, 240]],
  [10, [63, 201, 214]],
  [16, [120, 210, 110]],
  [21, [243, 211, 74]],
  [26, [247, 161, 58]],
  [32, [239, 90, 60]],
  [40, [200, 40, 60]],
];

// ---------- formatting ----------

const toUnit = (c) => (unit === 'F' ? (c * 9) / 5 + 32 : c);
const fmtTemp = (c) => (c == null ? '–' : `${Math.round(toUnit(c))}°`);

function fmtPrecip(mm) {
  if (unit === 'F') {
    const inches = mm / 25.4;
    return inches < 0.01 ? '<0.01 in' : `${inches.toFixed(2)} in`;
  }
  return mm < 1 ? `${mm.toFixed(1)} mm` : `${Math.round(mm)} mm`;
}

function tempColor(c) {
  if (c <= TEMP_STOPS[0][0]) return `rgb(${TEMP_STOPS[0][1]})`;
  for (let i = 1; i < TEMP_STOPS.length; i++) {
    const [t1, c1] = TEMP_STOPS[i];
    if (c <= t1) {
      const [t0, c0] = TEMP_STOPS[i - 1];
      const f = (c - t0) / (t1 - t0);
      return `rgb(${c0.map((v, k) => Math.round(v + (c1[k] - v) * f)).join(',')})`;
    }
  }
  return `rgb(${TEMP_STOPS[TEMP_STOPS.length - 1][1]})`;
}

function barGradient(low, high) {
  const steps = 6;
  const stops = [];
  for (let i = 0; i <= steps; i++) {
    const t = low + ((high - low) * i) / steps;
    stops.push(`${tempColor(t)} ${Math.round((i / steps) * 100)}%`);
  }
  return `linear-gradient(90deg, ${stops.join(', ')})`;
}

// Dates arrive as local YYYY-MM-DD strings; format them without shifting time zones.
function dayLabel(isoDate) {
  const d = new Date(`${isoDate}T12:00:00Z`);
  return {
    weekday: d.toLocaleDateString(undefined, { weekday: 'short', timeZone: 'UTC' }),
    date: d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' }),
  };
}

function precipText(day) {
  const p = day.precip;
  if (!p) return '';
  const parts = [];
  if (p.observed) {
    if (p.mm > 0) parts.push(fmtPrecip(p.mm));
    else if (p.hours > 0) parts.push(`${PRECIP_WORD[p.kind] || 'Rain'} · ${p.hours} hr`);
  }
  if (day.kind !== 'past' && p.chance >= 10) parts.push(`${p.chance}%`);
  return parts.length ? `💧 ${parts.join(' · ')}` : '';
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

// ---------- rendering ----------

function renderHero(data) {
  const { current, location, days } = data;
  const today = days.find((d) => d.kind === 'today');
  const place = [location.city, location.state].filter(Boolean).join(', ');
  $('#place').textContent = lastPlaceLabel ? `${place} · ${lastPlaceLabel}` : place || 'Your location';

  if (current) {
    $('#hero-temp').textContent = fmtTemp(current.temp);
    $('#hero-text').textContent = current.text;
    const extra = [`Feels like ${fmtTemp(current.feelsLike)}`];
    if (current.humidity != null) extra.push(`Humidity ${current.humidity}%`);
    if (current.windKph === 0) extra.push('Calm');
    else if (current.windKph != null) {
      extra.push(unit === 'F' ? `Wind ${Math.round(current.windKph / 1.609)} mph` : `Wind ${current.windKph} km/h`);
    }
    $('#hero-extra').textContent = extra.join('  ·  ');
  } else {
    $('#hero-temp').textContent = '–';
    $('#hero-text').textContent = 'No current observation';
    $('#hero-extra').textContent = '';
  }
  $('#hero-hilo').textContent = today ? `H:${fmtTemp(today.high)}  L:${fmtTemp(today.low)}` : '';

  const cat = current?.category || 'clear';
  const night = current && !current.isDaytime;
  let sky = 'sky-day';
  if (cat === 'rain') sky = 'sky-rain';
  else if (cat === 'snow') sky = 'sky-snow';
  else if (cat === 'thunder') sky = 'sky-thunder';
  else if (cat === 'cloudy' || cat === 'fog') sky = night ? 'sky-cloudy-night' : 'sky-cloudy';
  else if (night) sky = 'sky-night';
  document.body.className = sky;
}

function renderDays(data) {
  const list = $('#days');
  list.replaceChildren();

  const known = data.days.filter((d) => d.low != null && d.high != null);
  const minT = Math.min(...known.map((d) => d.low));
  const maxT = Math.max(...known.map((d) => d.high));
  const span = Math.max(maxT - minT, 1);
  const pct = (t) => ((t - minT) / span) * 100;

  let shownDivider = false;
  for (const day of data.days) {
    if (day.kind === 'forecast' && !shownDivider) {
      list.append(el('li', 'divider', 'Forecast'));
      shownDivider = true;
    }

    const li = el('li', `day ${day.kind}`);
    const label = dayLabel(day.date);
    const name = el('div', 'day-name', day.kind === 'today' ? 'Today' : label.weekday);
    name.append(el('small', null, day.partial ? `${label.date}*` : label.date));
    if (day.partial) li.title = 'Partial day: NOAA did not report observations for the whole day';
    if (day.source === 'ncei') {
      li.title = day.station ? `Daily summary from NCEI station ${day.station}` : 'No NOAA daily record for this day';
      if (day.category === 'dry') li.title += '. No rain recorded; NOAA daily records don\'t include cloud cover';
    }

    const icon = el('div', 'day-icon', ICONS[day.category] || '');
    icon.setAttribute('aria-hidden', 'true');

    const track = el('div', 'bar-track');
    if (day.low != null && day.high != null) {
      const bar = el('div', 'bar');
      bar.style.left = `${pct(day.low)}%`;
      bar.style.width = `${pct(day.high) - pct(day.low)}%`;
      bar.style.background = barGradient(day.low, day.high);
      track.append(bar);
      if (day.kind === 'today' && data.current?.temp != null) {
        const dot = el('div', 'now-dot');
        const t = Math.min(Math.max(data.current.temp, minT), maxT);
        dot.style.left = `${pct(t)}%`;
        dot.title = `Now ${fmtTemp(data.current.temp)}`;
        track.append(dot);
      }
    }
    track.setAttribute('role', 'img');
    track.setAttribute('aria-label', `Low ${fmtTemp(day.low)}, high ${fmtTemp(day.high)}`);

    li.append(
      name,
      icon,
      el('div', 'day-low', fmtTemp(day.low)),
      track,
      el('div', 'day-high', fmtTemp(day.high)),
      el('div', 'precip', precipText(day)),
    );
    if (day.kind === 'forecast' && day.text) li.title = `Forecast: ${day.text}`;
    list.append(li);
  }
}

/** NWS days with any NCEI replacements (the oldest NWS day is partial), preceded by older NCEI days. */
function allDays() {
  if (!lastData) return [];
  const replaced = new Map(olderDays.map((d) => [d.date, d]));
  // Keep NWS's sky icon when swapping in the NCEI record, since NCEI has no cloud cover.
  const recent = lastData.days.map((d) => {
    const r = replaced.get(d.date);
    if (!d.partial || r?.high == null) return d;
    return { ...r, category: r.category === 'dry' && d.category ? d.category : r.category };
  });
  const recentDates = new Set(recent.map((d) => d.date));
  return [...olderDays.filter((d) => !recentDates.has(d.date)), ...recent];
}

function render() {
  if (!lastData) return;
  const days = allDays();
  renderHero(lastData);
  renderDays({ ...lastData, days });
  const pastCount = days.filter((d) => d.kind === 'past').length;
  $('#days-title').textContent = `Past ${pastCount} days & forecast`;
  const s = lastData.station;
  const updated = new Date(lastData.generatedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  let source = `Observations from ${s.name} (${s.id}) · Updated ${updated}`;
  if (olderStations.size) {
    source += ` · Older days: NCEI daily summaries from ${[...olderStations.values()].map((st) => st.name).join(', ')}`;
  }
  $('#source').textContent = source;
  $('#partial-note').hidden = !days.some((d) => d.partial);
}

// ---------- load more (older days) ----------

function addDays(isoDate, n) {
  return new Date(Date.parse(`${isoDate}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
}

function resetHistory() {
  olderDays = [];
  olderStations = new Map();
  historyToken++;
  $('#load-more').disabled = false;
  $('#load-more').textContent = `Load ${LOAD_MORE_DAYS} more days`;
  $('#load-more-status').hidden = true;
}

async function loadMore() {
  if (!lastData) return;
  const token = ++historyToken;
  const button = $('#load-more');
  const status = $('#load-more-status');
  const { lat, lon } = lastData.location;

  // First time, include the oldest NWS day too, since NWS usually only has part of it.
  let end;
  let count = LOAD_MORE_DAYS;
  if (olderDays.length) {
    end = addDays(olderDays[0].date, -1);
  } else {
    const oldest = lastData.days[0];
    end = oldest.partial ? oldest.date : addDays(oldest.date, -1);
    if (oldest.partial) count += 1;
  }

  button.disabled = true;
  button.textContent = 'Loading…';
  status.hidden = true;
  try {
    const data = await getJson(`/api/history?lat=${lat.toFixed(4)}&lon=${lon.toFixed(4)}&end=${end}&days=${count}`);
    if (token !== historyToken) return; // location changed while loading
    if (!data.days.some((d) => d.high != null)) {
      status.textContent = 'NOAA has no older daily records near this location for those dates.';
      status.hidden = false;
    }
    olderDays = [...data.days, ...olderDays];
    for (const st of data.stations) olderStations.set(st.id, st);
    render();
  } catch (err) {
    if (token !== historyToken) return;
    status.textContent = err.message;
    status.hidden = false;
  } finally {
    if (token === historyToken) {
      button.disabled = false;
      button.textContent = `Load ${LOAD_MORE_DAYS} more days`;
    }
  }
}

$('#load-more').addEventListener('click', loadMore);

// ---------- state / flow ----------

function show(section) {
  $('#locate').hidden = section !== 'locate';
  $('#loading').hidden = section !== 'loading';
  $('#weather').hidden = section !== 'weather';
  $('#change-location').hidden = section !== 'weather';
}

function askForZip(message, isError = false) {
  show('locate');
  $('#locate-status').hidden = !!isError || !message;
  $('#locate-status').textContent = isError ? '' : message || '';
  $('#locate-error').hidden = !isError;
  $('#locate-error').textContent = isError ? message : '';
  $('#zip-form').hidden = false;
  $('#use-location').hidden = !('geolocation' in navigator);
  $('#zip').focus();
}

async function getJson(url) {
  const res = await fetch(url);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`);
  return body;
}

async function loadWeather(lat, lon, placeLabel = null) {
  show('loading');
  try {
    const data = await getJson(`/api/weather?lat=${lat.toFixed(4)}&lon=${lon.toFixed(4)}`);
    lastData = data;
    lastPlaceLabel = placeLabel;
    resetHistory();
    render();
    show('weather');
  } catch (err) {
    askForZip(err.message, true);
  }
}

function locate() {
  if (!('geolocation' in navigator) || !window.isSecureContext) {
    askForZip('Enter a zip code to see your weather.');
    return;
  }
  show('locate');
  $('#zip-form').hidden = true;
  $('#locate-error').hidden = true;
  $('#locate-status').hidden = false;
  $('#locate-status').textContent = 'Finding your location…';
  navigator.geolocation.getCurrentPosition(
    (pos) => loadWeather(pos.coords.latitude, pos.coords.longitude),
    () => askForZip("We couldn't get your location."),
    { timeout: 10000, maximumAge: 10 * 60 * 1000 },
  );
}

$('#zip-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const zip = $('#zip').value.trim();
  if (!/^\d{5}$/.test(zip)) {
    askForZip('Enter a 5-digit US zip code.', true);
    return;
  }
  try {
    const { lat, lon } = await getJson(`/api/zip/${zip}`);
    loadWeather(lat, lon, zip);
  } catch (err) {
    askForZip(err.message, true);
  }
});

$('#use-location').addEventListener('click', locate);
$('#change-location').addEventListener('click', () => askForZip(''));

function setUnit(next) {
  unit = next;
  localStorage.setItem(UNIT_KEY, unit);
  document.querySelectorAll('.unit-toggle button').forEach((b) => {
    b.setAttribute('aria-pressed', String(b.dataset.unit === unit));
  });
  render();
}
document.querySelectorAll('.unit-toggle button').forEach((b) => {
  b.addEventListener('click', () => setUnit(b.dataset.unit));
});

setUnit(unit);
locate();
