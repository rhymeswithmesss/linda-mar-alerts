/**
 * Linda Mar Surf Alert — 7-day forecast digest
 * Scans the Stormglass forecast for upcoming hours that match your sweet spot,
 * groups them into windows, and emails a once-a-day digest (Slack/SMS optional).
 *
 * Sweet spot criteria (from your screenshot):
 *   - Surf height:  1–3 ft (small but rideable)
 *   - Wind speed:   ≤ 5 kts (glassy / light)
 *   - Tide height:  -1.0 ft to +1.0 ft (low tide window)
 *   - Primary swell period: ≥ 8s (some shape)
 *
 * Only daylight hours are considered, and an alert is sent only when at least
 * one matching window exists in the forecast.
 */

const https = require("https");
const fs = require("fs");
const path = require("path");

const DASHBOARD_PATH = process.env.DASHBOARD_PATH || "public/index.html";

// ─── CONFIG ───────────────────────────────────────────────────────────────────

const CONFIG = {
  location: {
    name: "Linda Mar",
    lat: 37.5943,
    lng: -122.4998,
  },
  criteria: {
    surfHeightMin_ft: 1.0,    // minimum surf height in feet
    surfHeightMax_ft: 3.0,    // max SURF (breaking-face) height — applies to Surfline LOLA data
    surfHeightMaxHs_ft: 5.0,  // max SIGNIFICANT WAVE height — applies to the Stormglass fallback
                              //   (offshore Hs runs higher than breaking surf; ~5ft Hs ≈ your 3ft surf)
    windMax_kts: 5,           // max wind in knots (glassy threshold)
    tideMin_ft: -1.0,         // low tide window start
    tideMax_ft: 1.0,          // low tide window end
    swellPeriodMin_s: 8,      // minimum swell period for shape
  },
  forecastDays: 7,            // how far ahead to scan (Stormglass free tier returns ~7-10 days)
  daylightStartHour: 6,       // earliest hour to consider, PT (24h)
  daylightEndHour: 19,        // latest hour to consider, PT (24h)
  // Surfline (nearshore LOLA surf height — preferred source, with Stormglass fallback)
  surflineSpotId: process.env.SURFLINE_SPOT_ID || "5842041f4e65fad6a7708cdf", // Linda Mar State Beach
  surflineToken: process.env.SURFLINE_TOKEN,        // recommended: access token grabbed from a logged-in browser
  surflineEmail: process.env.SURFLINE_EMAIL,        // optional: exchanged for a token at runtime
  surflinePassword: process.env.SURFLINE_PASSWORD,  // optional: paired with SURFLINE_EMAIL
  // Set these via environment variables (never hardcode secrets)
  stormglassApiKey: process.env.STORMGLASS_API_KEY,
  // Email alert via Resend (https://resend.com)
  resendApiKey: process.env.RESEND_API_KEY,                                   // required for email
  emailTo: process.env.EMAIL_TO,                                              // your inbox, e.g. "you@example.com"
  emailFrom: process.env.EMAIL_FROM || "Surf Alerts <onboarding@resend.dev>", // default sender works with no domain setup
  slackWebhookUrl: process.env.SLACK_WEBHOOK_URL,   // optional
  twilioAccountSid: process.env.TWILIO_ACCOUNT_SID, // optional
  twilioAuthToken: process.env.TWILIO_AUTH_TOKEN,   // optional
  twilioFrom: process.env.TWILIO_FROM,              // optional, e.g. "+14155550100"
  twilioTo: process.env.TWILIO_TO,                  // optional, e.g. "+14155550101"
};

// ─── HELPERS ──────────────────────────────────────────────────────────────────

function metersToFeet(m) {
  return m * 3.28084;
}

function msToKnots(ms) {
  return ms * 1.94384;
}

function degToCompass(deg) {
  const dirs = ["N","NNE","NE","ENE","E","ESE","SE","SSE","S","SSW","SW","WSW","W","WNW","NW","NNW"];
  return dirs[Math.round(deg / 22.5) % 16];
}

