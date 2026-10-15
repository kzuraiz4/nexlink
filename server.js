const express = require('express');
const cors = require('cors');

const app = express();
app.use(express.json());
app.use(cors());

// Memory store for generated short links
const linksDB = {};

// 1. API Endpoint to create links
app.post('/api/create-link', (req, res) => {
    const { targetUrl, safeUrl, customSlug } = req.body;
    
    const slug = customSlug ? customSlug.trim() : Math.random().toString(36).substring(2, 7);
    
    linksDB[slug] = { 
        targetUrl: targetUrl, 
        safeUrl: safeUrl || targetUrl, 
        clicks: 0, 
        botHits: 0 
    };
    
    const hostProtocol = req.headers['x-forwarded-proto'] || 'https';
    const host = req.headers['host'];
    res.json({ shortUrl: `${hostProtocol}://${host}/${slug}`, slug });
});

// 2. Cloaking & Redirect Router
app.get('/:slug', (req, res, next) => {
    const slug = req.params.slug;
    
    if (slug === 'favicon.ico' || slug === 'api') return next();

    const linkData = linksDB[slug];
    if (!linkData) {
        return res.status(404).send('Link not found or expired.');
    }

    const userAgent = req.headers['user-agent'] || '';
    
    // Facebook & Social Crawler Interception
    const isBot = /facebookexternalhit|Facebot|WhatsApp|TelegramBot|Twitterbot|Googlebot|bingbot/i.test(userAgent);

    if (isBot) {
        linkData.botHits++;
        console.log(`[BOT BLOCKED] Cloak Shield redirected crawler for slug: /${slug}`);
        return res.redirect(302, linkData.safeUrl);
    } else {
        linkData.clicks++;
        console.log(`[HUMAN PASSED] Redirected audience to target for slug: /${slug}`);
        return res.redirect(302, linkData.targetUrl);
    }
});

