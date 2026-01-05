require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');

const app = express();

app.use(cors({ origin: '*', methods: ['GET', 'POST', 'OPTIONS'], allowedHeaders: ['Content-Type', 'Authorization'] }));
app.use(express.json());

if (!process.env.MONGO_URI) { console.error("FATAL: MONGO_URI missing."); process.exit(1); }

mongoose.connect(process.env.MONGO_URI)
    .then(() => { console.log('MongoDB Connected'); initializeAds(); })
    .catch(err => console.log('DB Error:', err));

const emailSchema = new mongoose.Schema({
    trackingId: String,
    senderEmail: String,
    recipientEmail: String,
    subject: String,
    opened: { type: Boolean, default: false },
    openCount: { type: Number, default: 0 },
    openHistory: [{ timestamp: { type: Date, default: Date.now }, ip: String, userAgent: String }],
    createdAt: { type: Date, default: Date.now }
});
const TrackedEmail = mongoose.model('TrackedEmail', emailSchema);

const adSchema = new mongoose.Schema({
    clientName: String,
    imageUrl: String,
    maxViews: Number,
    currentViews: { type: Number, default: 0 },
    isActive: { type: Boolean, default: true }
});
const Ad = mongoose.model('Ad', adSchema);

const initializeAds = async () => {
    try {
        if (await Ad.countDocuments() === 0) {
            await new Ad({
                clientName: "Parul University",
                imageUrl: "https://dummyimage.com/180x60/4a90e2/fff&text=Parul+University", // Updated default
                maxViews: 10000, isActive: true
            }).save();
        }
    } catch (err) {}
};

// Route 1: Generate ID
app.post('/api/track/generate', async (req, res) => {
    try {
        const { sender, recipient, subject } = req.body;
        const trackingId = uuidv4();
        await new TrackedEmail({ trackingId, senderEmail: sender, recipientEmail: recipient, subject }).save();
        
        const baseUrl = process.env.BASE_URL || "https://gmailtracker-backend.onrender.com";
        // Return the SPECIAL PROXY URL
        res.json({ 
            trackingId, 
            pixelUrl: `${baseUrl}/api/track-image/${trackingId}` 
        });
    } catch (error) { res.status(500).json({ error: 'Error generating ID' }); }
});

// Route 2: THE TROJAN HORSE (Image Proxy)
// This loads the Ad Image BUT counts it as an Open first!
app.get('/api/track-image/:id', async (req, res) => {
    try {
        const trackingId = req.params.id;
        const email = await TrackedEmail.findOne({ trackingId: trackingId });
        
        if (email) {
            console.log(`TROJAN OPEN: ${email.recipientEmail}`);
            email.opened = true;
            email.openCount += 1;
            email.openHistory.push({ timestamp: new Date(), ip: req.ip, userAgent: req.headers['user-agent'] });
            await email.save();
        }

        // Now, find the Ad and redirect the user to the real image
        const ad = await Ad.findOne({ isActive: true });
        const realImageUrl = ad ? ad.imageUrl : "https://dummyimage.com/180x60/000/fff&text=Ad";
        
        // 302 Redirect tells the browser "The image you want is actually over here"
        res.redirect(realImageUrl);
        
    } catch (error) { res.status(500).send('Error'); }
});

// Route 3: Ads
app.get('/api/ads/serve', async (req, res) => {
    try {
        const ad = await Ad.findOne({ isActive: true, $expr: { $lt: ["$currentViews", "$maxViews"] } });
        if (ad) {
            ad.currentViews += 1;
            await ad.save();
            res.json({ found: true, imageUrl: ad.imageUrl });
        } else { res.json({ found: false }); }
    } catch (error) { res.status(500).json({ error: 'Error' }); }
});

// Route 4: Check Status
app.get('/api/check-status', async (req, res) => {
    try {
        const subject = req.query.subject;
        if (!subject || subject === "(no subject)") return res.json({ found: false });

        const email = await TrackedEmail.findOne({ subject: subject }).sort({ createdAt: -1 });
        if (email) {
            res.json({
                found: true,
                opened: email.opened,
                openCount: email.openCount,
                recipient: email.recipientEmail,
                firstOpen: email.openHistory.length > 0 ? email.openHistory[0].timestamp : null
            });
        } else { res.json({ found: false }); }
    } catch (error) { res.status(500).json({ error: 'Error' }); }
});

app.get('/', (req, res) => res.send('Backend Operational'));
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));