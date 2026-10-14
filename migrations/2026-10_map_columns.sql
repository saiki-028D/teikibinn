-- ============================================================
-- 地図機能用の列追加（既存データには影響しない「追加のみ」）
--   companies.address / lat / lng : 取引先の住所と緯度経度
--   vehicles.icon                 : 地図に出す車アイコンの種類
--     mini=ミニキャブ型 / ek=ekワゴン型 / van=バネット型 / hi=ハイエース型 / truck=トラック型
--     空のときは車両名・車種から自動で判定します
-- ============================================================
alter table companies add column if not exists address text;
alter table companies add column if not exists lat double precision;
alter table companies add column if not exists lng double precision;
alter table vehicles  add column if not exists icon text;
