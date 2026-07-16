const express = require('express');
const router = express.Router();
const multer = require('multer');
const sharp = require('sharp');
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

  // 원본(아이폰 사진 수 MB~20MB)을 그대로 저장하면 피드 로딩이 수 초씩 걸린다 —
  // 긴 변 1600px·JPEG 82%로 리사이즈해 보통 100~400KB로 줄인다. (GIF는 애니메이션 보존 위해 원본 유지)
  let buffer = req.file.buffer;
  let contentType = req.file.mimetype;
  let ext = contentType.includes('png') ? 'png' : contentType.includes('gif') ? 'gif' : 'jpg';
  if (ext !== 'gif') {
    try {
      buffer = await sharp(req.file.buffer)
        .rotate() // EXIF 회전 반영 (리사이즈하면 EXIF가 사라지므로 픽셀에 구움)
        .resize(1600, 1600, { fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 82, mozjpeg: true })
        .toBuffer();
      contentType = 'image/jpeg';
      ext = 'jpg';
    } catch (e) {
      console.warn('[UPLOAD] 리사이즈 실패, 원본 저장:', e.message);
    }
  }
  const fileName = `${req.user.id}_${Date.now()}.${ext}`;

  const { error } = await supabaseAdmin.storage
    .from('photos')
    .upload(fileName, buffer, {
      contentType,
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