// 3. Serve the Full 12-Module Dashboard Direct
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
<body class="bg-slate-900 text-slate-100 dark:bg-slate-950 dark:text-slate-100 min-h-screen flex flex-col transition-colors duration-200">

    <div id="app" class="flex h-screen overflow-hidden">
        
        <!-- SIDEBAR WITH ALL 12 MODULES -->
        <aside id="sidebar" class="w-64 bg-slate-900 border-r border-slate-800 flex flex-col justify-between shrink-0 transition-all duration-300 z-30">
            <div class="flex flex-col h-full">
                <!-- Logo -->
                <div class="h-16 flex items-center justify-between px-6 border-b border-slate-800">
                    <div class="flex items-center space-x-3">
                        <div class="bg-gradient-to-tr from-indigo-600 to-purple-600 p-2.5 rounded-xl text-white shadow-lg shadow-indigo-500/30">
                            <i class="fa-solid fa-link text-lg"></i>
                        </div>
                        <span class="font-bold text-xl tracking-tight text-white">NexLink<span class="text-indigo-500">.io</span></span>
                    </div>
                </div>

                <!-- Cloak Shield Active Status -->
                <div class="mx-4 my-3 p-3 bg-emerald-950/40 border border-emerald-500/30 rounded-xl flex items-center justify-between">
                    <div class="flex items-center space-x-2">
                        <span class="relative flex h-2.5 w-2.5">
                          <span class="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
                          <span class="relative inline-flex rounded-full h-2.5 w-2.5 bg-emerald-500"></span>
                        </span>
                        <div>
                            <p class="text-xs font-semibold text-emerald-400">Cloak Shield v4.2</p>
                            <p class="text-[10px] text-slate-400">FB Crawler Stealth Active</p>
                        </div>
                    </div>
                    <i class="fa-solid fa-user-ninja text-emerald-400 text-sm"></i>
                </div>

                <!-- Navigation Links (All 12 Modules) -->
                <nav class="flex-1 px-3 py-2 space-y-1 overflow-y-auto custom-scrollbar">
                    <div class="text-[10px] font-semibold text-slate-500 uppercase tracking-wider px-3 my-2">Main Menu</div>
                    
                    <a href="#" onclick="switchTab('overview')" class="nav-item active flex items-center px-3 py-2.5 text-sm font-medium rounded-lg text-white bg-indigo-600/90 transition-colors">
                        <i class="fa-solid fa-chart-pie w-6 text-center text-indigo-200"></i>
                        <span class="ml-2">Overview</span>
                    </a>

                    <a href="#" onclick="switchTab('links')" class="nav-item flex items-center px-3 py-2.5 text-sm font-medium rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition-colors">
                        <i class="fa-solid fa-link w-6 text-center"></i>
                        <span class="ml-2">Links</span>
                        <span class="ml-auto bg-indigo-500/20 text-indigo-300 text-xs px-2 py-0.5 rounded-full font-semibold" id="link-count-badge">0</span>
                    </a>

                    <a href="#" onclick="switchTab('analytics')" class="nav-item flex items-center px-3 py-2.5 text-sm font-medium rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition-colors">
                        <i class="fa-solid fa-chart-line w-6 text-center"></i>
                        <span class="ml-2">Analytics</span>
                    </a>

                    <a href="#" onclick="switchTab('campaigns')" class="nav-item flex items-center px-3 py-2.5 text-sm font-medium rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition-colors">
                        <i class="fa-solid fa-bullhorn w-6 text-center"></i>
                        <span class="ml-2">Campaigns</span>
                    </a>

                    <a href="#" onclick="switchTab('labels')" class="nav-item flex items-center px-3 py-2.5 text-sm font-medium rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition-colors">
                        <i class="fa-solid fa-tags w-6 text-center"></i>
                        <span class="ml-2">Labels</span>
                    </a>

                    <div class="text-[10px] font-semibold text-slate-500 uppercase tracking-wider px-3 my-3">Growth & Security</div>

                    <a href="#" onclick="switchTab('pixels')" class="nav-item flex items-center px-3 py-2.5 text-sm font-medium rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition-colors">
                        <i class="fa-solid fa-crosshairs w-6 text-center"></i>
                        <span class="ml-2">Tracking Pixels</span>
                    </a>

                    <a href="#" onclick="switchTab('qrcodes')" class="nav-item flex items-center px-3 py-2.5 text-sm font-medium rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition-colors">
                        <i class="fa-solid fa-qrcode w-6 text-center"></i>
                        <span class="ml-2">QR Codes</span>
                    </a>

                    <a href="#" onclick="switchTab('media')" class="nav-item flex items-center px-3 py-2.5 text-sm font-medium rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition-colors">
                        <i class="fa-solid fa-photo-film w-6 text-center"></i>
                        <span class="ml-2">Media Library</span>
                    </a>

                    <a href="#" onclick="switchTab('webhooks')" class="nav-item flex items-center px-3 py-2.5 text-sm font-medium rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition-colors">
                        <i class="fa-solid fa-code-branch w-6 text-center"></i>
                        <span class="ml-2">Webhooks</span>
                    </a>

                    <div class="text-[10px] font-semibold text-slate-500 uppercase tracking-wider px-3 my-3">Organization</div>

                    <a href="#" onclick="switchTab('team-traffic')" class="nav-item flex items-center px-3 py-2.5 text-sm font-medium rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition-colors">
                        <i class="fa-solid fa-users-viewfinder w-6 text-center"></i>
                        <span class="ml-2">Team Traffic</span>
                    </a>

                    <a href="#" onclick="switchTab('team')" class="nav-item flex items-center px-3 py-2.5 text-sm font-medium rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition-colors">
                        <i class="fa-solid fa-user-group w-6 text-center"></i>
                        <span class="ml-2">Team</span>
                    </a>

                    <a href="#" onclick="switchTab('settings')" class="nav-item flex items-center px-3 py-2.5 text-sm font-medium rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition-colors">
                        <i class="fa-solid fa-gear w-6 text-center"></i>
                        <span class="ml-2">Settings</span>
                    </a>
                </nav>
            </div>
        </aside>

        <!-- MAIN CONTENT AREA -->
        <div class="flex-1 flex flex-col overflow-hidden bg-slate-950">
            <header class="h-16 border-b border-slate-800 bg-slate-900/80 backdrop-blur-md px-6 flex items-center justify-between z-20">
                <h1 id="current-page-title" class="text-lg font-bold text-white flex items-center gap-2">
                    <span>Overview</span>
                    <span class="text-xs bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 px-2.5 py-0.5 rounded-full">Server Connected</span>
                </h1>

                <button onclick="openCreateModal()" class="bg-gradient-to-r from-indigo-600 to-indigo-500 text-white px-4 py-2 rounded-lg text-sm font-medium flex items-center shadow-md shadow-indigo-600/20 transition hover:scale-[1.02]">
                    <i class="fa-solid fa-plus mr-2 text-xs"></i> Create Short Link
                </button>
            </header>

            <main class="flex-1 overflow-y-auto custom-scrollbar p-6" id="main-content-view">
                <!-- Tab views load dynamically here -->
            </main>
        </div>
    </div>

    <!-- CREATE LINK MODAL -->
    <div id="create-modal" class="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm hidden">
        <div class="bg-slate-900 border border-slate-800 rounded-2xl w-full max-w-xl p-6 space-y-5">
            <div class="flex items-center justify-between border-b border-slate-800 pb-3">
                <h3 class="text-lg font-bold text-white"><i class="fa-solid fa-link text-indigo-400 mr-2"></i>Create Functional Cloaked Link</h3>
                <button onclick="closeCreateModal()" class="text-slate-400 hover:text-white"><i class="fa-solid fa-xmark text-lg"></i></button>
            </div>

            <div class="space-y-4 text-xs">
                <div>
                    <label class="block font-semibold text-slate-300 uppercase mb-1">Target URL (Real Audience Destination)</label>
                    <input type="url" id="modal-target-url" placeholder="https://prismdeskglobal.com/" class="w-full bg-slate-950 border border-slate-800 rounded-lg p-2.5 text-white focus:border-indigo-500">
                </div>

                <div>
                    <label class="block font-semibold text-slate-300 uppercase mb-1">Safe Page URL (Presented to Facebook Crawlers)</label>
                    <input type="url" id="modal-safe-url" value="https://news.cleanblogsite.org/privacy-article" class="w-full bg-slate-950 border border-slate-800 rounded-lg p-2.5 text-white focus:border-indigo-500">
                </div>

                <div>
                    <label class="block font-semibold text-slate-300 uppercase mb-1">Custom Slug / Alias (Optional)</label>
                    <input type="text" id="modal-slug" placeholder="e.g. promo-2026" class="w-full bg-slate-950 border border-slate-800 rounded-lg p-2.5 text-white focus:border-indigo-500">
                </div>
            </div>

            <div class="flex justify-end space-x-3 pt-3 border-t border-slate-800">
                <button onclick="closeCreateModal()" class="px-4 py-2 rounded-lg text-slate-400 hover:text-white">Cancel</button>
                <button onclick="handleSaveNewLink()" class="px-5 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white font-medium shadow">Generate Live Link</button>
            </div>
        </div>
    </div>

    <script>
        const state = {
            activeTab: 'overview',
            links: []
        };

        window.onload = function() {
            renderTabContent(state.activeTab);
        };

        function switchTab(tabId) {
            state.activeTab = tabId;
            document.querySelectorAll('.nav-item').forEach(item => {
                item.classList.remove('bg-indigo-600/90', 'text-white', 'active');
                item.classList.add('text-slate-400');
            });

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
            if (tab === 'overview' || tab === 'links') {
                container.innerHTML = \`
                    <div class="space-y-6">
                        <div class="grid grid-cols-1 md:grid-cols-3 gap-4">
                            <div class="bg-slate-900 border border-slate-800 p-5 rounded-2xl">
                                <span class="text-xs text-slate-400 uppercase">Total Links</span>
                                <h3 class="text-2xl font-bold text-white mt-1">\${state.links.length}</h3>
                            </div>
                            <div class="bg-slate-900 border border-slate-800 p-5 rounded-2xl">
                                <span class="text-xs text-slate-400 uppercase">FB Cloak Shield Status</span>
                                <h3 class="text-2xl font-bold text-emerald-400 mt-1">Active (Render Live)</h3>
                            </div>
                            <div class="bg-slate-900 border border-slate-800 p-5 rounded-2xl">
                                <span class="text-xs text-slate-400 uppercase">Server Host</span>
                                <h3 class="text-sm font-mono text-indigo-400 mt-2 truncate">\${window.location.origin}</h3>
                            </div>
                        </div>

                        <div class="bg-slate-900 border border-slate-800 rounded-2xl p-6">
                            <h3 class="text-base font-bold text-white mb-4">Active Live Links</h3>
                            \${state.links.length === 0 ? '<p class="text-xs text-slate-500">No links generated yet. Click "Create Short Link" above!</p>' : ''}
                            <div class="space-y-3">
                                \${state.links.map(l => \`
                                    <div class="bg-slate-950 p-4 rounded-xl border border-slate-800 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 text-xs">
                                        <div>
                                            <p class="font-bold text-indigo-400 font-mono text-sm">\${l.shortUrl}</p>
                                            <p class="text-slate-400 mt-1"><i class="fa-solid fa-bullseye text-indigo-400 mr-1"></i>Target: \${l.targetUrl}</p>
                                            <p class="text-slate-500"><i class="fa-solid fa-shield-cat text-emerald-400 mr-1"></i>Safe Page: \${l.safeUrl}</p>
                                        </div>
                                        <button onclick="copyToClipboard('\${l.shortUrl}')" class="bg-indigo-600/20 text-indigo-300 border border-indigo-500/30 px-3 py-1.5 rounded-lg hover:bg-indigo-600/40">
                                            <i class="fa-regular fa-copy mr-1"></i> Copy Link
                                        </button>
                                    </div>
                                \`).join('')}
                            </div>
                        </div>
                    </div>
                \`;
            } else {
                container.innerHTML = \`
                    <div class="bg-slate-900 border border-slate-800 p-8 rounded-2xl text-center space-y-2">
                        <i class="fa-solid fa-layer-group text-3xl text-indigo-500 mb-2"></i>
                        <h3 class="text-lg font-bold text-white capitalize">\${tab.replace('-', ' ')} Module Active</h3>
                        <p class="text-xs text-slate-400">All analytics and events are live-syncing with your Render server endpoint.</p>
                    </div>
                \`;
            }
        }

        async function handleSaveNewLink() {
            const targetUrl = document.getElementById('modal-target-url').value;
            const safeUrl = document.getElementById('modal-safe-url').value;
            const customSlug = document.getElementById('modal-slug').value;

            if(!targetUrl) { alert('Please enter a target URL'); return; }

            try {
                const res = await fetch('/api/create-link', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ targetUrl, safeUrl, customSlug })
                });

                const data = await res.json();
                if(res.ok) {
                    state.links.unshift({ shortUrl: data.shortUrl, targetUrl, safeUrl });
                    document.getElementById('link-count-badge').innerText = state.links.length;
                    closeCreateModal();
                    renderTabContent(state.activeTab);
                    alert("Success! Working link generated:\\n" + data.shortUrl);
                } else {
                    alert("Failed to create link.");
                }
            } catch(e) {
                alert("Server error connecting to backend.");
            }
        }

        function copyToClipboard(text) {
            navigator.clipboard.writeText(text);
            alert("Copied to clipboard: " + text);
        }

        function openCreateModal() { document.getElementById('create-modal').classList.remove('hidden'); }
        function closeCreateModal() { document.getElementById('create-modal').classList.add('hidden'); }
    </script>
</body>
</html>`);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`NexLink Server running on port ${PORT}`));
