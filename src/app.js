const express = require('express');
const cors = require('cors');

// 라우트만 구성된 Express 앱 (listen/scheduler 제외 → 테스트에서 재사용)
const app = express();
app.use(cors());
app.use(express.json());

app.get('/health', (req, res) => res.json({ status: 'ok' }));

app.use('/auth', require('./routes/auth'));
app.use('/entries', require('./routes/entries'));
app.use('/groups', require('./routes/groups'));
app.use('/upload', require('./routes/upload'));

module.exports = app;
