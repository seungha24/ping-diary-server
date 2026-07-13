-- 그룹 방장(만든 사람) 컬럼 추가 — 그룹 삭제를 방장만 가능하게
-- 실행 위치: Supabase SQL Editor (승하 직접 실행)

-- 1) created_by 컬럼 추가
alter table public.groups
  add column if not exists created_by uuid;

-- 2) 기존 그룹 백필: 가장 먼저 가입한 멤버(=생성 시 자동 추가된 만든 사람)를 방장으로
update public.groups g
set created_by = (
  select gm.user_id
  from public.group_members gm
  where gm.group_id = g.id
  order by gm.id asc
  limit 1
)
where g.created_by is null;
