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

// Config Helmet
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

app.use(express.static(path.join(__dirname, 'frontend')));

// Database Connection
mongoose.connect(process.env.MONGO_URI || 'mongodb://mongo:27017/promo_db')
  .then(() => console.log('✅ MongoDB Connected'))
  .catch(err => console.error('❌ MongoDB Error:', err));

// Redis Connection
const redisClient = redis.createClient({ 
  url: process.env.REDIS_URL || 'redis://redis:6379',
  socket: { reconnectStrategy: false }
});
redisClient.on('error', (err) => console.log('⚠️ Redis Error (Cache disabled)'));
redisClient.connect().catch(err => console.log('⚠️ Redis Connect Failed:', err.message));

// Upload Helper
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

// Middleware: Admin Check
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

// --- PROMOTIONS ---

// Get Active Promotions
app.get('/api/promotions', async (req, res) => {
  try {
    const today = new Date();
    today.setHours(0,0,0,0);
    const promotions = await Promotion.find({ status: 'APPROVED', end: { $gte: today } });
    res.json(promotions);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Submit Promotion
app.post('/api/promotions', upload.single('image'), async (req, res) => {
  try {
    let imageUrl = '';
    if (req.file) imageUrl = await uploadToImgBB(req.file.buffer);
    const newPromo = new Promotion({ ...req.body, imageUrl });
    await newPromo.save();
    res.status(201).json({ message: 'Submission Received' });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// --- ADMIN: PROMOTIONS ---

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

// Create Promotion
app.post('/api/admin/promotions', authenticateAdmin, upload.single('image'), async (req, res) => {
  try {
    let imageUrl = '';
    if (req.file) imageUrl = await uploadToImgBB(req.file.buffer);
    const newPromo = new Promotion({ ...req.body, imageUrl, color: req.body.color || '#4F46E5', status: 'APPROVED' });
    await newPromo.save();
    res.status(201).json({ message: 'Created successfully' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Edit Promotion (Fix: เพิ่ม Route นี้ให้ชัดเจน)
app.put('/api/admin/promotions/:id/edit', authenticateAdmin, upload.single('image'), async (req, res) => {
  try {
    const updateData = { ...req.body };
    if (req.file) updateData.imageUrl = await uploadToImgBB(req.file.buffer);
    await Promotion.findByIdAndUpdate(req.params.id, updateData);
    res.json({ message: 'Updated successfully' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Update Status
app.put('/api/admin/promotions/:id', authenticateAdmin, async (req, res) => {
  try {
    await Promotion.findByIdAndUpdate(req.params.id, { status: req.body.status });
    res.json({ message: `Status updated` });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/admin/promotions/:id', authenticateAdmin, async (req, res) => {
  try {
    await Promotion.findByIdAndDelete(req.params.id);
    res.json({ message: 'Deleted successfully' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// --- ANNOUNCEMENTS ---

// Get Active (สำหรับหน้าเว็บ)
app.get('/api/announcement', async (req, res) => {
  try {
    const today = new Date();
    const announcements = await Announcement.find({
      isActive: true,
      startDate: { $lte: today },
      endDate: { $gte: today.setHours(0,0,0,0) } 
    }).sort({ createdAt: -1 });
    res.json(announcements);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Get All (สำหรับ Admin)
app.get('/api/admin/announcements', authenticateAdmin, async (req, res) => {
  try {
    const announcements = await Announcement.find().sort({ createdAt: -1 });
    res.json(announcements);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Create Announcement
app.post('/api/admin/announcements', authenticateAdmin, upload.single('image'), async (req, res) => {
  try {
    let imageUrl = '';
    if (req.file) imageUrl = await uploadToImgBB(req.file.buffer);
    const newAnn = new Announcement({ ...req.body, imageUrl, isActive: true });
    await newAnn.save();
    res.json({ message: 'Announcement created' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Update Announcement (รวมถึงการ Toggle Active)
app.put('/api/admin/announcements/:id', authenticateAdmin, upload.single('image'), async (req, res) => {
  try {
    const updateData = { ...req.body };
    if (req.file) updateData.imageUrl = await uploadToImgBB(req.file.buffer);
    
    // แปลงค่า isActive ถ้าส่งมา (บางทีส่งมาเป็น string 'true'/'false')
    if(updateData.isActive !== undefined) {
        updateData.isActive = updateData.isActive === 'true' || updateData.isActive === true;
    }

    await Announcement.findByIdAndUpdate(req.params.id, updateData);
    res.json({ message: 'Updated successfully' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/admin/announcements/:id', authenticateAdmin, async (req, res) => {
  try {
    await Announcement.findByIdAndDelete(req.params.id);
    res.json({ message: 'Deleted successfully' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));