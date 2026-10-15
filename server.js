const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const DB_FILE = path.join(__dirname, 'db.json');

// Middleware (50mb limit to support Base64 image uploads for OG tags)
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// ==========================================
// 1. PERSISTENT STORAGE ENGINE (db.json)
// ==========================================
function initDB() {
  if (!fs.existsSync(DB_FILE)) {
    const seedData = {
      links: [
        {
          id: 'lnk_demo_1',
          slug: 'promo-vip',
          domain: 'nexlink.io',
          targetUrl: 'https://example.com/exclusive-offer',
          safeUrl: 'https://en.wikipedia.org/wiki/Digital_marketing',
          ogTitle: 'Exclusive 2026 Enterprise Guide',
          ogDesc: 'Discover how leading brands optimize their conversion funnels with next-gen tools.',
          ogImage: 'https://images.unsplash.com/photo-1460925895917-afdab827c52f?auto=format&fit=crop&w=1200&q=80',
          humanClicks: 142,
          botHits: 38,
          status: 'active',
          createdAt: new Date(Date.now() - 86400000 * 2).toISOString()
        }
      ],
      logs: [
        {
          id: 'log_1',
          slug: 'promo-vip',
          type: 'BOT',
          ua: 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)',
          ip: '69.171.250.35',
          action: 'Cloaked -> Served OG & Safe URL',
          timestamp: new Date(Date.now() - 3600000).toISOString()
        },
        {
          id: 'log_2',
          slug: 'promo-vip',
          type: 'HUMAN',
          ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15',
          ip: '172.56.21.89',
          action: '302 Redirect -> Target URL',
          timestamp: new Date(Date.now() - 1800000).toISOString()
        }
      ]
    };
    fs.writeFileSync(DB_FILE, JSON.stringify(seedData, null, 2), 'utf8');
  }
}

function readDB() {
  initDB();
  try {
    const raw = fs.readFileSync(DB_FILE, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    console.error('Error reading db.json, resetting safe state:', err);
    return { links: [], logs: [] };
  }
}

function writeDB(data) {
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2), 'utf8');
  } catch (err) {
    console.error('Error writing to db.json:', err);
  }
}

// ==========================================
// 2. BOT & CRAWLER DETECTION ENGINE
// ==========================================
const BOT_SIGNATURES = [
  'facebookexternalhit',
  'facebot',
  'whatsapp',
  'twitterbot',
  'linkedinbot',
  'telegrambot',
  'discordbot',
  'slackbot',
  'pinterest',
  'googlebot',
  'bingbot',
  'yandexbot',
  'duckduckbot',
  'baiduspider',
  'ia_archiver',
  'skypeuripreview',
  'applebot',
  'embedly',
  'quora link preview',
  'outbrain',
  'vkshare',
  'w3c_validator',
  'redditbot',
  'rogerbot',
  'showyoubot'
];

function isBotUserAgent(ua) {
  if (!ua) return true; // Treat empty User-Agents as suspicious/bots
  const lowerUA = ua.toLowerCase();
  return BOT_SIGNATURES.some(bot => lowerUA.includes(bot));
}

