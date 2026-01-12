const mongoose = require('mongoose');

const AnnouncementSchema = new mongoose.Schema({
  title: { type: String, required: true },
  description: String,
  imageUrl: String,
  startDate: { type: Date, required: true }, // วันเริ่มแสดง
  endDate: { type: Date, required: true },   // วันจบ (กำหนดว่าโชว์กี่วัน)
  isActive: { type: Boolean, default: true },
  createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('Announcement', AnnouncementSchema);