// Hour-of-day (0-23) for a timestamp, in Pacific time
const _ptHourFmt = new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", hour: "2-digit", hourCycle: "h23" });
function ptHour(date) {
  return parseInt(_ptHourFmt.format(date), 10);
}

const _ptDayFmt = new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", weekday: "short", month: "short", day: "numeric" });
const _ptTimeFmt = new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", hour: "numeric", minute: "2-digit" });
const ptDay = (date) => _ptDayFmt.format(date);
const ptTime = (date) => _ptTimeFmt.format(date);

const _ptStampFmt = new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
const ptStamp = (date) => _ptStampFmt.format(date);

// "6a", "12p", "7p" style hour label
function hourLabel(h) {
  const ap = h < 12 ? "a" : "p";
  let hr = h % 12;
  if (hr === 0) hr = 12;
  return `${hr}${ap}`;
}

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const options = {
      headers: { Authorization: CONFIG.stormglassApiKey },
    };
    https.get(url, options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error(`Failed to parse response (HTTP ${res.statusCode}): ${data}`));
        }
      });
    }).on("error", reject);
  });
}

// ─── SURFLINE (nearshore LOLA surf height) ──────────────────────────────────

const SURFLINE_HOST = "services.surfline.com";
const BROWSER_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

// Generic Surfline request; never throws — resolves { status, json } so callers can fall back gracefully.
function surflineRequest(method, pathWithQuery, { token, body } = {}) {
  return new Promise((resolve) => {
    const headers = {
      "User-Agent": BROWSER_UA,
      "Accept": "application/json",
      "Origin": "https://www.surfline.com",
      "Referer": "https://www.surfline.com/",
    };
    let payload;
    if (body) {
      payload = JSON.stringify(body);
      headers["Content-Type"] = "application/json";
      headers["Content-Length"] = Buffer.byteLength(payload);
    }
    if (token) headers["Authorization"] = `Bearer ${token}`;
    const req = https.request({ hostname: SURFLINE_HOST, path: pathWithQuery, method, headers }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        let json = null;
        try { json = JSON.parse(data); } catch (e) { /* non-JSON (e.g. bot-block HTML) */ }
        resolve({ status: res.statusCode, json });
      });
    });
    req.on("error", () => resolve({ status: 0, json: null }));
    if (payload) req.write(payload);
    req.end();
  });
}

// Returns an access token (from SURFLINE_TOKEN, or by exchanging email/password), or null.
async function getSurflineToken() {
  if (CONFIG.surflineToken) return CONFIG.surflineToken;
  if (!CONFIG.surflineEmail || !CONFIG.surflinePassword) return null;
  const res = await surflineRequest("POST", "/trusted/token?isShortLived=false", {
    body: {
      grant_type: "password",
      username: CONFIG.surflineEmail,
      password: CONFIG.surflinePassword,
      device_id: "linda-mar-alerts",
      forced: true,
    },
  });
  if (res.status === 200 && res.json && res.json.access_token) {
    console.log("🔑 Surfline token obtained via email/password.");
    return res.json.access_token;
  }
  console.error(`⚠️  Surfline token exchange failed (HTTP ${res.status}). ` +
    `Set SURFLINE_TOKEN from a logged-in browser instead, or rely on the Stormglass fallback.`);
  return null;
}

// Fetch LOLA surf heights keyed by "YYYY-MM-DDTHH" (UTC), or null on any failure.
async function fetchSurflineSurf(token) {
  if (!CONFIG.surflineSpotId) return null;
  const q = `/kbyg/spots/forecasts/wave?spotId=${CONFIG.surflineSpotId}&days=${CONFIG.forecastDays}&intervalHours=1` +
    (token ? `&accesstoken=${encodeURIComponent(token)}` : "");
  const res = await surflineRequest("GET", q, { token });
  const wave = res.json && res.json.data && res.json.data.wave;
  if (res.status !== 200 || !wave) {
    console.error(`⚠️  Surfline surf fetch failed (HTTP ${res.status}) — using Stormglass for surf height.`);
    return null;
  }
  const units = (res.json.associated && res.json.associated.units && res.json.associated.units.waveHeight) || "FT";
  const toFt = units.toUpperCase() === "M" ? metersToFeet : (x) => x;
  const byHour = {};
  for (const p of wave) {
    if (!p.surf) continue;
    const key = new Date(p.timestamp * 1000).toISOString().slice(0, 13);
    byHour[key] = { min: toFt(p.surf.min), max: toFt(p.surf.max), human: p.surf.humanRelation || "" };
  }
  console.log(`🌊 Surfline LOLA surf loaded (${Object.keys(byHour).length} hours${token ? ", authenticated" : ", anonymous"}).`);
  return byHour;
}

