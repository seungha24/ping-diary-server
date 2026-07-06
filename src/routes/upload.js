const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// POST /upload — 이미지 업로드
router.post('/', requireAuth, async (req, res) => {
  const chunks = [];
  req.on('data', chunk => chunks.push(chunk));
  req.on('end', async () => {
    try {
      const buffer = Buffer.concat(chunks);
      const contentType = req.headers['content-type'] || 'image/jpeg';

      if (buffer.length > 5 * 1024 * 1024) {
        return res.status(400).json({ error: '5MB 이하 이미지만 업로드할 수 있습니다' });
      }

      const ext = contentType.includes('png') ? 'png' : contentType.includes('gif') ? 'gif' : 'jpg';
      const fileName = `${req.user.id}_${Date.now()}.${ext}`;

      const { error } = await supabaseAdmin.storage
        .from('photos')
        .upload(fileName, buffer, { contentType, upsert: false });

      if (error) return res.status(500).json({ error: error.message });

      const { data } = supabaseAdmin.storage.from('photos').getPublicUrl(fileName);
      res.json({ url: data.publicUrl });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });
});

module.exports = router;
