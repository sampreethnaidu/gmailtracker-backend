/* server.js - Version 21.0: Enterprise Edition (Sigma Logic + Session Lock) */
require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const bcrypt = require('bcryptjs'); 
const jwt = require('jsonwebtoken'); 
const cookieParser = require('cookie-parser'); 

const app = express();
const JWT_SECRET = process.env.JWT_SECRET || "vitsn-super-secret-key-2026"; 

// CORS: Allow credentials (cookies) for Sender Protection
app.use(cors({ origin: true, credentials: true, methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'] }));
app.use(express.json());
app.use(cookieParser()); 

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
const userSchema = new mongoose.Schema({
    name: String,
    email: { type: String, unique: true, required: true },
    password: { type: String, select: false },
    role: { type: String, enum: ['user', 'ad_client', 'admin'], default: 'user' },
    plan: { type: String, enum: ['free', 'premium', 'ad_basic', 'ad_premium', 'ad_ultra'], default: 'free' },
    createdAt: { type: Date, default: Date.now }
});
const User = mongoose.model('User', userSchema);

const emailSchema = new mongoose.Schema({
    trackingId: { type: String, unique: true },
    parentId: { type: String, default: null }, // NEW: Links Reply to Original
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
    lastOpenedAt: { type: Date, default: null }, // NEW: For 5-min Session Lock
    createdAt: { type: Date, default: Date.now }
});
const TrackedEmail = mongoose.model('TrackedEmail', emailSchema);

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

const voucherSchema = new mongoose.Schema({
    code: { type: String, unique: true, required: true },
    planType: { type: String, required: true },
    isRedeemed: { type: Boolean, default: false },
    redeemedBy: String,
    createdAt: { type: Date, default: Date.now }
});
const Voucher = mongoose.model('Voucher', voucherSchema);

// ==========================================
// --- INITIALIZER ---
// ==========================================
const initializeSystem = async () => {
    try {
        const adminExists = await User.findOne({ role: 'admin' });
        if (!adminExists) {
            const hashedPassword = await bcrypt.hash("admin123", 10);
            await new User({
                name: "Super Admin",
                email: "admin@vitsn.com",
                password: hashedPassword,
                role: "admin",
                plan: "premium"
            }).save();
            console.log(">> SYSTEM: Default Admin Created");
        }
        
        const adCount = await Ad.countDocuments({ clientName: "VITSN Innovations" });
        if (adCount === 0) {
            await new Ad({
                clientName: "VITSN Innovations",
                imageUrl: "https://dummyimage.com/600x80/f1f3f4/555555&text=Sponsored+by+VITSN+Innovations",
                adPlan: 'ultra',
                maxViews: 999999999,
                isActive: true
            }).save();
            console.log(">> SYSTEM: Default Fallback Ad Initialized");
        }
    } catch (err) { console.error("Init Error:", err); }
};

// ==========================================
// --- MIDDLEWARE ---
// ==========================================
const auth = (req, res, next) => {
    const token = req.header('Authorization');
    if (!token) return res.status(401).json({ error: "Access Denied." });
    try {
        const cleanToken = token.replace('Bearer ', '');
        const verified = jwt.verify(cleanToken, JWT_SECRET);
        req.user = verified;
        next();
    } catch (err) { res.status(400).json({ error: "Invalid Token" }); }
};

// ==========================================
// --- ROUTES ---
// ==========================================

app.post('/api/auth/login', async (req, res) => {
    try {
        const { email, password } = req.body;
        const user = await User.findOne({ email }).select('+password');
        if (!user) return res.status(400).json({ error: "User not found" });
        const validPass = await bcrypt.compare(password, user.password);
        if (!validPass) return res.status(400).json({ error: "Invalid password" });
        if (user.role !== 'admin') return res.status(403).json({ error: "Access restricted" });
        const token = jwt.sign({ _id: user._id, role: user.role }, JWT_SECRET, { expiresIn: '12h' });
        res.json({ token, user: { name: user.name, email: user.email, role: user.role } });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// --- TRACKING API (UPDATED) ---

// 1. Generate ID (Now supports parentId for Thread Linking)
app.post('/api/track/generate', async (req, res) => {
    try {
        const { sender, recipients, subject, trackingId, parentId } = req.body;
        const finalId = trackingId || uuidv4();
        await new TrackedEmail({ 
            trackingId: finalId, 
            parentId: parentId || null, // Capture Parent ID
            senderEmail: sender, 
            recipientEmails: recipients, 
            subject 
        }).save();
        
        const baseUrl = process.env.BASE_URL || "https://gmailtracker-backend.onrender.com"; 
        res.json({ trackingId: finalId, pixelUrl: `${baseUrl}/api/track-image/${finalId}` });
    } catch (error) { res.status(500).json({ error: 'Error generating ID' }); }
});

// 2. Serve Pixel (With 5-Min Session Lock)
app.get('/api/track-image/:id', async (req, res) => {
    try {
        const trackingId = req.params.id;
        const userAgent = req.headers['user-agent'] || '';
        const ip = req.ip;
        
        const isBot = /bot|crawler|spider|facebookexternalhit/i.test(userAgent);
        const isSender = req.cookies['vitsn_sender'] === 'true';

        console.log(`[PIXEL HIT] ID: ${trackingId} | Bot: ${isBot} | Sender: ${isSender}`);

        if (!isBot && !isSender) {
            const email = await TrackedEmail.findOne({ trackingId: trackingId });
            
            if (email) {
                const now = new Date();
                let shouldCount = true;

                // --- 5-MINUTE SESSION LOCK ---
                if (email.openHistory && email.openHistory.length > 0) {
                    const lastOpen = email.openHistory[email.openHistory.length - 1];
                    const timeDiff = (now - new Date(lastOpen.timestamp)) / 1000 / 60; // Minutes
                    
                    // If same IP and less than 5 mins, ignore
                    if (lastOpen.ip === ip && timeDiff < 5) {
                        shouldCount = false;
                        console.log(`🔒 Session Locked (Last read ${timeDiff.toFixed(1)} mins ago)`);
                    }
                }

                if (shouldCount) {
                    email.opened = true;
                    email.openCount += 1;
                    email.openHistory.push({ timestamp: now, ip: ip, userAgent: userAgent });
                    email.lastOpenedAt = now;
                    await email.save();
                    console.log(`✅ Read Counted! Total: ${email.openCount}`);
                }
            }
        } 

        const img = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
        res.writeHead(200, { 
            'Content-Type': 'image/gif', 
            'Content-Length': img.length, 
            'Cache-Control': 'no-cache, no-store, must-revalidate, max-age=0' 
        });
        res.end(img);
    } catch (error) { res.status(500).send('Error'); }
});

// --- HELPER: Clean Subject & Compare Recipients ---
function getCleanSubjectRegex(subject) {
    if (!subject) return null;
    const clean = subject.replace(/^(Re|Fwd|FW|re|fwd|Aw):\s*/i, "").trim();
    return new RegExp(`^((Re|Fwd|FW|re|fwd|Aw):\\s*)*${clean}$`, 'i');
}

function areRecipientsSame(listA, listB) {
    if (!listA || !listB) return false;
    const setA = new Set(listA.map(e => e.toLowerCase().trim()));
    const setB = new Set(listB.map(e => e.toLowerCase().trim()));
    for (let email of setA) { if (setB.has(email)) return true; }
    return false;
}

// 3. Check Status (Sigma Thread Summation)
app.get('/api/check-status', async (req, res) => {
    try {
        const { subject, trackingId } = req.query;
        let responseData = { found: false };
        let emails = [];

        // STRATEGY A: ID-Based Parent-Child Linking (The Best Way)
        if (trackingId) {
            const target = await TrackedEmail.findOne({ trackingId });
            if (target) {
                // If I am a child, find my siblings and parent.
                // If I am a parent, find my children.
                const rootId = target.parentId || target.trackingId;
                
                // Find ALL emails in this family (Root or Child of Root)
                // Note: Simplified 1-level depth (Parent -> Children). 
                // Advanced trees would need recursive search, but 1-level covers 99% of emails.
                emails = await TrackedEmail.find({ 
                    $or: [
                        { trackingId: rootId }, // Is the Root
                        { parentId: rootId }    // Is a Child of Root
                    ]
                }).sort({ createdAt: 1 }); // Sort Oldest first
            }
        }

        // STRATEGY B: Subject Clustering Fallback (If no ID match found)
        if (emails.length === 0 && subject) {
            const subjectRegex = getCleanSubjectRegex(subject);
            const rawEmails = await TrackedEmail.find({ subject: { $regex: subjectRegex } }).sort({ createdAt: -1 });
            
            // Smart Filter: Use recipient list of the query target or most recent
            if (rawEmails.length > 0) {
                 // Note: Ideally we filter by recipient here too, but for speed in fallback we take the cluster
                 emails = rawEmails.reverse(); // Make Oldest First for list
            }
        }

        if (emails.length > 0) {
            // GENERATE BREAKDOWN
            const threadBreakdown = emails.map((email, index) => ({
                index: index + 1,
                date: email.createdAt,
                openCount: email.openCount,
                isReply: !!email.parentId || index > 0, 
                lastRead: email.openHistory.length > 0 ? email.openHistory[email.openHistory.length-1].timestamp : null
            }));

            // SIGMA TOTAL (Sum of Thread)
            const totalOpens = emails.reduce((acc, email) => acc + email.openCount, 0);
            
            // LATEST STATUS (For Grey/Green Ticks)
            // We use the LAST email in the sorted list (Newest)
            const latest = emails[emails.length - 1];

            responseData = {
                found: true,
                opened: latest.opened,       // Status of Newest
                openCount: latest.openCount, // Count of Newest
                totalThreadOpens: totalOpens, // NEW: Sum of Thread
                threadBreakdown: threadBreakdown
            };
        }

        res.json(responseData);

    } catch (error) {
        console.error("Check Status Error:", error);
        res.status(500).json({ error: "Server error" });
    }
});

app.get('/api/ads/serve', async (req, res) => {
    try {
        const randomAds = await Ad.aggregate([
            { $match: { isActive: true, clientName: { $ne: "VITSN Innovations" }, $expr: { $lt: ["$currentViews", "$maxViews"] } } },
            { $sample: { size: 1 } }
        ]);
        let ad = randomAds[0] || await Ad.findOne({ clientName: "VITSN Innovations" });

        if (ad) {
            if (ad.clientName !== "VITSN Innovations") {
                await Ad.updateOne({ _id: ad._id }, { $inc: { currentViews: 1 } });
            }
            res.json({ found: true, clientName: ad.clientName, imageUrl: ad.imageUrl });
        } else {
            res.json({ found: true, clientName: "VITSN", imageUrl: "https://dummyimage.com/600x80/ccc/000&text=Ads" });
        }
    } catch (error) { res.status(500).json({ error: 'Error serving ad' }); }
});

// --- ADMIN API ---
app.get('/api/admin/stats', auth, async (req, res) => {
    try {
        const totalEmails = await TrackedEmail.countDocuments();
        const openedEmails = await TrackedEmail.countDocuments({ opened: true });
        const totalUsers = await User.countDocuments();
        res.json({ totalEmails, openedEmails, openRate: totalEmails ? ((openedEmails/totalEmails)*100).toFixed(1) : 0, totalUsers });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/admin/emails', auth, async (req, res) => {
    try {
        const { search = '' } = req.query;
        let query = search ? { subject: { $regex: search, $options: 'i' } } : {};
        const emails = await TrackedEmail.find(query).sort({ createdAt: -1 }).limit(100);
        res.json({ emails });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/admin/ads', auth, async (req, res) => { res.json(await Ad.find().sort({ createdAt: -1 })); });
app.post('/api/admin/ads', auth, async (req, res) => {
    try {
        const { clientName, imageUrl, adPlan } = req.body;
        let maxViews = adPlan === 'premium' ? 10000 : (adPlan === 'ultra' ? 100000 : 1000);
        await new Ad({ clientName, imageUrl, adPlan, maxViews }).save();
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});
app.patch('/api/admin/ads/:id/toggle', auth, async (req, res) => {
    const ad = await Ad.findById(req.params.id);
    if (ad) { ad.isActive = !ad.isActive; await ad.save(); res.json(ad); } else { res.status(404).json({ error: "Not found" }); }
});
app.delete('/api/admin/ads/:id', auth, async (req, res) => { await Ad.findByIdAndDelete(req.params.id); res.json({ success: true }); });

app.get('/api/admin/users', auth, async (req, res) => { res.json(await User.find().sort({ createdAt: -1 })); });
app.post('/api/admin/users', auth, async (req, res) => {
    try {
        const { name, email, role, plan } = req.body;
        const hashedPassword = await bcrypt.hash("user123", 10);
        await new User({ name, email, password: hashedPassword, role, plan }).save();
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: "User exists" }); }
});

app.get('/api/admin/vouchers', auth, async (req, res) => { res.json(await Voucher.find().sort({ createdAt: -1 })); });
app.post('/api/admin/vouchers', auth, async (req, res) => {
    try { await new Voucher(req.body).save(); res.json({ success: true }); }
    catch (err) { res.status(500).json({ error: "Code exists" }); }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));