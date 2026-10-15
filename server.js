const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json());
app.use(cors());

// File path for permanent link storage
const DB_FILE = path.join(__dirname, 'links.json');

// Load links from file or start with empty object
function loadDB() {
    try {
        if (fs.existsSync(DB_FILE)) {
            const data = fs.readFileSync(DB_FILE, 'utf8');
            return JSON.parse(data);
        }
    } catch (e) {
        console.error("Error reading database file:", e);
    }
    return {};
}

// Save links permanently to file
function saveDB(db) {
    try {
        fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2), 'utf8');
    } catch (e) {
        console.error("Error saving database file:", e);
    }
}

// 1. API Endpoint to create and permanently save links
app.post('/api/create-link', (req, res) => {
    const { targetUrl, safeUrl, customSlug } = req.body;
    
    const slug = customSlug ? customSlug.trim() : Math.random().toString(36).substring(2, 7);
    
    const linksDB = loadDB();
    
    linksDB[slug] = { 
        targetUrl: targetUrl, 
        safeUrl: safeUrl || targetUrl, 
        clicks: 0, 
        botHits: 0,
        createdAt: new Date().toISOString()
    };
    
    saveDB(linksDB);
    
    const hostProtocol = req.headers['x-forwarded-proto'] || 'https';
    const host = req.headers['host'];
    res.json({ shortUrl: `${hostProtocol}://${host}/${slug}`, slug });
});

// 2. API Endpoint to load all links when dashboard opens
app.get('/api/get-links', (req, res) => {
    const linksDB = loadDB();
    const formattedLinks = Object.keys(linksDB).map(slug => ({
        slug: slug,
        shortUrl: `https://${req.headers['host']}/${slug}`,
        targetUrl: linksDB[slug].targetUrl,
        safeUrl: linksDB[slug].safeUrl,
        clicks: linksDB[slug].clicks
    }));
    res.json(formattedLinks);
});

// 3. Cloaking & Redirect Router
app.get('/:slug', (req, res, next) => {
    const slug = req.params.slug;
    
    if (slug === 'favicon.ico' || slug === 'api') return next();

    const linksDB = loadDB();
    const linkData = linksDB[slug];
    
    if (!linkData) {
        return res.status(404).send('Link not found or expired.');
    }

    const userAgent = req.headers['user-agent'] || '';
    const isBot = /facebookexternalhit|Facebot|WhatsApp|TelegramBot|Twitterbot|Googlebot|bingbot/i.test(userAgent);

    if (isBot) {
        linkData.botHits++;
        saveDB(linksDB);
        return res.redirect(302, linkData.safeUrl);
    } else {
        linkData.clicks++;
        saveDB(linksDB);
        return res.redirect(302, linkData.targetUrl);
    }
});

// 4. Serve the Dashboard with Auto-Load Feature
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
        tailwind.config = { darkMode: 'class', theme: { extend: { colors: { brand: { 500: '#6366f1', 600: '#4f46e5' } } } } }
    </script>
