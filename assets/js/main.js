/* ================================================================
   ADMIN SIPALARUS - SISTEM PASPOR HILANG DAN RUSAK
   Seksi Intelijen dan Penindakan Keimigrasian (INTELDAKIM)
   Kantor Imigrasi Kelas I TPI Tanjungpinang
   ================================================================ */

'use strict';

// ── Constants & Configuration ────────────────────────────────────
const SHEET_URL = 'https://script.google.com/macros/s/AKfycbzLX7lj0FfKp807R4hsOf5D9Q6Bn3T9oeEV7C8PVAaEZtd2HZin8HQt0eYGxe90EcSX/exec';
const SESSION_KEY = 'baper_session_v4';
const STATUS_KEY = 'baper_status_v4';
const THEME_KEY = 'baper_theme_v4';
const AUDIT_KEY = 'baper_audit_v4';
const SOUND_KEY = 'baper_sound_v4';
const HOLIDAY_KEY = 'baper_holiday_v4';
const SCHEDULE_KEY = 'baper_schedule_v4';

const SESSION_HOURS = 6; // sama dengan masa berlaku token di server (6 jam)
const MAX_ATTEMPTS = 5;
const LOCKOUT_SECS = 60;
const REFRESH_SECS = 30;
const PAGE_SIZE = 12;

const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'];
const MONTH_FULL = ['Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni', 'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember'];
const DAYS_ID = ['Minggu', 'Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat', 'Sabtu'];

// ── Application State ────────────────────────────────────────────
let allData = [];
let localStatus = {};
let auditLogs = [];
let selectedRowKeys = new Set();
let docRotations = {};

// State Jadwal & Hari Libur
let holidaySettings = {};
let scheduleSettings = {};
let selectedScheduleDate = '';
let calCurrentYear = 2026;
let calCurrentMonth = 9; // 0-indexed: Oktober 2026
let scheduleSettingsLoaded = false;
let bulkSelectedDates = new Set();

let currentPage = 1;
let currentRow = null;
let pendingDelKey = null;

let rsFilter = 'all';
let dashFilter = 'all';
let activeMonth = 'all';
let activeYear = '';

let arCountdown = REFRESH_SECS;
let tokenAttempts = MAX_ATTEMPTS;
let lockoutTimer = null;
let autoRefInt = null;
let confirmResolve = null;

let isSoundEnabled = true;
let cpSelectedIndex = 0;
let cpCurrentResults = [];
let currentLightboxRotation = 0;

// ── Core Helpers ─────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const $$ = sel => document.querySelectorAll(sel);

function escKey(k) {
  return (k || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

function escHtml(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ── Audio Feedback (Procedural Web Audio API) ────────────────────
function playTone(freq = 587.33, type = 'sine', duration = 0.12) {
  if (!isSoundEnabled) return;
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, ctx.currentTime);
    gain.gain.setValueAtTime(0.04, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + duration);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + duration);
  } catch {
    // Ignore audio context autoplay restrictions
  }
}

function playSuccessChime() {
  playTone(523.25, 'sine', 0.08);
  setTimeout(() => playTone(659.25, 'sine', 0.12), 70);
}

function playAlertChime() {
  playTone(392.00, 'triangle', 0.1);
  setTimeout(() => playTone(329.63, 'triangle', 0.14), 80);
}

function initSound() {
  const saved = localStorage.getItem(SOUND_KEY);
  isSoundEnabled = saved !== 'false';
  updateSoundIcon();
}

function toggleSound() {
  isSoundEnabled = !isSoundEnabled;
  localStorage.setItem(SOUND_KEY, String(isSoundEnabled));
  updateSoundIcon();
  if (isSoundEnabled) playSuccessChime();
  showToast('info', isSoundEnabled ? 'Efek audio diaktifkan' : 'Efek audio dimatikan');
}

function updateSoundIcon() {
  const el = $('soundIcon');
  if (el) el.textContent = isSoundEnabled ? 'Audio: On' : 'Audio: Off';
}

// ── Audit Log System ─────────────────────────────────────────────
function loadAuditLogs() {
  try {
    auditLogs = JSON.parse(localStorage.getItem(AUDIT_KEY) || '[]');
  } catch {
    auditLogs = [];
  }
}

function logActivity(action, details) {
  const session = getSession();
  const officer = session ? session.displayName : 'Petugas';
  const entry = {
    id: Date.now(),
    officer,
    action,
    details,
    time: new Date().toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
    date: (() => { const n = new Date(); return `${n.getDate()} ${MONTH_SHORT[n.getMonth()]}`; })()
  };
  auditLogs.unshift(entry);
  if (auditLogs.length > 80) auditLogs.pop();
  try {
    localStorage.setItem(AUDIT_KEY, JSON.stringify(auditLogs));
  } catch {
    // Storage quota fallback
  }
}

function openAuditModal() {
  renderAuditLogs();
  $('auditLogModal').classList.add('show');
  document.body.style.overflow = 'hidden';
}

function closeAuditModal() {
  $('auditLogModal').classList.remove('show');
  document.body.style.overflow = '';
}

function clearAuditLog() {
  auditLogs = [];
  localStorage.removeItem(AUDIT_KEY);
  renderAuditLogs();
  showToast('info', 'Riwayat aktivitas telah dibersihkan');
}

function renderAuditLogs() {
  const container = $('auditLogList');
  if (!container) return;
  if (!auditLogs.length) {
    container.innerHTML = '<div class="audit-empty">Belum ada catatan aktivitas pada sesi ini.</div>';
    return;
  }
  container.innerHTML = auditLogs.map(item => `
    <div class="audit-item">
      <div class="audit-item-top">
        <span class="audit-action-name">${escHtml(item.action)}</span>
        <span class="audit-time">${escHtml(item.date)} ${escHtml(item.time)}</span>
      </div>
      <div class="audit-desc">${escHtml(item.details)} <span style="opacity:0.65;font-size:10px;">(${escHtml(item.officer)})</span></div>
    </div>
  `).join('');
}

// ── Theme Protocol (Dual Mode) ───────────────────────────────────
function initTheme() {
  const saved = localStorage.getItem(THEME_KEY);
  if (saved === 'light') applyTheme('light');
  else applyTheme('dark');
}

function applyTheme(mode) {
  const icon = $('themeIcon');
  if (mode === 'light') {
    document.body.classList.add('light-mode');
    if (icon) icon.textContent = 'Mode: Terang';
    localStorage.setItem(THEME_KEY, 'light');
  } else {
    document.body.classList.remove('light-mode');
    if (icon) icon.textContent = 'Mode: Gelap';
    localStorage.setItem(THEME_KEY, 'dark');
  }
}

function toggleTheme() {
  const isLight = document.body.classList.contains('light-mode');
  applyTheme(isLight ? 'dark' : 'light');
  logActivity('Pengaturan Tema', `Mengubah tema menjadi ${isLight ? 'Gelap' : 'Terang'}`);
}

// ── Online / Connectivity Status ─────────────────────────────────
function initOnlineStatus() {
  function update() {
    const el = $('onlineIndicator');
    if (!el) return;
    if (navigator.onLine) {
      el.className = 'online-status-chip online';
      el.innerHTML = '<span class="osc-dot"></span><span class="osc-text">Online</span>';
    } else {
      el.className = 'online-status-chip offline';
      el.innerHTML = '<span class="osc-dot"></span><span class="osc-text">Offline</span>';
    }
  }
  window.addEventListener('online', () => { update(); showToast('success', 'Koneksi kembali online'); });
  window.addEventListener('offline', () => { update(); showToast('error', 'Koneksi terputus (Offline)'); });
  update();
}

// ── Custom System Confirm Dialog ─────────────────────────────────
function showConfirm({ title = 'Konfirmasi', msg = 'Apakah Anda yakin?', icon = 'PERIKSA',
  okText = 'Ya, Lanjutkan', cancelText = 'Batal' }) {
  return new Promise(resolve => {
    confirmResolve = resolve;
    $('confirmIcon').textContent = icon;
    $('confirmTitle').textContent = title;
    $('confirmMsg').textContent = msg;
    $('confirmOkBtn').textContent = okText;
    $('confirmCancelBtn').textContent = cancelText;
    $('confirmOverlay').classList.add('show');
    document.body.style.overflow = 'hidden';
  });
}

function resolveConfirm(val) {
  $('confirmOverlay').classList.remove('show');
  document.body.style.overflow = '';
  if (confirmResolve) {
    confirmResolve(val);
    confirmResolve = null;
  }
}

// ── Session Management ───────────────────────────────────────────
function saveSession(displayName, username, token) {
  localStorage.setItem(SESSION_KEY, JSON.stringify({ displayName, username, token: token || '', loginTime: Date.now() }));
}

// Sesi lama (sebelum ada token) dianggap tidak valid -> wajib login ulang
function getAdminToken() {
  const s = getSession();
  return s && s.token ? s.token : '';
}

let sessionExpiredShown = false;
function handleSessionExpired() {
  if (sessionExpiredShown) return;
  sessionExpiredShown = true;
  clearSession();
  clearInterval(autoRefInt);
  $('adminShell').style.display = 'none';
  $('loginPage').classList.add('visible');
  showToast('error', 'Sesi berakhir. Silakan login kembali.');
  setTimeout(() => { sessionExpiredShown = false; }, 3000);
}

// POST aman ke Apps Script: otomatis menyertakan token admin
async function apiPost(payload) {
  const res = await fetch(SHEET_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },
    body: JSON.stringify({ ...payload, token: getAdminToken() })
  });
  const json = await res.json();
  if (json && json.needLogin) handleSessionExpired();
  return json;
}

function getSession() {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw);
    if (Date.now() - s.loginTime > SESSION_HOURS * 3600000) {
      clearSession();
      return null;
    }
    return s;
  } catch {
    return null;
  }
}

function clearSession() {
  localStorage.removeItem(SESSION_KEY);
}

function getSessionAge(s) {
  if (!s) return 'Sesi Aktif';
  const m = Math.floor((Date.now() - s.loginTime) / 60000);
  return m < 60 ? `Aktif ${m} mnt` : `Aktif ${Math.floor(m / 60)} jam`;
}

// ── Authentication (Login & Logout) ──────────────────────────────
function togglePw() {
  const inp = $('loginPass');
  const btn = $('pwToggle');
  if (inp.type === 'password') {
    inp.type = 'text';
    btn.textContent = 'Sembunyikan';
  } else {
    inp.type = 'password';
    btn.textContent = 'Lihat';
  }
}

async function doLogin() {
  const u = $('loginUser').value.trim();
  const p = $('loginPass').value.trim();
  const err = $('loginErr');
  const btn = $('loginBtn');

  if (!u || !p) {
    showLoginErr('Username dan kata sandi tidak boleh kosong.');
    playAlertChime();
    return;
  }
  if (tokenAttempts <= 0) return;

  btn.disabled = true;
  btn.innerHTML = '<span>Memverifikasi Kredensial...</span>';
  err.classList.remove('show');

  try {
    const res = await fetch(SHEET_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify({ action: 'adminLogin', username: u, password: p })
    });
    const json = await res.json();

    if (json.ok) {
      const displayName = json.displayName || u;
      saveSession(displayName, u, json.token);
      logActivity('Autentikasi Berhasil', `Petugas ${displayName} berhasil login ke portal.`);
      playSuccessChime();
      bootDashboard(displayName);
    } else {
      tokenAttempts = Math.max(0, tokenAttempts - 1);
      updateAttemptDots();
      playAlertChime();
      showLoginErr(json.error || 'Username atau kata sandi tidak cocok.');
      if (tokenAttempts <= 0) {
        startLockout();
        return;
      }
    }
  } catch {
    playAlertChime();
    showLoginErr('Gagal terhubung ke server. Periksa jaringan internet.');
  }

  btn.disabled = false;
  btn.innerHTML = '<span>Masuk Portal Petugas</span>';
}

function showLoginErr(msg) {
  const err = $('loginErr');
  err.textContent = msg;
  err.classList.remove('show');
  void err.offsetWidth;
  err.classList.add('show');
}

function updateAttemptDots() {
  $$('.attempt-dot').forEach((d, i) => {
    d.className = 'attempt-dot' + (i < (MAX_ATTEMPTS - tokenAttempts) ? ' used' : '');
  });
}

function startLockout() {
  const btn = $('loginBtn');
  const bar = $('lockoutBar');
  const fill = $('lockoutFill');
  const txt = $('lockoutText');
  const uI = $('loginUser');
  const pI = $('loginPass');

  btn.disabled = true;
  btn.innerHTML = '<span>Akses Terkunci Sementara</span>';
  uI.disabled = true;
  pI.disabled = true;
  bar.classList.add('show');
  fill.style.width = '100%';

  let remaining = LOCKOUT_SECS;
  txt.textContent = `Akses terkunci. Silakan tunggu ${remaining} detik...`;

  lockoutTimer = setInterval(() => {
    remaining--;
    fill.style.width = (remaining / LOCKOUT_SECS * 100) + '%';
    txt.textContent = `Akses terkunci. Silakan tunggu ${remaining} detik...`;

    if (remaining <= 0) {
      clearInterval(lockoutTimer);
      tokenAttempts = MAX_ATTEMPTS;
      btn.disabled = false;
      btn.innerHTML = '<span>Masuk Portal Petugas</span>';
      uI.disabled = false;
      pI.disabled = false;
      bar.classList.remove('show');
      $('loginErr').classList.remove('show');
      updateAttemptDots();
    }
  }, 1000);
}

async function doLogout() {
  const ok = await showConfirm({
    title: 'Keluar Portal Petugas',
    msg: 'Apakah Anda yakin ingin mengakhiri sesi kerja saat ini?',
    icon: 'LOGOUT',
    okText: 'Ya, Keluar'
  });
  if (!ok) return;

  logActivity('Sesi Berakhir', 'Petugas keluar dari sistem.');
  const token = getAdminToken();
  if (token) {
    try {
      await fetch(SHEET_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: JSON.stringify({ action: 'adminLogout', token: token })
      });
    } catch (e) {
      // Best-effort remote token revocation
    }
  }

  clearSession();
  clearInterval(autoRefInt);

  $('adminShell').style.display = 'none';
  $('loginPage').classList.add('visible');
  $('loginUser').value = '';
  $('loginPass').value = '';

  tokenAttempts = MAX_ATTEMPTS;
  updateAttemptDots();
  $('loginErr').classList.remove('show');
  showToast('info', 'Sesi kerja telah diakhiri.');
}

function bootDashboard(displayName) {
  const session = getSession();
  $('officerName').textContent = displayName;
  const initialEl = $('officerInitial');
  if (initialEl) initialEl.textContent = (displayName || 'P').charAt(0).toUpperCase();
  if (session) $('sessionExpiry').textContent = getSessionAge(session);

  $('loginPage').classList.remove('visible');
  $('adminShell').style.display = 'block';

  loadLocalStatus();
  loadAuditLogs();
  loadCachedScheduleSettings();
  loadData();
  loadUsers(false, true);
  syncScheduleSettings(false);
  startClock();
  startAutoRefresh();
}

// ── Live Clock & Auto-Refresh System ─────────────────────────────
function startClock() {
  function tick() {
    const now = new Date();
    const cl = $('liveClock');
    const de = $('liveDate');
    if (cl) cl.textContent = now.toLocaleTimeString('id-ID', { hour12: false }) + ' WIB';
    if (de) de.textContent = `${DAYS_ID[now.getDay()]}, ${now.getDate()} ${MONTH_SHORT[now.getMonth()]} ${now.getFullYear()}`;
    const session = getSession();
    const exp = $('sessionExpiry');
    if (exp && session && now.getSeconds() === 0) {
      exp.textContent = getSessionAge(session);
    }
  }
  tick();
  setInterval(tick, 1000);
}

function startAutoRefresh() {
  arCountdown = REFRESH_SECS;
  clearInterval(autoRefInt);

  autoRefInt = setInterval(() => {
    const anyModalOpen =
      $('modalOverlay').classList.contains('show') ||
      $('deleteOverlay').classList.contains('show') ||
      $('lightbox').classList.contains('show') ||
      $('confirmOverlay').classList.contains('show') ||
      $('commandPaletteModal').classList.contains('show') ||
      $('auditLogModal').classList.contains('show') ||
      $('bulkHolidayModal')?.classList.contains('show');

    if (anyModalOpen) return;

    arCountdown--;
    const el = $('arTimer');
    const bar = $('arProgressBar');
    if (el) el.textContent = arCountdown + 's';
    if (bar) bar.style.width = (arCountdown / REFRESH_SECS * 100) + '%';

    if (arCountdown <= 0) {
      loadData(false);
      syncScheduleSettings(false);
      arCountdown = REFRESH_SECS;
    }
  }, 1000);
}

// ── Local Status Cache ───────────────────────────────────────────
function loadLocalStatus() {
  try {
    localStatus = JSON.parse(localStorage.getItem(STATUS_KEY) || '{}');
  } catch {
    localStatus = {};
  }
}

function saveLocalStatus() {
  localStorage.setItem(STATUS_KEY, JSON.stringify(localStatus));
}

function getRowKey(r) {
  return (r.nama || '') + '_' + (r.tanggal || '') + '_' + (r.jam || '') + '_' + (r.hp || '');
}

// ── Data Loading & Synchronization ───────────────────────────────
function normTanggal(v) {
  if (!v) return '';
  const s = String(v);
  if (s.includes('T') || s.match(/^\d{4}-\d{2}-\d{2}/)) return s.slice(0, 10);
  return s;
}

async function loadData(manual = false) {
  const btn = $('refreshBtn');
  if (btn) btn.classList.add('spinning');

  try {
    const res = await fetch(`${SHEET_URL}?action=get&token=${encodeURIComponent(getAdminToken())}`, { cache: 'no-store' });
    const json = await res.json();
    if (json && json.needLogin) { handleSessionExpired(); return; }
    const raw = Array.isArray(json) ? json : (json.data || []);

    allData = raw.map(r => {
      const key = getRowKey(r);
      const sheetSt = r.status && String(r.status).trim() !== '' ? String(r.status).trim() : 'Menunggu';
      const sheetNote = r.note && String(r.note).trim() !== '' ? String(r.note).trim() : '';
      return {
        ...r,
        tanggal: normTanggal(r.tanggal),
        _key: key,
        status: sheetSt,
        note: sheetNote,
        reg: r.no_registrasi || r.reg || '',
        _rowIndex: r._rowIndex || null,
        reschedule_status: r.reschedule_status || '',
        reschedule_tanggal: normTanggal(r.reschedule_tanggal || ''),
        reschedule_jam: r.reschedule_jam || '',
        reschedule_slot_id: r.reschedule_slot_id || '',
        reschedule_alasan: r.reschedule_alasan || '',
        reschedule_count: r.reschedule_count || '0',
        foto_ulang_tanggal: r.foto_ulang_tanggal ? normTanggal(r.foto_ulang_tanggal) : '',
      };
    });

    // Sort newest row first
    allData.sort((a, b) => (parseInt(b._rowIndex) || 0) - (parseInt(a._rowIndex) || 0));

    const lu = $('lastUpdate');
    if (lu) lu.textContent = 'Sinkron: ' + new Date().toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });

    if (manual) {
      playSuccessChime();
      showToast('success', 'Data berhasil disinkronisasi dari lembar kerja');
      logActivity('Sinkronisasi Data', `Memuat ${allData.length} data pendaftar.`);
    }

    startAutoRefresh();
    buildMonthYearOptions();

  } catch (e) {
    console.error('loadData error:', e);
    if (manual) {
      playAlertChime();
      showToast('error', 'Gagal menyinkronkan data dengan server.');
    }
  }

  if (btn) btn.classList.remove('spinning');
  renderAll();
}

