require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const redis = require('redis');
const cors = require('cors');
const helmet = require('helmet');
const jwt = require('jsonwebtoken');
const axios = require('axios'); 
const multer = require('multer');       // ✅ เพิ่ม: จัดการไฟล์อัปโหลด
const FormData = require('form-data');  // ✅ เพิ่ม: จัดรูปแบบข้อมูลส่ง ImgBB

const Promotion = require('./models/Promotion');

const app = express();
app.use(express.json());
app.use(cors());
app.use(helmet());

// --- Database Connection ---
mongoose.connect(process.env.MONGO_URI || 'mongodb://mongo:27017/promo_db')
  .then(() => console.log('✅ MongoDB Connected'))
  .catch(err => console.error('❌ MongoDB Error:', err));

// --- Redis Connection ---
const redisClient = redis.createClient({ url: 'redis://redis:6379' });
redisClient.connect().catch(console.error);

// --- Multer Setup (เก็บไฟล์ใน RAM ชั่วคราว) ---
const upload = multer({ storage: multer.memoryStorage() });

// --- Helper: Upload to ImgBB ---
const uploadToImgBB = async (buffer) => {
  try {
    const formData = new FormData();
    formData.append('image', buffer.toString('base64')); // แปลงรูปเป็น base64
    
    // ยิง Request ไป ImgBB
    const res = await axios.post(`https://api.imgbb.com/1/upload?key=${process.env.IMGBB_API_KEY}`, formData, {
      headers: formData.getHeaders()
    });
    
    return res.data.data.url; // คืนค่า URL รูปภาพ
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

// 1. Get Promotions (Public - Auto Hide Expired & Only Approved)
app.get('/api/promotions', async (req, res) => {
  try {
    const cacheKey = 'promotions:approved';
    const cachedData = await redisClient.get(cacheKey);
    if (cachedData) return res.json(JSON.parse(cachedData));

    const today = new Date();
    today.setHours(0,0,0,0);
    
    const promotions = await Promotion.find({
      status: 'APPROVED',
      end: { $gte: today }
    });

    await redisClient.setEx(cacheKey, 300, JSON.stringify(promotions));
    res.json(promotions);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 2. Submit Promotion (User - รองรับการอัปโหลดรูป)
// ✅ แก้ไข: ใช้ upload.single('image') และ Logic ส่ง ImgBB
app.post('/api/promotions', upload.single('image'), async (req, res) => {
  try {
    let imageUrl = '';
    
    // ถ้ามีการแนบไฟล์รูปมาด้วย
    if (req.file) {
      console.log('Uploading image to ImgBB...');
      imageUrl = await uploadToImgBB(req.file.buffer);
    }

    const newPromo = new Promotion({
      title: req.body.title,
      description: req.body.description,
      start: req.body.start,
      end: req.body.end,
      imageUrl: imageUrl // บันทึก URL
    });

    await newPromo.save();
    // TODO: Send FCM Notification to Admin
    res.status(201).json({ message: 'Submission Received (Pending Approval)' });
  } catch (err) {
    console.error(err);
    res.status(400).json({ error: err.message });
  }
});

// 3. Admin Login
app.post('/api/admin/login', (req, res) => {
  const { password } = req.body;
  if (password === process.env.ADMIN_PASSWORD) {
    const token = jwt.sign({ role: 'ADMIN' }, process.env.JWT_SECRET, { expiresIn: '1h' });
    return res.json({ token });
  }
  res.status(401).json({ error: 'Invalid Password' });
});

// 4. Admin: Get All (Included Pending/Expired)
app.get('/api/admin/promotions', authenticateAdmin, async (req, res) => {
  const promos = await Promotion.find().sort({ createdAt: -1 });
  res.json(promos);
});

// 5. Admin: Approve/Reject
app.put('/api/admin/promotions/:id', authenticateAdmin, async (req, res) => {
  try {
    const { status } = req.body;
    await Promotion.findByIdAndUpdate(req.params.id, { status });
    
    // Clear Cache
    await redisClient.del('promotions:approved');
    
    // TODO: If Approved -> Send FCM to Users
    
    res.json({ message: `Promotion ${status}` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 6. Admin Create Promotion (สร้างโดย Admin = อนุมัติเลย)
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
      status: 'APPROVED' // Admin สร้างเองให้อนุมัติเลย
    });

    await newPromo.save();
    await redisClient.del('promotions:approved'); // เคลียร์ Cache
    res.status(201).json({ message: 'Created successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 7. Admin Edit Promotion (แก้ไขข้อมูล + เปลี่ยนรูป)
app.put('/api/admin/promotions/:id/edit', authenticateAdmin, upload.single('image'), async (req, res) => {
  try {
    const updateData = {
      title: req.body.title,
      description: req.body.description,
      start: req.body.start,
      end: req.body.end,
    };

    // ถ้ามีการอัปโหลดรูปใหม่ ให้ส่งไป ImgBB แล้วอัปเดต URL
    if (req.file) {
      console.log('Updating image...');
      updateData.imageUrl = await uploadToImgBB(req.file.buffer);
    }

    await Promotion.findByIdAndUpdate(req.params.id, updateData);
    await redisClient.del('promotions:approved'); // เคลียร์ Cache

    res.json({ message: 'Updated successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));