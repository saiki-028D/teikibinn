#!/usr/bin/env node
// ============================================================
// Googleスプレッドシート → Supabase 移行スクリプト
// 外部ライブラリ不要（Node.js標準機能のみ）。 node migrate.js で実行します。
//
// 事前準備:
//   1. 現行スプレッドシートの各タブを「ファイル > ダウンロード > カンマ区切り値(.csv)」で
//      それぞれ書き出し、このファイルと同じフォルダに以下の名前で保存してください。
//        vehicles.csv / drivers.csv / routes.csv / checks.csv / delivery_records.csv
//   2. 環境変数を設定してください（SupabaseのService role keyはAPI設定画面から取得）。
//        SUPABASE_URL=https://xxxx.supabase.co
//        SUPABASE_SERVICE_ROLE_KEY=xxxxx
//   3. まずは --dry-run で内容を確認してから本実行することを強く推奨します。
//
//      SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node migrate.js --dry-run
//      SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node migrate.js
//
// ※ 列構成は実際のGAS(Apps Script)コード（doGet/doPost/saveDelivery/upsertRow/saveCheck）を
//    確認して設計しています。ただし本番データでの実行前には、必ず --dry-run の
//    出力内容を目視確認してください。もし列名が異なる場合はCSVのヘッダー行を
//    このスクリプトが期待する名前に合わせて書き換えてください（下記CSV_SCHEMAS参照）。
// ============================================================

const fs = require('fs');
const path = require('path');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const DRY_RUN = process.argv.includes('--dry-run');
const DIR = __dirname;

if (!DRY_RUN && (!SUPABASE_URL || !SERVICE_KEY)) {
  console.error('❌ SUPABASE_URL と SUPABASE_SERVICE_ROLE_KEY を環境変数で指定してください（--dry-run のときは不要です）');
  process.exit(1);
}

// ------------------------------------------------------------
// 期待するCSVヘッダー（違う場合はCSV側を書き換えてください）
// ------------------------------------------------------------
const CSV_SCHEMAS = {
  'vehicles.csv':         ['id', 'name', 'type', 'shaken', 'insurance', 'note'],
  'drivers.csv':          ['id', 'name', 'vehicleId', '月', '火', '水', '木', '金', '土', '日', 'note'],
  'routes.csv':           ['id', 'name', 'time', 'vehicleId', 'defaultVehicleId', 'driverId', 'days', 'note'],
  'checks.csv':           ['vehicleId', 'year', 'month', 'itemKey', 'value', 'note', 'inspector', 'savedAt'],
  'delivery_records.csv': ['companyName', 'date', 'nouhinMemo', 'hikitoriMemo', 'nouhinPhotoUrls', 'hikitoriPhotoUrls', 'savedAt'],
};

// ------------------------------------------------------------
// 依存ライブラリなしの簡易CSVパーサー（ダブルクォート・カンマ・改行対応）
// ------------------------------------------------------------
function parseCSV(text) {
  const rows = [];
  let row = [], field = '', inQuotes = false;
  text = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else { inQuotes = false; }
      } else field += ch;
    } else {
      if (ch === '"') inQuotes = true;
      else if (ch === ',') { row.push(field); field = ''; }
      else if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
      else field += ch;
    }
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  if (!rows.length) return [];
  const header = rows[0];
  return rows.slice(1).filter(r => r.some(c => c !== '')).map(r => {
    const obj = {};
    header.forEach((h, idx) => { obj[h.trim()] = (r[idx] ?? '').trim(); });
    return obj;
  });
}

function loadCSV(filename) {
  const p = path.join(DIR, filename);
  if (!fs.existsSync(p)) { console.log(`  (スキップ: ${filename} が見つかりません)`); return []; }
  const rows = parseCSV(fs.readFileSync(p, 'utf8'));
  const expected = CSV_SCHEMAS[filename] || [];
  const actualHeaders = rows.length ? Object.keys(rows[0]) : [];
  const missing = expected.filter(h => !actualHeaders.includes(h));
  if (missing.length) {
    console.warn(`  ⚠️ ${filename}: 想定した列が見つかりません → [${missing.join(', ')}]`);
    console.warn(`     実際の列: [${actualHeaders.join(', ')}]`);
  }
  console.log(`  ${filename}: ${rows.length}行 読み込み`);
  return rows;
}

function toDateOnly(v) {
  if (!v) return null;
  const m = String(v).match(/(\d{4})[-\/](\d{1,2})[-\/](\d{1,2})/);
  if (!m) return null;
  return `${m[1]}-${String(m[2]).padStart(2, '0')}-${String(m[3]).padStart(2, '0')}`;
}
function toISOTimestamp(v) {
  if (!v) return new Date().toISOString();
  const d = new Date(v);
  return isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
}
function uuid() { return crypto.randomUUID(); }
function csvArray(v) {
  if (!v) return [];
  return String(v).split(',').map(s => s.trim()).filter(Boolean);
}

// ------------------------------------------------------------
// Supabase REST(PostgREST) への一括insert（service role keyでRLSをバイパス）
// ------------------------------------------------------------
async function insertRows(table, rows) {
  if (!rows.length) return;
  if (DRY_RUN) {
    console.log(`  [DRY-RUN] ${table} に ${rows.length}件 insert予定（先頭1件のサンプル）`);
    console.log('   ', JSON.stringify(rows[0]));
    return;
  }
  const CHUNK = 500;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': SERVICE_KEY,
        'Authorization': `Bearer ${SERVICE_KEY}`,
        'Prefer': 'return=minimal',
      },
      body: JSON.stringify(chunk),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`${table} への書き込みに失敗 (HTTP ${res.status}): ${text}`);
    }
    console.log(`  ${table}: ${Math.min(i + CHUNK, rows.length)}/${rows.length}件 完了`);
  }
}

