const path = require('path');
require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const redis = require('redis');
const cors = require('cors');
const helmet = require('helmet');
const jwt = require('jsonwebtoken');
const axios = require('axios'); 
const multer = require('multer');       
const FormData = require('form-data');  

// Import Models
const Promotion = require('./models/Promotion');
const Announcement = require('./models/Announcement');

const app = express();
app.use(express.json());
app.use(cors());

// ✅ Config Helmet: ปลดล็อค CSP ให้โหลดรูป, สคริปต์ และแสดงผลได้ถูกต้อง
app.use(helmet({
  crossOriginResourcePolicy: false,
  crossOriginEmbedderPolicy: false,
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "cdn.jsdelivr.net"], 
      scriptSrcAttr: ["'unsafe-inline'"], 
      styleSrc: ["'self'", "'unsafe-inline'", "cdn.jsdelivr.net", "fonts.googleapis.com"], 
      imgSrc: ["'self'", "data:", "i.ibb.co", "https://i.ibb.co", "blob:"],
      fontSrc: ["'self'", "data:", "fonts.gstatic.com", "cdn.jsdelivr.net"],
      connectSrc: ["'self'", "cdn.jsdelivr.net"], 
    },
  },
}));

// Serve Frontend Files
app.use(express.static(path.join(__dirname, 'frontend')));

// --- Database Connection ---
mongoose.connect(process.env.MONGO_URI || 'mongodb://mongo:27017/promo_db')
  .then(() => console.log('✅ MongoDB Connected'))
  .catch(err => console.error('❌ MongoDB Error:', err));

// --- Redis Connection (Cache) ---
const redisClient = redis.createClient({ 
  url: process.env.REDIS_URL || 'redis://redis:6379',
  socket: { reconnectStrategy: false }
});
redisClient.on('error', (err) => console.log('⚠️ Redis Error (Cache disabled)'));
redisClient.connect().catch(err => console.log('⚠️ Redis Connect Failed:', err.message));

// --- Helper: Upload Image to ImgBB ---
const upload = multer({ storage: multer.memoryStorage() });

const uploadToImgBB = async (buffer) => {
  try {
    const formData = new FormData();
    formData.append('image', buffer.toString('base64')); 
    const res = await axios.post(`https://api.imgbb.com/1/upload?key=${process.env.IMGBB_API_KEY}`, formData, {
      headers: formData.getHeaders()
    });
    return res.data.data.url;
  } catch (error) {
    console.error('ImgBB Error:', error.response?.data || error.message);
    throw new Error('Image upload failed');
  }
};

// --- Middleware: Admin Check ---
const authenticateAdmin = (req, res, next) => {
  const token = req.headers['authorization']?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  
  jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ error: 'Forbidden' });
    req.user = user;
    next();
  });
};

// ================= API ROUTES =================

// ---------------- PROMOTIONS ----------------

