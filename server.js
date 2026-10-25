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
// 1. HYBRID STORAGE ENGINE (Supabase + db.json)
// ==========================================
// Upgraded Schema: Added 'users' and 'domains'
let memoryDB = { links: [], logs: [], users: [], domains: [] };
let lastCloudSync = null;

function initLocalDB() {
  if (!fs.existsSync(DB_FILE)) {
    fs.writeFileSync(DB_FILE, JSON.stringify(memoryDB, null, 2), 'utf8');
  } else {
    try {
      memoryDB = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
      // Backwards compatibility for existing DBs
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
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json',
        'Prefer': 'resolution=merge-duplicates'
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

// Middleware: Protect API Routes
function requireAuth(req, res, next) {
  const token = req.headers['authorization']?.split(' ')[1];
  if (!token) return res.status(401).json({ success: false, error: 'Unauthorized. Please log in.' });

  const user = memoryDB.users.find(u => u.token === token);
  if (!user) return res.status(401).json({ success: false, error: 'Invalid or expired session.' });

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

// AUTH: Sign Up
app.post('/api/auth/signup', (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ success: false, error: 'Email and password required.' });
  if (memoryDB.users.some(u => u.email === email)) return res.status(409).json({ success: false, error: 'Email already exists.' });

  // First user created is automatically the Manager. All subsequent users are Team Members.
  const role = memoryDB.users.length === 0 ? 'manager' : 'member';
  const token = generateToken();
  
  const newUser = {
    id: 'usr_' + Date.now(),
    email,
    passwordHash: hashPassword(password),
    role,
    token,
    createdAt: new Date().toISOString()
  };

  memoryDB.users.push(newUser);
  writeDB(memoryDB);

  res.json({ success: true, token, user: { id: newUser.id, email: newUser.email, role: newUser.role } });
});

// AUTH: Log In
app.post('/api/auth/login', (req, res) => {
  const { email, password } = req.body;
  const user = memoryDB.users.find(u => u.email === email);
  
  if (!user || !verifyPassword(password, user.passwordHash)) {
    return res.status(401).json({ success: false, error: 'Invalid credentials.' });
  }

  // Generate new session token on login
  user.token = generateToken();
  writeDB(memoryDB);

  res.json({ success: true, token: user.token, user: { id: user.id, email: user.email, role: user.role } });
});

// DATA: Fetch Dashboard Data (Role-Based)
app.get('/api/get-data', requireAuth, (req, res) => {
  const { user } = req;
  
  // Managers see ALL links. Team Members see ONLY their own links.
  // Existing legacy links (no userId) are visible to Managers.
  const accessibleLinks = user.role === 'manager' 
    ? memoryDB.links 
    : memoryDB.links.filter(l => l.userId === user.id);

  const totalHuman = accessibleLinks.reduce((acc, item) => acc + (item.humanClicks || 0), 0);
  const totalBot = accessibleLinks.reduce((acc, item) => acc + (item.botHits || 0), 0);

  // Filter logs to only show activity for accessible links
  const accessibleLinkSlugs = new Set(accessibleLinks.map(l => l.slug));
  const accessibleLogs = memoryDB.logs.filter(log => accessibleLinkSlugs.has(log.slug)).slice(0, 100);

  res.json({
    success: true,
    user: { email: user.email, role: user.role },
    cloud: { enabled: IS_SUPABASE_ENABLED, lastSync: lastCloudSync },
    stats: {
      totalLinks: accessibleLinks.length,
      totalHumanClicks: totalHuman,
      totalBotHits: totalBot
    },
    links: accessibleLinks,
    logs: accessibleLogs,
    domains: memoryDB.domains // Share approved custom domains
  });
});

// DOMAINS: Add Custom Domain (Manager Only)
app.post('/api/domains', requireAuth, (req, res) => {
  if (req.user.role !== 'manager') return res.status(403).json({ success: false, error: 'Only Managers can add custom domains.' });
  
  const { domain } = req.body;
  if (!domain) return res.status(400).json({ success: false, error: 'Domain required.' });
  
  const cleanDomain = domain.toLowerCase().trim().replace(/^https?:\/\//, '').replace(/\/$/, '');
  if (memoryDB.domains.some(d => d.domain === cleanDomain)) {
    return res.status(409).json({ success: false, error: 'Domain already registered.' });
  }

  memoryDB.domains.push({ id: 'dom_' + Date.now(), domain: cleanDomain, addedBy: req.user.email });
  writeDB(memoryDB);
  res.json({ success: true, domains: memoryDB.domains });
});

// LINKS: Create Cloaked Link (Tied to User)
app.post('/api/create-link', requireAuth, (req, res) => {
  const { slug, domain, targetUrl, safeUrl, ogTitle, ogDesc, ogImage } = req.body;
  if (!targetUrl) return res.status(400).json({ success: false, error: 'Target URL is required.' });

  let cleanSlug = (slug || '').trim().replace(/[^a-zA-Z0-9-_]/g, '') || Math.random().toString(36).substring(2, 8);
  if (['api', 'favicon.ico', 'robots.txt'].includes(cleanSlug.toLowerCase())) cleanSlug += `-${Math.floor(Math.random() * 999)}`;
  if (memoryDB.links.some(l => l.slug.toLowerCase() === cleanSlug.toLowerCase())) {
    return res.status(409).json({ success: false, error: `Slug "/${cleanSlug}" already exists.` });
  }

  const newLink = {
    id: 'lnk_' + Date.now(),
    userId: req.user.id,        // Ties link to the specific creator
    creatorEmail: req.user.email,
    slug: cleanSlug,
    domain: domain || req.get('host'),
    targetUrl: targetUrl.trim(),
    safeUrl: (safeUrl || 'https://en.wikipedia.org/wiki/Main_Page').trim(),
    ogTitle: (ogTitle || 'Featured Resource').trim(),
    ogDesc: (ogDesc || 'Click to view full details.').trim(),
    ogImage: ogImage || '',
    humanClicks: 0,
    botHits: 0,
    status: 'active',
    createdAt: new Date().toISOString()
  };

  memoryDB.links.unshift(newLink);
  writeDB(memoryDB);

  res.json({ success: true, link: newLink, shortUrl: `https://${newLink.domain}/${cleanSlug}` });
});

app.delete('/api/delete-link/:slug', requireAuth, (req, res) => {
  const linkIndex = memoryDB.links.findIndex(l => l.slug === req.params.slug);
  if (linkIndex === -1) return res.status(404).json({ success: false, error: 'Link not found' });
  
  // Members can only delete their own links. Managers can delete anything.
  if (req.user.role !== 'manager' && memoryDB.links[linkIndex].userId !== req.user.id) {
    return res.status(403).json({ success: false, error: 'Forbidden. You can only delete your own links.' });
  }

  memoryDB.links.splice(linkIndex, 1);
  writeDB(memoryDB);
  res.json({ success: true });
});

// Serving OG Images
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
app.get('/', (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(renderDashboardHTML());
});

app.get('/:slug', (req, res) => {
  const { slug } = req.params;
  if (slug === 'favicon.ico' || slug === 'robots.txt') return res.status(204).end();

  const linkIndex = memoryDB.links.findIndex(l => l.slug.toLowerCase() === slug.toLowerCase());
  if (linkIndex === -1) return res.status(404).send('404 - Link Not Found');

  const link = memoryDB.links[linkIndex];
  const ua = req.headers['user-agent'] || '';
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '0.0.0.0').split(',')[0].trim();
  const currentShortUrl = `https://${req.get('host')}/${link.slug}`;
  const botDetected = req.query.bot_preview === '1' || req.query.safe_redirect === '1' || isBotUserAgent(ua);

  if (botDetected) {
    memoryDB.links[linkIndex].botHits = (memoryDB.links[linkIndex].botHits || 0) + 1;
    memoryDB.logs.unshift({
      id: 'log_' + Date.now(), slug: link.slug, type: 'BOT', ua: ua.substring(0, 140), ip, action: `Cloaked -> Served OG Card`, timestamp: new Date().toISOString()
    });
    if (memoryDB.logs.length > 200) memoryDB.logs.pop();
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
<meta http-equiv="refresh" content="0;url=${escapeHtml(link.safeUrl)}" />
</head><body><script>window.location.replace("${escapeHtml(link.safeUrl)}");</script></body></html>`);
  }

  memoryDB.links[linkIndex].humanClicks = (memoryDB.links[linkIndex].humanClicks || 0) + 1;
  memoryDB.logs.unshift({ id: 'log_' + Date.now(), slug: link.slug, type: 'HUMAN', ua: ua.substring(0, 140), ip, action: `302 Redirect`, timestamp: new Date().toISOString() });
  if (memoryDB.logs.length > 200) memoryDB.logs.pop();
  writeDB(memoryDB);

  return res.redirect(302, link.targetUrl);
});

// ==========================================
// 6. DASHBOARD SPA (Contains Login & App UI)
// ==========================================
function renderDashboardHTML() {
  return `<!DOCTYPE html>
<html lang="en" class="dark">
<head>
  <meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>NexLink.io — Enterprise Cloaker</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.1/css/all.min.css" />
  <style>
    @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&family=JetBrains+Mono:wght@400;500&display=swap');
    body { font-family: 'Inter', sans-serif; background-color: #09090b; color: #fafafa; }
    .mono { font-family: 'JetBrains Mono', monospace; }
  </style>
</head>
<body class="min-h-screen flex flex-col antialiased">

  <!-- AUTHENTICATION OVERLAY -->
  <div id="auth-screen" class="fixed inset-0 z-[100] bg-zinc-950 flex flex-col items-center justify-center p-6">
    <div class="w-full max-w-sm bg-zinc-900 border border-zinc-800 rounded-2xl p-6">
      <div class="text-center mb-6">
        <h1 class="text-xl font-bold text-white">NexLink.io</h1>
        <p class="text-xs text-zinc-400 mt-1" id="auth-subtitle">Login to access your workspace</p>
      </div>
      
      <form id="auth-form" onsubmit="handleAuth(event)" class="space-y-4">
        <div>
          <label class="block text-xs font-medium text-zinc-400 mb-1">Email</label>
          <input type="email" id="auth-email" required class="w-full px-3 py-2 rounded-lg bg-zinc-950 border border-zinc-800 text-sm text-white focus:border-emerald-500 outline-none" />
        </div>
        <div>
          <label class="block text-xs font-medium text-zinc-400 mb-1">Password</label>
          <input type="password" id="auth-password" required class="w-full px-3 py-2 rounded-lg bg-zinc-950 border border-zinc-800 text-sm text-white focus:border-emerald-500 outline-none" />
        </div>
        <div id="auth-error" class="hidden text-xs text-rose-400 bg-rose-500/10 p-2 rounded border border-rose-500/20 text-center"></div>
        <button type="submit" class="w-full py-2.5 rounded-lg bg-white text-zinc-950 text-sm font-semibold hover:bg-zinc-200 transition" id="auth-btn">Log In</button>
      </form>
      
      <div class="mt-4 text-center text-xs text-zinc-500">
        <button onclick="toggleAuthMode()" id="auth-toggle-btn" class="hover:text-white transition">Need an account? Sign up</button>
      </div>
    </div>
  </div>

  <!-- MAIN APP CONTAINER (Hidden until authenticated) -->
  <div id="app-screen" class="hidden flex-1 flex flex-col">
    
    <header class="sticky top-0 z-30 bg-zinc-950/85 backdrop-blur-md border-b border-zinc-800/80 px-6 py-3">
      <div class="max-w-7xl mx-auto flex items-center justify-between">
        <div class="flex items-center gap-3">
          <div class="w-7 h-7 rounded-lg bg-white text-zinc-950 flex items-center justify-center font-bold text-xs">N</div>
          <div>
            <span class="font-semibold text-sm text-white">NexLink.io</span>
            <span id="user-role-badge" class="ml-2 text-[10px] mono px-2 py-0.5 rounded bg-zinc-900 border border-zinc-800 uppercase">Role</span>
          </div>
        </div>
        <div class="flex items-center gap-3">
          <button onclick="logout()" class="px-3 py-1.5 rounded-lg bg-zinc-900 hover:bg-zinc-800 text-zinc-300 text-xs font-medium border border-zinc-800">Logout</button>
          <button onclick="openCreateModal()" class="px-3.5 py-1.5 rounded-lg bg-white hover:bg-zinc-200 text-zinc-950 text-xs font-semibold">New Link</button>
        </div>
      </div>
    </header>

    <main class="flex-1 max-w-7xl w-full mx-auto px-6 py-6 space-y-6">
      
      <!-- STATS -->
      <section class="grid grid-cols-3 gap-3">
        <div class="bg-zinc-900/40 border border-zinc-800/80 rounded-xl p-4">
          <div class="text-[11px] text-zinc-500">Your Links</div>
          <div id="stat-total" class="text-2xl font-semibold text-white mt-1 mono">0</div>
        </div>
        <div class="bg-zinc-900/40 border border-zinc-800/80 rounded-xl p-4">
          <div class="text-[11px] text-zinc-500">Human Traffic (302)</div>
          <div id="stat-human" class="text-2xl font-semibold text-emerald-400 mt-1 mono">0</div>
        </div>
        <div class="bg-zinc-900/40 border border-zinc-800/80 rounded-xl p-4">
          <div class="text-[11px] text-zinc-500">Bots Cloaked</div>
          <div id="stat-bot" class="text-2xl font-semibold text-amber-400 mt-1 mono">0</div>
        </div>
      </section>

      <!-- DATA TABLE -->
      <section class="bg-zinc-900/40 border border-zinc-800/80 rounded-xl p-5">
        <div class="flex items-center justify-between mb-4">
          <h2 class="text-sm font-semibold text-white">Active Routing Table</h2>
          <input id="search-links" oninput="renderLinksTable()" type="text" placeholder="Search..." class="px-3 py-1.5 rounded-lg bg-zinc-950 border border-zinc-800 text-xs focus:outline-none w-52" />
        </div>
        <div class="overflow-x-auto">
          <table class="w-full text-left text-xs">
            <thead>
              <tr class="border-b border-zinc-800/70 text-[10px] text-zinc-500 uppercase">
                <th class="py-2.5 px-2">Slug</th>
                <th class="py-2.5 px-2">Target</th>
                <th class="py-2.5 px-2">Owner</th>
                <th class="py-2.5 px-2">Clicks</th>
                <th class="py-2.5 px-2 text-right">Actions</th>
              </tr>
            </thead>
            <tbody id="links-table-body" class="divide-y divide-zinc-800/40"></tbody>
          </table>
        </div>
      </section>

      <!-- CUSTOM DOMAINS (Manager Only) -->
      <section id="manager-domains-section" class="hidden bg-zinc-900/40 border border-zinc-800/80 rounded-xl p-5">
        <div class="flex items-center justify-between mb-4">
          <div>
            <h2 class="text-sm font-semibold text-white">Custom Domain Registry (Manager Only)</h2>
            <p class="text-[11px] text-zinc-400">Map custom domains to your links. Ensure DNS A-Records point to this Render server.</p>
          </div>
        </div>
        <div class="flex gap-2 mb-4">
          <input type="text" id="new-domain-input" placeholder="e.g., links.mycompany.com" class="px-3 py-2 rounded-lg bg-zinc-950 border border-zinc-800 text-xs w-64 focus:outline-none" />
          <button onclick="addCustomDomain()" class="px-3 py-2 rounded-lg bg-zinc-800 text-white text-xs font-medium">Add Domain</button>
        </div>
        <div id="domains-list" class="flex flex-wrap gap-2 text-xs"></div>
      </section>
    </main>
  </div>

  <!-- LINK CREATION MODAL -->
  <div id="create-modal" class="fixed inset-0 z-50 hidden bg-black/80 backdrop-blur-sm flex items-center justify-center p-4">
    <div class="bg-zinc-950 border border-zinc-800 rounded-xl w-full max-w-lg p-5">
      <h3 class="text-sm font-semibold text-white mb-4">Create Cloaked Link</h3>
      <form id="create-link-form" onsubmit="submitCreateLink(event)" class="space-y-3">
        <div class="grid grid-cols-2 gap-3">
          <div>
            <label class="block text-[11px] text-zinc-400 mb-1">Domain</label>
            <select id="form-domain" class="w-full px-3 py-2 rounded-lg bg-zinc-900 border border-zinc-800 text-xs outline-none"></select>
          </div>
          <div>
            <label class="block text-[11px] text-zinc-400 mb-1">Slug</label>
            <input id="form-slug" type="text" placeholder="auto-generated" class="w-full px-3 py-2 rounded-lg bg-zinc-900 border border-zinc-800 text-xs outline-none" />
          </div>
        </div>
        <div>
          <label class="block text-[11px] text-emerald-400 mb-1">Target URL (Humans)</label>
          <input id="form-target" type="url" required class="w-full px-3 py-2 rounded-lg bg-zinc-900 border border-zinc-800 text-xs outline-none" />
        </div>
        <div>
          <label class="block text-[11px] text-amber-400 mb-1">Safe URL (Bots)</label>
          <input id="form-safe" type="url" required class="w-full px-3 py-2 rounded-lg bg-zinc-900 border border-zinc-800 text-xs outline-none" />
        </div>
        <div class="flex justify-end gap-2 pt-3 border-t border-zinc-800">
          <button type="button" onclick="document.getElementById('create-modal').classList.add('hidden')" class="px-3 py-1.5 rounded-lg bg-zinc-900 text-xs">Cancel</button>
          <button type="submit" class="px-4 py-1.5 rounded-lg bg-white text-zinc-950 text-xs font-semibold">Save</button>
        </div>
      </form>
    </div>
  </div>

  <script>
    let appState = { links: [], domains: [], user: null };
    let isLoginMode = true;

    // --- AUTHENTICATION LOGIC ---
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
        const res = await fetch(endpoint, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email, password })
        });
        const data = await res.json();
        if (!data.success) throw new Error(data.error);
        
        setToken(data.token);
        bootApp();
      } catch (err) {
        errBox.textContent = err.message;
        errBox.classList.remove('hidden');
      }
    }

    function logout() {
      localStorage.removeItem('nexlink_token');
      document.getElementById('app-screen').classList.add('hidden');
      document.getElementById('auth-screen').classList.remove('hidden');
    }

    // --- CORE APP LOGIC ---
    async function bootApp() {
      const token = getToken();
      if (!token) return logout();

      try {
        const res = await fetch('/api/get-data', { headers: { 'Authorization': \`Bearer \${token}\` } });
        const data = await res.json();
        if (!res.ok) throw new Error();

        appState = data;
        document.getElementById('auth-screen').classList.add('hidden');
        document.getElementById('app-screen').classList.remove('hidden');
        
        // UI Role Customization
        document.getElementById('user-role-badge').textContent = data.user.role;
        document.getElementById('user-role-badge').className = data.user.role === 'manager' 
          ? 'ml-2 text-[10px] mono px-2 py-0.5 rounded bg-purple-500/20 text-purple-400 border border-purple-500/30 uppercase'
          : 'ml-2 text-[10px] mono px-2 py-0.5 rounded bg-blue-500/20 text-blue-400 border border-blue-500/30 uppercase';

        if (data.user.role === 'manager') {
          document.getElementById('manager-domains-section').classList.remove('hidden');
          renderDomains();
        }

        renderStats();
        renderLinksTable();
        populateDomainDropdown();
      } catch (err) { logout(); }
    }

    function renderStats() {
      document.getElementById('stat-total').textContent = appState.stats.totalLinks;
      document.getElementById('stat-human').textContent = appState.stats.totalHumanClicks;
      document.getElementById('stat-bot').textContent = appState.stats.totalBotHits;
    }

    function renderLinksTable() {
      const tbody = document.getElementById('links-table-body');
      const filter = (document.getElementById('search-links').value || '').toLowerCase();
      
      const html = appState.links.filter(l => l.slug.toLowerCase().includes(filter)).map(link => \`
        <tr class="hover:bg-zinc-900/60">
          <td class="py-3 px-2 font-medium mono text-white">/\${link.slug}</td>
          <td class="py-3 px-2 truncate max-w-[150px] text-emerald-400 text-[11px]">\${link.targetUrl}</td>
          <td class="py-3 px-2 text-[10px] text-zinc-500">\${link.creatorEmail || 'Admin'}</td>
          <td class="py-3 px-2 text-zinc-300 mono text-[10px]">H: \${link.humanClicks} | B: \${link.botHits}</td>
          <td class="py-3 px-2 text-right">
            <button onclick="deleteLink('\${link.slug}')" class="text-[10px] text-rose-400 hover:underline">Delete</button>
          </td>
        </tr>
      \`).join('');
      
      tbody.innerHTML = html || '<tr><td colspan="5" class="py-4 text-center text-zinc-500">No links found.</td></tr>';
    }

    function populateDomainDropdown() {
      const select = document.getElementById('form-domain');
      const host = window.location.host;
      let opts = \`<option value="\${host}">\${host}</option>\`;
      appState.domains.forEach(d => { opts += \`<option value="\${d.domain}">\${d.domain}</option>\`; });
      select.innerHTML = opts;
    }

    async function addCustomDomain() {
      const val = document.getElementById('new-domain-input').value;
      if (!val) return;
      
      const res = await fetch('/api/domains', {
        method: 'POST',
        headers: { 'Authorization': \`Bearer \${getToken()}\`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ domain: val })
      });
      if (res.ok) {
        document.getElementById('new-domain-input').value = '';
        bootApp();
      }
    }

    function renderDomains() {
      const container = document.getElementById('domains-list');
      container.innerHTML = appState.domains.map(d => \`
        <span class="px-2.5 py-1 rounded bg-zinc-950 border border-zinc-800 text-zinc-300 flex items-center gap-2">
          \${d.domain} <span class="text-[9px] text-zinc-600">by \${d.addedBy}</span>
        </span>
      \`).join('');
    }

    function openCreateModal() {
      document.getElementById('create-link-form').reset();
      document.getElementById('create-modal').classList.remove('hidden');
    }

    async function submitCreateLink(e) {
      e.preventDefault();
      const payload = {
        domain: document.getElementById('form-domain').value,
        slug: document.getElementById('form-slug').value,
        targetUrl: document.getElementById('form-target').value,
        safeUrl: document.getElementById('form-safe').value
      };
      
      const res = await fetch('/api/create-link', {
        method: 'POST',
        headers: { 'Authorization': \`Bearer \${getToken()}\`, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      if (res.ok) {
        document.getElementById('create-modal').classList.add('hidden');
        bootApp();
      } else {
        alert('Failed to create link');
      }
    }

    async function deleteLink(slug) {
      if(!confirm('Delete this link?')) return;
      await fetch(\`/api/delete-link/\${slug}\`, { method: 'DELETE', headers: { 'Authorization': \`Bearer \${getToken()}\` } });
      bootApp();
    }

    // Start App Check
    if (getToken()) bootApp();
  </script>
</body>
</html>`;
}

// BOOT
pullFromSupabase().then(() => {
  app.listen(PORT, () => { console.log(`🚀 NexLink Auth/Team Engine on port ${PORT}`); });
});
