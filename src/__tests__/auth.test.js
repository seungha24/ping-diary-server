const request = require('supertest');
const app = require('../app');

// 네트워크(Supabase) 호출 전에 걸리는 검증/인증 경로만 테스트한다.
describe('기본 헬스체크', () => {
  test('GET /health → 200 ok', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
  });
});

describe('인증 입력 검증', () => {
  test('POST /auth/signup 이메일/비번 없으면 400', async () => {
    const res = await request(app).post('/auth/signup').send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBeTruthy();
  });

  test('POST /auth/login 이메일/비번 없으면 400', async () => {
    const res = await request(app).post('/auth/login').send({ email: 'a@b.com' });
    expect(res.status).toBe(400);
  });
});

describe('보호된 엔드포인트는 토큰 없으면 401', () => {
  test('POST /auth/password (토큰 없음) → 401', async () => {
    const res = await request(app).post('/auth/password').send({ password: 'x' });
    expect(res.status).toBe(401);
  });

  test('DELETE /auth/account (토큰 없음) → 401', async () => {
    const res = await request(app).delete('/auth/account');
    expect(res.status).toBe(401);
  });

  test('GET /entries (토큰 없음) → 401', async () => {
    const res = await request(app).get('/entries');
    expect(res.status).toBe(401);
  });
});
