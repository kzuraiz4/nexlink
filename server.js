const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;
const DB_FILE = path.join(__dirname, 'db.json');

// Supabase Configuration
const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SUPABASE_KEY = process.env.SUPABASE_KEY || '';
const IS_SUPABASE_ENABLED = Boolean(SUPABASE_URL && SUPABASE_KEY);

app.set('trust proxy', true);
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// ==========================================
// 1. HYBRID STORAGE ENGINE
// ==========================================
let memoryDB = { links: [], logs: [], users: [], domains: [] };
let lastCloudSync = null;

function initLocalDB() {
  if (!fs.existsSync(DB_FILE)) {
    fs.writeFileSync(DB_FILE, JSON.stringify(memoryDB, null, 2), 'utf8');
  } else {
    try {
      memoryDB = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
      if (!memoryDB.users) memoryDB.users = [];
      if (!memoryDB.domains) memoryDB.domains = [];
    } catch (err) {
      memoryDB = { links: [], logs: [], users: [], domains: [] };
    }
  }
}

async function pullFromSupabase() {
  initLocalDB();
  if (!IS_SUPABASE_ENABLED) return;
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/nexlink_store?id=eq.1&select=data`, {
      headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` }
    });
    if (!res.ok) throw new Error(await res.text());
    const rows = await res.json();
    if (rows && rows.length > 0 && rows[0].data) {
      const data = rows[0].data;
      memoryDB = {
        links: Array.isArray(data.links) ? data.links : [],
        logs: Array.isArray(data.logs) ? data.logs : [],
        users: Array.isArray(data.users) ? data.users : [],
        domains: Array.isArray(data.domains) ? data.domains : []
      };
      fs.writeFileSync(DB_FILE, JSON.stringify(memoryDB, null, 2), 'utf8');
      lastCloudSync = new Date().toISOString();
      console.log(`✅ Restored DB from Supabase (Users: ${memoryDB.users.length}, Links: ${memoryDB.links.length})`);
    } else {
      await pushToSupabase(memoryDB);
    }
  } catch (err) {
    console.error('❌ Supabase pull error:', err.message);
  }
}

async function pushToSupabase(data) {
  if (!IS_SUPABASE_ENABLED) return;
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/nexlink_store`, {
      method: 'POST',
      headers: {
        'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json', 'Prefer': 'resolution=merge-duplicates'
      },
      body: JSON.stringify({ id: 1, data, updated_at: new Date().toISOString() })
    });
    if (res.ok) lastCloudSync = new Date().toISOString();
  } catch (err) {}
}

function writeDB(data) {
  memoryDB = data;
  try { fs.writeFileSync(DB_FILE, JSON.stringify(memoryDB, null, 2), 'utf8'); } catch (err) {}
  pushToSupabase(memoryDB);
}

// ==========================================
// 2. AUTHENTICATION & SECURITY ENGINE
// ==========================================
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, storedHash) {
  const [salt, key] = storedHash.split(':');
  const hashedBuffer = crypto.scryptSync(password, salt, 64);
  const keyBuffer = Buffer.from(key, 'hex');
  return crypto.timingSafeEqual(hashedBuffer, keyBuffer);
}

function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

function requireAuth(req, res, next) {
  const token = req.headers['authorization']?.split(' ')[1];
  if (!token) return res.status(401).json({ success: false, error: 'Unauthorized. Please log in.' });

  const user = memoryDB.users.find(u => u.token === token);
  if (!user) return res.status(401).json({ success: false, error: 'Invalid session.' });

  req.user = user;
  next();
}

// ==========================================
// 3. BOT ENGINE & ROUTING UTILS
// ==========================================
const BOT_SIGNATURES = ['facebookexternalhit', 'facebot', 'meta-externalagent', 'whatsapp', 'twitterbot', 'linkedinbot', 'telegrambot', 'discordbot', 'slackbot', 'googlebot', 'applebot'];

function isBotUserAgent(ua) {
  if (!ua) return true;
  return BOT_SIGNATURES.some(bot => ua.toLowerCase().includes(bot));
}
function escapeHtml(str = '') { return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;'); }
function getBaseUrl(req) {
  const proto = req.headers['x-forwarded-proto'] ? req.headers['x-forwarded-proto'].split(',')[0].trim() : (req.protocol || 'https');
  return `${proto}://${req.get('host')}`;
}

// ==========================================
// 4. API ENDPOINTS
// ==========================================

app.post('/api/auth/signup', (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ success: false, error: 'Email and password required.' });
  if (memoryDB.users.some(u => u.email === email)) return res.status(409).json({ success: false, error: 'Email already exists.' });

  const role = memoryDB.users.length === 0 ? 'manager' : 'member';
  const token = generateToken();
  const newUser = { id: 'usr_' + Date.now(), email, passwordHash: hashPassword(password), role, token, createdAt: new Date().toISOString() };

  memoryDB.users.push(newUser);
  writeDB(memoryDB);
  res.json({ success: true, token, user: { id: newUser.id, email: newUser.email, role: newUser.role } });
});

app.post('/api/auth/login', (req, res) => {
  const { email, password } = req.body;
  const user = memoryDB.users.find(u => u.email === email);
  if (!user || !verifyPassword(password, user.passwordHash)) return res.status(401).json({ success: false, error: 'Invalid credentials.' });

  user.token = generateToken();
  writeDB(memoryDB);
  res.json({ success: true, token: user.token, user: { id: user.id, email: user.email, role: user.role } });
});

app.get('/api/get-data', requireAuth, (req, res) => {
  const { user } = req;
  const accessibleLinks = user.role === 'manager' ? memoryDB.links : memoryDB.links.filter(l => l.userId === user.id);
  const accessibleLinkSlugs = new Set(accessibleLinks.map(l => l.slug));
  const accessibleLogs = memoryDB.logs.filter(log => accessibleLinkSlugs.has(log.slug)); // Return all for charting

  res.json({
    success: true,
    user: { email: user.email, role: user.role },
    cloud: { enabled: IS_SUPABASE_ENABLED, lastSync: lastCloudSync },
    stats: {
      totalLinks: accessibleLinks.length,
      totalHumanClicks: accessibleLinks.reduce((acc, item) => acc + (item.humanClicks || 0), 0),
      totalBotHits: accessibleLinks.reduce((acc, item) => acc + (item.botHits || 0), 0)
    },
    links: accessibleLinks,
    logs: accessibleLogs, // All accessible logs sent to frontend for analytics graph
    domains: memoryDB.domains
  });
});

