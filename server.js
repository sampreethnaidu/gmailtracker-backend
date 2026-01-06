/* server.js - Final Commercial Edition (Auth + History + Ads + Admin) */
require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const bcrypt = require('bcryptjs'); // Security: For password hashing
const jwt = require('jsonwebtoken'); // Security: For login tokens

const app = express();
const JWT_SECRET = process.env.JWT_SECRET || "vitsn-super-secret-key-2026"; // Change this in production

app.use(cors({ origin: '*', methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'] }));
app.use(express.json());

// --- DATABASE CONNECTION ---
if (!process.env.MONGO_URI) { console.error("FATAL: MONGO_URI missing."); process.exit(1); }
mongoose.connect(process.env.MONGO_URI)
    .then(() => {
        console.log('MongoDB Connected');
        initializeSystem();
    })
    .catch(err => console.log('DB Error:', err));

// ==========================================
// --- SCHEMAS ---
// ==========================================

// 1. USER (Admin & Clients - Secure)
const userSchema = new mongoose.Schema({
    name: String,
    email: { type: String, unique: true, required: true },
    password: { type: String, select: false }, // Hidden by default for security
    role: { type: String, enum: ['user', 'ad_client', 'admin'], default: 'user' },
    plan: { type: String, enum: ['free', 'premium', 'ad_basic', 'ad_premium', 'ad_ultra'], default: 'free' },
    createdAt: { type: Date, default: Date.now }
});
const User = mongoose.model('User', userSchema);

// 2. TRACKED EMAIL
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

// 3. ADVERTISEMENT
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

// 4. VOUCHER
const voucherSchema = new mongoose.Schema({
    code: { type: String, unique: true, required: true },
    planType: { type: String, required: true },
    isRedeemed: { type: Boolean, default: false },
    redeemedBy: String,
    createdAt: { type: Date, default: Date.now }
});
const Voucher = mongoose.model('Voucher', voucherSchema);

// ==========================================
// --- INITIALIZER (Admin & Defaults) ---
// ==========================================
const initializeSystem = async () => {
    try {
        // 1. Create Default Admin (If missing)
        const adminExists = await User.findOne({ role: 'admin' });
        if (!adminExists) {
            const hashedPassword = await bcrypt.hash("admin123", 10); // Default Password
            await new User({
                name: "Super Admin",
                email: "admin@vitsn.com",
                password: hashedPassword,
                role: "admin",
                plan: "premium"
            }).save();
            console.log(">> SYSTEM: Default Admin Created (admin@vitsn.com / admin123)");
        }

        // 2. Create Default Fallback Ad (If missing)
        const adCount = await Ad.countDocuments({ clientName: "VITSN Innovations" });
        if (adCount === 0) {
            await new Ad({
                clientName: "VITSN Innovations",
                imageUrl: "https://dummyimage.com/600x80/f1f3f4/555555&text=Sponsored+by+VITSN+Innovations+@copyright+by+Mr,+Yellapu+Sampreeth+Naidu",
                adPlan: 'ultra',
                maxViews: 999999999,
                isActive: true
            }).save();
            console.log(">> SYSTEM: Default Fallback Ad Initialized");
        }
    } catch (err) { console.error("Init Error:", err); }
};

// ==========================================
// --- MIDDLEWARE (Security Guard) ---
// ==========================================
const auth = (req, res, next) => {
    const token = req.header('Authorization');
    if (!token) return res.status(401).json({ error: "Access Denied. Login required." });

    try {
        // Extract token (remove 'Bearer ' if present)
        const cleanToken = token.replace('Bearer ', '');
        const verified = jwt.verify(cleanToken, JWT_SECRET);
        req.user = verified;
        next();
    } catch (err) {
        res.status(400).json({ error: "Invalid Token" });
    }
};

// ==========================================
// --- ROUTES ---
// ==========================================

// --- 1. AUTHENTICATION (Login) ---
app.post('/api/auth/login', async (req, res) => {
    try {
        const { email, password } = req.body;
        
        // Find user and explicitly select password (since it's hidden by default)
        const user = await User.findOne({ email }).select('+password');
        if (!user) return res.status(400).json({ error: "User not found" });

        // Check password
        const validPass = await bcrypt.compare(password, user.password);
        if (!validPass) return res.status(400).json({ error: "Invalid password" });

        // Check role
        if (user.role !== 'admin') return res.status(403).json({ error: "Access restricted to Admins" });

        // Generate Token
        const token = jwt.sign({ _id: user._id, role: user.role }, JWT_SECRET, { expiresIn: '12h' });
        
        res.json({ token, user: { name: user.name, email: user.email, role: user.role } });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// --- 2. EXTENSION API (Public) ---

// Generate ID
app.post('/api/track/generate', async (req, res) => {
    try {
        const { sender, recipients, subject, trackingId } = req.body;
        const finalId = trackingId || uuidv4();
        await new TrackedEmail({ trackingId: finalId, senderEmail: sender, recipientEmails: recipients, subject }).save();
        const baseUrl = process.env.BASE_URL || "https://gmailtracker-backend.onrender.com"; 
        res.json({ trackingId: finalId, pixelUrl: `${baseUrl}/api/track-image/${finalId}` });
    } catch (error) { res.status(500).json({ error: 'Error generating ID' }); }
});

// Tracking Pixel
app.get('/api/track-image/:id', async (req, res) => {
    try {
        const trackingId = req.params.id;
        const userAgent = req.headers['user-agent'] || '';
        const ip = req.ip;
        const isBot = /bot|crawler|spider|facebookexternalhit/i.test(userAgent);

        if (!isBot) {
            const email = await TrackedEmail.findOne({ trackingId: trackingId });
            if (email) {
                console.log(`REAL OPEN: ${email.subject}`);
                email.opened = true;
                email.openCount += 1;
                email.openHistory.push({ timestamp: new Date(), ip: ip, userAgent: userAgent });
                await email.save();
            }
        }
        const img = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
        res.writeHead(200, { 'Content-Type': 'image/gif', 'Content-Length': img.length, 'Cache-Control': 'no-cache, no-store, must-revalidate' });
        res.end(img);
    } catch (error) { res.status(500).send('Error'); }
});

// Check Status (With Full History)
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
                openHistory: email.openHistory, // Sends full history
                firstOpen: email.openHistory.length > 0 ? email.openHistory[0].timestamp : null
            });
        } else { res.json({ found: false }); }
    } catch (error) { res.status(500).json({ error: 'Error' }); }
});