</head>
<body class="bg-slate-950 text-slate-100 min-h-screen flex flex-col">
    <div class="flex h-screen overflow-hidden">
        <aside class="w-64 bg-slate-900 border-r border-slate-800 flex flex-col justify-between shrink-0">
            <div class="p-6 border-b border-slate-800 flex items-center space-x-3">
                <div class="bg-indigo-600 p-2.5 rounded-xl text-white"><i class="fa-solid fa-link"></i></div>
                <span class="font-bold text-xl text-white">NexLink<span class="text-indigo-500">.io</span></span>
            </div>
            <div class="p-4 m-4 bg-emerald-950/40 border border-emerald-500/30 rounded-xl text-xs text-emerald-400">
                <i class="fa-solid fa-user-ninja mr-1"></i> FB Crawler Shield Active
            </div>
            <div class="p-4 text-xs text-slate-400">Database: <span class="text-emerald-400 font-bold">Permanent JSON Storage</span></div>
        </aside>

        <main class="flex-1 p-8 overflow-y-auto space-y-6">
            <header class="flex justify-between items-center border-b border-slate-800 pb-4">
                <h1 class="text-lg font-bold text-white">Links & Cloaking Engine</h1>
                <button onclick="openCreateModal()" class="bg-indigo-600 hover:bg-indigo-500 text-white px-4 py-2 rounded-lg text-sm font-semibold shadow">
                    <i class="fa-solid fa-plus mr-1"></i> Create Short Link
                </button>
            </header>

            <div class="bg-slate-900 border border-slate-800 rounded-2xl p-6">
                <h3 class="text-base font-bold text-white mb-4">Your Permanent Live Links</h3>
                <div id="links-container" class="space-y-3">
                    <p class="text-xs text-slate-500">Loading your saved links...</p>
                </div>
            </div>
        </main>
    </div>

    <!-- CREATE MODAL -->
    <div id="create-modal" class="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm hidden">
        <div class="bg-slate-900 border border-slate-800 rounded-2xl w-full max-w-xl p-6 space-y-4">
            <h3 class="text-lg font-bold text-white">Create Permanent Cloaked Link</h3>
            <div class="space-y-3 text-xs">
                <div>
                    <label class="block font-semibold text-slate-300 uppercase mb-1">Target URL</label>
                    <input type="url" id="modal-target-url" placeholder="https://your-landing-page.com" class="w-full bg-slate-950 border border-slate-800 rounded-lg p-2.5 text-white">
                </div>
                <div>
                    <label class="block font-semibold text-slate-300 uppercase mb-1">Safe Page URL (FB Bot Target)</label>
                    <input type="url" id="modal-safe-url" value="https://news.cleanblogsite.org/privacy-article" class="w-full bg-slate-950 border border-slate-800 rounded-lg p-2.5 text-white">
                </div>
                <div>
                    <label class="block font-semibold text-slate-300 uppercase mb-1">Custom Alias (Optional)</label>
                    <input type="text" id="modal-slug" placeholder="e.g. promo-2026" class="w-full bg-slate-950 border border-slate-800 rounded-lg p-2.5 text-white">
                </div>
            </div>
            <div class="flex justify-end space-x-3 pt-2">
                <button onclick="closeCreateModal()" class="px-4 py-2 text-slate-400">Cancel</button>
                <button onclick="handleSaveNewLink()" class="px-4 py-2 bg-indigo-600 text-white rounded-lg font-medium">Save & Generate</button>
            </div>
        </div>
    </div>

    <script>
        window.onload = function() { fetchLinks(); };

        async function fetchLinks() {
            try {
                const res = await fetch('/api/get-links');
                const links = await res.json();
                const container = document.getElementById('links-container');
                
                if (links.length === 0) {
                    container.innerHTML = '<p class="text-xs text-slate-500">No links created yet.</p>';
                    return;
                }

                container.innerHTML = links.map(l => \`
                    <div class="bg-slate-950 p-4 rounded-xl border border-slate-800 flex items-center justify-between text-xs">
                        <div>
                            <a href="\${l.shortUrl}" target="_blank" class="font-bold text-indigo-400 font-mono text-sm underline">\${l.shortUrl}</a>
                            <p class="text-slate-400 mt-1">Target: \${l.targetUrl}</p>
                        </div>
                        <button onclick="navigator.clipboard.writeText('\${l.shortUrl}'); alert('Copied!');" class="bg-indigo-600/20 text-indigo-300 px-3 py-1.5 rounded border border-indigo-500/30">Copy</button>
                    </div>
                \`).join('');
            } catch(e) {
                console.error("Failed to load links");
            }
        }

        async function handleSaveNewLink() {
            const targetUrl = document.getElementById('modal-target-url').value;
            const safeUrl = document.getElementById('modal-safe-url').value;
            const customSlug = document.getElementById('modal-slug').value;

            if(!targetUrl) { alert('Enter target URL'); return; }

            const res = await fetch('/api/create-link', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ targetUrl, safeUrl, customSlug })
            });

            if(res.ok) {
                closeCreateModal();
                fetchLinks();
                alert('Permanent link created successfully!');
            } else {
                alert('Error creating link.');
            }
        }

        function openCreateModal() { document.getElementById('create-modal').classList.remove('hidden'); }
        function closeCreateModal() { document.getElementById('create-modal').classList.add('hidden'); }
    </script>
</body>
</html>`);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running with permanent storage on port ${PORT}`));