// ─── FETCH FORECAST ─────────────────────────────────────────────────────────

async function fetchForecast() {
  const { lat, lng } = CONFIG.location;
  const params = [
    "waveHeight",     // significant wave height (m)
    "wavePeriod",     // swell period (s)
    "waveDirection",  // swell direction (°)
    "windSpeed",      // wind speed (m/s)
    "windDirection",  // wind direction (°)
  ].join(",");

  const now = new Date();
  const end = new Date(now.getTime() + CONFIG.forecastDays * 24 * 60 * 60 * 1000);

  const weatherUrl = `https://api.stormglass.io/v2/weather/point?lat=${lat}&lng=${lng}&params=${params}&start=${now.toISOString()}&end=${end.toISOString()}`;

  const token = await getSurflineToken();
  const [weatherData, tideByHour, surfByHour] = await Promise.all([
    fetchJson(weatherUrl),
    fetchTideSeries(lat, lng, now, end),
    fetchSurflineSurf(token),   // null if Surfline is unreachable → Stormglass takes over for surf height
  ]);

  if (weatherData.errors) {
    throw new Error(`Stormglass error: ${JSON.stringify(weatherData.errors)}`);
  }
  const hours = weatherData.hours;
  if (!hours || hours.length === 0) throw new Error("No weather data returned from Stormglass");

  // Stormglass returns values from multiple sources — prefer NOAA or sg (Stormglass model)
  const pick = (sources) => {
    if (!sources) return null;
    return (sources.noaa ?? sources.sg ?? sources.meteo ?? Object.values(sources)[0]);
  };

  return hours.map((hour) => {
    const key = hour.time.slice(0, 13); // "YYYY-MM-DDTHH"
    const hs_ft = metersToFeet(pick(hour.waveHeight) ?? 0); // Stormglass significant wave height (offshore)
    const sl = surfByHour && surfByHour[key];

    // Prefer Surfline LOLA breaking-surf height; fall back to Stormglass Hs
    let surfSource, surf_ft, surfMin_ft = null, surfMax_ft = null, surfHuman = null;
    if (sl) {
      surfSource = "surfline";
      surfMin_ft = sl.min;
      surfMax_ft = sl.max;
      surf_ft = (sl.min + sl.max) / 2; // representative value for the criterion check
      surfHuman = sl.human;
    } else {
      surfSource = "stormglass";
      surf_ft = hs_ft;
    }

    return {
      timestamp: hour.time,
      date: new Date(hour.time),
      surfSource,
      waveHeight_ft: surf_ft,        // representative surf height used for evaluation & display
      surfMin_ft, surfMax_ft, surfHuman,
      waveHeightHs_ft: hs_ft,        // always-available Stormglass offshore Hs
      wavePeriod_s: pick(hour.wavePeriod) ?? 0,
      waveDirection_deg: pick(hour.waveDirection) ?? 0,
      windSpeed_kts: msToKnots(pick(hour.windSpeed) ?? 0),
      windDirection_deg: pick(hour.windDirection) ?? 0,
      tide_ft: tide_lookup(tideByHour, key),
    };
  });
}

function tide_lookup(map, key) {
  return map[key] ?? null; // null = no tide reading for this hour
}

// Hourly sea-level (tide height), keyed by "YYYY-MM-DDTHH" for fast lookup
async function fetchTideSeries(lat, lng, start, end) {
  const url = `https://api.stormglass.io/v2/tide/sea-level/point?lat=${lat}&lng=${lng}&start=${start.toISOString()}&end=${end.toISOString()}`;
  const data = await fetchJson(url);
  const byHour = {};
  if (data.data) {
    for (const point of data.data) {
      byHour[point.time.slice(0, 13)] = metersToFeet(point.sg ?? 0);
    }
  }
  return byHour;
}

