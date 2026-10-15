const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(cors());

const DB_FILE = path.join(__dirname, 'db.json');

// Ensure db.json exists on disk
function loadDB() {
    try {
        if (fs.existsSync(DB_FILE)) {
            const data = fs.readFileSync(DB_FILE, 'utf8');
            if (data.trim().length > 0) {
                const parsed = JSON.parse(data);
                if (!parsed.links) parsed.links = {};
                return parsed;
            }
        }
    } catch (e) {
        console.error("Error reading database file:", e);
    }

    const defaultDB = { links: {} };
    saveDB(defaultDB);
    return defaultDB;
}

function saveDB(db) {
    try {
        fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2), 'utf8');
    } catch (e) {
        console.error("Error saving database file:", e);
    }
}

// Initialize database on startup
loadDB();

// --- AUTH API (Instant Success Gateway) ---
app.post('/api/login', (req, res) => {
    const { email } = req.body;
    res.json({ success: true, email: email || 'admin@nexlink.io' });
});

app.post('/api/signup', (req, res) => {
    const { email } = req.body;
    res.json({ success: true, email: email || 'admin@nexlink.io' });
});

// --- LINK CREATION & DATA API ---
app.post('/api/create-link', (req, res) => {
    const { 
        targetUrl, safeUrl, customSlug, domainPrefix, 
        title, previewTitle, previewDescription, previewImage, campaign 
    } = req.body;

    const slug = customSlug ? customSlug.trim() : Math.random().toString(36).substring(2, 7);
    const db = loadDB();
    if (!db.links) db.links = {};
    
    db.links[slug] = { 
        title: title || slug.toUpperCase(),
        targetUrl: targetUrl, 
        safeUrl: safeUrl || targetUrl, 
        domainPrefix: domainPrefix || '',
        previewTitle: previewTitle || '',
        previewDescription: previewDescription || '',
        previewImage: previewImage || '',
        campaign: campaign || 'Q3 FB Ads Campaign',
        clicks: 0, 
        botHits: 0,
        createdAt: new Date().toISOString()
    };
    
    saveDB(db);
    
    const hostProtocol = req.headers['x-forwarded-proto'] || 'https';
    const host = req.headers['host'];
    const chosenDomain = domainPrefix ? domainPrefix : `${hostProtocol}://${host}`;
    
    res.json({ shortUrl: `${chosenDomain}/${slug}`, slug });
});

app.get('/api/get-data', (req, res) => {
    const db = loadDB();
    const hostProtocol = req.headers['x-forwarded-proto'] || 'https';
    const host = req.headers['host'];

    const links = Object.keys(db.links || {}).map(slug => {
        const item = db.links[slug];
        const chosenDomain = item.domainPrefix ? item.domainPrefix : `${hostProtocol}://${host}`;
        
        return {
            id: slug,
            title: item.title || slug.toUpperCase(),
            slug: slug,
            shortUrl: `${chosenDomain}/${slug}`,
            domain: chosenDomain,
            target: item.targetUrl,
            safePage: item.safeUrl,
            previewTitle: item.previewTitle,
            previewDescription: item.previewDescription,
            previewImage: item.previewImage,
            cloak: true,
            clicks: item.clicks || 0,
            botShielded: item.botHits || 0,
            campaign: item.campaign || 'Q3 FB Ads Campaign',
            created: item.createdAt ? item.createdAt.split('T')[0] : new Date().toISOString().split('T')[0]
        };
    });

    res.json({ links });
});

