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

// ─── CONFIG ───────────────────────────────────────────────────────────────────

const CONFIG = {
  location: {
    name: "Linda Mar",
    lat: 37.5943,
    lng: -122.4998,
  },
  criteria: {
    surfHeightMin_ft: 1.0,   // minimum surf height in feet
    surfHeightMax_ft: 3.0,   // maximum surf height in feet
    windMax_kts: 5,           // max wind in knots (glassy threshold)
    tideMin_ft: -1.0,         // low tide window start
    tideMax_ft: 1.0,          // low tide window end
    swellPeriodMin_s: 8,      // minimum swell period for shape
  },
  forecastDays: 7,            // how far ahead to scan (Stormglass free tier returns ~7-10 days)
  daylightStartHour: 6,       // earliest hour to consider, PT (24h)
  daylightEndHour: 19,        // latest hour to consider, PT (24h)
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

  const [weatherData, tideByHour] = await Promise.all([
    fetchJson(weatherUrl),
    fetchTideSeries(lat, lng, now, end),
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
    const tide = tideByHour[key];
    return {
      timestamp: hour.time,
      date: new Date(hour.time),
      waveHeight_ft: metersToFeet(pick(hour.waveHeight) ?? 0),
      wavePeriod_s: pick(hour.wavePeriod) ?? 0,
      waveDirection_deg: pick(hour.waveDirection) ?? 0,
      windSpeed_kts: msToKnots(pick(hour.windSpeed) ?? 0),
      windDirection_deg: pick(hour.windDirection) ?? 0,
      tide_ft: tide ?? null,   // null = no tide reading for this hour
    };
  });
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
  const checks = {
    surfHeight: c.waveHeight_ft >= criteria.surfHeightMin_ft &&
                c.waveHeight_ft <= criteria.surfHeightMax_ft,
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

Upcoming windows at *${name}* matching your sweet spot (1–3ft, ≤5kt wind, -1 to +1ft tide, ≥8s period):

${body}

🔗 https://www.surfline.com/surf-report/linda-mar-state-beach/5842041f4e65fad6a7708cdf`;
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

  console.log(`Scanned ${forecast.length} forecast hours (${daylight.length} in daylight).`);
  console.log(`Found ${matches.length} matching hours across ${windows.length} window(s).`);

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
