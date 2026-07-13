-- groups 테이블 RLS 활성화
-- 목적: 앱 번들에 들어있는 공개(anon) 키로 로그인 없이 그룹 목록·초대코드(invite_code)를
--       읽던 것을 차단. 서버 라우트는 사용자 JWT(authenticated 역할)로 동작하므로 영향 없음.
-- 실행: Supabase 대시보드 → SQL Editor → 붙여넣고 Run.

alter table public.groups enable row level security;

-- 혹시 이전에 만든 동일 정책이 있으면 정리
drop policy if exists "groups_authenticated_all" on public.groups;

-- 로그인한 사용자(=서버 라우트)만 접근 허용. anon 역할은 정책이 없으므로 전부 거부됨.
create policy "groups_authenticated_all"
  on public.groups
  for all
  to authenticated
  using (true)
  with check (true);

-- 2차 강화 (2026-07-12): 로그인 사용자도 groups를 직접 못 읽게.
-- 서버 라우트가 전부 service_role(관리자)로 그룹을 처리하도록 바꾼 뒤 실행.
-- anon은 이미 revoke됨. authenticated까지 막으면 초대코드는 오직 서버 API로만 접근 가능.
revoke all on public.groups from anon;
revoke all on public.groups from authenticated;
