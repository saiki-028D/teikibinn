-- ============================================================
-- 納入手順書（PDF）：取引先ごとに複数ファイル（追加のみ）
--   companies.procedures : [{ "path": Storage上の保存先, "name": 元のファイル名 }, ...]（複数可）
--   Storage: 非公開バケット procedures（ログイン済みユーザーのみ読み書き）
-- ============================================================
alter table companies add column if not exists procedures jsonb not null default '[]'::jsonb;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('procedures', 'procedures', false, 10485760, array['application/pdf'])
on conflict (id) do nothing;

create policy "procedures_authenticated_select" on storage.objects for select to authenticated using (bucket_id = 'procedures');
create policy "procedures_authenticated_insert" on storage.objects for insert to authenticated with check (bucket_id = 'procedures');
create policy "procedures_authenticated_update" on storage.objects for update to authenticated using (bucket_id = 'procedures');
create policy "procedures_authenticated_delete" on storage.objects for delete to authenticated using (bucket_id = 'procedures');
