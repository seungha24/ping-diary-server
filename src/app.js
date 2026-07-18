const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');

// 라우트만 구성된 Express 앱 (listen/scheduler 제외 → 테스트에서 재사용)
const app = express();
app.set('trust proxy', 1); // Railway 프록시 뒤에서 실제 클라이언트 IP 기준으로 제한
app.use(cors());
app.use(express.json());

// ── 레이트 리밋 ──────────────────────────────────────────────
// 전역: 남용 방지 수준의 완만한 제한
const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 600,
  standardHeaders: true, legacyHeaders: false,
  message: { error: '요청이 너무 많아요. 잠시 후 다시 시도해 주세요.' },
});
// 인증: 브루트포스 방지 (로그인·가입만 엄격히)
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 20,
  standardHeaders: true, legacyHeaders: false,
  message: { error: '로그인 시도가 너무 많아요. 15분 후 다시 시도해 주세요.' },
});
// AI 호출: OpenAI 비용 방어
const aiLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, max: 30,
  standardHeaders: true, legacyHeaders: false,
  message: { error: 'AI 요청이 너무 많아요. 잠시 후 다시 시도해 주세요.' },
});

app.use(globalLimiter);
app.use(['/auth/login', '/auth/signup'], authLimiter);
app.use(['/entries/report', '/entries/awards', '/entries/:id/comment'], aiLimiter);

app.get('/health', (req, res) => res.json({
  status: 'ok',
  // 환경변수 주입 여부만 노출 (값은 절대 노출하지 않음) — Railway 주입 문제 진단용
  env: { kakao_secret: !!process.env.KAKAO_CLIENT_SECRET, kakao_rest: !!process.env.KAKAO_REST_KEY },
}));

app.use('/auth', require('./routes/auth'));
app.use('/entries', require('./routes/entries'));
app.use('/groups', require('./routes/groups'));
app.use('/upload', require('./routes/upload'));
app.use('/reports', require('./routes/reports'));

module.exports = app;
