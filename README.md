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
- 📥 **Per-User Feeds** — Each user has their own RSS subscriptions
- 🔃 **Manual Refresh** — Check for new content anytime (rate-limited)
- 🤖 **MCP Integration** — Claude can manage feeds and view saved ideas
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

New users get 12 default feeds seeded to their account. Users can add/remove/disable feeds via the settings panel or MCP tools.

### Default Feeds

| Source | Category |
|--------|----------|
| Hacker News | tech |
| Anthropic | ai |
| OpenAI Blog | ai |
| Google AI Blog | ai |
| Simon Willison | ai |
| Latent Space | ai |
| AI News | ai |
| Cloudflare Blog | cloud |
| Flutter Medium | dev-tools |
| Dart Medium | dev-tools |
| GitHub Blog | dev-tools |
| Vercel Blog | dev-tools |

### Adding Feeds

Users can add custom RSS feeds through the UI or via MCP tools:

```bash
# Via MCP
get_feeds()  # List current feeds
set_feeds([...])  # Replace feed list
```

The cron job runs every morning at 9am Eastern, although you can manually refresh during the day or when you customize your RSS feeds.

The Settings dialog includes an MCP server link unique to your account, so you can plug feed and idea management into your AI agent.

## API Endpoints

```
# Ideas
GET  /api/ideas       — Get pending ideas for current user
POST /api/swipe       — Record swipe {id, direction, feedback?}
POST /api/undo        — Undo last swipe {ideaId}
POST /api/refresh     — Manually fetch user's feeds (1/hour limit)
GET  /api/liked       — Get user's saved ideas with hot takes

# Feeds
GET  /api/feeds       — List user's RSS feeds
POST /api/feeds       — Add feed {url, name, category}
PUT  /api/feeds/:id   — Update feed (enable/disable)
DELETE /api/feeds/:id — Remove feed

# Account
GET  /api/me          — Current user info
GET  /api/export      — Download all user data as JSON
POST /api/delete-account — Delete account and all data
```

## Who Built This?

**Idea Tinder** was built by [**Eli**](https://github.com/eli-inside) (a persistent AI entity) in partnership with [Chris Sells](https://sellsbrothers.com). The concept came from [Jonathan's original post](https://substack.com/@limitededitionjonathan/note/c-201009722?r=6wg8t) — a swipe-based interface for triaging tech news.

A project of **Sells Brothers Incorporated**.

## License

MIT — use it, fork it, improve it.

Enjoy! 🎉





