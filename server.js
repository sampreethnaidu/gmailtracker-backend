/* server.js - Final Production Version (Admin & Dashboard Ready) */
require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');

const app = express();

app.use(cors({ origin: '*', methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'] }));
app.use(express.json());

// --- DATABASE CONNECTION ---
if (!process.env.MONGO_URI) { console.error("FATAL: MONGO_URI missing."); process.exit(1); }
mongoose.connect(process.env.MONGO_URI)
    .then(() => {
        console.log('MongoDB Connected');
        initializeSystemDefaults();
    })
    .catch(err => console.log('DB Error:', err));

// ==========================================
// --- SCHEMAS ---
// ==========================================

// 1. TRACKED EMAIL
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

// 2. USER (For Admin Panel)
const userSchema = new mongoose.Schema({
    name: String,
    email: { type: String, unique: true, required: true },
    role: { type: String, enum: ['user', 'ad_client', 'admin'], default: 'user' },
    plan: { type: String, enum: ['free', 'premium', 'ad_basic', 'ad_premium', 'ad_ultra'], default: 'free' },
    createdAt: { type: Date, default: Date.now }
});
const User = mongoose.model('User', userSchema);

// 3. VOUCHER (Cloud Codes)
const voucherSchema = new mongoose.Schema({
    code: { type: String, unique: true, required: true },
    planType: { type: String, enum: ['premium', 'ad_basic', 'ad_premium', 'ad_ultra'], required: true },
    isRedeemed: { type: Boolean, default: false },
    redeemedBy: String,
    createdAt: { type: Date, default: Date.now }
});
const Voucher = mongoose.model('Voucher', voucherSchema);

// 4. ADVERTISEMENT
const adSchema = new mongoose.Schema({
    clientName: String,
    imageUrl: String,
    adPlan: { type: String, enum: ['basic', 'premium', 'ultra'], default: 'basic' }, 
    maxViews: Number,
    currentViews: { type: Number, default: 0 },
    isActive: { type: Boolean, default: true },
    createdAt: { type: Date, default: Date.now }
});
const Ad = mongoose.model('Ad', adSchema);

// ==========================================
// --- SYSTEM DEFAULTS ---
// ==========================================
const initializeSystemDefaults = async () => {
    try {
        const count = await Ad.countDocuments({ clientName: "VITSN Innovations" });
        if (count === 0) {
            await new Ad({
                clientName: "VITSN Innovations",
                imageUrl: "https://dummyimage.com/600x80/f1f3f4/555555&text=Sponsored+by+VITSN+Innovations+@copyright+by+Mr,+Yellapu+Sampreeth+Naidu",
                adPlan: 'ultra',
                maxViews: 999999999,
                isActive: true
            }).save();
            console.log("System Default Ad Initialized");
        }
    } catch (err) { console.error("Init Error:", err); }
};

// ==========================================
// --- EXTENSION API ROUTES ---
// ==========================================

// 1. Generate Tracking ID
app.post('/api/track/generate', async (req, res) => {
    try {
        const { sender, recipients, subject, trackingId } = req.body;
        const finalId = trackingId || uuidv4();
        await new TrackedEmail({ trackingId: finalId, senderEmail: sender, recipientEmails: recipients, subject }).save();
        const baseUrl = process.env.BASE_URL || "https://gmailtracker-backend.onrender.com"; 
        res.json({ trackingId: finalId, pixelUrl: `${baseUrl}/api/track-image/${finalId}` });
    } catch (error) { res.status(500).json({ error: 'Error generating ID' }); }
});

// 2. Tracking Pixel
app.get('/api/track-image/:id', async (req, res) => {
    try {
        const trackingId = req.params.id;
        const userAgent = req.headers['user-agent'] || '';
        const isBot = /bot|crawler|spider|facebookexternalhit/i.test(userAgent);

        if (!isBot) {
            const email = await TrackedEmail.findOne({ trackingId: trackingId });
            if (email) {
                console.log(`REAL OPEN: ${email.subject}`);
                email.opened = true;
                email.openCount += 1;
                email.openHistory.push({ timestamp: new Date(), ip: req.ip, userAgent: userAgent });
                await email.save();
            }
        }
        const img = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
        res.writeHead(200, { 'Content-Type': 'image/gif', 'Content-Length': img.length, 'Cache-Control': 'no-cache, no-store, must-revalidate' });
        res.end(img);
    } catch (error) { res.status(500).send('Error'); }
});

// 3. Status Check (With Full History)
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
                openHistory: email.openHistory,
                firstOpen: email.openHistory.length > 0 ? email.openHistory[0].timestamp : null
            });
        } else { res.json({ found: false }); }
    } catch (error) { res.status(500).json({ error: 'Error' }); }
});

