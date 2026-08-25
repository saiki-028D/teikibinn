// ============================================================
// 車両・配送管理システム（Supabase版）
// config.js の SUPABASE_URL / SUPABASE_ANON_KEY を読み込んで動作します。
// ============================================================

const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
const CLOUDINARY_URL = `https://api.cloudinary.com/v1_1/${CLOUDINARY_CLOUD}/image/upload`;

// ── 曜日ヘルパー ──
const DOW_JP  = ['日','月','火','水','木','金','土'];
const DOW_KEY = ['sun','mon','tue','wed','thu','fri','sat'];

function fmtDate(d) { return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; }
function parseDate(s) { const [y,m,d] = s.split('-').map(Number); return new Date(y, m-1, d); }

const todayObj = new Date();
const todayStr = fmtDate(todayObj);
const todayDay = DOW_JP[todayObj.getDay()];

// ── アプリ状態 ──
let db = { vehicles: [], drivers: [], companies: [] };
let dispatchCache = new Map();   // key: `${date}|${companyName}` -> row
let dispatchByDate = new Map();  // key: date -> array of rows (company_id無しのスポットも含む)
let recordsByDate = new Map();   // key: date -> Map(companyName -> record)
let holidays = {};

let currentYear, currentMonth;
let confirmedVehicleFilter = 'all';
let calVehicleFilter = 'all';
let calCompanyFilter = '';
let activeTab = 'today';

const VEHICLE_COLORS = [
  { bg: '#dbeafe', text: '#1e40af', dot: '#3b82f6' },
  { bg: '#dcfce7', text: '#166534', dot: '#22c55e' },
  { bg: '#fef9c3', text: '#854d0e', dot: '#eab308' },
  { bg: '#ffe4e6', text: '#9f1239', dot: '#f43f5e' },
  { bg: '#ede9fe', text: '#5b21b6', dot: '#8b5cf6' },
  { bg: '#ffedd5', text: '#9a3412', dot: '#f97316' },
  { bg: '#f0fdf4', text: '#065f46', dot: '#10b981' },
];
function getVehicleColor(vehicleId) {
  if (!vehicleId) return { bg: '#f3f4f6', text: '#6b7280', dot: '#9ca3af' };
  const idx = db.vehicles.findIndex(v => String(v.id) === String(vehicleId));
  return VEHICLE_COLORS[Math.max(0, idx) % VEHICLE_COLORS.length];
}

// ════════════════════════════════════════════════════════
//  認証
// ════════════════════════════════════════════════════════
document.getElementById('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const id = document.getElementById('login-email').value.trim();
  const email = id.includes('@') ? id : `${id}@${LOGIN_ID_DOMAIN}`;
  const password = document.getElementById('login-password').value;
  const btn = document.getElementById('login-submit');
  const errEl = document.getElementById('login-error');
  errEl.classList.add('hidden');
  btn.disabled = true; btn.textContent = 'ログイン中...';
  const { error } = await sb.auth.signInWithPassword({ email, password });
  btn.disabled = false; btn.textContent = 'ログイン';
  if (error) {
    errEl.textContent = 'ログインできませんでした（IDまたはパスワードが違います）';
    errEl.classList.remove('hidden');
  }
});

async function doLogout() {
  if (!confirm('ログアウトしますか？')) return;
  await sb.auth.signOut();
}

sb.auth.onAuthStateChange((event, session) => {
  if (session) {
    document.getElementById('view-login').classList.add('hidden');
    document.getElementById('app').classList.remove('hidden');
    boot();
  } else {
    document.getElementById('view-login').classList.remove('hidden');
    document.getElementById('app').classList.add('hidden');
  }
});

let booted = false;
async function boot() {
  if (booted) return;
  booted = true;
  currentYear = todayObj.getFullYear();
  currentMonth = todayObj.getMonth() + 1;
  document.getElementById('today-date-display').innerText = `${currentYear}年${currentMonth}月${todayObj.getDate()}日（${todayDay}）`;
  document.getElementById('rec-from').value = `${currentYear}-${String(currentMonth).padStart(2,'0')}-01`;
  document.getElementById('rec-to').value = todayStr;
  initCheckFormSelectors();
  renderCheckForm();
  updateStatus('loading', '読み込み中...');
  await Promise.all([fetchHolidays(), loadMasters()]);
  await loadDispatchAndRecordsForMonth(currentYear, currentMonth);
  updateDropdowns();
  refreshAllViews();
  updateStatus('success', '同期完了');
  subscribeRealtime();
}

function fetchHolidays() {
  return fetch('https://holidays-jp.github.io/api/v1/date.json')
    .then(r => r.json()).then(d => { holidays = d; }).catch(() => {});
}

// ════════════════════════════════════════════════════════
//  データ読み込み（必要な範囲だけ・毎シート全件は取りに行かない）
// ════════════════════════════════════════════════════════
async function loadMasters() {
  const [{data: vehicles}, {data: drivers}, {data: companies}] = await Promise.all([
    sb.from('vehicles').select('*').order('sort_order').order('created_at'),
    sb.from('drivers').select('*').order('created_at'),
    sb.from('companies').select('*').order('created_at'),
  ]);
  db.vehicles = vehicles || [];
  db.drivers = drivers || [];
  db.companies = companies || [];
}

function monthRange(year, month) {
  const from = `${year}-${String(month).padStart(2,'0')}-01`;
  const lastDate = new Date(year, month, 0).getDate();
  const to = `${year}-${String(month).padStart(2,'0')}-${String(lastDate).padStart(2,'0')}`;
  return { from, to };
}

async function loadDispatchAndRecordsForMonth(year, month) {
  const { from, to } = monthRange(year, month);
  await loadDispatchRange(from, to);
  await loadRecordsRange(from, to);
}

async function loadDispatchRange(from, to) {
  const { data } = await sb.from('dispatch_days').select('*').gte('date', from).lte('date', to);
  dispatchCache.clear(); dispatchByDate.clear();
  (data || []).forEach(row => {
    dispatchCache.set(`${row.date}|${row.company_name}`, row);
    if (!dispatchByDate.has(row.date)) dispatchByDate.set(row.date, []);
    dispatchByDate.get(row.date).push(row);
  });
}

async function loadRecordsRange(from, to) {
  const { data } = await sb.from('delivery_records').select('*').gte('date', from).lte('date', to);
  recordsByDate.clear();
  (data || []).forEach(rec => {
    if (!recordsByDate.has(rec.date)) recordsByDate.set(rec.date, new Map());
    recordsByDate.get(rec.date).set(rec.company_name, rec);
  });
}

function refreshAllViews() {
  buildConfirmedVtabs();
  renderTodayDispatchBuilder();
  renderCalendar();
  renderCompanies();
  renderVehicles();
  renderDrivers();
}

// ── リアルタイム同期：他の人の更新を軽量に反映 ──
let refreshTimer = null;
function scheduleRefresh() {
  if (refreshTimer) clearTimeout(refreshTimer);
  refreshTimer = setTimeout(async () => {
    await loadDispatchAndRecordsForMonth(currentYear, currentMonth);
    refreshCurrentTabOnly();
  }, 500);
}
function refreshCurrentTabOnly() {
  if (activeTab === 'today') { buildConfirmedVtabs(); renderTodayDispatchBuilder(); }
  else if (activeTab === 'calendar') { renderCalendar(); }
  else if (activeTab === 'records') { loadRecordsView(); }
}
function subscribeRealtime() {
  sb.channel('public:dispatch_days')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'dispatch_days' }, scheduleRefresh)
    .subscribe();
  sb.channel('public:delivery_records')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'delivery_records' }, scheduleRefresh)
    .subscribe();
}

function switchTab(tabId) {
  activeTab = tabId;
  document.querySelectorAll('.tab-content').forEach(el => el.classList.add('hidden'));
  document.getElementById(`view-${tabId}`).classList.remove('hidden');
  document.querySelectorAll('nav button[id^="tab-"]').forEach(btn => btn.className = 'w-full py-4 px-2 text-gray-600 hover:text-slate-800 whitespace-nowrap');
  document.getElementById(`tab-${tabId}`).className = 'w-full py-4 px-2 text-slate-800 font-bold border-b-2 border-slate-800 whitespace-nowrap';
  if (tabId === 'records') loadRecordsView();
}

// ════════════════════════════════════════════════════════
//  スケジュール計算（定期パターン + dispatch_daysの例外をマージ）
// ════════════════════════════════════════════════════════
function patternMatchesDate(pattern, dateObj, isHol) {
  if (!pattern) return false;
  if (pattern.includes('不定期')) return false;
  const isWeekend = dateObj.getDay() === 0 || dateObj.getDay() === 6;
  if (pattern === '毎営業日') return !isHol && !isWeekend;
  const dow = DOW_JP[dateObj.getDay()];
  return pattern.split(',').map(s => s.trim()).includes(dow);
}

function autoDriverFor(vehicleId, dateObj) {
  if (!vehicleId) return '';
  const key = DOW_KEY[dateObj.getDay()];
  const drv = db.drivers.find(d => String(d.vehicle_id) === String(vehicleId) && d[key]);
  return drv ? drv.id : '';
}

// cache/byDate を省略すると、現在読み込み済みの共有キャッシュ（本日・カレンダー用）を使います。
// 「実績一覧」タブなど別の日付範囲を一時的に集計したい場合は、専用のMapを渡して
// 共有キャッシュを壊さないようにします。
function getScheduledCompaniesForDate(dateObj, cache = dispatchCache, byDate = dispatchByDate) {
  const fd = fmtDate(dateObj);
  const isHol = holidays[fd] !== undefined;
  const list = [];

  db.companies.forEach(c => {
    if (!patternMatchesDate(c.pattern, dateObj, isHol)) return;
    const override = cache.get(`${fd}|${c.name}`);
    if (override && override.status === 'skip') return;
    const vehicleId = (override && override.vehicle_id) || c.default_vehicle_id || '';
    const time = (override && override.time) || c.default_time || '';
    const driverId = (override && override.driver_id) || autoDriverFor(vehicleId, dateObj) || '';
    list.push({
      name: c.name, companyId: c.id, vehicleId, driverId, time, type: 'regular',
      confirmed: !!(override && override.status === 'go'),
      memo: override ? (override.note || '') : '',
      hasDelivery: override ? override.has_delivery !== false : true,
      hasPickup: override ? !!override.has_pickup : false,
    });
  });

  (byDate.get(fd) || []).forEach(row => {
    if (row.status !== 'go') return;
    if (list.some(x => x.name === row.company_name)) return;
    list.push({
      name: row.company_name, companyId: row.company_id, vehicleId: row.vehicle_id, driverId: row.driver_id, time: row.time,
      type: row.is_spot ? 'spot' : 'regular', confirmed: true,
      memo: row.note || '', hasDelivery: row.has_delivery !== false, hasPickup: !!row.has_pickup,
    });
  });

  return list;
}

