const express = require('express');
const router = express.Router();
const multer = require('multer');
const { requireAuth } = require('../middleware/auth');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 }, // 20MB (아이폰 원본 사진 대응)
  fileFilter: (req, file, cb) => {
    if (!file.mimetype.startsWith('image/')) {
      return cb(new Error('이미지 파일만 업로드할 수 있습니다'));
    }
    cb(null, true);
  },
});

// POST /upload
router.post('/', requireAuth, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: '파일이 없습니다' });

  const ext = req.file.mimetype.includes('png') ? 'png' : req.file.mimetype.includes('gif') ? 'gif' : 'jpg';
  const fileName = `${req.user.id}_${Date.now()}.${ext}`;

  const { error } = await supabaseAdmin.storage
    .from('photos')
    .upload(fileName, req.file.buffer, {
      contentType: req.file.mimetype,
      upsert: false,
    });

  if (error) return res.status(500).json({ error: error.message });

  const { data } = supabaseAdmin.storage.from('photos').getPublicUrl(fileName);
  res.json({ url: data.publicUrl });
});

// multer 에러 처리
router.use((err, req, res, next) => {
  if (err.code === 'LIMIT_FILE_SIZE') {
    return res.status(400).json({ error: '20MB 이하 이미지만 업로드할 수 있습니다' });
  }
  res.status(400).json({ error: err.message });
});

module.exports = router;