app.post('/api/domains', requireAuth, (req, res) => {
  if (req.user.role !== 'manager') return res.status(403).json({ success: false, error: 'Only Managers can add domains.' });
  const { domain } = req.body;
  if (!domain) return res.status(400).json({ success: false, error: 'Domain required.' });
  
  const cleanDomain = domain.toLowerCase().trim().replace(/^https?:\/\//, '').replace(/\/$/, '');
  if (memoryDB.domains.some(d => d.domain === cleanDomain)) return res.status(409).json({ success: false, error: 'Domain already registered.' });

  memoryDB.domains.push({ id: 'dom_' + Date.now(), domain: cleanDomain, addedBy: req.user.email });
  writeDB(memoryDB);
  res.json({ success: true, domains: memoryDB.domains });
});

app.delete('/api/domains/:domain', requireAuth, (req, res) => {
  if (req.user.role !== 'manager') return res.status(403).json({ success: false, error: 'Only Managers can delete domains.' });
  memoryDB.domains = memoryDB.domains.filter(d => d.domain !== req.params.domain);
  writeDB(memoryDB);
  res.json({ success: true, domains: memoryDB.domains });
});

app.post('/api/create-link', requireAuth, (req, res) => {
  const { slug, domain, targetUrl, safeUrl, ogTitle, ogDesc, ogImage } = req.body;
  if (!targetUrl) return res.status(400).json({ success: false, error: 'Destination URL required.' });

  let cleanSlug = (slug || '').trim().replace(/[^a-zA-Z0-9-_]/g, '') || Math.random().toString(36).substring(2, 8);
  if (['api', 'favicon.ico', 'robots.txt'].includes(cleanSlug.toLowerCase())) cleanSlug += `-${Math.floor(Math.random() * 999)}`;
  if (memoryDB.links.some(l => l.slug.toLowerCase() === cleanSlug.toLowerCase())) return res.status(409).json({ success: false, error: `Slug "/${cleanSlug}" already exists.` });

  const newLink = {
    id: 'lnk_' + Date.now(),
    userId: req.user.id,
    creatorEmail: req.user.email,
    slug: cleanSlug,
    domain: domain || req.get('host'),
    targetUrl: targetUrl.trim(),
    safeUrl: (safeUrl || 'https://en.wikipedia.org/wiki/Main_Page').trim(),
    ogTitle: (ogTitle || 'Featured Resource').trim(),
    ogDesc: (ogDesc || 'Click to view full details.').trim(),
    ogImage: ogImage || '',
    humanClicks: 0, botHits: 0, status: 'active', createdAt: new Date().toISOString()
  };

  memoryDB.links.unshift(newLink);
  writeDB(memoryDB);
  res.json({ success: true, link: newLink, shortUrl: `https://${newLink.domain}/${cleanSlug}` });
});

app.delete('/api/delete-link/:slug', requireAuth, (req, res) => {
  const linkIndex = memoryDB.links.findIndex(l => l.slug === req.params.slug);
  if (linkIndex === -1) return res.status(404).json({ success: false, error: 'Link not found' });
  if (req.user.role !== 'manager' && memoryDB.links[linkIndex].userId !== req.user.id) return res.status(403).json({ success: false, error: 'Forbidden' });

  memoryDB.links.splice(linkIndex, 1);
  writeDB(memoryDB);
  res.json({ success: true });
});

app.get('/api/og-image/:slug', (req, res) => {
  const link = memoryDB.links.find(l => l.slug.toLowerCase() === req.params.slug.toLowerCase());
  if (!link || !link.ogImage) return res.redirect('https://placehold.co/1200x630/09090b/ffffff.png?text=Preview');

  if (link.ogImage.startsWith('data:image')) {
    const matches = link.ogImage.match(/^data:([A-Za-z-+\/]+);base64,(.+)$/);
    if (matches && matches.length === 3) {
      const buffer = Buffer.from(matches[2], 'base64');
      res.writeHead(200, { 'Content-Type': matches[1], 'Content-Length': buffer.length, 'Cache-Control': 'public, max-age=86400' });
      return res.end(buffer);
    }
  }
  return res.redirect(link.ogImage);
});

// ==========================================
// 5. PUBLIC ROUTER (GET /:slug & GET /)
// ==========================================
app.get('/', (req, res) => { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.send(renderDashboardHTML()); });

app.get('/:slug', (req, res) => {
  const { slug } = req.params;
  if (slug === 'favicon.ico' || slug === 'robots.txt') return res.status(204).end();

  const linkIndex = memoryDB.links.findIndex(l => l.slug.toLowerCase() === slug.toLowerCase());
  if (linkIndex === -1) return res.status(404).send(`<!DOCTYPE html><html class="dark"><head><script src="https://cdn.tailwindcss.com"></script></head><body class="bg-zinc-950 text-zinc-100 min-h-screen flex items-center justify-center p-6"><div class="max-w-sm w-full border border-zinc-800 bg-zinc-900/50 rounded-xl p-6 text-center"><h1 class="text-base font-semibold mb-2">Link Not Found</h1><a href="/" class="px-4 py-2 rounded-lg bg-white text-zinc-950 text-xs">Back to Dashboard</a></div></body></html>`);

  const link = memoryDB.links[linkIndex];
  const ua = req.headers['user-agent'] || '';
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '0.0.0.0').split(',')[0].trim();
  const currentShortUrl = `https://${req.get('host')}/${link.slug}`;
  const botDetected = req.query.bot_preview === '1' || req.query.safe_redirect === '1' || isBotUserAgent(ua);

  if (botDetected) {
    memoryDB.links[linkIndex].botHits = (memoryDB.links[linkIndex].botHits || 0) + 1;
    memoryDB.logs.unshift({ id: 'log_' + Date.now(), slug: link.slug, type: 'BOT', ua: ua.substring(0, 140), ip, action: `Cloaked -> Served Uploaded OG Card`, timestamp: new Date().toISOString() });
    if (memoryDB.logs.length > 2500) memoryDB.logs.pop(); // Increased limit for better analytics graphs
    writeDB(memoryDB);

    if (req.query.safe_redirect === '1') return res.redirect(302, link.safeUrl);

    const baseUrl = getBaseUrl(req);
    const ogImageUrl = link.ogImage ? (link.ogImage.startsWith('data:image') ? `${baseUrl}/api/og-image/${link.slug}?v=${link.id}` : link.ogImage) : 'https://placehold.co/1200x630/09090b/ffffff.png?text=Preview';

    return res.status(200).setHeader('Content-Type', 'text/html; charset=utf-8').send(`<!DOCTYPE html>
<html lang="en" prefix="og: https://ogp.me/ns#"><head><meta charset="utf-8" />
<title>${escapeHtml(link.ogTitle)}</title><meta name="description" content="${escapeHtml(link.ogDesc)}" />
<meta property="og:type" content="website" /><meta property="og:url" content="${escapeHtml(currentShortUrl)}" />
<meta property="og:title" content="${escapeHtml(link.ogTitle)}" /><meta property="og:description" content="${escapeHtml(link.ogDesc)}" />
<meta property="og:image" content="${escapeHtml(ogImageUrl)}" /><meta name="twitter:card" content="summary_large_image" />
</head><body style="margin:0;background:#09090b;display:flex;align-items:center;justify-content:center;height:100vh;">
<script>window.location.replace("${escapeHtml(link.safeUrl)}");</script></body></html>`);
  }

  memoryDB.links[linkIndex].humanClicks = (memoryDB.links[linkIndex].humanClicks || 0) + 1;
  memoryDB.logs.unshift({ id: 'log_' + Date.now(), slug: link.slug, type: 'HUMAN', ua: ua.substring(0, 140), ip, action: `302 Redirect -> Target`, timestamp: new Date().toISOString() });
  if (memoryDB.logs.length > 2500) memoryDB.logs.pop();
  writeDB(memoryDB);
  return res.redirect(302, link.targetUrl);
});

