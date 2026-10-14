const express = require('express');
const cors = require('cors');

const app = express();
app.use(express.json());
app.use(cors());

// In-memory database for your links
const linksDB = {};

// 1. API Endpoint to create links from your dashboard
app.post('/api/create-link', (req, res) => {
    const { targetUrl, safeUrl, customSlug } = req.body;
    const slug = customSlug || Math.random().toString(36).substring(2, 7);
    
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

// 2. The Core Cloaking & Redirect Engine (Catches the short links and redirects)
app.get('/:slug', (req, res) => {
    const slug = req.params.slug;
    
    // Ignore browser asset requests
    if (slug === 'favicon.ico' || slug === 'api') return;

    const linkData = linksDB[slug];
    if (!linkData) {
        return res.status(404).send('Link not found or expired.');
    }

    const userAgent = req.headers['user-agent'] || '';
    
    // Check if the visitor is a Facebook or social crawler bot
    const isBot = /facebookexternalhit|Facebot|WhatsApp|TelegramBot|Twitterbot|Googlebot/i.test(userAgent);

    if (isBot) {
        linkData.botHits++;
        console.log(`[BOT BLOCKED] Routing Facebook crawler to safe page for slug: ${slug}`);
        return res.redirect(302, linkData.safeUrl);
    } else {
        linkData.clicks++;
        console.log(`[HUMAN PASSED] Redirecting real user to target for slug: ${slug}`);
        return res.redirect(302, linkData.targetUrl);
    }
});

// 3. Serve the full dashboard interface directly
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
        <aside class="w-64 bg-slate-900 border-r border-slate-800 flex flex-col justify-between">
            <div class="p-6 border-b border-slate-800 flex items-center space-x-3">
                <div class="bg-indigo-600 p-2.5 rounded-xl text-white"><i class="fa-solid fa-link"></i></div>
                <span class="font-bold text-xl text-white">NexLink<span class="text-indigo-500">.io</span></span>
            </div>
            <div class="p-4 text-xs text-emerald-400 bg-emerald-950/40 m-4 rounded-xl border border-emerald-500/30">
                <i class="fa-solid fa-user-ninja mr-1"></i> FB Crawler Shield Active
            </div>
            <div class="p-4 text-xs text-slate-400">Server Status: <span class="text-emerald-400 font-bold">Online & Ready</span></div>
        </aside>
        <main class="flex-1 p-8 overflow-y-auto">
            <div class="max-w-3xl mx-auto bg-slate-900 border border-slate-800 p-6 rounded-2xl space-y-6">
                <h2 class="text-xl font-bold text-white"><i class="fa-solid fa-shield-halved text-indigo-400 mr-2"></i>Create Functional Cloaked Short Link</h2>
                <div class="space-y-4 text-sm">
                    <div>
                        <label class="block text-xs font-semibold text-slate-300 uppercase mb-1">Target URL (Where humans go)</label>
                        <input type="url" id="target-url" placeholder="https://your-landing-page.com" class="w-full bg-slate-950 border border-slate-800 rounded-lg p-3 text-white focus:border-indigo-500">
                    </div>
                    <div>
                        <label class="block text-xs font-semibold text-slate-300 uppercase mb-1">Safe Page URL (Where Facebook bots go)</label>
                        <input type="url" id="safe-url" value="https://news.cleanblogsite.org/privacy-article" class="w-full bg-slate-950 border border-slate-800 rounded-lg p-3 text-white focus:border-indigo-500">
                    </div>
                    <div>
                        <label class="block text-xs font-semibold text-slate-300 uppercase mb-1">Custom Alias / Slug (Optional)</label>
                        <input type="text" id="custom-slug" placeholder="e.g. promo-2026" class="w-full bg-slate-950 border border-slate-800 rounded-lg p-3 text-white focus:border-indigo-500">
                    </div>
                    <button onclick="generateLink()" class="w-full bg-indigo-600 hover:bg-indigo-500 text-white font-bold p-3 rounded-lg shadow-lg">Generate Working Cloaked Link</button>
                </div>
                <div id="result-box" class="hidden p-4 bg-slate-950 border border-indigo-500/40 rounded-xl space-y-2">
                    <p class="text-xs text-slate-400 uppercase font-bold">Your Live Functional Link:</p>
                    <input type="text" id="output-link" readonly class="w-full bg-slate-900 border border-slate-800 p-2.5 rounded text-indigo-400 font-mono text-sm">
                </div>
            </div>
        </main>
    </div>
    <script>
        async function generateLink() {
            const targetUrl = document.getElementById('target-url').value;
            const safeUrl = document.getElementById('safe-url').value;
            const customSlug = document.getElementById('custom-slug').value;

            if(!targetUrl) { alert('Please enter a Target URL'); return; }

            const res = await fetch('/api/create-link', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ targetUrl, safeUrl, customSlug })
            });
            const data = await res.json();
            if(res.ok) {
                document.getElementById('result-box').classList.remove('hidden');
                document.getElementById('output-link').value = data.shortUrl;
                alert('Success! Your link is live and fully functional.');
            } else {
                alert('Error creating link');
            }
        }
    </script>
</body>
</html>`);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Server running'));