// ── Month & Year Filtering Options ───────────────────────────────
function getYearsFromData() {
  const set = new Set();
  allData.forEach(r => {
    const y = (r.tanggal || '').slice(0, 4);
    if (y.match(/^\d{4}$/)) set.add(y);
  });
  return [...set].sort((a, b) => parseInt(b) - parseInt(a));
}

function getMonthsWithData(year) {
  const set = new Set();
  allData.forEach(r => {
    const tgl = r.tanggal || '';
    if (!year || tgl.startsWith(year)) {
      const m = tgl.slice(5, 7);
      if (m.match(/^\d{2}$/)) set.add(m);
    }
  });
  return [...set].sort();
}

function buildMonthYearOptions() {
  const yearSel = $('filterYear');
  if (!yearSel) return;
  const years = getYearsFromData();
  const prevYear = yearSel.value;

  yearSel.innerHTML =
    '<option value="">Semua Tahun</option>' +
    years.map(y => `<option value="${y}">${y}</option>`).join('');

  if (prevYear && years.includes(prevYear)) {
    yearSel.value = prevYear;
  } else {
    yearSel.value = '';
    activeYear = '';
  }

  activeYear = yearSel.value;
  renderMonthChips();
}

function renderMonthChips() {
  const container = $('monthChips');
  if (!container) return;
  const months = getMonthsWithData(activeYear);

  let html = `<button class="month-chip ${activeMonth === 'all' ? 'active' : ''}" onclick="setMonthFilter('all')">Semua Bulan</button>`;
  html += months.map(m => {
    const label = MONTH_SHORT[parseInt(m) - 1];
    return `<button class="month-chip ${activeMonth === m ? 'active' : ''}" onclick="setMonthFilter('${m}')">${label}</button>`;
  }).join('');

  container.innerHTML = html;

  const badge = $('filterActiveBadge');
  const clearBtn = $('filterClearBtn');
  const isActive = activeMonth !== 'all' || activeYear !== '';

  if (isActive) {
    if (badge) badge.style.display = 'inline-flex';
    if (clearBtn) clearBtn.style.display = 'inline-flex';
    let txt = '';
    if (activeMonth !== 'all') txt += MONTH_SHORT[parseInt(activeMonth) - 1];
    if (activeYear) txt += (txt ? ' ' : '') + activeYear;
    const bt = $('filterBadgeText');
    if (bt) bt.textContent = txt;
  } else {
    if (badge) badge.style.display = 'none';
    if (clearBtn) clearBtn.style.display = 'none';
  }
}

function setMonthFilter(m) {
  activeMonth = m;
  renderMonthChips();
  resetPageAndRender();
}

function clearMonthFilter() {
  activeMonth = 'all';
  activeYear = '';
  const ySel = $('filterYear');
  if (ySel) ySel.value = '';
  renderMonthChips();
  resetPageAndRender();
}

function resetPageAndRender() {
  currentPage = 1;
  activeYear = $('filterYear')?.value || '';
  if (activeMonth !== 'all') {
    const available = getMonthsWithData(activeYear);
    if (!available.includes(activeMonth)) activeMonth = 'all';
  }
  renderMonthChips();
  renderTable();
}

// ── Filtered Data Calculation ────────────────────────────────────
function getFiltered() {
  const q = ($('searchInput')?.value || '').toLowerCase().trim();
  const fs = $('filterStatus')?.value || '';
  const fj = $('filterJenis')?.value || '';

  return allData.filter(r => {
    const tgl = r.tanggal || '';
    if (activeYear && !tgl.startsWith(activeYear)) return false;
    if (activeMonth !== 'all' && tgl.slice(5, 7) !== activeMonth) return false;
    const mQ = !q ||
      (r.nama || '').toLowerCase().includes(q) ||
      (r.reg || '').toLowerCase().includes(q) ||
      (r.hp || '').includes(q) ||
      (r.nik || '').includes(q);
    const mS = !fs || r.status === fs;
    const mJ = !fj || r.jenis_permohonan === fj;
    return mQ && mS && mJ;
  });
}

// ── Global Render Coordinator ────────────────────────────────────
function renderAll() {
  renderStats();
  renderTodayAgenda();
  renderDashTable();
  renderTable();
  renderRsTable();
  renderRecap();
  if (typeof refreshUsersView === 'function') refreshUsersView();

  // Navigation Badges
  const waiting = allData.filter(r => r.status === 'Menunggu').length;
  const rsPending = allData.filter(r => r.reschedule_status === 'Pending').length;

  const nb = $('navBadge');
  if (nb) nb.textContent = waiting;

  const rsBadge = $('navRsBadge');
  if (rsBadge) {
    rsBadge.textContent = rsPending;
    rsBadge.style.display = rsPending > 0 ? 'inline-flex' : 'none';
  }
}

// ── Metric Tiles ─────────────────────────────────────────────────
function renderStats() {
  const total = allData.length || 0;
  const wait = allData.filter(r => r.status === 'Menunggu').length;
  const conf = allData.filter(r => r.status === 'Dikonfirmasi').length;
  const done = allData.filter(r => r.status === 'Selesai').length;
  const rs = allData.filter(r => r.reschedule_status === 'Pending').length;

  animateNum('sc-total', total);
  animateNum('sc-wait', wait);
  animateNum('sc-conf', conf);
  animateNum('sc-done', done);
  animateNum('sc-rs', rs);

  if ($('tileWaitRatio')) $('tileWaitRatio').textContent = total ? Math.round(wait / total * 100) + '%' : '0%';
  if ($('tileConfRatio')) $('tileConfRatio').textContent = total ? Math.round(conf / total * 100) + '%' : '0%';
  if ($('tileDoneRatio')) $('tileDoneRatio').textContent = total ? Math.round(done / total * 100) + '%' : '0%';
}

function animateNum(id, target) {
  const el = $(id);
  if (!el) return;
  let cur = parseInt(el.textContent) || 0;
  const diff = Math.abs(target - cur);
  if (diff === 0) { el.textContent = target; return; }
  const step = Math.ceil(diff / 16) || 1;
  const iv = setInterval(() => {
    cur = cur < target ? Math.min(cur + step, target) : Math.max(cur - step, target);
    el.textContent = cur;
    if (cur === target) clearInterval(iv);
  }, 24);
}

function filterFromTile(status) {
  navTo('pendaftar', document.querySelector('[data-page=pendaftar]'));
  const fs = $('filterStatus');
  if (fs) {
    fs.value = status === 'all' ? '' : status;
    resetPageAndRender();
  }
}

// ── Today's Agenda (Live Queue) ──────────────────────────────────
function renderTodayAgenda() {
  const container = $('todayQueueList');
  const sub = $('todayAgendaSubtitle');
  const stripCount = $('stripTodayCount');
  if (!container) return;

  const todayStr = new Date().toISOString().slice(0, 10);
  const todayItems = allData.filter(r => r.tanggal === todayStr);

  if (stripCount) stripCount.textContent = todayItems.length;

  if (!todayItems.length) {
    if (sub) sub.textContent = 'Tidak ada pemohon terjadwal hari ini';
    container.innerHTML = `
      <div class="agenda-empty-state">
        <p>Tidak ada jadwal pemeriksaan BAP untuk hari ini (${formatTgl(todayStr)}).</p>
      </div>`;
    return;
  }

  if (sub) sub.textContent = `${todayItems.length} pemohon terjadwal untuk hari ini`;

  container.innerHTML = todayItems.map(r => `
    <div class="agenda-item-card" onclick="openModal('${escKey(r._key)}')">
      <div class="agenda-item-top">
        <span class="agenda-sesi-pill">${escHtml(r.jam) || 'Sesi Terjadwal'}</span>
        ${badgeHtml(r.status, r.reschedule_status)}
      </div>
      <div class="agenda-item-name">${escHtml(r.nama)}</div>
      <div class="agenda-item-type">${escHtml(r.jenis_permohonan)}</div>
    </div>
  `).join('');
}

// ── Date Formatting Helpers (Zero Em-Dash) ───────────────────────
function formatTgl(tgl) {
  if (!tgl) return 'Belum ada';
  const s = String(tgl).slice(0, 10);
  if (!s.match(/^\d{4}-\d{2}-\d{2}$/)) return s;
  const [y, m, d] = s.split('-');
  return `${parseInt(d)} ${MONTH_SHORT[parseInt(m) - 1]} ${y}`;
}

function formatTglFull(tgl) {
  if (!tgl) return 'Belum ditentukan';
  const s = String(tgl).slice(0, 10);
  if (!s.match(/^\d{4}-\d{2}-\d{2}$/)) return s;
  const [y, m, d] = s.split('-').map(Number);
  const dayName = DAYS_ID[new Date(y, m - 1, d, 12, 0, 0).getDay()];
  return `${dayName}, ${d} ${MONTH_FULL[m - 1]} ${y}`;
}

// ── Status Badges HTML ───────────────────────────────────────────
function badgeHtml(status, rsStatus) {
  if (rsStatus === 'Pending') {
    return `<span class="status-pill rs"><span class="status-pill-dot"></span>Pending RS</span>`;
  }
  if (status === 'Menunggu') {
    return `<span class="status-pill wait"><span class="status-pill-dot"></span>Menunggu</span>`;
  }
  if (status === 'Dikonfirmasi') {
    return `<span class="status-pill conf"><span class="status-pill-dot"></span>Dikonfirmasi</span>`;
  }
  if (status === 'Selesai') {
    return `<span class="status-pill done"><span class="status-pill-dot"></span>Selesai</span>`;
  }
  return `<span class="status-pill wait"><span class="status-pill-dot"></span>${escHtml(status) || 'Menunggu'}</span>`;
}

function rsBadgeHtml(s) {
  if (s === 'Pending') {
    return `<span class="status-pill rs"><span class="status-pill-dot"></span>Pending</span>`;
  }
  if (s === 'Disetujui') {
    return `<span class="status-pill done"><span class="status-pill-dot"></span>Disetujui</span>`;
  }
  if (s === 'Ditolak') {
    return `<span class="status-pill reject"><span class="status-pill-dot"></span>Ditolak</span>`;
  }
  return `<span class="status-pill wait">${escHtml(s) || 'Belum ada'}</span>`;
}

// ── Highlight Search Query ───────────────────────────────────────
function highlight(text, query) {
  if (!query) return escHtml(text);
  const esc = escHtml(text);
  const escQ = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return esc.replace(new RegExp(`(${escQ})`, 'gi'), '<mark style="background:rgba(2,132,199,0.3);color:#ffffff;border-radius:2px;padding:0 2px;">$1</mark>');
}

// ── Dashboard Recent Table ───────────────────────────────────────
function setDashFilter(filter, el) {
  dashFilter = filter;
  $$('#dashQuickFilter .filter-chip').forEach(b => {
    b.classList.remove('active');
  });
  if (el) el.classList.add('active');
  renderDashTable();
}

function renderDashTable() {
  let data = allData.slice(0, 20);
  if (dashFilter !== 'all') {
    data = allData.filter(r => r.status === dashFilter).slice(0, 20);
  }
  const shown = data.slice(0, 10);

  const sub = $('dashTableSub');
  if (sub) sub.textContent = `${shown.length} data pendaftar terbaru ditampilkan`;

  const tbody = $('dashBody');
  if (!tbody) return;

  if (!shown.length) {
    tbody.innerHTML = '<tr><td colspan="6"><div class="table-empty-state"><div class="empty-state-title">Belum ada data pendaftar</div></div></td></tr>';
    return;
  }

  tbody.innerHTML = shown.map(r => `
    <tr onclick="openModal('${escKey(r._key)}')">
      <td><span class="t-reg-code">${escHtml(r.reg) || 'Belum ada'}</span></td>
      <td>
        <div class="t-name-cell">${escHtml(r.nama) || 'Pemohon'}</div>
        <div class="t-sub-info">${escHtml(r.jk) || ''}</div>
      </td>
      <td>${escHtml(r.jenis_permohonan) || 'BAP Paspor'}</td>
      <td>
        <div>${formatTgl(r.tanggal)}</div>
        <div class="t-sub-info">${escHtml(r.jam) || ''}</div>
      </td>
      <td>${badgeHtml(r.status, r.reschedule_status)}</td>
      <td style="text-align: right;">
        <div class="table-btn-group">
          <button class="tbl-action-btn" onclick="event.stopPropagation();openModal('${escKey(r._key)}')">Detail</button>
          ${r.hp ? `<button class="tbl-action-btn wa" onclick="event.stopPropagation();openWA('${escKey(r.hp)}')" title="Hubungi via WhatsApp">WA</button>` : ''}
        </div>
      </td>
    </tr>
  `).join('');
}

// ── Main Pendaftar Database Table ────────────────────────────────
function renderTable() {
  const q = ($('searchInput')?.value || '').trim();
  const filtered = getFiltered();
  const total = filtered.length;
  const totalPages = Math.ceil(total / PAGE_SIZE) || 1;

  if (currentPage > totalPages) currentPage = totalPages;

  const start = (currentPage - 1) * PAGE_SIZE;
  const page = filtered.slice(start, start + PAGE_SIZE);

  const sub = $('tblSubtitle');
  if (sub) sub.textContent = `${total} data pemohon ditemukan`;

  const pgInfo = $('pgInfo');
  if (pgInfo) pgInfo.textContent = `Menampilkan baris ${total ? start + 1 : 0} sampai ${Math.min(start + PAGE_SIZE, total)} dari total ${total} data`;

  const tbody = $('mainBody');
  if (!tbody) return;

  if (!page.length) {
    tbody.innerHTML = `
      <tr>
        <td colspan="10">
          <div class="table-empty-state">
            <div class="empty-state-title">Tidak ada data yang cocok</div>
            <div class="empty-state-sub">Ubah kata kunci pencarian atau sesuaikan filter status dan bulan.</div>
          </div>
        </td>
      </tr>`;
  } else {
    tbody.innerHTML = page.map((r, i) => {
      const isChecked = selectedRowKeys.has(r._key);
      return `
        <tr class="${isChecked ? 'row-selected' : ''}" onclick="openModal('${escKey(r._key)}')">
          <td onclick="event.stopPropagation()">
            <input type="checkbox" ${isChecked ? 'checked' : ''} onchange="toggleRowSelection('${escKey(r._key)}', this)">
          </td>
          <td style="color:var(--text-muted);font-size:11px">${start + i + 1}</td>
          <td><span class="t-reg-code">${escHtml(r.reg) || 'Belum ada'}</span></td>
          <td>
            <div class="t-name-cell">${highlight(r.nama, q) || 'Pemohon'}</div>
            <div class="t-sub-info">${escHtml(r.ttl) || ''}</div>
          </td>
          <td class="t-phone-cell">${escHtml(r.hp) || 'Belum ada'}</td>
          <td>${escHtml(r.jenis_permohonan) || 'BAP'}</td>
          <td>
            <div>${formatTgl(r.tanggal)}</div>
            <div class="t-sub-info">${escHtml(r.jam) || ''}</div>
          </td>
          <td>${badgeHtml(r.status, r.reschedule_status)}</td>
          <td style="font-size:11px;color:var(--text-muted)">${escHtml(r.waktu_daftar) || 'Belum ada'}</td>
          <td style="text-align: right;" onclick="event.stopPropagation()">
            <div class="table-btn-group">
              <button class="tbl-action-btn" title="Buka Detail" onclick="openModal('${escKey(r._key)}')">Buka</button>
              ${r.hp ? `<button class="tbl-action-btn wa" title="Hubungi via WhatsApp" onclick="openWA('${escKey(r.hp)}')">WA</button>` : ''}
              <button class="tbl-action-btn danger" title="Hapus Data" onclick="openDeleteFromTable('${escKey(r._key)}')">Hapus</button>
            </div>
          </td>
        </tr>`;
    }).join('');
  }

  renderPagination(totalPages);
  updateBulkActionBar();
}

function renderPagination(total) {
  const container = $('pgBtns');
  if (!container) return;

  let html = `<button class="pg-btn" onclick="changePage(${currentPage - 1})" ${currentPage <= 1 ? 'disabled' : ''} aria-label="Halaman Sebelumnya">&lt;</button>`;
  const s = Math.max(1, currentPage - 2);
  const e = Math.min(total, s + 4);
  for (let i = s; i <= e; i++) {
    html += `<button class="pg-btn ${i === currentPage ? 'active' : ''}" onclick="changePage(${i})">${i}</button>`;
  }
  html += `<button class="pg-btn" onclick="changePage(${currentPage + 1})" ${currentPage >= total ? 'disabled' : ''} aria-label="Halaman Berikutnya">&gt;</button>`;
  container.innerHTML = html;
}

function changePage(p) {
  currentPage = p;
  renderTable();
}

// ── Bulk Selection & Actions ─────────────────────────────────────
function toggleRowSelection(key, checkbox) {
  if (checkbox.checked) selectedRowKeys.add(key);
  else selectedRowKeys.delete(key);
  updateBulkActionBar();
}

function toggleSelectAllRows(checkbox) {
  const filtered = getFiltered();
  const start = (currentPage - 1) * PAGE_SIZE;
  const page = filtered.slice(start, start + PAGE_SIZE);

  page.forEach(r => {
    if (checkbox.checked) selectedRowKeys.add(r._key);
    else selectedRowKeys.delete(r._key);
  });
  renderTable();
}

function clearRowSelection() {
  selectedRowKeys.clear();
  const selectAll = $('selectAllRows');
  if (selectAll) selectAll.checked = false;
  renderTable();
}

function updateBulkActionBar() {
  const bar = $('bulkActionBar');
  const countEl = $('bulkSelectedCount');
  if (!bar || !countEl) return;

  const count = selectedRowKeys.size;
  countEl.textContent = count;
  bar.style.display = count > 0 ? 'flex' : 'none';
}

function bulkCopyPhones() {
  const phones = [];
  allData.forEach(r => {
    if (selectedRowKeys.has(r._key) && r.hp) {
      phones.push(r.hp.trim());
    }
  });
  if (!phones.length) {
    showToast('error', 'Tidak ada nomor telepon pada data yang dipilih');
    return;
  }
  navigator.clipboard.writeText(phones.join(', ')).then(() => {
    playSuccessChime();
    showToast('success', `${phones.length} nomor WhatsApp berhasil disalin`);
  });
}

// ── WhatsApp Direct Sender ───────────────────────────────────────
function openWA(hp) {
  if (!hp) return;
  const clean = String(hp).replace(/\D/g, '');
  const intl = clean.startsWith('0') ? '62' + clean.slice(1) : clean;
  window.open(`https://wa.me/${intl}`, '_blank');
}

// ── Reschedule Page Table & Actions ──────────────────────────────
function setRsFilter(val, el) {
  rsFilter = val;
  $$('.tab-pill-btn').forEach(b => b.classList.remove('active'));
  if (el) el.classList.add('active');
  renderRsTable();
}

