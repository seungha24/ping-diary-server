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

// GET /upload/thumb?f=<파일명>&w=<너비> — 커버·썸네일용 축소 이미지
// 첫 요청 때 축소본을 만들어 storage(thumbs/)에 저장하고, 이후엔 그 공개 URL로 리다이렉트.
// 원본(1600px, 수백 KB)을 146px 카드에 그대로 내리던 것을 ~20KB로 줄여 첫 로딩을 빠르게.
const THUMB_WIDTHS = new Set([160, 480, 960]);
router.get('/thumb', async (req, res) => {
  const f = String(req.query.f || '');
  // photos 버킷의 파일명만 허용 (경로 조작·SSRF 방지)
  if (!/^[\w.-]+$/.test(f)) return res.status(400).json({ error: '유효한 파일명이 필요합니다' });
  const w = THUMB_WIDTHS.has(parseInt(req.query.w, 10)) ? parseInt(req.query.w, 10) : 480;
  // GIF는 애니메이션 보존을 위해 원본으로 보낸다
  if (/\.gif$/i.test(f)) {
    return res.redirect(301, supabaseAdmin.storage.from('photos').getPublicUrl(f).data.publicUrl);
  }

  const thumbPath = `thumbs/w${w}_${f.replace(/\.\w+$/, '')}.jpg`;
  const thumbUrl = supabaseAdmin.storage.from('photos').getPublicUrl(thumbPath).data.publicUrl;

  // 이미 만들어진 축소본이 있으면 바로 리다이렉트
  try {
    const head = await fetch(thumbUrl, { method: 'HEAD' });
    if (head.ok) {
      res.set('Cache-Control', 'public, max-age=31536000, immutable');
      return res.redirect(301, thumbUrl);
    }
  } catch (_) {}

  // 없으면 원본을 받아 축소 → 저장 → 리다이렉트
  try {
    const { data: orig, error: dlErr } = await supabaseAdmin.storage.from('photos').download(f);
    if (dlErr || !orig) return res.status(404).json({ error: '원본 이미지를 찾을 수 없습니다' });
    const buf = Buffer.from(await orig.arrayBuffer());
    const thumb = await sharp(buf)
      .rotate()
      .resize(w, w * 2, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 78, mozjpeg: true })
      .toBuffer();
    await supabaseAdmin.storage.from('photos')
      .upload(thumbPath, thumb, { contentType: 'image/jpeg', upsert: true });
    res.set('Cache-Control', 'public, max-age=31536000, immutable');
    return res.redirect(301, thumbUrl);
  } catch (e) {
    // 축소 실패 시 원본으로 폴백 (깨진 이미지보다 느린 이미지가 낫다)
    return res.redirect(302, supabaseAdmin.storage.from('photos').getPublicUrl(f).data.publicUrl);
  }
});

// multer 에러 처리
router.use((err, req, res, next) => {
  if (err.code === 'LIMIT_FILE_SIZE') {
    return res.status(400).json({ error: '20MB 이하 이미지만 업로드할 수 있습니다' });
  }
  res.status(400).json({ error: err.message });
});

module.exports = router;
