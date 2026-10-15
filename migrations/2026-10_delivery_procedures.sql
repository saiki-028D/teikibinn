-- ============================================================
-- 納入手順書（PDF）：取引先ごとに1ファイル（追加のみ）
--   companies.procedure_path : Storage上の保存先（procedures バケット内）
--   companies.procedure_name : 元のファイル名（表示用）
--   Storage: 非公開バケット procedures（ログイン済みユーザーのみ読み書き）
-- ============================================================
alter table companies add column if not exists procedure_path text;
alter table companies add column if not exists procedure_name text;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('procedures', 'procedures', false, 10485760, array['application/pdf'])
on conflict (id) do nothing;

create policy "procedures_authenticated_select" on storage.objects for select to authenticated using (bucket_id = 'procedures');
create policy "procedures_authenticated_insert" on storage.objects for insert to authenticated with check (bucket_id = 'procedures');
create policy "procedures_authenticated_update" on storage.objects for update to authenticated using (bucket_id = 'procedures');
create policy "procedures_authenticated_delete" on storage.objects for delete to authenticated using (bucket_id = 'procedures');
