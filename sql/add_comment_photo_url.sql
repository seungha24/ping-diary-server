-- 댓글 사진 첨부 컬럼 (Supabase SQL Editor에서 실행)
-- 이 마이그레이션 전에도 서버는 photo_url 없이 동작하도록 폴백 처리돼 있고,
-- 실행하는 순간부터 사진 댓글이 저장된다.
alter table diary_comments add column if not exists photo_url text;