// --- CORE REDIRECTION ROUTER ---
app.get('/:slug', (req, res, next) => {
    const slug = req.params.slug;
    if (slug === 'favicon.ico' || slug === 'api') return next();

    const db = loadDB();
    const linkData = db.links ? db.links[slug] : null;
    
    if (!linkData) {
        return res.status(404).send(`
            <div style="font-family: sans-serif; text-align: center; padding: 50px; background: #0f172a; color: white;">
                <h2>Link Not Found or Expired</h2>
                <p style="color: #94a3b8;">The requested short link does not exist on this server.</p>
            </div>
        `);
    }

    const userAgent = req.headers['user-agent'] || '';
    const isBot = /facebookexternalhit|Facebot|WhatsApp|TelegramBot|Twitterbot|Googlebot|bingbot|Slackbot/i.test(userAgent);

    if (isBot) {
        linkData.botHits++;
        saveDB(db);

        if (linkData.previewTitle || linkData.previewImage || linkData.previewDescription) {
            return res.send(`
                <!DOCTYPE html>
                <html>
                <head>
                    <meta charset="utf-8">
                    <title>${linkData.previewTitle || 'Link Preview'}</title>
                    <meta property="og:title" content="${linkData.previewTitle || ''}" />
                    <meta property="og:description" content="${linkData.previewDescription || ''}" />
                    <meta property="og:image" content="${linkData.previewImage || ''}" />
                    <meta property="og:type" content="website" />
                    <meta name="twitter:card" content="summary_large_image" />
                    <meta name="twitter:title" content="${linkData.previewTitle || ''}" />
                    <meta name="twitter:description" content="${linkData.previewDescription || ''}" />
                    <meta name="twitter:image" content="${linkData.previewImage || ''}" />
                    <script>window.location.href = "${linkData.safeUrl}";</script>
                </head>
                <body></body>
                </html>
            `);
        }
        return res.redirect(302, linkData.safeUrl);
    } else {
        linkData.clicks++;
        saveDB(db);
        return res.redirect(302, linkData.targetUrl);
    }
});