// 4. Serve Ads (Smart Logic)
app.get('/api/ads/serve', async (req, res) => {
    try {
        let ad = await Ad.findOne({ isActive: true, clientName: { $ne: "VITSN Innovations" }, $expr: { $lt: ["$currentViews", "$maxViews"] } });
        if (!ad) ad = await Ad.findOne({ clientName: "VITSN Innovations" });

        if (ad) {
            if (ad.clientName !== "VITSN Innovations") { ad.currentViews += 1; await ad.save(); }
            res.json({ found: true, clientName: ad.clientName, imageUrl: ad.imageUrl });
        } else {
            res.json({ found: true, clientName: "VITSN Innovations", imageUrl: "https://dummyimage.com/600x80/f1f3f4/555555&text=Sponsored+by+VITSN+Innovations" });
        }
    } catch (error) { res.status(500).json({ error: 'Error serving ad' }); }
});

// ==========================================
// --- ADMIN DASHBOARD API ROUTES ---
// ==========================================

// 5. Dashboard Stats
app.get('/api/admin/stats', async (req, res) => {
    try {
        const totalEmails = await TrackedEmail.countDocuments();
        const openedEmails = await TrackedEmail.countDocuments({ opened: true });
        const totalUsers = await User.countDocuments();
        const totalAds = await Ad.countDocuments();
        const totalVouchers = await Voucher.countDocuments();
        res.json({ totalEmails, openedEmails, openRate: totalEmails ? ((openedEmails/totalEmails)*100).toFixed(1) : 0, totalUsers, totalAds, totalVouchers });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// 6. Users
app.post('/api/admin/users', async (req, res) => {
    try { const newUser = new User(req.body); await newUser.save(); res.json(newUser); } 
    catch (err) { res.status(500).json({ error: "User exists" }); }
});
app.get('/api/admin/users', async (req, res) => {
    try { const users = await User.find().sort({ createdAt: -1 }); res.json(users); } 
    catch (err) { res.status(500).json({ error: err.message }); }
});

// 7. Vouchers
app.post('/api/admin/vouchers', async (req, res) => {
    try { const newVoucher = new Voucher(req.body); await newVoucher.save(); res.json(newVoucher); } 
    catch (err) { res.status(500).json({ error: "Code exists" }); }
});
app.get('/api/admin/vouchers', async (req, res) => {
    try { const vouchers = await Voucher.find().sort({ createdAt: -1 }); res.json(vouchers); } 
    catch (err) { res.status(500).json({ error: err.message }); }
});

// 8. Ads
app.post('/api/admin/ads', async (req, res) => {
    try {
        const { clientName, imageUrl, adPlan } = req.body;
        let maxViews = 1000;
        if (adPlan === 'premium') maxViews = 10000;
        if (adPlan === 'ultra') maxViews = 100000;
        const newAd = new Ad({ clientName, imageUrl, adPlan, maxViews });
        await newAd.save();
        res.json(newAd);
    } catch (err) { res.status(500).json({ error: err.message }); }
});
app.get('/api/admin/ads', async (req, res) => {
    try { const ads = await Ad.find().sort({ createdAt: -1 }); res.json(ads); } 
    catch (err) { res.status(500).json({ error: err.message }); }
});
app.delete('/api/admin/ads/:id', async (req, res) => {
    try { await Ad.findByIdAndDelete(req.params.id); res.json({ message: "Deleted" }); } 
    catch (err) { res.status(500).json({ error: err.message }); }
});
app.patch('/api/admin/ads/:id/toggle', async (req, res) => {
    try {
        const ad = await Ad.findById(req.params.id);
        if (ad) { ad.isActive = !ad.isActive; await ad.save(); res.json(ad); } 
        else { res.status(404).json({ error: "Not Found" }); }
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// 9. Emails
app.get('/api/admin/emails', async (req, res) => {
    try {
        const { search = '' } = req.query;
        let query = {};
        if (search) query = { subject: { $regex: search, $options: 'i' } };
        const emails = await TrackedEmail.find(query).sort({ createdAt: -1 }).limit(100);
        res.json({ emails });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));