// 1. Get Active Promotions (Public)
app.get('/api/promotions', async (req, res) => {
  try {
    const cacheKey = 'promotions:active';
    
    // Try Cache
    if (redisClient.isOpen) {
       const cachedData = await redisClient.get(cacheKey);
       if (cachedData) return res.json(JSON.parse(cachedData));
    }

    const today = new Date();
    today.setHours(0,0,0,0);
    
    // ดึงโปรโมชั่นที่ อนุมัติแล้ว และ ยังไม่หมดอายุ
    const promotions = await Promotion.find({
      status: 'APPROVED',
      end: { $gte: today }
    });

    // Save Cache (5 mins)
    if (redisClient.isOpen) {
      await redisClient.setEx(cacheKey, 300, JSON.stringify(promotions));
    }
    
    res.json(promotions);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 2. Submit Promotion (User)
app.post('/api/promotions', upload.single('image'), async (req, res) => {
  try {
    let imageUrl = '';
    if (req.file) imageUrl = await uploadToImgBB(req.file.buffer);

    const newPromo = new Promotion({
      title: req.body.title,
      description: req.body.description,
      start: req.body.start,
      end: req.body.end,
      imageUrl
    });

    await newPromo.save();
    res.status(201).json({ message: 'Submission Received' });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ---------------- ADMIN: PROMOTIONS ----------------

// 3. Admin Login
app.post('/api/admin/login', (req, res) => {
  const { password } = req.body;
  if (password === process.env.ADMIN_PASSWORD) {
    const token = jwt.sign({ role: 'ADMIN' }, process.env.JWT_SECRET, { expiresIn: '1h' });
    return res.json({ token });
  }
  res.status(401).json({ error: 'Invalid Password' });
});

// 4. Get All Promotions (Admin)
app.get('/api/admin/promotions', authenticateAdmin, async (req, res) => {
  const promos = await Promotion.find().sort({ createdAt: -1 });
  res.json(promos);
});

// 5. Create Promotion (Admin - Auto Approved)
app.post('/api/admin/promotions', authenticateAdmin, upload.single('image'), async (req, res) => {
  try {
    let imageUrl = '';
    if (req.file) imageUrl = await uploadToImgBB(req.file.buffer);

    const newPromo = new Promotion({
      title: req.body.title,
      description: req.body.description,
      start: req.body.start,
      end: req.body.end,
      imageUrl: imageUrl,
      color: req.body.color || '#4F46E5', // รองรับสีที่ส่งมา
      status: 'APPROVED'
    });

    await newPromo.save();
    if (redisClient.isOpen) await redisClient.del('promotions:active'); // Clear Cache
    res.status(201).json({ message: 'Created successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 6. Update Status (Approve/Reject)
app.put('/api/admin/promotions/:id', authenticateAdmin, async (req, res) => {
  try {
    const { status } = req.body;
    await Promotion.findByIdAndUpdate(req.params.id, { status });
    
    if (redisClient.isOpen) await redisClient.del('promotions:active');
    res.json({ message: `Status updated` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 7. Edit Promotion Details
app.put('/api/admin/promotions/:id/edit', authenticateAdmin, upload.single('image'), async (req, res) => {
  try {
    const updateData = {
      title: req.body.title,
      description: req.body.description,
      start: req.body.start,
      end: req.body.end,
      color: req.body.color
    };

    if (req.file) {
      updateData.imageUrl = await uploadToImgBB(req.file.buffer);
    }

    await Promotion.findByIdAndUpdate(req.params.id, updateData);
    if (redisClient.isOpen) await redisClient.del('promotions:active');

    res.json({ message: 'Updated successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 8. Delete Promotion
app.delete('/api/admin/promotions/:id', authenticateAdmin, async (req, res) => {
  try {
    await Promotion.findByIdAndDelete(req.params.id);
    if (redisClient.isOpen) await redisClient.del('promotions:active');
    res.json({ message: 'Deleted successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------- ANNOUNCEMENTS (NEW SYSTEM) ----------------

// 9. Get Active Announcements (Public)
app.get('/api/announcement', async (req, res) => {
  try {
    const today = new Date();
    // today.setHours(0,0,0,0); // ใช้เวลาปัจจุบันเลยเพื่อความแม่นยำ

    // ดึงประกาศที่: 
    // 1. isActive = true
    // 2. วันที่เริ่ม <= วันนี้ (เริ่มแล้ว)
    // 3. วันที่จบ >= วันนี้ (ยังไม่จบ)
    const announcements = await Announcement.find({
      isActive: true,
      startDate: { $lte: today },
      endDate: { $gte: today.setHours(0,0,0,0) } 
    }).sort({ createdAt: -1 });

    res.json(announcements);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 10. Get All Announcements (Admin)
app.get('/api/admin/announcements', authenticateAdmin, async (req, res) => {
  try {
    const announcements = await Announcement.find().sort({ createdAt: -1 });
    res.json(announcements);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 11. Create Announcement (Admin)
app.post('/api/admin/announcements', authenticateAdmin, upload.single('image'), async (req, res) => {
  try {
    let imageUrl = '';
    if (req.file) {
      imageUrl = await uploadToImgBB(req.file.buffer);
    }

    const newAnn = new Announcement({
      title: req.body.title,
      description: req.body.description,
      startDate: req.body.startDate,
      endDate: req.body.endDate,
      imageUrl,
      isActive: true
    });

    await newAnn.save();
    res.json({ message: 'Announcement created successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 12. Delete Announcement (Admin)
app.delete('/api/admin/announcements/:id', authenticateAdmin, async (req, res) => {
  try {
    await Announcement.findByIdAndDelete(req.params.id);
    res.json({ message: 'Deleted successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Start Server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));