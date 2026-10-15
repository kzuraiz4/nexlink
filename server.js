const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const DB_FILE = path.join(__dirname, 'db.json');

// Critical for Render.com so req.protocol is always 'https'
app.set('trust proxy', true);

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// ==========================================
// 1. PERSISTENT STORAGE ENGINE (db.json)
// ==========================================
function initDB() {
  if (!fs.existsSync(DB_FILE)) {
    const seedData = {
      links: [],
      logs: []
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
    console.error('Error reading db.json:', err);
    return { links: [], logs: [] };
  }
}

function writeDB(data) {
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2), 'utf8');
  } catch (err) {
    console.error('Error writing db.json:', err);
  }
}

// ==========================================
// 2. BOT & CRAWLER DETECTION ENGINE
// ==========================================
const BOT_SIGNATURES = [
  'facebookexternalhit',
  'facebot',
  'meta-externalagent',
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
  'showyoubot',
  'curl',
  'python-requests',
  'headlesschrome'
];

function isBotUserAgent(ua) {
  if (!ua) return true;
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

function getBaseUrl(req) {
  const proto = req.headers['x-forwarded-proto']
    ? req.headers['x-forwarded-proto'].split(',')[0].trim()
    : (req.protocol || 'https');
  const host = req.get('host');
  return `${proto}://${host}`;
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
      cloakEfficiency: 100
    },
    links: db.links,
    logs: db.logs.slice(0, 100)
  });
});