// --- DASHBOARD UI ---
app.get('/', (req, res) => {
    res.send(`<!DOCTYPE html>
<html lang="en" class="dark">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>NexLink | Enterprise URL Shortener & Cloaking Dashboard</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
    <script>
        tailwind.config = {
            darkMode: 'class',
            theme: {
                extend: {
                    colors: {
                        brand: { 50: '#eef2ff', 100: '#e0e7ff', 500: '#6366f1', 600: '#4f46e5', 700: '#4338ca' }
                    }
                }
            }
        }
    </script>
    <style>
        @import url('https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&display=swap');
        body { font-family: 'Inter', sans-serif; }
        .custom-scrollbar::-webkit-scrollbar { width: 6px; height: 6px; }
        .custom-scrollbar::-webkit-scrollbar-track { background: transparent; }
        .custom-scrollbar::-webkit-scrollbar-thumb { background: #334155; border-radius: 4px; }
    </style>
</head>
<body class="bg-slate-900 text-slate-100 dark:bg-slate-950 min-h-screen flex flex-col">

    <!-- LOGIN OVERLAY WITH DIRECT BYPASS -->
    <div id="auth-modal" class="fixed inset-0 z-50 flex items-center justify-center bg-slate-950 backdrop-blur-md">
        <div class="bg-slate-900 border border-slate-800 rounded-2xl w-full max-w-md p-8 space-y-6 shadow-2xl">
            <div class="text-center space-y-2">
                <div class="inline-block bg-gradient-to-tr from-indigo-600 to-purple-600 p-3 rounded-2xl text-white shadow-lg mb-2">
                    <i class="fa-solid fa-link text-2xl"></i>
                </div>
                <h2 class="text-xl font-bold text-white">Welcome to NexLink.io</h2>
                <p class="text-xs text-slate-400">Enterprise URL Shortener & Meta Cloaking System</p>
            </div>

            <div class="space-y-4 text-xs">
                <div>
                    <label class="block font-semibold text-slate-300 uppercase mb-1">Email Address</label>
                    <input type="email" id="auth-email" value="admin@nexlink.io" class="w-full bg-slate-950 border border-slate-800 rounded-lg p-3 text-white focus:border-indigo-500 focus:outline-none">
                </div>
                <div>
                    <label class="block font-semibold text-slate-300 uppercase mb-1">Password</label>
                    <input type="password" id="auth-password" value="password123" class="w-full bg-slate-950 border border-slate-800 rounded-lg p-3 text-white focus:border-indigo-500 focus:outline-none">
                </div>

                <button onclick="handleAuthSubmit()" class="w-full bg-indigo-600 hover:bg-indigo-500 text-white font-semibold py-3 rounded-lg shadow-md transition">
                    Sign In to Dashboard
                </button>
            </div>
        </div>
    </div>

    <!-- MAIN DASHBOARD -->
    <div id="app" class="flex h-screen overflow-hidden hidden">
        <aside class="w-64 bg-slate-900 border-r border-slate-800 flex flex-col justify-between shrink-0 z-30">
            <div class="flex flex-col h-full">
                <div class="h-16 flex items-center justify-between px-6 border-b border-slate-800">
                    <div class="flex items-center space-x-3">
                        <div class="bg-gradient-to-tr from-indigo-600 to-purple-600 p-2.5 rounded-xl text-white shadow-lg">
                            <i class="fa-solid fa-link text-lg"></i>
                        </div>
                        <span class="font-bold text-xl tracking-tight text-white">NexLink<span class="text-indigo-500">.io</span></span>
                    </div>
                </div>

                <div class="mx-4 my-3 p-3 bg-emerald-950/40 border border-emerald-500/30 rounded-xl flex items-center justify-between">
                    <div class="flex items-center space-x-2">
                        <span class="relative flex h-2.5 w-2.5">
                          <span class="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
                          <span class="relative inline-flex rounded-full h-2.5 w-2.5 bg-emerald-500"></span>
                        </span>
                        <div>
                            <p class="text-xs font-semibold text-emerald-400">Cloak Shield v4.2</p>
                            <p class="text-[10px] text-slate-400 truncate max-w-[110px]" id="logged-in-user-label">admin@nexlink.io</p>
                        </div>
                    </div>
                    <i class="fa-solid fa-user-ninja text-emerald-400 text-sm"></i>
                </div>

                <nav class="flex-1 px-3 py-2 space-y-1 overflow-y-auto custom-scrollbar text-sm">
                    <div class="text-[10px] font-semibold text-slate-500 uppercase tracking-wider px-3 my-2">Main Menu</div>
                    <a href="#" onclick="switchTab('overview')" class="nav-item active flex items-center px-3 py-2.5 font-medium rounded-lg text-white bg-indigo-600/90"><i class="fa-solid fa-chart-pie w-6 text-center"></i><span class="ml-2">Overview</span></a>
                    <a href="#" onclick="switchTab('links')" class="nav-item flex items-center px-3 py-2.5 font-medium rounded-lg text-slate-400 hover:text-white hover:bg-slate-800"><i class="fa-solid fa-link w-6 text-center"></i><span class="ml-2">Links</span><span class="ml-auto bg-indigo-500/20 text-indigo-300 text-xs px-2 py-0.5 rounded-full font-semibold" id="link-count-badge">0</span></a>
                    <a href="#" onclick="switchTab('analytics')" class="nav-item flex items-center px-3 py-2.5 font-medium rounded-lg text-slate-400 hover:text-white hover:bg-slate-800"><i class="fa-solid fa-chart-line w-6 text-center"></i><span class="ml-2">Analytics</span></a>
                    <a href="#" onclick="switchTab('campaigns')" class="nav-item flex items-center px-3 py-2.5 font-medium rounded-lg text-slate-400 hover:text-white hover:bg-slate-800"><i class="fa-solid fa-bullhorn w-6 text-center"></i><span class="ml-2">Campaigns</span></a>
                    <a href="#" onclick="switchTab('labels')" class="nav-item flex items-center px-3 py-2.5 font-medium rounded-lg text-slate-400 hover:text-white hover:bg-slate-800"><i class="fa-solid fa-tags w-6 text-center"></i><span class="ml-2">Labels</span></a>
                    
                    <div class="text-[10px] font-semibold text-slate-500 uppercase tracking-wider px-3 my-3">Growth & Security</div>
                    <a href="#" onclick="switchTab('pixels')" class="nav-item flex items-center px-3 py-2.5 font-medium rounded-lg text-slate-400 hover:text-white hover:bg-slate-800"><i class="fa-solid fa-crosshairs w-6 text-center"></i><span class="ml-2">Tracking Pixels</span></a>
                    <a href="#" onclick="switchTab('qrcodes')" class="nav-item flex items-center px-3 py-2.5 font-medium rounded-lg text-slate-400 hover:text-white hover:bg-slate-800"><i class="fa-solid fa-qrcode w-6 text-center"></i><span class="ml-2">QR Codes</span></a>
                    <a href="#" onclick="switchTab('media')" class="nav-item flex items-center px-3 py-2.5 font-medium rounded-lg text-slate-400 hover:text-white hover:bg-slate-800"><i class="fa-solid fa-photo-film w-6 text-center"></i><span class="ml-2">Media Library</span></a>
                    <a href="#" onclick="switchTab('webhooks')" class="nav-item flex items-center px-3 py-2.5 font-medium rounded-lg text-slate-400 hover:text-white hover:bg-slate-800"><i class="fa-solid fa-code-branch w-6 text-center"></i><span class="ml-2">Webhooks</span></a>
                    
                    <div class="text-[10px] font-semibold text-slate-500 uppercase tracking-wider px-3 my-3">Organization</div>
                    <a href="#" onclick="switchTab('team-traffic')" class="nav-item flex items-center px-3 py-2.5 font-medium rounded-lg text-slate-400 hover:text-white hover:bg-slate-800"><i class="fa-solid fa-users-viewfinder w-6 text-center"></i><span class="ml-2">Team Traffic</span></a>
                    <a href="#" onclick="switchTab('team')" class="nav-item flex items-center px-3 py-2.5 font-medium rounded-lg text-slate-400 hover:text-white hover:bg-slate-800"><i class="fa-solid fa-user-group w-6 text-center"></i><span class="ml-2">Team</span></a>
                    <a href="#" onclick="switchTab('settings')" class="nav-item flex items-center px-3 py-2.5 font-medium rounded-lg text-slate-400 hover:text-white hover:bg-slate-800"><i class="fa-solid fa-gear w-6 text-center"></i><span class="ml-2">Settings</span></a>
                </nav>
            </div>
        </aside>

        <div class="flex-1 flex flex-col overflow-hidden bg-slate-950">
            <header class="h-16 border-b border-slate-800 bg-slate-900/80 backdrop-blur-md px-6 flex items-center justify-between z-20">
                <h1 id="current-page-title" class="text-lg font-bold text-white flex items-center gap-2">
                    <span>Overview</span>
                    <span class="text-xs bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 px-2.5 py-0.5 rounded-full">Permanent DB Online</span>
                </h1>

                <button onclick="openCreateModal()" class="bg-gradient-to-r from-indigo-600 to-indigo-500 text-white px-4 py-2 rounded-lg text-sm font-medium flex items-center shadow-md hover:scale-[1.02]">
                    <i class="fa-solid fa-plus mr-2 text-xs"></i> Create Short Link
                </button>
            </header>

            <main class="flex-1 overflow-y-auto custom-scrollbar p-6" id="main-content-view">
                <!-- Dynamic Content -->
            </main>
        </div>
    </div>

    <!-- CREATE LINK MODAL -->
    <div id="create-modal" class="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm hidden overflow-y-auto py-10">
        <div class="bg-slate-900 border border-slate-800 rounded-2xl w-full max-w-xl p-6 space-y-5 my-auto shadow-2xl">
            <div class="flex items-center justify-between border-b border-slate-800 pb-3">
                <div>
                    <h3 class="text-lg font-bold text-white">New link</h3>
                    <p class="text-xs text-slate-400">Set everything up front — nothing here needs a second pass.</p>
                </div>
                <button onclick="closeCreateModal()" class="text-slate-400 hover:text-white"><i class="fa-solid fa-xmark text-lg"></i></button>
            </div>

            <div class="space-y-4 text-xs">
                <div>
                    <label class="block font-semibold text-slate-200 uppercase mb-1">Destination</label>
                    <input type="url" id="modal-target-url" placeholder="https://example.com" class="w-full bg-slate-950 border border-slate-800 rounded-lg p-3 text-white focus:border-indigo-500 focus:outline-none">
                </div>

                <div class="grid grid-cols-3 gap-2">
                    <div class="col-span-1">
                        <label class="block font-semibold text-slate-200 uppercase mb-1">Short link <span class="text-slate-500 font-normal">(optional)</span></label>
                        <select id="modal-domain-prefix" class="w-full bg-slate-950 border border-slate-800 rounded-lg p-3 text-white">
                            <option value="">Default Host</option>
                            <option value="https://go.securehub.app">securehub.app</option>
                            <option value="https://trk.dealstream.co">dealstream.co</option>
                        </select>
                    </div>
                    <div class="col-span-2">
                        <label class="block font-semibold text-slate-200 uppercase mb-1">&nbsp;</label>
                        <input type="text" id="modal-slug" placeholder="my-campaign" class="w-full bg-slate-950 border border-slate-800 rounded-lg p-3 text-white focus:border-indigo-500 focus:outline-none">
                    </div>
                </div>

                <div>
                    <label class="block font-semibold text-slate-200 uppercase mb-1">Title <span class="text-slate-500 font-normal">(optional)</span></label>
                    <input type="text" id="modal-title" placeholder="Internal label" class="w-full bg-slate-950 border border-slate-800 rounded-lg p-3 text-white focus:border-indigo-500 focus:outline-none">
                </div>

                <div>
                    <label class="block font-semibold text-slate-200 uppercase mb-1">Safe Page URL <span class="text-slate-500 font-normal">(FB Bot Target)</span></label>
                    <input type="url" id="modal-safe-url" value="https://news.cleanblogsite.org/privacy-article" class="w-full bg-slate-950 border border-slate-800 rounded-lg p-3 text-white focus:border-indigo-500 focus:outline-none">
                </div>

                <div class="border border-slate-800 bg-slate-950/60 rounded-xl p-4 space-y-3">
                    <div class="flex items-center space-x-2 text-indigo-400 font-semibold text-xs">
                        <i class="fa-regular fa-image"></i>
                        <span>Link preview</span>
                    </div>
                    
                    <input type="text" id="modal-preview-title" placeholder="Preview title" class="w-full bg-slate-900 border border-slate-800 rounded-lg p-2.5 text-white focus:border-indigo-500 focus:outline-none">
                    <input type="text" id="modal-preview-desc" placeholder="Preview description" class="w-full bg-slate-900 border border-slate-800 rounded-lg p-2.5 text-white focus:border-indigo-500 focus:outline-none">

                    <div class="space-y-2">
                        <label class="block font-semibold text-slate-300 uppercase">Preview Image Card</label>
                        <div class="flex items-center space-x-3">
                            <label class="flex-1 cursor-pointer bg-slate-900 border border-dashed border-indigo-500/50 hover:border-indigo-500 rounded-lg p-3 text-center transition">
                                <i class="fa-solid fa-cloud-arrow-up text-indigo-400 text-lg mb-1 block"></i>
                                <span class="text-xs text-slate-300 font-medium block">Upload Image File</span>
                                <input type="file" id="modal-preview-file" accept="image/*" onchange="handleFileSelect(event)" class="hidden">
                            </label>

                            <div class="w-24 h-20 bg-slate-900 border border-slate-800 rounded-lg overflow-hidden flex items-center justify-center relative shrink-0">
                                <img id="preview-img-tag" src="" class="w-full h-full object-cover hidden">
                                <span id="preview-img-placeholder" class="text-[10px] text-slate-600 text-center px-1">No Image</span>
                            </div>
                        </div>

                        <input type="url" id="modal-preview-image" placeholder="Or paste direct Image URL (https://...)" oninput="handleUrlInput(event)" class="w-full bg-slate-900 border border-slate-800 rounded-lg p-2.5 text-white focus:border-indigo-500 focus:outline-none">
                    </div>
                </div>
            </div>

            <div class="flex justify-end space-x-3 pt-3 border-t border-slate-800">
                <button onclick="closeCreateModal()" class="px-4 py-2 text-slate-400 hover:text-white">Cancel</button>
                <button onclick="handleSaveNewLink()" class="px-5 py-2 bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg font-medium shadow">Generate Link</button>
            </div>
        </div>
    </div>

    <script>
        let uploadedImageBase64 = "";

        const state = {
            activeTab: 'overview',
            links: []
        };

        window.onload = function() {
            // Auto bypass login gate on load
            document.getElementById('auth-modal').classList.add('hidden');
            document.getElementById('app').classList.remove('hidden');
            fetchData();
        };

        function handleAuthSubmit() {
            const email = document.getElementById('auth-email').value.trim() || 'admin@nexlink.io';
            localStorage.setItem('nexlink_user', email);
            document.getElementById('auth-modal').classList.add('hidden');
            document.getElementById('app').classList.remove('hidden');
            document.getElementById('logged-in-user-label').innerText = email;
            fetchData();
        }

        function handleFileSelect(event) {
            const file = event.target.files[0];
            if (!file) return;

            if (file.size > 5 * 1024 * 1024) {
                alert("File size exceeds 5MB limit.");
                return;
            }

            const reader = new FileReader();
            reader.onload = function(e) {
                uploadedImageBase64 = e.target.result;
                document.getElementById('modal-preview-image').value = uploadedImageBase64;
                showImagePreview(uploadedImageBase64);
            };
            reader.readAsDataURL(file);
        }

        function handleUrlInput(event) {
            const url = event.target.value.trim();
            uploadedImageBase64 = url;
            showImagePreview(url);
        }

        function showImagePreview(src) {
            const imgTag = document.getElementById('preview-img-tag');
            const placeholder = document.getElementById('preview-img-placeholder');
            if (src) {
                imgTag.src = src;
                imgTag.classList.remove('hidden');
                placeholder.classList.add('hidden');
            } else {
                imgTag.src = '';
                imgTag.classList.add('hidden');
                placeholder.classList.remove('hidden');
            }
        }

        async function fetchData() {
            try {
                const res = await fetch('/api/get-data');
                const data = await res.json();
                state.links = data.links || [];
                document.getElementById('link-count-badge').innerText = state.links.length;
                renderTabContent(state.activeTab);
            } catch(e) {
                console.error("Failed to fetch database records");
            }
        }

        function switchTab(tabId) {
            state.activeTab = tabId;
            document.querySelectorAll('.nav-item').forEach(item => {
                item.classList.remove('bg-indigo-600/90', 'text-white');
                item.classList.add('text-slate-400');
            });

            const currentNav = Array.from(document.querySelectorAll('.nav-item')).find(el => {
                const attr = el.getAttribute('onclick');
                return attr && attr.includes(\`'\${tabId}'\`);
            });
            if (currentNav) {
                currentNav.classList.add('bg-indigo-600/90', 'text-white');
                currentNav.classList.remove('text-slate-400');
            }

            const titles = {
                overview: 'Overview Dashboard', links: 'Links & Cloaking Engine', analytics: 'Traffic & Bot Analytics',
                campaigns: 'Marketing Campaigns', labels: 'Labels & Categories', pixels: 'Retargeting Pixels',
                qrcodes: 'Dynamic QR Codes', media: 'Media Library', webhooks: 'Webhooks & Integrations',
                'team-traffic': 'Team Traffic Allocation', team: 'Team Management', settings: 'System Settings'
            };

            document.getElementById('current-page-title').firstElementChild.innerText = titles[tabId] || 'Dashboard';
            renderTabContent(tabId);
        }

        function renderTabContent(tab) {
            const container = document.getElementById('main-content-view');
            const totalClicks = state.links.reduce((acc, l) => acc + (l.clicks || 0), 0);
            const totalBots = state.links.reduce((acc, l) => acc + (l.botShielded || 0), 0);

            if (tab === 'overview' || tab === 'links') {
                container.innerHTML = \`
                    <div class="space-y-6">
                        <div class="grid grid-cols-1 md:grid-cols-4 gap-4">
                            <div class="bg-slate-900 border border-slate-800 p-5 rounded-2xl">
                                <span class="text-xs text-slate-400 uppercase">Total Permanent Links</span>
                                <h3 class="text-2xl font-bold text-white mt-1">\${state.links.length}</h3>
                            </div>
                            <div class="bg-slate-900 border border-slate-800 p-5 rounded-2xl">
                                <span class="text-xs text-slate-400 uppercase">Real Audience Clicks</span>
                                <h3 class="text-2xl font-bold text-indigo-400 mt-1">\${totalClicks}</h3>
                            </div>
                            <div class="bg-slate-900 border border-slate-800 p-5 rounded-2xl">
                                <span class="text-xs text-slate-400 uppercase">FB Bots Shielded</span>
                                <h3 class="text-2xl font-bold text-emerald-400 mt-1">\${totalBots}</h3>
                            </div>
                            <div class="bg-slate-900 border border-slate-800 p-5 rounded-2xl">
                                <span class="text-xs text-slate-400 uppercase">Database Status</span>
                                <h3 class="text-sm font-bold text-emerald-400 mt-2">Active (JSON File)</h3>
                            </div>
                        </div>

                        <div class="bg-slate-900 border border-slate-800 rounded-2xl p-6 space-y-4">
                            <div class="flex justify-between items-center">
                                <h3 class="text-base font-bold text-white">Active Permanent Links</h3>
                                <button onclick="openCreateModal()" class="bg-indigo-600 text-white px-3 py-1.5 rounded-lg text-xs font-semibold">New Link</button>
                            </div>
                            \${state.links.length === 0 ? '<p class="text-xs text-slate-500">No permanent links created yet. Click "Create Short Link" above!</p>' : ''}
                            <div class="space-y-3">
                                \${state.links.map(l => \`
                                    <div class="bg-slate-950 p-4 rounded-xl border border-slate-800 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 text-xs">
                                        <div class="flex items-start space-x-3">
                                            \${l.previewImage ? \`<img src="\${l.previewImage}" class="w-16 h-12 object-cover rounded border border-slate-800 shrink-0">\` : ''}
                                            <div>
                                                <p class="font-bold text-white text-sm mb-1">\${l.title}</p>
                                                <a href="\${l.shortUrl}" target="_blank" class="font-bold text-indigo-400 font-mono text-xs underline">\${l.shortUrl}</a>
                                                <p class="text-slate-400 mt-1"><i class="fa-solid fa-bullseye text-indigo-400 mr-1"></i>Target: \${l.target}</p>
                                                <p class="text-slate-500"><i class="fa-solid fa-shield-cat text-emerald-400 mr-1"></i>Safe Page: \${l.safePage}</p>
                                            </div>
                                        </div>
                                        <div class="flex items-center space-x-2">
                                            <span class="bg-slate-900 text-slate-300 px-2.5 py-1 rounded">Clicks: \${l.clicks} | Bots: \${l.botShielded}</span>
                                            <button onclick="navigator.clipboard.writeText('\${l.shortUrl}'); alert('Copied!');" class="bg-indigo-600/20 text-indigo-300 px-3 py-1.5 rounded border border-indigo-500/30">Copy</button>
                                        </div>
                                    </div>
                                \`).join('')}
                            </div>
                        </div>
                    </div>
                \`;
            } else if (tab === 'analytics') {
                container.innerHTML = \`
                    <div class="space-y-6">
                        <div class="grid grid-cols-1 md:grid-cols-3 gap-4">
                            <div class="bg-slate-900 border border-slate-800 p-5 rounded-2xl">
                                <span class="text-xs text-slate-400 uppercase">Tracked Impressions</span>
                                <h3 class="text-xl font-bold text-white mt-1">\${totalClicks + totalBots}</h3>
                            </div>
                            <div class="bg-slate-900 border border-slate-800 p-5 rounded-2xl">
                                <span class="text-xs text-slate-400 uppercase">Human Conversion Rate</span>
                                <h3 class="text-xl font-bold text-emerald-400 mt-1">100% Safe Route</h3>
                            </div>
                            <div class="bg-slate-900 border border-slate-800 p-5 rounded-2xl">
                                <span class="text-xs text-slate-400 uppercase">Top Traffic Source</span>
                                <h3 class="text-xl font-bold text-indigo-400 mt-1">Facebook & Instagram Ads</h3>
                            </div>
                        </div>
                    </div>
                \`;
            } else {
                container.innerHTML = \`
                    <div class="bg-slate-900 border border-slate-800 p-8 rounded-2xl text-center space-y-2">
                        <i class="fa-solid fa-layer-group text-3xl text-indigo-500 mb-2"></i>
                        <h3 class="text-lg font-bold text-white capitalize">\${tab.replace('-', ' ')} Module Active</h3>
                        <p class="text-xs text-slate-400">Database connected and syncing permanently with your server storage.</p>
                    </div>
                \`;
            }
        }

        async function handleSaveNewLink() {
            const targetUrl = document.getElementById('modal-target-url').value;
            const safeUrl = document.getElementById('modal-safe-url').value;
            const customSlug = document.getElementById('modal-slug').value;
            const domainPrefix = document.getElementById('modal-domain-prefix').value;
            const title = document.getElementById('modal-title').value;
            const previewTitle = document.getElementById('modal-preview-title').value;
            const previewDescription = document.getElementById('modal-preview-desc').value;
            const previewImage = document.getElementById('modal-preview-image').value;

            if(!targetUrl) { alert('Please enter a destination URL'); return; }

            try {
                const res = await fetch('/api/create-link', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ 
                        targetUrl, safeUrl, customSlug, domainPrefix, 
                        title, previewTitle, previewDescription, previewImage 
                    })
                });

                const data = await res.json();
                if(res.ok) {
                    closeCreateModal();
                    await fetchData();
                    alert("Success! Working short link generated:\n" + data.shortUrl);
                } else {
                    alert("Failed to create link.");
                }
            } catch(e) {
                alert("Server error connecting to backend.");
            }
        }

        function openCreateModal() { 
            uploadedImageBase64 = "";
            showImagePreview("");
            document.getElementById('create-modal').classList.remove('hidden'); 
        }
        function closeCreateModal() { document.getElementById('create-modal').classList.add('hidden'); }
    </script>
</body>
</html>`);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
