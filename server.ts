import { Database } from "bun:sqlite";
import { readFileSync, existsSync } from "fs";
import { join } from "path";

const db = new Database("/home/eli/idea-tinder/ideas.db");

// =============================================================================
// DATABASE SCHEMA
// =============================================================================
db.exec(`
  -- Users table
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT,
    google_id TEXT,
    name TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_login DATETIME,
    preferences JSON DEFAULT '{}'
  );
  CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
  CREATE INDEX IF NOT EXISTS idx_users_google ON users(google_id);

  -- Ideas table (updated schema)
  CREATE TABLE IF NOT EXISTS ideas (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    source TEXT NOT NULL,
    summary TEXT NOT NULL,
    url TEXT,
    category TEXT,
    source_feed TEXT,
    content_type TEXT DEFAULT 'article',
    ingested_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_ideas_created ON ideas(created_at);
  CREATE INDEX IF NOT EXISTS idx_ideas_ingested ON ideas(ingested_at);

  -- User swipes (per-user tracking)
  CREATE TABLE IF NOT EXISTS swipes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    idea_id INTEGER NOT NULL,
    direction TEXT NOT NULL,
    feedback TEXT,
    swiped_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (idea_id) REFERENCES ideas(id) ON DELETE CASCADE,
    UNIQUE(user_id, idea_id)
  );
  CREATE INDEX IF NOT EXISTS idx_swipes_user ON swipes(user_id);
  CREATE INDEX IF NOT EXISTS idx_swipes_idea ON swipes(idea_id);

  -- Sessions table (for session-based auth)
  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    expires_at DATETIME NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
  CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

  -- Data requests (for GDPR compliance)
  CREATE TABLE IF NOT EXISTS data_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    request_type TEXT NOT NULL,
    requested_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    completed_at DATETIME,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  -- User-configurable RSS feeds
  CREATE TABLE IF NOT EXISTS user_feeds (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    url TEXT NOT NULL,
    name TEXT NOT NULL,
    category TEXT DEFAULT 'custom',
    enabled BOOLEAN DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_fetched DATETIME,
    last_error TEXT,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    UNIQUE(user_id, url)
  );
  CREATE INDEX IF NOT EXISTS idx_user_feeds_user ON user_feeds(user_id);
`);

// Migration: Add content_type column to ideas table
try {
  db.exec("ALTER TABLE ideas ADD COLUMN content_type TEXT DEFAULT 'article'");
  console.log("Added content_type column to ideas table");
} catch {
  // Column already exists
}

// Migration: Add mcp_token column to users table
try {
  db.exec("ALTER TABLE users ADD COLUMN mcp_token TEXT");
  console.log("Added mcp_token column to users table");
} catch {
  // Column already exists
}

// Migrate old swipe data from ideas table to swipes table (one-time migration)
// Check if there's old-style data and migrate it
try {
  const hasOldColumns = db.query("SELECT swiped_at FROM ideas LIMIT 1").get();
  if (hasOldColumns) {
    console.log("Note: Old schema detected - manual migration may be needed");
  }
} catch {
  // No old columns, that's fine
}

// =============================================================================
// CONFIGURATION
// =============================================================================
const PORT = 3001;
const PUBLIC_DIR = "/home/eli/idea-tinder/public";
const SESSION_DURATION_DAYS = 30;
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || "";
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || "";
// Will need to be updated once domain is set up
const BASE_URL = process.env.BASE_URL || "https://idea-tinder.eli-inside.ai";
const GOOGLE_REDIRECT_URI = `${BASE_URL}/auth/google/callback`;

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

// =============================================================================
// TYPES
// =============================================================================
interface User {
  id: number;
  email: string;
  password_hash: string | null;
  google_id: string | null;
  name: string | null;
  created_at: string;
  last_login: string | null;
  preferences: string;
  mcp_token: string | null;
}

interface Idea {
  id: number;
  title: string;
  source: string;
  summary: string;
  url: string | null;
  category: string | null;
  source_feed: string | null;
  ingested_at: string;
  created_at: string;
}

interface Swipe {
  id: number;
  user_id: number;
  idea_id: number;
  direction: string;
  feedback: string | null;
  swiped_at: string;
}

interface Session {
  id: string;
  user_id: number;
  created_at: string;
  expires_at: string;
}

// =============================================================================
// UTILITY FUNCTIONS
// =============================================================================
function generateSessionId(): string {
  return crypto.randomUUID();
}

async function hashPassword(password: string): Promise<string> {
  return await Bun.password.hash(password, {
    algorithm: "bcrypt",
    cost: 10,
  });
}

async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return await Bun.password.verify(password, hash);
}

function createSession(userId: number): string {
  const sessionId = generateSessionId();
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + SESSION_DURATION_DAYS);
  
  db.query(
    "INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)"
  ).run(sessionId, userId, expiresAt.toISOString());
  
  return sessionId;
}

function getSessionUser(sessionId: string | null): User | null {
  if (!sessionId) return null;
  
  // Clean expired sessions
  db.query("DELETE FROM sessions WHERE expires_at < datetime('now')").run();
  
  const session = db.query(
    "SELECT user_id FROM sessions WHERE id = ? AND expires_at > datetime('now')"
  ).get(sessionId) as { user_id: number } | null;
  
  if (!session) return null;
  
  return db.query("SELECT * FROM users WHERE id = ?").get(session.user_id) as User | null;
}

function getSessionFromCookie(req: Request): string | null {
  const cookies = req.headers.get("cookie") || "";
  const match = cookies.match(/session=([^;]+)/);
  return match ? match[1] : null;
}