// Create a cloaked short link
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

  let cleanSlug = (slug || '').trim().replace(/[^a-zA-Z0-9-_]/g, '');
  if (!cleanSlug) {
    cleanSlug = Math.random().toString(36).substring(2, 8);
  }

  if (['api', 'favicon.ico', 'robots.txt'].includes(cleanSlug.toLowerCase())) {
    cleanSlug = `${cleanSlug}-${Math.floor(Math.random() * 999)}`;
  }

  if (db.links.some(l => l.slug.toLowerCase() === cleanSlug.toLowerCase())) {
    return res.status(409).json({
      success: false,
      error: `Alias "/${cleanSlug}" already exists. Choose a different slug.`
    });
  }

  const baseUrl = getBaseUrl(req);
  const host = req.get('host');

  const newLink = {
    id: 'lnk_' + Date.now(),
    slug: cleanSlug,
    domain: domain || host,
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

  db.links.unshift(newLink);
  writeDB(db);

  res.json({
    success: true,
    link: newLink,
    shortUrl: `${baseUrl}/${cleanSlug}`
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

// Serve uploaded Base64 image as a proper binary image with Content-Length for FB/WhatsApp scrapers
app.get('/api/og-image/:slug', (req, res) => {
  const db = readDB();
  const link = db.links.find(l => l.slug.toLowerCase() === req.params.slug.toLowerCase());

  if (!link || !link.ogImage) {
    return res.redirect('https://placehold.co/1200x630/09090b/ffffff.png?text=Preview');
  }

  if (link.ogImage.startsWith('data:image')) {
    const matches = link.ogImage.match(/^data:([A-Za-z-+\/]+);base64,(.+)$/);
    if (matches && matches.length === 3) {
      const contentType = matches[1];
      const buffer = Buffer.from(matches[2], 'base64');
      res.writeHead(200, {
        'Content-Type': contentType,
        'Content-Length': buffer.length,
        'Cache-Control': 'public, max-age=86400'
      });
      return res.end(buffer);
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
// ==========================================
app.get('/:slug', (req, res) => {
  const { slug } = req.params;
  if (slug === 'favicon.ico' || slug === 'robots.txt') return res.status(204).end();

  const db = readDB();
  const linkIndex = db.links.findIndex(l => l.slug.toLowerCase() === slug.toLowerCase());

  if (linkIndex === -1) {
    return res.status(404).send(`<!DOCTYPE html>
      <html class="dark"><head><title>404 Not Found</title><script src="https://cdn.tailwindcss.com"></script></head>
      <body class="bg-zinc-950 text-zinc-100 min-h-screen flex items-center justify-center p-6 font-sans">
        <div class="max-w-sm w-full border border-zinc-800 bg-zinc-900/50 rounded-xl p-6 text-center">
          <p class="text-xs font-mono text-zinc-500 uppercase">404 Error</p>
          <h1 class="text-base font-semibold mt-1 mb-2">Link /${escapeHtml(slug)} Not Found</h1>
          <a href="/" class="inline-block mt-3 px-4 py-2 rounded-lg bg-white text-zinc-950 text-xs font-medium">Back to Dashboard</a>
        </div>
      </body></html>`);
  }

  const link = db.links[linkIndex];
  const ua = req.headers['user-agent'] || '';
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '0.0.0.0').split(',')[0].trim();
  const baseUrl = getBaseUrl(req);
  const currentShortUrl = `${baseUrl}/${link.slug}`;

  const forceBotPreview = req.query.bot_preview === '1';
  const forceSafeRedirect = req.query.safe_redirect === '1';
  const botDetected = forceBotPreview || forceSafeRedirect || isBotUserAgent(ua);

  if (botDetected) {
    db.links[linkIndex].botHits = (db.links[linkIndex].botHits || 0) + 1;
    db.logs.unshift({
      id: 'log_' + Date.now(),
      slug: link.slug,
      type: 'BOT',
      ua: ua.substring(0, 140),
      ip,
      action: `Cloaked -> Served Uploaded OG Card (Safe: ${link.safeUrl})`,
      timestamp: new Date().toISOString()
    });
    if (db.logs.length > 200) db.logs.pop();
    writeDB(db);

    // Optional explicit 302 to Safe URL if ?safe_redirect=1 is called
    if (forceSafeRedirect) {
      return res.redirect(302, link.safeUrl);
    }

    // Build cache-busted HTTPS URL for the uploaded image so social crawlers ALWAYS fetch your uploaded image
    const ogImageUrl = link.ogImage
      ? (link.ogImage.startsWith('data:image')
          ? `${baseUrl}/api/og-image/${link.slug}?v=${link.id}`
          : link.ogImage)
      : 'https://placehold.co/1200x630/09090b/ffffff.png?text=Preview';

    // CRITICAL FIX:
    // 1. og:url MUST point to currentShortUrl (NOT safeUrl), otherwise Facebook/WhatsApp discards your image and scrapes Wikipedia!
    // 2. Do NOT include <meta http-equiv="refresh"> or <link rel="canonical">, because crawlers follow them and overwrite your OG image.
    res.status(200).setHeader('Content-Type', 'text/html; charset=utf-8').send(`<!DOCTYPE html>
<html lang="en" prefix="og: https://ogp.me/ns#">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${escapeHtml(link.ogTitle)}</title>
  <meta name="description" content="${escapeHtml(link.ogDesc)}" />

  <!-- Open Graph (Facebook, WhatsApp, Messenger, LinkedIn, iMessage) -->
  <meta property="og:type" content="website" />
  <meta property="og:site_name" content="${escapeHtml(link.domain || req.get('host'))}" />
  <meta property="og:url" content="${escapeHtml(currentShortUrl)}" />
  <meta property="og:title" content="${escapeHtml(link.ogTitle)}" />
  <meta property="og:description" content="${escapeHtml(link.ogDesc)}" />
  <meta property="og:image" content="${escapeHtml(ogImageUrl)}" />
  <meta property="og:image:secure_url" content="${escapeHtml(ogImageUrl)}" />
  <meta property="og:image:width" content="1200" />
  <meta property="og:image:height" content="630" />

  <!-- Twitter / X Large Card -->
  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:title" content="${escapeHtml(link.ogTitle)}" />
  <meta name="twitter:description" content="${escapeHtml(link.ogDesc)}" />
  <meta name="twitter:image" content="${escapeHtml(ogImageUrl)}" />
</head>
<body style="margin:0;background:#09090b;color:#fafafa;font-family:system-ui,-apple-system,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:24px;">
  <div style="max-width:460px;width:100%;border:1px solid #27272a;border-radius:12px;overflow:hidden;background:#18181b;">
    <img src="${escapeHtml(ogImageUrl)}" alt="${escapeHtml(link.ogTitle)}" style="width:100%;height:240px;object-fit:cover;display:block;" />
    <div style="padding:16px;">
      <div style="font-size:11px;color:#a1a1aa;text-transform:uppercase;letter-spacing:0.05em;">${escapeHtml(link.domain || req.get('host'))}</div>
      <h1 style="font-size:16px;font-weight:600;margin:6px 0;color:#fff;">${escapeHtml(link.ogTitle)}</h1>
      <p style="font-size:13px;color:#a1a1aa;margin:0 0 14px 0;line-height:1.5;">${escapeHtml(link.ogDesc)}</p>
      <a href="${escapeHtml(link.safeUrl)}" style="display:inline-block;padding:8px 14px;border-radius:8px;background:#fff;color:#09090b;text-decoration:none;font-size:12px;font-weight:600;">Continue to Safe Page &rarr;</a>
    </div>
  </div>
</body>
</html>`);
    return;
  }

  // Real Human Visitor -> Instant 302 Redirect to Destination Target URL
  db.links[linkIndex].humanClicks = (db.links[linkIndex].humanClicks || 0) + 1;
  db.logs.unshift({
    id: 'log_' + Date.now(),
    slug: link.slug,
    type: 'HUMAN',
    ua: ua.substring(0, 140),
    ip,
    action: `302 Redirect -> ${link.targetUrl}`,
    timestamp: new Date().toISOString()
  });
  if (db.logs.length > 200) db.logs.pop();
  writeDB(db);

  return res.redirect(302, link.targetUrl);
});

// ==========================================
// 6. MINIMALIST & SLEEK 12-MODULE DASHBOARD
// ==========================================
function renderDashboardHTML() {
  return `<!DOCTYPE html>
<html lang="en" class="dark">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>NexLink.io — Minimalist Enterprise Cloaker</title>
  <script src="https://cdn.tailwindcss.com"></script>
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

  <!-- TOP MINIMALIST HEADER -->
  <header class="sticky top-0 z-30 bg-zinc-950/85 backdrop-blur-md border-b border-zinc-800/80 px-6 py-3">
    <div class="max-w-7xl mx-auto flex items-center justify-between">
      <div class="flex items-center gap-3">
        <div class="w-7 h-7 rounded-lg bg-white text-zinc-950 flex items-center justify-center font-bold text-xs">N</div>
        <div class="flex items-center gap-2">
          <span class="font-semibold text-sm tracking-tight text-white">NexLink.io</span>
          <span class="text-[10px] mono px-2 py-0.5 rounded bg-zinc-900 text-zinc-400 border border-zinc-800">v2.7 Minimal</span>
        </div>
      </div>

      <div class="flex items-center gap-2.5">
        <div class="hidden sm:flex items-center gap-2 px-2.5 py-1 rounded-md bg-zinc-900 border border-zinc-800 text-[11px] text-zinc-400">
          <span class="w-1.5 h-1.5 rounded-full bg-emerald-400"></span>
          <span>Engine Active</span>
        </div>
        <button onclick="fetchDashboardData()" class="px-3 py-1.5 rounded-lg bg-zinc-900 hover:bg-zinc-800 text-zinc-300 text-xs font-medium border border-zinc-800 transition">
          <i class="fa-solid fa-rotate-right mr-1 text-[10px]"></i> Sync
        </button>
        <button onclick="openCreateModal()" class="px-3.5 py-1.5 rounded-lg bg-white hover:bg-zinc-200 text-zinc-950 text-xs font-semibold transition flex items-center gap-1.5">
          <i class="fa-solid fa-plus text-[10px]"></i> New Link
        </button>
      </div>
    </div>
  </header>

  <!-- MAIN 12-MODULE SLEEK WORKSPACE -->
  <main class="flex-1 max-w-7xl w-full mx-auto px-6 py-6 space-y-6">

    <!-- MODULES 01 - 04: MINIMAL KPI STRIP -->
    <section class="grid grid-cols-2 lg:grid-cols-4 gap-3">
      <div class="bg-zinc-900/40 border border-zinc-800/80 rounded-xl p-4">
        <div class="flex items-center justify-between text-[11px] text-zinc-500">
          <span>01 / Active Links</span>
          <i class="fa-solid fa-link text-zinc-600"></i>
        </div>
        <div id="stat-total-links" class="text-2xl font-semibold text-white mt-1.5 mono">0</div>
      </div>

      <div class="bg-zinc-900/40 border border-zinc-800/80 rounded-xl p-4">
        <div class="flex items-center justify-between text-[11px] text-zinc-500">
          <span>02 / Human Clicks (302)</span>
          <span class="w-1.5 h-1.5 rounded-full bg-emerald-400"></span>
        </div>
        <div id="stat-human-clicks" class="text-2xl font-semibold text-emerald-400 mt-1.5 mono">0</div>
      </div>

      <div class="bg-zinc-900/40 border border-zinc-800/80 rounded-xl p-4">
        <div class="flex items-center justify-between text-[11px] text-zinc-500">
          <span>03 / Bots Cloaked (OG)</span>
          <span class="w-1.5 h-1.5 rounded-full bg-amber-400"></span>
        </div>
        <div id="stat-bot-hits" class="text-2xl font-semibold text-amber-400 mt-1.5 mono">0</div>
      </div>

      <div class="bg-zinc-900/40 border border-zinc-800/80 rounded-xl p-4">
        <div class="flex items-center justify-between text-[11px] text-zinc-500">
          <span>04 / OG Image Integrity</span>
          <i class="fa-solid fa-shield-halved text-zinc-600"></i>
        </div>
        <div id="stat-efficiency" class="text-2xl font-semibold text-zinc-100 mt-1.5 mono">100%</div>
      </div>
    </section>

    <!-- MODULES 05 & 06: LINKS TABLE + LIVE SOCIAL PREVIEW VERIFIER -->
    <section class="grid grid-cols-1 lg:grid-cols-12 gap-5">

      <!-- Module 05: Routing Table (8 cols) -->
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
                <th class="py-2.5 px-2">Uploaded OG Preview</th>
                <th class="py-2.5 px-2 text-center">Human</th>
                <th class="py-2.5 px-2 text-center">Bot</th>
                <th class="py-2.5 px-2 text-right">Actions</th>
              </tr>
            </thead>
            <tbody id="links-table-body" class="divide-y divide-zinc-800/40 text-xs"></tbody>
          </table>
        </div>
      </div>

      <!-- Module 06: Social Card & Bot Simulator (4 cols) -->
      <div class="lg:col-span-4 bg-zinc-900/40 border border-zinc-800/80 rounded-xl p-5 flex flex-col justify-between">
        <div>
          <div class="flex items-center justify-between mb-3">
            <div>
              <span class="text-[10px] mono uppercase text-zinc-500">06 / Preview Verifier</span>
              <h2 class="text-sm font-semibold text-white">Social Scraper Card</h2>
            </div>
            <select id="simulator-slug-select" onchange="updateSimulatorCard()" class="px-2.5 py-1 rounded-lg bg-zinc-950 border border-zinc-800 text-xs text-zinc-200 focus:outline-none">
            </select>
          </div>

          <!-- Exact Social Media Preview Card -->
          <div class="rounded-xl overflow-hidden border border-zinc-800 bg-zinc-950 mb-4">
            <div class="h-40 bg-zinc-900 relative overflow-hidden">
              <img id="sim-og-img" src="https://placehold.co/1200x630/09090b/ffffff.png?text=Preview" alt="OG" class="w-full h-full object-cover" />
            </div>
            <div class="p-3 border-t border-zinc-800/80">
              <div id="sim-domain" class="text-[10px] mono uppercase text-zinc-500 truncate">nexlink.io</div>
              <div id="sim-og-title" class="text-xs font-semibold text-white truncate mt-0.5">No link selected</div>
              <div id="sim-og-desc" class="text-[11px] text-zinc-400 line-clamp-2 mt-0.5">Create a link to verify its social preview card.</div>
            </div>
          </div>
        </div>

        <div class="grid grid-cols-3 gap-2 pt-3 border-t border-zinc-800/80">
          <button onclick="triggerSimulatedVisit('human')" class="px-2.5 py-1.5 rounded-lg bg-zinc-950 hover:bg-zinc-800 text-emerald-400 border border-zinc-800 text-[11px] font-medium transition">
            302 Human
          </button>
          <button onclick="triggerSimulatedVisit('bot')" class="px-2.5 py-1.5 rounded-lg bg-zinc-950 hover:bg-zinc-800 text-amber-400 border border-zinc-800 text-[11px] font-medium transition">
            OG Bot Card
          </button>
          <button onclick="triggerSimulatedVisit('safe')" class="px-2.5 py-1.5 rounded-lg bg-zinc-950 hover:bg-zinc-800 text-zinc-300 border border-zinc-800 text-[11px] font-medium transition">
            Safe Page
          </button>
        </div>
      </div>

    </section>

    <!-- MODULES 07, 08, 09: TELEMETRY, WAF SIGNATURES, TRAFFIC RATIO -->
    <section class="grid grid-cols-1 lg:grid-cols-3 gap-5">

      <!-- Module 07: Live Telemetry Stream -->
      <div class="bg-zinc-900/40 border border-zinc-800/80 rounded-xl p-5 flex flex-col h-72">
        <div class="flex items-center justify-between mb-3">
          <div>
            <span class="text-[10px] mono uppercase text-zinc-500">07 / Live Stream</span>
            <h2 class="text-sm font-semibold text-white">Interception Logs</h2>
          </div>
          <span class="text-[10px] mono text-zinc-500">Real-time</span>
        </div>
        <div id="logs-container" class="flex-1 overflow-y-auto space-y-1.5 pr-1"></div>
      </div>

      <!-- Module 08: Crawler Signatures -->
      <div class="bg-zinc-900/40 border border-zinc-800/80 rounded-xl p-5 flex flex-col h-72">
        <div class="mb-3">
          <span class="text-[10px] mono uppercase text-zinc-500">08 / Bot Filter</span>
          <h2 class="text-sm font-semibold text-white">Active Crawler Signatures</h2>
        </div>
        <div class="grid grid-cols-2 gap-2 text-xs overflow-y-auto pr-1">
          <div class="px-3 py-2 rounded-lg bg-zinc-950 border border-zinc-800/80 flex items-center justify-between">
            <span class="text-zinc-300">FacebookHit</span>
            <span class="w-1.5 h-1.5 rounded-full bg-emerald-400"></span>
          </div>
          <div class="px-3 py-2 rounded-lg bg-zinc-950 border border-zinc-800/80 flex items-center justify-between">
            <span class="text-zinc-300">WhatsApp</span>
            <span class="w-1.5 h-1.5 rounded-full bg-emerald-400"></span>
          </div>
          <div class="px-3 py-2 rounded-lg bg-zinc-950 border border-zinc-800/80 flex items-center justify-between">
            <span class="text-zinc-300">Twitterbot</span>
            <span class="w-1.5 h-1.5 rounded-full bg-emerald-400"></span>
          </div>
          <div class="px-3 py-2 rounded-lg bg-zinc-950 border border-zinc-800/80 flex items-center justify-between">
            <span class="text-zinc-300">TelegramBot</span>
            <span class="w-1.5 h-1.5 rounded-full bg-emerald-400"></span>
          </div>
          <div class="px-3 py-2 rounded-lg bg-zinc-950 border border-zinc-800/80 flex items-center justify-between">
            <span class="text-zinc-300">LinkedInBot</span>
            <span class="w-1.5 h-1.5 rounded-full bg-emerald-400"></span>
          </div>
          <div class="px-3 py-2 rounded-lg bg-zinc-950 border border-zinc-800/80 flex items-center justify-between">
            <span class="text-zinc-300">Googlebot</span>
            <span class="w-1.5 h-1.5 rounded-full bg-emerald-400"></span>
          </div>
          <div class="px-3 py-2 rounded-lg bg-zinc-950 border border-zinc-800/80 flex items-center justify-between">
            <span class="text-zinc-300">Discordbot</span>
            <span class="w-1.5 h-1.5 rounded-full bg-emerald-400"></span>
          </div>
          <div class="px-3 py-2 rounded-lg bg-zinc-950 border border-zinc-800/80 flex items-center justify-between">
            <span class="text-zinc-300">Slackbot</span>
            <span class="w-1.5 h-1.5 rounded-full bg-emerald-400"></span>
          </div>
        </div>
      </div>

      <!-- Module 09: Traffic Distribution -->
      <div class="bg-zinc-900/40 border border-zinc-800/80 rounded-xl p-5 flex flex-col justify-between h-72">
        <div>
          <span class="text-[10px] mono uppercase text-zinc-500">09 / Traffic Ratio</span>
          <h2 class="text-sm font-semibold text-white mb-4">Human vs. Bot Distribution</h2>

          <div class="space-y-4">
            <div>
              <div class="flex justify-between text-xs mb-1.5">
                <span class="text-zinc-300">Human Visitors (302 Target)</span>
                <span id="bar-human-label" class="mono text-emerald-400">0 (50%)</span>
              </div>
              <div class="w-full h-2 rounded-full bg-zinc-950 overflow-hidden border border-zinc-800">
                <div id="bar-human" class="h-full bg-emerald-400 transition-all duration-500" style="width: 50%"></div>
              </div>
            </div>

            <div>
              <div class="flex justify-between text-xs mb-1.5">
                <span class="text-zinc-300">Social Bots (Custom OG Card)</span>
                <span id="bar-bot-label" class="mono text-amber-400">0 (50%)</span>
              </div>
              <div class="w-full h-2 rounded-full bg-zinc-950 overflow-hidden border border-zinc-800">
                <div id="bar-bot" class="h-full bg-amber-400 transition-all duration-500" style="width: 50%"></div>
              </div>
            </div>
          </div>
        </div>

        <div class="px-3 py-2.5 rounded-lg bg-zinc-950 border border-zinc-800/80 flex items-center justify-between text-xs">
          <span class="text-zinc-400">OG Image Lock</span>
          <span class="mono text-emerald-400 text-[11px]">Self-Canonical Active</span>
        </div>
      </div>

    </section>

    <!-- MODULES 10, 11, 12: COMPACT SYSTEM FOOTER MODULES -->
    <section class="grid grid-cols-1 md:grid-cols-3 gap-5">

      <!-- Module 10: Domain Prefixes -->
      <div class="bg-zinc-900/40 border border-zinc-800/80 rounded-xl p-4 flex items-center justify-between">
        <div>
          <span class="text-[10px] mono uppercase text-zinc-500">10 / Domain Prefix</span>
          <div id="current-host-domain" class="text-xs font-medium text-white mono mt-0.5">nexlink.io</div>
        </div>
        <span class="text-[10px] mono px-2 py-1 rounded bg-zinc-950 border border-zinc-800 text-zinc-400">SSL Proxy Ready</span>
      </div>

      <!-- Module 11: Persistence Engine -->
      <div class="bg-zinc-900/40 border border-zinc-800/80 rounded-xl p-4 flex items-center justify-between">
        <div>
          <span class="text-[10px] mono uppercase text-zinc-500">11 / Storage Engine</span>
          <div class="text-xs font-medium text-white mt-0.5">Local <code class="mono text-zinc-300">db.json</code> Store</div>
        </div>
        <button onclick="exportDatabaseJSON()" class="px-2.5 py-1 rounded-lg bg-zinc-950 hover:bg-zinc-800 text-zinc-300 border border-zinc-800 text-xs transition">
          Export JSON
        </button>
      </div>

      <!-- Module 12: Core API Status -->
      <div class="bg-zinc-900/40 border border-zinc-800/80 rounded-xl p-4 flex items-center justify-between">
        <div>
          <span class="text-[10px] mono uppercase text-zinc-500">12 / Express Router</span>
          <div class="text-xs font-medium text-white mono mt-0.5">/:slug + /api/og-image/:slug</div>
        </div>
        <span class="text-[10px] mono px-2 py-1 rounded bg-emerald-500/10 border border-emerald-500/20 text-emerald-400">200 OK</span>
      </div>

    </section>
  </main>

  <!-- ========================================== -->
  <!-- SLEEK LINK CREATION MODAL                  -->
  <!-- ========================================== -->
  <div id="create-modal" class="fixed inset-0 z-50 hidden bg-black/80 backdrop-blur-sm flex items-center justify-center p-4 overflow-y-auto">
    <div class="bg-zinc-950 border border-zinc-800 rounded-2xl max-w-3xl w-full p-6 shadow-2xl my-8">
      <div class="flex items-center justify-between pb-4 border-b border-zinc-800">
        <div>
          <h3 class="text-sm font-semibold text-white">Create Cloaked Short Link</h3>
          <p class="text-xs text-zinc-400">Humans 302 redirect to Target URL. Social bots render your exact uploaded OG image.</p>
        </div>
        <button onclick="closeCreateModal()" class="w-7 h-7 rounded-lg bg-zinc-900 hover:bg-zinc-800 text-zinc-400 hover:text-white flex items-center justify-center text-xs">
          <i class="fa-solid fa-xmark"></i>
        </button>
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
              <input id="form-slug" type="text" placeholder="custom-slug (optional)" class="w-full px-3 py-2 rounded-lg bg-zinc-900 border border-zinc-800 text-xs text-white mono focus:outline-none focus:border-zinc-600" />
            </div>
          </div>

          <div>
            <label class="block text-[11px] text-emerald-400 mb-1">Destination Target URL (Real Humans -> 302) *</label>
            <input id="form-target" type="url" required placeholder="https://your-destination.com/offer" class="w-full px-3 py-2 rounded-lg bg-zinc-900 border border-zinc-800 text-xs text-white focus:outline-none focus:border-emerald-500" />
          </div>

          <div>
            <label class="block text-[11px] text-amber-400 mb-1">Safe Page URL (Fallback / Bot Safe Link) *</label>
            <input id="form-safe" type="url" required placeholder="https://en.wikipedia.org/wiki/Computing" class="w-full px-3 py-2 rounded-lg bg-zinc-900 border border-zinc-800 text-xs text-white focus:outline-none focus:border-amber-500" />
          </div>

          <div class="pt-2 border-t border-zinc-800/80 space-y-3">
            <div class="text-[11px] font-medium text-zinc-300">Social Preview Metadata (Open Graph)</div>

            <div>
              <label class="block text-[11px] text-zinc-400 mb-1">OG Title *</label>
              <input id="form-og-title" oninput="syncModalPreview()" type="text" required placeholder="Enter social card headline" class="w-full px-3 py-2 rounded-lg bg-zinc-900 border border-zinc-800 text-xs text-white focus:outline-none focus:border-zinc-600" />
            </div>

            <div>
              <label class="block text-[11px] text-zinc-400 mb-1">OG Description</label>
              <textarea id="form-og-desc" oninput="syncModalPreview()" rows="2" placeholder="Enter social card summary..." class="w-full px-3 py-2 rounded-lg bg-zinc-900 border border-zinc-800 text-xs text-white focus:outline-none focus:border-zinc-600"></textarea>
            </div>

            <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label class="block text-[11px] text-zinc-400 mb-1">Upload Preview Image (Recommended)</label>
                <input id="form-og-image-file" onchange="handleBase64Upload(event)" type="file" accept="image/*" class="w-full text-xs text-zinc-400 file:mr-2 file:py-1.5 file:px-3 file:rounded-lg file:border-0 file:text-xs file:font-medium file:bg-white file:text-zinc-950 hover:file:bg-zinc-200 cursor-pointer" />
              </div>
              <div>
                <label class="block text-[11px] text-zinc-400 mb-1">Or Direct Image URL</label>
                <input id="form-og-image-url" oninput="handleImageUrlInput()" type="url" placeholder="https://example.com/image.jpg" class="w-full px-3 py-1.5 rounded-lg bg-zinc-900 border border-zinc-800 text-xs text-white focus:outline-none focus:border-zinc-600" />
              </div>
            </div>
          </div>

          <div id="form-error" class="hidden p-2.5 rounded-lg bg-rose-500/10 border border-rose-500/30 text-rose-400 text-xs"></div>

          <div class="flex items-center justify-end gap-2 pt-3 border-t border-zinc-800">
            <button type="button" onclick="closeCreateModal()" class="px-3.5 py-2 rounded-lg bg-zinc-900 hover:bg-zinc-800 text-xs text-zinc-300">Cancel</button>
            <button type="submit" class="px-4 py-2 rounded-lg bg-white hover:bg-zinc-200 text-zinc-950 text-xs font-semibold transition">
              Deploy Short Link
            </button>
          </div>
        </div>

        <!-- Live Social Preview Column -->
        <div class="lg:col-span-5 bg-zinc-900/50 border border-zinc-800 rounded-xl p-4 flex flex-col justify-between">
          <div>
            <span class="text-[10px] mono uppercase text-zinc-500">Live Social Card Preview</span>
            <div class="rounded-xl overflow-hidden border border-zinc-800 bg-zinc-950 mt-2">
              <div class="h-44 bg-zinc-900 overflow-hidden">
                <img id="modal-preview-img" src="https://placehold.co/1200x630/09090b/ffffff.png?text=Upload+Preview+Image" class="w-full h-full object-cover" alt="Preview" />
              </div>
              <div class="p-3 border-t border-zinc-800">
                <div id="modal-preview-domain" class="text-[10px] mono uppercase text-zinc-500 truncate">nexlink.io</div>
                <div id="modal-preview-title" class="text-xs font-semibold text-white truncate mt-0.5">Your OG Title</div>
                <div id="modal-preview-desc" class="text-[11px] text-zinc-400 line-clamp-2 mt-0.5">Your uploaded image and text will appear on Facebook, WhatsApp, X, and Telegram.</div>
              </div>
            </div>
          </div>
          <div class="text-[11px] text-zinc-500 mt-3">
            Tip: Images are automatically compressed & served via <code class="mono text-zinc-300">/api/og-image/:slug</code> so social crawlers never show the Wikipedia preview.
          </div>
        </div>
      </form>
    </div>
  </div>

  <!-- TOAST -->
  <div id="toast" class="fixed bottom-5 right-5 z-50 hidden px-4 py-2.5 rounded-xl bg-white text-zinc-950 text-xs font-medium shadow-xl">
    <span id="toast-msg">Copied</span>
  </div>

  <script>
    let appState = { links: [], logs: [], stats: {} };
    let uploadedBase64Image = '';

    function initHostDomains() {
      const host = window.location.host || 'nexlink.io';
      document.getElementById('current-host-domain').textContent = host;
      document.getElementById('form-domain').innerHTML = \`
        <option value="\${host}">\${host}</option>
        <option value="nexlink.io">nexlink.io</option>
        <option value="go.nexlink.io">go.nexlink.io</option>
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
      } catch (e) {
        console.error(e);
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
      const baseOrigin = window.location.origin;

      const filtered = appState.links.filter(l =>
        l.slug.toLowerCase().includes(filter) ||
        l.targetUrl.toLowerCase().includes(filter) ||
        (l.ogTitle || '').toLowerCase().includes(filter)
      );

      if (!filtered.length) {
        tbody.innerHTML = '<tr><td colspan="6" class="py-8 text-center text-zinc-500">No active links. Click "New Link" to create one.</td></tr>';
        return;
      }

      tbody.innerHTML = filtered.map(link => {
        const shortUrl = \`\${baseOrigin}/\${link.slug}\`;
        const imgThumb = link.ogImage
          ? (link.ogImage.startsWith('data:image') ? \`/api/og-image/\${link.slug}?v=\${link.id}\` : link.ogImage)
          : 'https://placehold.co/120x63/09090b/ffffff.png?text=OG';

        return \`
          <tr class="hover:bg-zinc-900/60 transition">
            <td class="py-3 px-2">
              <div class="flex items-center gap-1.5">
                <span class="font-medium text-white mono">/\${link.slug}</span>
                <button onclick="copyToClipboard('\${shortUrl}')" class="px-1.5 py-0.5 rounded bg-zinc-900 hover:bg-zinc-800 text-zinc-400 text-[10px]">Copy</button>
              </div>
            </td>
            <td class="py-3 px-2 max-w-[200px]">
              <div class="truncate text-emerald-400 text-[11px]" title="Target: \${link.targetUrl}">→ \${link.targetUrl}</div>
              <div class="truncate text-zinc-500 text-[10px]" title="Safe: \${link.safeUrl}">Safe: \${link.safeUrl}</div>
            </td>
            <td class="py-3 px-2 max-w-[200px]">
              <div class="flex items-center gap-2">
                <img src="\${imgThumb}" class="w-10 h-6 rounded object-cover border border-zinc-800 shrink-0" />
                <div class="truncate">
                  <div class="text-zinc-200 truncate text-[11px] font-medium">\${link.ogTitle}</div>
                  <div class="text-zinc-500 truncate text-[10px]">\${link.ogDesc || ''}</div>
                </div>
              </div>
            </td>
            <td class="py-3 px-2 text-center mono text-emerald-400">\${link.humanClicks || 0}</td>
            <td class="py-3 px-2 text-center mono text-amber-400">\${link.botHits || 0}</td>
            <td class="py-3 px-2 text-right whitespace-nowrap space-x-1">
              <a href="/\${link.slug}?bot_preview=1" target="_blank" title="Preview Bot OG Card" class="inline-block px-2 py-1 rounded bg-zinc-900 hover:bg-zinc-800 text-zinc-300 text-[10px]">OG</a>
              <button onclick="deleteLink('\${link.slug}')" class="px-2 py-1 rounded bg-zinc-900 hover:bg-rose-500/20 text-zinc-400 hover:text-rose-400 text-[10px]">Del</button>
            </td>
          </tr>
        \`;
      }).join('');
    }

    function renderLogs() {
      const container = document.getElementById('logs-container');
      if (!appState.logs || !appState.logs.length) {
        container.innerHTML = '<div class="text-xs text-zinc-600 text-center py-8">No requests logged yet.</div>';
        return;
      }

      container.innerHTML = appState.logs.map(log => {
        const isBot = log.type === 'BOT';
        const color = isBot ? 'text-amber-400' : 'text-emerald-400';
        const time = new Date(log.timestamp).toLocaleTimeString();
        return \`
          <div class="px-3 py-2 rounded-lg bg-zinc-950 border border-zinc-800/70 text-[11px] flex items-center justify-between gap-2">
            <div class="truncate">
              <span class="mono font-semibold \${color}">[\${log.type}]</span>
              <span class="mono text-white ml-1">/\${log.slug}</span>
              <span class="text-zinc-500 ml-1.5">\${log.action}</span>
            </div>
            <span class="mono text-[10px] text-zinc-600 shrink-0">\${time}</span>
          </div>
        \`;
      }).join('');
    }

    function populateSimulatorSelect() {
      const select = document.getElementById('simulator-slug-select');
      if (!appState.links.length) {
        select.innerHTML = '<option value="">No links</option>';
        return;
      }
      const prev = select.value;
      select.innerHTML = appState.links.map(l => \`<option value="\${l.slug}">/\${l.slug}</option>\`).join('');
      if (prev && appState.links.some(l => l.slug === prev)) select.value = prev;
      updateSimulatorCard();
    }

    function updateSimulatorCard() {
      const slug = document.getElementById('simulator-slug-select').value;
      const link = appState.links.find(l => l.slug === slug);
      if (!link) return;

      const imgUrl = link.ogImage
        ? (link.ogImage.startsWith('data:image') ? \`/api/og-image/\${link.slug}?v=\${link.id}\` : link.ogImage)
        : 'https://placehold.co/1200x630/09090b/ffffff.png?text=Preview';

      document.getElementById('sim-domain').textContent = link.domain || window.location.host;
      document.getElementById('sim-og-title').textContent = link.ogTitle || 'Untitled';
      document.getElementById('sim-og-desc').textContent = link.ogDesc || '';
      document.getElementById('sim-og-img').src = imgUrl;
    }

    function triggerSimulatedVisit(mode) {
      const slug = document.getElementById('simulator-slug-select').value;
      if (!slug) return;
      if (mode === 'bot') window.open(\`/\${slug}?bot_preview=1\`, '_blank');
      else if (mode === 'safe') window.open(\`/\${slug}?safe_redirect=1\`, '_blank');
      else window.open(\`/\${slug}\`, '_blank');
      setTimeout(fetchDashboardData, 800);
    }

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

    // Compress & resize uploaded image to 1200x630 JPEG so social scrapers load it fast
    function handleBase64Upload(event) {
      const file = event.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = function(e) {
        const img = new Image();
        img.onload = function() {
          const canvas = document.createElement('canvas');
          const maxW = 1200;
          const scale = img.width > maxW ? maxW / img.width : 1;
          canvas.width = Math.round(img.width * scale);
          canvas.height = Math.round(img.height * scale);
          const ctx = canvas.getContext('2d');
          ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
          uploadedBase64Image = canvas.toDataURL('image/jpeg', 0.85);
          document.getElementById('form-og-image-url').value = '';
          syncModalPreview();
        };
        img.src = e.target.result;
      };
      reader.readAsDataURL(file);
    }

    function syncModalPreview() {
      const title = document.getElementById('form-og-title').value || 'Your OG Title';
      const desc = document.getElementById('form-og-desc').value || 'Your uploaded image and text will appear on Facebook, WhatsApp, X, and Telegram.';
      const domain = document.getElementById('form-domain').value || window.location.host;
      const imgUrl = uploadedBase64Image || document.getElementById('form-og-image-url').value || 'https://placehold.co/1200x630/09090b/ffffff.png?text=Upload+Preview+Image';

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
          errBox.textContent = data.error || 'Error creating link';
          errBox.classList.remove('hidden');
          return;
        }

        document.getElementById('create-link-form').reset();
        uploadedBase64Image = '';
        closeCreateModal();
        await fetchDashboardData();
        copyToClipboard(data.shortUrl);
      } catch (err) {
        errBox.textContent = 'Network error.';
        errBox.classList.remove('hidden');
      }
    }

    async function deleteLink(slug) {
      if (!confirm(\`Delete /\${slug}?\`)) return;
      await fetch(\`/api/delete-link/\${slug}\`, { method: 'DELETE' });
      fetchDashboardData();
    }

    function copyToClipboard(text) {
      navigator.clipboard.writeText(text);
      const toast = document.getElementById('toast');
      document.getElementById('toast-msg').textContent = 'Copied: ' + text;
      toast.classList.remove('hidden');
      setTimeout(() => toast.classList.add('hidden'), 2500);
    }

    function exportDatabaseJSON() {
      const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(appState, null, 2));
      const a = document.createElement('a');
      a.setAttribute("href", dataStr);
      a.setAttribute("download", "nexlink-db.json");
      document.body.appendChild(a);
      a.click();
      a.remove();
    }

    initHostDomains();
    fetchDashboardData();
  </script>
</body>
</html>`;
}

app.listen(PORT, () => {
  initDB();
  console.log(`NexLink.io running on port ${PORT}`);
});
