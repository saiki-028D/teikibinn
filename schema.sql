-- ============================================================
-- 配送管理アプリ Supabase スキーマ
-- Supabase の SQL Editor に貼り付けて実行してください。
-- 既存のGoogleスプレッドシート運用から移行するための新しいデータ構造です。
-- ============================================================

-- 拡張機能（UUID生成用。Supabaseはデフォルトで有効なことが多いですが念のため）
create extension if not exists "pgcrypto";

-- ------------------------------------------------------------
-- updated_at 自動更新トリガー関数
-- ------------------------------------------------------------
create or replace function set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

-- ------------------------------------------------------------
-- 1. vehicles（車両マスタ）
-- ------------------------------------------------------------
create table if not exists vehicles (
  id            uuid primary key default gen_random_uuid(),
  name          text not null,               -- 車両名・ナンバー
  type          text,                        -- 車種
  shaken_date   date,                        -- 車検満了日
  insurance_date date,                       -- 任意保険更新日
  note          text,
  sort_order    int not null default 0,      -- 車両タブの表示順
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create trigger trg_vehicles_updated_at before update on vehicles
  for each row execute function set_updated_at();

-- ------------------------------------------------------------
-- 2. drivers（ドライバーマスタ）
-- ------------------------------------------------------------
create table if not exists drivers (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  vehicle_id  uuid references vehicles(id) on delete set null,
  mon boolean not null default false,
  tue boolean not null default false,
  wed boolean not null default false,
  thu boolean not null default false,
  fri boolean not null default false,
  sat boolean not null default false,
  sun boolean not null default false,
  note        text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create trigger trg_drivers_updated_at before update on drivers
  for each row execute function set_updated_at();

-- ------------------------------------------------------------
-- 3. companies（取引先マスタ：定期／不定期パターン）
-- ------------------------------------------------------------
create table if not exists companies (
  id                  uuid primary key default gen_random_uuid(),
  name                text not null unique,
  default_time        time,
  default_vehicle_id  uuid references vehicles(id) on delete set null,
  -- pattern: '毎営業日' / '月,木' / '火,金' / '水' / '不定期・かんばん次第' など
  -- 複数曜日はカンマ区切りの日本語1文字（月,火,水,木,金,土,日）で保持し、
  -- アプリ側の既存ロジックをそのまま流用できるようにしています。
  pattern             text not null default '毎営業日',
  note                text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
create trigger trg_companies_updated_at before update on companies
  for each row execute function set_updated_at();

-- ------------------------------------------------------------
-- 4. dispatch_days（日ごとの運行：定期便からの変更点＋スポット便のみを保持）
--    ・定期パターンに一致する「通常運行」はここに行を作らず、
--      companies.pattern から毎回計算します（旧routesシートのマスタ行に相当）。
--    ・この表に入るのは「例外」だけ：
--        - status='skip'  → 本来運行日だが休みにする
--        - status='go'    → スポット便 or 時間/車両/ドライバーを変更した確定運行
-- ------------------------------------------------------------
create table if not exists dispatch_days (
  id            uuid primary key default gen_random_uuid(),
  date          date not null,
  company_id    uuid references companies(id) on delete set null,
  company_name  text not null,              -- 取引先マスタ未登録のスポット便にも対応する非正規化名
  status        text not null check (status in ('go','skip')) default 'go',
  time          time,
  vehicle_id    uuid references vehicles(id) on delete set null,
  driver_id     uuid references drivers(id) on delete set null,
  is_spot       boolean not null default false,  -- true: マスタに無い/対象外のスポット便
  has_delivery  boolean not null default true,   -- 📦 納品あり
  has_pickup    boolean not null default false,  -- 🔄 引取あり
  note          text,                            -- 本日の確定スケジュールに表示するメモ
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (date, company_name)
);
create index if not exists idx_dispatch_days_date on dispatch_days(date);
create trigger trg_dispatch_days_updated_at before update on dispatch_days
  for each row execute function set_updated_at();

-- ------------------------------------------------------------
-- 5. checks（月次点検：1車両×1年月＝1行。26項目はJSONBでまとめて保持）
--    items の例: {"seat_1":"○","seat_2":"×", ...}
-- ------------------------------------------------------------
create table if not exists checks (
  id          uuid primary key default gen_random_uuid(),
  vehicle_id  uuid not null references vehicles(id) on delete cascade,
  year        int not null,
  month       int not null,
  items       jsonb not null default '{}'::jsonb,
  inspector   text,
  note        text,
  saved_at    timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (vehicle_id, year, month)
);
create trigger trg_checks_updated_at before update on checks
  for each row execute function set_updated_at();

-- ------------------------------------------------------------
-- 6. delivery_records（配送実績：納品／引取の写真URL・メモ）
-- ------------------------------------------------------------
create table if not exists delivery_records (
  id                  uuid primary key default gen_random_uuid(),
  date                date not null,
  company_name        text not null,
  nouhin_memo         text,
  hikitori_memo       text,
  nouhin_photo_urls   text[] not null default '{}',
  hikitori_photo_urls text[] not null default '{}',
  saved_by            text,                 -- 入力したドライバー名（任意）
  saved_at            timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (date, company_name)
);
create index if not exists idx_delivery_records_date on delivery_records(date);
create trigger trg_delivery_records_updated_at before update on delivery_records
  for each row execute function set_updated_at();

-- ============================================================
-- RLS（行レベルセキュリティ）
-- 社内共有ログイン（Supabase Authでログイン済みユーザー）であれば
-- 全テーブルを読み書きできるシンプルなポリシーにしています。
-- ============================================================
alter table vehicles         enable row level security;
alter table drivers          enable row level security;
alter table companies        enable row level security;
alter table dispatch_days    enable row level security;
alter table checks           enable row level security;
alter table delivery_records enable row level security;

do $$
declare
  t text;
begin
  foreach t in array array['vehicles','drivers','companies','dispatch_days','checks','delivery_records']
  loop
    execute format('drop policy if exists "authenticated_all" on %I', t);
    execute format(
      'create policy "authenticated_all" on %I for all to authenticated using (true) with check (true)',
      t
    );
  end loop;
end $$;

-- ============================================================
-- Realtime（画面を開いたまま他の人の更新が自動反映されるようにする）
-- ============================================================
alter publication supabase_realtime add table vehicles;
alter publication supabase_realtime add table drivers;
alter publication supabase_realtime add table companies;
alter publication supabase_realtime add table dispatch_days;
alter publication supabase_realtime add table checks;
alter publication supabase_realtime add table delivery_records;
