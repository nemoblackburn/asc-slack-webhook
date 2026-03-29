# App Store Connect → Slack Notifications

Get beautiful, real-time Slack notifications when your iOS app moves through the App Store review process.

![Example notifications](https://github.com/nemoblackburn/asc-slack-webhook/assets/example.png)

## What You'll Get

| Event | Notification |
|-------|--------------|
| Build uploaded | 🛫 **MyApp v1.2.3 (456)** — Build available in TestFlight |
| Waiting for review | ⏳ **MyApp v1.2.3** — Waiting for review |
| In review | 🔍 **MyApp v1.2.3** — In review |
| Approved | 🎉 **MyApp v1.2.3 (456)** — Approved! Pending release 🟡 |
| Rejected | ❌ **MyApp v1.2.3** — Rejected |
| Live | ✅ **MyApp v1.2.3** — Ready for distribution |

## How It Works

```
App Store Connect → Cloudflare Worker → Slack
```

Apple sends webhook events whenever your app's status changes. This worker receives them, formats them nicely, and posts to your Slack channel.

## Setup (15 minutes)

### Prerequisites

- [Cloudflare account](https://dash.cloudflare.com/sign-up) (free)
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/install-and-update/) installed
- Slack workspace with permission to add apps
- App Store Connect access (Admin or App Manager role)

### Step 1: Deploy the Worker

```bash
# Clone this repo
git clone https://github.com/nemoblackburn/asc-slack-webhook.git
cd asc-slack-webhook

# Deploy to Cloudflare
npx wrangler deploy
```

You'll get a URL like `https://asc-slack-webhook.YOUR-SUBDOMAIN.workers.dev`

### Step 2: Create a Slack Webhook

1. Go to [Slack Apps](https://api.slack.com/apps) → Create New App → From scratch
2. Name it "App Store Updates" and select your workspace
3. Go to **Incoming Webhooks** → Activate → Add New Webhook
4. Choose the channel for notifications
5. Copy the webhook URL

### Step 3: Configure Secrets

```bash
# Slack webhook URL (from Step 2)
npx wrangler secret put SLACK_WEBHOOK_URL

# Paste your Slack webhook URL when prompted
```

### Step 4: Set Up App Store Connect Webhook

1. Go to [App Store Connect](https://appstoreconnect.apple.com) → Users and Access → Integrations
2. Click **App Store Connect API** → **Webhooks** tab
3. Click **+** to add a new webhook
4. Enter your worker URL from Step 1
5. Copy the **Shared Secret** shown

```bash
# Add the shared secret
npx wrangler secret put ASC_WEBHOOK_SECRET

# Paste the shared secret when prompted
```

### Step 5: Test It

Click **Send Test Notification** in App Store Connect. You should see:

> 🏓 **App Store Connect** — Webhook configured successfully

## Optional: Show Version Numbers

By default, Apple's webhooks don't include version numbers. To display them, add an App Store Connect API key:

### Create an API Key

1. In App Store Connect → Users and Access → Integrations → **App Store Connect API**
2. Click **+** next to "Active" to generate a new key
3. Name it "Slack Webhook" and give it **Developer** access
4. Download the `.p8` file and note the **Key ID**
5. Copy the **Issuer ID** shown at the top

### Add the Secrets

```bash
npx wrangler secret put ASC_KEY_ID
# Paste your Key ID (e.g., ABC123XYZ)

npx wrangler secret put ASC_ISSUER_ID
# Paste your Issuer ID (e.g., 12345678-1234-1234-1234-123456789012)

npx wrangler secret put ASC_API_KEY
# Paste the ENTIRE contents of your .p8 file, including the BEGIN/END lines
```

Now your notifications will include version and build numbers!

## Supported Events

- ✅ App version state changes (review status)
- ✅ Build upload status
- ✅ TestFlight beta status
- ✅ TestFlight feedback
- ✅ Webhook ping/test

Unknown events are displayed with their raw payload for debugging.

## Customization

Edit `src/index.js` to customize:

- **Emojis** — Change the emoji mappings in `getStateEmoji()`, `getUploadStateEmoji()`, etc.
- **Messages** — Modify the text in `humanizeState()`, `humanizeUploadState()`, etc.
- **App name** — Change the fallback app name (default: searches payload, falls back to "Unknown App")

## Troubleshooting

### Notifications not appearing

1. Check Cloudflare dashboard for worker errors
2. Verify the webhook URL in App Store Connect matches your worker URL
3. Test with the "Send Test Notification" button in ASC

### "Invalid signature" errors

The shared secret in your worker doesn't match App Store Connect. Re-copy it:

```bash
npx wrangler secret put ASC_WEBHOOK_SECRET
```

### Version numbers not showing

Make sure all three API key secrets are set correctly. The `.p8` key content must include the `-----BEGIN PRIVATE KEY-----` and `-----END PRIVATE KEY-----` lines.

## Contributing

PRs welcome! Some ideas:

- [ ] Support for more event types
- [ ] Custom Slack message formatting (blocks, buttons)
- [ ] Multiple Slack channels based on event type
- [ ] Discord/Teams support

## License

MIT — use it however you want.

---

Built with ☕ by [@nemoblackburn](https://github.com/nemoblackburn)