function escapeHtml(str = '') {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// ==========================================
// 3. API ROUTES
// ==========================================

// Fetch all links, telemetry logs, and aggregated metrics
app.get('/api/get-data', (req, res) => {
  const db = readDB();
  const totalHuman = db.links.reduce((acc, item) => acc + (item.humanClicks || 0), 0);
  const totalBot = db.links.reduce((acc, item) => acc + (item.botHits || 0), 0);

  res.json({
    success: true,
    stats: {
      totalLinks: db.links.length,
      totalHumanClicks: totalHuman,
      totalBotHits: totalBot,
      totalTraffic: totalHuman + totalBot,
      cloakEfficiency: (totalHuman + totalBot) > 0 
        ? Math.round((totalBot / (totalHuman + totalBot)) * 100) 
        : 100
    },
    links: db.links,
    logs: db.logs.slice(0, 100)
  });
});

// Create or overwrite a cloaked short link
app.post('/api/create-link', (req, res) => {
  const {
    slug,
    domain,
    targetUrl,
    safeUrl,
    ogTitle,
    ogDesc,
    ogImage
  } = req.body;

  if (!targetUrl) {
    return res.status(400).json({ success: false, error: 'Destination Target URL is required.' });
  }

  const db = readDB();

  // Clean or auto-generate slug
  let cleanSlug = (slug || '').trim().replace(/[^a-zA-Z0-9-_]/g, '');
  if (!cleanSlug) {
    cleanSlug = Math.random().toString(36).substring(2, 8);
  }

  // Prevent reserved route collisions
  if (['api', 'favicon.ico', 'robots.txt'].includes(cleanSlug.toLowerCase())) {
    cleanSlug = `${cleanSlug}-${Math.floor(Math.random() * 999)}`;
  }

  // Check if slug already exists
  if (db.links.some(l => l.slug.toLowerCase() === cleanSlug.toLowerCase())) {
    return res.status(409).json({
      success: false,
      error: `Alias "/${cleanSlug}" is already in use. Choose another slug.`
    });
  }

  const protocol = req.headers['x-forwarded-proto'] || req.protocol || 'http';
  const host = req.get('host');
  const effectiveDomain = domain || host;

  const newLink = {
    id: 'lnk_' + Date.now(),
    slug: cleanSlug,
    domain: effectiveDomain,
    targetUrl: targetUrl.trim(),
    safeUrl: (safeUrl || 'https://www.google.com').trim(),
    ogTitle: (ogTitle || 'Check this out').trim(),
    ogDesc: (ogDesc || 'Click to view the full resource and details.').trim(),
    ogImage: ogImage || '',
    humanClicks: 0,
    botHits: 0,
    status: 'active',
    createdAt: new Date().toISOString()
  };

  db.links.unshift(newLink);
  writeDB(db);

  res.json({
    success: true,
    link: newLink,
    shortUrl: `${protocol}://${host}/${cleanSlug}`
  });
});

// Delete a link
app.delete('/api/delete-link/:slug', (req, res) => {
  const { slug } = req.params;
  const db = readDB();
  const initialLen = db.links.length;
  db.links = db.links.filter(l => l.slug !== slug);

  if (db.links.length === initialLen) {
    return res.status(404).json({ success: false, error: 'Link not found' });
  }

  writeDB(db);
  res.json({ success: true });
});

// Serve dynamic Base64 image as binary if a crawler requests it via URL
app.get('/api/og-image/:slug', (req, res) => {
  const db = readDB();
  const link = db.links.find(l => l.slug === req.params.slug);
  if (!link || !link.ogImage) {
    return res.redirect('https://placehold.co/1200x630/0f172a/38bdf8.png?text=NexLink.io');
  }

  if (link.ogImage.startsWith('data:image')) {
    const matches = link.ogImage.match(/^data:([A-Za-z-+\/]+);base64,(.+)$/);
    if (matches && matches.length === 3) {
      const contentType = matches[1];
      const buffer = Buffer.from(matches[2], 'base64');
      res.setHeader('Content-Type', contentType);
      res.setHeader('Cache-Control', 'public, max-age=86400');
      return res.send(buffer);
    }
  }

  return res.redirect(link.ogImage);
});

// ==========================================
// 4. MAIN DASHBOARD SPA ROUTE (GET /)
// ==========================================
app.get('/', (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(renderDashboardHTML());
});

// ==========================================
// 5. INTELLIGENT CLOAKING & ROUTING (GET /:slug)
// Placed BEFORE fallback routes as required
// ==========================================
app.get('/:slug', (req, res, next) => {
  const { slug } = req.params;
  if (slug === 'favicon.ico' || slug === 'robots.txt') return res.status(204).end();

  const db = readDB();
  const linkIndex = db.links.findIndex(l => l.slug.toLowerCase() === slug.toLowerCase());

  if (linkIndex === -1) {
    return res.status(404).send(`
      <!DOCTYPE html>
      <html class="dark">
      <head>
        <title>404 - Link Not Found | NexLink.io</title>
        <script src="https://cdn.tailwindcss.com"></script>
      </head>
      <body class="bg-slate-950 text-slate-100 min-h-screen flex items-center justify-center p-6">
        <div class="max-w-md w-full bg-slate-900 border border-slate-800 rounded-2xl p-8 text-center shadow-2xl">
          <div class="w-14 h-14 rounded-xl bg-rose-500/10 border border-rose-500/30 text-rose-400 flex items-center justify-center mx-auto mb-4 text-2xl font-bold">404</div>
          <h1 class="text-xl font-bold mb-2">Short Link Not Found</h1>
          <p class="text-slate-400 text-sm mb-6">The slug <code class="text-indigo-400">/${escapeHtml(slug)}</code> does not exist or has been removed.</p>
          <a href="/" class="inline-block px-5 py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-sm font-semibold transition">Return to NexLink Dashboard</a>
        </div>
      </body>
      </html>
    `);
  }

  const link = db.links[linkIndex];
  const ua = req.headers['user-agent'] || '';
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '0.0.0.0').split(',')[0].trim();
  const protocol = req.headers['x-forwarded-proto'] || req.protocol || 'http';
  const host = req.get('host');

  // Allow forcing bot preview mode via ?bot_preview=1 for testing inside the dashboard
  const forceBotPreview = req.query.bot_preview === '1';
  const botDetected = forceBotPreview || isBotUserAgent(ua);

  if (botDetected) {
    // 1. Increment Bot telemetry
    db.links[linkIndex].botHits = (db.links[linkIndex].botHits || 0) + 1;
    db.logs.unshift({
      id: 'log_' + Date.now(),
      slug: link.slug,
      type: 'BOT',
      ua: ua.substring(0, 140),
      ip,
      action: `Cloaked -> Served OG Meta + Safe URL (${link.safeUrl})`,
      timestamp: new Date().toISOString()
    });
    if (db.logs.length > 200) db.logs.pop();
    writeDB(db);

    // Resolve OG Image endpoint (so social scrapers always receive a valid HTTP image URL even if Base64 was uploaded)
    const ogImageUrl = link.ogImage
      ? (link.ogImage.startsWith('data:image') ? `${protocol}://${host}/api/og-image/${link.slug}` : link.ogImage)
      : 'https://placehold.co/1200x630/0f172a/6366f1.png?text=NexLink+Preview';

    // If the user agent is strictly a non-social search indexer with no OG need or if ?redirect_bot=302 is requested,
    // we still serve 200 OK with meta tags AND meta/JS redirect to Safe Page so Facebook/WhatsApp/Twitter scrape the OG tags first.
    res.status(200).setHeader('Content-Type', 'text/html; charset=utf-8').send(`<!DOCTYPE html>
<html lang="en" prefix="og: https://ogp.me/ns#">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${escapeHtml(link.ogTitle)}</title>
  <meta name="description" content="${escapeHtml(link.ogDesc)}" />

  <!-- Open Graph / Facebook / WhatsApp -->
  <meta property="og:type" content="website" />
  <meta property="og:url" content="${escapeHtml(link.safeUrl)}" />
  <meta property="og:title" content="${escapeHtml(link.ogTitle)}" />
  <meta property="og:description" content="${escapeHtml(link.ogDesc)}" />
  <meta property="og:image" content="${escapeHtml(ogImageUrl)}" />
  <meta property="og:image:width" content="1200" />
  <meta property="og:image:height" content="630" />

  <!-- Twitter Card -->
  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:title" content="${escapeHtml(link.ogTitle)}" />
  <meta name="twitter:description" content="${escapeHtml(link.ogDesc)}" />
  <meta name="twitter:image" content="${escapeHtml(ogImageUrl)}" />

  <link rel="canonical" href="${escapeHtml(link.safeUrl)}" />
  <meta http-equiv="refresh" content="0;url=${escapeHtml(link.safeUrl)}" />
</head>
<body style="background:#090d16;color:#94a3b8;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;">
  <script>window.location.replace(${JSON.stringify(link.safeUrl)});</script>
  <p>Redirecting to safe page... <a href="${escapeHtml(link.safeUrl)}" style="color:#6366f1;">Click here</a>.</p>
</body>
</html>`);
    return;
  }

  // 2. Real Human Traffic -> Instant 302 Redirect to Destination Target URL
  db.links[linkIndex].humanClicks = (db.links[linkIndex].humanClicks || 0) + 1;
  db.logs.unshift({
    id: 'log_' + Date.now(),
    slug: link.slug,
    type: 'HUMAN',
    ua: ua.substring(0, 140),
    ip,
    action: `302 Redirect -> Target (${link.targetUrl})`,
    timestamp: new Date().toISOString()
  });
  if (db.logs.length > 200) db.logs.pop();
  writeDB(db);

  return res.redirect(302, link.targetUrl);
});

