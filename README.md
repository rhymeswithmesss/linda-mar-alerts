# 🏄 Linda Mar Sweet Spot Alerts

Notifies you when Linda Mar conditions match your personal sweet spot:
small (1–3ft), glassy (≤5 kts wind), low tide (-1 to +1 ft), with some shape (≥8s period).

Runs free on GitHub Actions — no server needed.

---

## Your Sweet Spot Criteria

| Condition | Your Target | Why |
|---|---|---|
| Surf height | 1–3 ft | Small & manageable |
| Wind | ≤ 5 kts | Glassy surface |
| Tide | -1.0 to +1.0 ft | Low tide window |
| Swell period | ≥ 8s | Enough shape to surf |

All four must pass for an alert to fire.

To adjust any threshold, edit the `criteria` block in `check-surf.js`.

---

## Setup (one-time, ~15 minutes)

### 1. Get a Stormglass API key (free)

1. Go to [stormglass.io](https://stormglass.io) and create a free account
2. The free tier gives you **10 API calls/day** — enough for 6 checks/day with headroom
3. Copy your API key from the dashboard

### 2. Fork or create this repo on GitHub

Push all files to a new GitHub repo (public or private both work).

```
linda-mar-alerts/
├── check-surf.js
├── README.md
└── .github/
    └── workflows/
        └── surf-alert.yml
```

### 3. Add your secrets to GitHub

In your repo → **Settings → Secrets and variables → Actions → New repository secret**

**Required:**
| Secret name | Value |
|---|---|
| `STORMGLASS_API_KEY` | Your Stormglass API key |

**Recommended — Email alert via [Resend](https://resend.com):**
| Secret name | Value |
|---|---|
| `RESEND_API_KEY` | Your Resend API key (free tier: 100 emails/day) |
| `EMAIL_TO` | The inbox to alert (e.g. `you@example.com`) |
| `EMAIL_FROM` | *(optional)* Sender. Defaults to `Surf Alerts <onboarding@resend.dev>`, which works with no domain setup. With no verified domain, Resend only delivers to your own account email. |

To get a Resend API key:
1. Sign up at [resend.com](https://resend.com) (free)
2. **API Keys** → **Create API Key** → copy it
3. You can send to your own signup email immediately with no domain verification

**Optional — Slack DM alert:**
| Secret name | Value |
|---|---|
| `SLACK_WEBHOOK_URL` | Your Slack Incoming Webhook URL |

To get a Slack webhook:
1. Go to [api.slack.com/apps](https://api.slack.com/apps) → Create New App → From scratch
2. Enable "Incoming Webhooks" → Add New Webhook to Workspace → pick your DM channel
3. Copy the webhook URL

**Optional — SMS alert via Twilio:**
| Secret name | Value |
|---|---|
| `TWILIO_ACCOUNT_SID` | From your Twilio Console dashboard |
| `TWILIO_AUTH_TOKEN` | From your Twilio Console dashboard |
| `TWILIO_FROM` | Your Twilio phone number (e.g. `+14155550100`) |
| `TWILIO_TO` | Your personal phone number (e.g. `+14155550101`) |

Twilio free trial gives you ~$15 credit — more than enough for months of alerts.

### 4. Test it manually

1. Go to your repo → **Actions** tab
2. Click **"Linda Mar Surf Alert"** workflow
3. Click **"Run workflow"** → **Run workflow**
4. Watch the logs — you'll see current conditions printed and whether they passed

### 5. You're live 🤙

The workflow runs automatically at:
- 5:30am, 6:00am, 6:30am, 7:00am, 7:30am, 8:00am PT daily

If conditions match, you get a Slack DM and/or SMS. If not, nothing happens.

---

## Adjusting Your Criteria

Edit the `criteria` block at the top of `check-surf.js`:

```js
criteria: {
  surfHeightMin_ft: 1.0,   // lower = catches smaller days
  surfHeightMax_ft: 3.0,   // raise if you want bigger days too
  windMax_kts: 5,           // raise to 8-10 for "mostly clean" vs "glassy only"
  tideMin_ft: -1.0,         // widen if you're flexible on tide
  tideMax_ft: 1.0,
  swellPeriodMin_s: 8,      // raise for more shape/power
},
```

## Adding More Check Times

Edit the `cron` schedule in `.github/workflows/surf-alert.yml`.
Note: GitHub Actions cron runs in UTC. PT = UTC-7 (PDT) or UTC-8 (PST).

```yaml
schedule:
  - cron: "0 16 * * *"   # 9:00am PT — add a mid-morning check
```

---

## How It Works

```
GitHub Actions (cron)
    ↓
check-surf.js
    ↓
Stormglass API → wave height, swell period, wind, tide
    ↓
Evaluate all 4 criteria
    ↓
All pass? → Slack DM + SMS
Not passing? → silent, nothing sent
```

Data source: [Stormglass.io](https://stormglass.io) marine forecast API, pulling from NOAA and Stormglass models for Linda Mar (lat: 37.5943, lng: -122.4998).
