const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(express.json());
app.use(cors());

// In-memory database (For production, replace with MongoDB or PostgreSQL)
const linksDB = {}; 

// Serve the frontend dashboard
app.use(express.static(path.join(__dirname, 'public')));

// 1. API Endpoint to Create Links (Called by your Dashboard)
app.post('/api/create-link', (req, res) => {
    const { targetUrl, safeUrl, customSlug, pixels } = req.body;
    
    // Generate a random 5-character slug if a custom one isn't provided
    const slug = customSlug || Math.random().toString(36).substring(2, 7);
    
    linksDB[slug] = { targetUrl, safeUrl, pixels, clicks: 0, botHits: 0 };
    
    // Return the functional shortened URL
    res.json({ shortUrl: `https://yourdomain.com/${slug}`, slug });
});

// 2. The Core Cloaking & Redirect Engine (The Magic)
app.get('/:slug', (req, res) => {
    const slug = req.params.slug;
    const linkData = linksDB[slug];

    // If link doesn't exist, send them to a 404 or fallback page
    if (!linkData) {
        return res.status(404).send('Link not found');
    }

    const userAgent = req.headers['user-agent'] || '';
    
    // Facebook Bot Detection Regex
    const isBot = /facebookexternalhit|Facebot|WhatsApp|TelegramBot|Twitterbot/i.test(userAgent);

    if (isBot) {
        // CRAWLER DETECTED: Serve the Safe Page
        linkData.botHits++;
        console.log(`[BOT INTERCEPTED] Serving safe page for slug: ${slug}`);
        
        // Return a true HTTP 302 redirect to the safe page
        return res.redirect(302, linkData.safeUrl);
    } else {
        // REAL HUMAN DETECTED: Serve the Target Page
        linkData.clicks++;
        console.log(`[HUMAN ALLOWED] Redirecting to target for slug: ${slug}`);
        
        // Return a true HTTP 302 redirect to the money/target page
        return res.redirect(302, linkData.targetUrl);
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
