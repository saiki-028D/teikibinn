// ============================================================
// 設定ファイル：ここだけ書き換えれば動きます
// ============================================================

// Supabaseプロジェクトの Settings > API から取得してください
const SUPABASE_URL = 'https://YOUR-PROJECT-REF.supabase.co';
const SUPABASE_ANON_KEY = 'YOUR-ANON-PUBLIC-KEY';

// Cloudinary（写真アップロード先）：これまでと同じ値を使う場合はそのままでOK
const CLOUDINARY_CLOUD = 'deshebyn8';
const CLOUDINARY_PRESET = 'vehicle_photos';

// ログイン画面で入力する「ID」に付加するドメイン（Supabase Authはメール形式が必須のため、
// 例えば「haiso」と入力すると内部的に「haiso@nikkenkougyo.co.jp」としてログインします）
const LOGIN_ID_DOMAIN = 'nikkenkougyo.co.jp';
