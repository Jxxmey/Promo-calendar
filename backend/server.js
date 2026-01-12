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
const Announcement = require('./models/Announcement'); // ✅ Model ประกาศ

const app = express();
app.use(express.json());
app.use(cors());

// ✅ ปลดล็อค Helmet ให้โหลดรูปและ Script ได้ครบถ้วน
app.use(helmet({
  crossOriginResourcePolicy: false,
  crossOriginEmbedderPolicy: false,
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "cdn.jsdelivr.net"], 
      scriptSrcAttr: ["'unsafe-inline'"], 
      styleSrc: ["'self'", "'unsafe-inline'", "cdn.jsdelivr.net", "fonts.googleapis.com"], 
      imgSrc: ["'self'", "data:", "i.ibb.co", "https://i.ibb.co", "blob:"], // ✅ เพิ่ม blob:
      fontSrc: ["'self'", "data:", "fonts.gstatic.com", "cdn.jsdelivr.net"],
      connectSrc: ["'self'", "cdn.jsdelivr.net"], 
    },
  },
}));

app.use(express.static(path.join(__dirname, 'frontend')));

// --- DB Connect ---
mongoose.connect(process.env.MONGO_URI || 'mongodb://mongo:27017/promo_db')
  .then(() => console.log('✅ MongoDB Connected'))
  .catch(err => console.error('❌ MongoDB Error:', err));

// --- Redis ---
const redisClient = redis.createClient({ 
  url: process.env.REDIS_URL || 'redis://redis:6379',
  socket: { reconnectStrategy: false }
});
redisClient.on('error', (err) => console.log('⚠️ Redis Error (Cache disabled)'));
redisClient.connect().catch(err => console.log('⚠️ Redis Connect Failed:', err.message));

// --- Upload Helper ---
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
    console.error('ImgBB Error:', error.message);
    throw new Error('Image upload failed');
  }
};

const authenticateAdmin = (req, res, next) => {
  const token = req.headers['authorization']?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ error: 'Forbidden' });
    req.user = user;
    next();
  });
};

// --- ROUTES ---

// Promotion APIs
app.get('/api/promotions', async (req, res) => {
  try {
    const cacheKey = 'promotions:approved';
    if (redisClient.isOpen) {
       const cachedData = await redisClient.get(cacheKey);
       if (cachedData) return res.json(JSON.parse(cachedData));
    }
    const today = new Date(); today.setHours(0,0,0,0);
    const promotions = await Promotion.find({ status: 'APPROVED', end: { $gte: today } });
    if (redisClient.isOpen) await redisClient.setEx(cacheKey, 300, JSON.stringify(promotions));
    res.json(promotions);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/promotions', upload.single('image'), async (req, res) => {
  try {
    let imageUrl = '';
    if (req.file) imageUrl = await uploadToImgBB(req.file.buffer);
    const newPromo = new Promotion({ ...req.body, imageUrl });
    await newPromo.save();
    res.status(201).json({ message: 'Submission Received' });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// Admin APIs
app.post('/api/admin/login', (req, res) => {
  if (req.body.password === process.env.ADMIN_PASSWORD) {
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
  await Promotion.findByIdAndUpdate(req.params.id, { status: req.body.status });
  if (redisClient.isOpen) await redisClient.del('promotions:approved');
  res.json({ message: `Status updated` });
});

app.post('/api/admin/promotions', authenticateAdmin, upload.single('image'), async (req, res) => {
  try {
    let imageUrl = '';
    if (req.file) imageUrl = await uploadToImgBB(req.file.buffer);
    const newPromo = new Promotion({ ...req.body, imageUrl, color: req.body.color || '#4F46E5', status: 'APPROVED' });
    await newPromo.save();
    if (redisClient.isOpen) await redisClient.del('promotions:approved');
    res.status(201).json({ message: 'Created successfully' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/admin/promotions/:id/edit', authenticateAdmin, upload.single('image'), async (req, res) => {
  try {
    const updateData = { ...req.body };
    if (req.file) updateData.imageUrl = await uploadToImgBB(req.file.buffer);
    await Promotion.findByIdAndUpdate(req.params.id, updateData);
    if (redisClient.isOpen) await redisClient.del('promotions:approved');
    res.json({ message: 'Updated successfully' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ✅ Announcement Routes (New)
app.get('/api/announcement', async (req, res) => {
  try {
    const announcement = await Announcement.findOne().sort({ updatedAt: -1 });
    res.json(announcement || { isActive: false });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// อัปเดตประกาศแบบมีรูป
app.post('/api/admin/announcement', authenticateAdmin, upload.single('image'), async (req, res) => {
  try {
    const { title, description, isActive } = req.body;
    const updateData = {
      title,
      description,
      isActive: isActive === 'true', // แปลง string 'true' เป็น boolean
      updatedAt: new Date()
    };

    if (req.file) {
      updateData.imageUrl = await uploadToImgBB(req.file.buffer);
    }

    await Announcement.findOneAndUpdate({}, updateData, { upsert: true, new: true });
    res.json({ message: 'Announcement updated' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));