function getRsData() {
  return allData.filter(r => {
    if (!r.reschedule_status) return false;
    if (rsFilter === 'all') return true;
    return r.reschedule_status === rsFilter;
  });
}

function renderRsTable() {
  const data = getRsData();
  const sub = $('rsSubtitle');
  if (sub) sub.textContent = `${data.length} pengajuan reschedule ditemukan`;

  const tbody = $('rsBody');
  if (!tbody) return;

  if (!data.length) {
    tbody.innerHTML = `
      <tr>
        <td colspan="8">
          <div class="table-empty-state">
            <div class="empty-state-title">Tidak ada permohonan reschedule</div>
            <div class="empty-state-sub">Belum ada pengajuan perubahan jadwal dengan status terpilih.</div>
          </div>
        </td>
      </tr>`;
    return;
  }

  tbody.innerHTML = data.map(r => `
    <tr onclick="openModal('${escKey(r._key)}')">
      <td><span class="t-reg-code">${escHtml(r.reg) || 'Belum ada'}</span></td>
      <td><div class="t-name-cell">${escHtml(r.nama) || 'Pemohon'}</div></td>
      <td style="font-family:'JetBrains Mono',monospace;font-size:11px">${escHtml(r.nik) || 'Belum ada'}</td>
      <td>
        <div class="rs-jadwal-stack">
          <span class="rs-date-text">${formatTgl(r.tanggal)}</span>
          <span class="rs-time-text">${escHtml(r.jam) || ''}</span>
        </div>
      </td>
      <td>
        <div class="rs-jadwal-stack">
          <span class="rs-date-text rs-new-target">${formatTgl(r.reschedule_tanggal)}</span>
          <span class="rs-time-text rs-new-target">${escHtml(r.reschedule_jam) || ''}</span>
        </div>
      </td>
      <td>
        <div style="max-width:180px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis" title="${escHtml(r.reschedule_alasan)}">
          ${escHtml(r.reschedule_alasan) || 'Tidak ada alasan'}
        </div>
      </td>
      <td>${rsBadgeHtml(r.reschedule_status)}</td>
      <td style="text-align: right;" onclick="event.stopPropagation()">
        ${r.reschedule_status === 'Pending' ? `
          <div class="table-btn-group">
            <button class="tbl-action-btn approve" onclick="approveReschedule('${escKey(r._key)}')">Setujui</button>
            <button class="tbl-action-btn reject" onclick="rejectReschedule('${escKey(r._key)}')">Tolak</button>
          </div>
        ` : `
          <button class="tbl-action-btn" onclick="openModal('${escKey(r._key)}')">Detail</button>
        `}
      </td>
    </tr>
  `).join('');
}

async function approveReschedule(key) {
  const row = allData.find(r => r._key === key);
  if (!row || !row._rowIndex) return;

  const ok = await showConfirm({
    title: 'Persetujuan Reschedule',
    msg: `Setujui perubahan jadwal untuk ${row.nama}?\nJadwal baru: ${formatTgl(row.reschedule_tanggal)}, ${row.reschedule_jam}`,
    icon: 'SETUJU',
    okText: 'Ya, Setujui Jadwal'
  });
  if (!ok) return;

  showToast('info', 'Memproses persetujuan reschedule...');
  try {
    const json = await apiPost({
      action: 'approveReschedule',
      _rowIndex: row._rowIndex,
      new_tanggal: row.reschedule_tanggal,
      new_jam: row.reschedule_jam,
      new_slot_id: row.reschedule_slot_id
    });
    if (json.ok) {
      row.tanggal = row.reschedule_tanggal;
      row.jam = row.reschedule_jam;
      row.reschedule_status = 'Disetujui';
      row.status = 'Dikonfirmasi';
      playSuccessChime();
      showToast('success', 'Jadwal baru berhasil disetujui');
      logActivity('Reschedule Disetujui', `Persetujuan perubahan jadwal ${row.nama} ke ${row.tanggal}.`);
      renderAll();
    } else {
      if (!json.needLogin) showToast('error', json.error || 'Gagal memproses persetujuan di server');
    }
  } catch {
    showToast('error', 'Gagal terhubung ke server');
  }
}

async function rejectReschedule(key) {
  const row = allData.find(r => r._key === key);
  if (!row || !row._rowIndex) return;

  const ok = await showConfirm({
    title: 'Penolakan Reschedule',
    msg: `Tolak pengajuan jadwal baru untuk ${row.nama}?\nJadwal awal tetap berlaku.`,
    icon: 'TOLAK',
    okText: 'Ya, Tolak Permohonan'
  });
  if (!ok) return;

  showToast('info', 'Memproses penolakan...');
  try {
    const json = await apiPost({ action: 'rejectReschedule', _rowIndex: row._rowIndex });
    if (json.ok) {
      row.reschedule_status = 'Ditolak';
      row.status = 'Menunggu';
      showToast('info', 'Pengajuan reschedule ditolak. Jadwal lama tetap berlaku.');
      logActivity('Reschedule Ditolak', `Penolakan reschedule pemohon ${row.nama}.`);
      renderAll();
    } else {
      if (!json.needLogin) showToast('error', json.error || 'Gagal memproses penolakan di server');
    }
  } catch {
    showToast('error', 'Gagal terhubung ke server');
  }
}

// ── Detail Applicant Modal ───────────────────────────────────────
function openModal(key) {
  const row = allData.find(r => r._key === key);
  if (!row) return;
  currentRow = row;

  // Header Elements
  $('mTitle').textContent = row.nama || 'Pemohon BAP';
  $('m-header-reg').textContent = row.reg || 'BAP-00000000-0000';
  const stBadge = $('m-header-status');
  if (stBadge) {
    stBadge.className = 'mhb-status-badge ' + (row.status === 'Selesai' ? 'done' : row.status === 'Dikonfirmasi' ? 'conf' : 'wait');
    stBadge.textContent = row.status || 'Menunggu';
  }

  // Data Tab Elements
  $('m-reg').textContent = row.reg || 'Belum ada';
  $('m-waktu').textContent = row.waktu_daftar || 'Belum ada';
  $('m-nama').textContent = row.nama || 'Pemohon';
  $('m-ttl').textContent = row.ttl || 'Belum ada';
  $('m-jk').textContent = row.jk || 'Belum ada';
  $('m-hp').textContent = row.hp || 'Belum ada';
  $('m-jadwal').textContent = `${formatTglFull(row.tanggal)} (Sesi: ${row.jam || 'Belum ditentukan'})`;
  $('m-jenis').textContent = row.jenis_permohonan || 'BAP Paspor';
  $('m-paspor').textContent = row.jenis_paspor || 'Paspor Biasa';
  $('m-tujuan').textContent = row.tujuan || 'Tidak ada keterangan';

  // Photo Schedule
  const fuItem = $('m-fu-item');
  if (row.foto_ulang_tanggal && String(row.foto_ulang_tanggal).trim() !== '') {
    fuItem.style.display = 'block';
    $('m-fu-jadwal').textContent = formatFotoUlangReadable(row.foto_ulang_tanggal);
  } else {
    fuItem.style.display = 'none';
  }

  // Documents Tab & Inspection Studio
  renderDocumentsStudio(row);

  // Status Tab
  $('m-note').value = row.note || '';
  const isDone = row.status === 'Selesai';

  $$('.status-card-opt').forEach(o => {
    o.classList.remove('selected-wait', 'selected-conf', 'selected-done');
    if (o.dataset.val === row.status) {
      o.classList.add(
        row.status === 'Menunggu' ? 'selected-wait' :
          row.status === 'Dikonfirmasi' ? 'selected-conf' : 'selected-done'
      );
    }
  });

  const fuSection = $('fotoUlangSection');
  if (isDone) {
    if (fuSection) fuSection.style.display = 'block';
    setFotoUlangValue(row.foto_ulang_tanggal);
  } else {
    if (fuSection) fuSection.style.display = 'none';
  }
  $('statusLockedNote').style.display = isDone ? 'block' : 'none';

  // WhatsApp Tab
  const waTarget = $('waRecipientNumber');
  if (waTarget) waTarget.textContent = `Tujuan: ${row.hp || 'Belum ada nomor'}`;
  applyWATemplate('konfirmasi');

  // Reschedule Tab
  const rsTabEl = $('rsTab');
  const hasRs = row.reschedule_status && row.reschedule_status !== '';
  if (rsTabEl) rsTabEl.style.display = hasRs ? 'block' : 'none';
  if (hasRs) renderRescheduleDetail(row);

  // Reset to identity tab
  switchTab('data', document.querySelector('.modal-nav-tab[data-tab="data"]'));

  $('modalOverlay').classList.add('show');
  document.body.style.overflow = 'hidden';
}

function closeModal() {
  $('modalOverlay').classList.remove('show');
  document.body.style.overflow = '';
  currentRow = null;
}

function switchTab(name, el) {
  $$('.modal-tab-panel').forEach(p => p.classList.remove('active'));
  $$('.modal-nav-tab').forEach(t => {
    t.classList.remove('active');
    t.setAttribute('aria-selected', 'false');
  });

  const panel = $('tab-' + name);
  if (panel) panel.classList.add('active');
  if (el) {
    el.classList.add('active');
    el.setAttribute('aria-selected', 'true');
  }
}

// ── Document Inspection Studio ───────────────────────────────────
function renderDocumentsStudio(row) {
  const DOCS = [
    { key: 'url_ktp', label: 'E-KTP Pemohon' },
    { key: 'url_kk', label: 'Kartu Keluarga' },
    { key: 'url_akta', label: 'Akta Lahir / Buku Nikah / Ijazah' },
    { key: 'url_foto_paspor', label: 'Foto Paspor Lama / Rusak' },
    { key: 'url_surat_polisi', label: 'Surat Keterangan Kepolisian' },
    { key: 'url_surat_kelurahan', label: 'Surat Keterangan Kelurahan' },
    { key: 'url_surat_pemerintah', label: 'Surat Dinas / Rekomendasi Pemerintah' },
    { key: 'url_pendukung', label: 'Berkas Pendukung Lainnya' }
  ];

  const container = $('docContainer');
  const countPill = $('docCountPill');
  if (!container) return;

  let availableCount = 0;
  DOCS.forEach(d => {
    if (row[d.key] && String(row[d.key]).trim() !== '') availableCount++;
  });
  if (countPill) countPill.textContent = availableCount;

  container.innerHTML = DOCS.map((d, idx) => {
    const url = row[d.key];
    const isAvailable = Boolean(url && String(url).trim() !== '');
    if (!isAvailable) {
      return `
        <div class="doc-item-card">
          <div class="doc-item-header">
            <span class="dih-title">${d.label}</span>
            <span class="legend-item missing">Tidak Dilampirkan</span>
          </div>
          <div class="doc-missing-placeholder">
            <span>Berkas belum diunggah oleh pemohon</span>
          </div>
        </div>`;
    }

    // Konversi link Drive (uc?export=view atau file/d/.../view) ke thumbnail resmi agar tampil di <img> tanpa terblokir browser
    let displayUrl = url;
    let driveFileId = null;
    if (url.includes('drive.google.com')) {
      const matchId = url.match(/\/d\/([a-zA-Z0-9_-]+)/) || url.match(/[?&]id=([a-zA-Z0-9_-]+)/);
      if (matchId && matchId[1]) {
        driveFileId = matchId[1];
        displayUrl = 'https://drive.google.com/thumbnail?id=' + driveFileId + '&sz=w1200';
      }
    }

    const isPdf = url.toLowerCase().includes('.pdf');
    const safeUrl = escKey(displayUrl);
    const originalUrl = driveFileId ? `https://drive.google.com/file/d/${driveFileId}/view?usp=sharing` : url;
    const rotation = docRotations[d.key] || 0;

    return `
      <div class="doc-item-card">
        <div class="doc-item-header">
          <span class="dih-title">${d.label}</span>
          <span class="legend-item available">Tersedia</span>
        </div>
        <div class="doc-stage-area">
          ${isPdf ? `
            <div style="text-align:center;color:var(--text-secondary)">
              <div style="font-size:12px;margin-bottom:8px">Dokumen Berformat PDF</div>
              <a href="${originalUrl}" target="_blank" rel="noopener" class="primary-btn compact">Buka Dokumen PDF</a>
            </div>
          ` : `
            <img class="doc-preview-img" id="docImg_${idx}" src="${displayUrl}" alt="${d.label}" loading="lazy"
              referrerpolicy="no-referrer"
              onerror="this.onerror=null; if(this.src.indexOf('thumbnail')!==-1){ this.src='${url}'; }"
              style="transform: rotate(${rotation}deg)"
              onclick="openLightbox('${safeUrl}', '${escKey(d.label)}')">
            <div class="doc-action-overlay">
              <button class="doc-tool-pill" onclick="rotateCardDoc('${d.key}', 'docImg_${idx}', 90)">Putar 90°</button>
              <button class="doc-tool-pill" onclick="openLightbox('${safeUrl}', '${escKey(d.label)}')">Perbesar</button>
              <a href="${originalUrl}" target="_blank" rel="noopener" class="doc-tool-pill" style="text-decoration:none;display:inline-flex;align-items:center;">Buka Berkas Asli ↗</a>
            </div>
          `}
        </div>
      </div>`;
  }).join('');
}

function rotateCardDoc(key, imgId, delta) {
  docRotations[key] = (docRotations[key] || 0) + delta;
  const img = document.getElementById(imgId);
  if (img) img.style.transform = `rotate(${docRotations[key]}deg)`;
}

// ── Lightbox & Inspector Controls ────────────────────────────────
function openLightbox(url, title = 'Dokumen Lampiran') {
  currentLightboxRotation = 0;
  $('lightboxTitle').textContent = title;
  const img = $('lightbox-img');
  img.src = url;
  img.style.transform = 'rotate(0deg)';
  $('lightboxDownloadBtn').href = url;
  $('lightbox').classList.add('show');
  document.body.style.overflow = 'hidden';
}

function closeLightbox() {
  $('lightbox').classList.remove('show');
  document.body.style.overflow = '';
}

function rotateLightboxDoc(delta) {
  currentLightboxRotation += delta;
  const img = $('lightbox-img');
  if (img) img.style.transform = `rotate(${currentLightboxRotation}deg)`;
}

function resetLightboxZoom() {
  currentLightboxRotation = 0;
  const img = $('lightbox-img');
  if (img) img.style.transform = 'rotate(0deg)';
}

// ── Status Decision Handling ─────────────────────────────────────
function selectStatus(el) {
  $$('.status-card-opt').forEach(o => {
    o.classList.remove('selected-wait', 'selected-conf', 'selected-done');
    o.setAttribute('aria-checked', 'false');
  });

  const v = el.dataset.val;
  el.classList.add(v === 'Menunggu' ? 'selected-wait' : v === 'Dikonfirmasi' ? 'selected-conf' : 'selected-done');
  el.setAttribute('aria-checked', 'true');

  const fuSection = $('fotoUlangSection');
  if (v === 'Selesai') {
    populateFotoUlangSelects();
    if (!currentRow || !currentRow.foto_ulang_tanggal) setFotoUlangValue('');
    if (fuSection) fuSection.style.display = 'block';
  } else {
    if (fuSection) fuSection.style.display = 'none';
  }
}

function populateFotoUlangSelects() {
  const hSel = $('fuHari'), bSel = $('fuBulan'), ySel = $('fuTahun');
  if (!hSel || hSel.dataset.filled) return;

  for (let d = 1; d <= 31; d++) {
    const o = document.createElement('option');
    o.value = String(d).padStart(2, '0');
    o.textContent = d;
    hSel.appendChild(o);
  }

  MONTH_FULL.forEach((m, i) => {
    const o = document.createElement('option');
    o.value = String(i + 1).padStart(2, '0');
    o.textContent = m;
    bSel.appendChild(o);
  });

  const thisYear = new Date().getFullYear();
  for (let y = thisYear; y <= thisYear + 1; y++) {
    const o = document.createElement('option');
    o.value = String(y);
    o.textContent = y;
    ySel.appendChild(o);
  }
  hSel.dataset.filled = '1';
}

function setFotoUlangValue(tglStr) {
  populateFotoUlangSelects();
  const s = String(tglStr || '').slice(0, 10);
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if ($('fuTahun')) $('fuTahun').value = m ? m[1] : '';
  if ($('fuBulan')) $('fuBulan').value = m ? m[2] : '';
  if ($('fuHari')) $('fuHari').value = m ? m[3] : '';
}

function getFotoUlangValue() {
  const h = $('fuHari')?.value, b = $('fuBulan')?.value, y = $('fuTahun')?.value;
  if (!h || !b || !y) return '';
  return `${y}-${b}-${h}`;
}

function formatFotoUlangReadable(tglStr) {
  const s = String(tglStr || '').slice(0, 10);
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return 'Belum ada';
  const dateObj = new Date(parseInt(m[1]), parseInt(m[2]) - 1, parseInt(m[3]), 12, 0, 0);
  const dayName = DAYS_ID[dateObj.getDay()] || '';
  return `${dayName}, ${parseInt(m[3])} ${MONTH_FULL[parseInt(m[2]) - 1]} ${m[1]}`;
}

async function saveStatus() {
  if (!currentRow) return;
  const sel = document.querySelector('.status-card-opt[class*="selected"]');
  if (!sel) {
    showToast('error', 'Pilih status keputusan terlebih dahulu');
    return;
  }

  const newStatus = sel.dataset.val;
  const note = $('m-note').value.trim();

  let fotoUlangTanggal = '';
  if (newStatus === 'Selesai') {
    fotoUlangTanggal = getFotoUlangValue();
    if (!fotoUlangTanggal) {
      showToast('error', 'Pilih jadwal pengambilan surat keputusan hasil BAP sebelum menyimpan status Selesai');
      return;
    }
  }

  const rowKey = currentRow._key;
  const rowIndex = currentRow._rowIndex;
  const rowInData = allData.find(r => r._key === rowKey);

  if (rowInData) {
    rowInData.status = newStatus;
    rowInData.note = note;
    if (newStatus === 'Selesai') rowInData.foto_ulang_tanggal = fotoUlangTanggal;
  }

  localStatus[rowKey] = { status: newStatus, note, foto_ulang_tanggal: fotoUlangTanggal };
  saveLocalStatus();
  logActivity('Pembaruan Status BAP', `Mengubah status ${currentRow.nama} menjadi ${newStatus}.`);
  playSuccessChime();
  renderAll();
  closeModal();

  if (rowIndex) {
    showToast('info', 'Menyimpan status ke lembar kerja...');
    try {
      const payload = { action: 'updateStatus', _rowIndex: rowIndex, status: newStatus, note };
      if (newStatus === 'Selesai') payload.foto_ulang_tanggal = fotoUlangTanggal;

      const json = await apiPost(payload);
      if (json.ok) {
        showToast('success', `Status "${newStatus}" berhasil disimpan ke server`);
        delete localStatus[rowKey];
        saveLocalStatus();
        if (newStatus === 'Selesai' || newStatus === 'Dikonfirmasi') {
          setTimeout(() => showToast('info', 'Pesan WhatsApp otomatis dikirim ke pemohon'), 1800);
        }
      } else {
        // Server menolak -> batalkan tampilan optimistis agar tidak menyesatkan petugas
        delete localStatus[rowKey];
        saveLocalStatus();
        showToast('error', json.error || 'Gagal menyimpan status ke server');
        loadData();
      }
    } catch {
      showToast('error', 'Koneksi gagal (status disimpan secara lokal)');
    }
  } else {
    showToast('success', `Status "${newStatus}" tersimpan lokal`);
  }
}

