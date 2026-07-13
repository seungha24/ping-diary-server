-- 그룹 멤버십 중복 방지: unique(group_id, user_id) 제약 추가
-- 실행 위치: Supabase SQL Editor (승하 직접 실행)
--
-- 배경: /groups/join 이 check-then-insert 라 동시 요청(더블탭·재시도)이
-- 둘 다 통과하면 중복 멤버 행이 생겨 멤버 수가 부풀 수 있음.
-- DB 제약으로 원천 차단하고, 이후 서버 라우트를 upsert로 교체한다.

-- 1) 혹시 이미 생긴 중복 행이 있으면 가장 오래된 행 하나만 남기고 제거
delete from public.group_members a
using public.group_members b
where a.group_id = b.group_id
  and a.user_id = b.user_id
  and a.id > b.id;

-- 2) 유니크 제약 추가 (이후 중복 insert는 DB가 거부)
alter table public.group_members
  add constraint group_members_group_user_uniq unique (group_id, user_id);
