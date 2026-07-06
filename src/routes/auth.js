const express = require('express');
const router = express.Router();
const supabase = require('../supabase');

// POST /auth/signup
router.post('/signup', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: '이메일과 비밀번호는 필수입니다' });
  }

  const { data, error } = await supabase.auth.signUp({ email, password });
  if (error) return res.status(400).json({ error: error.message });

  res.status(201).json({ user: { id: data.user.id, email: data.user.email } });
});

// POST /auth/login
router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: '이메일과 비밀번호는 필수입니다' });
  }

  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) return res.status(401).json({ error: '이메일 또는 비밀번호가 틀렸습니다' });

  res.json({
    token: data.session.access_token,
    user: { id: data.user.id, email: data.user.email },
  });
});

module.exports = router;