// ── WhatsApp Official Template Generator ─────────────────────────
function applyWATemplate(type, btnEl) {
  if (btnEl) {
    $$('.wa-preset-btn').forEach(b => b.classList.remove('active'));
    btnEl.classList.add('active');
  }

  if (!currentRow) return;
  const r = currentRow;
  const editor = $('waMessageEditor');
  if (!editor) return;

  let msg = '';
  const nama = r.nama || 'Bapak/Ibu';
  const reg = r.reg || 'BAP-0000';
  const tgl = formatTglFull(r.tanggal);
  const jam = r.jam || 'Sesi Ditentukan';
  const jenis = r.jenis_permohonan || 'BAP Paspor';

  if (type === 'konfirmasi') {
    msg =
      `*PEMBERITAHUAN JADWAL BAP KANTOR IMIGRASI KELAS I TPI TANJUNGPINANG*

Yth. Bapak/Ibu *${nama}*,

Pendaftaran Berita Acara Pemeriksaan (BAP) Paspor Anda telah kami verifikasi dan disetujui.

*Rincian Kedatangan:*
• No. Registrasi: *${reg}*
• Jenis Permohonan: *${jenis}*
• Hari/Tanggal: *${tgl}*
• Sesi Waktu: *${jam} WIB*
• Lokasi: Seksi INTELDAKIM, Kantor Imigrasi Kelas I TPI Tanjungpinang

*Instruksi Penting:*
1. Harap hadir 15 menit sebelum waktu sesi.
2. Wajib membawa seluruh *dokumen fisik asli* (KTP, KK, Akta Lahir/Buku Nikah/Ijazah, Surat Polisi jika paspor hilang).
3. Berpakaian rapi dan berkerah (bukan kaos oblong).

Terima kasih.
_Seksi Intelijen dan Penindakan Keimigrasian_`;

  } else if (type === 'h1') {
    msg =
      `*PENGINGAT KEHADIRAN BAP (H-1)*

Yth. Bapak/Ibu *${nama}*,

Mengingatkan kembali jadwal pelaksanaan Berita Acara Pemeriksaan (BAP) Paspor Anda besok:
• No. Registrasi: *${reg}*
• Jadwal: *${tgl}*
• Sesi: *${jam} WIB*

Pastikan seluruh berkas persyaratan asli telah lengkap. Jika berhalangan hadir, segera hubungi petugas kami.

Terima kasih.
_Kantor Imigrasi Kelas I TPI Tanjungpinang_`;

  } else if (type === 'berkas_kurang') {
    msg =
      `*KLARIFIKASI DOKUMEN SIPALARUS*

Yth. Bapak/Ibu *${nama}*,

Sehubungan dengan pendaftaran BAP No. *${reg}*, terdapat dokumen yang perlu dilengkapi atau diperjelas sebelum pelaksanaan wawancara.

Mohon konfirmasi kelengkapan berkas fisik yang akan dibawa saat verifikasi loket.

Terima kasih.
_Petugas Pemeriksa INTELDAKIM Tanjungpinang_`;

  } else if (type === 'selesai') {
    // Pakai tanggal yang sedang dipilih di form (jika ada), kalau tidak pakai yang sudah tersimpan
    const fuRaw = (typeof getFotoUlangValue === 'function' && getFotoUlangValue()) || r.foto_ulang_tanggal;
    const fuTgl = fuRaw ? formatFotoUlangReadable(fuRaw) : '[ISI TANGGAL PENGAMBILAN]';
    msg =
      `*INFORMASI PENYELESAIAN BAP*

Yth. Bapak/Ibu *${nama}*,

Proses Berita Acara Pemeriksaan (BAP) Paspor No. *${reg}* telah *SELESAI* dilaksanakan.

Mohon hadir kembali ke Kantor Imigrasi untuk mengambil surat keputusan Berita Acara Pemeriksaan pada:
* Tanggal : ${fuTgl.toUpperCase()}
* Tempat : Ruang Inteldakim Kantor Imigrasi Kelas I TPI Tanjungpinang.

Terima kasih.
_Kantor Imigrasi Kelas I TPI Tanjungpinang_`;
  }

  editor.value = msg;
}

function copyWAMessage() {
  const text = $('waMessageEditor')?.value || '';
  if (!text) return;
  navigator.clipboard.writeText(text).then(() => {
    playSuccessChime();
    showToast('success', 'Teks pesan WhatsApp berhasil disalin');
  });
}

function sendDirectWAMessage() {
  if (!currentRow || !currentRow.hp) {
    showToast('error', 'Nomor telepon pemohon tidak valid');
    return;
  }
  const text = $('waMessageEditor')?.value || '';
  const clean = String(currentRow.hp).replace(/\D/g, '');
  const intl = clean.startsWith('0') ? '62' + clean.slice(1) : clean;
  const url = `https://wa.me/${intl}?text=${encodeURIComponent(text)}`;
  logActivity('Kirim Pesan WhatsApp', `Mengirim template pesan ke ${currentRow.nama} (${currentRow.hp}).`);
  window.open(url, '_blank');
}

function openDirectWAFromModal() {
  if (!currentRow || !currentRow.hp) return;
  openWA(currentRow.hp);
}

// ── Reschedule Modal Details ─────────────────────────────────────
function renderRescheduleDetail(row) {
  const panel = $('rsDetailPanel');
  if (!panel) return;

  const isApproved = row.reschedule_status === 'Disetujui';
  const isRejected = row.reschedule_status === 'Ditolak';

  panel.innerHTML = `
    <div class="data-group-card full-span">
      <div class="dgc-title">Pengajuan Perubahan Jadwal Kedatangan</div>
      <div class="field-grid-three">
        <div class="field-item">
          <span class="fi-label">Jadwal Semula</span>
          <span class="fi-value">${formatTglFull(row.tanggal)} (Sesi: ${escHtml(row.jam)})</span>
        </div>
        <div class="field-item">
          <span class="fi-label">Jadwal Baru Dimohonkan</span>
          <span class="fi-value schedule-tag">${formatTglFull(row.reschedule_tanggal)} (Sesi: ${escHtml(row.reschedule_jam)})</span>
        </div>
        <div class="field-item">
          <span class="fi-label">Status Pengajuan</span>
          <span class="fi-value">${rsBadgeHtml(row.reschedule_status)}</span>
        </div>
        <div class="field-item full-span">
          <span class="fi-label">Alasan Perubahan Jadwal</span>
          <span class="fi-value text-block">${escHtml(row.reschedule_alasan) || 'Tidak disertakan alasan.'}</span>
        </div>
      </div>
      ${row.reschedule_status === 'Pending' ? `
        <div style="margin-top:14px;display:flex;gap:10px;">
          <button class="primary-btn" onclick="approveReschedule('${escKey(row._key)}');closeModal();">Setujui Jadwal Baru</button>
          <button class="tbl-action-btn danger" onclick="rejectReschedule('${escKey(row._key)}');closeModal();">Tolak Permohonan</button>
        </div>
      ` : isApproved ? `
        <div style="margin-top:12px;padding:8px 12px;background:rgba(34,197,94,0.08);border-radius:6px;font-size:11.5px;color:var(--green-400);font-weight:700;">
          Pengajuan perubahan jadwal ini telah disetujui petugas.
        </div>
      ` : isRejected ? `
        <div style="margin-top:12px;padding:8px 12px;background:rgba(239,68,68,0.08);border-radius:6px;font-size:11.5px;color:var(--red-400);font-weight:700;">
          Pengajuan perubahan jadwal ini telah ditolak. Jadwal lama tetap berlaku.
        </div>
      ` : ''}
    </div>`;
}

// ── Delete Actions ───────────────────────────────────────────────
function confirmDelete() {
  if (!currentRow) return;
  pendingDelKey = currentRow._key;
  $('deleteName').textContent = currentRow.nama || 'Pemohon';
  closeModal();
  $('deleteOverlay').classList.add('show');
  document.body.style.overflow = 'hidden';
}

function openDeleteFromTable(key) {
  const row = allData.find(r => r._key === key);
  if (!row) return;
  pendingDelKey = key;
  $('deleteName').textContent = row.nama || 'Pemohon';
  $('deleteOverlay').classList.add('show');
  document.body.style.overflow = 'hidden';
}

function closeDeleteModal() {
  $('deleteOverlay').classList.remove('show');
  document.body.style.overflow = '';
  pendingDelKey = null;
}

async function executeDelete() {
  if (!pendingDelKey) return;
  const row = allData.find(r => r._key === pendingDelKey);
  if (!row) { closeDeleteModal(); return; }

  allData = allData.filter(r => r._key !== pendingDelKey);
  delete localStatus[pendingDelKey];
  saveLocalStatus();
  closeDeleteModal();
  renderAll();

  logActivity('Penghapusan Data', `Menghapus pendaftar ${row.nama} (${row.reg}).`);
  showToast('info', 'Menghapus data pemohon...');

  if (row._rowIndex) {
    try {
      const json = await apiPost({ action: 'deleteRow', _rowIndex: row._rowIndex, reg: row.reg || '' });
      if (json.ok) {
        showToast('success', 'Data pemohon berhasil dihapus');
      } else {
        showToast('error', json.error || 'Gagal menghapus baris di Google Sheets');
        loadData();
      }
    } catch {
      showToast('error', 'Gagal menghubungi server untuk menghapus');
    }
  } else {
    showToast('success', 'Data berhasil dihapus dari sistem lokal');
  }
  pendingDelKey = null;
}

// ── Print Official Document View ─────────────────────────────────
function printDetail() {
  if (!currentRow) return;
  const r = currentRow;
  const w = window.open('', '_blank', 'width=780,height=900');
  w.document.write(`<!DOCTYPE html>
<html lang="id">
<head>
<meta charset="UTF-8">
<title>Lembar Pemeriksaan SIPALARUS - ${escHtml(r.nama)}</title>
<style>
  body { font-family: 'Plus Jakarta Sans', Arial, sans-serif; margin: 36px; color: #0f172a; font-size: 13px; line-height: 1.5; }
  .gov-head { text-align: center; border-bottom: 2px solid #0f172a; padding-bottom: 12px; margin-bottom: 20px; }
  .gov-head h2 { font-size: 14px; margin: 0; text-transform: uppercase; letter-spacing: 0.05em; }
  .gov-head h1 { font-size: 16px; margin: 4px 0; text-transform: uppercase; }
  .gov-head p { font-size: 11px; margin: 0; color: #475569; }
  .doc-title { text-align: center; font-size: 14px; font-weight: 800; text-transform: uppercase; margin: 18px 0; letter-spacing: 0.06em; }
  table { width: 100%; border-collapse: collapse; margin-bottom: 18px; }
  th { background: #f1f5f9; padding: 7px 10px; text-align: left; font-size: 10px; text-transform: uppercase; letter-spacing: 0.05em; border-bottom: 1px solid #cbd5e1; }
  td { padding: 8px 10px; border-bottom: 1px solid #e2e8f0; font-size: 12px; }
  td:first-child { width: 35%; font-weight: 700; color: #475569; }
  .footer-sig { display: flex; justify-content: space-between; margin-top: 40px; }
  .sig-block { text-align: center; width: 220px; }
  .sig-space { height: 70px; }
  @media print { body { margin: 15px; } }
</style>
</head>
<body>
<div class="gov-head">
  <h2>Kementerian Hukum dan Hak Asasi Manusia RI</h2>
  <h2>Direktorat Jenderal Imigrasi</h2>
  <h1>Kantor Imigrasi Kelas I TPI Tanjungpinang</h1>
  <p>Seksi Intelijen dan Penindakan Keimigrasian (INTELDAKIM)</p>
</div>
<div class="doc-title">SIPALARUS - Lembar Registrasi Pemeriksaan Paspor Hilang &amp; Rusak</div>
<table>
  <thead><tr><th colspan="2">Data Identitas Pemohon</th></tr></thead>
  <tbody>
    <tr><td>No. Registrasi BAP</td><td><strong>${escHtml(r.reg)}</strong></td></tr>
    <tr><td>Nama Lengkap Sesuai KTP</td><td><strong>${escHtml(r.nama)}</strong></td></tr>
    <tr><td>Tempat / Tanggal Lahir</td><td>${escHtml(r.ttl)}</td></tr>
    <tr><td>Jenis Kelamin</td><td>${escHtml(r.jk)}</td></tr>
    <tr><td>Nomor WhatsApp / HP</td><td>${escHtml(r.hp)}</td></tr>
    <tr><td>Waktu Pendaftaran</td><td>${escHtml(r.waktu_daftar)}</td></tr>
  </tbody>
</table>
<table>
  <thead><tr><th colspan="2">Informasi Permohonan BAP</th></tr></thead>
  <tbody>
    <tr><td>Jenis Permohonan</td><td>${escHtml(r.jenis_permohonan)}</td></tr>
    <tr><td>Jenis Paspor</td><td>${escHtml(r.jenis_paspor)}</td></tr>
    <tr><td>Tujuan Permohonan</td><td>${escHtml(r.tujuan)}</td></tr>
    <tr><td>Jadwal Pemeriksaan</td><td>${formatTglFull(r.tanggal)} (Sesi: ${escHtml(r.jam)})</td></tr>
    <tr><td>Status Saat Ini</td><td><strong>${escHtml(r.status)}</strong></td></tr>
    ${r.foto_ulang_tanggal ? `<tr><td>Jadwal Pengambilan SK BAP</td><td>${formatFotoUlangReadable(r.foto_ulang_tanggal)}</td></tr>` : ''}
    ${r.note ? `<tr><td>Catatan Petugas Pemeriksa</td><td>${escHtml(r.note)}</td></tr>` : ''}
  </tbody>
</table>
<div class="footer-sig">
  <div class="sig-block">
    <p>Pemohon,</p>
    <div class="sig-space"></div>
    <p>( ${escHtml(r.nama)} )</p>
  </div>
  <div class="sig-block">
    <p>Tanjungpinang, ${(() => { const n = new Date(); return `${n.getDate()} ${MONTH_FULL[n.getMonth()]} ${n.getFullYear()}`; })()}<br>Petugas Pemeriksa INTELDAKIM,</p>
    <div class="sig-space"></div>
    <p>( ..................................................... )</p>
  </div>
</div>
</body>
</html>`);
  w.document.close();
  setTimeout(() => w.print(), 400);
}

// ── Rekapitulasi & Statistik View ────────────────────────────────
function renderRecap() {
  const total = allData.length || 1;

  const statusData = [
    { label: 'Menunggu', count: allData.filter(r => r.status === 'Menunggu').length, color: '#f59e0b' },
    { label: 'Dikonfirmasi', count: allData.filter(r => r.status === 'Dikonfirmasi').length, color: '#0284c7' },
    { label: 'Selesai', count: allData.filter(r => r.status === 'Selesai').length, color: '#16a34a' },
    { label: 'Pending Reschedule', count: allData.filter(r => r.reschedule_status === 'Pending').length, color: '#ea580c' },
  ];

  const statusBars = $('statusBars');
  if (statusBars) {
    statusBars.innerHTML = statusData.map(s => `
      <div>
        <div class="recap-metric-row">
          <span class="rmr-label"><span class="rmr-color-dot" style="background:${s.color}"></span>${s.label}</span>
          <span class="rmr-value">${s.count} pemohon (${Math.round(s.count / total * 100)}%)</span>
        </div>
        <div class="recap-progress-track">
          <div class="recap-progress-fill" style="width:${Math.round(s.count / total * 100)}%;background:${s.color}"></div>
        </div>
      </div>
    `).join('');
  }

  const jenisMap = {};
  allData.forEach(r => {
    const j = r.jenis_permohonan || 'Lainnya';
    jenisMap[j] = (jenisMap[j] || 0) + 1;
  });
  const jColors = ['#0284c7', '#0ea5e9', '#16a34a', '#d97706', '#8b5cf6'];
  const jenisBars = $('jenisBars');
  if (jenisBars) {
    jenisBars.innerHTML = Object.entries(jenisMap)
      .sort((a, b) => b[1] - a[1])
      .map(([k, v], i) => `
        <div>
          <div class="recap-metric-row">
            <span class="rmr-label"><span class="rmr-color-dot" style="background:${jColors[i % jColors.length]}"></span>${k}</span>
            <span class="rmr-value">${v} pemohon (${Math.round(v / total * 100)}%)</span>
          </div>
          <div class="recap-progress-track">
            <div class="recap-progress-fill" style="width:${Math.round(v / total * 100)}%;background:${jColors[i % jColors.length]}"></div>
          </div>
        </div>
      `).join('');
  }

  const sesiMap = {};
  allData.forEach(r => {
    const s = r.jam || 'Belum Ditentukan';
    sesiMap[s] = (sesiMap[s] || 0) + 1;
  });

  const sesiTable = $('sesiTable');
  if (sesiTable) {
    sesiTable.innerHTML = `
      <table class="data-table">
        <thead>
          <tr>
            <th>Waktu Sesi Pelayanan</th>
            <th>Beban Jumlah Pemohon</th>
            <th>Persentase Antrean</th>
          </tr>
        </thead>
        <tbody>
          ${Object.entries(sesiMap).sort().map(([k, v]) => `
            <tr>
              <td><strong>${k}</strong></td>
              <td style="color:var(--sky-400);font-weight:700;">${v} orang</td>
              <td>${Math.round(v / allData.length * 100)}%</td>
            </tr>
          `).join('')}
        </tbody>
      </table>`;
  }
}

// ── Export to Excel ──────────────────────────────────────────────
function exportExcel(onlySelected = false) {
  if (!window.XLSX) {
    showToast('error', 'Library Excel (XLSX) tidak tersedia');
    return;
  }

  let sourceData = getFiltered();
  if (onlySelected) {
    sourceData = sourceData.filter(r => selectedRowKeys.has(r._key));
  }

  if (!sourceData.length) {
    showToast('error', 'Tidak ada data untuk diekspor ke Excel');
    return;
  }

  const wb = XLSX.utils.book_new();
  const rows = sourceData.map((r, i) => ({
    'No': i + 1,
    'No. Registrasi': r.reg || '',
    'Nama Lengkap': r.nama || '',
    'Tempat/Tgl Lahir': r.ttl || '',
    'Jenis Kelamin': r.jk || '',
    'Nomor WhatsApp': r.hp || '',
    'Kategori BAP': r.jenis_permohonan || '',
    'Jenis Paspor': r.jenis_paspor || '',
    'Tujuan Permohonan': r.tujuan || '',
    'Jadwal BAP': r.tanggal || '',
    'Sesi Kedatangan': r.jam || '',
    'Status BAP': r.status || '',
    'Status Reschedule': r.reschedule_status || '',
    'Tgl Reschedule': r.reschedule_tanggal || '',
    'Jam Reschedule': r.reschedule_jam || '',
    'Alasan Reschedule': r.reschedule_alasan || '',
    'Tgl Pengambilan SK BAP': r.foto_ulang_tanggal || '',
    'Catatan Petugas': r.note || '',
    'Waktu Registrasi': r.waktu_daftar || '',
  }));

  const ws = XLSX.utils.json_to_sheet(rows);
  ws['!cols'] = [
    { wch: 4 }, { wch: 18 }, { wch: 28 }, { wch: 22 }, { wch: 6 }, { wch: 16 },
    { wch: 20 }, { wch: 16 }, { wch: 28 }, { wch: 13 }, { wch: 14 }, { wch: 14 },
    { wch: 14 }, { wch: 14 }, { wch: 14 }, { wch: 30 }, { wch: 14 }, { wch: 28 }, { wch: 20 }
  ];
  XLSX.utils.book_append_sheet(wb, ws, 'Data SIPALARUS');

  const now = new Date();
  const dateStr = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
  const fileName = `Rekap_SIPALARUS_INTELDAKIM_${dateStr}.xlsx`;
  XLSX.writeFile(wb, fileName);

  playSuccessChime();
  showToast('success', `Ekspor berhasil (${sourceData.length} baris data)`);
  logActivity('Ekspor Data Excel', `Mengunduh berkas ${fileName} sejumlah ${sourceData.length} baris.`);
}