// ─── EVALUATE CONDITIONS ──────────────────────────────────────────────────────

function evaluate(c) {
  const { criteria } = CONFIG;
  // Surf ceiling depends on the source: Surfline reports breaking-surf height,
  // Stormglass reports offshore significant wave height (which runs higher).
  const surfMax = c.surfSource === "surfline" ? criteria.surfHeightMax_ft : criteria.surfHeightMaxHs_ft;
  const checks = {
    surfHeight: c.waveHeight_ft >= criteria.surfHeightMin_ft &&
                c.waveHeight_ft <= surfMax,
    wind:       c.windSpeed_kts <= criteria.windMax_kts,
    tide:       c.tide_ft != null &&
                c.tide_ft >= criteria.tideMin_ft &&
                c.tide_ft <= criteria.tideMax_ft,
    swellPeriod: c.wavePeriod_s >= criteria.swellPeriodMin_s,
  };
  const passed = Object.values(checks).every(Boolean);
  return { passed, checks };
}

// Group consecutive matching hours into windows
function groupWindows(matches) {
  const windows = [];
  let current = null;
  for (const c of matches) {
    if (current && c.date.getTime() - current.hours[current.hours.length - 1].date.getTime() <= 60 * 60 * 1000 + 1000) {
      current.hours.push(c);
    } else {
      current = { hours: [c] };
      windows.push(current);
    }
  }
  return windows;
}

// ─── FORMAT MESSAGE ───────────────────────────────────────────────────────────

function range(values, digits = 1) {
  const min = Math.min(...values).toFixed(digits);
  const max = Math.max(...values).toFixed(digits);
  return min === max ? min : `${min}–${max}`;
}

function formatWindow(w) {
  const hrs = w.hours;
  const start = hrs[0].date;
  const end = new Date(hrs[hrs.length - 1].date.getTime() + 60 * 60 * 1000); // window covers through end of last hour
  const peak = hrs[Math.floor(hrs.length / 2)]; // representative middle hour for direction

  const surf = range(hrs.map((h) => h.waveHeight_ft));
  const period = range(hrs.map((h) => h.wavePeriod_s), 0);
  const wind = Math.max(...hrs.map((h) => h.windSpeed_kts)).toFixed(1);
  const tide = range(hrs.map((h) => h.tide_ft));

  return `📅 *${ptDay(start)}*, ${ptTime(start)}–${ptTime(end)} PT
   Surf ${surf} ft · Swell ${period}s ${degToCompass(peak.waveDirection_deg)} · Wind ≤${wind} kts ${degToCompass(peak.windDirection_deg)} · Tide ${tide} ft`;
}

function formatDigest(windows) {
  const { name } = CONFIG.location;
  const n = windows.length;
  const header = `🏄 *Linda Mar — ${n} sweet-spot window${n === 1 ? "" : "s"} in the next ${CONFIG.forecastDays} days*`;
  const body = windows.map(formatWindow).join("\n\n");
  return `${header}

Upcoming windows at *${name}* matching your sweet spot (1–3ft, ≤5kt wind, -1 to +1ft tide, ≥8s swell period):

${body}

🔗 https://www.surfline.com/surf-report/linda-mar-state-beach/5842041f4e65fad6a7708cdf`;
}

// ─── DASHBOARD (GitHub Pages) ───────────────────────────────────────────────

const CRIT_LABELS = {
  surfHeight: "Surf",
  swellPeriod: "Swell",
  wind: "Wind",
  tide: "Tide",
};

function cellColor(passCount) {
  if (passCount === 4) return "#15803d";   // green — all match
  if (passCount === 3) return "#ca8a04";   // amber — close
  if (passCount === 2) return "#ea580c";   // orange
  return "#b91c1c";                          // red — not it
}

