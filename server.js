require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');

const app = express();

// --- CORS: Allow Gmail to talk to Server ---
app.use(cors({
    origin: '*', 
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json());

// --- DATABASE CONNECTION ---
if (!process.env.MONGO_URI) {
    console.error("FATAL ERROR: MONGO_URI is missing in Environment Variables.");
    process.exit(1);
}

mongoose.connect(process.env.MONGO_URI)
    .then(() => {
        console.log('MongoDB Connected Successfully');
        initializeAds();
    })
    .catch(err => console.log('MongoDB Connection Error:', err));

// --- DATA MODELS ---
const emailSchema = new mongoose.Schema({
    trackingId: String,
    senderEmail: String,
    recipientEmail: String,
    subject: String,
    opened: { type: Boolean, default: false },
    openCount: { type: Number, default: 0 },
    openHistory: [{
        timestamp: { type: Date, default: Date.now },
        ip: String,
        userAgent: String
    }],
    createdAt: { type: Date, default: Date.now }
});
const TrackedEmail = mongoose.model('TrackedEmail', emailSchema);

const adSchema = new mongoose.Schema({
    clientName: String,
    imageUrl: String,
    planType: { type: String, enum: ['BASIC', 'PREMIUM', 'ULTRA'], default: 'BASIC' },
    maxViews: Number,
    currentViews: { type: Number, default: 0 },
    isActive: { type: Boolean, default: true }
});
const Ad = mongoose.model('Ad', adSchema);

// --- SEED DATA ---
const initializeAds = async () => {
    try {
        const count = await Ad.countDocuments();
        if (count === 0) {
            console.log("Creating test ad...");
            const testAd = new Ad({
                clientName: "Test Client",
                imageUrl: "https://dummyimage.com/180x60/000/fff&text=Ad+Space",
                planType: "ULTRA",
                maxViews: 10000,
                isActive: true
            });
            await testAd.save();
        }
    } catch (err) { console.log(err); }
};

// --- API ROUTES ---

// Route 1: Generate ID
app.post('/api/track/generate', async (req, res) => {
    try {
        const { sender, recipient, subject } = req.body;
        const trackingId = uuidv4();
        
        const newEmail = new TrackedEmail({
            trackingId,
            senderEmail: sender,
            recipientEmail: recipient,
            subject: subject
        });
        await newEmail.save();
        
        const baseUrl = process.env.BASE_URL || "https://gmailtracker-backend.onrender.com";
        console.log(`Generated ID for: ${recipient}`);
        
        res.json({ trackingId, pixelUrl: `${baseUrl}/api/track/${trackingId}` });
    } catch (error) {
        res.status(500).json({ error: 'Error generating ID' });
    }
});

// Route 2: Tracking Pixel (Anti-Cache + Spacer Mode)
app.get('/api/track/:id', async (req, res) => {
    try {
        const trackingId = req.params.id;
        const email = await TrackedEmail.findOne({ trackingId: trackingId });
        
        if (email) {
            console.log(`REAL Open Detected: ${email.recipientEmail}`);
            email.opened = true;
            email.openCount += 1;
            email.openHistory.push({
                timestamp: new Date(),
                ip: req.ip,
                userAgent: req.headers['user-agent']
            });
            await email.save();
        }

        // 5x5 Transparent GIF (Looks like a layout spacer, not a tracker)
        const pixel = Buffer.from('R0lGODlhBQAFAIAAAAAAAP///yH5BAEAAAAALAAAAAAFAAUAAAIHhI+py+1dAAA7', 'base64');
        
        res.writeHead(200, {
            'Content-Type': 'image/gif',
            'Content-Length': pixel.length,
            // AGGRESSIVE NO-CACHE HEADERS
            'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0',
            'Pragma': 'no-cache',
            'Expires': '0',
            'Surrogate-Control': 'no-store'
        });
        res.end(pixel);
        
    } catch (error) {
        console.log("Track Error:", error);
        res.status(500).send('Error');
    }
});

// Route 3: Ads
app.get('/api/ads/serve', async (req, res) => {
    try {
        const ad = await Ad.findOne({ 
            isActive: true,
            $expr: { $lt: ["$currentViews", "$maxViews"] } 
        });

        if (ad) {
            ad.currentViews += 1;
            await ad.save();
            res.json({ found: true, imageUrl: ad.imageUrl });
        } else {
            res.json({ found: false });
        }
    } catch (error) {
        res.status(500).json({ error: 'Error serving ad' });
    }
});

// Route 4: Check Status
app.get('/api/check-status', async (req, res) => {
    try {
        const subject = req.query.subject;
        if (!subject || subject === "(no subject)" || subject === "") {
            return res.json({ found: false });
        }

        const email = await TrackedEmail.findOne({ subject: subject }).sort({ createdAt: -1 });
        
        if (email) {
            res.json({
                found: true,
                opened: email.opened,
                openCount: email.openCount,
                recipient: email.recipientEmail,
                firstOpen: email.openHistory.length > 0 ? email.openHistory[0].timestamp : null
            });
        } else {
            res.json({ found: false });
        }
    } catch (error) {
        res.status(500).json({ error: 'Error checking status' });
    }
});

app.get('/', (req, res) => res.send('Backend Operational'));

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});