// ── Command Palette (Ctrl+K) ─────────────────────────────────────
function openCommandPalette() {
  const modal = $('commandPaletteModal');
  const input = $('cpInput');
  if (!modal || !input) return;

  modal.classList.add('show');
  input.value = '';
  cpSelectedIndex = 0;
  handleCPSearch();
  input.focus();
}

function closeCommandPalette() {
  const modal = $('commandPaletteModal');
  if (modal) modal.classList.remove('show');
}

function handleCPSearch() {
  const q = ($('cpInput')?.value || '').toLowerCase().trim();
  const resultsEl = $('cpResults');
  if (!resultsEl) return;

  const items = [];

  // Navigation Items
  items.push({ type: 'nav', page: 'dashboard', label: 'Buka Halaman Dashboard', badge: 'Navigasi' });
  items.push({ type: 'nav', page: 'pendaftar', label: 'Buka Basis Data Pendaftar', badge: 'Navigasi' });
  items.push({ type: 'nav', page: 'reschedule', label: 'Buka Manajemen Reschedule', badge: 'Navigasi' });
  items.push({ type: 'nav', page: 'jadwal', label: 'Buka Manajemen Jadwal & Hari Libur', badge: 'Navigasi' });
  items.push({ type: 'nav', page: 'users', label: 'Buka Manajemen Akun Pemohon', badge: 'Navigasi' });
  items.push({ type: 'nav', page: 'rekap', label: 'Buka Rekap & Laporan BAP', badge: 'Navigasi' });

  // System Actions
  items.push({ type: 'action', action: 'theme', label: 'Ganti Mode Tampilan (Gelap / Terang)', badge: 'Tampilan' });
  items.push({ type: 'action', action: 'refresh', label: 'Sinkronisasi Ulang Data Sekarang', badge: 'Sistem' });
  items.push({ type: 'action', action: 'export', label: 'Unduh Seluruh Data ke Excel', badge: 'Ekspor' });
  items.push({ type: 'action', action: 'audit', label: 'Buka Log Riwayat Aktivitas Petugas', badge: 'Audit' });

  // Matching Applicants
  if (q.length >= 2) {
    allData.forEach(r => {
      const match =
        (r.nama || '').toLowerCase().includes(q) ||
        (r.reg || '').toLowerCase().includes(q) ||
        (r.hp || '').includes(q) ||
        (r.nik || '').includes(q);
      if (match) {
        items.push({
          type: 'applicant',
          key: r._key,
          label: `${r.nama} (${r.reg})`,
          sub: `${r.jenis_permohonan} - ${r.status}`,
          badge: 'Pemohon'
        });
      }
    });
  }

  // Filter items by query
  const filtered = items.filter(item => {
    if (!q) return item.type !== 'applicant';
    return item.label.toLowerCase().includes(q) || (item.sub && item.sub.toLowerCase().includes(q));
  });

  cpCurrentResults = filtered.slice(0, 12);
  if (cpSelectedIndex >= cpCurrentResults.length) cpSelectedIndex = 0;

  if (!cpCurrentResults.length) {
    resultsEl.innerHTML = '<div style="padding:24px;text-align:center;color:var(--text-muted);font-size:12px">Tidak ada aksi atau data yang cocok.</div>';
    return;
  }

  resultsEl.innerHTML = cpCurrentResults.map((item, idx) => `
    <div class="cp-item-row ${idx === cpSelectedIndex ? 'selected' : ''}" onclick="executeCPItem(${idx})">
      <div class="cp-item-left">
        <span class="cp-item-badge">${item.badge}</span>
        <div>
          <div>${escHtml(item.label)}</div>
          ${item.sub ? `<div style="font-size:10.5px;color:var(--text-muted);">${escHtml(item.sub)}</div>` : ''}
        </div>
      </div>
      <kbd style="font-size:10px;color:var(--text-muted)">Pilih</kbd>
    </div>
  `).join('');
}

function handleCPKeydown(e) {
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    if (cpCurrentResults.length) {
      cpSelectedIndex = (cpSelectedIndex + 1) % cpCurrentResults.length;
      handleCPSearch();
    }
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    if (cpCurrentResults.length) {
      cpSelectedIndex = (cpSelectedIndex - 1 + cpCurrentResults.length) % cpCurrentResults.length;
      handleCPSearch();
    }
  } else if (e.key === 'Enter') {
    e.preventDefault();
    if (cpCurrentResults[cpSelectedIndex]) {
      executeCPItem(cpSelectedIndex);
    }
  } else if (e.key === 'Escape') {
    closeCommandPalette();
  }
}

function executeCPItem(idx) {
  const item = cpCurrentResults[idx];
  if (!item) return;

  closeCommandPalette();

  if (item.type === 'nav') {
    navTo(item.page, document.querySelector(`[data-page="${item.page}"]`));
  } else if (item.type === 'action') {
    if (item.action === 'theme') toggleTheme();
    else if (item.action === 'refresh') loadData(true);
    else if (item.action === 'export') exportExcel();
    else if (item.action === 'audit') openAuditModal();
  } else if (item.type === 'applicant') {
    openModal(item.key);
  }
}

// ── Shortcuts Modal Helper ───────────────────────────────────────
function openShortcutsModal() {
  $('shortcutsModal').classList.add('show');
  document.body.style.overflow = 'hidden';
}

function closeShortcutsModal() {
  $('shortcutsModal').classList.remove('show');
  document.body.style.overflow = '';
}

// ── Navigation Manager ───────────────────────────────────────────
const PAGE_META = {
  dashboard: ['Dashboard', 'Pusat Kendali Admin SIPALARUS'],
  pendaftar: ['Data Pendaftar SIPALARUS', 'Basis Data Pendaftaran INTELDAKIM'],
  reschedule: ['Manajemen Reschedule', 'Pengajuan Perubahan Jadwal Pemohon'],
  jadwal: ['Manajemen Jadwal Kedatangan', 'Pengaturan Hari Libur & Sesi Kedatangan'],
  users: ['Manajemen Akun Pemohon', 'Pusat Kontrol Akun Pengguna Terdaftar'],
  rekap: ['Rekap & Laporan', 'Statistik Pelayanan Keimigrasian'],
  audit: ['Pusat Audit Log & Keamanan', 'Jejak Riwayat Aktivitas Seluruh Sistem'],
};

// ── Navigation History ──────────────────────────────────────────
let navHistory = ['dashboard'];
let navHistoryIndex = 0;
let navHistoryNavigating = false;

function navTo(page, el) {
  $$('.nav-item').forEach(n => n.classList.remove('active'));
  if (el) el.classList.add('active');
  else {
    const navBtn = document.querySelector(`.nav-item[data-page="${page}"]`);
    if (navBtn) navBtn.classList.add('active');
  }
  $$('.page-view').forEach(p => p.classList.remove('active'));

  const targetPage = $('page-' + page);
  if (targetPage) targetPage.classList.add('active');

  const [t, s] = PAGE_META[page] || [page, ''];
  $('topbarTitle').textContent = t;
  $('topbarBreadcrumb').textContent = t;

  if (page === 'users') loadUsers(false, usersLoaded);
  if (page === 'jadwal') initScheduleView();
  if (page === 'audit') loadAuditLogs(false, auditLoaded);

  // Track navigation history (skip if navigating via back/forward)
  if (!navHistoryNavigating) {
    // Trim forward history when navigating to a new page
    if (navHistoryIndex < navHistory.length - 1) {
      navHistory = navHistory.slice(0, navHistoryIndex + 1);
    }
    // Don't push duplicate consecutive pages
    if (navHistory[navHistory.length - 1] !== page) {
      navHistory.push(page);
      navHistoryIndex = navHistory.length - 1;
    }
  }
  updateNavHistoryButtons();

  closeSidebar();
}

function navHistoryBack() {
  if (navHistoryIndex <= 0) return;
  navHistoryIndex--;
  navHistoryNavigating = true;
  const page = navHistory[navHistoryIndex];
  navTo(page, document.querySelector(`[data-page="${page}"]`));
  navHistoryNavigating = false;
}

function navHistoryForward() {
  if (navHistoryIndex >= navHistory.length - 1) return;
  navHistoryIndex++;
  navHistoryNavigating = true;
  const page = navHistory[navHistoryIndex];
  navTo(page, document.querySelector(`[data-page="${page}"]`));
  navHistoryNavigating = false;
}

function updateNavHistoryButtons() {
  const backBtn = $('navBackBtn');
  const fwdBtn = $('navForwardBtn');
  if (backBtn) backBtn.disabled = navHistoryIndex <= 0;
  if (fwdBtn) fwdBtn.disabled = navHistoryIndex >= navHistory.length - 1;
}

function toggleSidebar() {
  const sidebar = $('sidebar');
  const overlay = $('sidebarOverlay');
  const btn = $('menuToggleBtn');
  const isOpen = sidebar.classList.contains('open');
  sidebar.classList.toggle('open');
  overlay.classList.toggle('show');
  if (btn) btn.setAttribute('aria-expanded', String(!isOpen));
}

function closeSidebar() {
  $('sidebar')?.classList.remove('open');
  $('sidebarOverlay')?.classList.remove('show');
  const btn = $('menuToggleBtn');
  if (btn) btn.setAttribute('aria-expanded', 'false');
}

function toggleSidebarCollapse() {
  const sidebar = $('sidebar');
  if (!sidebar) return;
  sidebar.classList.toggle('collapsed');
  const isCollapsed = sidebar.classList.contains('collapsed');
  // Persist preference
  try { localStorage.setItem('sidebar_collapsed', isCollapsed ? '1' : '0'); } catch(e) {}
}

// Restore sidebar collapse state on load
(function restoreSidebarState() {
  try {
    if (localStorage.getItem('sidebar_collapsed') === '1') {
      const sidebar = $('sidebar');
      if (sidebar) sidebar.classList.add('collapsed');
    }
  } catch(e) {}
})();

// ── Toast Notifications ──────────────────────────────────────────
let toastTimer;
function showToast(type, msg) {
  clearTimeout(toastTimer);
  const t = $('toast');
  if (!t) return;
  t.textContent = msg;
  t.className = type;
  t.classList.add('show');
  toastTimer = setTimeout(() => t.classList.remove('show'), 3500);
}

// ── Global Keyboard Shortcuts ────────────────────────────────────
document.addEventListener('keydown', e => {
  // Command palette (Ctrl+K or Cmd+K)
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    openCommandPalette();
    return;
  }

  // Ctrl+F -> Focus Search
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
    const searchEl = $('searchInput');
    if (searchEl) {
      e.preventDefault();
      navTo('pendaftar', document.querySelector('[data-page=pendaftar]'));
      searchEl.focus();
      searchEl.select();
      return;
    }
  }

  // Escape key -> Close any modal
  if (e.key === 'Escape') {
    closeModal();
    closeLightbox();
    closeDeleteModal();
    closeCommandPalette();
    closeAuditModal();
    closeShortcutsModal();
    closeBulkHolidayModal();
    closeUserDetailModal();
    closeUserFormModal();
    closeDeleteUserModal();
    closeResetPasswordModal();
    resolveConfirm(false);
    return;
  }

  // Shortcuts when not in input
  const isInput = ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName);
  if (!isInput) {
    if (e.key === '?') {
      openShortcutsModal();
    } else if (e.key === 'r' || e.key === 'R') {
      loadData(true);
    } else if (e.key === '1') {
      navTo('dashboard', document.querySelector('[data-page=dashboard]'));
    } else if (e.key === '2') {
      navTo('pendaftar', document.querySelector('[data-page=pendaftar]'));
    } else if (e.key === '3') {
      navTo('reschedule', document.querySelector('[data-page=reschedule]'));
    } else if (e.key === '4') {
      navTo('users', document.querySelector('[data-page=users]'));
    } else if (e.key === '5') {
      navTo('rekap', document.querySelector('[data-page=rekap]'));
    }
  }
});

// ── Initialization Sequence ──────────────────────────────────────
window.addEventListener('DOMContentLoaded', () => {
  initTheme();
  initSound();
  initOnlineStatus();

  const session = getSession();
  setTimeout(() => {
    const splash = $('splashScreen');
    if (splash) {
      splash.classList.add('hide');
      setTimeout(() => splash.style.display = 'none', 450);
    }

    if (session && session.token) {
      bootDashboard(session.displayName);
    } else {
      $('loginPage').classList.add('visible');
    }
  }, 1000);
});

// ══════════════════════════════════════════════════════════════════
// ██ MANAJEMEN AKUN PEMOHON ██
// Halaman admin untuk melihat, mencari, menambah, mengubah, mereset
// kata sandi, dan menghapus akun pemohon (sheet "users").
// ══════════════════════════════════════════════════════════════════
const USERS_PER_PAGE = 10;
let allUsers = [];
let usersPage = 1;
let usersLoaded = false;
let activeUser = null;       // akun yang sedang dibuka di modal detail / hapus / reset
let userFormMode = 'create'; // 'create' | 'edit'
let userPwVisible = false;
let userBusy = false;

// ── Utilitas ─────────────────────────────────────────────────────
function parseTglLahir(str) {
  const t = String(str || '').trim();
  let m = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return { y: +m[1], m: +m[2], d: +m[3] };
  m = t.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})/);
  if (m) return { y: +m[3], m: +m[2], d: +m[1] };
  return null;
}

function formatTglLahirUsia(str, short = false) {
  const p = parseTglLahir(str);
  if (!p || p.m < 1 || p.m > 12) return str ? String(str) : '-';
  const now = new Date();
  let usia = now.getFullYear() - p.y;
  if (now.getMonth() + 1 < p.m || (now.getMonth() + 1 === p.m && now.getDate() < p.d)) usia--;
  return `${p.d} ${(short ? MONTH_SHORT : MONTH_FULL)[p.m - 1]} ${p.y} (${usia} th)`;
}

function tglLahirToInput(str) {
  const p = parseTglLahir(str);
  if (!p) return '';
  return `${p.y}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`;
}

function bapOfNik(nik) {
  return allData.filter(r => String(r.nik || '').trim() === String(nik).trim());
}

function findUser(nik) {
  return allUsers.find(u => u.nik === String(nik).trim());
}

function setUserBusy(btnId, busy, idleText, busyText) {
  userBusy = busy;
  const b = $(btnId);
  if (!b) return;
  b.disabled = busy;
  b.textContent = busy ? busyText : idleText;
}

// ── Muat data akun dari server ───────────────────────────────────
async function loadUsers(manual = false, silent = false) {
  const btn = $('refreshUsersBtn');
  if (btn) btn.classList.add('spinning');
  try {
    const res = await fetch(`${SHEET_URL}?action=getUsers&token=${encodeURIComponent(getAdminToken())}&t=${Date.now()}`, { cache: 'no-store' });
    const json = await res.json();

    if (json && json.needLogin) { handleSessionExpired(); return; }
    if (!Array.isArray(json)) {
      if (!silent) showToast('error', (json && json.error) || 'Gagal memuat data akun');
      renderUsersError((json && json.error) || 'Gagal memuat data akun.');
      return;
    }

    allUsers = json;
    usersLoaded = true;
    refreshUsersView();
    if (manual) {
      playSuccessChime();
      showToast('success', `${allUsers.length} akun pemohon berhasil disinkronkan`);
      logActivity('Sinkronisasi Akun', `Memuat ${allUsers.length} akun pemohon.`);
    }
  } catch (err) {
    console.error('loadUsers error:', err);
    if (!silent) showToast('error', 'Koneksi gagal saat memuat akun pemohon');
    renderUsersError('Koneksi ke server gagal. Tekan "Sinkron Akun" untuk mencoba lagi.');
  } finally {
    if (btn) btn.classList.remove('spinning');
  }
}

function renderUsersError(msg) {
  if (usersLoaded) return;
  const tb = $('userTableBody');
  if (tb) tb.innerHTML = `<tr><td colspan="8"><div class="table-loader-state error">${escHtml(msg)}</div></td></tr>`;
  const sub = $('userTblSubtitle');
  if (sub) sub.textContent = 'Data akun belum termuat';
}

// Dipanggil setelah data akun atau data BAP berubah
function refreshUsersView() {
  if (!usersLoaded) return;
  updateUsersStats();
  renderUsersTable();
}

// ── Statistik ────────────────────────────────────────────────────
function updateUsersStats() {
  const total = allUsers.length;
  const male = allUsers.filter(u => /^l/i.test(u.jenis_kelamin)).length;
  const female = allUsers.filter(u => /^p/i.test(u.jenis_kelamin)).length;
  const withBap = allUsers.filter(u => bapOfNik(u.nik).length > 0).length;
  const pct = n => total ? Math.round((n / total) * 100) + '%' : '0%';

  const set = (id, v) => { const el = $(id); if (el) el.textContent = v; };
  set('uc-total', total);
  set('uc-male', male);
  set('uc-female', female);
  set('uc-bap', withBap);
  set('tileUserTotalRatio', '100%');
  set('tileUserMaleRatio', pct(male));
  set('tileUserFemaleRatio', pct(female));
  set('tileUserBapRatio', pct(withBap));

  const badge = $('navUsersBadge');
  if (badge) badge.textContent = total;
  set('stripUsersCount', total);
}

