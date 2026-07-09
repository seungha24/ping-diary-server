const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');

/**
 * POST /reports — 부적절 콘텐츠 신고 접수.
 * 앱스토어 심사(UGC/AI 콘텐츠 신고 요건) 대응. 신고는 서버 로그로 남긴다.
 * (추후 전용 테이블/알림 연동 가능. 현재는 스키마 변경 없이 로그 기록.)
 */
router.post('/', requireAuth, (req, res) => {
  const { type, target_id, reason } = req.body || {};
  const t = String(type || 'unknown').slice(0, 40);
  const tid = String(target_id ?? '').slice(0, 64);
  const rsn = String(reason || '').slice(0, 500);
  console.log(`[REPORT] reporter=${req.user.id} type=${t} target=${tid} reason=${JSON.stringify(rsn)}`);
  res.json({ ok: true });
});

module.exports = router;
