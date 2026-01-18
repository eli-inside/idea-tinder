# Idea Tinder - Status Update

## ✅ Completed (January 17, 2026)

### Authentication System
- [x] Google OAuth integration
- [x] Email/password registration and login
- [x] Session management with 30-day expiry
- [x] Logout functionality

### Per-User Experience
- [x] Users table with email, password_hash, google_id, preferences
- [x] Swipes table linking users to their idea interactions
- [x] Each user sees only ideas they haven't swiped

### Privacy & Legal
- [x] Privacy policy page (`/privacy`)
- [x] Terms of service page (`/terms`)
- [x] About page (`/about`)
- [x] Copyright footer: © 2026 Sells Brothers Incorporated
- [x] Data export endpoint (`/api/export`)
- [x] Account deletion endpoint (`/api/delete-account`)
- [x] Data requests table for GDPR tracking

### News Ingestion
- [x] RSS feed aggregation script (`ingest.ts`)
- [x] Daily cron job at 8am
- [x] 8 feed sources configured (OpenAI, HuggingFace, Bun, Rust, GitHub, Vercel, Cloudflare, Chrome)
- [x] Deduplication by URL
- [x] 12 real news items ingested

### Deleted
- [x] Removed 3 fake sample items

---

## 🔲 Still Needed

### 1. Domain Registration (Requires Chris)
Potential available domains (no DNS records found):
- swipethis.app
- techswipe.app  
- ideacard.app
- swipetech.app
- ideapile.app
- dailyswipe.app
- techflick.app

**Note:** Cloudflare domain registration API is Enterprise-only. Chris needs to register manually via Cloudflare dashboard at https://domains.cloudflare.com/

Once registered:
1. Add DNS A record pointing to 144.126.145.59
2. Add Caddy config for new domain
3. Update Google OAuth redirect URI in Google Cloud Console

### 2. Personalization (Future)
- Track category preferences from swipe patterns
- Track keyword associations from liked items
- Rank queue by predicted interest
- Basic collaborative filtering

### 3. Additional Improvements
- Add more RSS feeds
- Consider Perplexity API for trending news search
- Mobile PWA manifest for "add to home screen"
- Push notifications for new items

---

## Questions for Chris

1. **Domain preference?** Any of the available .app domains work?
2. **Budget?** .app domains are ~$15-18/year on Cloudflare
3. **Google OAuth** - Currently using Eli's existing OAuth app. Want a separate one for production?
4. **Any specific news sources** to add?

