-- REVIEW BEFORE RUNNING. This deletes only AMAN QA tenants created by the test runner.
-- Run only after the user explicitly approves cleanup and verifies the preview query.

select id,login_code,name_ar,name_en,contact_name,created_at
from public.complexes
where login_code ~ '^TST[AB][0-9]+'
  and contact_name='AMAN QA AUTOMATION'
order by created_at desc;

-- After reviewing the SELECT result, execute the transaction below separately.
-- begin;
-- create temporary table aman_qa_auth_users on commit drop as
-- select distinct p.auth_user_id
-- from public.profiles p
-- join public.complexes c on c.id=p.complex_id
-- where c.login_code ~ '^TST[AB][0-9]+'
--   and c.contact_name='AMAN QA AUTOMATION'
--   and p.auth_user_id is not null;
-- delete from public.complexes
-- where login_code ~ '^TST[AB][0-9]+'
--   and contact_name='AMAN QA AUTOMATION';
-- delete from auth.users u using aman_qa_auth_users t where u.id=t.auth_user_id;
-- commit;