// ==========================================
// 6. FRONTEND DASHBOARD UI TEMPLATE (12 MODULES)
// ==========================================
function renderDashboardHTML() {
  return `<!DOCTYPE html>
<html lang="en" class="dark">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>NexLink.io — Enterprise URL Shortener & Meta Cloaking Engine</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.1/css/all.min.css" />
  <script>
    tailwind.config = {
      darkMode: 'class',
      theme: {
        extend: {
          colors: {
            slate: {
              950: '#060911'
            }
          }
        }
      }
    }
  </script>
  <style>
    @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600&display=swap');
    body { font-family: 'Inter', sans-serif; }
    .mono { font-family: 'JetBrains Mono', monospace; }
    ::-webkit-scrollbar { width: 6px; height: 6px; }
    ::-webkit-scrollbar-track { background: #0f172a; }
    ::-webkit-scrollbar-thumb { background: #334155; border-radius: 9999px; }
    ::-webkit-scrollbar-thumb:hover { background: #475569; }
  </style>
</head>
<body class="bg-slate-950 text-slate-100 min-h-screen flex flex-col selection:bg-indigo-500 selection:text-white">

  <!-- TOP NAVIGATION BAR -->
  <header class="sticky top-0 z-30 bg-slate-900/80 backdrop-blur-md border-b border-slate-800/80 px-6 py-3.5">
    <div class="max-w-[1600px] mx-auto flex flex-wrap items-center justify-between gap-4">
      <div class="flex items-center gap-3">
        <div class="w-10 h-10 rounded-xl bg-gradient-to-br from-indigo-500 via-purple-500 to-cyan-400 flex items-center justify-center shadow-lg shadow-indigo-500/20">
          <i class="fa-solid fa-shield-halved text-white text-lg"></i>
        </div>
        <div>
          <div class="flex items-center gap-2">
            <span class="font-bold text-lg tracking-tight text-white">NexLink<span class="text-indigo-400">.io</span></span>
            <span class="text-[10px] uppercase tracking-wider font-semibold px-2 py-0.5 rounded-full bg-indigo-500/10 text-indigo-400 border border-indigo-500/30">Enterprise Cloaker v2.6</span>
          </div>
          <p class="text-xs text-slate-400">Real-Time Bot Filtering, OpenGraph Injection & 302 Traffic Router</p>
        </div>
      </div>

      <div class="flex items-center gap-3">
        <div class="hidden md:flex items-center gap-2 px-3 py-1.5 rounded-lg bg-slate-950 border border-slate-800 text-xs text-slate-400">
          <span class="w-2 h-2 rounded-full bg-emerald-400 animate-pulse"></span>
          <span>Cloaking Engine: <strong class="text-emerald-400">ONLINE</strong></span>
        </div>
        <button onclick="fetchDashboardData()" class="px-3.5 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-medium transition flex items-center gap-2 border border-slate-700">
          <i class="fa-solid fa-rotate"></i> Sync Data
        </button>
        <button onclick="openCreateModal()" class="px-4 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold transition flex items-center gap-2 shadow-lg shadow-indigo-600/25">
          <i class="fa-solid fa-plus"></i> Create Cloaked Link
        </button>
      </div>
    </div>
  </header>

  <!-- MAIN 12-MODULE ENTERPRISE ANALYTICS DASHBOARD -->
  <main class="flex-1 max-w-[1600px] w-full mx-auto p-6 space-y-6">

    <!-- MODULES 1 - 4: KPI TELEMETRY CARDS -->
    <section class="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
      <!-- Module 1: Active Short Links -->
      <div class="bg-slate-900/90 border border-slate-800/90 rounded-2xl p-5 flex items-center justify-between">
        <div>
          <span class="text-xs font-medium text-slate-400 uppercase tracking-wider">Module 01 • Active Campaigns</span>
          <h3 id="stat-total-links" class="text-3xl font-bold text-white mt-1">0</h3>
          <p class="text-xs text-emerald-400 mt-1 flex items-center gap-1">
            <i class="fa-solid fa-circle-check"></i> Persistent in db.json
          </p>
        </div>
        <div class="w-12 h-12 rounded-2xl bg-indigo-500/10 border border-indigo-500/20 flex items-center justify-center text-indigo-400 text-xl">
          <i class="fa-solid fa-link"></i>
        </div>
      </div>

      <!-- Module 2: Real Human Clicks (302 Target) -->
      <div class="bg-slate-900/90 border border-slate-800/90 rounded-2xl p-5 flex items-center justify-between">
        <div>
          <span class="text-xs font-medium text-slate-400 uppercase tracking-wider">Module 02 • Real Human Clicks</span>
          <h3 id="stat-human-clicks" class="text-3xl font-bold text-emerald-400 mt-1">0</h3>
          <p class="text-xs text-slate-400 mt-1">302 Redirected to Target URL</p>
        </div>
        <div class="w-12 h-12 rounded-2xl bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center text-emerald-400 text-xl">
          <i class="fa-solid fa-user-check"></i>
        </div>
      </div>

      <!-- Module 3: Bot & Crawler Hits Cloaked -->
      <div class="bg-slate-900/90 border border-slate-800/90 rounded-2xl p-5 flex items-center justify-between">
        <div>
          <span class="text-xs font-medium text-slate-400 uppercase tracking-wider">Module 03 • Bots Intercepted</span>
          <h3 id="stat-bot-hits" class="text-3xl font-bold text-amber-400 mt-1">0</h3>
          <p class="text-xs text-slate-400 mt-1">Served OG Meta + Safe Page</p>
        </div>
        <div class="w-12 h-12 rounded-2xl bg-amber-500/10 border border-amber-500/20 flex items-center justify-center text-amber-400 text-xl">
          <i class="fa-solid fa-robot"></i>
        </div>
      </div>

      <!-- Module 4: Shield Protection Rate -->
      <div class="bg-slate-900/90 border border-slate-800/90 rounded-2xl p-5 flex items-center justify-between">
        <div>
          <span class="text-xs font-medium text-slate-400 uppercase tracking-wider">Module 04 • Cloak Shield Ratio</span>
          <h3 id="stat-efficiency" class="text-3xl font-bold text-cyan-400 mt-1">100%</h3>
          <p class="text-xs text-slate-400 mt-1">Zero Target URL Leakage</p>
        </div>
        <div class="w-12 h-12 rounded-2xl bg-cyan-500/10 border border-cyan-500/20 flex items-center justify-center text-cyan-400 text-xl">
          <i class="fa-solid fa-shield-virus"></i>
        </div>
      </div>
    </section>

    <!-- MODULES 5 & 6: CAMPAIGN TABLE + SOCIAL CRAWLER SIMULATOR -->
    <section class="grid grid-cols-1 lg:grid-cols-3 gap-6">
      
      <!-- Module 5: Active Cloaked Links Manager (Spans 2 columns) -->
      <div class="lg:col-span-2 bg-slate-900/90 border border-slate-800/90 rounded-2xl p-5 flex flex-col">
        <div class="flex flex-wrap items-center justify-between gap-3 mb-4">
          <div>
            <span class="text-[11px] font-semibold uppercase tracking-wider text-indigo-400">Module 05 • Routing Table</span>
            <h2 class="text-base font-bold text-white">Active Cloaked Links & Traffic Split</h2>
          </div>
          <div class="flex items-center gap-2">
            <input id="search-links" oninput="renderLinksTable()" type="text" placeholder="Filter by slug or target..." class="px-3 py-1.5 rounded-xl bg-slate-950 border border-slate-800 text-xs text-slate-200 focus:outline-none focus:border-indigo-500" />
            <button onclick="openCreateModal()" class="px-3 py-1.5 rounded-xl bg-indigo-600/20 hover:bg-indigo-600/30 text-indigo-300 border border-indigo-500/30 text-xs font-medium transition">
              + New Link
            </button>
          </div>
        </div>

        <div class="overflow-x-auto flex-1">
          <table class="w-full text-left border-collapse">
            <thead>
              <tr class="border-b border-slate-800 text-[11px] text-slate-400 uppercase">
                <th class="py-3 px-3">Short Link / Slug</th>
                <th class="py-3 px-3">Routing (Target vs Safe)</th>
                <th class="py-3 px-3">OG Social Card</th>
                <th class="py-3 px-3 text-center">Humans</th>
                <th class="py-3 px-3 text-center">Bots</th>
                <th class="py-3 px-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody id="links-table-body" class="divide-y divide-slate-800/60 text-xs">
              <!-- Populated by JS -->
            </tbody>
          </table>
        </div>
      </div>

      <!-- Module 6: Live Bot vs Human Inspector & Tester -->
      <div class="bg-slate-900/90 border border-slate-800/90 rounded-2xl p-5 flex flex-col justify-between">
        <div>
          <span class="text-[11px] font-semibold uppercase tracking-wider text-amber-400">Module 06 • Cloaking Verifier</span>
          <h2 class="text-base font-bold text-white mb-1">Bot vs. Human Route Simulator</h2>
          <p class="text-xs text-slate-400 mb-4">Select any active slug to preview how social bots scrape your OpenGraph metadata vs. where real visitors land.</p>

          <label class="block text-xs font-medium text-slate-300 mb-1">Select Active Slug</label>
          <select id="simulator-slug-select" onchange="updateSimulatorCard()" class="w-full px-3 py-2 rounded-xl bg-slate-950 border border-slate-800 text-xs text-white mb-4 focus:outline-none focus:border-indigo-500">
            <!-- Populated dynamically -->
          </select>

          <!-- Simulated Social Preview Card -->
          <div class="rounded-xl overflow-hidden border border-slate-800 bg-slate-950 mb-4">
            <div class="h-36 bg-slate-900 relative overflow-hidden flex items-center justify-center">
              <img id="sim-og-img" src="https://placehold.co/1200x630/0f172a/6366f1.png?text=NexLink+Preview" alt="OG Preview" class="w-full h-full object-cover" />
              <span class="absolute top-2 right-2 text-[10px] font-semibold px-2 py-0.5 rounded bg-black/70 text-amber-300 border border-amber-500/30">
                Bot View (200 OK + OG)
              </span>
            </div>
            <div class="p-3">
              <div id="sim-domain" class="text-[10px] uppercase tracking-wider text-slate-400 mono truncate">nexlink.io</div>
              <div id="sim-og-title" class="text-sm font-bold text-white truncate mt-0.5">Select a link</div>
              <div id="sim-og-desc" class="text-xs text-slate-400 line-clamp-2 mt-0.5">OpenGraph description will render here.</div>
            </div>
          </div>
        </div>

        <div class="grid grid-cols-2 gap-2 pt-2 border-t border-slate-800">
          <button onclick="triggerSimulatedVisit('human')" class="px-3 py-2 rounded-xl bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 text-xs font-semibold transition flex items-center justify-center gap-1.5">
            <i class="fa-solid fa-user"></i> Test Human (302)
          </button>
          <button onclick="triggerSimulatedVisit('bot')" class="px-3 py-2 rounded-xl bg-amber-500/10 hover:bg-amber-500/20 text-amber-300 border border-amber-500/30 text-xs font-semibold transition flex items-center justify-center gap-1.5">
            <i class="fa-solid fa-robot"></i> Test Bot Meta
          </button>
        </div>
      </div>

    </section>

    <!-- MODULES 7, 8, 9: REAL-TIME LOGS, BOT SIGNATURES, TRAFFIC SPLIT -->
    <section class="grid grid-cols-1 lg:grid-cols-3 gap-6">

      <!-- Module 7: Live Traffic & Bot Interception Stream -->
      <div class="bg-slate-900/90 border border-slate-800/90 rounded-2xl p-5 flex flex-col h-[340px]">
        <div class="flex items-center justify-between mb-3">
          <div>
            <span class="text-[11px] font-semibold uppercase tracking-wider text-cyan-400">Module 07 • Live Telemetry</span>
            <h2 class="text-base font-bold text-white">Real-Time Interception Log</h2>
          </div>
          <span class="text-[10px] px-2 py-0.5 rounded bg-slate-800 text-slate-300 mono">Last 100 Hits</span>
        </div>
        <div id="logs-container" class="flex-1 overflow-y-auto space-y-2 pr-1">
          <!-- Populated by JS -->
        </div>
      </div>

      <!-- Module 8: Active Crawler Fingerprint Matrix -->
      <div class="bg-slate-900/90 border border-slate-800/90 rounded-2xl p-5 flex flex-col h-[340px]">
        <div class="mb-3">
          <span class="text-[11px] font-semibold uppercase tracking-wider text-purple-400">Module 08 • WAF Ruleset</span>
          <h2 class="text-base font-bold text-white">Social Crawler Signatures</h2>
          <p class="text-xs text-slate-400">User-Agents automatically routed to Safe URL with custom OpenGraph tags:</p>
        </div>
        <div class="flex-1 overflow-y-auto grid grid-cols-2 gap-2 pr-1 text-xs">
          <div class="p-2.5 rounded-xl bg-slate-950 border border-slate-800 flex items-center gap-2">
            <i class="fa-brands fa-facebook text-blue-400 text-base"></i>
            <div>
              <div class="font-semibold text-slate-200">FacebookHit</div>
              <div class="text-[10px] text-emerald-400">Cloak Active</div>
            </div>
          </div>
          <div class="p-2.5 rounded-xl bg-slate-950 border border-slate-800 flex items-center gap-2">
            <i class="fa-brands fa-whatsapp text-emerald-400 text-base"></i>
            <div>
              <div class="font-semibold text-slate-200">WhatsApp Bot</div>
              <div class="text-[10px] text-emerald-400">Cloak Active</div>
            </div>
          </div>
          <div class="p-2.5 rounded-xl bg-slate-950 border border-slate-800 flex items-center gap-2">
            <i class="fa-brands fa-x-twitter text-slate-200 text-base"></i>
            <div>
              <div class="font-semibold text-slate-200">Twitterbot</div>
              <div class="text-[10px] text-emerald-400">Cloak Active</div>
            </div>
          </div>
          <div class="p-2.5 rounded-xl bg-slate-950 border border-slate-800 flex items-center gap-2">
            <i class="fa-brands fa-google text-amber-400 text-base"></i>
            <div>
              <div class="font-semibold text-slate-200">Googlebot</div>
              <div class="text-[10px] text-emerald-400">Cloak Active</div>
            </div>
          </div>
          <div class="p-2.5 rounded-xl bg-slate-950 border border-slate-800 flex items-center gap-2">
            <i class="fa-brands fa-telegram text-sky-400 text-base"></i>
            <div>
              <div class="font-semibold text-slate-200">TelegramBot</div>
              <div class="text-[10px] text-emerald-400">Cloak Active</div>
            </div>
          </div>
          <div class="p-2.5 rounded-xl bg-slate-950 border border-slate-800 flex items-center gap-2">
            <i class="fa-brands fa-linkedin text-blue-500 text-base"></i>
            <div>
              <div class="font-semibold text-slate-200">LinkedInBot</div>
              <div class="text-[10px] text-emerald-400">Cloak Active</div>
            </div>
          </div>
          <div class="p-2.5 rounded-xl bg-slate-950 border border-slate-800 flex items-center gap-2">
            <i class="fa-brands fa-discord text-indigo-400 text-base"></i>
            <div>
              <div class="font-semibold text-slate-200">Discordbot</div>
              <div class="text-[10px] text-emerald-400">Cloak Active</div>
            </div>
          </div>
          <div class="p-2.5 rounded-xl bg-slate-950 border border-slate-800 flex items-center gap-2">
            <i class="fa-brands fa-slack text-pink-400 text-base"></i>
            <div>
              <div class="font-semibold text-slate-200">Slackbot</div>
              <div class="text-[10px] text-emerald-400">Cloak Active</div>
            </div>
          </div>
        </div>
      </div>

      <!-- Module 9: Traffic Distribution & Ratio Visualizer -->
      <div class="bg-slate-900/90 border border-slate-800/90 rounded-2xl p-5 flex flex-col justify-between h-[340px]">
        <div>
          <span class="text-[11px] font-semibold uppercase tracking-wider text-emerald-400">Module 09 • Traffic Analytics</span>
          <h2 class="text-base font-bold text-white mb-1">Human vs. Crawler Split</h2>
          <p class="text-xs text-slate-400 mb-6">Real-time breakdown of incoming requests across all active short links.</p>

          <div class="space-y-4">
            <div>
              <div class="flex justify-between text-xs mb-1">
                <span class="text-emerald-400 font-medium"><i class="fa-solid fa-user mr-1"></i> Human Visitors (302 Target)</span>
                <span id="bar-human-label" class="mono text-slate-300">0%</span>
              </div>
              <div class="w-full h-3 rounded-full bg-slate-950 overflow-hidden border border-slate-800">
                <div id="bar-human" class="h-full bg-emerald-500 transition-all duration-500" style="width: 50%"></div>
              </div>
            </div>

            <div>
              <div class="flex justify-between text-xs mb-1">
                <span class="text-amber-400 font-medium"><i class="fa-solid fa-robot mr-1"></i> Social Scrapers & Bots (Safe Page)</span>
                <span id="bar-bot-label" class="mono text-slate-300">0%</span>
              </div>
              <div class="w-full h-3 rounded-full bg-slate-950 overflow-hidden border border-slate-800">
                <div id="bar-bot" class="h-full bg-amber-500 transition-all duration-500" style="width: 50%"></div>
              </div>
            </div>
          </div>
        </div>

        <div class="p-3.5 rounded-xl bg-slate-950 border border-slate-800 flex items-center justify-between">
          <div class="text-xs">
            <div class="text-slate-400">Routing Architecture</div>
            <div class="text-white font-semibold mt-0.5">Express <code class="text-indigo-400">/:slug</code> Pre-Static Interceptor</div>
          </div>
          <span class="px-2.5 py-1 rounded-lg bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 text-[11px] font-semibold">302 Instant</span>
        </div>
      </div>

    </section>

    <!-- MODULES 10, 11, 12: DOMAIN ROUTER, STORAGE ENGINE, API HEALTH -->
    <section class="grid grid-cols-1 md:grid-cols-3 gap-6">

      <!-- Module 10: Domain Prefix Registry -->
      <div class="bg-slate-900/90 border border-slate-800/90 rounded-2xl p-5">
        <span class="text-[11px] font-semibold uppercase tracking-wider text-indigo-400">Module 10 • Domain Registry</span>
        <h2 class="text-base font-bold text-white mt-0.5 mb-2">Configured Domain Prefixes</h2>
        <p class="text-xs text-slate-400 mb-3">Select any domain prefix when generating links in the creation modal.</p>
        <div class="space-y-2 text-xs">
          <div class="flex items-center justify-between px-3 py-2 rounded-xl bg-slate-950 border border-slate-800">
            <span class="mono text-slate-200" id="current-host-domain">render-host.onrender.com</span>
            <span class="text-[10px] px-2 py-0.5 rounded bg-emerald-500/10 text-emerald-400 border border-emerald-500/30">Primary Host</span>
          </div>
          <div class="flex items-center justify-between px-3 py-2 rounded-xl bg-slate-950 border border-slate-800">
            <span class="mono text-slate-200">nexlink.io</span>
            <span class="text-[10px] px-2 py-0.5 rounded bg-indigo-500/10 text-indigo-400 border border-indigo-500/30">Alias Ready</span>
          </div>
          <div class="flex items-center justify-between px-3 py-2 rounded-xl bg-slate-950 border border-slate-800">
            <span class="mono text-slate-200">go.nexlink.io</span>
            <span class="text-[10px] px-2 py-0.5 rounded bg-indigo-500/10 text-indigo-400 border border-indigo-500/30">Alias Ready</span>
          </div>
        </div>
      </div>

      <!-- Module 11: Persistent db.json Storage Inspector -->
      <div class="bg-slate-900/90 border border-slate-800/90 rounded-2xl p-5 flex flex-col justify-between">
        <div>
          <span class="text-[11px] font-semibold uppercase tracking-wider text-emerald-400">Module 11 • Persistence Layer</span>
          <h2 class="text-base font-bold text-white mt-0.5 mb-2">Local <code class="text-emerald-400">db.json</code> File Engine</h2>
          <p class="text-xs text-slate-400 mb-4">All link configurations, Base64 OpenGraph images, and click counters are safely synchronized to disk.</p>
        </div>
        <div class="flex items-center justify-between pt-3 border-t border-slate-800">
          <div class="text-xs text-slate-400">
            Storage Mode: <strong class="text-white">Synchronous JSON FS</strong>
          </div>
          <button onclick="exportDatabaseJSON()" class="px-3 py-1.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-xs font-medium text-slate-200 border border-slate-700 transition flex items-center gap-1.5">
            <i class="fa-solid fa-download"></i> Export JSON
          </button>
        </div>
      </div>

      <!-- Module 12: API Endpoint & Render Health Diagnostics -->
      <div class="bg-slate-900/90 border border-slate-800/90 rounded-2xl p-5 flex flex-col justify-between">
        <div>
          <span class="text-[11px] font-semibold uppercase tracking-wider text-cyan-400">Module 12 • System Diagnostics</span>
          <h2 class="text-base font-bold text-white mt-0.5 mb-2">Core Express Endpoints</h2>
          <div class="space-y-1.5 text-xs mono">
            <div class="flex items-center justify-between px-2.5 py-1.5 rounded bg-slate-950 border border-slate-800">
              <span class="text-emerald-400">POST /api/create-link</span>
              <span class="text-slate-400">200 OK</span>
            </div>
            <div class="flex items-center justify-between px-2.5 py-1.5 rounded bg-slate-950 border border-slate-800">
              <span class="text-cyan-400">GET /api/get-data</span>
              <span class="text-slate-400">200 OK</span>
            </div>
            <div class="flex items-center justify-between px-2.5 py-1.5 rounded bg-slate-950 border border-slate-800">
              <span class="text-amber-400">GET /:slug</span>
              <span class="text-slate-400">302 / Cloak</span>
            </div>
          </div>
        </div>
      </div>

    </section>
  </main>

  <!-- ========================================== -->
  <!-- LINK CREATION MODAL (WITH LIVE OG PREVIEW) -->
  <!-- ========================================== -->
  <div id="create-modal" class="fixed inset-0 z-50 hidden bg-black/75 backdrop-blur-sm flex items-center justify-center p-4 overflow-y-auto">
    <div class="bg-slate-900 border border-slate-800 rounded-2xl max-w-4xl w-full p-6 shadow-2xl my-8">
      <div class="flex items-center justify-between pb-4 border-b border-slate-800">
        <div class="flex items-center gap-2.5">
          <div class="w-9 h-9 rounded-xl bg-indigo-600/20 border border-indigo-500/30 flex items-center justify-center text-indigo-400">
            <i class="fa-solid fa-wand-magic-sparkles"></i>
          </div>
          <div>
            <h3 class="text-base font-bold text-white">Create Cloaked Short Link</h3>
            <p class="text-xs text-slate-400">Configure human destination, bot safe page, and social OpenGraph card.</p>
          </div>
        </div>
        <button onclick="closeCreateModal()" class="w-8 h-8 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-400 hover:text-white flex items-center justify-center">
          <i class="fa-solid fa-xmark"></i>
        </button>
      </div>

      <form id="create-link-form" onsubmit="submitCreateLink(event)" class="grid grid-cols-1 lg:grid-cols-12 gap-6 mt-5">
        <!-- Left Column: Form Inputs (7 cols) -->
        <div class="lg:col-span-7 space-y-4">
          
          <!-- Domain Prefix + Custom Slug -->
          <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label class="block text-xs font-medium text-slate-300 mb-1">Domain Prefix</label>
              <select id="form-domain" class="w-full px-3 py-2 rounded-xl bg-slate-950 border border-slate-800 text-xs text-white focus:outline-none focus:border-indigo-500">
                <!-- Populated with current host + custom domains -->
              </select>
            </div>
            <div>
              <label class="block text-xs font-medium text-slate-300 mb-1">Custom Alias / Slug</label>
              <div class="flex items-center">
                <span class="px-2.5 py-2 rounded-l-xl bg-slate-800 border border-r-0 border-slate-700 text-xs text-slate-400 mono">/</span>
                <input id="form-slug" type="text" placeholder="vip-offer-2026" class="w-full px-3 py-2 rounded-r-xl bg-slate-950 border border-slate-800 text-xs text-white focus:outline-none focus:border-indigo-500 mono" />
              </div>
            </div>
          </div>

          <!-- Destination Target URL (Real Humans) -->
          <div>
            <label class="block text-xs font-medium text-emerald-400 mb-1">
              <i class="fa-solid fa-user-check mr-1"></i> Destination Target URL (Real Human Visitors -> 302 Redirect) *
            </label>
            <input id="form-target" type="url" required placeholder="https://your-real-money-page.com/landing" class="w-full px-3 py-2 rounded-xl bg-slate-950 border border-slate-800 text-xs text-white focus:outline-none focus:border-emerald-500" />
          </div>

          <!-- Safe Page URL (Bots & Crawlers) -->
          <div>
            <label class="block text-xs font-medium text-amber-400 mb-1">
              <i class="fa-solid fa-robot mr-1"></i> Safe Page URL (Bots, Reviewers & Social Crawlers) *
            </label>
            <input id="form-safe" type="url" required placeholder="https://en.wikipedia.org/wiki/Cloud_computing" class="w-full px-3 py-2 rounded-xl bg-slate-950 border border-slate-800 text-xs text-white focus:outline-none focus:border-amber-500" />
          </div>

          <!-- Social Open Graph Metadata -->
          <div class="pt-2 border-t border-slate-800 space-y-3">
            <div class="text-xs font-semibold text-indigo-400 uppercase tracking-wider">Social Preview Metadata (Open Graph)</div>
            
            <div>
              <label class="block text-xs font-medium text-slate-300 mb-1">OG Title</label>
              <input id="form-og-title" oninput="syncModalPreview()" type="text" placeholder="Exclusive 50% Partner Access" class="w-full px-3 py-2 rounded-xl bg-slate-950 border border-slate-800 text-xs text-white focus:outline-none focus:border-indigo-500" />
            </div>

            <div>
              <label class="block text-xs font-medium text-slate-300 mb-1">OG Description</label>
              <textarea id="form-og-desc" oninput="syncModalPreview()" rows="2" placeholder="Click to verify your invitation and access the private dashboard." class="w-full px-3 py-2 rounded-xl bg-slate-950 border border-slate-800 text-xs text-white focus:outline-none focus:border-indigo-500"></textarea>
            </div>

            <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label class="block text-xs font-medium text-slate-300 mb-1">Custom Image URL</label>
                <input id="form-og-image-url" oninput="handleImageUrlInput()" type="url" placeholder="https://example.com/banner.jpg" class="w-full px-3 py-2 rounded-xl bg-slate-950 border border-slate-800 text-xs text-white focus:outline-none focus:border-indigo-500" />
              </div>
              <div>
                <label class="block text-xs font-medium text-slate-300 mb-1">Or Upload Image (Base64)</label>
                <input id="form-og-image-file" onchange="handleBase64Upload(event)" type="file" accept="image/*" class="w-full text-xs text-slate-400 file:mr-2 file:py-1.5 file:px-3 file:rounded-lg file:border-0 file:text-xs file:font-semibold file:bg-indigo-600/20 file:text-indigo-300 hover:file:bg-indigo-600/30 cursor-pointer" />
              </div>
            </div>
          </div>

          <div id="form-error" class="hidden p-3 rounded-xl bg-rose-500/10 border border-rose-500/30 text-rose-300 text-xs"></div>

          <div class="flex items-center justify-end gap-2 pt-3 border-t border-slate-800">
            <button type="button" onclick="closeCreateModal()" class="px-4 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-xs font-medium text-slate-300">Cancel</button>
            <button type="submit" class="px-5 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-xs font-semibold text-white shadow-lg shadow-indigo-600/30 flex items-center gap-2">
              <i class="fa-solid fa-bolt"></i> Deploy Cloaked Link
            </button>
          </div>
        </div>

        <!-- Right Column: Live Social Card Preview (5 cols) -->
        <div class="lg:col-span-5 bg-slate-950 border border-slate-800 rounded-2xl p-4 flex flex-col justify-between">
          <div>
            <span class="text-[11px] font-semibold uppercase tracking-wider text-slate-400">Live Crawler Card Preview</span>
            <p class="text-xs text-slate-500 mb-3">How Facebook, WhatsApp, X, and Telegram will render your link:</p>

            <div class="rounded-xl overflow-hidden border border-slate-800 bg-slate-900 shadow-lg">
              <div class="h-44 bg-slate-800 relative flex items-center justify-center overflow-hidden">
                <img id="modal-preview-img" src="https://placehold.co/1200x630/0f172a/6366f1.png?text=OG+Image+Preview" class="w-full h-full object-cover" alt="Preview" />
              </div>
              <div class="p-3.5">
                <div class="text-[10px] uppercase text-slate-400 mono" id="modal-preview-domain">nexlink.io</div>
                <div class="text-sm font-bold text-white mt-0.5 truncate" id="modal-preview-title">Your OpenGraph Title</div>
                <div class="text-xs text-slate-400 mt-1 line-clamp-2" id="modal-preview-desc">Your OpenGraph description will appear here when shared on social networks.</div>
              </div>
            </div>
          </div>

          <div class="mt-4 p-3 rounded-xl bg-slate-900/90 border border-slate-800 text-[11px] text-slate-400 space-y-1">
            <div class="font-semibold text-slate-200"><i class="fa-solid fa-code-branch text-indigo-400 mr-1"></i> Routing Behavior Summary:</div>
            <div>• <strong>Real User:</strong> 302 -> Destination Target URL</div>
            <div>• <strong>Social Bot:</strong> 200 OK (OG Tags) -> Safe Page URL</div>
          </div>
        </div>
      </form>
    </div>
  </div>

  <!-- TOAST NOTIFICATION -->
  <div id="toast" class="fixed bottom-5 right-5 z-50 hidden px-4 py-3 rounded-xl bg-slate-900 border border-indigo-500/40 text-white text-xs font-medium shadow-2xl flex items-center gap-2.5">
    <i class="fa-solid fa-circle-check text-emerald-400"></i>
    <span id="toast-msg">Copied to clipboard!</span>
  </div>

  <script>
    let appState = {
      links: [],
      logs: [],
      stats: {}
    };
    let uploadedBase64Image = '';

    // Initialize host domain options
    function initHostDomains() {
      const host = window.location.host || 'nexlink.io';
      document.getElementById('current-host-domain').textContent = host;
      const domainSelect = document.getElementById('form-domain');
      domainSelect.innerHTML = \`
        <option value="\${host}">\${host} (Current Render Host)</option>
        <option value="nexlink.io">nexlink.io</option>
        <option value="go.nexlink.io">go.nexlink.io</option>
        <option value="lnk.nexlink.io">lnk.nexlink.io</option>
      \`;
    }

    async function fetchDashboardData() {
      try {
        const res = await fetch('/api/get-data');
        const data = await res.json();
        if (!data.success) return;

        appState = data;
        renderStats();
        renderLinksTable();
        renderLogs();
        populateSimulatorSelect();
      } catch (err) {
        console.error('Failed to load dashboard data:', err);
      }
    }

    function renderStats() {
      const s = appState.stats || {};
      document.getElementById('stat-total-links').textContent = s.totalLinks || 0;
      document.getElementById('stat-human-clicks').textContent = s.totalHumanClicks || 0;
      document.getElementById('stat-bot-hits').textContent = s.totalBotHits || 0;
      document.getElementById('stat-efficiency').textContent = '100%';

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
      const baseOrigin = window.location.origin;

      const filtered = appState.links.filter(l =>
        l.slug.toLowerCase().includes(filter) ||
        l.targetUrl.toLowerCase().includes(filter) ||
        (l.ogTitle || '').toLowerCase().includes(filter)
      );

      if (filtered.length === 0) {
        tbody.innerHTML = \`
          <tr>
            <td colspan="6" class="py-8 text-center text-slate-500">
              No cloaked links found. Click <strong>"Create Cloaked Link"</strong> to deploy your first route.
            </td>
          </tr>
        \`;
        return;
      }

      tbody.innerHTML = filtered.map(link => {
        const shortUrl = \`\${baseOrigin}/\${link.slug}\`;
        const imgThumb = link.ogImage || 'https://placehold.co/120x63/0f172a/6366f1.png?text=OG';
        return \`
          <tr class="hover:bg-slate-800/40 transition">
            <td class="py-3 px-3">
              <div class="flex items-center gap-2">
                <span class="font-bold text-indigo-400 mono">/\${link.slug}</span>
                <button onclick="copyToClipboard('\${shortUrl}')" title="Copy Short Link" class="p-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-300">
                  <i class="fa-regular fa-copy text-[11px]"></i>
                </button>
              </div>
              <div class="text-[10px] text-slate-500 mono">\${link.domain || window.location.host}</div>
            </td>
            <td class="py-3 px-3 max-w-[240px]">
              <div class="truncate text-emerald-400" title="Target: \${link.targetUrl}">
                <i class="fa-solid fa-arrow-turn-up rotate-90 mr-1 text-[10px]"></i>\${link.targetUrl}
              </div>
              <div class="truncate text-amber-400/80 text-[11px]" title="Safe: \${link.safeUrl}">
                <i class="fa-solid fa-shield-halved mr-1 text-[10px]"></i>\${link.safeUrl}
              </div>
            </td>
            <td class="py-3 px-3 max-w-[200px]">
              <div class="flex items-center gap-2">
                <img src="\${imgThumb}" class="w-10 h-6 rounded object-cover border border-slate-700 shrink-0" />
                <div class="truncate">
                  <div class="font-medium text-slate-200 truncate">\${link.ogTitle || 'Untitled'}</div>
                  <div class="text-[10px] text-slate-500 truncate">\${link.ogDesc || ''}</div>
                </div>
              </div>
            </td>
            <td class="py-3 px-3 text-center">
              <span class="px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 font-semibold mono">\${link.humanClicks || 0}</span>
            </td>
            <td class="py-3 px-3 text-center">
              <span class="px-2 py-0.5 rounded-full bg-amber-500/10 text-amber-400 border border-amber-500/20 font-semibold mono">\${link.botHits || 0}</span>
            </td>
            <td class="py-3 px-3 text-right whitespace-nowrap space-x-1">
              <a href="/\${link.slug}" target="_blank" title="Test Human Redirect" class="inline-block px-2 py-1 rounded bg-slate-800 hover:bg-emerald-500/20 text-slate-300 hover:text-emerald-300">
                <i class="fa-solid fa-arrow-up-right-from-square"></i>
              </a>
              <button onclick="deleteLink('\${link.slug}')" title="Delete Link" class="px-2 py-1 rounded bg-slate-800 hover:bg-rose-500/20 text-slate-400 hover:text-rose-400">
                <i class="fa-solid fa-trash"></i>
              </button>
            </td>
          </tr>
        \`;
      }).join('');
    }

    function renderLogs() {
      const container = document.getElementById('logs-container');
      if (!appState.logs || appState.logs.length === 0) {
        container.innerHTML = '<div class="text-xs text-slate-500 text-center py-8">No traffic recorded yet.</div>';
        return;
      }

      container.innerHTML = appState.logs.map(log => {
        const isBot = log.type === 'BOT';
        const badgeClass = isBot
          ? 'bg-amber-500/10 text-amber-400 border-amber-500/30'
          : 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30';
        const icon = isBot ? 'fa-robot' : 'fa-user-check';
        const time = new Date(log.timestamp).toLocaleTimeString();

        return \`
          <div class="p-2.5 rounded-xl bg-slate-950 border border-slate-800/90 text-xs flex items-start justify-between gap-2">
            <div class="min-w-0">
              <div class="flex items-center gap-2">
                <span class="px-1.5 py-0.5 rounded border text-[10px] font-semibold \${badgeClass}">
                  <i class="fa-solid \${icon} mr-1"></i>\${log.type}
                </span>
                <span class="font-bold text-indigo-400 mono">/\${log.slug}</span>
                <span class="text-[10px] text-slate-500">\${log.ip}</span>
              </div>
              <div class="text-slate-300 text-[11px] mt-1 truncate">\${log.action}</div>
              <div class="text-slate-500 text-[10px] truncate mono">\${log.ua}</div>
            </div>
            <span class="text-[10px] text-slate-500 mono shrink-0">\${time}</span>
          </div>
        \`;
      }).join('');
    }

    function populateSimulatorSelect() {
      const select = document.getElementById('simulator-slug-select');
      if (!appState.links.length) {
        select.innerHTML = '<option value="">No links available</option>';
        return;
      }
      const currentVal = select.value;
      select.innerHTML = appState.links.map(l => \`<option value="\${l.slug}">/\${l.slug} — \${l.ogTitle}</option>\`).join('');
      if (currentVal && appState.links.some(l => l.slug === currentVal)) {
        select.value = currentVal;
      }
      updateSimulatorCard();
    }

    function updateSimulatorCard() {
      const slug = document.getElementById('simulator-slug-select').value;
      const link = appState.links.find(l => l.slug === slug);
      if (!link) return;

      document.getElementById('sim-domain').textContent = link.domain || window.location.host;
      document.getElementById('sim-og-title').textContent = link.ogTitle || 'Untitled';
      document.getElementById('sim-og-desc').textContent = link.ogDesc || '';
      document.getElementById('sim-og-img').src = link.ogImage || 'https://placehold.co/1200x630/0f172a/6366f1.png?text=NexLink+Preview';
    }

    function triggerSimulatedVisit(mode) {
      const slug = document.getElementById('simulator-slug-select').value;
      if (!slug) return;
      if (mode === 'bot') {
        window.open(\`/\${slug}?bot_preview=1\`, '_blank');
      } else {
        window.open(\`/\${slug}\`, '_blank');
      }
      setTimeout(fetchDashboardData, 900);
    }

    // Modal Operations
    function openCreateModal() {
      document.getElementById('form-error').classList.add('hidden');
      document.getElementById('create-modal').classList.remove('hidden');
      syncModalPreview();
    }

    function closeCreateModal() {
      document.getElementById('create-modal').classList.add('hidden');
    }

    function handleImageUrlInput() {
      uploadedBase64Image = '';
      document.getElementById('form-og-image-file').value = '';
      syncModalPreview();
    }

    function handleBase64Upload(event) {
      const file = event.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = function(e) {
        uploadedBase64Image = e.target.result;
        document.getElementById('form-og-image-url').value = '';
        syncModalPreview();
      };
      reader.readAsDataURL(file);
    }

    function syncModalPreview() {
      const title = document.getElementById('form-og-title').value || 'Your OpenGraph Title';
      const desc = document.getElementById('form-og-desc').value || 'Your OpenGraph description will appear here when shared on social networks.';
      const domain = document.getElementById('form-domain').value || window.location.host;
      const imgUrl = uploadedBase64Image || document.getElementById('form-og-image-url').value || 'https://placehold.co/1200x630/0f172a/6366f1.png?text=OG+Image+Preview';

      document.getElementById('modal-preview-title').textContent = title;
      document.getElementById('modal-preview-desc').textContent = desc;
      document.getElementById('modal-preview-domain').textContent = domain;
      document.getElementById('modal-preview-img').src = imgUrl;
    }

    async function submitCreateLink(event) {
      event.preventDefault();
      const errBox = document.getElementById('form-error');
      errBox.classList.add('hidden');

      const payload = {
        domain: document.getElementById('form-domain').value,
        slug: document.getElementById('form-slug').value,
        targetUrl: document.getElementById('form-target').value,
        safeUrl: document.getElementById('form-safe').value,
        ogTitle: document.getElementById('form-og-title').value,
        ogDesc: document.getElementById('form-og-desc').value,
        ogImage: uploadedBase64Image || document.getElementById('form-og-image-url').value
      };

      try {
        const res = await fetch('/api/create-link', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
        const data = await res.json();

        if (!res.ok || !data.success) {
          errBox.textContent = data.error || 'Failed to create link.';
          errBox.classList.remove('hidden');
          return;
        }

        document.getElementById('create-link-form').reset();
        uploadedBase64Image = '';
        closeCreateModal();
        await fetchDashboardData();
        copyToClipboard(data.shortUrl);
        showToast('Cloaked link deployed & copied to clipboard!');
      } catch (err) {
        errBox.textContent = 'Network error while saving link.';
        errBox.classList.remove('hidden');
      }
    }

    async function deleteLink(slug) {
      if (!confirm(\`Delete short link /\${slug}?\`)) return;
      await fetch(\`/api/delete-link/\${slug}\`, { method: 'DELETE' });
      fetchDashboardData();
      showToast(\`Deleted /\${slug}\`);
    }

    function copyToClipboard(text) {
      navigator.clipboard.writeText(text);
      showToast('Copied: ' + text);
    }

    function showToast(msg) {
      const toast = document.getElementById('toast');
      document.getElementById('toast-msg').textContent = msg;
      toast.classList.remove('hidden');
      setTimeout(() => toast.classList.add('hidden'), 3200);
    }

    function exportDatabaseJSON() {
      const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(appState, null, 2));
      const dlAnchor = document.createElement('a');
      dlAnchor.setAttribute("href", dataStr);
      dlAnchor.setAttribute("download", "nexlink-db-backup.json");
      document.body.appendChild(dlAnchor);
      dlAnchor.click();
      dlAnchor.remove();
    }

    // Boot Dashboard immediately (Zero auth or blocking modals)
    initHostDomains();
    fetchDashboardData();
  </script>
</body>
</html>`;
}

// Start Server
app.listen(PORT, () => {
  initDB();
  console.log(`====================================================`);
  console.log(`🚀 NexLink.io Enterprise Cloaking Engine Online`);
  console.log(`🔗 Dashboard UI: http://localhost:${PORT}`);
  console.log(`📁 Persistence : ${DB_FILE}`);
  console.log(`====================================================`);
});
