// ============================================================
// 設定ファイル：ここだけ書き換えれば動きます
// ============================================================

// Supabaseプロジェクトの Settings > API から取得してください
const SUPABASE_URL = 'https://nbwkvojuzwblzdmzzaaq.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5id2t2b2p1endibHpkbXp6YWFxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQxMzI0NTcsImV4cCI6MjA5OTcwODQ1N30.8FAdgbOhnst8RQFodY9Adt_CGLDIUKH6FucgtAP2V3A';

// Cloudinary（写真アップロード先）：これまでと同じ値を使う場合はそのままでOK
const CLOUDINARY_CLOUD = 'deshebyn8';
const CLOUDINARY_PRESET = 'vehicle_photos';

// ログイン画面で入力する「ID」に付加するドメイン（Supabase Authはメール形式が必須のため、
// 例えば「haiso」と入力すると内部的に「haiso@nikkenkougyo.co.jp」としてログインします）
const LOGIN_ID_DOMAIN = 'nikkenkougyo.co.jp';