function surfText(c) {
  if (c.surfSource === "surfline" && c.surfMin_ft != null) {
    return `${c.surfMin_ft.toFixed(1)}–${c.surfMax_ft.toFixed(1)}ft`;
  }
  return `${c.waveHeight_ft.toFixed(1)}ft Hs`; // Stormglass offshore significant wave height
}

function buildCell(c) {
  const { checks } = evaluate(c);
  const passCount = Object.values(checks).filter(Boolean).length;
  const mark = (ok) => (ok ? "✓" : "✗");
  const tide = c.tide_ft == null ? "n/a" : `${c.tide_ft.toFixed(1)}ft`;
  const title = `${ptDay(c.date)} ${ptTime(c.date)} — ` +
    `Surf ${surfText(c)} ${mark(checks.surfHeight)} · ` +
    `Swell ${c.wavePeriod_s.toFixed(0)}s ${degToCompass(c.waveDirection_deg)} ${mark(checks.swellPeriod)} · ` +
    `Wind ${c.windSpeed_kts.toFixed(1)}kt ${degToCompass(c.windDirection_deg)} ${mark(checks.wind)} · ` +
    `Tide ${tide} ${mark(checks.tide)}` +
    (passCount === 4 ? "  →  MATCH 🏄" : "");
  return { passCount, surf: c.waveHeight_ft, title };
}