// ════════════════════════════════════════════════════════
//  ① 車検アラート
// ════════════════════════════════════════════════════════
function renderAlerts() {
  const alerts = document.getElementById('today-alerts');
  alerts.innerHTML = '';
  let count = 0;
  db.vehicles.forEach(v => {
    if (v.shaken_date) {
      const days = Math.ceil((new Date(v.shaken_date) - todayObj) / 86400000);
      if (days <= 60) {
        count++;
        const cls = days < 0 ? 'bg-red-100 border-red-200 text-red-700' : 'bg-orange-50 border-orange-200 text-orange-700';
        alerts.innerHTML += `<div class="text-xs p-3 rounded-md border ${cls} flex justify-between items-center"><span>⚠️ <strong>${v.name}</strong> 車検${days < 0 ? '期限切れ' : `まであと${days}日`}</span><span class="font-bold">${v.shaken_date}</span></div>`;
      }
    }
  });
  if (count === 0) alerts.innerHTML = `<div class="text-xs text-green-700 bg-green-50 border border-green-200 p-3 rounded-md">✅ 車検アラートなし（60日以内の期限切れなし）</div>`;
}

// ════════════════════════════════════════════════════════
//  ② 確定スケジュール（本日）
// ════════════════════════════════════════════════════════
function buildConfirmedVtabs() {
  const bar = document.getElementById('confirmed-vtab-bar');
  bar.innerHTML = '';
  const btnAll = document.createElement('button');
  btnAll.className = `vtab ${confirmedVehicleFilter === 'all' ? 'active' : ''}`;
  btnAll.textContent = 'すべて';
  btnAll.onclick = () => { confirmedVehicleFilter = 'all'; buildConfirmedVtabs(); renderFinalList(); };
  bar.appendChild(btnAll);
  db.vehicles.forEach(v => {
    const btn = document.createElement('button');
    btn.className = `vtab ${confirmedVehicleFilter === v.id ? 'active' : ''}`;
    btn.textContent = v.name;
    btn.onclick = () => { confirmedVehicleFilter = v.id; buildConfirmedVtabs(); renderFinalList(); };
    bar.appendChild(btn);
  });
  renderFinalList();
}

function renderFinalList() {
  const container = document.getElementById('today-final-list');
  container.innerHTML = '';
  let runs = getScheduledCompaniesForDate(todayObj);
  if (confirmedVehicleFilter !== 'all') runs = runs.filter(r => String(r.vehicleId) === String(confirmedVehicleFilter));

  if (runs.length === 0) {
    container.innerHTML = '<p class="text-sm text-gray-400 text-center py-3">本日の運行予定はありません。</p>';
    return;
  }

  const assignedIds = new Set(runs.map(s => s.driverId).filter(Boolean).map(String));
  if (assignedIds.size > 0) {
    const chips = [...assignedIds].map(did => {
      const drv = db.drivers.find(d => String(d.id) === did);
      return drv ? `<span class="inline-flex items-center gap-1 px-2.5 py-1 rounded text-xs font-medium bg-blue-50 text-blue-700 border border-blue-100">👤 ${drv.name}</span>` : '';
    }).join('');
    container.innerHTML += `<div class="flex flex-wrap gap-2 pb-3 border-b border-dashed border-gray-200"><span class="text-xs text-gray-400 self-center">本日のドライバー：</span>${chips}</div>`;
  }

  runs.sort((a, b) => (a.time || '').localeCompare(b.time || ''));
  runs.forEach(s => {
    const v = db.vehicles.find(x => String(x.id) === String(s.vehicleId));
    const drv = db.drivers.find(x => String(x.id) === String(s.driverId));
    const hasRecord = !!(recordsByDate.get(todayStr) && recordsByDate.get(todayStr).get(s.name));
    const badge = s.confirmed
      ? '<span class="text-[10px] font-bold px-2 py-0.5 rounded bg-emerald-100 text-emerald-700 mr-1">✅ 確定</span>'
      : '<span class="text-[10px] font-bold px-2 py-0.5 rounded bg-gray-100 text-gray-500 mr-1">📅 定期</span>';
    container.innerHTML += `
      <div class="flex flex-wrap justify-between items-center gap-2 border-b last:border-0 pb-3 last:pb-0">
        <div>
          ${badge}
          <span class="text-xs font-bold px-2 py-0.5 rounded bg-blue-100 text-blue-800 mr-1">${s.time || '時間未定'}</span>
          <strong class="text-sm text-gray-900">${s.name}</strong>
          ${s.hasDelivery ? '<span class="text-xs ml-1" title="納品">📦</span>' : ''}
          ${s.hasPickup ? '<span class="text-xs" title="引取">🔄</span>' : ''}
          ${s.memo ? `<span class="text-xs text-blue-500 ml-1">📝 ${s.memo}</span>` : ''}
          <span class="block text-xs text-gray-400 mt-0.5">🚚 ${v ? v.name : '車両未定'}${drv ? ' ／ 👤 ' + drv.name : ''}</span>
        </div>
        <button onclick="openDeliveryModal('${escQ(s.name)}','${todayStr}')" class="bg-slate-800 text-white text-xs px-3 py-2 rounded-md font-bold hover:bg-slate-900 transition">
          ${hasRecord ? '📝 記録を編集' : '📸 記録する'}
        </button>
      </div>`;
  });
}

