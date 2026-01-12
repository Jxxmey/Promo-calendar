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

const Promotion = require('./models/Promotion');

const app = express();
app.use(express.json());
app.use(cors());

// ✅ แก้ไข Helmet (ปลดล็อคทุกอย่างที่ติด Error)
app.use(helmet({
  crossOriginResourcePolicy: false, // อนุญาตให้โหลด Resource ข้าม Domain ได้ (แก้ปัญหาโหลดรูปไม่ได้)
  crossOriginEmbedderPolicy: false, // ปิด COEP เพื่อให้โหลดรูปจาก i.ibb.co ได้โดยไม่ติด Block
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "cdn.jsdelivr.net"], 
      scriptSrcAttr: ["'unsafe-inline'"], // ✅ อนุญาตให้ใช้ onclick="..." ใน HTML ได้
      styleSrc: ["'self'", "'unsafe-inline'", "cdn.jsdelivr.net", "fonts.googleapis.com"], 
      imgSrc: ["'self'", "data:", "i.ibb.co", "https://i.ibb.co"], // ✅ ระบุ i.ibb.co ให้ชัดเจน
      fontSrc: ["'self'", "data:", "fonts.gstatic.com", "cdn.jsdelivr.net"], // ✅ อนุญาต font แบบ data:
      connectSrc: ["'self'", "cdn.jsdelivr.net"], 
    },
  },
}));

// เปิดให้เข้าถึงหน้าเว็บ (Frontend)
app.use(express.static(path.join(__dirname, 'frontend')));

// --- Database Connection ---
mongoose.connect(process.env.MONGO_URI || 'mongodb://mongo:27017/promo_db')
  .then(() => console.log('✅ MongoDB Connected'))
  .catch(err => console.error('❌ MongoDB Error:', err));

// --- Redis Connection ---
const redisClient = redis.createClient({ 
  url: process.env.REDIS_URL || 'redis://redis:6379',
  socket: { reconnectStrategy: false }
});
redisClient.on('error', (err) => console.log('⚠️ Redis Error (Cache disabled)'));
redisClient.connect().catch(err => console.log('⚠️ Redis Connect Failed:', err.message));

// --- Multer Setup ---
const upload = multer({ storage: multer.memoryStorage() });

// --- Helper: Upload to ImgBB ---
const uploadToImgBB = async (buffer) => {
  try {
    const formData = new FormData();
    formData.append('image', buffer.toString('base64')); 
    
    const res = await axios.post(`https://api.imgbb.com/1/upload?key=${process.env.IMGBB_API_KEY}`, formData, {
      headers: formData.getHeaders()
    });
    return res.data.data.url;
  } catch (error) {
    console.error('ImgBB Upload Error:', error.response?.data || error.message);
    throw new Error('Image upload failed');
  }
};

// --- Middleware ---
const authenticateAdmin = (req, res, next) => {
  const token = req.headers['authorization']?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  
  jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ error: 'Forbidden' });
    req.user = user;
    next();
  });
};

// --- API Routes ---

app.get('/api/promotions', async (req, res) => {
  try {
    const cacheKey = 'promotions:approved';
    if (redisClient.isOpen) {
       const cachedData = await redisClient.get(cacheKey);
       if (cachedData) return res.json(JSON.parse(cachedData));
    }

    const today = new Date();
    today.setHours(0,0,0,0);
    
    const promotions = await Promotion.find({
      status: 'APPROVED',
      end: { $gte: today }
    });

    if (redisClient.isOpen) {
      await redisClient.setEx(cacheKey, 300, JSON.stringify(promotions));
    }
    
    res.json(promotions);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/promotions', upload.single('image'), async (req, res) => {
  try {
    let imageUrl = '';
    if (req.file) {
      imageUrl = await uploadToImgBB(req.file.buffer);
    }

    const newPromo = new Promotion({
      title: req.body.title,
      description: req.body.description,
      start: req.body.start,
      end: req.body.end,
      imageUrl: imageUrl
    });

    await newPromo.save();
    res.status(201).json({ message: 'Submission Received (Pending Approval)' });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/admin/login', (req, res) => {
  const { password } = req.body;
  if (password === process.env.ADMIN_PASSWORD) {
    const token = jwt.sign({ role: 'ADMIN' }, process.env.JWT_SECRET, { expiresIn: '1h' });
    return res.json({ token });
  }
  res.status(401).json({ error: 'Invalid Password' });
});

app.get('/api/admin/promotions', authenticateAdmin, async (req, res) => {
  const promos = await Promotion.find().sort({ createdAt: -1 });
  res.json(promos);
});

app.put('/api/admin/promotions/:id', authenticateAdmin, async (req, res) => {
  try {
    const { status } = req.body;
    await Promotion.findByIdAndUpdate(req.params.id, { status });
    
    if (redisClient.isOpen) await redisClient.del('promotions:approved');
    
    res.json({ message: `Promotion ${status}` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/promotions', authenticateAdmin, upload.single('image'), async (req, res) => {
  try {
    let imageUrl = '';
    if (req.file) {
      imageUrl = await uploadToImgBB(req.file.buffer);
    }

    const newPromo = new Promotion({
      title: req.body.title,
      description: req.body.description,
      start: req.body.start,
      end: req.body.end,
      imageUrl: imageUrl,
      color: req.body.color || '#4F46E5',
      status: 'APPROVED'
    });

    await newPromo.save();
    if (redisClient.isOpen) await redisClient.del('promotions:approved');
    res.status(201).json({ message: 'Created successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

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
    if (redisClient.isOpen) await redisClient.del('promotions:approved');

    res.json({ message: 'Updated successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));