// ------------------------------------------------------------
// メイン処理
// ------------------------------------------------------------
async function main() {
  console.log(`=== 移行開始 ${DRY_RUN ? '(DRY RUN・書き込みなし)' : ''} ===`);

  console.log('\n[1/6] CSV読み込み');
  const vehiclesCsv = loadCSV('vehicles.csv');
  const driversCsv = loadCSV('drivers.csv');
  const routesCsv = loadCSV('routes.csv');
  const checksCsv = loadCSV('checks.csv');
  const deliveryCsv = loadCSV('delivery_records.csv');

  const vehicleIdMap = new Map(); // 旧id -> 新uuid
  const driverIdMap = new Map();
  const companyIdMap = new Map(); // 会社名 -> 新uuid（routesの名前で紐付け）

  console.log('\n[2/6] vehicles 変換');
  const vehicleRows = vehiclesCsv.map(v => {
    const id = uuid();
    vehicleIdMap.set(v.id, id);
    return {
      id, name: v.name || '(名称未設定)', type: v.type || null,
      shaken_date: toDateOnly(v.shaken), insurance_date: toDateOnly(v.insurance),
      note: v.note || null,
    };
  });
  await insertRows('vehicles', vehicleRows);

  console.log('\n[3/6] drivers 変換');
  const driverRows = driversCsv.map(d => {
    const id = uuid();
    driverIdMap.set(d.id, id);
    return {
      id, name: d.name || '(名称未設定)',
      vehicle_id: vehicleIdMap.get(d.vehicleId) || null,
      mon: d['月'] === '✓', tue: d['火'] === '✓', wed: d['水'] === '✓',
      thu: d['木'] === '✓', fri: d['金'] === '✓', sat: d['土'] === '✓', sun: d['日'] === '✓',
      note: d.note || null,
    };
  });
  await insertRows('drivers', driverRows);

  console.log('\n[4/6] companies（定期便マスタ）変換');
  const dateNotePattern = /\d{4}[-\/]\d{2}[-\/]\d{2}/;
  const masterRows = routesCsv.filter(r => r.name && (!r.note || !dateNotePattern.test(r.note)));
  const overrideRows = routesCsv.filter(r => r.name && r.note && dateNotePattern.test(r.note));

  // 同名の取引先が複数行あった場合は後の行（＝より新しい内容）を優先
  const companyRowsMap = new Map();
  masterRows.forEach(r => {
    companyRowsMap.set(r.name, {
      name: r.name,
      default_time: r.time || null,
      default_vehicle_id_raw: r.defaultVehicleId || r.vehicleId,
      pattern: r.days || '毎営業日',
      note: r.note || null,
    });
  });
  const companyRows = [...companyRowsMap.values()].map(c => {
    const id = uuid();
    companyIdMap.set(c.name, id);
    return { id, name: c.name, default_time: c.default_time, default_vehicle_id: vehicleIdMap.get(c.default_vehicle_id_raw) || null, pattern: c.pattern, note: c.note };
  });
  await insertRows('companies', companyRows);

  console.log('\n[5/6] dispatch_days（日次の例外・スポット便）変換');
  // 同じ日付・取引先の行が複数あった場合は後の行を優先（date,company_name がユニーク制約のため）
  const dispatchRowsMap = new Map();
  overrideRows.forEach(r => {
    const date = toDateOnly(r.note);
    if (!date) return;
    const companyId = companyIdMap.get(r.name) || null;
    dispatchRowsMap.set(`${date}|${r.name}`, {
      date, company_id: companyId, company_name: r.name,
      status: r.days === 'SKIP' ? 'skip' : 'go',
      time: r.time || null,
      vehicle_id: vehicleIdMap.get(r.vehicleId) || null,
      driver_id: driverIdMap.get(r.driverId) || null,
      is_spot: !companyId,
    });
  });
  await insertRows('dispatch_days', [...dispatchRowsMap.values()]);

  console.log('\n[6/6] checks・delivery_records 変換');
  const checkGroups = new Map(); // key: vehicleId|year|month
  checksCsv.forEach(c => {
    const vId = vehicleIdMap.get(c.vehicleId);
    if (!vId || !c.year || !c.month) return;
    const key = `${vId}|${c.year}|${c.month}`;
    if (!checkGroups.has(key)) checkGroups.set(key, { vehicle_id: vId, year: Number(c.year), month: Number(c.month), items: {}, note: c.note || null, inspector: c.inspector || null, saved_at: toISOTimestamp(c.savedAt) });
    if (c.itemKey) checkGroups.get(key).items[c.itemKey] = c.value;
  });
  await insertRows('checks', [...checkGroups.values()]);

  // 同じ日付・取引先の行が複数あった場合は後の行を優先（date,company_name がユニーク制約のため）
  const deliveryRowsMap = new Map();
  deliveryCsv.forEach(r => {
    const date = toDateOnly(r.date);
    if (!date || !r.companyName) return;
    deliveryRowsMap.set(`${date}|${r.companyName}`, {
      date, company_name: r.companyName,
      nouhin_memo: r.nouhinMemo || null,
      hikitori_memo: r.hikitoriMemo || null,
      nouhin_photo_urls: csvArray(r.nouhinPhotoUrls),
      hikitori_photo_urls: csvArray(r.hikitoriPhotoUrls),
      saved_at: toISOTimestamp(r.savedAt),
    });
  });
  await insertRows('delivery_records', [...deliveryRowsMap.values()]);

  console.log(`\n=== 完了 ${DRY_RUN ? '(DRY RUNのため実際の書き込みなし。内容を確認して --dry-run を外して再実行してください)' : ''} ===`);
}

main().catch(e => { console.error('❌ エラー:', e.message); process.exit(1); });