function escQ(s) { return String(s).replace(/'/g, "\\'"); }

// ════════════════════════════════════════════════════════
//  ③ 本日の運行計画（チェック）
// ════════════════════════════════════════════════════════
function renderTodayDispatchBuilder() {
  renderAlerts();
  const mainCont = document.getElementById('today-dispatch-selector');
  const othersCont = document.getElementById('today-dispatch-selector-others-list');
  mainCont.innerHTML = ''; othersCont.innerHTML = '';

  const isHol = holidays[todayStr] !== undefined;
  let mainItems = [], otherItems = [];

  db.companies.forEach(c => {
    const override = dispatchCache.get(`${todayStr}|${c.name}`);
    const matchesToday = patternMatchesDate(c.pattern, todayObj, isHol);
    const isIrregular = (c.pattern || '').includes('不定期');
    const vehicleId = (override && override.vehicle_id) || c.default_vehicle_id || '';
    const time = (override && override.time) || c.default_time || '';
    const driverId = (override && override.driver_id) || autoDriverFor(vehicleId, todayObj) || '';
    let isChecked, label;
    if (override) { isChecked = override.status === 'go'; label = `📅 本日の設定 (${override.status === 'go' ? 'GO' : 'SKIP'})`; }
    else if (matchesToday) { isChecked = true; label = `パターン: ${c.pattern}`; }
    else if (isIrregular) { isChecked = false; label = `パターン: ${c.pattern}`; }
    else { isChecked = false; label = `パターン: ${c.pattern}`; }

    const item = { fid: 'C_' + c.id, companyId: c.id, name: c.name, time, vehicleId, driverId, isChecked, label };
    if (matchesToday || isIrregular || override) mainItems.push(item);
    else otherItems.push(item);
  });

  const vOpts = (selId) => {
    let o = '<option value="">-- 車両選択 --</option>';
    db.vehicles.forEach(v => { o += `<option value="${v.id}" ${String(v.id) === String(selId) ? 'selected' : ''}>${v.name}</option>`; });
    return o;
  };
  const dOpts = (selId) => {
    let o = '<option value="">-- ドライバー --</option>';
    db.drivers.forEach(d => { o += `<option value="${d.id}" ${String(d.id) === String(selId) ? 'selected' : ''}>${d.name}</option>`; });
    return o;
  };
  const rowHtml = (item) => `
    <div class="flex flex-wrap items-center justify-between p-2.5 border rounded-md gap-2 bg-gray-50/50">
      <label class="flex items-center gap-2 font-bold text-sm text-gray-900 cursor-pointer select-none min-w-[160px]">
        <input type="checkbox" id="chk-${item.fid}" data-company-id="${item.companyId}" data-name="${item.name}" ${item.isChecked ? 'checked' : ''} class="w-4 h-4 text-blue-600 rounded">
        <div><span>${item.name}</span><span class="block text-[10px] text-gray-400 font-normal">${item.label}</span></div>
      </label>
      <div class="flex items-center gap-2 flex-1 justify-end flex-wrap">
        <input type="time" id="time-${item.fid}" value="${item.time || ''}" class="border p-1.5 rounded text-xs bg-white w-24">
        <select id="vec-${item.fid}" class="border p-1.5 rounded text-xs bg-white max-w-[120px]">${vOpts(item.vehicleId)}</select>
        <select id="drv-${item.fid}" class="border p-1.5 rounded text-xs bg-white max-w-[120px]">${dOpts(item.driverId)}</select>
      </div>
    </div>`;

  mainCont.innerHTML = mainItems.length ? mainItems.map(rowHtml).join('') : '<p class="text-xs text-center py-3 text-gray-400">本日の運行予定はありません。</p>';
  othersCont.innerHTML = otherItems.length ? otherItems.map(rowHtml).join('') : '<p class="text-xs text-gray-400">他の曜日のマスタはありません。</p>';

  renderFinalList();
}

function toggleOtherCompanies() {
  const c = document.getElementById('today-dispatch-selector-others');
  const b = document.getElementById('btn-toggle-others');
  if (c.classList.contains('hidden')) { c.classList.remove('hidden'); b.textContent = '－ 隠す'; }
  else { c.classList.add('hidden'); b.textContent = '＋ 他の曜日の取引先も表示'; }
}

async function saveTodayDispatch() {
  const cbs = document.querySelectorAll('#today-dispatch-selector input[type="checkbox"], #today-dispatch-selector-others-list input[type="checkbox"]');
  if (!cbs.length) return;
  updateStatus('loading', '本日の運行計画を保存中...');
  const rows = [...cbs].map(chk => {
    const fid = chk.id.replace('chk-', '');
    const companyId = chk.getAttribute('data-company-id') || null;
    const name = chk.getAttribute('data-name');
    return {
      date: todayStr,
      company_id: companyId,
      company_name: name,
      status: chk.checked ? 'go' : 'skip',
      time: document.getElementById(`time-${fid}`).value || null,
      vehicle_id: document.getElementById(`vec-${fid}`).value || null,
      driver_id: document.getElementById(`drv-${fid}`).value || null,
      is_spot: false,
    };
  });
  const { error } = await sb.from('dispatch_days').upsert(rows, { onConflict: 'date,company_name' });
  if (error) { updateStatus('error', '保存に失敗: ' + error.message); return; }
  document.getElementById('today-dispatch-selector-others').classList.add('hidden');
  document.getElementById('btn-toggle-others').textContent = '＋ 他の曜日の取引先も表示';
  await loadDispatchAndRecordsForMonth(currentYear, currentMonth);
  buildConfirmedVtabs(); renderTodayDispatchBuilder();
  updateStatus('success', '本日の運行日程を更新しました');
}

// ════════════════════════════════════════════════════════
//  カレンダー
// ════════════════════════════════════════════════════════
function buildCalVtabs() {
  const bar = document.getElementById('cal-vtab-bar');
  bar.innerHTML = '';
  const btnAll = document.createElement('button');
  btnAll.className = `vtab ${calVehicleFilter === 'all' ? 'active' : ''}`;
  btnAll.textContent = 'すべて';
  btnAll.onclick = () => { calVehicleFilter = 'all'; buildCalVtabs(); renderCalendar(); };
  bar.appendChild(btnAll);
  db.vehicles.forEach(v => {
    const btn = document.createElement('button');
    btn.className = `vtab ${calVehicleFilter === v.id ? 'active' : ''}`;
    btn.textContent = v.name;
    btn.onclick = () => { calVehicleFilter = v.id; buildCalVtabs(); renderCalendar(); };
    bar.appendChild(btn);
  });
  const cSel = document.getElementById('cal-company-filter');
  const current = cSel.value;
  cSel.innerHTML = '<option value="">すべての会社</option>';
  db.companies.slice().sort((a, b) => a.name.localeCompare(b.name, 'ja')).forEach(c => {
    cSel.innerHTML += `<option value="${c.name}" ${c.name === current ? 'selected' : ''}>${c.name}</option>`;
  });
  calCompanyFilter = cSel.value;
}

async function changeMonth(diff) {
  currentMonth += diff;
  if (currentMonth > 12) { currentYear++; currentMonth = 1; }
  if (currentMonth < 1) { currentYear--; currentMonth = 12; }
  updateStatus('loading', `${currentYear}年${currentMonth}月のデータを取得中...`);
  await loadDispatchAndRecordsForMonth(currentYear, currentMonth);
  renderCalendar();
  updateStatus('success', '取得完了');
}

function renderCalendar() {
  document.getElementById('calendar-month-title').innerText = `${currentYear}年 ${currentMonth}月`;
  buildCalVtabs();
  const grid = document.getElementById('calendar-grid');
  grid.innerHTML = '';
  const firstDay = new Date(currentYear, currentMonth - 1, 1).getDay();
  const lastDate = new Date(currentYear, currentMonth, 0).getDate();

  for (let i = 0; i < firstDay; i++) grid.innerHTML += '<div class="h-16 bg-gray-50/50 rounded"></div>';

  for (let date = 1; date <= lastDate; date++) {
    const dObj = new Date(currentYear, currentMonth - 1, date);
    const fd = fmtDate(dObj);
    const dow = dObj.getDay();
    const isHol = holidays[fd] !== undefined;
    const isToday = fd === todayStr;

    let companies = getScheduledCompaniesForDate(dObj);
    if (calVehicleFilter !== 'all') companies = companies.filter(c => String(c.vehicleId) === String(calVehicleFilter));
    if (calCompanyFilter) companies = companies.filter(c => c.name === calCompanyFilter);

    const confirmedCount = companies.filter(c => c.confirmed).length;
    const totalCount = companies.length;

    let bgCls = 'bg-white', numCls = 'text-gray-700', borderCls = 'border-gray-100';
    if (isToday) { bgCls = 'bg-orange-500'; numCls = 'text-white'; borderCls = 'border-orange-400'; }
    else if (isHol || dow === 0) { bgCls = 'bg-red-50'; numCls = 'text-red-400'; }
    else if (dow === 6) { bgCls = 'bg-sky-50'; numCls = 'text-sky-500'; }

    const isFiltered = calCompanyFilter || calVehicleFilter !== 'all';
    let cellBody = '';
    if (totalCount === 0) {
      cellBody = '<span class="text-[9px] text-gray-200">-</span>';
    } else if (isFiltered) {
      const nameList = companies.slice(0, 3).map(c => {
        const col = getVehicleColor(c.vehicleId);
        if (isToday) return `<span class="text-[9px] leading-tight text-white truncate w-full text-center block">${c.name}</span>`;
        return `<span class="text-[9px] leading-tight truncate w-full text-center block rounded px-0.5" style="background:${col.bg};color:${col.text}">${c.name}</span>`;
      }).join('');
      const more = companies.length > 3 ? `<span class="text-[8px] ${isToday ? 'text-orange-100' : 'text-gray-400'}">+${companies.length - 3}</span>` : '';
      cellBody = `<div class="w-full flex flex-col items-center gap-0.5">${nameList}${more}</div>`;
    } else {
      const dotHtml = `<div class="flex gap-0.5 justify-center flex-wrap">${companies.slice(0, 5).map(c => {
        const col = getVehicleColor(c.vehicleId);
        const dotColor = isToday ? (c.confirmed ? '#fff' : 'rgba(255,255,255,0.4)') : (c.confirmed ? col.dot : '#d1d5db');
        return `<span class="w-1.5 h-1.5 rounded-full inline-block" style="background:${dotColor}"></span>`;
      }).join('')}</div>`;
      const countBadge = `<span class="text-[9px] ${isToday ? 'text-orange-100' : 'text-gray-400'}">${confirmedCount}/${totalCount}</span>`;
      cellBody = dotHtml + countBadge;
    }

    grid.innerHTML += `
      <button onclick="showCalendarDetail(${date})"
        class="h-16 ${bgCls} border ${borderCls} rounded p-1 flex flex-col items-center justify-between hover:opacity-80 transition w-full overflow-hidden">
        <span class="text-xs font-bold ${numCls}">${date}</span>
        ${cellBody}
      </button>`;
  }
}

let calendarDetailDate = '';

function showCalendarDetail(date) {
  const detail = document.getElementById('calendar-detail');
  const fd = `${currentYear}-${String(currentMonth).padStart(2, '0')}-${String(date).padStart(2, '0')}`;
  calendarDetailDate = fd;
  document.getElementById('calendar-detail-date').innerText = `${fd} の運行予定・実績`;
  detail.classList.remove('hidden');

  const dObj = parseDate(fd);
  let companies = getScheduledCompaniesForDate(dObj);
  if (calVehicleFilter !== 'all') companies = companies.filter(c => String(c.vehicleId) === String(calVehicleFilter));
  if (calCompanyFilter) companies = companies.filter(c => c.name === calCompanyFilter);

  const list = document.getElementById('calendar-detail-list');
  list.innerHTML = '';
  if (companies.length === 0) { list.innerHTML = '<p class="text-xs text-gray-400 text-center py-3">この日の運行予定はありません。</p>'; return; }

  // 車両ごとにグループ化して表示（どの車がどこを回るか一目でわかるように）
  const groups = [];
  companies.forEach(c => {
    const vid = c.vehicleId || '__none__';
    let g = groups.find(g => g.vehicleId === vid);
    if (!g) { g = { vehicleId: vid, items: [] }; groups.push(g); }
    g.items.push(c);
  });
  groups.forEach(g => g.items.sort((a, b) => (a.time || '').localeCompare(b.time || '')));

  groups.forEach(group => {
    const gv = db.vehicles.find(x => String(x.id) === String(group.vehicleId));
    const col = getVehicleColor(group.vehicleId === '__none__' ? null : group.vehicleId);
    list.innerHTML += `
      <div class="flex items-center gap-2 mt-3 first:mt-0">
        <div class="text-xs font-bold px-2.5 py-1 rounded shrink-0" style="background:${col.bg};color:${col.text}">🚛 ${gv ? gv.name : '車両未定'}</div>
        <div class="flex-1 h-px bg-gray-200"></div>
      </div>`;

    group.items.forEach(c => {
      const badge = c.confirmed
        ? '<span class="text-[10px] font-bold px-2 py-0.5 rounded bg-emerald-100 text-emerald-700">✅ 確定</span>'
        : '<span class="text-[10px] font-bold px-2 py-0.5 rounded bg-gray-100 text-gray-500">📅 定期</span>';
      const typeBadge = c.type === 'spot' ? '<span class="text-[10px] font-bold px-2 py-0.5 rounded bg-purple-100 text-purple-700">スポット</span>' : '';
      const kindBadges = `${c.hasDelivery ? '<span class="text-[10px]" title="納品">📦</span>' : ''}${c.hasPickup ? '<span class="text-[10px]" title="引取">🔄</span>' : ''}`;

      const rec = recordsByDate.get(fd) && recordsByDate.get(fd).get(c.name);
      const hasRecord = !!rec;

      const drvOpts = '<option value="">-- ドライバー --</option>' + db.drivers.map(d => `<option value="${d.id}" ${String(d.id) === String(c.driverId) ? 'selected' : ''}>${d.name}</option>`).join('');
      const calDrvId = 'cal-drv-' + fd + '-' + c.name.replace(/[^a-zA-Z0-9]/g, '');

      list.innerHTML += `
        <div class="flex items-center gap-1.5 p-2.5 rounded overflow-x-auto ml-2" style="background:${col.bg}33">
          ${badge}${typeBadge}${kindBadges}
          <span class="font-bold text-gray-800 text-xs shrink-0">${c.name}</span>
          ${c.memo ? `<span class="text-[10px] text-blue-500 shrink-0">📝${c.memo}</span>` : ''}
          <select id="${calDrvId}" onchange="updateCalendarDriver('${fd}','${escQ(c.name)}','${c.companyId || ''}','${c.vehicleId || ''}',this.value)" class="w-24 border p-1 rounded text-[11px] bg-white shrink-0">${drvOpts}</select>
          <span class="text-[10px] text-gray-400 shrink-0">${hasRecord ? '📝記録あり' : '未記録'}</span>
          <button onclick="openDeliveryModal('${escQ(c.name)}','${fd}')" class="ml-auto text-[10px] font-bold px-2 py-1 rounded ${hasRecord ? 'bg-indigo-50 text-indigo-700 border border-indigo-200' : 'bg-slate-800 text-white'} whitespace-nowrap shrink-0">
            ${hasRecord ? '📋 記録を見る/編集' : '📸 記録する'}
          </button>
        </div>`;
    });
  });
}

async function updateCalendarDriver(fd, companyName, companyId, vehicleId, driverId) {
  updateStatus('loading', 'ドライバーを変更中...');
  const { error } = await sb.from('dispatch_days').upsert({
    date: fd, company_id: companyId || null, company_name: companyName,
    status: 'go', vehicle_id: vehicleId || null, driver_id: driverId || null,
  }, { onConflict: 'date,company_name' });
  if (error) { updateStatus('error', '変更に失敗: ' + error.message); return; }
  await loadDispatchAndRecordsForMonth(currentYear, currentMonth);
  renderCalendar();
  const d = parseDate(fd);
  if (d.getMonth() + 1 === currentMonth && d.getFullYear() === currentYear) showCalendarDetail(d.getDate());
  updateStatus('success', 'ドライバーを変更しました');
}

// ════════════════════════════════════════════════════════
//  便追加モーダル（複数日付・納品/引取の種別・メモに対応）
// ════════════════════════════════════════════════════════
let asState = {
  selectedDates: new Set(),
  hasDelivery: true,
  hasPickup: false,
  year: todayObj.getFullYear(),
  month: todayObj.getMonth() + 1,
};

function openAddScheduleModal(presetDate) {
  asState.selectedDates = new Set();
  asState.hasDelivery = true;
  asState.hasPickup = false;
  asState.year = currentYear || todayObj.getFullYear();
  asState.month = currentMonth || todayObj.getMonth() + 1;
  if (presetDate) {
    asState.selectedDates.add(presetDate);
    const d = parseDate(presetDate);
    asState.year = d.getFullYear();
    asState.month = d.getMonth() + 1;
  }

  const dl = document.getElementById('as-name-list');
  dl.innerHTML = db.companies.map(c => `<option value="${c.name}">`).join('');
  const vSel = document.getElementById('as-vehicle');
  vSel.innerHTML = '<option value="">-- 選択 --</option>' + db.vehicles.map(v => `<option value="${v.id}">${v.name}</option>`).join('');
  const dSel = document.getElementById('as-driver');
  dSel.innerHTML = '<option value="">-- 自動 --</option>' + db.drivers.map(d => `<option value="${d.id}">${d.name}</option>`).join('');
  document.getElementById('as-name').value = '';
  document.getElementById('as-time').value = '';
  document.getElementById('as-memo').value = '';

  updateAsTypeButtons();
  renderAsDateGrid();
  renderAsSelectedDates();
  document.getElementById('add-schedule-modal').classList.remove('hidden');
}
function openAddScheduleModalFromDetail() {
  const fd = calendarDetailDate || document.getElementById('calendar-detail-date').innerText.split(' ')[0];
  openAddScheduleModal(fd);
}
function closeAddScheduleModal() { document.getElementById('add-schedule-modal').classList.add('hidden'); }

function toggleAsType(type) {
  if (type === 'delivery') asState.hasDelivery = !asState.hasDelivery;
  if (type === 'pickup') asState.hasPickup = !asState.hasPickup;
  updateAsTypeButtons();
}
function updateAsTypeButtons() {
  const dBtn = document.getElementById('as-btn-delivery');
  const pBtn = document.getElementById('as-btn-pickup');
  dBtn.className = `flex-1 py-2.5 rounded-md border-2 text-sm font-bold transition ${asState.hasDelivery ? 'border-blue-500 bg-blue-50 text-blue-700' : 'border-gray-200 text-gray-400'}`;
  pBtn.className = `flex-1 py-2.5 rounded-md border-2 text-sm font-bold transition ${asState.hasPickup ? 'border-green-500 bg-green-50 text-green-700' : 'border-gray-200 text-gray-400'}`;
}

function changeAsMonth(diff) {
  asState.month += diff;
  if (asState.month > 12) { asState.year++; asState.month = 1; }
  if (asState.month < 1) { asState.year--; asState.month = 12; }
  renderAsDateGrid();
}
function renderAsDateGrid() {
  document.getElementById('as-month-label').textContent = `${asState.year}年${asState.month}月`;
  const grid = document.getElementById('as-date-grid');
  grid.innerHTML = '';
  const firstDay = new Date(asState.year, asState.month - 1, 1).getDay();
  const lastDate = new Date(asState.year, asState.month, 0).getDate();
  for (let i = 0; i < firstDay; i++) grid.innerHTML += '<div></div>';
  for (let d = 1; d <= lastDate; d++) {
    const fd = `${asState.year}-${String(asState.month).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    const selected = asState.selectedDates.has(fd);
    const dow = new Date(asState.year, asState.month - 1, d).getDay();
    const isHol = holidays[fd] !== undefined;
    const textCls = (dow === 0 || isHol) ? 'text-red-400' : dow === 6 ? 'text-blue-400' : 'text-gray-700';
    grid.innerHTML += `<button type="button" onclick="toggleAsDate('${fd}')" class="h-8 rounded text-xs font-medium transition ${selected ? 'bg-slate-800 text-white' : `${textCls} hover:bg-gray-100`}">${d}</button>`;
  }
}
function toggleAsDate(fd) {
  if (asState.selectedDates.has(fd)) asState.selectedDates.delete(fd);
  else asState.selectedDates.add(fd);
  renderAsDateGrid();
  renderAsSelectedDates();
}
function renderAsSelectedDates() {
  const el = document.getElementById('as-selected-dates');
  el.innerHTML = [...asState.selectedDates].sort().map(fd => `
    <span class="inline-flex items-center gap-1 px-2 py-0.5 bg-blue-50 text-blue-700 rounded text-xs border border-blue-200">
      ${fd.slice(5).replace('-', '/')}
      <button type="button" onclick="toggleAsDate('${fd}')" class="text-blue-400 hover:text-red-500 font-bold">×</button>
    </span>`).join('');
}

function onAsNameChange() {
  const name = document.getElementById('as-name').value.trim();
  const master = db.companies.find(c => c.name === name);
  if (master && master.default_vehicle_id) {
    document.getElementById('as-vehicle').value = master.default_vehicle_id;
    onAsVehicleChange();
  }
  if (master && master.default_time && !document.getElementById('as-time').value) {
    document.getElementById('as-time').value = master.default_time;
  }
}
function onAsVehicleChange() {
  const vid = document.getElementById('as-vehicle').value;
  const dSel = document.getElementById('as-driver');
  if (dSel.value) return; // すでに選択済みなら変更しない
  const autoDriver = db.drivers.find(d => String(d.vehicle_id) === String(vid));
  if (autoDriver) dSel.value = autoDriver.id;
}

async function submitAddSchedule() {
  const name = document.getElementById('as-name').value.trim();
  if (!name) { alert('取引先名を入力してください'); return; }
  if (asState.selectedDates.size === 0) { alert('日付を1つ以上選択してください'); return; }

  const time = document.getElementById('as-time').value || null;
  const vehicleId = document.getElementById('as-vehicle').value || null;
  const driverId = document.getElementById('as-driver').value || null;
  const memo = document.getElementById('as-memo').value || null;
  const existing = db.companies.find(c => c.name === name);
  const dates = [...asState.selectedDates].sort();

  const rows = dates.map(date => ({
    date, company_id: existing ? existing.id : null, company_name: name,
    status: 'go', time, vehicle_id: vehicleId, driver_id: driverId,
    is_spot: !existing, has_delivery: asState.hasDelivery, has_pickup: asState.hasPickup, note: memo,
  }));

  closeAddScheduleModal();
  updateStatus('loading', `${dates.length}件の便を追加中...`);
  const { error } = await sb.from('dispatch_days').upsert(rows, { onConflict: 'date,company_name' });
  if (error) { updateStatus('error', '追加に失敗: ' + error.message); return; }

  const lastDate = parseDate(dates[dates.length - 1]);
  if (lastDate.getFullYear() !== currentYear || lastDate.getMonth() + 1 !== currentMonth) {
    currentYear = lastDate.getFullYear(); currentMonth = lastDate.getMonth() + 1;
  }
  await loadDispatchAndRecordsForMonth(currentYear, currentMonth);
  buildConfirmedVtabs(); renderTodayDispatchBuilder(); renderCalendar();
  if (activeTab === 'calendar') showCalendarDetail(lastDate.getDate());
  updateStatus('success', `${dates.length}件の便を追加しました`);
}

// ════════════════════════════════════════════════════════
//  エクセル一括登録（指定テンプレートに転記されたエクセルを取り込み）
// ════════════════════════════════════════════════════════
let excelImportState = { rows: [] };

function openExcelImportModal() {
  excelImportState = { rows: [] };
  document.getElementById('excel-import-file-input').value = '';
  document.getElementById('excel-import-error').classList.add('hidden');
  document.getElementById('as-name-list').innerHTML = db.companies.map(c => `<option value="${c.name}">`).join('');
  showExcelImportStep('upload');
  document.getElementById('excel-import-modal').classList.remove('hidden');
}
function closeExcelImportModal() {
  document.getElementById('excel-import-modal').classList.add('hidden');
}
function showExcelImportStep(step) {
  document.getElementById('excel-import-step-upload').classList.toggle('hidden', step !== 'upload');
  document.getElementById('excel-import-step-loading').classList.toggle('hidden', step !== 'loading');
  document.getElementById('excel-import-step-review').classList.toggle('hidden', step !== 'review');
}

// Excelの日付セル（Dateオブジェクト）や、テキストで入力された日付文字列を
// "YYYY-MM-DD" に正規化する。読み取れない場合は空文字を返す（呼び出し側で要確認フラグにする）。
function excelCellToYMD(v) {
  if (v instanceof Date && !isNaN(v)) {
    // SheetJSはExcelのシリアル日付をUTC基準のDateとして返すため、UTC側のgetterで取り出す
    // （ローカルタイムゾーンで取り出すと前後の日付にずれることがある）
    const y = v.getUTCFullYear();
    const m = String(v.getUTCMonth() + 1).padStart(2, '0');
    const d = String(v.getUTCDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  const s = String(v ?? '').trim();
  if (!s) return '';
  const m = s.match(/^(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})$/);
  if (m) return `${m[1]}-${String(m[2]).padStart(2, '0')}-${String(m[3]).padStart(2, '0')}`;
  return '';
}

async function handleExcelImportFileSelect(event) {
  const file = event.target.files && event.target.files[0];
  if (!file) return;
  const errEl = document.getElementById('excel-import-error');
  errEl.classList.add('hidden');

  if (!window.XLSX) {
    errEl.textContent = 'エクセル読み込み機能の準備中にエラーが発生しました。ページを再読み込みしてからもう一度お試しください。';
    errEl.classList.remove('hidden');
    return;
  }

  showExcelImportStep('loading');
  try {
    const buf = await file.arrayBuffer();
    const wb = XLSX.read(buf, { type: 'array', cellDates: true });
    const sheet = wb.Sheets[wb.SheetNames[0]];
    const json = XLSX.utils.sheet_to_json(sheet, { defval: '' });

    excelImportState.rows = json
      .map(row => {
        const date = excelCellToYMD(row['日付']);
        const company_name = String(row['取引先名'] ?? '').trim();
        const has_delivery = String(row['納品'] ?? '').trim() === '○';
        const has_pickup = String(row['引取'] ?? '').trim() === '○';
        const note = String(row['メモ'] ?? '').trim();
        const missing = !date || !company_name;
        return {
          include: true, date: date || '', company_name, has_delivery, has_pickup, note,
          confidence: missing ? 'low' : 'high',
          flag_reason: !date ? '日付を確認してください' : (!company_name ? '取引先名を確認してください' : ''),
        };
      })
      // 完全に空の行（例のすぐ下の空行など）は無視する
      .filter(r => r.date || r.company_name || r.note || r.has_delivery || r.has_pickup);

    if (excelImportState.rows.length === 0) {
      errEl.textContent = '読み込める行が見つかりませんでした。テンプレートの形式で入力されているかご確認ください。';
      errEl.classList.remove('hidden');
      showExcelImportStep('upload');
      return;
    }

    renderExcelImportRows();
    showExcelImportStep('review');
  } catch (err) {
    errEl.textContent = 'エクセルの読み込みに失敗しました。テンプレートをもとに作成したファイルかご確認ください。';
    errEl.classList.remove('hidden');
    showExcelImportStep('upload');
  }
}

function renderExcelImportRows() {
  const tbody = document.getElementById('excel-import-rows');
  tbody.innerHTML = excelImportState.rows.map((r, i) => `
    <tr class="${r.confidence === 'low' ? 'bg-yellow-50' : ''} border-t">
      <td class="text-center align-top pt-2"><input type="checkbox" class="w-4 h-4" ${r.include ? 'checked' : ''} onchange="excelImportState.rows[${i}].include=this.checked"></td>
      <td class="align-top pt-1 px-1">
        <input type="date" value="${r.date}" class="border rounded p-1 text-xs w-full" onchange="excelImportState.rows[${i}].date=this.value">
        ${r.confidence === 'low' ? `<div class="text-[10px] text-amber-600 mt-0.5">⚠️ ${r.flag_reason || '要確認'}</div>` : ''}
      </td>
      <td class="align-top pt-1 px-1">
        <input type="text" value="${(r.company_name || '').replace(/"/g, '&quot;')}" list="as-name-list" class="border rounded p-1 text-xs w-full" onchange="excelImportState.rows[${i}].company_name=this.value">
      </td>
      <td class="align-top pt-1 px-1">
        <div class="flex gap-1">
          <button type="button" onclick="toggleExcelImportType(${i},'has_delivery')" class="px-1.5 py-1 rounded border text-[11px] font-bold ${r.has_delivery ? 'border-blue-500 bg-blue-50 text-blue-700' : 'border-gray-200 text-gray-300'}">📦納品</button>
          <button type="button" onclick="toggleExcelImportType(${i},'has_pickup')" class="px-1.5 py-1 rounded border text-[11px] font-bold ${r.has_pickup ? 'border-green-500 bg-green-50 text-green-700' : 'border-gray-200 text-gray-300'}">🔄引取</button>
        </div>
      </td>
      <td class="align-top pt-1 px-1">
        <input type="text" value="${(r.note || '').replace(/"/g, '&quot;')}" class="border rounded p-1 text-xs w-full" onchange="excelImportState.rows[${i}].note=this.value">
      </td>
    </tr>
  `).join('');
}
function toggleExcelImportType(i, field) {
  excelImportState.rows[i][field] = !excelImportState.rows[i][field];
  renderExcelImportRows();
}

async function submitExcelImport() {
  const targetRows = excelImportState.rows.filter(r => r.include);
  if (targetRows.length === 0) { alert('反映する行を1つ以上チェックしてください'); return; }
  const invalid = targetRows.find(r => !r.date || !r.company_name);
  if (invalid) { alert('日付または取引先名が空の行があります。確認してください。'); return; }

  const rows = targetRows.map(r => {
    const existing = db.companies.find(c => c.name === r.company_name);
    return {
      date: r.date, company_id: existing ? existing.id : null, company_name: r.company_name,
      status: 'go', vehicle_id: existing ? existing.default_vehicle_id || null : null, driver_id: null,
      is_spot: !existing, has_delivery: r.has_delivery, has_pickup: r.has_pickup, note: r.note || null,
    };
  });

  closeExcelImportModal();
  updateStatus('loading', `${rows.length}件をカレンダーに反映中...`);
  const { error } = await sb.from('dispatch_days').upsert(rows, { onConflict: 'date,company_name' });
  if (error) { updateStatus('error', '反映に失敗: ' + error.message); return; }

  // 複数の日付・取引先にまたがる場合があるため、一番遅い日付の月をカレンダーに表示する
  const lastDate = rows.map(r => parseDate(r.date)).sort((a, b) => a - b).pop();
  currentYear = lastDate.getFullYear(); currentMonth = lastDate.getMonth() + 1;
  await loadDispatchAndRecordsForMonth(currentYear, currentMonth);
  buildConfirmedVtabs(); renderTodayDispatchBuilder(); renderCalendar();
  if (activeTab === 'calendar') showCalendarDetail(lastDate.getDate());
  updateStatus('success', `${rows.length}件をカレンダーに反映しました`);
}

// ════════════════════════════════════════════════════════
//  実績一覧（新規）
// ════════════════════════════════════════════════════════
async function loadRecordsView() {
  const from = document.getElementById('rec-from').value;
  const to = document.getElementById('rec-to').value;
  const companyFilter = document.getElementById('rec-company').value;
  const vehicleFilter = document.getElementById('rec-vehicle').value;
  const missingOnly = document.getElementById('rec-missing-only').checked;
  if (!from || !to) return;

  const dOpts = '<option value="">すべて</option>' + db.companies.map(c => `<option value="${c.name}">${c.name}</option>`).join('');
  document.getElementById('rec-company').innerHTML = dOpts;
  document.getElementById('rec-company').value = companyFilter;
  const vOpts = '<option value="">すべて</option>' + db.vehicles.map(v => `<option value="${v.id}">${v.name}</option>`).join('');
  document.getElementById('rec-vehicle').innerHTML = vOpts;
  document.getElementById('rec-vehicle').value = vehicleFilter;

  updateStatus('loading', '実績を集計中...');
  const [{ data: recs }] = await Promise.all([
    sb.from('delivery_records').select('*').gte('date', from).lte('date', to),
  ]);
  const recMap = new Map();
  (recs || []).forEach(r => recMap.set(`${r.date}|${r.company_name}`, r));

  // 期間中のdispatch_daysを取得（本日/カレンダー用の共有キャッシュとは別のローカルMapに入れる。
  // ここでグローバルの dispatchCache/dispatchByDate を書き換えると、他のタブに戻ったときの
  // 表示が実績一覧の期間のデータのままズレてしまうため、必ず分離しています。）
  const localDispatchCache = new Map();
  const localDispatchByDate = new Map();
  const { data: dispatchRowsInRange } = await sb.from('dispatch_days').select('*').gte('date', from).lte('date', to);
  (dispatchRowsInRange || []).forEach(row => {
    localDispatchCache.set(`${row.date}|${row.company_name}`, row);
    if (!localDispatchByDate.has(row.date)) localDispatchByDate.set(row.date, []);
    localDispatchByDate.get(row.date).push(row);
  });

  const rows = [];
  let cur = parseDate(from);
  const end = parseDate(to);
  let guard = 0;
  while (cur <= end && guard < 400) {
    guard++;
    const fd = fmtDate(cur);
    let scheduled = getScheduledCompaniesForDate(cur, localDispatchCache, localDispatchByDate).filter(c => c.confirmed || c.type === 'regular');
    if (companyFilter) scheduled = scheduled.filter(c => c.name === companyFilter);
    if (vehicleFilter) scheduled = scheduled.filter(c => String(c.vehicleId) === String(vehicleFilter));
    scheduled.forEach(c => {
      const rec = recMap.get(`${fd}|${c.name}`);
      rows.push({ date: fd, company: c.name, vehicleId: c.vehicleId, rec });
    });
    cur = new Date(cur.getFullYear(), cur.getMonth(), cur.getDate() + 1);
  }
  const filteredRows = missingOnly ? rows.filter(r => !r.rec) : rows;
  filteredRows.sort((a, b) => b.date.localeCompare(a.date) || a.company.localeCompare(b.company, 'ja'));

  const missingCount = rows.filter(r => !r.rec).length;
  document.getElementById('records-summary').innerText = `対象 ${rows.length} 件中、未記録 ${missingCount} 件`;

  const list = document.getElementById('records-list');
  if (filteredRows.length === 0) { list.innerHTML = '<p class="text-sm text-gray-400 text-center py-6">該当するデータがありません。</p>'; updateStatus('success', '集計完了'); return; }
  list.innerHTML = filteredRows.map(r => {
    const v = db.vehicles.find(x => String(x.id) === String(r.vehicleId));
    if (r.rec) {
      return `<div class="flex items-center gap-2 p-3 bg-white rounded-md border border-gray-200 text-xs">
        <span class="font-mono text-gray-400 shrink-0">${r.date}</span>
        <strong class="text-gray-900">${r.company}</strong>
        <span class="text-gray-400 shrink-0">🚛${v ? v.name : '未定'}</span>
        <span class="ml-auto text-emerald-700 bg-emerald-50 px-2 py-1 rounded font-bold shrink-0">記録済み</span>
        <button onclick="openRecordViewer(${JSON.stringify(r.rec).replace(/"/g, '&quot;')})" class="text-indigo-600 font-bold shrink-0">見る</button>
      </div>`;
    }
    return `<div class="flex items-center gap-2 p-3 rounded-md border missing-row text-xs">
      <span class="font-mono text-gray-400 shrink-0">${r.date}</span>
      <strong class="text-gray-900">${r.company}</strong>
      <span class="text-gray-400 shrink-0">🚛${v ? v.name : '未定'}</span>
      <span class="ml-auto text-red-600 font-bold shrink-0">未記録</span>
      <button onclick="openDeliveryModal('${escQ(r.company)}','${r.date}')" class="bg-slate-800 text-white px-2 py-1 rounded font-bold shrink-0">記録する</button>
    </div>`;
  }).join('');
  updateStatus('success', '集計完了');
}

// ════════════════════════════════════════════════════════
//  写真・配送実績モーダル
// ════════════════════════════════════════════════════════
const photoState = { nouhin: [], hikitori: [] };
const MAX_PHOTOS = 5;
let deliveryTargetDate = '';
let deliveryTargetCompany = '';

function renderPhotoGrid(type) {
  const grid = document.getElementById(`${type}-photo-grid`);
  const counter = document.getElementById(`${type}-count`);
  const photos = photoState[type];
  grid.innerHTML = '';
  counter.textContent = `${photos.length} / ${MAX_PHOTOS}`;
  photos.forEach((p, idx) => {
    const thumb = document.createElement('div');
    thumb.className = 'photo-thumb';
    thumb.innerHTML = `<img src="${p.dataUrl}" onclick="openLightbox('${p.dataUrl}')" style="cursor:zoom-in"><button class="del-btn" onclick="removePhoto('${type}',${idx})">✕</button>`;
    grid.appendChild(thumb);
  });
  if (photos.length < MAX_PHOTOS) {
    // カメラ撮影ボタン（スマホでその場で撮影）
    const cam = document.createElement('div');
    cam.className = 'photo-add-btn';
    cam.innerHTML = `<span class="icon">📷</span><span>カメラ</span>`;
    cam.onclick = () => {
      const inp = document.getElementById(`${type}-file-input`);
      inp.setAttribute('capture', 'environment');
      inp.removeAttribute('multiple');
      inp.click();
      inp.setAttribute('multiple', '');
    };
    grid.appendChild(cam);
    // ギャラリーから選択ボタン（複数選択可）
    const file = document.createElement('div');
    file.className = 'photo-add-btn';
    file.innerHTML = `<span class="icon">🖼️</span><span>選択</span>`;
    file.onclick = () => {
      const inp = document.getElementById(`${type}-file-input`);
      inp.removeAttribute('capture');
      inp.setAttribute('multiple', '');
      inp.click();
    };
    grid.appendChild(file);
  }
}
function handlePhotoSelect(type, event) {
  const files = Array.from(event.target.files);
  const remaining = MAX_PHOTOS - photoState[type].length;
  files.slice(0, remaining).forEach(file => {
    const reader = new FileReader();
    reader.onload = e => { photoState[type].push({ dataUrl: e.target.result, file }); renderPhotoGrid(type); };
    reader.readAsDataURL(file);
  });
  event.target.value = '';
}
function removePhoto(type, idx) { photoState[type].splice(idx, 1); renderPhotoGrid(type); }
function openLightbox(src) { document.getElementById('lightbox-img').src = src; document.getElementById('photo-lightbox').classList.remove('hidden'); }
function closeLightbox() { document.getElementById('photo-lightbox').classList.add('hidden'); }

async function uploadToCloudinary(photos, dateStr) {
  const urls = [];
  for (const p of photos) {
    const formData = new FormData();
    formData.append('file', p.file);
    formData.append('upload_preset', CLOUDINARY_PRESET);
    formData.append('folder', `vehicle_records/${dateStr}`);
    const r = await fetch(CLOUDINARY_URL, { method: 'POST', body: formData });
    const d = await r.json();
    if (d.secure_url) urls.push(d.secure_url);
    else throw new Error('アップロード失敗: ' + (d.error?.message || 'unknown'));
  }
  return urls;
}

let deliveryExistingRecord = null; // 開いているモーダルの既存レコード（月をまたぐ日付でもキャッシュに頼らず正確に取得する）

async function openDeliveryModal(companyName, dateStr) {
  const targetDate = dateStr || todayStr;
  deliveryTargetCompany = companyName;
  deliveryTargetDate = targetDate;
  deliveryExistingRecord = null;
  document.getElementById('delivery-modal-title').innerText = `📦 ${companyName}`;
  document.getElementById('delivery-modal-date').innerText = deliveryTargetDate;
  const savedBy = document.getElementById('delivery-saved-by');
  savedBy.innerHTML = '<option value="">-- 選択 --</option>' + db.drivers.map(d => `<option value="${d.name}">${d.name}</option>`).join('');

  photoState.nouhin = []; photoState.hikitori = [];
  document.getElementById('nouhin-memo').value = '';
  document.getElementById('hikitori-memo').value = '';
  savedBy.value = '';
  renderPhotoGrid('nouhin'); renderPhotoGrid('hikitori');
  document.getElementById('delivery-modal').classList.remove('hidden');

  // 対象日付・取引先の既存レコードを直接取得（表示中の月キャッシュに依存しない）
  const { data: existing } = await sb.from('delivery_records').select('*')
    .eq('date', targetDate).eq('company_name', companyName).maybeSingle();
  if (deliveryTargetCompany !== companyName || deliveryTargetDate !== targetDate) return; // モーダルが切り替わっていたら反映しない
  deliveryExistingRecord = existing || null;
  if (existing) {
    document.getElementById('nouhin-memo').value = existing.nouhin_memo || '';
    document.getElementById('hikitori-memo').value = existing.hikitori_memo || '';
    savedBy.value = existing.saved_by || '';
  }
}
function closeDeliveryModal() { document.getElementById('delivery-modal').classList.add('hidden'); }

async function submitDeliveryReport() {
  const nouhinMemo = document.getElementById('nouhin-memo').value;
  const hikitoriMemo = document.getElementById('hikitori-memo').value;
  const savedBy = document.getElementById('delivery-saved-by').value;
  const btn = document.querySelector('#delivery-modal button[onclick="submitDeliveryReport()"]');
  if (btn) { btn.disabled = true; btn.textContent = '送信中...'; }
  updateStatus('loading', '配送実績を送信中...');

  let nouhinUrls = deliveryExistingRecord ? (deliveryExistingRecord.nouhin_photo_urls || []) : [];
  let hikitoriUrls = deliveryExistingRecord ? (deliveryExistingRecord.hikitori_photo_urls || []) : [];

  try {
    if (photoState.nouhin.length) {
      updateStatus('loading', `納品写真をアップロード中... (${photoState.nouhin.length}枚)`);
      nouhinUrls = nouhinUrls.concat(await uploadToCloudinary(photoState.nouhin, deliveryTargetDate));
    }
    if (photoState.hikitori.length) {
      updateStatus('loading', `引取写真をアップロード中... (${photoState.hikitori.length}枚)`);
      hikitoriUrls = hikitoriUrls.concat(await uploadToCloudinary(photoState.hikitori, deliveryTargetDate));
    }
  } catch (e) {
    updateStatus('error', '写真アップロードに失敗: ' + e.message);
    if (btn) { btn.disabled = false; btn.textContent = '💾 保存する'; }
    return;
  }

  updateStatus('loading', '保存中...');
  const { error } = await sb.from('delivery_records').upsert({
    date: deliveryTargetDate, company_name: deliveryTargetCompany,
    nouhin_memo: nouhinMemo, hikitori_memo: hikitoriMemo,
    nouhin_photo_urls: nouhinUrls, hikitori_photo_urls: hikitoriUrls,
    saved_by: savedBy || null,
  }, { onConflict: 'date,company_name' });

  if (btn) { btn.disabled = false; btn.textContent = '💾 保存する'; }
  if (error) { updateStatus('error', '保存に失敗: ' + error.message); return; }

  closeDeliveryModal();
  updateStatus('success', '配送実績の報告完了');
  const d = parseDate(deliveryTargetDate);
  if (d.getFullYear() === currentYear && d.getMonth() + 1 === currentMonth) await loadRecordsRange(...Object.values(monthRange(currentYear, currentMonth)));
  if (deliveryTargetDate === todayStr) renderFinalList();
  if (activeTab === 'calendar') showCalendarDetail(d.getDate());
  if (activeTab === 'records') loadRecordsView();
}

function openRecordViewer(rec) {
  document.getElementById('rv-title').innerText = `📋 ${rec.company_name}`;
  document.getElementById('rv-date').innerText = rec.date;
  document.getElementById('rv-nouhin-memo').innerText = rec.nouhin_memo || '（なし）';
  document.getElementById('rv-hikitori-memo').innerText = rec.hikitori_memo || '（なし）';

  const npGrid = document.getElementById('rv-nouhin-photos');
  npGrid.innerHTML = (rec.nouhin_photo_urls || []).length === 0
    ? '<p class="text-xs text-gray-300">写真なし</p>'
    : rec.nouhin_photo_urls.map(url => `<img src="${url}" onclick="openLightbox('${url}')" class="w-20 h-20 object-cover rounded border border-gray-200 cursor-zoom-in hover:opacity-80">`).join('');

  const hpGrid = document.getElementById('rv-hikitori-photos');
  hpGrid.innerHTML = (rec.hikitori_photo_urls || []).length === 0
    ? '<p class="text-xs text-gray-300">写真なし</p>'
    : rec.hikitori_photo_urls.map(url => `<img src="${url}" onclick="openLightbox('${url}')" class="w-20 h-20 object-cover rounded border border-gray-200 cursor-zoom-in hover:opacity-80">`).join('');

  document.getElementById('record-viewer-modal').classList.remove('hidden');
}
function closeRecordViewer() { document.getElementById('record-viewer-modal').classList.add('hidden'); }

// ════════════════════════════════════════════════════════
//  ドライバー管理
// ════════════════════════════════════════════════════════
function renderDrivers() {
  const list = document.getElementById('drivers-list');
  list.innerHTML = '';
  if (db.drivers.length === 0) { list.innerHTML = '<p class="text-sm text-gray-400 col-span-2 text-center py-8">ドライバーが登録されていません</p>'; return; }
  db.drivers.forEach(d => {
    const dayBadges = DOW_KEY.map((key, i) => d[key] ? `<span class="inline-block px-1.5 py-0.5 rounded text-[10px] font-medium bg-blue-50 text-blue-700">${DOW_JP[i]}</span>` : '').join('');
    const veh = db.vehicles.find(v => String(v.id) === String(d.vehicle_id));
    list.innerHTML += `
      <div class="bg-white p-4 rounded-md border border-gray-200">
        <div class="flex justify-between items-start">
          <div class="flex-1 min-w-0">
            <p class="font-bold text-gray-900">👤 ${d.name}</p>
            ${veh ? `<p class="text-xs text-blue-600 mt-0.5">🚛 ${veh.name}</p>` : '<p class="text-xs text-gray-300 mt-0.5">車両未設定</p>'}
            <div class="flex gap-1 mt-1 flex-wrap">${dayBadges || '<p class="text-xs text-gray-300">曜日未設定</p>'}</div>
            ${d.note ? `<p class="text-xs text-gray-400 mt-1">${d.note}</p>` : ''}
          </div>
          <div class="flex gap-3 text-xs">
            <button onclick="openDriverModal(${JSON.stringify(d).replace(/"/g, '&quot;')})" class="text-blue-600 hover:underline">修正</button>
            <button onclick="deleteRow('drivers','${d.id}')" class="text-red-500 hover:underline">削除</button>
          </div>
        </div>
      </div>`;
  });
}

function openDriverModal(data = null) {
  document.getElementById('driver-modal').classList.remove('hidden');
  DOW_KEY.forEach(key => { document.getElementById('d-' + key).checked = false; });
  const vSel = document.getElementById('d-vehicle');
  vSel.innerHTML = '<option value="">-- 選択 --</option>' + db.vehicles.map(v => `<option value="${v.id}">${v.name}</option>`).join('');
  if (data) {
    document.getElementById('d-id').value = data.id;
    document.getElementById('d-name').value = data.name;
    document.getElementById('d-note').value = data.note || '';
    document.getElementById('d-vehicle').value = data.vehicle_id || '';
    DOW_KEY.forEach(key => { if (data[key]) document.getElementById('d-' + key).checked = true; });
  } else {
    document.getElementById('d-id').value = crypto.randomUUID();
    document.getElementById('d-name').value = '';
    document.getElementById('d-note').value = '';
    document.getElementById('d-vehicle').value = '';
  }
}
function closeDriverModal() { document.getElementById('driver-modal').classList.add('hidden'); }
async function submitDriver() {
  const id = document.getElementById('d-id').value;
  const name = document.getElementById('d-name').value.trim();
  if (!name) { alert('名前を入力してください'); return; }
  const row = { id, name, note: document.getElementById('d-note').value, vehicle_id: document.getElementById('d-vehicle').value || null };
  DOW_KEY.forEach(key => { row[key] = document.getElementById('d-' + key).checked; });
  await upsertRow('drivers', row);
  closeDriverModal();
}

// ════════════════════════════════════════════════════════
//  取引先マスタ
// ════════════════════════════════════════════════════════
function renderCompanies() {
  const regEl = document.getElementById('companies-regular');
  const irrEl = document.getElementById('companies-irregular');
  const regular = db.companies.filter(c => !(c.pattern || '').includes('不定期'));
  const irregular = db.companies.filter(c => (c.pattern || '').includes('不定期'));

  const cardHtml = (c) => `
    <div class="bg-white p-3 rounded-md border border-gray-200 text-xs space-y-1">
      <div class="flex justify-between items-start gap-1">
        <h4 class="font-bold text-gray-900 text-sm leading-tight">${c.name}</h4>
        <button onclick="openCompanyModal(${JSON.stringify(c).replace(/"/g, '&quot;')})" class="text-blue-500 hover:underline shrink-0">修正</button>
      </div>
      <span class="inline-block px-2 py-0.5 rounded bg-gray-100 text-gray-600 font-medium">${c.pattern || '未設定'}</span>
      ${(() => { const dv = db.vehicles.find(v => String(v.id) === String(c.default_vehicle_id)); return dv ? `<p class="text-xs text-blue-600">🚛 ${dv.name}</p>` : ''; })()}
      ${c.default_time ? `<p class="text-gray-500">⏰ ${c.default_time}</p>` : ''}
      ${c.note ? `<p class="text-gray-400 bg-yellow-50 px-2 py-1 rounded border border-yellow-100">💡 ${c.note}</p>` : ''}
      <div class="text-right pt-1"><button onclick="deleteRow('companies','${c.id}')" class="text-red-400 hover:underline text-[10px]">削除</button></div>
    </div>`;

  regEl.innerHTML = regular.length ? regular.map(cardHtml).join('') : '<p class="text-xs text-gray-400 text-center py-4">なし</p>';
  irrEl.innerHTML = irregular.length ? irregular.map(cardHtml).join('') : '<p class="text-xs text-gray-400 text-center py-4">なし</p>';
}

function openCompanyModal(data = null) {
  document.getElementById('company-modal').classList.remove('hidden');
  const cVSel = document.getElementById('c-vehicle');
  cVSel.innerHTML = '<option value="">-- 選択 --</option>' + db.vehicles.map(v => `<option value="${v.id}">${v.name}</option>`).join('');
  if (data) {
    document.getElementById('company-modal-title').innerText = '取引先の修正';
    document.getElementById('c-id').value = data.id;
    document.getElementById('c-name').value = data.name;
    document.getElementById('c-time').value = data.default_time || '';
    document.getElementById('c-pattern').value = data.pattern || '毎営業日';
    document.getElementById('c-note').value = data.note || '';
    document.getElementById('c-vehicle').value = data.default_vehicle_id || '';
  } else {
    document.getElementById('company-modal-title').innerText = '取引先の新規登録';
    document.getElementById('c-id').value = crypto.randomUUID();
    document.getElementById('c-name').value = '';
    document.getElementById('c-time').value = '';
    document.getElementById('c-pattern').value = '毎営業日';
    document.getElementById('c-note').value = '';
    document.getElementById('c-vehicle').value = '';
  }
}
function closeCompanyModal() { document.getElementById('company-modal').classList.add('hidden'); }
async function submitCompany() {
  const id = document.getElementById('c-id').value;
  const name = document.getElementById('c-name').value.trim();
  if (!name) { alert('会社名を入力してください'); return; }
  await upsertRow('companies', {
    id, name,
    default_time: document.getElementById('c-time').value || null,
    default_vehicle_id: document.getElementById('c-vehicle').value || null,
    pattern: document.getElementById('c-pattern').value,
    note: document.getElementById('c-note').value,
  });
  closeCompanyModal();
}

// ════════════════════════════════════════════════════════
//  車両管理
// ════════════════════════════════════════════════════════
function renderVehicles() {
  const list = document.getElementById('vehicles-list');
  list.innerHTML = db.vehicles.map(v => `
    <div class="bg-white p-4 rounded-md border border-gray-200 flex flex-col justify-between text-sm">
      <div><h4 class="font-bold text-gray-900">${v.name}</h4><p class="text-xs text-gray-400">${v.type || '車種未指定'}</p>
        <div class="mt-2 space-y-0.5 text-xs text-gray-600"><p>🛠 車検満了: ${v.shaken_date || '未登録'}</p><p>📄 任意保険: ${v.insurance_date || '未登録'}</p></div>
      </div>
      <div class="flex justify-end gap-3 mt-3 pt-2 border-t border-gray-50 text-xs">
        <button onclick="openVehicleModal(${JSON.stringify(v).replace(/"/g, '&quot;')})" class="text-blue-600 hover:underline">修正</button>
        <button onclick="deleteRow('vehicles','${v.id}')" class="text-red-500 hover:underline">削除</button>
      </div>
    </div>`).join('');
}
function openVehicleModal(data = null) {
  document.getElementById('vehicle-modal').classList.remove('hidden');
  if (data) {
    document.getElementById('v-id').value = data.id;
    document.getElementById('v-name').value = data.name;
    document.getElementById('v-type').value = data.type || '';
    document.getElementById('v-shaken').value = data.shaken_date || '';
    document.getElementById('v-insurance').value = data.insurance_date || '';
    document.getElementById('v-note').value = data.note || '';
  } else {
    document.getElementById('v-id').value = crypto.randomUUID();
    document.getElementById('v-name').value = '';
    document.getElementById('v-type').value = '';
    document.getElementById('v-shaken').value = '';
    document.getElementById('v-insurance').value = '';
    document.getElementById('v-note').value = '';
  }
}
function closeVehicleModal() { document.getElementById('vehicle-modal').classList.add('hidden'); }
async function submitVehicle() {
  const id = document.getElementById('v-id').value;
  await upsertRow('vehicles', {
    id, name: document.getElementById('v-name').value,
    type: document.getElementById('v-type').value,
    shaken_date: document.getElementById('v-shaken').value || null,
    insurance_date: document.getElementById('v-insurance').value || null,
    note: document.getElementById('v-note').value,
  });
  closeVehicleModal();
}

// ════════════════════════════════════════════════════════
//  月次点検（1車両×1年月＝1行、JSONBでまとめて保存）
// ════════════════════════════════════════════════════════
const CHECK_ITEMS = [
  {category:'運転席',key:'seat_1',label:'ブレーキ・ペダルの踏みしろ、効き具合'},
  {category:'運転席',key:'seat_2',label:'駐車ブレーキ・レバーの引きしろ'},
  {category:'運転席',key:'seat_3',label:'エンジンのかかり具合、異音'},
  {category:'運転席',key:'seat_4',label:'ワイパーの拭き取り状態、洗浄液の噴射'},
  {category:'運転席',key:'seat_5',label:'各種メーター、警告灯の作動状態'},
  {category:'エンジンルーム',key:'eng_1',label:'エンジンオイルの量・汚れ'},
  {category:'エンジンルーム',key:'eng_2',label:'冷却水の量'},
  {category:'エンジンルーム',key:'eng_3',label:'バッテリー液の量、ターミナルの緩み'},
  {category:'エンジンルーム',key:'eng_4',label:'ブレーキ液の量'},
  {category:'エンジンルーム',key:'eng_5',label:'ファンベルトの張り・損傷'},
  {category:'車両周り',key:'ext_1',label:'ランプ類（ヘッドライト、ウインカー、テール）の点灯・汚れ・損傷'},
  {category:'車両周り',key:'ext_2',label:'タイヤの空気圧、亀裂、異常な摩耗'},
  {category:'車両周り',key:'ext_3',label:'タイヤの溝の深さ'},
  {category:'車両周り',key:'ext_4',label:'ホイールナット・ボルトの緩み'},
  {category:'車両周り',key:'ext_5',label:'水漏れ、油漏れの有無（車両下部）'},
  {category:'車両周り',key:'ext_6',label:'バックミラーの方向・汚れ・損傷'},
  {category:'安全用具',key:'safe_1',label:'消火器の設置、有効期限'},
  {category:'安全用具',key:'safe_2',label:'停止表示板（三角停止板）の点検'},
  {category:'安全用具',key:'safe_3',label:'発炎筒の有効期限'},
  {category:'安全用具',key:'safe_4',label:'車載工具、ジャッキの確認'},
  {category:'適切な時期に実施',key:'time_1',label:'エアクリーナーエレメントの清掃・交換'},
  {category:'適切な時期に実施',key:'time_2',label:'デファレンシャルギヤオイルの漏れ'},
  {category:'適切な時期に実施',key:'time_3',label:'トランスミッションオイルの漏れ'},
  {category:'適切な時期に実施',key:'time_4',label:'ステアリングギヤボックスの油漏れ'},
  {category:'適切な時期に実施',key:'time_5',label:'プロペラシャフト、ドライブシャフトの連結部の緩み'},
  {category:'適切な時期に実施',key:'time_6',label:'排気ガスの状態（色、臭い）'}
];

function updateDropdowns() {
  const s = document.getElementById('check-vehicle');
  s.innerHTML = db.vehicles.map(v => `<option value="${v.id}">${v.name}</option>`).join('');
}
function initCheckFormSelectors() {
  const y = document.getElementById('check-year'), m = document.getElementById('check-month');
  y.innerHTML = ''; m.innerHTML = '';
  for (let yr = currentYear - 1; yr <= currentYear + 1; yr++) y.innerHTML += `<option value="${yr}" ${yr === currentYear ? 'selected' : ''}>${yr}年</option>`;
  for (let mo = 1; mo <= 12; mo++) m.innerHTML += `<option value="${mo}" ${mo === currentMonth ? 'selected' : ''}>${mo}月</option>`;
}
function renderCheckForm() {
  const c = document.getElementById('check-form-container');
  const cats = [...new Set(CHECK_ITEMS.map(i => i.category))];
  c.innerHTML = cats.map(cat => {
    const rows = CHECK_ITEMS.filter(i => i.category === cat).map(item => `
      <div class="flex flex-col sm:flex-row sm:items-center justify-between py-1.5 border-b border-gray-50 text-sm">
        <span class="text-gray-700">${item.label}</span>
        <div class="flex gap-1">
          <button onclick="setMark('${item.key}','○')" id="mark-${item.key}-○" class="w-9 h-7 rounded border text-xs font-bold bg-white text-gray-400">○</button>
          <button onclick="setMark('${item.key}','△')" id="mark-${item.key}-△" class="w-9 h-7 rounded border text-xs font-bold bg-white text-gray-400">△</button>
          <button onclick="setMark('${item.key}','×')" id="mark-${item.key}-×" class="w-9 h-7 rounded border text-xs font-bold bg-white text-gray-400">×</button>
        </div></div>`).join('');
    return `<div class="space-y-2"><h3 class="text-xs font-bold text-gray-400 bg-gray-100 px-2 py-1 rounded">${cat}</h3>${rows}</div>`;
  }).join('');
}
let currentMarks = {};
function setMark(key, val) {
  currentMarks[key] = val;
  ['○', '△', '×'].forEach(v => { const b = document.getElementById(`mark-${key}-${v}`); if (b) b.className = 'w-9 h-7 rounded border text-xs font-bold bg-white text-gray-400 border-gray-200'; });
  const b = document.getElementById(`mark-${key}-${val}`);
  if (b) {
    if (val === '○') b.className = 'w-9 h-7 rounded text-xs font-bold bg-green-600 text-white';
    if (val === '△') b.className = 'w-9 h-7 rounded text-xs font-bold bg-yellow-500 text-white';
    if (val === '×') b.className = 'w-9 h-7 rounded text-xs font-bold bg-red-600 text-white';
  }
}
async function loadCheckData() {
  const vId = document.getElementById('check-vehicle').value;
  const year = document.getElementById('check-year').value;
  const month = document.getElementById('check-month').value;
  currentMarks = {};
  CHECK_ITEMS.forEach(item => { ['○', '△', '×'].forEach(v => { const b = document.getElementById(`mark-${item.key}-${v}`); if (b) b.className = 'w-9 h-7 rounded border text-xs font-bold bg-white text-gray-400 border-gray-200'; }); });
  document.getElementById('check-note').value = '';
  document.getElementById('check-inspector').value = '';
  if (!vId) return;
  const { data } = await sb.from('checks').select('*').eq('vehicle_id', vId).eq('year', year).eq('month', month).maybeSingle();
  if (data) {
    currentMarks = data.items || {};
    Object.entries(currentMarks).forEach(([key, val]) => setMark(key, val));
    document.getElementById('check-note').value = data.note || '';
    document.getElementById('check-inspector').value = data.inspector || '';
  }
}
async function saveCheckData() {
  const vId = document.getElementById('check-vehicle').value;
  if (!vId) { alert('車両を選択してください'); return; }
  updateStatus('loading', '点検データを保存中...');
  const { error } = await sb.from('checks').upsert({
    vehicle_id: vId,
    year: Number(document.getElementById('check-year').value),
    month: Number(document.getElementById('check-month').value),
    items: currentMarks,
    note: document.getElementById('check-note').value,
    inspector: document.getElementById('check-inspector').value,
    saved_at: new Date().toISOString(),
  }, { onConflict: 'vehicle_id,year,month' });
  if (error) { updateStatus('error', '保存に失敗: ' + error.message); return; }
  updateStatus('success', '点検結果を保存しました');
}

// ════════════════════════════════════════════════════════
//  通信共通
// ════════════════════════════════════════════════════════
// vehicles/drivers/companiesはテーブル名=db上のキー名なので、そのまま楽観的更新に使う。
async function upsertRow(table, row) {
  updateStatus('loading', '送信中...');
  // 先にローカルのdbを更新して画面に即反映し、体感速度を上げる。
  if (db[table]) {
    const idx = db[table].findIndex(x => String(x.id) === String(row.id));
    if (idx >= 0) db[table][idx] = { ...db[table][idx], ...row };
    else db[table].push(row);
    updateDropdowns();
    refreshAllViews();
  }
  const { error } = await sb.from(table).upsert(row);
  if (error) {
    updateStatus('error', '保存に失敗: ' + error.message);
    await loadMasters(); updateDropdowns(); refreshAllViews(); // ロールバック
    return;
  }
  updateStatus('success', '保存しました');
}
async function deleteRow(table, id) {
  if (!confirm('削除しますか？')) return;
  updateStatus('loading', '削除中...');
  const backup = db[table] ? [...db[table]] : null;
  if (db[table]) {
    db[table] = db[table].filter(x => String(x.id) !== String(id));
    updateDropdowns();
    refreshAllViews();
  }
  const { error } = await sb.from(table).delete().eq('id', id);
  if (error) {
    updateStatus('error', '削除に失敗: ' + error.message);
    if (backup) db[table] = backup;
    updateDropdowns(); refreshAllViews(); // ロールバック
    return;
  }
  updateStatus('success', '削除しました');
}

let toastTimer = null;
function updateStatus(type, text) {
  const toast = document.getElementById('toast');
  const dot = document.getElementById('toast-dot');
  const txt = document.getElementById('status-text');
  if (!toast) return;
  txt.innerText = text;
  if (type === 'loading') {
    toast.className = 'fixed bottom-6 left-1/2 z-[100] flex items-center gap-2 px-4 py-2.5 rounded shadow-lg text-sm font-medium bg-yellow-50 text-yellow-800 border border-yellow-200';
    dot.className = 'w-2.5 h-2.5 rounded-full shrink-0 bg-yellow-500 animate-pulse';
  } else if (type === 'success') {
    toast.className = 'fixed bottom-6 left-1/2 z-[100] flex items-center gap-2 px-4 py-2.5 rounded shadow-lg text-sm font-medium bg-green-50 text-green-800 border border-green-200';
    dot.className = 'w-2.5 h-2.5 rounded-full shrink-0 bg-green-500';
  } else {
    toast.className = 'fixed bottom-6 left-1/2 z-[100] flex items-center gap-2 px-4 py-2.5 rounded shadow-lg text-sm font-medium bg-red-50 text-red-800 border border-red-200';
    dot.className = 'w-2.5 h-2.5 rounded-full shrink-0 bg-red-500';
  }
  toast.style.opacity = '1';
  toast.style.transform = 'translate(-50%, 0)';
  toast.style.pointerEvents = 'none';
  if (toastTimer) clearTimeout(toastTimer);
  if (type !== 'loading') {
    toastTimer = setTimeout(() => { toast.style.opacity = '0'; toast.style.transform = 'translate(-50%, 16px)'; }, 3000);
  }
}

// 初期状態のセッションチェック（onAuthStateChangeが初回にも発火するが念のため）
sb.auth.getSession().then(({ data: { session } }) => {
  if (session) { document.getElementById('view-login').classList.add('hidden'); document.getElementById('app').classList.remove('hidden'); boot(); }
});