// 4. Serve Ads (Smart Random Rotation)
app.get('/api/ads/serve', async (req, res) => {
    try {
        // Step 1: Find ALL eligible paying ads (Active + Has Views Left)
        // We use 'aggregate' and '$sample' to pick ONE random winner
        const randomAds = await Ad.aggregate([
            { 
                $match: { 
                    isActive: true, 
                    clientName: { $ne: "VITSN Innovations" }, 
                    $expr: { $lt: ["$currentViews", "$maxViews"] } 
                } 
            },
            { $sample: { size: 1 } } // <--- THE MAGIC: Picks 1 random ad
        ]);

        let ad = randomAds[0];

        // Step 2: Fallback to VITSN Default if no paying ads exist
        if (!ad) {
            ad = await Ad.findOne({ clientName: "VITSN Innovations" });
        }

        if (ad) {
            // Only count views for paying clients
            if (ad.clientName !== "VITSN Innovations") {
                // Since 'aggregate' returns a plain object, we must re-fetch to save
                await Ad.updateOne({ _id: ad._id }, { $inc: { currentViews: 1 } });
            }
            
            res.json({ 
                found: true, 
                clientName: ad.clientName, 
                imageUrl: ad.imageUrl 
            });
        } else { 
            // Absolute Safety Net
            res.json({ 
                found: true, 
                clientName: "VITSN Innovations",
                imageUrl: "https://dummyimage.com/600x80/f1f3f4/555555&text=Sponsored+by+VITSN+Innovations"
            }); 
        }
    } catch (error) { res.status(500).json({ error: 'Error serving ad' }); }
});

// --- 3. ADMIN DASHBOARD API (Protected with 'auth' Middleware) ---

// Stats
app.get('/api/admin/stats', auth, async (req, res) => {
    try {
        const totalEmails = await TrackedEmail.countDocuments();
        const openedEmails = await TrackedEmail.countDocuments({ opened: true });
        const totalUsers = await User.countDocuments();
        const totalAds = await Ad.countDocuments();
        const totalVouchers = await Voucher.countDocuments();
        res.json({ totalEmails, openedEmails, openRate: totalEmails ? ((openedEmails/totalEmails)*100).toFixed(1) : 0, totalUsers, totalAds, totalVouchers });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// Email Logs
app.get('/api/admin/emails', auth, async (req, res) => {
    try {
        const { search = '' } = req.query;
        let query = {};
        if (search) query = { subject: { $regex: search, $options: 'i' } };
        const emails = await TrackedEmail.find(query).sort({ createdAt: -1 }).limit(100);
        res.json({ emails });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// Ad Management
app.get('/api/admin/ads', auth, async (req, res) => { res.json(await Ad.find().sort({ createdAt: -1 })); });

app.post('/api/admin/ads', auth, async (req, res) => {
    try {
        const { clientName, imageUrl, adPlan } = req.body;
        let maxViews = 1000;
        if (adPlan === 'premium') maxViews = 10000;
        if (adPlan === 'ultra') maxViews = 100000;
        await new Ad({ clientName, imageUrl, adPlan, maxViews }).save();
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.patch('/api/admin/ads/:id/toggle', auth, async (req, res) => {
    const ad = await Ad.findById(req.params.id);
    if (ad) { ad.isActive = !ad.isActive; await ad.save(); res.json(ad); } else { res.status(404).json({ error: "Not found" }); }
});

app.delete('/api/admin/ads/:id', auth, async (req, res) => { await Ad.findByIdAndDelete(req.params.id); res.json({ success: true }); });

// User Management
app.get('/api/admin/users', auth, async (req, res) => { res.json(await User.find().sort({ createdAt: -1 })); });

app.post('/api/admin/users', auth, async (req, res) => {
    try {
        const { name, email, role, plan } = req.body;
        // Note: Manually added users get a default password 'user123' (change in production)
        const hashedPassword = await bcrypt.hash("user123", 10);
        await new User({ name, email, password: hashedPassword, role, plan }).save();
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: "User exists" }); }
});

// Voucher Management
app.get('/api/admin/vouchers', auth, async (req, res) => { res.json(await Voucher.find().sort({ createdAt: -1 })); });

app.post('/api/admin/vouchers', auth, async (req, res) => {
    try { await new Voucher(req.body).save(); res.json({ success: true }); }
    catch (err) { res.status(500).json({ error: "Code exists" }); }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));