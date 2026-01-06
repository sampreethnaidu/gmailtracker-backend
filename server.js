/* server.js - Final Version (History Fix) */
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
const emailSchema = new mongoose.Schema({
    trackingId: String,
    senderEmail: String,
    recipientEmails: [String],
    subject: String,
    opened: { type: Boolean, default: false },
    openCount: { type: Number, default: 0 },
    openHistory: [{
        timestamp: { type: Date, default: Date.now },
        ip: String,
        userAgent: String,
        location: String
    }],
    createdAt: { type: Date, default: Date.now }
});
const TrackedEmail = mongoose.model('TrackedEmail', emailSchema);

const adSchema = new mongoose.Schema({
    clientName: String,
    imageUrl: String,
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

// Route 1: Generate Tracking ID
app.post('/api/track/generate', async (req, res) => {
    try {
        const { sender, recipients, subject, trackingId } = req.body;
        const finalId = trackingId || uuidv4();
        
        await new TrackedEmail({ 
            trackingId: finalId, 
            senderEmail: sender, 
            recipientEmails: recipients, 
            subject 
        }).save();
        
        const baseUrl = process.env.BASE_URL || "https://gmailtracker-backend.onrender.com"; 
        
        res.json({ 
            trackingId: finalId, 
            pixelUrl: `${baseUrl}/api/track-image/${finalId}` 
        });
    } catch (error) { 
        console.error(error);
        res.status(500).json({ error: 'Error generating ID' }); 
    }
});

// Route 2: THE TRACKING PIXEL
app.get('/api/track-image/:id', async (req, res) => {
    try {
        const trackingId = req.params.id;
        const userAgent = req.headers['user-agent'] || '';
        const ip = req.ip;

        const isBot = /bot|crawler|spider|facebookexternalhit/i.test(userAgent);

        if (!isBot) {
            const email = await TrackedEmail.findOne({ trackingId: trackingId });
            if (email) {
                console.log(`REAL OPEN DETECTED: ${email.subject}`);
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
            console.log(`BOT BLOCKED: ${userAgent}`);
        }

        const img = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
        res.writeHead(200, {
            'Content-Type': 'image/gif',
            'Content-Length': img.length,
            'Cache-Control': 'no-cache, no-store, must-revalidate'
        });
        res.end(img);
        
    } catch (error) { res.status(500).send('Error'); }
});

// Route 3: Serve Ads
app.get('/api/ads/serve', async (req, res) => {
    try {
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

// Route 4: Status Check (FIXED HERE)
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
                recipient: email.recipientEmails[0],
                
                // --- THE MISSING LINE IS ADDED BELOW ---
                openHistory: email.openHistory, 
                // ---------------------------------------

                firstOpen: email.openHistory.length > 0 ? email.openHistory[0].timestamp : null
            });
        } else { res.json({ found: false }); }
    } catch (error) { res.status(500).json({ error: 'Error' }); }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));