function generateHtml(daylight, windows, generatedAt) {
  const { criteria } = CONFIG;

  const usingSurfline = daylight.some((c) => c.surfSource === "surfline");
  const sourceBadge = usingSurfline
    ? `<span class="badge ok">Surf: Surfline LOLA (breaking-surf height)</span>`
    : `<span class="badge warn">Surf: Stormglass estimate (offshore wave height — Surfline unavailable)</span>`;
  const surfMaxShown = usingSurfline ? criteria.surfHeightMax_ft : criteria.surfHeightMaxHs_ft;

  // group daylight hours by day, preserving chronological order
  const dayOrder = [];
  const byDay = new Map();
  for (const c of daylight) {
    const label = ptDay(c.date);
    if (!byDay.has(label)) { byDay.set(label, {}); dayOrder.push(label); }
    byDay.get(label)[ptHour(c.date)] = buildCell(c);
  }

  const hours = [];
  for (let h = CONFIG.daylightStartHour; h <= CONFIG.daylightEndHour; h++) hours.push(h);

  const headerCells = hours.map((h) => `<th>${hourLabel(h)}</th>`).join("");
  const rows = dayOrder.map((label) => {
    const cells = hours.map((h) => {
      const cell = byDay.get(label)[h];
      if (!cell) return `<td class="empty"></td>`;
      return `<td style="background:${cellColor(cell.passCount)}" title="${cell.title}">${cell.surf.toFixed(1)}</td>`;
    }).join("");
    return `<tr><th class="day">${label}</th>${cells}</tr>`;
  }).join("\n");

  const windowSummary = windows.length === 0
    ? `<p class="none">No sweet-spot windows in the next ${CONFIG.forecastDays} days — but check back daily, the forecast shifts.</p>`
    : `<ul class="windows">` + windows.map((w) => {
        const start = w.hours[0].date;
        const end = new Date(w.hours[w.hours.length - 1].date.getTime() + 60 * 60 * 1000);
        const surf = range(w.hours.map((h) => h.waveHeight_ft));
        return `<li><strong>${ptDay(start)}</strong> ${ptTime(start)}–${ptTime(end)} PT · Surf ${surf} ft</li>`;
      }).join("") + `</ul>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="3600">
<title>🏄 Linda Mar — 7-Day Surf Forecast</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; margin: 0; padding: 1.25rem; background: #0b1220; color: #e5e7eb; }
  .wrap { max-width: 920px; margin: 0 auto; }
  h1 { font-size: 1.4rem; margin: 0 0 .25rem; }
  .sub { color: #94a3b8; font-size: .85rem; margin: 0 0 1rem; }
  .criteria { background: #111c30; border: 1px solid #1e293b; border-radius: 10px; padding: .75rem 1rem; font-size: .9rem; margin-bottom: 1rem; }
  .criteria b { color: #38bdf8; }
  h2 { font-size: 1.05rem; margin: 1.5rem 0 .5rem; }
  .scroll { overflow-x: auto; -webkit-overflow-scrolling: touch; border-radius: 10px; }
  table { border-collapse: collapse; width: 100%; font-size: .8rem; }
  th, td { text-align: center; padding: .4rem .3rem; min-width: 34px; }
  thead th { color: #94a3b8; font-weight: 600; border-bottom: 1px solid #1e293b; }
  th.day { text-align: left; white-space: nowrap; color: #cbd5e1; font-weight: 600; padding-right: .6rem; position: sticky; left: 0; background: #0b1220; }
  td { color: #fff; font-weight: 600; border-radius: 4px; cursor: default; }
  td.empty { background: transparent; }
  .legend { display: flex; flex-wrap: wrap; gap: .75rem; font-size: .8rem; color: #cbd5e1; margin: .75rem 0 0; }
  .legend span { display: inline-flex; align-items: center; gap: .35rem; }
  .swatch { width: 14px; height: 14px; border-radius: 3px; display: inline-block; }
  .windows { padding-left: 1.1rem; line-height: 1.7; }
  .none { color: #94a3b8; }
  .hint { color: #64748b; font-size: .78rem; margin-top: .5rem; }
  footer { margin-top: 2rem; color: #64748b; font-size: .78rem; border-top: 1px solid #1e293b; padding-top: .75rem; }
  a { color: #38bdf8; }
  .badge { display: inline-block; padding: .2rem .55rem; border-radius: 999px; font-size: .78rem; font-weight: 600; }
  .badge.ok { background: #052e16; color: #4ade80; border: 1px solid #166534; }
  .badge.warn { background: #2e1908; color: #fb923c; border: 1px solid #9a3412; }
</style>
</head>
<body>
<div class="wrap">
  <h1>🏄 Linda Mar — 7-Day Forecast</h1>
  <p class="sub">Updated ${ptStamp(generatedAt)} PT · refreshes daily ~6:00 AM PT</p>
  <p class="sub">${sourceBadge}</p>

  <div class="criteria">
    Your sweet spot: <b>Surf ${criteria.surfHeightMin_ft}–${surfMaxShown} ft</b> ·
    <b>Wind ≤ ${criteria.windMax_kts} kt</b> ·
    <b>Tide ${criteria.tideMin_ft} to ${criteria.tideMax_ft} ft</b> ·
    <b>Swell period ≥ ${criteria.swellPeriodMin_s}s</b>
  </div>

  <h2>Daylight hours (number = surf height, ft)</h2>
  <div class="scroll">
    <table>
      <thead><tr><th class="day"></th>${headerCells}</tr></thead>
      <tbody>
${rows}
      </tbody>
    </table>
  </div>
  <div class="legend">
    <span><i class="swatch" style="background:#15803d"></i> all 4 match</span>
    <span><i class="swatch" style="background:#ca8a04"></i> 3 of 4</span>
    <span><i class="swatch" style="background:#ea580c"></i> 2 of 4</span>
    <span><i class="swatch" style="background:#b91c1c"></i> &lt; 2</span>
  </div>
  <p class="hint">Hover (or long-press) a cell for the full breakdown of which criteria pass.</p>

  <h2>Matching windows</h2>
  ${windowSummary}

  <footer>
    Data: <a href="https://stormglass.io">Stormglass</a> marine forecast ·
    <a href="https://www.surfline.com/surf-report/linda-mar-state-beach/5842041f4e65fad6a7708cdf">Surfline report</a><br>
    Generated by <a href="https://github.com/rhymeswithmesss/linda-mar-alerts">linda-mar-alerts</a>.
  </footer>
</div>
</body>
</html>
`;
}

function writeDashboard(html) {
  const dir = path.dirname(DASHBOARD_PATH);
  if (dir && dir !== ".") fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(DASHBOARD_PATH, html);
  console.log(`📊 Dashboard written to ${DASHBOARD_PATH}`);
}

// ─── NOTIFY ───────────────────────────────────────────────────────────────────

