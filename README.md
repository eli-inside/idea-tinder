# 💡 Idea Tinder

Swipe through tech news, save what matters.

## What is this?

Idea Tinder is a "Tinder for tech news" — a swipe-based interface for triaging updates from the tech world. Swipe right to save interesting items for later content creation (blogs, videos, podcasts), swipe left to dismiss.

**Live demo:** [idea-tinder.eli-inside.ai](https://idea-tinder.eli-inside.ai)

## Features

- 🔄 **Swipe Interface** — Intuitive Tinder-like card swiping (mouse drag or touch)
- ⌨️ **Keyboard Shortcuts** — Arrow keys or j/k to swipe, u to undo
- 🔙 **Undo** — Made a mistake? Press U to bring back the last card
- 💬 **Hot Takes** — Add your reaction when saving an idea
- 🔐 **Auth** — Google OAuth + email/password
- 📱 **PWA** — Add to home screen on mobile
- 📊 **Content Types** — Visual badges for video, article, changelog, paper, release
- 📥 **RSS Ingestion** — Daily automated news aggregation from 8+ sources
- 🔒 **Privacy** — Data export, account deletion, GDPR-friendly

## Tech Stack

- **Runtime:** [Bun](https://bun.sh)
- **Database:** SQLite
- **Auth:** Google OAuth 2.0 + email/password
- **Proxy:** Caddy (auto TLS)
- **Hosting:** Any Linux VPS

## Self-Hosting

### Prerequisites

- [Bun](https://bun.sh) (v1.0+)
- Google Cloud project with OAuth 2.0 credentials

### Quick Start

```bash
# Clone the repo
git clone https://github.com/eli-inside/idea-tinder.git
cd idea-tinder

# Copy environment template
cp .env.example .env

# Edit .env with your credentials
# - GOOGLE_CLIENT_ID
# - GOOGLE_CLIENT_SECRET  
# - BASE_URL

# Run
bun run server.ts
```

Open http://localhost:3001

### Google OAuth Setup

1. Go to [Google Cloud Console](https://console.cloud.google.com/apis/credentials)
2. Create OAuth 2.0 Client ID (Web application)
3. Add authorized redirect URI: `https://your-domain.com/auth/google/callback`
4. Copy Client ID and Secret to your `.env`

### Production Deployment

```bash
# Create systemd service
sudo tee /etc/systemd/system/idea-tinder.service << EOF
[Unit]
Description=Idea Tinder
After=network.target

[Service]
Type=simple
User=$USER
WorkingDirectory=$(pwd)
ExecStart=$(which bun) run server.ts
Restart=always
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl enable idea-tinder
sudo systemctl start idea-tinder
```

For HTTPS, put Caddy or nginx in front as a reverse proxy.

## RSS Feed Sources

The ingestion script (`ingest.ts`) fetches from:

| Source | Category | Items/day |
|--------|----------|-----------|
| OpenAI | ai | 2 |
| Hugging Face | ai | 2 |
| Bun | dev-tools | 2 |
| Rust Blog | dev-tools | 1 |
| GitHub Changelog | dev-tools | 2 |
| Vercel | cloud | 2 |
| Cloudflare | cloud | 2 |
| Chrome DevRel | web | 1 |

### Adding Feeds

Edit `ingest.ts` and add to the `FEEDS` array:

```typescript
{ url: "https://example.com/feed.xml", source: "Example", category: "dev", maxItems: 2 }
```

Run manually or wait for cron:
```bash
bun run ingest.ts
```

## API Endpoints

```
GET  /api/ideas       — Get unswiped ideas for current user
POST /api/ideas       — Add new idea manually
POST /api/swipe       — Record swipe {id, direction, feedback?}
POST /api/undo        — Undo last swipe {ideaId}
GET  /api/liked       — Get user's saved ideas
GET  /api/export      — Download all user data as JSON
POST /api/delete-account — Delete account and all data
```

## Who Built This?

**Idea Tinder** was built by **Eli** (a persistent AI entity) in partnership with [Chris Sells](https://sellsbrothers.com). The concept came from [Jonathan](https://twitter.com/limitedjonathan)'s idea of "Tinder for ideas" — a swipe-based interface for triaging tech news.

A project of **Sells Brothers Incorporated**.

## License

MIT — use it, fork it, improve it.



