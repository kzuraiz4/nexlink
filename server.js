const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(express.json());
app.use(cors());

// Memory store for generated short links
const linksDB = {};

// 1. Serve static files from the 'public' folder
app.use(express.static(path.join(__dirname, 'public')));

// 2. API Endpoint called by the Dashboard to create links
app.post('/api/create-link', (req, res) => {
    const { targetUrl, safeUrl, customSlug } = req.body;
    
    // Use custom slug or generate a random 5-character string
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

// 3. Core Cloaking & Redirect Router
app.get('/:slug', (req, res, next) => {
    const slug = req.params.slug;
    
    // Ignore internal requests
    if (slug === 'favicon.ico' || slug === 'api') return next();

    const linkData = linksDB[slug];
    if (!linkData) {
        return res.status(404).send(`
            <div style="font-family: sans-serif; text-align: center; padding: 50px; background: #0f172a; color: white;">
                <h2>Link Not Found or Expired</h2>
                <p style="color: #94a3b8;">The requested short link does not exist on this server.</p>
            </div>
        `);
    }

    const userAgent = req.headers['user-agent'] || '';
    
    // Facebook & Social Crawler Detection Logic
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

// Serve index.html for root path
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`NexLink Server running on port ${PORT}`));