async function notifyEmail(subject, message) {
  if (!CONFIG.resendApiKey || !CONFIG.emailTo) return;
  const body = JSON.stringify({
    from: CONFIG.emailFrom,
    to: [CONFIG.emailTo],
    subject,
    text: message.replace(/\*/g, ""),   // strip Slack-style markdown for plain email
  });

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: "api.resend.com",
      path: "/emails",
      method: "POST",
      headers: {
        "Authorization": `Bearer ${CONFIG.resendApiKey}`,
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
      },
    }, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        if (res.statusCode >= 400) {
          console.error(`⚠️  Resend returned ${res.statusCode}: ${data}`);
        }
        resolve(res.statusCode);
      });
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

async function notifySlack(message) {
  if (!CONFIG.slackWebhookUrl) return;
  const body = JSON.stringify({ text: message });
  return new Promise((resolve, reject) => {
    const url = new URL(CONFIG.slackWebhookUrl);
    const req = https.request({
      hostname: url.hostname,
      path: url.pathname,
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
    }, (res) => { resolve(res.statusCode); });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

async function notifySMS(message) {
  if (!CONFIG.twilioAccountSid || !CONFIG.twilioAuthToken) return;
  const body = new URLSearchParams({
    From: CONFIG.twilioFrom,
    To: CONFIG.twilioTo,
    Body: message.replace(/\*/g, ""), // strip markdown for SMS
  }).toString();

  return new Promise((resolve, reject) => {
    const auth = Buffer.from(`${CONFIG.twilioAccountSid}:${CONFIG.twilioAuthToken}`).toString("base64");
    const req = https.request({
      hostname: "api.twilio.com",
      path: `/2010-04-01/Accounts/${CONFIG.twilioAccountSid}/Messages.json`,
      method: "POST",
      headers: {
        "Authorization": `Basic ${auth}`,
        "Content-Type": "application/x-www-form-urlencoded",
        "Content-Length": Buffer.byteLength(body),
      },
    }, (res) => { resolve(res.statusCode); });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────

async function main() {
  if (!CONFIG.stormglassApiKey) {
    console.error("❌ Missing STORMGLASS_API_KEY environment variable");
    process.exit(1);
  }

  console.log(`🌊 Scanning ${CONFIG.forecastDays}-day forecast for ${CONFIG.location.name}...`);

  const forecast = await fetchForecast();
  const daylight = forecast.filter((c) => {
    const h = ptHour(c.date);
    return h >= CONFIG.daylightStartHour && h <= CONFIG.daylightEndHour;
  });

  const matches = daylight.filter((c) => evaluate(c).passed);
  const windows = groupWindows(matches);

  const surfSource = daylight.some((c) => c.surfSource === "surfline") ? "Surfline LOLA" : "Stormglass (offshore Hs fallback)";
  console.log(`Surf-height source: ${surfSource}`);
  console.log(`Scanned ${forecast.length} forecast hours (${daylight.length} in daylight).`);
  console.log(`Found ${matches.length} matching hours across ${windows.length} window(s).`);

  // Always render the dashboard, even when nothing matches
  writeDashboard(generateHtml(daylight, windows, new Date()));

  if (windows.length === 0) {
    console.log("\n😐 No sweet-spot windows in the forecast. No alert sent.");
    return;
  }

  for (const w of windows) {
    const start = w.hours[0].date;
    const end = new Date(w.hours[w.hours.length - 1].date.getTime() + 60 * 60 * 1000);
    console.log(`  🏄 ${ptDay(start)} ${ptTime(start)}–${ptTime(end)} PT (${w.hours.length}h)`);
  }

  console.log("\n📨 Sending digest...");
  const message = formatDigest(windows);
  const subject = `🏄 Linda Mar: ${windows.length} sweet-spot window${windows.length === 1 ? "" : "s"} ahead`;
  await Promise.all([
    notifyEmail(subject, message),
    notifySlack(message),
    notifySMS(message),
  ]);
  console.log("✅ Digest sent.");
}

main().catch((err) => {
  console.error("Fatal error:", err.message);
  process.exit(1);
});