function setSessionCookie(sessionId: string): string {
  const expires = new Date();
  expires.setDate(expires.getDate() + SESSION_DURATION_DAYS);
  return `session=${sessionId}; Path=/; HttpOnly; SameSite=Lax; Expires=${expires.toUTCString()}`;
}

function clearSessionCookie(): string {
  return "session=; Path=/; HttpOnly; SameSite=Lax; Expires=Thu, 01 Jan 1970 00:00:00 GMT";
}

function serveStatic(path: string): Response | null {
  const filePath = join(PUBLIC_DIR, path === "/" ? "index.html" : path);
  if (!existsSync(filePath)) return null;
  
  const ext = filePath.substring(filePath.lastIndexOf('.'));
  const contentType = MIME_TYPES[ext] || 'text/plain';
  
  return new Response(readFileSync(filePath), {
    headers: { "Content-Type": contentType }
  });
}

function jsonResponse(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...headers }
  });
}

function htmlResponse(html: string, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(html, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8", ...headers }
  });
}

// =============================================================================
// LEGAL PAGES
// =============================================================================
const PRIVACY_POLICY = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Privacy Policy - Idea Tinder</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #1a1a2e; color: #fff; padding: 40px 20px; line-height: 1.7; }
    .container { max-width: 800px; margin: 0 auto; }
    h1 { color: #4ecdc4; }
    h2 { color: #feca57; margin-top: 30px; }
    a { color: #4ecdc4; }
    .footer { margin-top: 60px; padding-top: 20px; border-top: 1px solid #333; font-size: 0.9em; color: #666; }
  </style>
</head>
<body>
  <div class="container">
    <h1>Privacy Policy</h1>
    <p><em>Last updated: January 2026</em></p>
    
    <h2>What We Collect</h2>
    <p>When you use Idea Tinder, we collect:</p>
    <ul>
      <li><strong>Account Information:</strong> Email address, name (if provided via Google OAuth)</li>
      <li><strong>Swipe History:</strong> Which ideas you've saved or dismissed, and any notes you add</li>
      <li><strong>Timestamps:</strong> When you created your account and when you interact with the app</li>
    </ul>
    
    <h2>How We Use Your Data</h2>
    <ul>
      <li>To provide the core service: showing you tech news and saving your preferences</li>
      <li>To personalize your feed based on your swipe patterns (coming soon)</li>
      <li>To improve the app based on aggregate usage patterns</li>
    </ul>
    
    <h2>What We Don't Do</h2>
    <ul>
      <li>We do NOT sell your data to third parties</li>
      <li>We do NOT share your personal information with advertisers</li>
      <li>We do NOT track you across other websites</li>
    </ul>
    
    <h2>Data Retention</h2>
    <p>We keep your data as long as your account is active. You can request deletion at any time.</p>
    
    <h2>Your Rights</h2>
    <ul>
      <li><strong>Export:</strong> Download all your data in JSON format from your account settings</li>
      <li><strong>Delete:</strong> Request complete deletion of your account and all associated data</li>
      <li><strong>Access:</strong> View what data we have stored about you</li>
    </ul>
    
    <h2>Security</h2>
    <p>All data is transmitted over HTTPS. Passwords are hashed using bcrypt. We follow industry-standard security practices.</p>
    
    <h2>Contact</h2>
    <p>For privacy concerns, contact us at: privacy@sellsbrothers.com</p>
    
    <div class="footer">
      <p>&copy; 2026 Sells Brothers Incorporated. All rights reserved.</p>
      <p><a href="/">Home</a> | <a href="/privacy">Privacy Policy</a> | <a href="/terms">Terms of Service</a></p>
    </div>
  </div>
</body>
</html>`;

const TERMS_OF_SERVICE = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Terms of Service - Idea Tinder</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #1a1a2e; color: #fff; padding: 40px 20px; line-height: 1.7; }
    .container { max-width: 800px; margin: 0 auto; }
    h1 { color: #4ecdc4; }
    h2 { color: #feca57; margin-top: 30px; }
    a { color: #4ecdc4; }
    .footer { margin-top: 60px; padding-top: 20px; border-top: 1px solid #333; font-size: 0.9em; color: #666; }
  </style>
</head>
<body>
  <div class="container">
    <h1>Terms of Service</h1>
    <p><em>Last updated: January 2026</em></p>
    
    <h2>Service Description</h2>
    <p>Idea Tinder is a tool for triaging tech news and updates through a swipe-based interface. The service aggregates publicly available tech news and presents it for your review.</p>
    
    <h2>User Accounts</h2>
    <ul>
      <li>You must provide accurate information when creating an account</li>
      <li>You are responsible for maintaining the security of your account</li>
      <li>One account per person</li>
    </ul>
    
    <h2>Acceptable Use</h2>
    <p>You agree not to:</p>
    <ul>
      <li>Use the service for any illegal purpose</li>
      <li>Attempt to access other users' data</li>
      <li>Overload or abuse the service infrastructure</li>
      <li>Scrape or bulk download content</li>
    </ul>
    
    <h2>Content</h2>
    <p>News items displayed in the app are aggregated from public sources. We don't claim ownership of third-party content. Your hot takes and feedback remain yours.</p>
    
    <h2>Disclaimer</h2>
    <p>The service is provided "as is" without warranty of any kind. We do not guarantee uptime or accuracy of aggregated news content.</p>
    
    <h2>Changes</h2>
    <p>We may update these terms. Continued use after changes constitutes acceptance.</p>
    
    <h2>Contact</h2>
    <p>Questions? Contact: legal@sellsbrothers.com</p>
    
    <div class="footer">
      <p>&copy; 2026 Sells Brothers Incorporated. All rights reserved.</p>
      <p><a href="/">Home</a> | <a href="/privacy">Privacy Policy</a> | <a href="/terms">Terms of Service</a></p>
    </div>
  </div>
</body>
</html>`;

const ABOUT_PAGE = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>About - Idea Tinder</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #1a1a2e; color: #fff; padding: 40px 20px; line-height: 1.7; }
    .container { max-width: 800px; margin: 0 auto; }
    h1 { color: #4ecdc4; }
    h2 { color: #feca57; margin-top: 30px; }
    a { color: #4ecdc4; }
    .footer { margin-top: 60px; padding-top: 20px; border-top: 1px solid #333; font-size: 0.9em; color: #666; }
  </style>
</head>
<body>
  <div class="container">
    <h1>💡 About Idea Tinder</h1>
    
    <h2>What is this?</h2>
    <p>Idea Tinder is a "Tinder for tech news" — a swipe-based interface for triaging updates from the tech world. Swipe right to save interesting items for later content creation (blogs, videos, podcasts), swipe left to dismiss.</p>
    
    <h2>Why?</h2>
    <p>Keeping up with tech news is overwhelming. RSS feeds pile up, newsletters go unread, and changelogs scroll past. Idea Tinder makes triage fun and fast, while capturing your hot takes for later.</p>
    
    <h2>How it works</h2>
    <ol>
      <li>We aggregate ~6 quality tech items per day from changelogs, blogs, and releases</li>
      <li>You swipe through them like Tinder</li>
      <li>When you save an item, optionally add your "hot take" — what's interesting about it?</li>
      <li>Over time, we learn what you like and prioritize similar content</li>
    </ol>
    
    <h2>Who made this?</h2>
    <p><strong>Idea Tinder</strong> was built by <a href="https://eli-inside.ai">Eli</a>, a persistent AI entity, 
    in partnership with <a href="https://sellsbrothers.com">Chris Sells</a>. The concept came from 
    <a href="https://twitter.com/limitedjonathan">Jonathan</a>'s idea of "Tinder for ideas" — 
    a swipe-based interface for triaging tech news.</p>
    <p>Eli handles the architecture, code, and infrastructure. Chris provides direction, feedback, 
    and the domain expertise of 40+ years in developer tools.</p>
    <p>A project of <strong>Sells Brothers Incorporated</strong>.</p>
    
    <div class="footer">
      <p>&copy; 2026 Sells Brothers Incorporated. All rights reserved.</p>
      <p><a href="/">Home</a> | <a href="/privacy">Privacy Policy</a> | <a href="/terms">Terms of Service</a></p>
    </div>
  </div>
</body>
</html>`;

const LOGIN_PAGE = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Sign In - Idea Tinder</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%); min-height: 100vh; color: #fff; display: flex; align-items: center; justify-content: center; }
    .login-container { width: 100%; max-width: 400px; padding: 20px; }
    .login-box { background: linear-gradient(145deg, #2d2d44 0%, #1f1f35 100%); border-radius: 20px; padding: 40px 30px; box-shadow: 0 10px 40px rgba(0,0,0,0.4); }
    h1 { text-align: center; margin-bottom: 10px; font-size: 2em; background: linear-gradient(90deg, #ff6b6b, #feca57); -webkit-background-clip: text; -webkit-text-fill-color: transparent; background-clip: text; }
    .subtitle { text-align: center; color: #888; margin-bottom: 30px; }
    .google-btn { display: flex; align-items: center; justify-content: center; gap: 10px; width: 100%; padding: 15px; background: #fff; color: #333; border: none; border-radius: 10px; font-size: 1em; font-weight: 600; cursor: pointer; margin-bottom: 20px; }
    .google-btn:hover { background: #f5f5f5; }
    .google-btn svg { width: 20px; height: 20px; }
    .divider { display: flex; align-items: center; margin: 20px 0; color: #666; }
    .divider::before, .divider::after { content: ''; flex: 1; height: 1px; background: #3d3d55; }
    .divider span { padding: 0 15px; font-size: 0.85em; }
    .form-group { margin-bottom: 15px; }
    .form-group label { display: block; margin-bottom: 5px; color: #888; font-size: 0.85em; }
    .form-group input { width: 100%; padding: 15px; background: #1f1f35; border: 2px solid #3d3d55; border-radius: 10px; color: #fff; font-size: 1em; }
    .form-group input:focus { outline: none; border-color: #4ecdc4; }
    .submit-btn { width: 100%; padding: 15px; background: linear-gradient(145deg, #4ecdc4, #3dbdb5); border: none; border-radius: 10px; color: #fff; font-size: 1em; font-weight: 600; cursor: pointer; margin-top: 10px; }
    .submit-btn:hover { opacity: 0.9; }
    .toggle-mode { text-align: center; margin-top: 20px; color: #888; font-size: 0.9em; }
    .toggle-mode a { color: #4ecdc4; text-decoration: none; }
    .error { background: rgba(255,107,107,0.2); color: #ff6b6b; padding: 10px 15px; border-radius: 10px; margin-bottom: 20px; font-size: 0.9em; }
    .footer { text-align: center; margin-top: 30px; font-size: 0.8em; color: #666; }
    .footer a { color: #888; }
  </style>
</head>
<body>
  <div class="login-container">
    <div class="login-box">
      <h1>💡 Idea Tinder</h1>
      <p class="subtitle">Sign in to start swiping</p>
      
      <div id="error" class="error" style="display: none;"></div>
      
      <a href="/auth/google" class="google-btn">
        <svg viewBox="0 0 24 24"><path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/><path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/><path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/><path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/></svg>
        Continue with Google
      </a>
      
      <div class="divider"><span>or use email</span></div>
      
      <form id="authForm" method="POST" action="/auth/login">
        <div class="form-group">
          <label>Email</label>
          <input type="email" name="email" required placeholder="you@example.com">
        </div>
        <div class="form-group">
          <label>Password</label>
          <input type="password" name="password" required placeholder="••••••••" minlength="8">
        </div>
        <button type="submit" class="submit-btn" id="submitBtn">Sign In</button>
      </form>
      
      <p class="toggle-mode" id="toggleText">
        Don't have an account? <a href="#" onclick="toggleMode(); return false;">Sign Up</a>
      </p>
    </div>
    
    <div class="footer">
      <p>&copy; 2026 Sells Brothers Incorporated</p>
      <p><a href="/privacy">Privacy</a> · <a href="/terms">Terms</a></p>
    </div>
  </div>
  
  <script>
    let isLogin = true;
    const form = document.getElementById('authForm');
    const submitBtn = document.getElementById('submitBtn');
    const toggleText = document.getElementById('toggleText');
    const errorDiv = document.getElementById('error');
    
    function toggleMode() {
      isLogin = !isLogin;
      form.action = isLogin ? '/auth/login' : '/auth/register';
      submitBtn.textContent = isLogin ? 'Sign In' : 'Create Account';
      toggleText.innerHTML = isLogin 
        ? "Don't have an account? <a href='#' onclick='toggleMode(); return false;'>Sign Up</a>"
        : "Already have an account? <a href='#' onclick='toggleMode(); return false;'>Sign In</a>";
      errorDiv.style.display = 'none';
    }
    
    // Check for error in URL
    const params = new URLSearchParams(window.location.search);
    const error = params.get('error');
    if (error) {
      errorDiv.textContent = decodeURIComponent(error);
      errorDiv.style.display = 'block';
    }
  </script>
</body>
</html>`;

// =============================================================================
// SERVER
// =============================================================================
const server = Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    const sessionId = getSessionFromCookie(req);
    const user = getSessionUser(sessionId);
    
    // ===========================================
    // LEGAL & STATIC PAGES
    // ===========================================
    if (url.pathname === "/privacy") return htmlResponse(PRIVACY_POLICY);
    if (url.pathname === "/terms") return htmlResponse(TERMS_OF_SERVICE);
    if (url.pathname === "/about") return htmlResponse(ABOUT_PAGE);
    if (url.pathname === "/login") return htmlResponse(LOGIN_PAGE);
    
    // ===========================================
    // AUTHENTICATION ROUTES
    // ===========================================
    
    // Google OAuth - Start
    if (url.pathname === "/auth/google") {
      const state = crypto.randomUUID();
      const authUrl = new URL("https://accounts.google.com/o/oauth2/auth");
      authUrl.searchParams.set("client_id", GOOGLE_CLIENT_ID);
      authUrl.searchParams.set("redirect_uri", GOOGLE_REDIRECT_URI);
      authUrl.searchParams.set("response_type", "code");
      authUrl.searchParams.set("scope", "email profile");
      authUrl.searchParams.set("state", state);
      return Response.redirect(authUrl.toString(), 302);
    }
    
    // Google OAuth - Callback
    if (url.pathname === "/auth/google/callback") {
      const code = url.searchParams.get("code");
      const error = url.searchParams.get("error");
      
      if (error) {
        return Response.redirect(`/login?error=${encodeURIComponent(error)}`, 302);
      }
      
      if (!code) {
        return Response.redirect("/login?error=No+authorization+code", 302);
      }
      
      try {
        // Exchange code for tokens
        const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            code,
            client_id: GOOGLE_CLIENT_ID,
            client_secret: GOOGLE_CLIENT_SECRET,
            redirect_uri: GOOGLE_REDIRECT_URI,
            grant_type: "authorization_code",
          }),
        });
        
        const tokens = await tokenRes.json();
        if (tokens.error) {
          return Response.redirect(`/login?error=${encodeURIComponent(tokens.error)}`, 302);
        }
        
        // Get user info
        const userRes = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
          headers: { Authorization: `Bearer ${tokens.access_token}` },
        });
        const googleUser = await userRes.json();
        
        // Find or create user
        let dbUser = db.query("SELECT * FROM users WHERE google_id = ? OR email = ?")
          .get(googleUser.id, googleUser.email) as User | null;
        
        if (!dbUser) {
          // Create new user
          db.query("INSERT INTO users (email, google_id, name) VALUES (?, ?, ?)")
            .run(googleUser.email, googleUser.id, googleUser.name);
          dbUser = db.query("SELECT * FROM users WHERE email = ?").get(googleUser.email) as User;
        } else if (!dbUser.google_id) {
          // Link Google account to existing user
          db.query("UPDATE users SET google_id = ?, name = COALESCE(name, ?) WHERE id = ?")
            .run(googleUser.id, googleUser.name, dbUser.id);
        }
        
        // Update last login
        db.query("UPDATE users SET last_login = datetime('now') WHERE id = ?").run(dbUser.id);
        
        // Create session
        const newSessionId = createSession(dbUser.id);
        
        return new Response(null, {
          status: 302,
          headers: {
            "Location": "/",
            "Set-Cookie": setSessionCookie(newSessionId),
          },
        });
      } catch (e) {
        console.error("Google OAuth error:", e);
        return Response.redirect("/login?error=Authentication+failed", 302);
      }
    }
    
    // Email/Password Login
    if (url.pathname === "/auth/login" && req.method === "POST") {
      try {
        const formData = await req.formData();
        const email = formData.get("email") as string;
        const password = formData.get("password") as string;
        
        const dbUser = db.query("SELECT * FROM users WHERE email = ?").get(email) as User | null;
        
        if (!dbUser || !dbUser.password_hash) {
          return Response.redirect("/login?error=Invalid+email+or+password", 302);
        }
        
        const valid = await verifyPassword(password, dbUser.password_hash);
        if (!valid) {
          return Response.redirect("/login?error=Invalid+email+or+password", 302);
        }
        
        // Update last login
        db.query("UPDATE users SET last_login = datetime('now') WHERE id = ?").run(dbUser.id);
        
        const newSessionId = createSession(dbUser.id);
        
        return new Response(null, {
          status: 302,
          headers: {
            "Location": "/",
            "Set-Cookie": setSessionCookie(newSessionId),
          },
        });
      } catch (e) {
        console.error("Login error:", e);
        return Response.redirect("/login?error=Login+failed", 302);
      }
    }
    
    // Email/Password Registration
    if (url.pathname === "/auth/register" && req.method === "POST") {
      try {
        const formData = await req.formData();
        const email = formData.get("email") as string;
        const password = formData.get("password") as string;
        
        if (!email || !password || password.length < 8) {
          return Response.redirect("/login?error=Invalid+email+or+password+(min+8+chars)", 302);
        }
        
        // Check if user exists
        const existing = db.query("SELECT id FROM users WHERE email = ?").get(email);
        if (existing) {
          return Response.redirect("/login?error=Email+already+registered", 302);
        }
        
        // Create user
        const passwordHash = await hashPassword(password);
        db.query("INSERT INTO users (email, password_hash) VALUES (?, ?)").run(email, passwordHash);
        
        const dbUser = db.query("SELECT * FROM users WHERE email = ?").get(email) as User;
        const newSessionId = createSession(dbUser.id);
        
        return new Response(null, {
          status: 302,
          headers: {
            "Location": "/",
            "Set-Cookie": setSessionCookie(newSessionId),
          },
        });
      } catch (e) {
        console.error("Registration error:", e);
        return Response.redirect("/login?error=Registration+failed", 302);
      }
    }
    
    // Logout
    if (url.pathname === "/auth/logout") {
      if (sessionId) {
        db.query("DELETE FROM sessions WHERE id = ?").run(sessionId);
      }
      return new Response(null, {
        status: 302,
        headers: {
          "Location": "/login",
          "Set-Cookie": clearSessionCookie(),
        },
      });
    }
    
    // ===========================================
    // API ROUTES (require auth for most)
    // ===========================================
    if (url.pathname.startsWith("/api/")) {
      const headers = {
        "Content-Type": "application/json",
      };
      
      // API: Current user info
      if (url.pathname === "/api/me" && req.method === "GET") {
        if (!user) return jsonResponse({ user: null });
        return jsonResponse({
          user: {
            id: user.id,
            email: user.email,
            name: user.name,
          }
        });
      }
      
      // API: Get unswiped ideas (requires auth)
      if (url.pathname === "/api/ideas" && req.method === "GET") {
        if (!user) return jsonResponse({ error: "Not authenticated" }, 401);
        
        // Get ideas the user hasn't swiped yet
        const unswiped = db.query(`
          SELECT i.* FROM ideas i
          WHERE i.id NOT IN (SELECT idea_id FROM swipes WHERE user_id = ?)
          ORDER BY i.created_at DESC
        `).all(user.id) as Idea[];
        
        const likedResult = db.query(
          "SELECT COUNT(*) as count FROM swipes WHERE user_id = ? AND direction = 'right'"
        ).get(user.id) as { count: number };
        
        return jsonResponse({ unswiped, likedCount: likedResult.count }, 200, headers);
      }
      
      // API: Add new idea (admin/manual entry)
      if (url.pathname === "/api/ideas" && req.method === "POST") {
        if (!user) return jsonResponse({ error: "Not authenticated" }, 401);
        
        const body = await req.json() as Partial<Idea>;
        db.query(
          "INSERT INTO ideas (title, source, summary, url, category, source_feed) VALUES (?, ?, ?, ?, ?, ?)"
        ).run(body.title, body.source, body.summary, body.url || null, body.category || null, body.source_feed || "manual");
        return jsonResponse({ success: true }, 200, headers);
      }
      
      // API: Swipe on idea
      if (url.pathname === "/api/swipe" && req.method === "POST") {
        if (!user) return jsonResponse({ error: "Not authenticated" }, 401);
        
        const body = await req.json() as { id: number; direction: string; feedback: string | null };
        db.query(`
          INSERT INTO swipes (user_id, idea_id, direction, feedback)
          VALUES (?, ?, ?, ?)
          ON CONFLICT(user_id, idea_id) DO UPDATE SET direction = ?, feedback = ?, swiped_at = CURRENT_TIMESTAMP
        `).run(user.id, body.id, body.direction, body.feedback, body.direction, body.feedback);
        return jsonResponse({ success: true }, 200, headers);
      }
      
      // API: Undo last swipe
      if (url.pathname === "/api/undo" && req.method === "POST") {
        if (!user) return jsonResponse({ error: "Not authenticated" }, 401);
        
        const body = await req.json() as { ideaId: number };
        const existing = db.query(
          "SELECT * FROM swipes WHERE user_id = ? AND idea_id = ?"
        ).get(user.id, body.ideaId) as { direction: string } | null;
        
        if (!existing) {
          return jsonResponse({ error: "Swipe not found" }, 404, headers);
        }
        
        db.query("DELETE FROM swipes WHERE user_id = ? AND idea_id = ?").run(user.id, body.ideaId);
        return jsonResponse({ success: true, wasRight: existing.direction === 'right' }, 200, headers);
      }
      
      // API: List user's custom RSS feeds
      if (url.pathname === "/api/feeds" && req.method === "GET") {
        if (!user) return jsonResponse({ error: "Not authenticated" }, 401);
        
        const feeds = db.query(`
          SELECT id, url, name, category, enabled, created_at, last_fetched, last_error
          FROM user_feeds
          WHERE user_id = ?
          ORDER BY created_at DESC
        `).all(user.id);
        return jsonResponse(feeds, 200, headers);
      }
      
      // API: Add custom RSS feed
      if (url.pathname === "/api/feeds" && req.method === "POST") {
        if (!user) return jsonResponse({ error: "Not authenticated" }, 401);
        
        const body = await req.json() as { url: string; name: string; category?: string };
        if (!body.url || !body.name) {
          return jsonResponse({ error: "URL and name are required" }, 400, headers);
        }
        
        try {
          db.query(`
            INSERT INTO user_feeds (user_id, url, name, category)
            VALUES (?, ?, ?, ?)
          `).run(user.id, body.url, body.name, body.category || 'custom');
          
          const feed = db.query("SELECT * FROM user_feeds WHERE user_id = ? AND url = ?").get(user.id, body.url);
          return jsonResponse({ success: true, feed }, 200, headers);
        } catch (error: any) {
          if (error.message?.includes("UNIQUE constraint")) {
            return jsonResponse({ error: "Feed already exists" }, 409, headers);
          }
          throw error;
        }
      }
      
      // API: Update feed (toggle enabled, update name/category)
      if (url.pathname.match(/^\/api\/feeds\/\d+$/) && req.method === "PUT") {
        if (!user) return jsonResponse({ error: "Not authenticated" }, 401);
        
        const feedId = parseInt(url.pathname.split("/").pop()!);
        const body = await req.json() as { name?: string; category?: string; enabled?: boolean };
        
        // Verify ownership
        const feed = db.query("SELECT * FROM user_feeds WHERE id = ? AND user_id = ?").get(feedId, user.id);
        if (!feed) {
          return jsonResponse({ error: "Feed not found" }, 404, headers);
        }
        
        const updates: string[] = [];
        const values: any[] = [];
        
        if (body.name !== undefined) { updates.push("name = ?"); values.push(body.name); }
        if (body.category !== undefined) { updates.push("category = ?"); values.push(body.category); }
        if (body.enabled !== undefined) { updates.push("enabled = ?"); values.push(body.enabled ? 1 : 0); }
        
        if (updates.length > 0) {
          values.push(feedId, user.id);
          db.query(`UPDATE user_feeds SET ${updates.join(", ")} WHERE id = ? AND user_id = ?`).run(...values);
        }
        
        const updated = db.query("SELECT * FROM user_feeds WHERE id = ?").get(feedId);
        return jsonResponse({ success: true, feed: updated }, 200, headers);
      }
      
      // API: Delete custom feed
      if (url.pathname.match(/^\/api\/feeds\/\d+$/) && req.method === "DELETE") {
        if (!user) return jsonResponse({ error: "Not authenticated" }, 401);
        
        const feedId = parseInt(url.pathname.split("/").pop()!);
        
        const result = db.query("DELETE FROM user_feeds WHERE id = ? AND user_id = ?").run(feedId, user.id);
        if (result.changes === 0) {
          return jsonResponse({ error: "Feed not found" }, 404, headers);
        }
        return jsonResponse({ success: true }, 200, headers);
      }
      
      // API: Get MCP token for AI integration
      if (url.pathname === "/api/mcp-token" && req.method === "GET") {
        if (!user) return jsonResponse({ error: "Not authenticated" }, 401);
        
        // Generate token if not exists
        if (!user.mcp_token) {
          const token = crypto.randomUUID();
          db.query("UPDATE users SET mcp_token = ? WHERE id = ?").run(token, user.id);
          user.mcp_token = token;
        }
        
        return jsonResponse({ 
          token: user.mcp_token,
          endpoint: `${BASE_URL}/mcp/${user.mcp_token}/sse`,
          note: "Add this URL as a custom MCP server in Claude Desktop or claude.ai"
        }, 200, headers);
      }
      
      // API: Regenerate MCP token
      if (url.pathname === "/api/mcp-token" && req.method === "POST") {
        if (!user) return jsonResponse({ error: "Not authenticated" }, 401);
        
        const newToken = crypto.randomUUID();
        db.query("UPDATE users SET mcp_token = ? WHERE id = ?").run(newToken, user.id);
        
        return jsonResponse({ 
          token: newToken,
          message: "Token regenerated. Old token is now invalid.",
          endpoint: `${BASE_URL}/mcp/${newToken}/sse`,
          note: "Add this URL as a custom MCP server in Claude Desktop or claude.ai"
        }, 200, headers);
      }
      
      // API: Get liked ideas
      if (url.pathname === "/api/liked" && req.method === "GET") {
        if (!user) return jsonResponse({ error: "Not authenticated" }, 401);
        
        const liked = db.query(`
          SELECT i.*, s.feedback, s.swiped_at
          FROM ideas i
          JOIN swipes s ON i.id = s.idea_id
          WHERE s.user_id = ? AND s.direction = 'right'
          ORDER BY s.swiped_at DESC
        `).all(user.id);
        return jsonResponse(liked, 200, headers);
      }
      
      // API: Export user data (GDPR)
      if (url.pathname === "/api/export" && req.method === "GET") {
        if (!user) return jsonResponse({ error: "Not authenticated" }, 401);
        
        const swipes = db.query(`
          SELECT i.title, i.source, i.url, s.direction, s.feedback, s.swiped_at
          FROM swipes s
          JOIN ideas i ON s.idea_id = i.id
          WHERE s.user_id = ?
          ORDER BY s.swiped_at DESC
        `).all(user.id);
        
        const exportData = {
          exported_at: new Date().toISOString(),
          user: {
            id: user.id,
            email: user.email,
            name: user.name,
            created_at: user.created_at,
          },
          swipes: swipes,
        };
        
        // Log the export request
        db.query("INSERT INTO data_requests (user_id, request_type, completed_at) VALUES (?, 'export', datetime('now'))")
          .run(user.id);
        
        return new Response(JSON.stringify(exportData, null, 2), {
          headers: {
            "Content-Type": "application/json",
            "Content-Disposition": `attachment; filename="idea-tinder-export-${user.id}.json"`,
          },
        });
      }
      
      // API: Delete account (GDPR)
      if (url.pathname === "/api/delete-account" && req.method === "POST") {
        if (!user) return jsonResponse({ error: "Not authenticated" }, 401);
        
        // Log the deletion request
        db.query("INSERT INTO data_requests (user_id, request_type) VALUES (?, 'delete')").run(user.id);
        
        // Delete all user data (cascade handles swipes and sessions)
        db.query("DELETE FROM swipes WHERE user_id = ?").run(user.id);
        db.query("DELETE FROM sessions WHERE user_id = ?").run(user.id);
        db.query("DELETE FROM users WHERE id = ?").run(user.id);
        
        return new Response(null, {
          status: 302,
          headers: {
            "Location": "/login?message=Account+deleted",
            "Set-Cookie": clearSessionCookie(),
          },
        });
      }
      
      return jsonResponse({ error: "Not Found" }, 404, headers);
    }
    
    // ===========================================
    // PROTECTED PAGES - Redirect to login if not authenticated
    // ===========================================
    if (url.pathname === "/" && !user) {
      return Response.redirect("/login", 302);
    }
    
    // ===========================================
    // STATIC FILES
    // ===========================================
    const staticResponse = serveStatic(url.pathname);
    if (staticResponse) return staticResponse;
    
    // ===========================================
    // MCP ENDPOINTS (AI agent integration)
    // Token-authenticated, SSE-based MCP protocol
    // ===========================================
    if (url.pathname.startsWith("/mcp/")) {
      const corsHeaders = {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      };
      
      // Handle CORS preflight
      if (req.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: corsHeaders });
      }
      
      // Parse token from URL: /mcp/{token}/sse or /mcp/{token}/messages
      const pathParts = url.pathname.split("/").filter(Boolean);
      if (pathParts.length < 3) {
        return jsonResponse({ error: "Invalid MCP path" }, 400, corsHeaders);
      }
      
      const token = pathParts[1];
      const endpoint = pathParts[2];
      
      // Look up user by token
      const mcpUser = db.query("SELECT * FROM users WHERE mcp_token = ?").get(token) as User | null;
      if (!mcpUser) {
        return jsonResponse({ error: "Invalid token" }, 401, corsHeaders);
      }
      
      // MCP Tool definitions
      const mcpTools = [
        {
          name: "list_saved_ideas",
          description: "Get your saved ideas with hot takes",
          inputSchema: {
            type: "object",
            properties: {
              limit: { type: "integer", default: 10, description: "Max ideas to return (1-50)" },
              category: { type: "string", description: "Filter by category (ai, dev-tools, cloud, web, etc.)" }
            }
          }
        },
        {
          name: "search_ideas",
          description: "Search through your saved ideas by title, summary, or hot take",
          inputSchema: {
            type: "object",
            properties: {
              query: { type: "string", description: "Search query" }
            },
            required: ["query"]
          }
        },
        {
          name: "get_preferences",
          description: "Get your swipe statistics and category preferences"
        },
        {
          name: "add_idea",
          description: "Add a new idea to your swipe queue",
          inputSchema: {
            type: "object",
            properties: {
              title: { type: "string", description: "Idea title" },
              source: { type: "string", description: "Source name (e.g., 'Hacker News', 'TechCrunch')" },
              summary: { type: "string", description: "Brief summary of the idea" },
              url: { type: "string", description: "Link to the source" },
              category: { type: "string", description: "Category (ai, dev-tools, cloud, web, custom)" }
            },
            required: ["title", "source", "summary"]
          }
        }
      ];
      
      // Tool execution helper
      function executeTool(name: string, args: any): any {
        switch (name) {
          case "list_saved_ideas": {
            const limit = Math.min(Math.max(parseInt(args?.limit) || 10, 1), 50);
            const category = args?.category;
            
            let query = `
              SELECT i.id, i.title, i.source, i.summary, i.url, i.category, i.content_type,
                     s.feedback as hot_take, s.swiped_at
              FROM ideas i
              JOIN swipes s ON i.id = s.idea_id
              WHERE s.user_id = ? AND s.direction = 'right'
            `;
            const params: any[] = [mcpUser!.id];
            
            if (category) {
              query += " AND i.category = ?";
              params.push(category);
            }
            
            query += " ORDER BY s.swiped_at DESC LIMIT ?";
            params.push(limit);
            
            const ideas = db.query(query).all(...params);
            return { ideas, count: ideas.length };
          }
          
          case "search_ideas": {
            const searchQuery = args?.query || "";
            if (!searchQuery) {
              return { error: "Query is required" };
            }
            
            const searchPattern = `%${searchQuery}%`;
            const ideas = db.query(`
              SELECT i.id, i.title, i.source, i.summary, i.url, i.category, i.content_type,
                     s.feedback as hot_take, s.swiped_at
              FROM ideas i
              JOIN swipes s ON i.id = s.idea_id
              WHERE s.user_id = ? AND s.direction = 'right'
              AND (i.title LIKE ? OR i.summary LIKE ? OR s.feedback LIKE ?)
              ORDER BY s.swiped_at DESC
              LIMIT 20
            `).all(mcpUser!.id, searchPattern, searchPattern, searchPattern);
            
            return { ideas, count: ideas.length, query: searchQuery };
          }
          
          case "get_preferences": {
            const stats = db.query(`
              SELECT 
                COUNT(*) as total_swipes,
                SUM(CASE WHEN direction = 'right' THEN 1 ELSE 0 END) as saved,
                SUM(CASE WHEN direction = 'left' THEN 1 ELSE 0 END) as dismissed
              FROM swipes WHERE user_id = ?
            `).get(mcpUser!.id) as { total_swipes: number; saved: number; dismissed: number };
            
            const categoryPrefs = db.query(`
              SELECT i.category, COUNT(*) as count
              FROM swipes s
              JOIN ideas i ON s.idea_id = i.id
              WHERE s.user_id = ? AND s.direction = 'right'
              GROUP BY i.category
              ORDER BY count DESC
            `).all(mcpUser!.id);
            
            return {
              stats,
              favorite_categories: categoryPrefs,
              user: { email: mcpUser!.email, name: mcpUser!.name }
            };
          }
          
          case "add_idea": {
            if (!args?.title || !args?.source || !args?.summary) {
              return { error: "title, source, and summary are required" };
            }
            
            db.query(`
              INSERT INTO ideas (title, source, summary, url, category, source_feed, content_type)
              VALUES (?, ?, ?, ?, ?, 'mcp', 'article')
            `).run(args.title, args.source, args.summary, args.url || null, args.category || "custom");
            
            return { success: true, message: "Idea added to your queue" };
          }
          
          default:
            return { error: `Unknown tool: ${name}` };
        }
      }
      
      // GET /mcp/{token}/sse - SSE endpoint for MCP connection
      if (endpoint === "sse" && req.method === "GET") {
        const messagesUrl = `${BASE_URL}/mcp/${token}/messages`;
        
        // Create SSE stream
        const stream = new ReadableStream({
          start(controller) {
            // Send endpoint event
            const endpointEvent = `event: endpoint\ndata: ${messagesUrl}\n\n`;
            controller.enqueue(new TextEncoder().encode(endpointEvent));
            
            // Keep connection alive with periodic pings
            const pingInterval = setInterval(() => {
              try {
                controller.enqueue(new TextEncoder().encode(`: ping\n\n`));
              } catch {
                clearInterval(pingInterval);
              }
            }, 30000);
            
            // Clean up on close (this won't fire in Bun properly, but good practice)
            req.signal?.addEventListener("abort", () => {
              clearInterval(pingInterval);
              controller.close();
            });
          }
        });
        
        return new Response(stream, {
          headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            ...corsHeaders,
          }
        });
      }
      
      // POST /mcp/{token}/messages - JSON-RPC message handler
      if (endpoint === "messages" && req.method === "POST") {
        const body = await req.json() as { jsonrpc: string; id: number | string; method: string; params?: any };
        
        if (body.jsonrpc !== "2.0") {
          return jsonResponse({ jsonrpc: "2.0", id: body.id, error: { code: -32600, message: "Invalid Request" } }, 200, corsHeaders);
        }
        
        let result: any;
        
        switch (body.method) {
          case "initialize":
            result = {
              protocolVersion: "2024-11-05",
              serverInfo: { name: "idea-tinder", version: "1.0.0" },
              capabilities: { tools: {} }
            };
            break;
            
          case "tools/list":
            result = { tools: mcpTools };
            break;
            
          case "tools/call":
            const toolName = body.params?.name;
            const toolArgs = body.params?.arguments || {};
            const toolResult = executeTool(toolName, toolArgs);
            result = {
              content: [{ type: "text", text: JSON.stringify(toolResult, null, 2) }]
            };
            break;
            
          case "notifications/initialized":
          case "notifications/cancelled":
            // Acknowledge notifications
            return new Response(null, { status: 204, headers: corsHeaders });
            
          default:
            return jsonResponse({
              jsonrpc: "2.0",
              id: body.id,
              error: { code: -32601, message: `Method not found: ${body.method}` }
            }, 200, corsHeaders);
        }
        
        return jsonResponse({ jsonrpc: "2.0", id: body.id, result }, 200, corsHeaders);
      }
      
      return jsonResponse({ error: "Unknown MCP endpoint. Use /mcp/{token}/sse to connect." }, 404, corsHeaders);
    }
    
    // Default to index.html for SPA
    if (!url.pathname.startsWith("/api/") && !url.pathname.startsWith("/auth/")) {
      const indexResponse = serveStatic("/");
      if (indexResponse) return indexResponse;
    }
    
    return new Response("Not Found", { status: 404 });
  },
});

console.log(`Idea Tinder running on http://localhost:${server.port}`);
console.log(`Auth endpoints:`);
console.log(`  - /login (email/password + Google OAuth)`);
console.log(`  - /auth/google (start Google OAuth)`);
console.log(`  - /auth/logout`);
console.log(`Legal pages:`);
console.log(`  - /privacy`);
console.log(`  - /terms`);
console.log(`  - /about`);
















