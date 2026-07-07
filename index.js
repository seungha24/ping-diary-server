require('dotenv').config();
const app = require('./src/app');

// 예약 발송 스케줄러 시작
require('./src/scheduler');

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`서버 실행 중: http://localhost:${PORT}`));
