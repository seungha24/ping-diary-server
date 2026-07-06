require('dotenv').config();
const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

app.get('/health', (req, res) => res.json({ status: 'ok' }));

app.use('/auth', require('./src/routes/auth'));
app.use('/entries', require('./src/routes/entries'));
app.use('/groups', require('./src/routes/groups'));

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`서버 실행 중: http://localhost:${PORT}`));
