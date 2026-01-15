const mongoose = require('mongoose');

const PromotionSchema = new mongoose.Schema({
  title: { type: String, required: true },
  description: String,
  start: { type: Date, required: true },
  end: { type: Date, required: true },
  color: String,
  imageUrls: [String], // ✅ เปลี่ยนจาก imageUrl เป็น imageUrls (Array)
  status: { type: String, enum: ['PENDING', 'APPROVED', 'REJECTED'], default: 'PENDING' },
  createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('Promotion', PromotionSchema);