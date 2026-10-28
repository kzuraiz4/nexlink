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
  const accessibleLogs = memoryDB.logs.filter(log => accessibleLinkSlugs.has(log.slug)); 

  res.json({
    success: true,
    user: { email: user.email, role: user.role },
    cloud: { enabled: IS_SUPABASE_ENABLED, lastSync: lastCloudSync },
    links: accessibleLinks,
    logs: accessibleLogs,
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
    memoryDB.logs.unshift({ id: 'log_' + Date.now(), slug: link.slug, type: 'BOT', ip, timestamp: new Date().toISOString() });
    if (memoryDB.logs.length > 6000) memoryDB.logs.pop(); 
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
  memoryDB.logs.unshift({ id: 'log_' + Date.now(), slug: link.slug, type: 'HUMAN', ip, timestamp: new Date().toISOString() });
  if (memoryDB.logs.length > 6000) memoryDB.logs.pop();
  writeDB(memoryDB);
  return res.redirect(302, link.targetUrl);
});

// ==========================================
// 6. DASHBOARD SPA (Tabbed Multi-Page UI)
// ==========================================
function renderDashboardHTML() {
  return `<!DOCTYPE html>
<html lang="en" class="dark">
<head>
  <meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>NexLink.io — Performance Engine</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.1/css/all.min.css" />
  <style>
    @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap');
    body { font-family: 'Inter', sans-serif; background-color: #09090b; color: #fafafa; }
    .mono { font-family: 'JetBrains Mono', monospace; }
    ::-webkit-scrollbar { width: 5px; height: 5px; }
    ::-webkit-scrollbar-track { background: transparent; }
    ::-webkit-scrollbar-thumb { background: #27272a; border-radius: 9999px; }
    .nav-tab { border-bottom: 2px solid transparent; color: #a1a1aa; }
    .nav-tab.active { border-bottom-color: #34d399; color: #fafafa; }
    .page-section { display: none; }
    .page-section.active { display: block; }
  </style>
</head>
<body class="min-h-screen flex flex-col antialiased selection:bg-white selection:text-zinc-950">

  <!-- AUTHENTICATION -->
  <div id="auth-screen" class="fixed inset-0 z-[100] bg-zinc-950 flex flex-col items-center justify-center p-6">
    <div class="w-full max-w-sm bg-zinc-900/50 border border-zinc-800 rounded-2xl p-8">
      <div class="text-center mb-6">
        <div class="w-10 h-10 rounded-xl bg-white text-zinc-950 flex items-center justify-center font-bold text-lg mx-auto mb-3">N</div>
        <h1 class="text-xl font-bold text-white">NexLink.io Engine</h1>
        <p class="text-xs text-zinc-400 mt-1" id="auth-subtitle">Login to access your workspace</p>
      </div>
      <form id="auth-form" onsubmit="handleAuth(event)" class="space-y-4">
        <div><label class="block text-xs font-medium text-zinc-400 mb-1">Email</label><input type="email" id="auth-email" required class="w-full px-3 py-2 rounded-lg bg-zinc-950 border border-zinc-800 text-sm text-white focus:border-emerald-500 outline-none transition" /></div>
        <div><label class="block text-xs font-medium text-zinc-400 mb-1">Password</label><input type="password" id="auth-password" required class="w-full px-3 py-2 rounded-lg bg-zinc-950 border border-zinc-800 text-sm text-white focus:border-emerald-500 outline-none transition" /></div>
        <div id="auth-error" class="hidden text-xs text-rose-400 bg-rose-500/10 p-2.5 rounded-lg border border-rose-500/20 text-center"></div>
        <button type="submit" class="w-full py-2.5 rounded-lg bg-white text-zinc-950 text-sm font-semibold hover:bg-zinc-200 transition" id="auth-btn">Log In</button>
      </form>
      <div class="mt-5 text-center text-xs text-zinc-500"><button onclick="toggleAuthMode()" id="auth-toggle-btn" class="hover:text-white transition">Need an account? Sign up</button></div>
    </div>
  </div>

  <!-- MAIN APP CONTAINER -->
  <div id="app-screen" class="hidden flex-1 flex flex-col w-full">
    
    <header class="sticky top-0 z-30 bg-zinc-950/85 backdrop-blur-md border-b border-zinc-800/80">
      <div class="px-6 py-3 max-w-7xl mx-auto flex items-center justify-between">
        <div class="flex items-center gap-3">
          <div class="w-7 h-7 rounded-lg bg-white text-zinc-950 flex items-center justify-center font-bold text-xs">N</div>
          <div class="flex items-center gap-2">
            <span class="font-semibold text-sm tracking-tight text-white">NexLink.io</span>
            <span id="role-badge" class="text-[9px] mono px-2 py-0.5 rounded bg-zinc-900 border border-zinc-800 text-zinc-400 uppercase">Role</span>
          </div>
        </div>
        <div class="flex items-center gap-2.5">
          <div id="cloud-badge" class="hidden sm:flex items-center gap-2 px-2.5 py-1 rounded-md bg-zinc-900 border border-zinc-800 text-[11px] text-zinc-400">
            <span id="cloud-dot" class="w-1.5 h-1.5 rounded-full bg-emerald-400"></span><span id="cloud-status-text">Cloud Sync</span>
          </div>
          <button onclick="openCreateModal()" class="px-3.5 py-1.5 rounded-lg bg-white hover:bg-zinc-200 text-zinc-950 text-xs font-semibold transition flex items-center gap-1.5">
            <i class="fa-solid fa-plus text-[10px]"></i> New Link
          </button>
          <button onclick="logout()" class="px-3 py-1.5 rounded-lg bg-zinc-900 hover:bg-rose-500/20 text-zinc-400 hover:text-rose-400 text-xs font-medium border border-zinc-800 transition ml-2">
            <i class="fa-solid fa-right-from-bracket"></i>
          </button>
        </div>
      </div>
      <!-- Tab Navigation -->
      <div class="px-6 max-w-7xl mx-auto flex gap-6 text-xs font-medium">
        <button onclick="switchTab('overview')" id="tab-overview" class="nav-tab active pb-2.5 px-1 transition">Overview</button>
        <button onclick="switchTab('links')" id="tab-links" class="nav-tab pb-2.5 px-1 transition">Links</button>
        <button onclick="switchTab('domains')" id="tab-domains" class="nav-tab pb-2.5 px-1 transition hidden">Domains</button>
      </div>
    </header>

    <main class="flex-1 max-w-7xl w-full mx-auto px-6 py-6">

      <!-- ================= PAGE 1: OVERVIEW ================= -->
      <div id="page-overview" class="page-section active space-y-6">
        <div>
          <div class="flex items-center justify-between mb-3">
            <h2 class="text-sm font-semibold text-white">Performance Metrics</h2>
            <select id="kpi-timeframe" onchange="updateKPIsAndChart()" class="px-3 py-1.5 rounded-lg bg-zinc-950 border border-zinc-800 text-xs text-zinc-200 focus:outline-none">
              <option value="today">Today</option>
              <option value="yesterday">Yesterday</option>
              <option value="7days">Last 7 Days</option>
              <option value="30days">Last 30 Days</option>
              <option value="alltime" selected>All Time</option>
            </select>
          </div>
          <div class="grid grid-cols-2 lg:grid-cols-4 gap-4">
            <div class="bg-[#121214] border border-zinc-800/80 rounded-xl p-4 shadow-sm">
              <div class="flex items-center justify-between text-[11px] text-zinc-400 mb-2"><span class="font-medium">Total clicks</span><i class="fa-solid fa-arrow-pointer"></i></div>
              <div id="kpi-total" class="text-2xl font-bold text-white mt-1">0</div>
            </div>
            <div class="bg-[#121214] border border-zinc-800/80 rounded-xl p-4 shadow-sm">
              <div class="flex items-center justify-between text-[11px] text-zinc-400 mb-2"><span class="font-medium">Unique</span><i class="fa-solid fa-user-group"></i></div>
              <div id="kpi-unique" class="text-2xl font-bold text-white mt-1">0</div>
            </div>
            <div class="bg-[#121214] border border-zinc-800/80 rounded-xl p-4 shadow-sm">
              <div class="flex items-center justify-between text-[11px] text-zinc-400 mb-2"><span class="font-medium">Human</span><i class="fa-solid fa-user-check"></i></div>
              <div id="kpi-human" class="text-2xl font-bold text-white mt-1">0</div>
            </div>
            <div class="bg-[#121214] border border-zinc-800/80 rounded-xl p-4 shadow-sm">
              <div class="flex items-center justify-between text-[11px] text-zinc-400 mb-2"><span class="font-medium">Bots</span><i class="fa-solid fa-robot"></i></div>
              <div id="kpi-bots" class="text-2xl font-bold text-white mt-1">0</div>
            </div>
          </div>
        </div>

        <section class="bg-[#121214] border border-zinc-800/80 rounded-xl p-5 shadow-sm">
          <div class="flex items-center justify-between mb-4"><h2 class="text-sm font-semibold text-white">Click Volume Trend</h2></div>
          <div class="w-full h-56 relative"><canvas id="simpleAnalyticsChart"></canvas></div>
        </section>

        <section class="bg-[#121214] border border-zinc-800/80 rounded-xl p-5 flex flex-col shadow-sm">
          <div class="mb-4"><span class="text-[10px] mono uppercase text-zinc-500">System Info</span><h2 class="text-sm font-semibold text-white">Workspace Details</h2></div>
          <div class="space-y-3">
             <div class="flex justify-between text-xs border-b border-zinc-800/50 pb-2"><span class="text-zinc-400">Account Session</span><span id="session-email" class="text-white font-medium"></span></div>
             <div class="flex justify-between text-xs border-b border-zinc-800/50 pb-2"><span class="text-zinc-400">Role Authority</span><span id="session-role" class="text-emerald-400 font-medium uppercase"></span></div>
             <div class="flex justify-between text-xs pb-2"><span class="text-zinc-400">Database Sync Module</span><span id="storage-mode-label" class="text-white"></span></div>
          </div>
        </section>
      </div>

      <!-- ================= PAGE 2: LINKS (WITH CREATOR COL) ================= -->
      <div id="page-links" class="page-section space-y-6">
        <section class="bg-[#121214] border border-zinc-800/80 rounded-xl overflow-hidden shadow-sm flex flex-col">
          <div class="p-4 border-b border-zinc-800/80 flex flex-wrap justify-between items-center gap-3 bg-zinc-900/20">
            <h2 class="text-sm font-semibold text-white">Link Performance Activity</h2>
            <input id="search-links" oninput="renderLinksTable()" type="text" placeholder="Search title or domain..." class="px-3 py-1.5 rounded-lg bg-zinc-950 border border-zinc-800 text-xs text-zinc-200 focus:outline-none w-52" />
          </div>
          <div class="overflow-x-auto">
            <table class="w-full text-left border-collapse whitespace-nowrap">
              <thead class="bg-zinc-900/40">
                <tr class="text-[11px] font-semibold text-zinc-400 uppercase tracking-wide border-b border-zinc-800/80">
                  <th class="py-3 px-4">LINK / DESTINATION</th>
                  <th class="py-3 px-4">CREATOR</th>
                  <th class="py-3 px-4 text-center">Today</th>
                  <th class="py-3 px-4 text-center">Yesterday</th>
                  <th class="py-3 px-4 text-center">Last 7 days</th>
                  <th class="py-3 px-4 text-center">Last 15 days</th>
                  <th class="py-3 px-4 text-center">Last 30 days</th>
                  <th class="py-3 px-4 text-center">Last month</th>
                  <th class="py-3 px-4 text-center">All time</th>
                  <th class="py-3 px-4 text-center">Status</th>
                  <th class="py-3 px-4 text-right">Actions</th>
                </tr>
              </thead>
              <tbody id="links-table-body" class="divide-y divide-zinc-800/40 text-sm"></tbody>
            </table>
          </div>
        </section>

        <!-- Social Card Simulator integrated below the table -->
        <div class="bg-zinc-900/40 border border-zinc-800/80 rounded-xl p-5 flex flex-col max-w-sm">
          <div class="flex items-center justify-between mb-3">
            <div>
              <span class="text-[10px] mono uppercase text-zinc-500">Preview Verifier</span>
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
          <div class="grid grid-cols-2 gap-2 pt-3 border-t border-zinc-800/80">
            <button onclick="triggerSimulatedVisit('human')" class="px-2.5 py-1.5 rounded-lg bg-zinc-950 hover:bg-zinc-800 text-emerald-400 border border-zinc-800 text-[11px] font-medium transition">302 Human</button>
            <button onclick="triggerSimulatedVisit('bot')" class="px-2.5 py-1.5 rounded-lg bg-zinc-950 hover:bg-zinc-800 text-amber-400 border border-zinc-800 text-[11px] font-medium transition">OG Bot Card</button>
          </div>
        </div>
      </div>

      <!-- ================= PAGE 3: DOMAINS (Manager Only) ================= -->
      <div id="page-domains" class="page-section space-y-6">
        <div class="bg-[#121214] border border-zinc-800/80 rounded-xl p-5 shadow-sm max-w-3xl">
          <div class="mb-5 border-b border-zinc-800/80 pb-4">
            <span class="text-[10px] mono uppercase text-zinc-500">Domain Registry</span>
            <h2 class="text-sm font-semibold text-white mb-2">Custom Routing Domains</h2>
            <p class="text-xs text-zinc-400">Map custom domains to your links. Ensure DNS A-Records point to this Render server before adding.</p>
          </div>
          <div class="flex gap-2 mb-6">
            <input type="text" id="new-domain-input" placeholder="links.brand.com" class="flex-1 px-3 py-2 rounded-lg bg-zinc-950 border border-zinc-800 text-xs text-white focus:outline-none focus:border-zinc-600" />
            <button onclick="addCustomDomain()" class="px-4 py-2 rounded-lg bg-white text-zinc-950 text-xs font-semibold transition">Add Domain</button>
          </div>
          <div id="domains-list" class="space-y-2 text-xs"></div>
        </div>
      </div>

    </main>
  </div>

  <!-- MODAL: LINK CREATION -->
  <div id="create-modal" class="fixed inset-0 z-[110] hidden bg-black/80 backdrop-blur-sm flex items-center justify-center p-4 overflow-y-auto">
    <div class="bg-zinc-950 border border-zinc-800 rounded-2xl max-w-3xl w-full p-6 shadow-2xl my-8">
      <div class="flex items-center justify-between pb-4 border-b border-zinc-800">
        <div>
          <h3 class="text-sm font-semibold text-white">Create Permanent Cloaked Link</h3>
          <p class="text-xs text-zinc-400">Humans 302 redirect to Target URL. Bots render your OG image.</p>
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
            <label class="block text-[11px] text-emerald-400 mb-1">Destination Target URL (Humans) *</label>
            <input id="form-target" type="url" required class="w-full px-3 py-2 rounded-lg bg-zinc-900 border border-zinc-800 text-xs text-white focus:outline-none focus:border-emerald-500" />
          </div>
          <div>
            <label class="block text-[11px] text-amber-400 mb-1">Safe Page URL (Bots) *</label>
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
    let appState = { links: [], logs: [], cloud: {}, domains: [], user: null };
    let uploadedBase64Image = '';
    let isLoginMode = true;
    let simpleChartObj = null;

    // --- TAB SYSTEM ---
    function switchTab(tabId) {
      document.querySelectorAll('.nav-tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.page-section').forEach(p => p.classList.remove('active'));
      
      document.getElementById('tab-' + tabId).classList.add('active');
      document.getElementById('page-' + tabId).classList.add('active');
    }

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

    // --- APP BOOT ---
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
        
        document.getElementById('role-badge').textContent = appState.user.role;
        document.getElementById('session-email').textContent = appState.user.email;
        document.getElementById('session-role').textContent = appState.user.role;

        // Show/Hide Domains Tab based on Role
        if (appState.user.role === 'manager') {
          document.getElementById('tab-domains').classList.remove('hidden');
        } else {
          document.getElementById('tab-domains').classList.add('hidden');
        }

        if (appState.cloud && appState.cloud.enabled) {
          document.getElementById('cloud-dot').className = 'w-1.5 h-1.5 rounded-full bg-emerald-400';
          document.getElementById('cloud-status-text').textContent = 'Supabase Sync';
          document.getElementById('storage-mode-label').innerHTML = '<span class="text-emerald-400">Supabase Cloud</span> Active';
        }

        updateKPIsAndChart();
        renderLinksTable();
        populateDomainDropdown();
        renderDomainsList();
        populateSimulatorSelect();
      } catch (e) { console.error(e); }
    }

    // --- DATE UTILS & FILTERS ---
    function getFilteredLogs(rangeStr) {
      let start = new Date(); let end = new Date();
      if (rangeStr === 'today') { start.setHours(0,0,0,0); } 
      else if (rangeStr === 'yesterday') { start.setDate(start.getDate() - 1); start.setHours(0,0,0,0); end.setDate(end.getDate() - 1); end.setHours(23,59,59,999); } 
      else if (rangeStr === '7days') { start.setDate(start.getDate() - 7); start.setHours(0,0,0,0); } 
      else if (rangeStr === '15days') { start.setDate(start.getDate() - 15); start.setHours(0,0,0,0); } 
      else if (rangeStr === '30days') { start.setDate(start.getDate() - 30); start.setHours(0,0,0,0); } 
      else if (rangeStr === 'lastmonth') { 
        start.setMonth(start.getMonth() - 1); start.setDate(1); start.setHours(0,0,0,0);
        end = new Date(start.getFullYear(), start.getMonth() + 1, 0, 23, 59, 59, 999);
      }
      else return appState.logs; 

      return appState.logs.filter(l => { const d = new Date(l.timestamp); return d >= start && d <= end; });
    }

    // --- KPI & CHART UPDATE ---
    function updateKPIsAndChart() {
      const range = document.getElementById('kpi-timeframe').value;
      const logsToUse = getFilteredLogs(range);
      
      let total = logsToUse.length;
      let human = 0; let bots = 0;
      let uniqueIps = new Set();
      
      logsToUse.forEach(l => {
        if (l.type === 'HUMAN') human++; else bots++;
        if (l.ip) uniqueIps.add(l.ip);
      });

      if (range === 'alltime') {
        human = appState.links.reduce((acc, l) => acc + (l.humanClicks || 0), 0);
        bots = appState.links.reduce((acc, l) => acc + (l.botHits || 0), 0);
        total = human + bots;
      }

      document.getElementById('kpi-total').textContent = total.toLocaleString();
      document.getElementById('kpi-human').textContent = human.toLocaleString();
      document.getElementById('kpi-bots').textContent = bots.toLocaleString();
      document.getElementById('kpi-unique').textContent = uniqueIps.size.toLocaleString();

      renderSimpleChart(logsToUse, range);
    }

    function renderSimpleChart(logs, range) {
      const grouped = {};
      logs.forEach(log => {
        const d = new Date(log.timestamp);
        const key = (range === 'today' || range === 'yesterday') 
          ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) 
          : d.toLocaleDateString([], { month: 'short', day: 'numeric' });
        grouped[key] = (grouped[key] || 0) + 1;
      });

      const labels = Object.keys(grouped).sort((a,b) => {
        if(range === 'today' || range === 'yesterday') return a.localeCompare(b);
        return new Date(a + " " + new Date().getFullYear()) - new Date(b + " " + new Date().getFullYear());
      });
      const data = labels.map(l => grouped[l]);

      const ctx = document.getElementById('simpleAnalyticsChart').getContext('2d');
      if (simpleChartObj) simpleChartObj.destroy();
      
      Chart.defaults.color = '#71717a';
      Chart.defaults.font.family = 'Inter';
      
      let gradient = ctx.createLinearGradient(0, 0, 0, 300);
      gradient.addColorStop(0, 'rgba(255, 255, 255, 0.15)');
      gradient.addColorStop(1, 'rgba(255, 255, 255, 0)');

      simpleChartObj = new Chart(ctx, {
        type: 'line',
        data: { labels: labels, datasets: [{ label: 'Total Clicks', data: data, borderColor: '#ffffff', backgroundColor: gradient, borderWidth: 2, fill: true, tension: 0.4, pointRadius: 0, pointHoverRadius: 5 }] },
        options: {
          responsive: true, maintainAspectRatio: false,
          plugins: { legend: { display: false } },
          interaction: { intersect: false, mode: 'index' },
          scales: {
            y: { beginAtZero: true, grid: { color: '#27272a', drawBorder: false }, ticks: { precision: 0 } },
            x: { grid: { display: false } }
          }
        }
      });
    }

    // --- DETAILED ROUTING TABLE (WITH CREATOR) ---
    function getLinkClicksForTimeframe(slug, rangeStr) {
      const logs = getFilteredLogs(rangeStr);
      return logs.filter(l => l.slug === slug).length;
    }

    function renderLinksTable() {
      const tbody = document.getElementById('links-table-body');
      const filter = (document.getElementById('search-links').value || '').toLowerCase();
      const filtered = appState.links.filter(l => l.slug.toLowerCase().includes(filter) || (l.ogTitle || '').toLowerCase().includes(filter) || (l.creatorEmail || '').toLowerCase().includes(filter));
      
      if (!filtered.length) { tbody.innerHTML = '<tr><td colspan="11" class="py-12 text-center text-zinc-500">No matching links found.</td></tr>'; return; }

      tbody.innerHTML = filtered.map(link => {
        const shortUrl = \`\${link.domain}/\${link.slug}\`;
        const creator = link.creatorEmail || 'System';
        
        const today = getLinkClicksForTimeframe(link.slug, 'today');
        const yesterday = getLinkClicksForTimeframe(link.slug, 'yesterday');
        const d7 = getLinkClicksForTimeframe(link.slug, '7days');
        const d15 = getLinkClicksForTimeframe(link.slug, '15days');
        const d30 = getLinkClicksForTimeframe(link.slug, '30days');
        const lastm = getLinkClicksForTimeframe(link.slug, 'lastmonth');
        const allTime = (link.humanClicks || 0) + (link.botHits || 0);

        return \`
          <tr class="hover:bg-zinc-900/50 transition">
            <td class="py-4 px-4">
              <div class="font-bold text-base text-white mb-0.5">\${link.ogTitle || 'Untitled'}</div>
              <div class="text-emerald-400 text-xs font-mono mb-1 cursor-pointer hover:underline" onclick="copyToClipboard('https://\${shortUrl}')">\${shortUrl}</div>
              <div class="text-zinc-500 text-[10px] truncate max-w-xs" title="\${link.targetUrl}">↳ \${link.targetUrl}</div>
            </td>
            <td class="py-4 px-4">
              <div class="text-zinc-300 text-xs">\${creator}</div>
            </td>
            <td class="py-4 px-4 text-center font-bold text-white">\${today.toLocaleString()}</td>
            <td class="py-4 px-4 text-center font-bold text-white">\${yesterday.toLocaleString()}</td>
            <td class="py-4 px-4 text-center font-bold text-white">\${d7.toLocaleString()}</td>
            <td class="py-4 px-4 text-center font-bold text-white">\${d15.toLocaleString()}</td>
            <td class="py-4 px-4 text-center font-bold text-white">\${d30.toLocaleString()}</td>
            <td class="py-4 px-4 text-center font-bold text-white">\${lastm.toLocaleString()}</td>
            <td class="py-4 px-4 text-center font-bold text-white">\${allTime.toLocaleString()}</td>
            <td class="py-4 px-4 text-center">
              <span class="px-2 py-0.5 rounded text-[10px] font-medium border \${link.status === 'active' ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20' : 'bg-zinc-800 text-zinc-400 border-zinc-700'}">Active</span>
            </td>
            <td class="py-4 px-4 text-right">
              <button onclick="deleteLink('\${link.slug}')" class="px-3 py-1.5 rounded-lg bg-zinc-900 hover:bg-rose-500/20 text-zinc-400 hover:text-rose-400 text-xs border border-zinc-800 transition">Trash</button>
            </td>
          </tr>\`;
      }).join('');
    }

    // --- DOMAINS ---
    function populateDomainDropdown() {
      const select = document.getElementById('form-domain');
      let opts = \`<option value="\${window.location.host}">\${window.location.host}</option>\`;
      appState.domains.forEach(d => { opts += \`<option value="\${d.domain}">\${d.domain}</option>\`; });
      select.innerHTML = opts;
    }

    function renderDomainsList() {
      const container = document.getElementById('domains-list');
      if (!appState.domains.length) { container.innerHTML = '<div class="text-zinc-600 text-[11px] py-4">No custom domains added.</div>'; return; }
      container.innerHTML = appState.domains.map(d => \`<div class="px-4 py-3 rounded-xl bg-zinc-900/50 border border-zinc-800 flex items-center justify-between">
          <div><div class="text-zinc-200 text-sm font-medium">\${d.domain}</div><div class="text-[10px] text-zinc-500 mt-1">Added by \${d.addedBy}</div></div>
          \${appState.user.role === 'manager' ? \`<button onclick="deleteCustomDomain('\${d.domain}')" class="px-3 py-1.5 bg-rose-500/10 text-rose-400 rounded-lg hover:bg-rose-500/20 transition text-xs font-medium">Remove</button>\` : ''}
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

    // --- LINK CREATION ---
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
        await bootApp(); copyToClipboard('https://' + data.shortUrl);
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
    
    // --- SIMULATOR ---
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

    if (getToken()) bootApp();
  </script>
</body>
</html>`;
}

// BOOT
pullFromSupabase().then(() => {
  app.listen(PORT, () => { console.log(`🚀 NexLink Auth & Analytics Engine running on port ${PORT}`); });
});
