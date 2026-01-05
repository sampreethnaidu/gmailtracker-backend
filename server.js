require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');

const app = express();

// --- CRITICAL FIX: PERMISSIVE CORS ---
// This tells the server: "Allow ANY website to talk to me."
app.use(cors({
    origin: '*', 
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));

// Backup Manual Headers (Just in case the cors package misses something)
app.use((req, res, next) => {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept");
    next();
});

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
            console.log("No ads found. Creating a test ad...");
            const testAd = new Ad({
                clientName: "Test Client",
                imageUrl: "https://dummyimage.com/180x60/000/fff&text=Ad+Space",
                planType: "ULTRA",
                maxViews: 10000,
                isActive: true
            });
            await testAd.save();
            console.log("Test Ad Created!");
        }
    } catch (err) {
        console.log("Error creating test ad:", err);
    }
};

// --- API ROUTES ---

// Route 1: Generate a Tracking ID
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
        console.log(error);
        res.status(500).json({ error: 'Error generating ID' });
    }
});

// Route 2: The Tracking Pixel (DEBUG MODE: VISIBLE RED DOT)
app.get('/api/track/:id', async (req, res) => {
    try {
        const trackingId = req.params.id;
        const email = await TrackedEmail.findOne({ trackingId: trackingId });
        
        if (email) {
            // Log it immediately
            console.log(`REAL Open Detected for: ${email.recipientEmail}`);
            
            email.opened = true;
            email.openCount += 1;
            email.openHistory.push({
                timestamp: new Date(),
                ip: req.ip,
                userAgent: req.headers['user-agent']
            });
            await email.save();
        } else {
            console.log("Tracking ID not found in database.");
        }

        // Return a VISIBLE Red Square (10x10 pixels) so you can see if it loads
        // This is a base64 encoded red GIF
        const redPixel = Buffer.from('R0lGODlhCgAKAPAAAP8AAAAAACH5BAAAAAAALAAAAAAKAAoAAAIRhI+py+0Po5y02ouz3rz7rxQAOw==', 'base64');
        
        res.writeHead(200, {
            'Content-Type': 'image/gif',
            'Content-Length': redPixel.length,
            'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate'
        });
        res.end(redPixel);
        
    } catch (error) {
        console.log("Tracking Error:", error);
        res.status(500).send('Error');
    }
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
            res.json({ found: true, imageUrl: ad.imageUrl });
        } else {
            res.json({ found: false });
        }
    } catch (error) {
        console.log(error);
        res.status(500).json({ error: 'Error serving ad' });
    }
});

// Route 4: Check Status
app.get('/api/check-status', async (req, res) => {
    try {
        const subject = req.query.subject;
        
        // Safety: If subject is missing or "(no subject)", don't search
        if (!subject || subject === "(no subject)" || subject === "") {
            return res.json({ found: false });
        }

        const email = await TrackedEmail.findOne({ subject: subject }).sort({ createdAt: -1 });
        
        if (email) {
            res.json({
                found: true,
                opened: email.opened,
                openCount: email.openCount,
                firstOpen: email.openHistory.length > 0 ? email.openHistory[0].timestamp : null
            });
        } else {
            res.json({ found: false });
        }
    } catch (error) {
        console.log(error);
        res.status(500).json({ error: 'Error checking status' });
    }
});

// Route 5: Health Check
app.get('/', (req, res) => {
    res.send('Gmail Tracker Backend is Fully Operational!');
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});