// ==========================================
// 6. DASHBOARD SPA (Includes Auth & Chart.js)
// ==========================================
function renderDashboardHTML() {
  return `<!DOCTYPE html>
<html lang="en" class="dark">
<head>
  <meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>NexLink.io — 12-Module Enterprise Cloaker</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.1/css/all.min.css" />
  <style>
    @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&family=JetBrains+Mono:wght@400;500&display=swap');
    body { font-family: 'Inter', sans-serif; background-color: #09090b; color: #fafafa; }
    .mono { font-family: 'JetBrains Mono', monospace; }
    ::-webkit-scrollbar { width: 5px; height: 5px; }
    ::-webkit-scrollbar-track { background: transparent; }
    ::-webkit-scrollbar-thumb { background: #27272a; border-radius: 9999px; }
  </style>
</head>
<body class="min-h-screen flex flex-col antialiased selection:bg-white selection:text-zinc-950">

  <!-- ================= AUTH OVERLAY ================= -->
  <div id="auth-screen" class="fixed inset-0 z-[100] bg-zinc-950 flex flex-col items-center justify-center p-6">
    <div class="w-full max-w-sm bg-zinc-900/50 border border-zinc-800 rounded-2xl p-8">
      <div class="text-center mb-6">
        <div class="w-10 h-10 rounded-xl bg-white text-zinc-950 flex items-center justify-center font-bold text-lg mx-auto mb-3">N</div>
        <h1 class="text-xl font-bold text-white">NexLink.io Engine</h1>
        <p class="text-xs text-zinc-400 mt-1" id="auth-subtitle">Login to access your workspace</p>
      </div>
      <form id="auth-form" onsubmit="handleAuth(event)" class="space-y-4">
        <div>
          <label class="block text-xs font-medium text-zinc-400 mb-1">Email</label>
          <input type="email" id="auth-email" required class="w-full px-3 py-2 rounded-lg bg-zinc-950 border border-zinc-800 text-sm text-white focus:border-emerald-500 outline-none transition" />
        </div>
        <div>
          <label class="block text-xs font-medium text-zinc-400 mb-1">Password</label>
          <input type="password" id="auth-password" required class="w-full px-3 py-2 rounded-lg bg-zinc-950 border border-zinc-800 text-sm text-white focus:border-emerald-500 outline-none transition" />
        </div>
        <div id="auth-error" class="hidden text-xs text-rose-400 bg-rose-500/10 p-2.5 rounded-lg border border-rose-500/20 text-center"></div>
        <button type="submit" class="w-full py-2.5 rounded-lg bg-white text-zinc-950 text-sm font-semibold hover:bg-zinc-200 transition" id="auth-btn">Log In</button>
      </form>
      <div class="mt-5 text-center text-xs text-zinc-500">
        <button onclick="toggleAuthMode()" id="auth-toggle-btn" class="hover:text-white transition">Need an account? Sign up</button>
      </div>
    </div>
  </div>

  <!-- ================= APP SCREEN ================= -->
  <div id="app-screen" class="hidden flex-1 flex flex-col w-full">
    
    <header class="sticky top-0 z-30 bg-zinc-950/85 backdrop-blur-md border-b border-zinc-800/80 px-6 py-3">
      <div class="max-w-7xl mx-auto flex items-center justify-between">
        <div class="flex items-center gap-3">
          <div class="w-7 h-7 rounded-lg bg-white text-zinc-950 flex items-center justify-center font-bold text-xs">N</div>
          <div class="flex items-center gap-2">
            <span class="font-semibold text-sm tracking-tight text-white">NexLink.io</span>
            <span id="role-badge" class="text-[9px] mono px-2 py-0.5 rounded bg-zinc-900 border border-zinc-800 text-zinc-400 uppercase">Role</span>
          </div>
        </div>

        <div class="flex items-center gap-2.5">
          <div id="cloud-badge" class="hidden sm:flex items-center gap-2 px-2.5 py-1 rounded-md bg-zinc-900 border border-zinc-800 text-[11px] text-zinc-400">
            <span id="cloud-dot" class="w-1.5 h-1.5 rounded-full bg-emerald-400"></span>
            <span id="cloud-status-text">Cloud Sync</span>
          </div>
          <button onclick="bootApp()" class="px-3 py-1.5 rounded-lg bg-zinc-900 hover:bg-zinc-800 text-zinc-300 text-xs font-medium border border-zinc-800 transition">
            <i class="fa-solid fa-rotate-right mr-1 text-[10px]"></i> Sync
          </button>
          <button onclick="openCreateModal()" class="px-3.5 py-1.5 rounded-lg bg-white hover:bg-zinc-200 text-zinc-950 text-xs font-semibold transition flex items-center gap-1.5">
            <i class="fa-solid fa-plus text-[10px]"></i> New Link
          </button>
          <button onclick="logout()" class="px-3 py-1.5 rounded-lg bg-zinc-900 hover:bg-rose-500/20 text-zinc-400 hover:text-rose-400 text-xs font-medium border border-zinc-800 transition ml-2">
            <i class="fa-solid fa-right-from-bracket"></i>
          </button>
        </div>
      </div>
    </header>

    <main class="flex-1 max-w-7xl w-full mx-auto px-6 py-6 space-y-6">

      <!-- KPI STRIP -->
      <section class="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <div class="bg-zinc-900/40 border border-zinc-800/80 rounded-xl p-4">
          <div class="flex items-center justify-between text-[11px] text-zinc-500"><span>01 / Active Links</span><i class="fa-solid fa-link text-zinc-600"></i></div>
          <div id="stat-total-links" class="text-2xl font-semibold text-white mt-1.5 mono">0</div>
        </div>
        <div class="bg-zinc-900/40 border border-zinc-800/80 rounded-xl p-4">
          <div class="flex items-center justify-between text-[11px] text-zinc-500"><span>02 / Human Clicks (302)</span><span class="w-1.5 h-1.5 rounded-full bg-emerald-400"></span></div>
          <div id="stat-human-clicks" class="text-2xl font-semibold text-emerald-400 mt-1.5 mono">0</div>
        </div>
        <div class="bg-zinc-900/40 border border-zinc-800/80 rounded-xl p-4">
          <div class="flex items-center justify-between text-[11px] text-zinc-500"><span>03 / Bots Cloaked (OG)</span><span class="w-1.5 h-1.5 rounded-full bg-amber-400"></span></div>
          <div id="stat-bot-hits" class="text-2xl font-semibold text-amber-400 mt-1.5 mono">0</div>
        </div>
        <div class="bg-zinc-900/40 border border-zinc-800/80 rounded-xl p-4">
          <div class="flex items-center justify-between text-[11px] text-zinc-500"><span>04 / Shield Efficiency</span><i class="fa-solid fa-shield-halved text-zinc-600"></i></div>
          <div id="stat-efficiency" class="text-2xl font-semibold text-zinc-100 mt-1.5 mono">100%</div>
        </div>
      </section>

      <!-- ADVANCED ANALYTICS GRAPH MODULE -->
      <section class="bg-zinc-900/40 border border-zinc-800/80 rounded-xl p-5">
        <div class="flex flex-wrap items-center justify-between gap-4 mb-4">
          <div>
            <span class="text-[10px] mono uppercase text-zinc-500">Advanced Analytics</span>
            <h2 class="text-sm font-semibold text-white" id="analytics-title">Traffic Overview</h2>
          </div>
          <div class="flex items-center gap-2">
            <div id="custom-date-picker" class="hidden items-center gap-2 mr-2">
              <input type="date" id="chart-start" class="px-2 py-1 rounded bg-zinc-950 border border-zinc-800 text-[10px] text-zinc-300 focus:outline-none" />
              <span class="text-zinc-500 text-[10px]">to</span>
              <input type="date" id="chart-end" class="px-2 py-1 rounded bg-zinc-950 border border-zinc-800 text-[10px] text-zinc-300 focus:outline-none" />
              <button onclick="renderAnalyticsChart()" class="px-2 py-1 rounded bg-zinc-800 text-[10px] text-white">Apply</button>
            </div>
            <select id="chart-timeframe" onchange="handleTimeframeChange()" class="px-3 py-1.5 rounded-lg bg-zinc-950 border border-zinc-800 text-xs text-zinc-200 focus:outline-none">
              <option value="today">Today</option>
              <option value="yesterday">Yesterday</option>
              <option value="3days">Last 3 Days</option>
              <option value="7days" selected>Last 7 Days</option>
              <option value="month">This Month</option>
              <option value="custom">Custom Range</option>
            </select>
          </div>
        </div>
        <div class="w-full h-64 relative">
          <canvas id="analyticsChart"></canvas>
        </div>
      </section>

      <!-- LINKS TABLE + LIVE SOCIAL PREVIEW VERIFIER -->
      <section class="grid grid-cols-1 lg:grid-cols-12 gap-5">
        <div class="lg:col-span-8 bg-zinc-900/40 border border-zinc-800/80 rounded-xl p-5 flex flex-col">
          <div class="flex flex-wrap items-center justify-between gap-3 pb-4 border-b border-zinc-800/80">
            <div>
              <span class="text-[10px] mono uppercase text-zinc-500">05 / Routing Table</span>
              <h2 class="text-sm font-semibold text-white">Active Cloaked Short Links</h2>
            </div>
            <input id="search-links" oninput="renderLinksTable()" type="text" placeholder="Search slug or URL..." class="px-3 py-1.5 rounded-lg bg-zinc-950 border border-zinc-800 text-xs text-zinc-200 focus:outline-none focus:border-zinc-600 w-52" />
          </div>
          <div class="overflow-x-auto mt-2">
            <table class="w-full text-left border-collapse">
              <thead>
                <tr class="border-b border-zinc-800/70 text-[10px] mono text-zinc-500 uppercase">
                  <th class="py-2.5 px-2">Short Slug</th>
                  <th class="py-2.5 px-2">Routes (Target / Safe)</th>
                  <th class="py-2.5 px-2">Creator</th>
                  <th class="py-2.5 px-2 text-center">H</th>
                  <th class="py-2.5 px-2 text-center">B</th>
                  <th class="py-2.5 px-2 text-right">Actions</th>
                </tr>
              </thead>
              <tbody id="links-table-body" class="divide-y divide-zinc-800/40 text-xs"></tbody>
            </table>
          </div>
        </div>

        <div class="lg:col-span-4 bg-zinc-900/40 border border-zinc-800/80 rounded-xl p-5 flex flex-col justify-between">
          <div>
            <div class="flex items-center justify-between mb-3">
              <div>
                <span class="text-[10px] mono uppercase text-zinc-500">06 / Preview Verifier</span>
                <h2 class="text-sm font-semibold text-white">Social Scraper Card</h2>
              </div>
              <select id="simulator-slug-select" onchange="updateSimulatorCard()" class="px-2.5 py-1 rounded-lg bg-zinc-950 border border-zinc-800 text-xs text-zinc-200 focus:outline-none"></select>
            </div>
            <div class="rounded-xl overflow-hidden border border-zinc-800 bg-zinc-950 mb-4">
              <div class="h-36 bg-zinc-900 relative overflow-hidden"><img id="sim-og-img" src="https://placehold.co/1200x630/09090b/ffffff.png?text=Preview" class="w-full h-full object-cover" /></div>
              <div class="p-3 border-t border-zinc-800/80">
                <div id="sim-domain" class="text-[10px] mono uppercase text-zinc-500 truncate">nexlink.io</div>
                <div id="sim-og-title" class="text-xs font-semibold text-white truncate mt-0.5">No link selected</div>
                <div id="sim-og-desc" class="text-[11px] text-zinc-400 line-clamp-2 mt-0.5">Create a link to verify its social preview card.</div>
              </div>
            </div>
          </div>
          <div class="grid grid-cols-2 gap-2 pt-3 border-t border-zinc-800/80">
            <button onclick="triggerSimulatedVisit('human')" class="px-2.5 py-1.5 rounded-lg bg-zinc-950 hover:bg-zinc-800 text-emerald-400 border border-zinc-800 text-[11px] font-medium transition">302 Human</button>
            <button onclick="triggerSimulatedVisit('bot')" class="px-2.5 py-1.5 rounded-lg bg-zinc-950 hover:bg-zinc-800 text-amber-400 border border-zinc-800 text-[11px] font-medium transition">OG Bot Card</button>
          </div>
        </div>
      </section>

      <!-- MODULES 07, 08, 09: TELEMETRY & DOMAINS -->
      <section class="grid grid-cols-1 lg:grid-cols-3 gap-5">
        <div class="bg-zinc-900/40 border border-zinc-800/80 rounded-xl p-5 flex flex-col h-72">
          <div class="flex items-center justify-between mb-3">
            <div><span class="text-[10px] mono uppercase text-zinc-500">07 / Live Stream</span><h2 class="text-sm font-semibold text-white">Interception Logs</h2></div>
            <span class="text-[10px] mono text-zinc-500">Real-time</span>
          </div>
          <div id="logs-container" class="flex-1 overflow-y-auto space-y-1.5 pr-1"></div>
        </div>
        <div class="bg-zinc-900/40 border border-zinc-800/80 rounded-xl p-5 flex flex-col justify-between h-72">
          <div>
            <span class="text-[10px] mono uppercase text-zinc-500">08 / Traffic Ratio</span>
            <h2 class="text-sm font-semibold text-white mb-4">Human vs. Bot Distribution</h2>
            <div class="space-y-4">
              <div>
                <div class="flex justify-between text-xs mb-1.5"><span class="text-zinc-300">Human Visitors (302 Target)</span><span id="bar-human-label" class="mono text-emerald-400">0 (50%)</span></div>
                <div class="w-full h-2 rounded-full bg-zinc-950 overflow-hidden border border-zinc-800"><div id="bar-human" class="h-full bg-emerald-400 transition-all duration-500" style="width: 50%"></div></div>
              </div>
              <div>
                <div class="flex justify-between text-xs mb-1.5"><span class="text-zinc-300">Social Bots (OG Cloak)</span><span id="bar-bot-label" class="mono text-amber-400">0 (50%)</span></div>
                <div class="w-full h-2 rounded-full bg-zinc-950 overflow-hidden border border-zinc-800"><div id="bar-bot" class="h-full bg-amber-400 transition-all duration-500" style="width: 50%"></div></div>
              </div>
            </div>
          </div>
        </div>
        <div class="bg-zinc-900/40 border border-zinc-800/80 rounded-xl p-5 flex flex-col h-72">
          <div class="mb-3">
            <span class="text-[10px] mono uppercase text-zinc-500">09 / Domain Registry</span>
            <h2 class="text-sm font-semibold text-white">Custom Routing Domains</h2>
          </div>
          <div id="manager-domain-controls" class="hidden mb-3 pb-3 border-b border-zinc-800/80">
            <div class="flex gap-2">
              <input type="text" id="new-domain-input" placeholder="links.brand.com" class="flex-1 px-3 py-1.5 rounded-lg bg-zinc-950 border border-zinc-800 text-xs text-white focus:outline-none focus:border-zinc-600" />
              <button onclick="addCustomDomain()" class="px-3 py-1.5 rounded-lg bg-white text-zinc-950 text-xs font-semibold hover:bg-zinc-200 transition">Add</button>
            </div>
          </div>
          <div id="domains-list" class="flex-1 overflow-y-auto space-y-2 pr-1 text-xs"></div>
        </div>
      </section>

      <!-- SYSTEM FOOTER MODULES -->
      <section class="grid grid-cols-1 md:grid-cols-3 gap-5">
        <div class="bg-zinc-900/40 border border-zinc-800/80 rounded-xl p-4 flex items-center justify-between">
          <div><span class="text-[10px] mono uppercase text-zinc-500">10 / Session User</span><div id="session-email" class="text-xs font-medium text-white mt-0.5">user@example.com</div></div>
          <span class="text-[10px] mono px-2 py-1 rounded bg-zinc-950 border border-zinc-800 text-zinc-400">Authenticated</span>
        </div>
        <div class="bg-zinc-900/40 border border-zinc-800/80 rounded-xl p-4 flex items-center justify-between">
          <div><span class="text-[10px] mono uppercase text-zinc-500">11 / Permanent Storage</span><div id="storage-mode-label" class="text-xs font-medium text-white mt-0.5">Supabase + db.json</div></div>
        </div>
        <div class="bg-zinc-900/40 border border-zinc-800/80 rounded-xl p-4 flex items-center justify-between">
          <div><span class="text-[10px] mono uppercase text-zinc-500">12 / Express Router</span><div class="text-xs font-medium text-white mono mt-0.5">/:slug + /api/og-image/:slug</div></div>
          <span class="text-[10px] mono px-2 py-1 rounded bg-emerald-500/10 border border-emerald-500/20 text-emerald-400">200 OK</span>
        </div>
      </section>
    </main>
  </div>

  <!-- LINK CREATION MODAL -->
  <div id="create-modal" class="fixed inset-0 z-[110] hidden bg-black/80 backdrop-blur-sm flex items-center justify-center p-4 overflow-y-auto">
    <div class="bg-zinc-950 border border-zinc-800 rounded-2xl max-w-3xl w-full p-6 shadow-2xl my-8">
      <div class="flex items-center justify-between pb-4 border-b border-zinc-800">
        <div>
          <h3 class="text-sm font-semibold text-white">Create Permanent Cloaked Link</h3>
          <p class="text-xs text-zinc-400">Humans 302 redirect to Target URL. Social bots render your uploaded OG image.</p>
        </div>
        <button onclick="closeCreateModal()" class="w-7 h-7 rounded-lg bg-zinc-900 hover:bg-zinc-800 text-zinc-400 hover:text-white flex items-center justify-center text-xs transition"><i class="fa-solid fa-xmark"></i></button>
      </div>

      <form id="create-link-form" onsubmit="submitCreateLink(event)" class="grid grid-cols-1 lg:grid-cols-12 gap-6 mt-5">
        <div class="lg:col-span-7 space-y-3.5">
          <div class="grid grid-cols-2 gap-3">
            <div>
              <label class="block text-[11px] text-zinc-400 mb-1">Domain Prefix</label>
              <select id="form-domain" class="w-full px-3 py-2 rounded-lg bg-zinc-900 border border-zinc-800 text-xs text-white focus:outline-none focus:border-zinc-600"></select>
            </div>
            <div>
              <label class="block text-[11px] text-zinc-400 mb-1">Custom Alias / Slug</label>
              <input id="form-slug" type="text" placeholder="custom-slug" class="w-full px-3 py-2 rounded-lg bg-zinc-900 border border-zinc-800 text-xs text-white mono focus:outline-none focus:border-zinc-600" />
            </div>
          </div>
          <div>
            <label class="block text-[11px] text-emerald-400 mb-1">Destination Target URL (Real Humans -> 302) *</label>
            <input id="form-target" type="url" required class="w-full px-3 py-2 rounded-lg bg-zinc-900 border border-zinc-800 text-xs text-white focus:outline-none focus:border-emerald-500" />
          </div>
          <div>
            <label class="block text-[11px] text-amber-400 mb-1">Safe Page URL (Fallback / Bot Safe Link) *</label>
            <input id="form-safe" type="url" required class="w-full px-3 py-2 rounded-lg bg-zinc-900 border border-zinc-800 text-xs text-white focus:outline-none focus:border-amber-500" />
          </div>
          <div class="pt-2 border-t border-zinc-800/80 space-y-3">
            <div class="text-[11px] font-medium text-zinc-300">Social Preview Metadata (Open Graph)</div>
            <div>
              <label class="block text-[11px] text-zinc-400 mb-1">OG Title *</label>
              <input id="form-og-title" oninput="syncModalPreview()" type="text" required class="w-full px-3 py-2 rounded-lg bg-zinc-900 border border-zinc-800 text-xs text-white focus:outline-none focus:border-zinc-600" />
            </div>
            <div>
              <label class="block text-[11px] text-zinc-400 mb-1">OG Description</label>
              <textarea id="form-og-desc" oninput="syncModalPreview()" rows="2" class="w-full px-3 py-2 rounded-lg bg-zinc-900 border border-zinc-800 text-xs text-white focus:outline-none focus:border-zinc-600"></textarea>
            </div>
            <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label class="block text-[11px] text-zinc-400 mb-1">Upload Preview Image</label>
                <input id="form-og-image-file" onchange="handleBase64Upload(event)" type="file" accept="image/*" class="w-full text-xs text-zinc-400 file:mr-2 file:py-1.5 file:px-3 file:rounded-lg file:border-0 file:text-xs file:font-medium file:bg-white file:text-zinc-950 hover:file:bg-zinc-200 cursor-pointer" />
              </div>
              <div>
                <label class="block text-[11px] text-zinc-400 mb-1">Or Direct Image URL</label>
                <input id="form-og-image-url" oninput="handleImageUrlInput()" type="url" class="w-full px-3 py-1.5 rounded-lg bg-zinc-900 border border-zinc-800 text-xs text-white focus:outline-none focus:border-zinc-600" />
              </div>
            </div>
          </div>
          <div id="form-error" class="hidden p-2.5 rounded-lg bg-rose-500/10 border border-rose-500/30 text-rose-400 text-xs"></div>
          <div class="flex items-center justify-end gap-2 pt-3 border-t border-zinc-800">
            <button type="button" onclick="closeCreateModal()" class="px-3.5 py-2 rounded-lg bg-zinc-900 hover:bg-zinc-800 text-xs text-zinc-300">Cancel</button>
            <button type="submit" class="px-4 py-2 rounded-lg bg-white hover:bg-zinc-200 text-zinc-950 text-xs font-semibold transition">Deploy Link</button>
          </div>
        </div>

        <div class="lg:col-span-5 bg-zinc-900/50 border border-zinc-800 rounded-xl p-4 flex flex-col justify-between">
          <div>
            <span class="text-[10px] mono uppercase text-zinc-500">Live Social Card Preview</span>
            <div class="rounded-xl overflow-hidden border border-zinc-800 bg-zinc-950 mt-2">
              <div class="h-44 bg-zinc-900 overflow-hidden"><img id="modal-preview-img" src="https://placehold.co/1200x630/09090b/ffffff.png?text=Upload+Preview+Image" class="w-full h-full object-cover" /></div>
              <div class="p-3 border-t border-zinc-800">
                <div id="modal-preview-domain" class="text-[10px] mono uppercase text-zinc-500 truncate">nexlink.io</div>
                <div id="modal-preview-title" class="text-xs font-semibold text-white truncate mt-0.5">Your OG Title</div>
                <div id="modal-preview-desc" class="text-[11px] text-zinc-400 line-clamp-2 mt-0.5">Your uploaded image and text will appear on Facebook, WhatsApp, X, and Telegram.</div>
              </div>
            </div>
          </div>
        </div>
      </form>
    </div>
  </div>

  <div id="toast" class="fixed bottom-5 right-5 z-[120] hidden px-4 py-2.5 rounded-xl bg-white text-zinc-950 text-xs font-medium shadow-xl"><span id="toast-msg">Copied</span></div>

  <script>
    let appState = { links: [], logs: [], stats: {}, cloud: {}, domains: [], user: null };
    let uploadedBase64Image = '';
    let isLoginMode = true;
    let analyticsChartObj = null;

    // --- AUTH LOGIC ---
    function getToken() { return localStorage.getItem('nexlink_token'); }
    function setToken(t) { localStorage.setItem('nexlink_token', t); }

    function toggleAuthMode() {
      isLoginMode = !isLoginMode;
      document.getElementById('auth-btn').textContent = isLoginMode ? 'Log In' : 'Sign Up';
      document.getElementById('auth-subtitle').textContent = isLoginMode ? 'Login to access your workspace' : 'Register your team account';
      document.getElementById('auth-toggle-btn').textContent = isLoginMode ? 'Need an account? Sign up' : 'Already have an account? Log in';
      document.getElementById('auth-error').classList.add('hidden');
    }

    async function handleAuth(e) {
      e.preventDefault();
      const email = document.getElementById('auth-email').value;
      const password = document.getElementById('auth-password').value;
      const endpoint = isLoginMode ? '/api/auth/login' : '/api/auth/signup';
      const errBox = document.getElementById('auth-error');
      try {
        const res = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) });
        const data = await res.json();
        if (!data.success) throw new Error(data.error);
        setToken(data.token);
        bootApp();
      } catch (err) {
        errBox.textContent = err.message; errBox.classList.remove('hidden');
      }
    }

    function logout() {
      localStorage.removeItem('nexlink_token');
      document.getElementById('app-screen').classList.add('hidden');
      document.getElementById('auth-screen').classList.remove('hidden');
    }

    // --- APP LOGIC ---
    async function bootApp() {
      const token = getToken();
      if (!token) return logout();
      try {
        const res = await fetch('/api/get-data', { headers: { 'Authorization': \`Bearer \${token}\` } });
        if (res.status === 401) return logout();
        const data = await res.json();
        if (!data.success) return;
        
        appState = data;
        document.getElementById('auth-screen').classList.add('hidden');
        document.getElementById('app-screen').classList.remove('hidden');
        
        const rb = document.getElementById('role-badge');
        rb.textContent = appState.user.role;
        rb.className = appState.user.role === 'manager' 
          ? 'text-[9px] mono px-2 py-0.5 rounded bg-purple-500/20 text-purple-400 border border-purple-500/30 uppercase'
          : 'text-[9px] mono px-2 py-0.5 rounded bg-blue-500/20 text-blue-400 border border-blue-500/30 uppercase';
        
        document.getElementById('session-email').textContent = appState.user.email;
        document.getElementById('analytics-title').textContent = appState.user.role === 'manager' ? 'Team Traffic Overview (All Links)' : 'Your Traffic Overview (My Links)';

        if (appState.user.role === 'manager') document.getElementById('manager-domain-controls').classList.remove('hidden');

        renderCloudStatus();
        renderStats();
        renderAnalyticsChart();
        renderLinksTable();
        renderLogs();
        populateDomainDropdown();
        renderDomainsList();
        populateSimulatorSelect();
      } catch (e) { console.error(e); }
    }

    // --- ANALYTICS GRAPH LOGIC ---
    function handleTimeframeChange() {
      const val = document.getElementById('chart-timeframe').value;
      const customDiv = document.getElementById('custom-date-picker');
      if (val === 'custom') customDiv.classList.replace('hidden', 'flex');
      else { customDiv.classList.replace('flex', 'hidden'); renderAnalyticsChart(); }
    }

    function filterLogsByDate(logs, rangeStr) {
      let start = new Date(); let end = new Date();
      if (rangeStr === 'today') { start.setHours(0,0,0,0); } 
      else if (rangeStr === 'yesterday') { start.setDate(start.getDate() - 1); start.setHours(0,0,0,0); end.setDate(end.getDate() - 1); end.setHours(23,59,59,999); } 
      else if (rangeStr === '3days') { start.setDate(start.getDate() - 3); start.setHours(0,0,0,0); } 
      else if (rangeStr === '7days') { start.setDate(start.getDate() - 7); start.setHours(0,0,0,0); } 
      else if (rangeStr === 'month') { start.setDate(1); start.setHours(0,0,0,0); } 
      else if (rangeStr === 'custom') {
        const cStart = document.getElementById('chart-start').value;
        const cEnd = document.getElementById('chart-end').value;
        if(cStart) { start = new Date(cStart); start.setHours(0,0,0,0); }
        if(cEnd) { end = new Date(cEnd); end.setHours(23,59,59,999); }
      }
      return logs.filter(l => { const d = new Date(l.timestamp); return d >= start && d <= end; });
    }

    function renderAnalyticsChart() {
      const range = document.getElementById('chart-timeframe').value;
      const filteredLogs = filterLogsByDate(appState.logs, range);
      
      const grouped = {};
      filteredLogs.forEach(log => {
        const d = new Date(log.timestamp);
        // Group by hour for 'today' or 'yesterday', else by date
        const key = (range === 'today' || range === 'yesterday') 
          ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) 
          : d.toLocaleDateString([], { month: 'short', day: 'numeric' });
        
        if (!grouped[key]) grouped[key] = { human: 0, bot: 0 };
        if (log.type === 'HUMAN') grouped[key].human++;
        else grouped[key].bot++;
      });

      const labels = Object.keys(grouped).sort((a,b) => {
        if(range === 'today' || range === 'yesterday') return a.localeCompare(b);
        return new Date(a + " " + new Date().getFullYear()) - new Date(b + " " + new Date().getFullYear());
      });
      const humanData = labels.map(l => grouped[l].human);
      const botData = labels.map(l => grouped[l].bot);

      const ctx = document.getElementById('analyticsChart').getContext('2d');
      if (analyticsChartObj) analyticsChartObj.destroy();
      
      Chart.defaults.color = '#a1a1aa';
      Chart.defaults.font.family = 'Inter';
      
      analyticsChartObj = new Chart(ctx, {
        type: 'line',
        data: {
          labels: labels,
          datasets: [
            { label: 'Human Clicks (302)', data: humanData, borderColor: '#34d399', backgroundColor: 'rgba(52, 211, 153, 0.1)', borderWidth: 2, fill: true, tension: 0.3, pointBackgroundColor: '#34d399' },
            { label: 'Bot Interceptions (OG)', data: botData, borderColor: '#fbbf24', backgroundColor: 'rgba(251, 191, 36, 0.1)', borderWidth: 2, fill: true, tension: 0.3, pointBackgroundColor: '#fbbf24' }
          ]
        },
        options: {
          responsive: true, maintainAspectRatio: false,
          plugins: { legend: { position: 'top', labels: { boxWidth: 12, usePointStyle: true } } },
          scales: {
            y: { beginAtZero: true, grid: { color: '#27272a' }, ticks: { stepSize: 1 } },
            x: { grid: { display: false } }
          }
        }
      });
    }

    // --- OTHER UI LOGIC ---
    function renderCloudStatus() {
      if (appState.cloud && appState.cloud.enabled) {
        document.getElementById('cloud-dot').className = 'w-1.5 h-1.5 rounded-full bg-emerald-400';
        document.getElementById('cloud-status-text').textContent = 'Supabase Sync';
        document.getElementById('storage-mode-label').innerHTML = '<span class="text-emerald-400">Supabase Cloud</span> + db.json';
      }
    }

    function renderStats() {
      const s = appState.stats || {};
      document.getElementById('stat-total-links').textContent = s.totalLinks || 0;
      document.getElementById('stat-human-clicks').textContent = s.totalHumanClicks || 0;
      document.getElementById('stat-bot-hits').textContent = s.totalBotHits || 0;

      const total = (s.totalHumanClicks || 0) + (s.totalBotHits || 0);
      const humanPct = total > 0 ? Math.round(((s.totalHumanClicks || 0) / total) * 100) : 50;
      const botPct = total > 0 ? 100 - humanPct : 50;
      document.getElementById('bar-human').style.width = humanPct + '%';
      document.getElementById('bar-human-label').textContent = \`\${s.totalHumanClicks || 0} (\${humanPct}%)\`;
      document.getElementById('bar-bot').style.width = botPct + '%';
      document.getElementById('bar-bot-label').textContent = \`\${s.totalBotHits || 0} (\${botPct}%)\`;
    }

    function renderLinksTable() {
      const tbody = document.getElementById('links-table-body');
      const filter = (document.getElementById('search-links').value || '').toLowerCase();
      const filtered = appState.links.filter(l => l.slug.toLowerCase().includes(filter) || l.targetUrl.toLowerCase().includes(filter));
      if (!filtered.length) { tbody.innerHTML = '<tr><td colspan="6" class="py-8 text-center text-zinc-500">No active links.</td></tr>'; return; }
      tbody.innerHTML = filtered.map(link => \`
        <tr class="hover:bg-zinc-900/60 transition">
          <td class="py-3 px-2">
            <div class="flex items-center gap-1.5"><span class="font-medium text-white mono">/\${link.slug}</span><button onclick="copyToClipboard('https://\${link.domain}/\${link.slug}')" class="px-1.5 py-0.5 rounded bg-zinc-900 hover:bg-zinc-800 text-zinc-400 text-[10px]">Copy</button></div>
            <div class="text-[9px] text-zinc-500 mono mt-0.5">\${link.domain}</div>
          </td>
          <td class="py-3 px-2 max-w-[180px]">
            <div class="truncate text-emerald-400 text-[11px]">→ \${link.targetUrl}</div><div class="truncate text-zinc-500 text-[10px]">Safe: \${link.safeUrl}</div>
          </td>
          <td class="py-3 px-2 text-[10px] text-zinc-400 truncate max-w-[100px]">\${link.creatorEmail || 'System'}</td>
          <td class="py-3 px-2 text-center mono text-emerald-400">\${link.humanClicks || 0}</td>
          <td class="py-3 px-2 text-center mono text-amber-400">\${link.botHits || 0}</td>
          <td class="py-3 px-2 text-right whitespace-nowrap"><button onclick="deleteLink('\${link.slug}')" class="px-2 py-1 rounded bg-zinc-900 hover:bg-rose-500/20 text-zinc-400 hover:text-rose-400 text-[10px]">Del</button></td>
        </tr>\`).join('');
    }

    function renderLogs() {
      const container = document.getElementById('logs-container');
      const limitedLogs = appState.logs.slice(0, 100);
      if (!limitedLogs.length) { container.innerHTML = '<div class="text-xs text-zinc-600 text-center py-8">No requests logged yet.</div>'; return; }
      container.innerHTML = limitedLogs.map(log => \`<div class="px-3 py-2 rounded-lg bg-zinc-950 border border-zinc-800/70 text-[11px] flex items-center justify-between gap-2">
            <div class="truncate"><span class="mono font-semibold \${log.type === 'BOT' ? 'text-amber-400' : 'text-emerald-400'}">[\${log.type}]</span><span class="mono text-white ml-1">/\${log.slug}</span></div>
            <span class="mono text-[10px] text-zinc-600 shrink-0">\${new Date(log.timestamp).toLocaleTimeString()}</span>
          </div>\`).join('');
    }

    function populateDomainDropdown() {
      const select = document.getElementById('form-domain');
      let opts = \`<option value="\${window.location.host}">\${window.location.host}</option>\`;
      appState.domains.forEach(d => { opts += \`<option value="\${d.domain}">\${d.domain}</option>\`; });
      select.innerHTML = opts;
    }

    function renderDomainsList() {
      const container = document.getElementById('domains-list');
      if (!appState.domains.length) { container.innerHTML = '<div class="text-zinc-600 text-[11px] py-4">No custom domains added.</div>'; return; }
      container.innerHTML = appState.domains.map(d => \`<div class="px-3 py-2 rounded-lg bg-zinc-950 border border-zinc-800 flex items-center justify-between">
          <div><div class="text-zinc-200">\${d.domain}</div><div class="text-[9px] text-zinc-500 mt-0.5">Added by \${d.addedBy}</div></div>
          \${appState.user.role === 'manager' ? \`<button onclick="deleteCustomDomain('\${d.domain}')" class="text-rose-400 hover:text-rose-300"><i class="fa-solid fa-trash text-[10px]"></i></button>\` : ''}
        </div>\`).join('');
    }

    async function addCustomDomain() {
      const val = document.getElementById('new-domain-input').value;
      if (!val) return;
      const res = await fetch('/api/domains', { method: 'POST', headers: { 'Authorization': \`Bearer \${getToken()}\`, 'Content-Type': 'application/json' }, body: JSON.stringify({ domain: val }) });
      if (res.ok) { document.getElementById('new-domain-input').value = ''; bootApp(); }
    }
    
    async function deleteCustomDomain(domain) {
      if (!confirm(\`Remove domain \${domain}?\`)) return;
      await fetch(\`/api/domains/\${domain}\`, { method: 'DELETE', headers: { 'Authorization': \`Bearer \${getToken()}\` } }); bootApp();
    }

    function populateSimulatorSelect() {
      const select = document.getElementById('simulator-slug-select'); const prev = select.value;
      if (!appState.links.length) { select.innerHTML = '<option value="">No links</option>'; return; }
      select.innerHTML = appState.links.map(l => \`<option value="\${l.slug}">/\${l.slug}</option>\`).join('');
      if (prev && appState.links.some(l => l.slug === prev)) select.value = prev; updateSimulatorCard();
    }

    function updateSimulatorCard() {
      const link = appState.links.find(l => l.slug === document.getElementById('simulator-slug-select').value);
      if (!link) return;
      document.getElementById('sim-domain').textContent = link.domain || window.location.host;
      document.getElementById('sim-og-title').textContent = link.ogTitle || 'Untitled';
      document.getElementById('sim-og-desc').textContent = link.ogDesc || '';
      document.getElementById('sim-og-img').src = link.ogImage ? (link.ogImage.startsWith('data:image') ? \`/api/og-image/\${link.slug}?v=\${link.id}\` : link.ogImage) : 'https://placehold.co/1200x630/09090b/ffffff.png?text=Preview';
    }

    function triggerSimulatedVisit(mode) {
      const slug = document.getElementById('simulator-slug-select').value;
      if (!slug) return;
      window.open(mode === 'bot' ? \`/\${slug}?bot_preview=1\` : \`/\${slug}\`, '_blank'); setTimeout(bootApp, 800);
    }

    function openCreateModal() { document.getElementById('form-error').classList.add('hidden'); document.getElementById('create-modal').classList.remove('hidden'); syncModalPreview(); }
    function closeCreateModal() { document.getElementById('create-modal').classList.add('hidden'); }
    function handleImageUrlInput() { uploadedBase64Image = ''; document.getElementById('form-og-image-file').value = ''; syncModalPreview(); }

    function handleBase64Upload(e) {
      const file = e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = function(evt) {
        const img = new Image();
        img.onload = function() {
          const canvas = document.createElement('canvas'); const scale = img.width > 1200 ? 1200 / img.width : 1;
          canvas.width = Math.round(img.width * scale); canvas.height = Math.round(img.height * scale);
          canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
          uploadedBase64Image = canvas.toDataURL('image/jpeg', 0.85);
          document.getElementById('form-og-image-url').value = ''; syncModalPreview();
        }; img.src = evt.target.result;
      }; reader.readAsDataURL(file);
    }

    function syncModalPreview() {
      document.getElementById('modal-preview-title').textContent = document.getElementById('form-og-title').value || 'Your OG Title';
      document.getElementById('modal-preview-desc').textContent = document.getElementById('form-og-desc').value || 'Description text here.';
      document.getElementById('modal-preview-domain').textContent = document.getElementById('form-domain').value || window.location.host;
      document.getElementById('modal-preview-img').src = uploadedBase64Image || document.getElementById('form-og-image-url').value || 'https://placehold.co/1200x630/09090b/ffffff.png?text=Upload+Preview+Image';
    }

    async function submitCreateLink(e) {
      e.preventDefault();
      const errBox = document.getElementById('form-error'); errBox.classList.add('hidden');
      const payload = {
        domain: document.getElementById('form-domain').value, slug: document.getElementById('form-slug').value,
        targetUrl: document.getElementById('form-target').value, safeUrl: document.getElementById('form-safe').value,
        ogTitle: document.getElementById('form-og-title').value, ogDesc: document.getElementById('form-og-desc').value,
        ogImage: uploadedBase64Image || document.getElementById('form-og-image-url').value
      };
      try {
        const res = await fetch('/api/create-link', { method: 'POST', headers: { 'Authorization': \`Bearer \${getToken()}\`, 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
        const data = await res.json();
        if (!res.ok || !data.success) { errBox.textContent = data.error || 'Error'; errBox.classList.remove('hidden'); return; }
        document.getElementById('create-link-form').reset(); uploadedBase64Image = ''; closeCreateModal();
        await bootApp(); copyToClipboard(data.shortUrl);
      } catch (err) { errBox.textContent = 'Network error.'; errBox.classList.remove('hidden'); }
    }

    async function deleteLink(slug) {
      if (!confirm(\`Delete /\${slug}?\`)) return;
      await fetch(\`/api/delete-link/\${slug}\`, { method: 'DELETE', headers: { 'Authorization': \`Bearer \${getToken()}\` } }); bootApp();
    }

    function copyToClipboard(text) {
      navigator.clipboard.writeText(text);
      const toast = document.getElementById('toast'); document.getElementById('toast-msg').textContent = 'Copied: ' + text;
      toast.classList.remove('hidden'); setTimeout(() => toast.classList.add('hidden'), 2500);
    }

    if (getToken()) bootApp();
  </script>
</body>
</html>`;
}

// BOOT
pullFromSupabase().then(() => {
  app.listen(PORT, () => { console.log(`🚀 NexLink Auth & Analytics Engine running on port ${PORT}`); });
});
