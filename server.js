require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');

const app = express();

app.use(cors({ origin: '*', methods: ['GET', 'POST', 'OPTIONS'] }));
app.use(express.json());

// --- DATABASE CONNECTION ---
if (!process.env.MONGO_URI) { console.error("FATAL: MONGO_URI missing."); process.exit(1); }
mongoose.connect(process.env.MONGO_URI)
    .then(() => {
        console.log('MongoDB Connected');
        initializeDefaults();
    })
    .catch(err => console.log('DB Error:', err));

// --- SCHEMAS ---

// 1. Email Tracking Schema
const emailSchema = new mongoose.Schema({
    trackingId: String,
    senderEmail: String,
    recipientEmails: [String], // Array to store To, CC, BCC
    subject: String,
    opened: { type: Boolean, default: false },
    openCount: { type: Number, default: 0 },
    openHistory: [{
        timestamp: { type: Date, default: Date.now },
        ip: String,
        userAgent: String,
        location: String // Placeholder for IP geolocation
    }],
    createdAt: { type: Date, default: Date.now }
});
const TrackedEmail = mongoose.model('TrackedEmail', emailSchema);

// 2. User Schema (For Plans & Ad Clients)
const userSchema = new mongoose.Schema({
    email: { type: String, unique: true },
    plan: { type: String, enum: ['free', 'premium'], default: 'free' },
    isAdClient: { type: Boolean, default: false },
    adPlan: { type: String, enum: ['none', 'basic', 'premium', 'ultra'], default: 'none' },
    createdAt: { type: Date, default: Date.now }
});
const User = mongoose.model('User', userSchema);

// 3. Ad Schema (Content from Cloud)
const adSchema = new mongoose.Schema({
    clientName: String,
    imageUrl: String, // The ad image
    targetPlan: { type: String, enum: ['basic', 'premium', 'ultra'] }, 
    maxViews: Number,
    currentViews: { type: Number, default: 0 },
    isActive: { type: Boolean, default: true }
});
const Ad = mongoose.model('Ad', adSchema);

// --- INITIALIZER ---
const initializeDefaults = async () => {
    try {
        if (await Ad.countDocuments() === 0) {
            await new Ad({
                clientName: "Parul University",
                imageUrl: "https://dummyimage.com/600x100/4a90e2/fff&text=Ad+Space+Available",
                maxViews: 10000, 
                isActive: true,
                targetPlan: 'basic'
            }).save();
            console.log("Default Ad Initialized");
        }
    } catch (err) {}
};

// --- ROUTES ---

// Route 1: Generate Tracking ID (Called when you click Send)
app.post('/api/track/generate', async (req, res) => {
    try {
        const { sender, recipients, subject } = req.body;
        const trackingId = uuidv4();
        
        await new TrackedEmail({ 
            trackingId, 
            senderEmail: sender, 
            recipientEmails: recipients, 
            subject 
        }).save();
        
        // IMPORTANT: Change this to your actual Render URL when deploying
        const baseUrl = process.env.BASE_URL || "https://gmailtracker-backend.onrender.com"; 
        
        res.json({ 
            trackingId, 
            // This is the INVISIBLE PIXEL the recipient gets
            pixelUrl: `${baseUrl}/api/track-image/${trackingId}` 
        });
    } catch (error) { 
        console.error(error);
        res.status(500).json({ error: 'Error generating ID' }); 
    }
});

// Route 2: THE TRACKING PIXEL (With Bot Filter)
app.get('/api/track-image/:id', async (req, res) => {
    try {
        const trackingId = req.params.id;
        const userAgent = req.headers['user-agent'] || '';
        const ip = req.ip;

        // --- BOT FILTERING LOGIC ---
        // If these words appear in User-Agent, it is NOT a human.
        const isBot = /GoogleImageProxy|Gmail|YahooMailProxy|bot|crawler|spider|facebookexternalhit/i.test(userAgent);

        if (!isBot) {
            const email = await TrackedEmail.findOne({ trackingId: trackingId });
            if (email) {
                console.log(`REAL HUMAN OPEN: ${email.subject}`);
                email.opened = true;
                email.openCount += 1;
                email.openHistory.push({ 
                    timestamp: new Date(), 
                    ip: ip, 
                    userAgent: userAgent 
                });
                await email.save();
            }
        } else {
            console.log(`BOT IGNORED: ${userAgent}`);
        }

        // Always serve a transparent 1x1 pixel
        const img = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
        res.writeHead(200, {
            'Content-Type': 'image/gif',
            'Content-Length': img.length,
            'Cache-Control': 'no-cache, no-store, must-revalidate'
        });
        res.end(img);
        
    } catch (error) { res.status(500).send('Error'); }
});

// Route 3: Serve Ads (For the Extension Footer ONLY)
app.get('/api/ads/serve', async (req, res) => {
    try {
        // Find an active ad that hasn't reached its view limit
        const ad = await Ad.findOne({ 
            isActive: true, 
            $expr: { $lt: ["$currentViews", "$maxViews"] } 
        });

        if (ad) {
            ad.currentViews += 1;
            await ad.save();
            res.json({ found: true, clientName: ad.clientName, imageUrl: ad.imageUrl });
        } else { 
            res.json({ found: false }); 
        }
    } catch (error) { res.status(500).json({ error: 'Error' }); }
});

// Route 4: Status Check (For the Green Ticks in Gmail)
app.get('/api/check-status', async (req, res) => {
    try {
        const { subject } = req.query;
        if (!subject) return res.json({ found: false });

        const email = await TrackedEmail.findOne({ subject: subject }).sort({ createdAt: -1 });
        
        if (email) {
            res.json({
                found: true,
                opened: email.opened,
                openCount: email.openCount,
                recipient: email.recipientEmails[0], // Show first recipient
                firstOpen: email.openHistory.length > 0 ? email.openHistory[0].timestamp : null
            });
        } else { res.json({ found: false }); }
    } catch (error) { res.status(500).json({ error: 'Error' }); }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));