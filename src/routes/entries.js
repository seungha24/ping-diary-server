const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');

// GET /entries — 내 일기 목록
router.get('/', requireAuth, async (req, res) => {
  const { data, error } = await req.supabase
    .from('diary_entries')
    .select('*')
    .order('created_at', { ascending: false });

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// POST /entries — 일기 작성
router.post('/', requireAuth, async (req, res) => {
  const { content, visibility = 'private', photo_url = null } = req.body;
  if (!content) return res.status(400).json({ error: 'content는 필수입니다' });

  const { data, error } = await req.supabase
    .from('diary_entries')
    .insert({ user_id: req.user.id, content, visibility, photo_url })
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });

  // AI 코멘트 비동기 생성 (응답은 먼저 보냄)
  res.status(201).json(data);
  generateAiComment(data.id, content, req.supabase);
});

// GET /entries/:id — 단건 조회 (AI 코멘트 polling용)
router.get('/:id', requireAuth, async (req, res) => {
  const { data, error } = await req.supabase
    .from('diary_entries')
    .select('*')
    .eq('id', req.params.id)
    .single();

  if (error || !data) return res.status(404).json({ error: '일기를 찾을 수 없습니다' });
  res.json(data);
});

// DELETE /entries/:id — 일기 삭제
router.delete('/:id', requireAuth, async (req, res) => {
  const { data: entry } = await req.supabase
    .from('diary_entries')
    .select('user_id')
    .eq('id', req.params.id)
    .single();

  if (!entry) return res.status(404).json({ error: '일기를 찾을 수 없습니다' });
  if (entry.user_id !== req.user.id) return res.status(403).json({ error: '본인의 일기만 삭제할 수 있습니다' });

  await req.supabase.from('diary_entries').delete().eq('id', req.params.id);
  res.status(204).send();
});

async function generateAiComment(entryId, content, supabase) {
  try {
    const OpenAI = require('openai');
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: '너는 사용자의 일기를 읽는 다정한 친구야. 2~3문장, 반말, 공감 위주로 답해줘. 훈수 두지 말고, 판단하지 말 것. 코멘트 내용만 출력해.',
        },
        { role: 'user', content },
      ],
    });

    const aiComment = completion.choices[0].message.content;
    await supabase.from('diary_entries').update({ ai_comment: aiComment }).eq('id', entryId);
  } catch (e) {
    console.error('AI 코멘트 생성 실패:', e.message);
  }
}

module.exports = router;