// ── Filter, cari, halaman ────────────────────────────────────────
function getFilteredUsers() {
  const q = ($('userSearchInput')?.value || '').toLowerCase().trim();
  const gender = $('userFilterGender')?.value || '';
  const bap = $('userFilterBap')?.value || '';

  return allUsers.filter(u => {
    if (q) {
      const hay = `${u.nik} ${u.nama} ${u.tanggal_lahir} ${formatTglLahirUsia(u.tanggal_lahir)}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    if (gender && u.jenis_kelamin !== gender) return false;
    if (bap) {
      const n = bapOfNik(u.nik).length;
      if (bap === 'has_bap' && n === 0) return false;
      if (bap === 'no_bap' && n > 0) return false;
    }
    return true;
  });
}

function resetUserPageAndRender() {
  usersPage = 1;
  renderUsersTable();
}

function filterUsersFromTile(type) {
  const g = $('userFilterGender'), b = $('userFilterBap'), q = $('userSearchInput');
  if (g) g.value = '';
  if (b) b.value = '';
  if (q) q.value = '';
  if (type === 'Laki-laki' || type === 'Perempuan') { if (g) g.value = type; }
  if (type === 'has_bap') { if (b) b.value = 'has_bap'; }
  resetUserPageAndRender();
}

function changeUserPage(p) {
  usersPage = p;
  renderUsersTable();
}

// ── Render tabel ─────────────────────────────────────────────────
function renderUsersTable() {
  const tbody = $('userTableBody');
  if (!tbody) return;

  const list = getFilteredUsers();
  const total = list.length;
  const pages = Math.max(1, Math.ceil(total / USERS_PER_PAGE));
  if (usersPage > pages) usersPage = pages;
  const start = (usersPage - 1) * USERS_PER_PAGE;
  const slice = list.slice(start, start + USERS_PER_PAGE);

  const sub = $('userTblSubtitle');
  if (sub) sub.textContent = total === allUsers.length
    ? `${allUsers.length} akun terdaftar di sistem`
    : `${total} dari ${allUsers.length} akun sesuai filter`;

  if (!slice.length) {
    tbody.innerHTML = `<tr><td colspan="8"><div class="table-loader-state">${allUsers.length ? 'Tidak ada akun yang cocok dengan pencarian / filter.' : 'Belum ada akun pemohon yang terdaftar.'
      }</div></td></tr>`;
  } else {
    tbody.innerHTML = slice.map((u, i) => {
      const nBap = bapOfNik(u.nik).length;
      const bapPill = nBap
        ? `<span class="status-pill done"><span class="status-pill-dot"></span>${nBap} berkas BAP</span>`
        : `<span class="status-pill neutral"><span class="status-pill-dot"></span>Belum ada</span>`;
      const initial = (u.nama || 'U').trim().charAt(0).toUpperCase();
      const female = /^p/i.test(u.jenis_kelamin);
      const nik = escHtml(u.nik);
      return `
      <tr class="user-row" onclick="openUserDetail('${nik}')">
        <td>${start + i + 1}</td>
        <td><span class="user-nik-chip">${nik}</span></td>
        <td>
          <div class="user-cell">
            <span class="user-avatar ${female ? 'f' : 'm'}">${escHtml(initial)}</span>
            <span class="user-name">${highlight(u.nama || '-', ($('userSearchInput')?.value || '').trim())}</span>
          </div>
        </td>
        <td>${escHtml(formatTglLahirUsia(u.tanggal_lahir, true))}</td>
        <td>${escHtml(u.jenis_kelamin || '-')}</td>
        <td>${escHtml(String(u.waktu_daftar || '-').replace(/\s*WIB$/, ''))}</td>
        <td>${bapPill}</td>
        <td style="text-align:right" onclick="event.stopPropagation()">
          <div class="user-row-actions">
            <button class="tbl-action-btn" onclick="openUserDetail('${nik}')" title="Lihat detail akun">Detail</button>
            <button class="tbl-action-btn" onclick="openEditUserModal('${nik}')" title="Ubah data akun">Edit</button>
            <button class="tbl-action-btn" onclick="openResetPasswordModal('${nik}')" title="Ganti kata sandi">Sandi</button>
            <button class="tbl-action-btn danger" onclick="openDeleteUserModal('${nik}')" title="Hapus akun">Hapus</button>
          </div>
        </td>
      </tr>`;
    }).join('');
  }

  const info = $('userPgInfo');
  if (info) info.textContent = total
    ? `Menampilkan ${start + 1}–${start + slice.length} dari ${total} akun`
    : 'Tidak ada data akun';

  const pg = $('userPgBtns');
  if (pg) {
    if (pages <= 1) { pg.innerHTML = ''; }
    else {
      let h = `<button class="pg-btn" onclick="changeUserPage(${usersPage - 1})" ${usersPage <= 1 ? 'disabled' : ''} aria-label="Halaman sebelumnya">&lt;</button>`;
      const a = Math.max(1, usersPage - 2), b = Math.min(pages, a + 4);
      for (let n = a; n <= b; n++) h += `<button class="pg-btn ${n === usersPage ? 'active' : ''}" onclick="changeUserPage(${n})">${n}</button>`;
      h += `<button class="pg-btn" onclick="changeUserPage(${usersPage + 1})" ${usersPage >= pages ? 'disabled' : ''} aria-label="Halaman berikutnya">&gt;</button>`;
      pg.innerHTML = h;
    }
  }
}

// ── Modal detail akun ────────────────────────────────────────────
function openUserDetail(nik) {
  const u = findUser(nik);
  if (!u) return;
  activeUser = u;
  userPwVisible = false;

  const set = (id, v) => { const el = $(id); if (el) el.textContent = v; };
  set('udTitle', u.nama || '-');
  set('udNikBadge', 'NIK: ' + u.nik);
  set('udGenderBadge', u.jenis_kelamin || '-');
  set('udNik', u.nik);
  set('udNama', u.nama || '-');
  set('udTglLahir', formatTglLahirUsia(u.tanggal_lahir));
  set('udJk', u.jenis_kelamin || '-');
  set('udWaktuDaftar', u.waktu_daftar || '-');
  set('udPassword', 'Tersimpan Aman (SHA-256 Hashed)');

  const baps = bapOfNik(u.nik);
  set('udBapCountBadge', `${baps.length} Berkas Ditemukan`);
  const list = $('udBapList');
  if (list) {
    list.innerHTML = baps.length ? baps.map(r => `
      <div class="user-bap-item" onclick="openBapFromUser('${escKey(r._key)}')" title="Buka berkas BAP">
        <div>
          <div class="ubi-reg">${escHtml(r.reg || '-')}</div>
          <div class="ubi-meta">${escHtml(r.jenis_permohonan || '-')} · ${escHtml(formatTglFull(r.tanggal))}, ${escHtml(r.jam || '-')}</div>
        </div>
        ${badgeHtml(r.status, r.reschedule_status)}
      </div>`).join('')
      : `<div class="agenda-empty-state"><p>Akun ini belum pernah mengajukan pendaftaran BAP.</p></div>`;
  }

  $('userDetailOverlay').classList.add('show');
  document.body.style.overflow = 'hidden';
}

function closeUserDetailModal() {
  $('userDetailOverlay')?.classList.remove('show');
  if (!document.querySelector('#modalOverlay.show, #userFormOverlay.show, #userResetPassOverlay.show, #userDeleteOverlay.show')) {
    document.body.style.overflow = '';
  }
}

function openBapFromUser(key) {
  closeUserDetailModal();
  navTo('pendaftar', document.querySelector('[data-page=pendaftar]'));
  openModal(key);
}

function toggleUserPwVisibility() {
  showToast('info', 'Kata sandi pemohon disimpan dengan salt dan SHA-256 hash demi keamanan data.');
}

function copyUserNik() {
  if (!activeUser) return;
  navigator.clipboard.writeText(activeUser.nik)
    .then(() => showToast('success', 'NIK berhasil disalin'))
    .catch(() => showToast('error', 'Gagal menyalin NIK'));
}

// ── Tambah / Edit akun ───────────────────────────────────────────
function showUserForm() {
  $('userFormOverlay').classList.add('show');
  document.body.style.overflow = 'hidden';
}

function openAddUserModal() {
  userFormMode = 'create';
  activeUser = null;
  $('ufTitle').textContent = 'Tambah Akun Pemohon Baru';
  $('ufNik').value = ''; $('ufNik').disabled = false;
  $('ufNama').value = '';
  $('ufTglLahir').value = '';
  $('ufJk').value = 'Laki-laki';
  $('ufPassword').value = '';
  $('ufPassword').placeholder = 'Minimal 6 karakter...';
  $('btnSaveUser').textContent = 'Simpan Akun';
  showUserForm();
  setTimeout(() => $('ufNik').focus(), 50);
}

function openEditUserModal(nik) {
  const u = findUser(nik);
  if (!u) return;
  closeUserDetailModal();
  userFormMode = 'edit';
  activeUser = u;
  $('ufTitle').textContent = 'Ubah Data Akun Pemohon';
  $('ufNik').value = u.nik; $('ufNik').disabled = true;   // NIK = identitas akun, tidak boleh diubah
  $('ufNama').value = u.nama || '';
  $('ufTglLahir').value = tglLahirToInput(u.tanggal_lahir);
  $('ufJk').value = u.jenis_kelamin || 'Laki-laki';
  $('ufPassword').value = '';
  $('ufPassword').placeholder = 'Kosongkan jika tidak ingin mengganti sandi';
  $('btnSaveUser').textContent = 'Simpan Perubahan';
  showUserForm();
  setTimeout(() => $('ufNama').focus(), 50);
}

function openEditUserFromDetail() {
  if (activeUser) openEditUserModal(activeUser.nik);
}

function closeUserFormModal() {
  $('userFormOverlay')?.classList.remove('show');
  if (!document.querySelector('#modalOverlay.show, #userDetailOverlay.show, #userResetPassOverlay.show, #userDeleteOverlay.show')) {
    document.body.style.overflow = '';
  }
}

async function submitCreateUser() {
  if (userBusy) return;
  const nik = $('ufNik').value.trim();
  const nama = $('ufNama').value.trim();
  const tgl = $('ufTglLahir').value;
  const jk = $('ufJk').value;
  const pw = $('ufPassword').value.trim();
  const edit = userFormMode === 'edit';

  if (!edit && !/^\d{16}$/.test(nik)) return showToast('error', 'NIK harus tepat 16 digit angka');
  if (!nama) return showToast('error', 'Nama lengkap wajib diisi');
  if (!tgl) return showToast('error', 'Tanggal lahir wajib diisi');
  if (!edit && pw.length < 6) return showToast('error', 'Kata sandi minimal 6 karakter');
  if (edit && pw && pw.length < 6) return showToast('error', 'Kata sandi baru minimal 6 karakter');

  const idle = edit ? 'Simpan Perubahan' : 'Simpan Akun';
  setUserBusy('btnSaveUser', true, idle, 'Menyimpan...');
  try {
    const payload = edit
      ? { action: 'updateUser', nik: activeUser.nik, nama, tanggal_lahir: tgl, jenis_kelamin: jk, password: pw }
      : { action: 'adminAddUser', nik, nama, tanggal_lahir: tgl, jenis_kelamin: jk, password: pw };
    const json = await apiPost(payload);
    if (json.ok) {
      playSuccessChime();
      showToast('success', edit ? 'Data akun berhasil diperbarui' : `Akun ${nama} berhasil ditambahkan`);
      logActivity(edit ? 'Ubah Akun Pemohon' : 'Tambah Akun Pemohon', `${edit ? 'Memperbarui' : 'Menambah'} akun ${nama} (NIK ${edit ? activeUser.nik : nik}).`);
      closeUserFormModal();
      await loadUsers(false, true);
    } else if (!json.needLogin) {
      showToast('error', json.error || 'Gagal menyimpan akun');
    }
  } catch {
    showToast('error', 'Gagal terhubung ke server');
  }
  setUserBusy('btnSaveUser', false, idle, '');
}

// ── Reset kata sandi ─────────────────────────────────────────────
function openResetPasswordModal(nik) {
  const u = findUser(nik);
  if (!u) return;
  closeUserDetailModal();
  activeUser = u;
  $('urpSub').textContent = `Tetapkan kata sandi baru untuk ${u.nama} (NIK ${u.nik})`;
  $('urpNewPass').value = '';
  $('userResetPassOverlay').classList.add('show');
  document.body.style.overflow = 'hidden';
  setTimeout(() => $('urpNewPass').focus(), 50);
}

function openResetPasswordFromDetail() {
  if (activeUser) openResetPasswordModal(activeUser.nik);
}

function closeResetPasswordModal() {
  $('userResetPassOverlay')?.classList.remove('show');
  if (!document.querySelector('#modalOverlay.show, #userDetailOverlay.show, #userFormOverlay.show, #userDeleteOverlay.show')) {
    document.body.style.overflow = '';
  }
}

async function submitResetPassword() {
  if (userBusy || !activeUser) return;
  const pw = $('urpNewPass').value.trim();
  if (pw.length < 6) return showToast('error', 'Kata sandi minimal 6 karakter');

  setUserBusy('btnSavePass', true, 'Perbarui Sandi', 'Menyimpan...');
  try {
    const json = await apiPost({ action: 'updateUser', nik: activeUser.nik, password: pw });
    if (json.ok) {
      playSuccessChime();
      showToast('success', `Kata sandi akun ${activeUser.nama} berhasil diperbarui`);
      logActivity('Reset Kata Sandi', `Mengganti kata sandi akun ${activeUser.nama} (NIK ${activeUser.nik}).`);
      closeResetPasswordModal();
      await loadUsers(false, true);
    } else if (!json.needLogin) {
      showToast('error', json.error || 'Gagal memperbarui kata sandi');
    }
  } catch {
    showToast('error', 'Gagal terhubung ke server');
  }
  setUserBusy('btnSavePass', false, 'Perbarui Sandi', '');
}

// ── Hapus akun ───────────────────────────────────────────────────
function openDeleteUserModal(nik) {
  const u = findUser(nik);
  if (!u) return;
  closeUserDetailModal();
  activeUser = u;
  const nBap = bapOfNik(u.nik).length;
  $('userDeleteName').textContent = u.nama || '-';
  $('userDeleteNik').textContent = 'NIK: ' + u.nik;
  $('userDeleteWarning').textContent = nBap
    ? `Perhatian: akun ini memiliki ${nBap} berkas BAP. Menghapus akun hanya menutup akses login pemohon; data BAP tetap tersimpan di Data Pendaftar. Tindakan ini tidak dapat dibatalkan.`
    : 'Perhatian: Menghapus akun ini akan menghapus akses login pemohon ke portal SIPALARUS. Tindakan ini tidak dapat dibatalkan.';
  $('userDeleteOverlay').classList.add('show');
  document.body.style.overflow = 'hidden';
}

function openDeleteUserFromDetail() {
  if (activeUser) openDeleteUserModal(activeUser.nik);
}

function closeDeleteUserModal() {
  $('userDeleteOverlay')?.classList.remove('show');
  if (!document.querySelector('#modalOverlay.show, #userDetailOverlay.show, #userFormOverlay.show, #userResetPassOverlay.show')) {
    document.body.style.overflow = '';
  }
}

async function executeDeleteUser() {
  if (userBusy || !activeUser) return;
  const u = activeUser;
  setUserBusy('btnConfirmDeleteUser', true, 'Ya, Hapus Akun', 'Menghapus...');
  try {
    const json = await apiPost({ action: 'deleteUser', nik: u.nik, _rowIndex: u._rowIndex });
    if (json.ok) {
      allUsers = allUsers.filter(x => x.nik !== u.nik);
      playSuccessChime();
      showToast('success', `Akun ${u.nama} berhasil dihapus`);
      logActivity('Hapus Akun Pemohon', `Menghapus akun ${u.nama} (NIK ${u.nik}).`);
      closeDeleteUserModal();
      activeUser = null;
      refreshUsersView();
      loadUsers(false, true); // sinkron ulang karena nomor baris di sheet bergeser
    } else if (!json.needLogin) {
      showToast('error', json.error || 'Gagal menghapus akun');
    }
  } catch {
    showToast('error', 'Gagal terhubung ke server');
  }
  setUserBusy('btnConfirmDeleteUser', false, 'Ya, Hapus Akun', '');
}

// ── Ekspor Excel (tanpa kata sandi) ──────────────────────────────
function exportUsersExcel() {
  if (!allUsers.length) return showToast('error', 'Tidak ada data akun untuk diekspor');
  if (!window.XLSX) return showToast('error', 'Library Excel (XLSX) tidak tersedia');

  const rows = getFilteredUsers().map((u, i) => ({
    'No': i + 1,
    'NIK': u.nik,
    'Nama Lengkap': u.nama || '',
    'Tanggal Lahir': formatTglLahirUsia(u.tanggal_lahir),
    'Jenis Kelamin': u.jenis_kelamin || '',
    'Waktu Terdaftar': u.waktu_daftar || '',
    'Jumlah Berkas BAP': bapOfNik(u.nik).length,
  }));
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.json_to_sheet(rows);
  ws['!cols'] = [{ wch: 4 }, { wch: 18 }, { wch: 30 }, { wch: 24 }, { wch: 14 }, { wch: 22 }, { wch: 16 }];
  XLSX.utils.book_append_sheet(wb, ws, 'Akun Pemohon');

  const n = new Date();
  const dateStr = `${n.getFullYear()}${String(n.getMonth() + 1).padStart(2, '0')}${String(n.getDate()).padStart(2, '0')}`;
  XLSX.writeFile(wb, `Akun_Pemohon_SIPALARUS_${dateStr}.xlsx`);
  playSuccessChime();
  showToast('success', `Ekspor ${rows.length} akun pemohon berhasil`);
  logActivity('Ekspor Akun', `Mengunduh ${rows.length} akun pemohon.`);
}

/* ================================================================
   MODUL PUSAT AUDIT LOG & JEJAK KEAMANAN SISTEM
   ================================================================ */
let allAuditLogs = [];
let auditLoaded = false;
let auditCurrentPage = 1;
const AUDIT_PAGE_SIZE = 25;

async function loadAuditLogs(manual = false, silent = false) {
  const btn = $('refreshAuditBtn');
  if (btn) btn.classList.add('spinning');
  try {
    const res = await fetch(`${SHEET_URL}?action=getAuditLogs&token=${encodeURIComponent(getAdminToken())}&t=${Date.now()}`, { cache: 'no-store' });
    const json = await res.json();

    if (json && json.needLogin) { handleSessionExpired(); return; }
    if (!Array.isArray(json)) {
      if (!silent) showToast('error', (json && json.error) || 'Gagal memuat catatan log audit');
      renderAuditError((json && json.error) || 'Gagal memuat catatan log audit.');
      return;
    }

    allAuditLogs = json;
    auditLoaded = true;
    refreshAuditView();

    if (manual) {
      playSuccessChime();
      showToast('success', `${allAuditLogs.length} catatan audit log berhasil disinkronkan`);
      logActivity('Sinkronisasi Audit', `Memuat ${allAuditLogs.length} catatan audit log.`);
    }
  } catch (err) {
    console.error('loadAuditLogs error:', err);
    if (!silent) showToast('error', 'Koneksi gagal saat memuat log audit');
    renderAuditError('Koneksi ke server gagal. Tekan "Sinkron Log" untuk mencoba lagi.');
  } finally {
    if (btn) btn.classList.remove('spinning');
  }
}

function renderAuditError(msg) {
  if (auditLoaded) return;
  const tb = $('auditTableBody');
  if (tb) tb.innerHTML = `<tr><td colspan="7"><div class="table-loader-state error">${escHtml(msg)}</div></td></tr>`;
  const sub = $('auditTblSubtitle');
  if (sub) sub.textContent = 'Data log audit belum termuat';
}

function refreshAuditView() {
  if (!auditLoaded) return;
  updateAuditStats();
  renderAuditTable();
}

function updateAuditStats() {
  const total = allAuditLogs.length;
  const adminCount = allAuditLogs.filter(a => String(a.role).toUpperCase() === 'ADMIN').length;
  const userCount = allAuditLogs.filter(a => String(a.role).toUpperCase() === 'USER').length;
  const systemCount = allAuditLogs.filter(a => String(a.role).toUpperCase() === 'SYSTEM').length;
  const pct = n => total ? Math.round((n / total) * 100) + '%' : '0%';

  const set = (id, v) => { const el = $(id); if (el) el.textContent = v; };
  set('ac-total', total);
  set('ac-admin', adminCount);
  set('ac-user', userCount);
  set('ac-system', systemCount);
  set('tileAuditTotalRatio', '100%');
  set('tileAuditAdminRatio', pct(adminCount));
  set('tileAuditUserRatio', pct(userCount));
  set('tileAuditSystemRatio', pct(systemCount));

  const badge = $('navAuditBadge');
  if (badge) {
    badge.textContent = total;
    badge.style.display = total ? 'inline-block' : 'none';
  }
}

function getFilteredAuditLogs() {
  const q = ($('auditSearchInput')?.value || '').toLowerCase().trim();
  const role = ($('auditFilterRole')?.value || '').toUpperCase();
  const resFilter = ($('auditFilterResult')?.value || '').toUpperCase();

  return allAuditLogs.filter(a => {
    if (q) {
      const hay = `${a.timestamp} ${a.actor} ${a.role} ${a.action} ${a.target} ${a.result}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    if (role && String(a.role).toUpperCase() !== role) return false;
    if (resFilter) {
      const resVal = String(a.result || '').toUpperCase();
      if (resFilter === 'SUCCESS' && (resVal.includes('FAIL') || resVal.includes('ERROR') || resVal.includes('LOCKOUT'))) return false;
      if (resFilter === 'FAILED' && !resVal.includes('FAIL') && !resVal.includes('ERROR') && !resVal.includes('LOCKOUT')) return false;
    }
    return true;
  });
}

function resetAuditPageAndRender() {
  auditCurrentPage = 1;
  renderAuditTable();
}

function filterAuditFromTile(type) {
  const roleSelect = $('auditFilterRole');
  const resSelect = $('auditFilterResult');
  const searchInput = $('auditSearchInput');
  if (searchInput) searchInput.value = '';
  if (resSelect) resSelect.value = '';

  if (roleSelect) {
    if (type === 'all') roleSelect.value = '';
    else roleSelect.value = type;
  }
  resetAuditPageAndRender();
}

function renderAuditTable() {
  const tb = $('auditTableBody');
  if (!tb) return;

  const filtered = getFilteredAuditLogs();
  const total = filtered.length;

  const sub = $('auditTblSubtitle');
  if (sub) {
    sub.textContent = total
      ? `Menampilkan ${total} catatan log aktivitas dari total ${allAuditLogs.length} jejak audit.`
      : 'Tidak ada catatan log aktivitas yang cocok dengan filter.';
  }

  if (!total) {
    tb.innerHTML = `<tr><td colspan="7"><div class="table-empty-notice"><p>Tidak ada catatan log aktivitas yang sesuai kriteria pencarian.</p></div></td></tr>`;
    renderAuditPagination(0, 0);
    return;
  }

  const totalPages = Math.ceil(total / AUDIT_PAGE_SIZE);
  if (auditCurrentPage > totalPages) auditCurrentPage = totalPages;
  const start = (auditCurrentPage - 1) * AUDIT_PAGE_SIZE;
  const paged = filtered.slice(start, start + AUDIT_PAGE_SIZE);

  tb.innerHTML = paged.map((item, idx) => {
    const num = start + idx + 1;
    const roleUpper = String(item.role || '').toUpperCase();
    let roleBadge = '<span class="status-badge grey">SYSTEM</span>';
    if (roleUpper === 'ADMIN') roleBadge = '<span class="status-badge blue">ADMIN</span>';
    else if (roleUpper === 'USER') roleBadge = '<span class="status-badge green">USER</span>';

    const resStr = String(item.result || '').toUpperCase();
    let resBadge = '<span class="status-badge green">OK / SUCCESS</span>';
    if (resStr.includes('FAIL') || resStr.includes('ERROR') || resStr.includes('LOCKOUT') || resStr.includes('REJECT')) {
      resBadge = `<span class="status-badge red">${escHtml(item.result || 'FAILED')}</span>`;
    } else if (resStr.includes('PENDING')) {
      resBadge = `<span class="status-badge orange">${escHtml(item.result || 'PENDING')}</span>`;
    } else if (item.result) {
      resBadge = `<span class="status-badge green">${escHtml(item.result)}</span>`;
    }

    return `
      <tr>
        <td style="color:var(--text-muted);font-size:12px">${num}</td>
        <td style="font-family:monospace;font-size:12px;white-space:nowrap;color:var(--sky-400)">
          ${escHtml(item.timestamp || '-')}
        </td>
        <td style="font-weight:600;color:var(--text-primary)">
          ${escHtml(item.actor || '-')}
        </td>
        <td>${roleBadge}</td>
        <td>
          <span style="font-weight:600;font-family:monospace;font-size:12px">${escHtml(item.action || '-')}</span>
        </td>
        <td style="max-width:240px;word-break:break-word;font-size:13px;color:var(--text-secondary)">
          ${escHtml(item.target || '-')}
        </td>
        <td style="text-align:right">${resBadge}</td>
      </tr>
    `;
  }).join('');

  renderAuditPagination(total, totalPages);
}

function renderAuditPagination(total, totalPages) {
  const info = $('auditPgInfo');
  const btns = $('auditPgBtns');
  if (!info || !btns) return;

  if (!total) {
    info.textContent = 'Menampilkan 0 catatan';
    btns.innerHTML = '';
    return;
  }

  const start = (auditCurrentPage - 1) * AUDIT_PAGE_SIZE + 1;
  const end = Math.min(auditCurrentPage * AUDIT_PAGE_SIZE, total);
  info.textContent = `Menampilkan ${start} - ${end} dari ${total} catatan log`;

  let html = `<button class="pg-arrow-btn" ${auditCurrentPage === 1 ? 'disabled' : ''} onclick="changeAuditPage(${auditCurrentPage - 1})" aria-label="Halaman sebelumnya">&lt;</button>`;
  for (let i = 1; i <= totalPages; i++) {
    if (i === 1 || i === totalPages || (i >= auditCurrentPage - 2 && i <= auditCurrentPage + 2)) {
      html += `<button class="pg-num-btn ${i === auditCurrentPage ? 'active' : ''}" onclick="changeAuditPage(${i})">${i}</button>`;
    } else if (i === auditCurrentPage - 3 || i === auditCurrentPage + 3) {
      html += `<span class="pg-ellipsis">...</span>`;
    }
  }
  html += `<button class="pg-arrow-btn" ${auditCurrentPage === totalPages ? 'disabled' : ''} onclick="changeAuditPage(${auditCurrentPage + 1})" aria-label="Halaman berikutnya">&gt;</button>`;
  btns.innerHTML = html;
}

function changeAuditPage(p) {
  auditCurrentPage = p;
  renderAuditTable();
}

function exportAuditExcel() {
  const filtered = getFilteredAuditLogs();
  if (!filtered.length) return showToast('error', 'Tidak ada catatan log untuk diekspor');

  const rows = filtered.map((a, i) => ({
    'No': i + 1,
    'Waktu': a.timestamp || '',
    'Pelaku': a.actor || '',
    'Role': a.role || '',
    'Aksi': a.action || '',
    'Target': a.target || '',
    'Status Hasil': a.result || ''
  }));

  if (window.XLSX) {
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.json_to_sheet(rows);
    ws['!cols'] = [{ wch: 4 }, { wch: 22 }, { wch: 18 }, { wch: 12 }, { wch: 24 }, { wch: 28 }, { wch: 18 }];
    XLSX.utils.book_append_sheet(wb, ws, 'Audit Log');
    const n = new Date();
    const dateStr = `${n.getFullYear()}${String(n.getMonth() + 1).padStart(2, '0')}${String(n.getDate()).padStart(2, '0')}`;
    XLSX.writeFile(wb, `Audit_Log_SIPALARUS_${dateStr}.xlsx`);
    playSuccessChime();
    showToast('success', `Ekspor ${rows.length} catatan audit log berhasil`);
  } else {
    // Fallback export CSV
    const csvContent = 'data:text/csv;charset=utf-8,' +
      ['No,Waktu,Pelaku,Role,Aksi,Target,Hasil']
      .concat(rows.map(r => `"${r['No']}","${r['Waktu']}","${r['Pelaku']}","${r['Role']}","${r['Aksi']}","${r['Target']}","${r['Status Hasil']}"`))
      .join('\n');
    const encodedUri = encodeURI(csvContent);
    const link = document.createElement('a');
    link.setAttribute('href', encodedUri);
    link.setAttribute('download', `Audit_Log_SIPALARUS.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    showToast('success', `Ekspor CSV berhasil`);
  }
}

/* ================================================================
   MODUL MANAJEMEN JADWAL, HARI LIBUR & SESI KEDATANGAN
   ================================================================ */

function formatIndonesianDateStr(tglStr, withDay = true) {
  const s = String(tglStr || '').slice(0, 10);
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return tglStr || '-';
  const dateObj = new Date(parseInt(m[1], 10), parseInt(m[2], 10) - 1, parseInt(m[3], 10), 12, 0, 0);
  const dayName = DAYS_ID[dateObj.getDay()] || '';
  const d = parseInt(m[3], 10);
  const mo = MONTH_FULL[parseInt(m[2], 10) - 1];
  const y = m[1];
  return withDay ? `${dayName}, ${d} ${mo} ${y}` : `${d} ${mo} ${y}`;
}

function loadCachedScheduleSettings() {
  try {
    holidaySettings = JSON.parse(localStorage.getItem(HOLIDAY_KEY) || '{}');
  } catch {
    holidaySettings = {};
  }
  try {
    scheduleSettings = JSON.parse(localStorage.getItem(SCHEDULE_KEY) || '{}');
  } catch {
    scheduleSettings = {};
  }
  updateHolidayNavBadge();
}

function saveCachedScheduleSettings() {
  try {
    localStorage.setItem(HOLIDAY_KEY, JSON.stringify(holidaySettings));
    localStorage.setItem(SCHEDULE_KEY, JSON.stringify(scheduleSettings));
  } catch (e) {
    console.warn('Storage quota issue:', e);
  }
  updateHolidayNavBadge();
}

function updateHolidayNavBadge() {
  const badge = $('navHolidayBadge');
  if (!badge) return;
  const curPrefix = `${calCurrentYear}-${String(calCurrentMonth + 1).padStart(2, '0')}`;
  let count = 0;
  Object.keys(holidaySettings).forEach(d => {
    if (d.startsWith(curPrefix) && holidaySettings[d].is_holiday && !isWeekendDate(d)) count++;
  });
  if (count > 0) {
    badge.textContent = count;
    badge.style.display = 'inline-flex';
  } else {
    badge.style.display = 'none';
  }
}

const MAX_SLOT_QUOTA = 2;          // harus sama dengan MAX_PER_SLOT di Apps Script
let scheduleBusy = false;          // true selama ada perubahan yang sedang dikirim ke server

function isWeekendDate(dateStr) {
  const m = String(dateStr || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return false;
  const dow = new Date(+m[1], +m[2] - 1, +m[3], 12).getDay();
  return dow === 0 || dow === 6;
}

function snapshotSchedule() {
  return { hol: JSON.parse(JSON.stringify(holidaySettings)), sch: JSON.parse(JSON.stringify(scheduleSettings)) };
}

function restoreSchedule(snap) {
  holidaySettings = snap.hol;
  scheduleSettings = snap.sch;
  saveCachedScheduleSettings();
  renderScheduleCalendar();
  if (selectedScheduleDate) renderDayDetail(selectedScheduleDate);
}

// Kirim perubahan ke server. Hanya dianggap berhasil jika server menjawab ok:true.
async function pushSchedule(payload) {
  try {
    const res = await apiPost(payload);
    if (res && res.ok) return { ok: true };
    if (res && res.needLogin) return { ok: false, silent: true };
    return { ok: false, error: (res && res.error) || 'Server menolak perubahan.' };
  } catch (err) {
    return { ok: false, error: 'Tidak dapat terhubung ke server. Perubahan dibatalkan.' };
  }
}

async function syncScheduleSettings(manual = false) {
  const btn = $('btnSyncJadwal');
  if (btn) btn.classList.add('spinning');
  try {
    const res = await fetch(`${SHEET_URL}?action=getScheduleSettings&token=${encodeURIComponent(getAdminToken())}&t=${Date.now()}`, { cache: 'no-store' });
    const json = await res.json();

    if (json && json.needLogin) {
      handleSessionExpired();
      return;
    }

    if (json && json.ok) {
      // Server adalah sumber kebenaran: ganti seluruh state (bukan digabung dengan cache lama)
      const hol = {};
      (json.holidays || []).forEach(h => {
        hol[h.date] = {
          is_holiday: h.is_holiday === true,
          holiday_name: h.holiday_name || (h.is_holiday ? 'Hari Libur' : ''),
          updated_at: h.updated_at,
          updated_by: h.updated_by
        };
      });
      const sch = {};
      (json.schedules || []).forEach(x => {
        if (!sch[x.date]) sch[x.date] = {};
        sch[x.date][x.slot_id] = x.enabled !== false;
      });
      holidaySettings = hol;
      scheduleSettings = sch;
      scheduleSettingsLoaded = true;
      saveCachedScheduleSettings();

      if (manual) {
        playSuccessChime();
        showToast('success', 'Pengaturan jadwal & hari libur berhasil disinkronkan');
        logActivity('Sinkronisasi Jadwal', 'Memperbarui data hari libur dan konfigurasi sesi.');
      }
    } else if (manual) {
      playAlertChime();
      showToast('error', (json && json.error) || 'Server tidak mengirim data jadwal. Pastikan Apps Script sudah di-deploy ulang.');
    }
  } catch (err) {
    console.warn('Gagal sinkron jadwal dari backend, menggunakan data lokal:', err);
    if (manual) {
      playAlertChime();
      showToast('error', 'Koneksi ke server gagal. Menampilkan data tersimpan terakhir.');
    }
  } finally {
    if (btn) btn.classList.remove('spinning');
    renderScheduleCalendar();
    if (selectedScheduleDate) renderDayDetail(selectedScheduleDate);
  }
}

function initScheduleView() {
  loadCachedScheduleSettings();

  if (!selectedScheduleDate) {
    const now = new Date();
    // Default: gunakan bulan dan tahun hari ini jika sesuai atau pertahankan 2026
    calCurrentYear = now.getFullYear();
    calCurrentMonth = now.getMonth();
    selectedScheduleDate = `${calCurrentYear}-${String(calCurrentMonth + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  }

  renderScheduleCalendar();
  renderDayDetail(selectedScheduleDate);
  syncScheduleSettings(false);
}

function prevCalMonth() {
  calCurrentMonth--;
  if (calCurrentMonth < 0) {
    calCurrentMonth = 11;
    calCurrentYear--;
  }
  renderScheduleCalendar();
}

function nextCalMonth() {
  calCurrentMonth++;
  if (calCurrentMonth > 11) {
    calCurrentMonth = 0;
    calCurrentYear++;
  }
  renderScheduleCalendar();
}

function jumpCalToday() {
  const now = new Date();
  calCurrentYear = now.getFullYear();
  calCurrentMonth = now.getMonth();
  selectedScheduleDate = `${calCurrentYear}-${String(calCurrentMonth + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  renderScheduleCalendar();
  renderDayDetail(selectedScheduleDate);
}

function onMonthPickerChange(val) {
  if (!val) return;
  const parts = val.split('-');
  calCurrentYear = parseInt(parts[0], 10);
  calCurrentMonth = parseInt(parts[1], 10) - 1;
  renderScheduleCalendar();
}

function filterJadwalMonthHolidays() {
  const curPrefix = `${calCurrentYear}-${String(calCurrentMonth + 1).padStart(2, '0')}`;
  const dates = Object.keys(holidaySettings).filter(d => d.startsWith(curPrefix) && holidaySettings[d].is_holiday && !isWeekendDate(d)).sort();
  if (dates.length > 0) {
    selectScheduleDate(dates[0]);
  } else {
    showToast('info', 'Belum ada hari libur yang ditetapkan pada bulan ini.');
  }
}

function renderScheduleCalendar() {
  const grid = $('calDaysGrid');
  const title = $('calMonthDisplay');
  const picker = $('calMonthPicker');

  if (title) title.textContent = `${MONTH_FULL[calCurrentMonth]} ${calCurrentYear}`;
  if (picker) picker.value = `${calCurrentYear}-${String(calCurrentMonth + 1).padStart(2, '0')}`;
  if (!grid) return;

  const totalDays = new Date(calCurrentYear, calCurrentMonth + 1, 0).getDate();
  // Senin = 0 ... Minggu = 6
  let firstDayIndex = new Date(calCurrentYear, calCurrentMonth, 1).getDay() - 1;
  if (firstDayIndex === -1) firstDayIndex = 6;

  const now = new Date();
  const todayIso = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;

  // Hitung pendaftar per tanggal sekali saja
  const bookingByDate = {};
  allData.forEach(r => { if (r.tanggal) bookingByDate[r.tanggal] = (bookingByDate[r.tanggal] || 0) + 1; });

  let html = '';
  for (let e = 0; e < firstDayIndex; e++) html += '<div class="cal-day empty"></div>';

  let countHolidays = 0;   // hari libur pada hari kerja (Sen–Jum)
  let countWorkdays = 0;   // hari kerja aktif (Sen–Jum, bukan libur)
  let countWeekend = 0;
  let countPartial = 0;    // hari kerja dengan sebagian sesi ditutup
  let countBookings = 0;

  for (let day = 1; day <= totalDays; day++) {
    const dateStr = `${calCurrentYear}-${String(calCurrentMonth + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    const isWeekend = isWeekendDate(dateStr);
    const isToday = dateStr === todayIso;
    const isSelected = dateStr === selectedScheduleDate;

    const bookings = bookingByDate[dateStr] || 0;
    countBookings += bookings;

    const hol = holidaySettings[dateStr];
    const isHoliday = !!(hol && hol.is_holiday === true);
    const slots = scheduleSettings[dateStr] || {};
    const closedCount = ['A', 'B', 'C', 'D'].filter(id => slots[id] === false).length;
    const hasClosedSlot = closedCount > 0;

    let stateClass = '';
    let dot = '🟢';
    let label = '';
    let tip = 'Hari Kerja';

    if (isHoliday) {
      if (!isWeekend) countHolidays++;
      stateClass = 'holiday';
      dot = '🔴';
      tip = hol.holiday_name || 'Hari Libur';
      label = `<span class="cal-day-label" title="${escHtml(tip)}">${escHtml(tip)}</span>`;
    } else if (isWeekend) {
      countWeekend++;
      dot = '⚪';
      tip = 'Akhir pekan (tidak ada layanan)';
    } else {
      countWorkdays++;
      if (hasClosedSlot) {
        countPartial++;
        stateClass = 'partial-closed';
        dot = '🟡';
        tip = `${closedCount} sesi ditutup`;
        label = `<span class="cal-day-label partial">${closedCount} sesi tutup</span>`;
      }
    }

    const bookingBadge = bookings > 0
      ? `<span class="cal-day-bookings" title="${bookings} pemohon terdaftar">${bookings} pendaftar</span>` : '';

    html += `
      <div class="cal-day ${stateClass} ${isWeekend ? 'weekend-day' : ''} ${isToday ? 'today' : ''} ${isSelected ? 'selected' : ''}"
           data-date="${dateStr}" role="button" tabindex="0"
           aria-label="${day} ${MONTH_FULL[calCurrentMonth]}: ${escHtml(tip)}${bookings ? ', ' + bookings + ' pendaftar' : ''}"
           onclick="selectScheduleDate('${dateStr}')"
           onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();selectScheduleDate('${dateStr}')}">
        <div class="cal-day-top">
          <span class="cal-day-num">${day}</span>
          <span class="cal-indicator-dot" title="${escHtml(tip)}">${dot}</span>
        </div>
        ${label}
        ${bookingBadge}
      </div>`;
  }

  grid.innerHTML = html;

  const weekdays = countHolidays + countWorkdays;
  const holPct = weekdays ? Math.round((countHolidays / weekdays) * 100) : 0;
  const workPct = weekdays ? 100 - holPct : 0;
  const setEl = (id, val) => { const el = $(id); if (el) el.textContent = val; };
  setEl('statHolidayCount', countHolidays);
  setEl('statWorkdayCount', countWorkdays);
  setEl('statCustomClosedSlots', countPartial);
  setEl('statMonthBookings', countBookings);
  setEl('statHolidayRatio', holPct + '%');
  setEl('statWorkdayRatio', workPct + '%');

  updateHolidayNavBadge();
}

function selectScheduleDate(dateStr) {
  selectedScheduleDate = dateStr;

  $$('.cal-day').forEach(el => {
    el.classList.toggle('selected', el.getAttribute('data-date') === dateStr);
  });

  renderDayDetail(dateStr);
}

function renderDayDetail(dateStr) {
  if (!dateStr) return;
  const m = dateStr.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return;

  const dateObj = new Date(+m[1], +m[2] - 1, +m[3], 12, 0, 0);
  const setEl = (id, val) => { const el = $(id); if (el) el.textContent = val; };
  setEl('ddcDayTag', DAYS_ID[dateObj.getDay()] || '');
  setEl('ddcDateTitle', `${+m[3]} ${MONTH_FULL[+m[2] - 1]} ${m[1]}`);
  setEl('ddcIsoDate', dateStr);

  const hol = holidaySettings[dateStr];
  const isHoliday = !!(hol && hol.is_holiday === true);
  const isWeekend = isWeekendDate(dateStr);
  const dayBookings = allData.filter(r => r.tanggal === dateStr);

  const pill = $('ddcStatusPill'), pillTxt = $('ddcStatusText');
  const btnWork = $('btnSetWorkday'), btnHol = $('btnSetHoliday');
  const holGroup = $('holidayNameGroup'), holInput = $('holidayNameInput');
  const holBanner = $('scsHolidayBanner');

  let bannerText = '';
  if (isHoliday) {
    if (pill) pill.className = 'day-status-pill red';
    if (pillTxt) pillTxt.textContent = 'HARI LIBUR';
    if (btnWork) btnWork.className = 'btn-day-status';
    if (btnHol) btnHol.className = 'btn-day-status active-holiday';
    if (holGroup) holGroup.style.display = 'block';
    if (holInput && document.activeElement !== holInput) holInput.value = hol.holiday_name || 'Hari Libur';
    bannerText = '🔴 SELURUH SESI DITUTUP (HARI LIBUR)';
  } else if (isWeekend) {
    if (pill) pill.className = 'day-status-pill gray';
    if (pillTxt) pillTxt.textContent = 'AKHIR PEKAN';
    if (btnWork) btnWork.className = 'btn-day-status';
    if (btnHol) btnHol.className = 'btn-day-status';
    if (holGroup) holGroup.style.display = 'none';
    bannerText = '⚪ TIDAK ADA LAYANAN PADA SABTU & MINGGU';
  } else {
    if (pill) pill.className = 'day-status-pill green';
    if (pillTxt) pillTxt.textContent = 'HARI KERJA';
    if (btnWork) btnWork.className = 'btn-day-status active-work';
    if (btnHol) btnHol.className = 'btn-day-status';
    if (holGroup) holGroup.style.display = 'none';
  }

  if (holBanner) {
    if (isHoliday && dayBookings.length) bannerText += ` • ${dayBookings.length} pemohon sudah terdaftar`;
    holBanner.textContent = bannerText;
    holBanner.style.display = bannerText ? 'block' : 'none';
  }
  [btnWork, btnHol].forEach(b => { if (b) b.disabled = scheduleBusy; });

  // Sesi A–D
  const slotMap = scheduleSettings[dateStr] || {};
  const locked = isHoliday || isWeekend;
  ['A', 'B', 'C', 'D'].forEach(sId => {
    const card = $('scc-' + sId), toggle = $('toggle-slot-' + sId);
    const txt = $('txt-slot-' + sId);

    const enabled = slotMap[sId] !== false;
    if (toggle) {
      toggle.checked = enabled;
      toggle.disabled = locked || scheduleBusy;
    }
    if (card) card.classList.toggle('disabled-by-holiday', locked);
    if (txt) {
      if (isHoliday) { txt.textContent = 'Libur'; txt.className = 'scc-state-text libur'; }
      else if (isWeekend) { txt.textContent = 'Akhir Pekan'; txt.className = 'scc-state-text libur'; }
      else if (!enabled) { txt.textContent = 'Ditutup'; txt.className = 'scc-state-text off'; }
      else { txt.textContent = 'Aktif'; txt.className = 'scc-state-text'; }
    }
  });

  // Daftar pemohon
  const appList = $('ddcApplicantsList'), appCount = $('ddcApplicantsCount');
  if (appCount) appCount.textContent = `${dayBookings.length} Pemohon`;
  if (appList) {
    appList.innerHTML = !dayBookings.length
      ? '<div class="drs-empty">Tidak ada pemohon terdaftar pada tanggal ini.</div>'
      : dayBookings.map(r => `
        <div class="drs-item" onclick="openApplicantFromSchedule('${escKey(r._key)}')" title="Buka berkas pemohon">
          <div>
            <div class="drs-item-name">${escHtml(r.nama)} <span class="drs-reg">(${escHtml(r.reg || '-')})</span></div>
            <div class="drs-item-meta">${escHtml(r.jam || 'Sesi ?')} &bull; ${escHtml(r.jenis_permohonan || '-')}</div>
          </div>
          <span class="status-badge-modern s-${escHtml((r.status || 'Menunggu').toLowerCase().replace(/\s+/g, '-'))}">${escHtml(r.status || 'Menunggu')}</span>
        </div>`).join('');
  }
}

function openApplicantFromSchedule(key) {
  navTo('pendaftar', document.querySelector('[data-page=pendaftar]'));
  openModal(key);
}

function officerName() { return (getSession() || {}).displayName || 'Petugas'; }

async function handleSetHolidayClick() {
  if (!selectedScheduleDate || scheduleBusy) return;
  if (isWeekendDate(selectedScheduleDate) && !(holidaySettings[selectedScheduleDate] || {}).is_holiday) {
    showToast('info', 'Sabtu & Minggu otomatis tidak ada layanan, tidak perlu ditetapkan sebagai hari libur.');
    return;
  }
  if ((holidaySettings[selectedScheduleDate] || {}).is_holiday) {
    showToast('info', 'Tanggal ini sudah berstatus Hari Libur.');
    return;
  }

  const date = selectedScheduleDate;
  const dateFmt = formatIndonesianDateStr(date, true);
  const customName = ($('holidayNameInput')?.value || '').trim() || 'Hari Libur';
  const existing = allData.filter(r => r.tanggal === date).length;

  let warn = 'Seluruh sesi pada tanggal ini akan ditutup dan pemohon tidak dapat memilih tanggal tersebut.';
  if (existing > 0) warn += `\n\nPERHATIAN: sudah ada ${existing} pemohon terdaftar pada tanggal ini. Mereka perlu diberi tahu / dijadwalkan ulang.`;

  const ok = await showConfirm({
    title: `Jadikan ${dateFmt} sebagai hari libur?`, msg: warn,
    icon: 'HARI LIBUR', okText: 'Jadikan Hari Libur', cancelText: 'Batal'
  });
  if (!ok) return;

  const snap = snapshotSchedule();
  scheduleBusy = true;
  holidaySettings[date] = { is_holiday: true, holiday_name: customName, updated_at: new Date().toISOString(), updated_by: officerName() };
  renderScheduleCalendar(); renderDayDetail(date);

  const r = await pushSchedule({ action: 'saveHoliday', date, is_holiday: true, holiday_name: customName });
  scheduleBusy = false;
  if (r.ok) {
    saveCachedScheduleSettings();
    playSuccessChime();
    showToast('success', `${dateFmt} ditetapkan sebagai hari libur.`);
    logActivity('SET_HOLIDAY', `${date} ditetapkan sebagai ${customName}.`);
    renderDayDetail(date);
  } else {
    restoreSchedule(snap);
    if (!r.silent) { playAlertChime(); showToast('error', r.error); }
  }
}

async function handleSetWorkdayClick() {
  if (!selectedScheduleDate || scheduleBusy) return;
  const date = selectedScheduleDate;
  const hol = holidaySettings[date];
  if (!hol || !hol.is_holiday) {
    showToast('info', isWeekendDate(date) ? 'Sabtu & Minggu tidak ada layanan BAP.' : 'Tanggal ini sudah berstatus Hari Kerja.');
    return;
  }
  const dateFmt = formatIndonesianDateStr(date, true);
  const ok = await showConfirm({
    title: `Kembalikan ${dateFmt} menjadi Hari Kerja?`,
    msg: 'Status hari libur dicabut dan konfigurasi sesi kedatangan sebelumnya diaktifkan kembali.',
    icon: 'HARI KERJA', okText: 'Jadikan Hari Kerja', cancelText: 'Batal'
  });
  if (!ok) return;

  const snap = snapshotSchedule();
  scheduleBusy = true;
  holidaySettings[date] = { is_holiday: false, holiday_name: '', updated_at: new Date().toISOString(), updated_by: officerName() };
  renderScheduleCalendar(); renderDayDetail(date);

  const r = await pushSchedule({ action: 'removeHoliday', date });
  scheduleBusy = false;
  if (r.ok) {
    saveCachedScheduleSettings();
    playSuccessChime();
    showToast('success', `${dateFmt} diubah menjadi hari kerja.`);
    logActivity('REMOVE_HOLIDAY', `${date} diubah kembali menjadi Hari Kerja.`);
    renderDayDetail(date);
  } else {
    restoreSchedule(snap);
    if (!r.silent) { playAlertChime(); showToast('error', r.error); }
  }
}

async function saveHolidayName() {
  if (!selectedScheduleDate || scheduleBusy) return;
  const date = selectedScheduleDate;
  if (!(holidaySettings[date] || {}).is_holiday) {
    showToast('warning', 'Jadikan tanggal ini sebagai Hari Libur terlebih dahulu.');
    return;
  }
  const name = ($('holidayNameInput')?.value || '').trim() || 'Hari Libur';

  const snap = snapshotSchedule();
  scheduleBusy = true;
  holidaySettings[date].holiday_name = name;
  renderScheduleCalendar(); renderDayDetail(date);

  const r = await pushSchedule({ action: 'saveHoliday', date, is_holiday: true, holiday_name: name });
  scheduleBusy = false;
  if (r.ok) {
    saveCachedScheduleSettings();
    playSuccessChime();
    showToast('success', `Nama hari libur diperbarui: ${name}`);
    logActivity('UPDATE_HOLIDAY_NAME', `${date} -> ${name}`);
    renderDayDetail(date);
  } else {
    restoreSchedule(snap);
    if (!r.silent) { playAlertChime(); showToast('error', r.error); }
  }
}

async function handleSlotToggle(slotId, enabled) {
  if (!selectedScheduleDate || scheduleBusy) return;
  const date = selectedScheduleDate;

  const snap = snapshotSchedule();
  scheduleBusy = true;
  if (!scheduleSettings[date]) scheduleSettings[date] = {};
  scheduleSettings[date][slotId] = enabled;
  renderScheduleCalendar(); renderDayDetail(date);

  const r = await pushSchedule({ action: 'saveSlotSettings', date, slot_id: slotId, enabled });
  scheduleBusy = false;
  if (r.ok) {
    saveCachedScheduleSettings();
    const st = enabled ? 'dibuka kembali' : 'ditutup';
    showToast('success', `Sesi ${slotId} pada ${formatIndonesianDateStr(date, false)} ${st}.`);
    logActivity('PENGATURAN_SESI', `${date} Sesi ${slotId} -> ${enabled ? 'Aktif' : 'Ditutup'}`);
    renderDayDetail(date);
  } else {
    restoreSchedule(snap);   // kembalikan toggle ke posisi semula
    if (!r.silent) { playAlertChime(); showToast('error', r.error); }
  }
}

/* ── BULK HOLIDAYS (ATUR HARI LIBUR MASSAL) ── */

function openBulkHolidayModal() {
  const modal = $('bulkHolidayModal');
  if (!modal) return;

  bulkSelectedDates.clear();

  const selMonthInput = $('bulkMonthSelect');
  if (selMonthInput) {
    selMonthInput.value = `${calCurrentYear}-${String(calCurrentMonth + 1).padStart(2, '0')}`;
  }

  renderBulkDateCheckboxes(`${calCurrentYear}-${String(calCurrentMonth + 1).padStart(2, '0')}`);
  modal.classList.add('show');
  document.body.style.overflow = 'hidden';
}

function closeBulkHolidayModal() {
  const modal = $('bulkHolidayModal');
  if (modal) modal.classList.remove('show');
  document.body.style.overflow = '';
}

function renderBulkDateCheckboxes(monthStr) {
  const container = $('bulkDatesGrid');
  if (!container || !monthStr) return;

  const parts = monthStr.split('-');
  const y = parseInt(parts[0], 10);
  const m = parseInt(parts[1], 10) - 1;
  const totalDays = new Date(y, m + 1, 0).getDate();

  let html = '';
  for (let day = 1; day <= totalDays; day++) {
    const dateObj = new Date(y, m, day);
    const dayOfWeek = dateObj.getDay();
    const isWeekend = (dayOfWeek === 0 || dayOfWeek === 6);
    const dStr = `${y}-${String(m + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    const hol = holidaySettings[dStr];
    const isAlreadyHol = hol && hol.is_holiday;

    const checkedAttr = bulkSelectedDates.has(dStr) ? 'checked' : '';
    const dayLabel = `${day} ${MONTH_SHORT[m]} (${DAYS_ID[dayOfWeek].slice(0, 3)})`;

    html += `
      <label class="bhm-date-checkbox ${isWeekend ? 'is-weekend' : ''} ${isAlreadyHol ? 'already-holiday' : ''}" title="${isAlreadyHol ? (hol.holiday_name || 'Hari Libur') : ''}">
        <input type="checkbox" value="${dStr}" ${checkedAttr} onchange="toggleBulkDate('${dStr}', this.checked)">
        <span>${dayLabel}</span>
      </label>
    `;
  }

  container.innerHTML = html;
  updateBulkSelectedCount();
}

function toggleBulkDate(dateStr, isChecked) {
  if (isChecked) bulkSelectedDates.add(dateStr);
  else bulkSelectedDates.delete(dateStr);
  updateBulkSelectedCount();
}

function updateBulkSelectedCount() {
  const el = $('bulkSelectedCount');
  if (el) el.textContent = bulkSelectedDates.size;
}

function bulkSelectWeekendsOnly() {
  const selMonthInput = $('bulkMonthSelect');
  if (!selMonthInput) return;
  const parts = selMonthInput.value.split('-');
  const y = parseInt(parts[0], 10);
  const m = parseInt(parts[1], 10) - 1;
  const totalDays = new Date(y, m + 1, 0).getDate();

  bulkSelectedDates.clear();
  for (let day = 1; day <= totalDays; day++) {
    const dObj = new Date(y, m, day);
    if (dObj.getDay() === 0 || dObj.getDay() === 6) {
      const dStr = `${y}-${String(m + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      bulkSelectedDates.add(dStr);
    }
  }
  renderBulkDateCheckboxes(selMonthInput.value);
}

function bulkSelectAllMonth() {
  const selMonthInput = $('bulkMonthSelect');
  if (!selMonthInput) return;
  const parts = selMonthInput.value.split('-');
  const y = parseInt(parts[0], 10);
  const m = parseInt(parts[1], 10) - 1;
  const totalDays = new Date(y, m + 1, 0).getDate();

  bulkSelectedDates.clear();
  for (let day = 1; day <= totalDays; day++) {
    const dStr = `${y}-${String(m + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    bulkSelectedDates.add(dStr);
  }
  renderBulkDateCheckboxes(selMonthInput.value);
}

function bulkDeselectAll() {
  bulkSelectedDates.clear();
  const selMonthInput = $('bulkMonthSelect');
  if (selMonthInput) renderBulkDateCheckboxes(selMonthInput.value);
}

async function submitBulkHolidays(isHoliday) {
  if (scheduleBusy) return;
  if (!bulkSelectedDates.size) {
    showToast('error', 'Pilih minimal satu tanggal.');
    return;
  }

  const holName = ($('bulkHolidayNameInput')?.value || '').trim() || 'Hari Libur';
  const dates = Array.from(bulkSelectedDates).sort();
  const impacted = isHoliday ? allData.filter(r => bulkSelectedDates.has(r.tanggal)).length : 0;

  let msg = `Sebanyak ${dates.length} tanggal akan ${isHoliday ? `ditetapkan sebagai Hari Libur (${holName})` : 'dikembalikan menjadi Hari Kerja'}.`;
  if (impacted > 0) msg += `\n\nPERHATIAN: ${impacted} pemohon sudah terdaftar pada tanggal-tanggal tersebut.`;

  const ok = await showConfirm({
    title: `Terapkan Pengaturan Massal (${dates.length} Tanggal)?`, msg,
    icon: isHoliday ? 'HARI LIBUR' : 'HARI KERJA', okText: 'Terapkan', cancelText: 'Batal'
  });
  if (!ok) return;

  const btns = [$('btnApplyBulkHoliday'), $('btnRemoveBulkHoliday')];
  btns.forEach(b => { if (b) b.disabled = true; });

  const snap = snapshotSchedule();
  scheduleBusy = true;
  dates.forEach(d => {
    holidaySettings[d] = {
      is_holiday: isHoliday, holiday_name: isHoliday ? holName : '',
      updated_at: new Date().toISOString(), updated_by: officerName()
    };
  });
  renderScheduleCalendar();
  if (selectedScheduleDate) renderDayDetail(selectedScheduleDate);

  const r = await pushSchedule({ action: 'bulkHolidays', dates, holiday_name: holName, is_holiday: isHoliday });
  scheduleBusy = false;
  btns.forEach(b => { if (b) b.disabled = false; });

  if (r.ok) {
    saveCachedScheduleSettings();
    playSuccessChime();
    showToast('success', `${dates.length} tanggal berhasil ${isHoliday ? 'ditetapkan sebagai Hari Libur' : 'dikembalikan menjadi Hari Kerja'}.`);
    logActivity(isHoliday ? 'BULK_SET_HOLIDAY' : 'BULK_REMOVE_HOLIDAY',
      `${dates.length} tanggal: ${dates.slice(0, 5).join(', ')}${dates.length > 5 ? '...' : ''}`);
    if (selectedScheduleDate) renderDayDetail(selectedScheduleDate);
    closeBulkHolidayModal();
  } else {
    restoreSchedule(snap);   // modal tetap terbuka agar petugas bisa mencoba lagi
    if (!r.silent) { playAlertChime(); showToast('error', r.error); }
  }
}
