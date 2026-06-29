/**
 * Linda Mar Surf Alert
 * Checks Stormglass API and notifies via Slack/SMS when conditions match your sweet spot.
 *
 * Sweet spot criteria (from your screenshot):
 *   - Surf height:  1–3 ft (small but rideable)
 *   - Wind speed:   ≤ 5 kts (glassy / light)
 *   - Tide height:  -1.0 ft to +1.0 ft (low tide window)
 *   - Primary swell period: ≥ 8s (some shape)
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
          reject(new Error(`Failed to parse response: ${data}`));
        }
      });
    }).on("error", reject);
  });
}

// ─── FETCH CONDITIONS ─────────────────────────────────────────────────────────

async function fetchConditions() {
  const { lat, lng } = CONFIG.location;
  const params = [
    "waveHeight",        // significant wave height (m)
    "wavePeriod",        // swell period (s)
    "waveDirection",     // swell direction (°)
    "windSpeed",         // wind speed (m/s)
    "windDirection",     // wind direction (°)
    "waterTemperature",  // water temp (°C)
  ].join(",");

  const now = new Date();
  const end = new Date(now.getTime() + 3 * 60 * 60 * 1000); // next 3 hours

  const url = `https://api.stormglass.io/v2/weather/point?lat=${lat}&lng=${lng}&params=${params}&start=${now.toISOString()}&end=${end.toISOString()}`;

  const [weatherData, tideData] = await Promise.all([
    fetchJson(url),
    fetchTide(lat, lng, now, end),
  ]);

  // Use the first hour's data point
  const hour = weatherData.hours?.[0];
  if (!hour) throw new Error("No weather data returned from Stormglass");

  // Stormglass returns values from multiple sources — prefer NOAA or sg (Stormglass model)
  const pick = (param) => {
    const sources = hour[param];
    if (!sources) return null;
    return (sources.noaa ?? sources.sg ?? sources.meteo ?? Object.values(sources)[0]);
  };

  return {
    timestamp: hour.time,
    waveHeight_ft: metersToFeet(pick("waveHeight") ?? 0),
    wavePeriod_s: pick("wavePeriod") ?? 0,
    waveDirection_deg: pick("waveDirection") ?? 0,
    windSpeed_kts: msToKnots(pick("windSpeed") ?? 0),
    windDirection_deg: pick("windDirection") ?? 0,
    tide_ft: tideData,
  };
}

async function fetchTide(lat, lng, start, end) {
  const url = `https://api.stormglass.io/v2/tide/extremes/point?lat=${lat}&lng=${lng}&start=${start.toISOString()}&end=${end.toISOString()}`;
  const data = await fetchJson(url);
  // Return current tide height from the nearest extreme, or use a sea-level estimate
  if (data.data && data.data.length > 0) {
    return metersToFeet(data.data[0].height ?? 0);
  }
  return 0; // fallback
}

// ─── EVALUATE CONDITIONS ──────────────────────────────────────────────────────

function evaluate(conditions) {
  const { criteria } = CONFIG;
  const checks = {
    surfHeight: conditions.waveHeight_ft >= criteria.surfHeightMin_ft &&
                conditions.waveHeight_ft <= criteria.surfHeightMax_ft,
    wind:       conditions.windSpeed_kts <= criteria.windMax_kts,
    tide:       conditions.tide_ft >= criteria.tideMin_ft &&
                conditions.tide_ft <= criteria.tideMax_ft,
    swellPeriod: conditions.wavePeriod_s >= criteria.swellPeriodMin_s,
  };

  const passed = Object.values(checks).every(Boolean);
  return { passed, checks };
}

// ─── FORMAT MESSAGE ───────────────────────────────────────────────────────────

function formatMessage(conditions, checks) {
  const { name } = CONFIG.location;
  const dir = degToCompass(conditions.waveDirection_deg);
  const windDir = degToCompass(conditions.windDirection_deg);

  const checkMark = (passed) => passed ? "✅" : "❌";

  return `
🏄 *Linda Mar Sweet Spot Alert!*

Conditions at *${name}* are matching your sweet spot right now:

${checkMark(checks.surfHeight)} *Surf:* ${conditions.waveHeight_ft.toFixed(1)} ft
${checkMark(checks.swellPeriod)} *Swell:* ${conditions.waveHeight_ft.toFixed(1)} ft @ ${conditions.wavePeriod_s.toFixed(0)}s ${dir}
${checkMark(checks.wind)} *Wind:* ${conditions.windSpeed_kts.toFixed(1)} kts ${windDir}
${checkMark(checks.tide)} *Tide:* ${conditions.tide_ft.toFixed(1)} ft

🕐 Checked at ${new Date(conditions.timestamp).toLocaleTimeString("en-US", { timeZone: "America/Los_Angeles" })} PT
🔗 https://www.surfline.com/surf-report/linda-mar-state-beach/5842041f4e65fad6a7708cdf
`.trim();
}

function degToCompass(deg) {
  const dirs = ["N","NNE","NE","ENE","E","ESE","SE","SSE","S","SSW","SW","WSW","W","WNW","NW","NNW"];
  return dirs[Math.round(deg / 22.5) % 16];
}

// ─── NOTIFY ───────────────────────────────────────────────────────────────────

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

async function notifyEmail(message) {
  if (!CONFIG.resendApiKey || !CONFIG.emailTo) return;
  const body = JSON.stringify({
    from: CONFIG.emailFrom,
    to: [CONFIG.emailTo],
    subject: "🏄 Linda Mar sweet spot is firing",
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

  console.log(`🌊 Checking conditions at ${CONFIG.location.name}...`);

  const conditions = await fetchConditions();
  const { passed, checks } = evaluate(conditions);

  console.log("\nCurrent conditions:");
  console.log(`  Surf:   ${conditions.waveHeight_ft.toFixed(1)} ft`);
  console.log(`  Swell:  ${conditions.wavePeriod_s.toFixed(0)}s @ ${degToCompass(conditions.waveDirection_deg)}`);
  console.log(`  Wind:   ${conditions.windSpeed_kts.toFixed(1)} kts ${degToCompass(conditions.windDirection_deg)}`);
  console.log(`  Tide:   ${conditions.tide_ft.toFixed(1)} ft`);
  console.log(`\nChecks: ${JSON.stringify(checks, null, 2)}`);

  if (passed) {
    console.log("\n🏄 Sweet spot conditions! Sending alerts...");
    const message = formatMessage(conditions, checks);
    await Promise.all([
      notifyEmail(message),
      notifySlack(message),
      notifySMS(message),
    ]);
    console.log("✅ Alerts sent.");
  } else {
    console.log("\n😐 Conditions don't match yet. No alert sent.");
  }
}

main().catch((err) => {
  console.error("Fatal error:", err.message);
  process.exit(1);
});
