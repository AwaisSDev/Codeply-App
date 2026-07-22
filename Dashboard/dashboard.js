/**
 * Codeply Dashboard — Renderer (Supabase + Google-like UI)
 */

let usage    = { totalTokens: 0, totalRequests: 0, sessions: [], history: [] };
let settings = {};
let currentUser = null;   // { id, email, name, avatar } or null
let watchData   = { folder: '', activeFile: null };
let refreshTimer = null;
let subStatus   = { allowed: true, reason: 'ok', plan: 'free' };
let oauthPending = false;
let oauthPollTimer = null;
let oauthStartedAt = 0;
let otpPending  = null;   // { email, mode } while the 6-digit code step is showing

// ─── Init ──────────────────────────────────────────────────────────────────────
function bindClick(id, handler) {
  const el = document.getElementById(id);
  if (!el) return;
  el.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    handler(e);
  });
}

function requireCodeply() {
  if (!window.codeply) throw new Error('Codeply bridge unavailable');
  return window.codeply;
}

async function initDashboard() {
  wireAllHandlers();

  const codeply = requireCodeply();
  settings = await codeply.getSettings();
  usage    = await codeply.getUsage();
  try { watchData = await codeply.getWatch(); } catch {}

  try { currentUser = await codeply.auth.getSession(); } catch {}
  codeply.auth.onCallback(handleAuthCallback);

  if (currentUser) {
    updateUserUI();
    // Route through the same onboarding gate a fresh sign-in would use — a
    // returning session (persisted from a previous run) must not skip it.
    proceedAfterLogin();
  }

  await refreshSubscription();
  populateSettings();
  renderOverview();
  // Load cloud history then render (overview + history both depend on it)
  loadCloudHistoryData().then(() => { renderHistory(); renderOverview(); });
  renderSubscriptionPage();
  renderWatchCard();
  initUpdater();
  initAdmin();

  refreshTimer = setInterval(liveRefresh, 5000);
  window.addEventListener('focus', () => { if (oauthPending) pollOAuthSession(); });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && oauthPending) pollOAuthSession();
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    initDashboard().catch(err => {
      console.error('[Dashboard] init failed:', err);
      setLoginError?.('Dashboard failed to start. Restart the app.');
    });
  });
} else {
  initDashboard().catch(err => console.error('[Dashboard] init failed:', err));
}

// ─── In-app updater (full-page update flow, no native notifications) ────────────
function initUpdater() {
  const cp = window.codeply;
  if (!cp || !cp.updater) return;

  const $ = (id) => document.getElementById(id);
  const overlay = $('updateOverlay');
  if (!overlay) return;

  const fmtBytes = (b) => {
    if (!b) return '0 MB';
    const mb = b / (1024 * 1024);
    return mb >= 1 ? mb.toFixed(1) + ' MB' : (b / 1024).toFixed(0) + ' KB';
  };

  function setStage(stage, data = {}) {
    const title   = $('upTitle'),       sub     = $('upSub'),      ver     = $('upVersion');
    const prog    = $('upProgressWrap'), install = $('upInstallBtn');
    const restart = $('upRestartBtn'),   err     = $('upError'),    retry   = $('upRetryBtn');

    // Hide everything, then reveal what this stage needs.
    prog.style.display = 'none';
    install.style.display = 'none';
    restart.style.display = 'none';
    retry.style.display = 'none';
    err.style.display = 'none';

    if (stage === 'available') {
      title.textContent = 'Update Required';
      sub.textContent = 'A new version of Codeply is available. Install it to continue with the latest fixes and features.';
      if (data.version) { ver.textContent = 'Version ' + data.version; ver.style.display = 'block'; }
      install.style.display = 'flex';
    } else if (stage === 'downloading') {
      title.textContent = 'Installing Update';
      sub.textContent = 'Downloading the latest version. Please keep Codeply open until it finishes.';
      prog.style.display = 'block';
    } else if (stage === 'downloaded') {
      title.textContent = 'Update Ready';
      sub.textContent = 'The update has been installed. Restart Codeply to finish and start using the new version.';
      restart.style.display = 'flex';
    } else if (stage === 'error') {
      title.textContent = 'Update Failed';
      sub.textContent = 'Something went wrong while updating. You can try again.';
      err.textContent = data.message || 'Unknown error';
      err.style.display = 'block';
      retry.style.display = 'block';
    }
    overlay.style.display = 'flex';
  }

  async function startDownload() {
    setStage('downloading');
    $('upProgressBar').style.width = '0%';
    $('upProgressPct').textContent = '0%';
    $('upProgressMeta').textContent = '';
    try {
      const r = await cp.updater.download();
      if (r && r.ok === false && r.reason !== 'dev') setStage('error', { message: r.error || 'Download failed' });
    } catch (e) {
      setStage('error', { message: e.message });
    }
  }

  // Main → renderer update events
  cp.updater.onAvailable((d) => setStage('available', d));
  cp.updater.onProgress((p) => {
    if (overlay.style.display !== 'flex' || $('upProgressWrap').style.display === 'none') setStage('downloading');
    const pct = Math.max(0, Math.min(100, p.percent || 0));
    $('upProgressBar').style.width = pct + '%';
    $('upProgressPct').textContent = pct + '%';
    const speed = p.bytesPerSecond ? ' · ' + fmtBytes(p.bytesPerSecond) + '/s' : '';
    $('upProgressMeta').textContent = fmtBytes(p.transferred) + ' / ' + fmtBytes(p.total) + speed;
  });
  cp.updater.onDownloaded((d) => setStage('downloaded', d));
  cp.updater.onError((d) => setStage('error', d));
  // UI hot-update applied live (no restart) — just a small confirmation toast.
  cp.updater.onUiUpdated?.((d) => showToast(`Updated to the latest version${d?.version ? ' (UI v' + d.version + ')' : ''}`, 'success'));

  // Buttons
  bindClick('upInstallBtn', startDownload);
  bindClick('upRetryBtn', startDownload);
  bindClick('upRestartBtn', async () => {
    const btn = $('upRestartBtn');
    btn.textContent = 'Restarting…';
    btn.disabled = true;
    try { await cp.updater.install(); } catch (e) { setStage('error', { message: e.message }); }
  });
}

// ─── Bug reports / admin ────────────────────────────────────────────────────────
async function initAdmin() {
  try {
    const { isAdmin } = await window.codeply.admin.check();
    const nav = document.getElementById('navAdmin');
    if (!isAdmin || !nav) return;
    nav.style.display = 'flex';
    const bugs = await window.codeply.bugs.list();
    const open = bugs.filter(b => b.status !== 'closed' && b.status !== 'resolved').length;
    const badge = document.getElementById('adminBugBadge');
    if (badge && open > 0) { badge.textContent = open; badge.style.display = 'inline-block'; }
  } catch {}
}

async function loadBugReports() {
  const wrap = document.getElementById('bugListWrap');
  if (!wrap) return;
  wrap.innerHTML = '<div class="empty-state">Loading…</div>';
  let bugs = [];
  try { bugs = await window.codeply.bugs.list(); } catch {}
  if (!bugs.length) {
    wrap.innerHTML = '<div class="empty-state"><span class="icon">🐞</span>No bug reports yet.</div>';
    return;
  }
  wrap.innerHTML = `<table class="history-table">
    <thead><tr><th>When</th><th>From</th><th>Title</th><th>Details</th><th>Ver</th><th>Status</th></tr></thead>
    <tbody>${bugs.map(b => `
      <tr>
        <td class="td-time">${relTime(b.created_at)}</td>
        <td class="td-file">${escHtml(b.user_email || '')}</td>
        <td style="font-weight:600;color:var(--text)">${escHtml(b.title || '')}</td>
        <td style="max-width:300px;white-space:normal;color:var(--text2);font-size:0.8rem">${escHtml(b.description || '')}</td>
        <td class="badge-model">${escHtml(b.app_version || '')}</td>
        <td>
          <select class="bug-status" data-id="${b.id}" style="height:28px;border-radius:6px;border:1px solid var(--border-light);font-size:0.72rem;padding:0 6px">
            ${['open','in-progress','resolved','closed'].map(s => `<option value="${s}" ${b.status===s?'selected':''}>${s}</option>`).join('')}
          </select>
        </td>
      </tr>`).join('')}</tbody></table>`;
  wrap.querySelectorAll('.bug-status').forEach(sel => {
    sel.addEventListener('change', async () => {
      await window.codeply.bugs.setStatus(sel.dataset.id, sel.value);
      showToast('Status updated', 'success');
    });
  });
}

async function loadReferralSources() {
  const wrap = document.getElementById('referralListWrap');
  const breakdown = document.getElementById('referralBreakdown');
  if (!wrap) return;
  wrap.innerHTML = '<div class="empty-state">Loading…</div>';
  if (breakdown) breakdown.innerHTML = '';
  let rows = [];
  try { rows = await window.codeply.admin.referrals(); } catch {}
  if (!rows.length) {
    wrap.innerHTML = '<div class="empty-state"><span class="icon">📍</span>No referral data yet.</div>';
    return;
  }

  // Breakdown chips: count per source.
  const counts = {};
  rows.forEach(r => {
    const key = (r.referral_source || 'Unknown').trim() || 'Unknown';
    counts[key] = (counts[key] || 0) + 1;
  });
  if (breakdown) {
    breakdown.innerHTML = Object.entries(counts)
      .sort((a, b) => b[1] - a[1])
      .map(([source, n]) => `
        <div style="display:flex;align-items:center;gap:6px;padding:6px 12px;border-radius:20px;background:var(--bg-soft, #f4f4f6);border:1px solid var(--border-light);font-size:0.78rem">
          <span style="font-weight:600;color:var(--text)">${escHtml(source)}</span>
          <span style="color:var(--text2)">${n}</span>
        </div>`).join('');
  }

  wrap.innerHTML = `<table class="history-table">
    <thead><tr><th>Signed up</th><th>User ID</th><th>Came from</th></tr></thead>
    <tbody>${rows.map(r => `
      <tr>
        <td class="td-time">${relTime(r.created_at)}</td>
        <td class="td-file" title="${escHtml(r.id || '')}">${escHtml((r.id || '').slice(0, 8))}</td>
        <td style="font-weight:600;color:var(--text)">${escHtml(r.referral_source || 'Unknown')}</td>
      </tr>`).join('')}</tbody></table>`;
}

// ─── Live refresh ──────────────────────────────────────────────────────────────
async function liveRefresh() {
  try {
    usage     = await window.codeply.getUsage();
    watchData = await window.codeply.getWatch();
    // Keep the signed-in account's cloud numbers fresh so the overview and badge
    // reflect new requests without needing a manual page switch.
    if (currentUser) await loadCloudHistoryData();
  } catch { return; }
  const activePage = document.querySelector('.page.active');
  if (activePage?.id === 'page-overview') renderOverview();
  renderWatchCard();
  document.getElementById('historyBadge').textContent = dashHistoryCount();
}

async function refreshSubscription() {
  try { subStatus = await window.codeply.subscription.check(); } catch { subStatus = { allowed: true, reason: 'error' }; }
  updatePaywallUI();
}

// ─── Subscription / Paywall ────────────────────────────────────────────────────
function updatePaywallUI() {
  const overlay = document.getElementById('paywallOverlay');
  if (!subStatus.allowed) {
    overlay.classList.add('show');
    document.getElementById('paywallTitle').textContent =
      subStatus.reason === 'kill_switch' ? 'Subscription Required' : 'Codeply Pro Required';
    document.getElementById('paywallSub').textContent =
      subStatus.message || 'Subscribe to continue using Codeply.';
    // If kill_switch, hide price — this is an admin thing
    const isMaint = subStatus.reason === 'kill_switch';
    document.getElementById('paywallPrice').style.display = isMaint ? 'none' : '';
    document.getElementById('paywallPriceNote').style.display = isMaint ? 'none' : '';
    document.getElementById('paywallCta').textContent = 'Subscribe Now';
    document.getElementById('paywallCta').disabled = false;
    document.getElementById('paywallIcon').textContent = isMaint ? '🔒' : '🔒';
  } else {
    overlay.classList.remove('show');
  }
}

// ─── Auth ──────────────────────────────────────────────────────────────────────
function clearOAuthPending() {
  oauthPending = false;
  oauthStartedAt = 0;
  if (oauthPollTimer) { clearInterval(oauthPollTimer); oauthPollTimer = null; }
}

function beginOAuthFlow(providerLabel) {
  clearLoginError();
  oauthPending = true;
  oauthStartedAt = Date.now();
  setLoginWaiting(`Opening ${providerLabel} in your browser…\nCome back here after signing in.`);
  if (oauthPollTimer) clearInterval(oauthPollTimer);
  oauthPollTimer = setInterval(pollOAuthSession, 1500);
}

async function pollOAuthSession() {
  if (!oauthPending) return;
  try {
    const session = await window.codeply.auth.getSession();
    if (session) {
      clearOAuthPending();
      clearLoginWaiting();
      clearLoginError();
      currentUser = session;
      updateUserUI();
      showAuthComplete(true, currentUser.name || currentUser.email);
      // Load this account's cloud data so the overview/badge aren't stale.
      await loadCloudHistoryData();
      renderOverview();
      renderHistory();
      setTimeout(async () => {
        hideAuthComplete();
        proceedAfterLogin();
        await refreshSubscription();
        renderSubscriptionPage();
      }, 6200);
      return;
    }
  } catch { /* keep polling */ }

  if (Date.now() - oauthStartedAt > 120000) {
    clearOAuthPending();
    setLoginError('Sign-in completed in browser, but we could not read your session. Try email sign-in.', 'oauth');
    clearLoginWaiting();
  }
}

async function completeAuthSuccess(user) {
  clearOAuthPending();
  clearLoginWaiting();
  clearLoginError();
  otpPending = null;
  currentUser = user;
  updateUserUI();
  showAuthComplete(true, currentUser.name || currentUser.email);
  // Load THIS account's cloud history/stats now so the dashboard never shows the
  // previous account's numbers, then re-render the data views.
  await loadCloudHistoryData();
  renderOverview();
  renderHistory();
  setTimeout(async () => {
    hideAuthComplete();
    proceedAfterLogin();
    await refreshSubscription();
    // Re-fetch settings from the main process so the settings page is fresh.
    settings = await window.codeply.getSettings();
    populateSettings();
    renderSubscriptionPage();
    renderOverview();
    renderHistory();
  }, 2600);
}

function handleAuthCallback(data) {
  if (data.success) {
    completeAuthSuccess(data.user);
  } else {
    clearOAuthPending();
    clearLoginWaiting();
    setLoginError(data.error || 'Authentication failed', 'oauth');
    showAuthComplete(false, data.error || 'Authentication failed');
    setTimeout(hideAuthComplete, 6200);
  }
}

async function startOAuth(provider, label, invoke) {
  beginOAuthFlow(label);
  const res = await invoke();
  if (!res.success) {
    clearOAuthPending();
    setLoginError(res.error || `Could not start ${label}.`, 'oauth');
    clearLoginWaiting();
    return;
  }
  pollOAuthSession();
}

function activeLoginTab() {
  return document.querySelector('.login-tab.active')?.dataset.tab === 'signup' ? 'signup' : 'signin';
}

function formatAuthError(raw, context) {
  let msg = typeof raw === 'string' ? raw : (raw?.message || raw?.msg || '');
  try {
    const parsed = JSON.parse(msg);
    msg = parsed.msg || parsed.message || msg;
  } catch {}
  const lower = String(msg).toLowerCase();
  const ctx = context || activeLoginTab();

  if (lower.includes('unsupported provider') || lower.includes('provider is not enabled')) {
    return 'Browser sign-in is not enabled yet. Please use email sign-in below.';
  }
  if (lower.includes('redirect_uri_mismatch')) {
    return 'Google sign-in blocked: redirect URI mismatch. Add https://zswkhfkfseclgadhvobg.supabase.co/auth/v1/callback to Google Cloud Console → OAuth client → Authorized redirect URIs.';
  }
  if (lower.includes('invalid login credentials') || lower.includes('invalid credentials')) {
    return 'Incorrect email or password.';
  }
  if (lower.includes('already exists') || lower.includes('already registered') || lower.includes('user already')) {
    return 'An account with this email already exists. Try signing in.';
  }
  if (lower.includes('signup') && lower.includes('disabled')) {
    return 'New account registration is disabled. Contact support.';
  }
  if (lower.includes('email not confirmed')) {
    return 'Please confirm your email first, then sign in.';
  }
  if (ctx === 'signup') return msg ? `Failed to create account. ${msg}` : 'Failed to create account.';
  if (ctx === 'oauth') return msg ? `Sign-in failed. ${msg}` : 'Sign-in failed.';
  return msg ? `Failed to sign in. ${msg}` : 'Failed to sign in.';
}

function getLoginErrorEl(context) {
  const ctx = context || activeLoginTab();
  if (ctx === 'otp') return document.getElementById('loginErrorOtp');
  if (ctx === 'signup') return document.getElementById('loginErrorSignup');
  if (ctx === 'oauth') return document.getElementById('loginErrorSignin');
  return document.getElementById(ctx === 'signin' ? 'loginErrorSignin' : 'loginErrorSignup');
}

function setLoginError(msg, context) {
  clearLoginError();
  const ctx = context || activeLoginTab();
  const el = getLoginErrorEl(ctx);
  if (!el) return;
  // OTP errors are already humanized by the main process — don't re-mangle them.
  el.textContent = ctx === 'otp'
    ? (typeof msg === 'string' ? msg : (msg?.message || 'Could not verify the code.'))
    : formatAuthError(msg, ctx);
  el.classList.add('show');
  clearLoginWaiting();
  requestAnimationFrame(() => el.scrollIntoView({ block: 'nearest', behavior: 'smooth' }));
}

function clearLoginError() {
  ['loginErrorSignin', 'loginErrorSignup', 'loginErrorOtp'].forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = '';
    el.classList.remove('show');
  });
}

function setLoginWaiting(msg)  { const el = document.getElementById('loginWaiting'); el.textContent = msg; el.style.display = ''; }
function clearLoginWaiting()   { document.getElementById('loginWaiting').style.display = 'none'; }

// ─── Login show/hide ────────────────────────────────────────────────────────────
function hideLogin() {
  const lp = document.getElementById('loginPage');
  lp.style.transition = 'opacity .3s';
  lp.style.opacity = '0';
  setTimeout(() => { lp.style.display = 'none'; }, 300);
}
function showLogin() {
  const lp = document.getElementById('loginPage');
  lp.style.display = 'flex';
  lp.style.opacity = '0';
  requestAnimationFrame(() => { lp.style.transition = 'opacity .25s'; lp.style.opacity = '1'; });
}

// ─── First-run onboarding (referral survey) ─────────────────────────────────────
// The AI engine is built in now — there is no API-key step. The only first-run
// question left is the referral survey, gated on whether it was already answered.
let onboardingSequenceStarted = false;
function proceedAfterLogin() {
  if (onboardingSequenceStarted) { hideLogin(); return; }
  onboardingSequenceStarted = true;

  if (settings.referralSource) {
    hideLogin();
    return;
  }
  showReferralPage();
}

function showReferralPage() {
  document.getElementById('loginPage').style.display = 'none';
  const rp = document.getElementById('referralPage');
  rp.style.display = 'flex';
  rp.style.opacity = '0';
  requestAnimationFrame(() => { rp.style.transition = 'opacity .25s'; rp.style.opacity = '1'; });
}

function finishReferralPage(value) {
  const rp = document.getElementById('referralPage');
  rp.style.transition = 'opacity .25s';
  rp.style.opacity = '0';
  setTimeout(() => { rp.style.display = 'none'; }, 250);

  settings = { ...settings, referralSource: value };
  codeply.saveSettings({ referralSource: value }).catch(() => {});

  hideLogin();
}

function initReferralSurvey() {
  const opts       = Array.from(document.querySelectorAll('#referralOptions .referral-opt'));
  const otherWrap  = document.getElementById('referralOtherWrap');
  const otherInput = document.getElementById('referralOtherInput');
  const continueBtn = document.getElementById('referralContinueBtn');
  if (!opts.length || !continueBtn) return;

  let selected = null;

  function updateContinue() {
    if (!selected) { continueBtn.disabled = true; return; }
    continueBtn.disabled = selected === 'Other' && !otherInput.value.trim();
  }

  opts.forEach(btn => {
    btn.addEventListener('click', () => {
      opts.forEach(b => b.classList.remove('selected'));
      btn.classList.add('selected');
      selected = btn.dataset.value;
      otherWrap.style.display = selected === 'Other' ? 'block' : 'none';
      if (selected === 'Other') otherInput.focus();
      updateContinue();
    });
  });

  otherInput?.addEventListener('input', updateContinue);
  continueBtn.addEventListener('click', () => {
    if (continueBtn.disabled) return;
    const value = selected === 'Other' ? (otherInput.value.trim() || 'Other') : selected;
    finishReferralPage(value);
  });
}

// ─── 6-digit code (OTP) step ────────────────────────────────────────────────────
function setLoginChromeVisible(visible) {
  // Show/hide the OAuth buttons, divider, tabs and guest link while the OTP
  // step is on screen so the card only shows the code input.
  const disp = visible ? '' : 'none';
  ['googleBtn', 'githubBtn', 'loginTabs'].forEach(id => {
    const el = document.getElementById(id); if (el) el.style.display = disp;
  });
  const divider = document.querySelector('#loginPage .divider');
  if (divider) divider.style.display = disp;
  const skip = document.getElementById('loginSkip');
  if (skip && skip.parentElement) skip.parentElement.style.display = disp;
}

function showOtpForm(email, mode) {
  otpPending = { email, mode: mode || 'login' };
  setLoginChromeVisible(false);
  document.getElementById('signinForm').style.display = 'none';
  document.getElementById('signupForm').style.display = 'none';
  document.getElementById('otpForm').style.display = '';
  document.getElementById('otpEmailLabel').textContent = email || 'your inbox';
  clearLoginError(); clearLoginWaiting();
  const inp = document.getElementById('otpCode');
  if (inp) { inp.value = ''; setTimeout(() => inp.focus(), 60); }
}

function hideOtpForm() {
  otpPending = null;
  document.getElementById('otpForm').style.display = 'none';
  setLoginChromeVisible(true);
  const mode = activeLoginTab();
  document.getElementById('signinForm').style.display = mode === 'signin' ? '' : 'none';
  document.getElementById('signupForm').style.display = mode === 'signup' ? '' : 'none';
  clearLoginError(); clearLoginWaiting();
}

// ─── Spinner → Tick auth completion animation ───────────────────────────────────
function showAuthComplete(success, name) {
  const overlay     = document.getElementById('authComplete');
  const ring        = document.getElementById('authSpinnerRing');
  const tickCircle  = document.getElementById('authTickCircle');
  const tickPath    = document.getElementById('authTickPath');
  const errCircle   = document.getElementById('authErrorCircle');
  const nameEl      = document.getElementById('authCompleteName');
  const subEl       = document.getElementById('authCompleteSub');

  // Reset everything
  ring.classList.remove('fill');
  tickCircle.classList.remove('pop'); tickPath.classList.remove('draw');
  errCircle.classList.remove('pop');
  nameEl.classList.remove('show'); subEl.classList.remove('show');
  nameEl.textContent = success ? ('Welcome, ' + (name || 'back') + '!') : 'Sign-in failed';
  subEl.textContent  = success ? "You're all set. Loading Codeply…" : (name || 'Please try again.');

  overlay.classList.add('show');

  // Phase 1: spinner fills over ~1.8s
  requestAnimationFrame(() => {
    setTimeout(() => ring.classList.add('fill'), 50);
  });

  // Phase 2: swap spinner for tick/error
  setTimeout(() => {
    ring.style.opacity = '0';
    if (success) {
      tickCircle.classList.add('pop');
      setTimeout(() => tickPath.classList.add('draw'), 120);
    } else {
      errCircle.classList.add('pop');
    }
    setTimeout(() => nameEl.classList.add('show'), 300);
    setTimeout(() => subEl.classList.add('show'),  450);
  }, 1900);
}

function hideAuthComplete() {
  const overlay = document.getElementById('authComplete');
  overlay.style.transition = 'opacity .4s';
  overlay.style.opacity = '0';
  setTimeout(() => {
    overlay.classList.remove('show');
    overlay.style.opacity = '';
    overlay.style.transition = '';
    // Reset ring opacity for next time
    const ring = document.getElementById('authSpinnerRing');
    if (ring) ring.style.opacity = '';
  }, 420);
}

// ─── User UI ───────────────────────────────────────────────────────────────────
function updateUserUI() {
  const name   = currentUser?.name  || 'Guest';
  const email  = currentUser?.email || '';
  const avatar = currentUser?.avatar || '';
  const initial = name.charAt(0).toUpperCase();

  // Sidebar
  const avatarEl = document.getElementById('userAvatar');
  if (avatar) {
    avatarEl.innerHTML = `<img src="${escHtml(avatar)}" alt="">`;
  } else {
    avatarEl.textContent = initial;
    avatarEl.style.background = currentUser ? 'var(--accent)' : '#9aa0a6';
  }
  document.getElementById('userName').textContent = name;
  document.getElementById('userPlan').textContent = currentUser ? (subStatus.plan === 'pro' ? 'Pro Plan' : 'Free Plan') : 'Free for all';

  // Settings page
  const settingsAvatar = document.getElementById('settingsAvatar');
  if (avatar) {
    settingsAvatar.innerHTML = `<img src="${escHtml(avatar)}" alt="">`;
  } else {
    settingsAvatar.textContent = initial;
    settingsAvatar.style.background = currentUser ? 'var(--accent)' : '#9aa0a6';
  }
  document.getElementById('settingsUserName').textContent = name;
  document.getElementById('settingsUserEmail').textContent = email || 'Not signed in';
  if (name !== 'Guest') document.getElementById('s-name').value = name;
  if (email)            document.getElementById('s-email').value = email;

  // Show/hide account section in settings
  document.getElementById('settingsLoggedIn').style.display  = currentUser ? '' : 'none';
  document.getElementById('settingsNotLoggedIn').style.display = currentUser ? 'none' : '';
}

// ─── Watcher Card ──────────────────────────────────────────────────────────────
function renderWatchCard() {
  const folderEl = document.getElementById('watchFolder');
  const fileEl   = document.getElementById('watchFile');
  const dot      = document.getElementById('watchDot');
  if (!folderEl) return;

  if (watchData.folder) {
    folderEl.textContent = watchData.folder.length > 46 ? '…' + watchData.folder.slice(-46) : watchData.folder;
    folderEl.style.color = 'var(--text2)';
  } else {
    folderEl.textContent = 'No folder selected';
    folderEl.style.color = 'var(--muted)';
  }
  if (watchData.activeFile) {
    const parts = watchData.activeFile.replace(/\\/g, '/').split('/');
    fileEl.textContent = parts.slice(-2).join('/');
    fileEl.style.color = 'var(--green)';
    dot.style.background = 'var(--green)';
    dot.title = 'Watching, file detected';
  } else if (watchData.folder) {
    fileEl.textContent = 'No recent file yet';
    fileEl.style.color = 'var(--muted)';
    dot.style.background = 'var(--yellow)';
    dot.title = 'Watching, no file yet';
  } else {
    fileEl.textContent = '';
    fileEl.style.color = 'var(--muted)';
    dot.style.background = 'var(--muted)';
    dot.title = 'Not watching';
  }
}

// ─── Overview ──────────────────────────────────────────────────────────────────
function renderTokenCapBar() {
  const cap  = parseInt(settings.tokenCap || 0, 10) || 0;
  const used = usage.totalTokens || 0;
  const wrap = document.getElementById('tokenCapBarWrap');
  if (!wrap) return;
  if (!cap) { wrap.style.display = 'none'; return; }
  wrap.style.display = '';
  const pct = Math.min(100, (used / cap) * 100);
  document.getElementById('tokenCapUsedLabel').textContent = `${formatNum(used)} / ${formatNum(cap)} tokens`;
  document.getElementById('tokenCapPctLabel').textContent  = `${Math.round(pct)}%`;
  const bar = document.getElementById('tokenCapProgressBar');
  if (bar) {
    bar.style.width      = pct + '%';
    bar.style.background = pct >= 100 ? 'var(--red)' : pct >= 80 ? 'var(--yellow)' : 'var(--accent)';
  }
}

// ── Account-scoped data source ───────────────────────────────────────────────
// When signed in, the dashboard reflects THIS account's cloud data only. Guests
// fall back to the local (this-machine) usage file. This is what stops a new
// account from seeing the previous account's tokens / history / badge count.
function dashHistory() {
  if (currentUser) {
    return (_cloudHistory || []).map(h => ({
      timestamp: h.created_at,
      tokens:    h.tokens_total || 0,
      snippet:   h.prompt_text || '',
      file:      h.file_path ? h.file_path.split(/[/\\]/).pop() : '',
      model:     h.model || '',
    }));
  }
  return usage.history || [];
}
function dashTotals() {
  if (currentUser) {
    return { tokens: _cloudStats.totalTokens || 0, requests: _cloudStats.totalRequests || 0 };
  }
  return { tokens: usage.totalTokens || 0, requests: usage.totalRequests || 0 };
}
function dashHistoryCount() {
  return currentUser ? (_cloudHistory?.length || 0) : (usage.history?.length || 0);
}

// Wipe the in-memory cloud caches on sign-out so the next account never inherits
// the previous account's history/stats, then refresh the data views.
function resetAccountData() {
  _cloudHistory = [];
  _cloudStats   = { totalTokens: 0, totalRequests: 0, byModel: {} };
  renderOverview();
  renderHistory();
}

function renderOverview() {
  const totals = dashTotals();
  document.getElementById('statTokens').textContent   = formatNum(totals.tokens);
  document.getElementById('statRequests').textContent = totals.requests;
  const avg = totals.requests > 0 ? Math.round(totals.tokens / totals.requests) : 0;
  document.getElementById('statAvg').textContent = avg > 0 ? formatNum(avg) : '';
  document.getElementById('historyBadge').textContent = dashHistoryCount();
  renderTokenCapBar();
  renderChart(); renderRecentActivity();
}
function formatNum(n) {
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
  if (n >= 1000)    return (n / 1000).toFixed(1) + 'k';
  return n.toString();
}
function renderChart() {
  const chart   = document.getElementById('usageChart');
  const history = dashHistory();

  // Build last 7 calendar days (oldest → newest)
  const days = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - i);
    days.push({
      date:     d,
      label:    d.toLocaleDateString('en', { weekday: 'short' }).slice(0, 3),
      tokens:   0,
      requests: 0,
    });
  }

  // Aggregate history into days
  history.forEach(h => {
    if (!h.timestamp) return;
    const hd = new Date(h.timestamp);
    hd.setHours(0, 0, 0, 0);
    const slot = days.find(d => d.date.getTime() === hd.getTime());
    if (slot) { slot.tokens += h.tokens || 0; slot.requests++; }
  });

  if (days.every(d => d.tokens === 0)) {
    chart.innerHTML = '<div style="color:var(--muted);font-size:0.72rem;font-family:var(--mono);margin:auto">No data yet</div>';
    return;
  }

  const maxTokens = Math.max(...days.map(d => d.tokens), 1);
  // Brand colors cycling Mon–Sun
  const barColors = [
    '#4285F4', // blue
    '#1f8f43', // green
    '#E38A00', // yellow
    '#d62f21', // red
    '#4285F4',
    '#1f8f43',
    '#E38A00',
  ];

  chart.style.position = 'relative';
  chart.innerHTML = `
    <div id="chartTip" style="
      position:absolute; pointer-events:none; z-index:20;
      background:#1d2230; color:#fff;
      font-family:var(--mono); font-size:0.6rem; font-weight:700;
      padding:4px 9px; border-radius:6px; white-space:nowrap;
      box-shadow:0 2px 8px rgba(0,0,0,.18);
      opacity:0; transition:opacity .12s; transform:translateX(-50%);
    "></div>
    ${days.map((d, i) => {
      const pct   = d.tokens > 0 ? Math.max(10, (d.tokens / maxTokens) * 100) : 3;
      const alpha = d.tokens > 0 ? '1' : '0.18';
      return `<div class="chart-bar-wrap">
        <div class="chart-bar"
          style="height:${pct}%;background:${barColors[i]};opacity:${alpha};cursor:${d.tokens > 0 ? 'pointer' : 'default'};transition:opacity .15s,filter .15s"
          data-tokens="${d.tokens}" data-req="${d.requests}" data-day="${d.label}"
        ></div>
        <div class="chart-label">${d.label}</div>
      </div>`;
    }).join('')}
  `;

  // Hover tooltip
  const tip = document.getElementById('chartTip');
  chart.querySelectorAll('.chart-bar[data-tokens]').forEach(bar => {
    bar.addEventListener('mouseenter', () => {
      const tokens = parseInt(bar.dataset.tokens);
      if (!tokens) return;
      tip.textContent = `${formatNum(tokens)} tokens · ${bar.dataset.req} req`;
      const br = bar.getBoundingClientRect();
      const cr = chart.getBoundingClientRect();
      tip.style.left    = (br.left - cr.left + br.width / 2) + 'px';
      tip.style.top     = (br.top  - cr.top  - 30) + 'px';
      tip.style.opacity = '1';
      bar.style.filter  = 'brightness(1.15)';
    });
    bar.addEventListener('mouseleave', () => {
      tip.style.opacity = '0';
      bar.style.filter  = '';
    });
  });
}
function renderRecentActivity() {
  const container = document.getElementById('recentActivity');
  const history   = dashHistory().slice(0, 5);
  if (!history.length) {
    container.innerHTML = '<div class="empty-state"><span class="icon">◈</span>No requests yet. Use the overlay to get started.</div>';
    return;
  }
  container.innerHTML = `<table class="history-table">
    <thead><tr><th>Snippet</th><th>File</th><th>Tokens</th><th>Time</th></tr></thead>
    <tbody>${history.map(h => `<tr>
      <td class="td-code">${escHtml(h.snippet || '')}</td>
      <td class="td-file">${escHtml(h.file || '')}</td>
      <td class="td-tokens">${h.tokens || 0}</td>
      <td class="td-time">${relTime(h.timestamp)}</td>
    </tr>`).join('')}</tbody></table>`;
}

// ─── History ───────────────────────────────────────────────────────────────────
let _cloudHistory = [];
let _cloudStats   = { totalTokens: 0, totalRequests: 0, byModel: {} };

async function loadCloudHistoryData() {
  if (!currentUser) return;
  try {
    [_cloudHistory, _cloudStats] = await Promise.all([
      window.codeply.history.getCloud(),
      window.codeply.history.getStats(),
    ]);
  } catch { /* offline — keep empty */ }
}

function renderHistoryStats() {
  const wrap = document.getElementById('historyStatsWrap');
  if (!wrap) return;

  const { totalTokens, totalRequests } = _cloudStats;
  const avg = totalRequests > 0 ? Math.round(totalTokens / totalRequests) : 0;

  wrap.innerHTML = `
    <div class="hst-top-stats">
      <div class="hst-stat-card">
        <div class="hst-stat-label">Total Tokens</div>
        <div class="hst-stat-val">${formatNum(totalTokens)}</div>
      </div>
      <div class="hst-stat-card">
        <div class="hst-stat-label">AI Requests</div>
        <div class="hst-stat-val">${formatNum(totalRequests)}</div>
      </div>
      <div class="hst-stat-card">
        <div class="hst-stat-label">Avg per Request</div>
        <div class="hst-stat-val">${avg > 0 ? formatNum(avg) : ''}</div>
      </div>
    </div>`;
}

function renderHistory() {
  const container = document.getElementById('historyTableWrap');

  const rows = _cloudHistory.map(h => ({
    snippet:   (h.prompt_text || '').slice(0, 80) + ((h.prompt_text || '').length > 80 ? '...' : ''),
    file:      h.file_path ? h.file_path.split(/[/\\]/).pop() : '',
    model:     h.model || '',
    tokens:    h.tokens_total || 0,
    tokensIn:  h.tokens_in   || 0,
    tokensOut: h.tokens_out  || 0,
    timestamp: h.created_at,
  }));

  document.getElementById('historyBadge').textContent = rows.length;

  renderHistoryStats();

  if (!rows.length) {
    container.innerHTML = '<div class="empty-state"><span class="icon">◈</span>No history yet. Run an analysis to get started.</div>';
    return;
  }

  container.innerHTML = `
    <div class="hst-table-header"><span class="hst-cloud-badge">☁ Cloud · ${rows.length} entries</span></div>
    <table class="history-table">
      <thead><tr><th>Prompt</th><th>File</th><th>Tokens</th><th>Time</th></tr></thead>
      <tbody>${rows.map(h => `<tr>
        <td class="td-code">${escHtml(h.snippet)}</td>
        <td class="td-file">${escHtml(h.file)}</td>
        <td class="td-tokens">${formatNum(h.tokens)}</td>
        <td class="td-time">${relTime(h.timestamp)}</td>
      </tr>`).join('')}</tbody>
    </table>`;
}
// ─── Subscription page ─────────────────────────────────────────────────────────
function renderSubscriptionPage() {
  const section = document.getElementById('subAccountSection');
  if (currentUser) {
    const isActive = subStatus.allowed;
    const badge = document.getElementById('subStatusBadge');
    badge.className = isActive ? 'sub-badge-free' : 'sub-badge-locked';
    badge.innerHTML = isActive
      ? `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" width="14" height="14"><polyline points="20 6 9 17 4 12"/></svg> Active · ${subStatus.plan === 'pro' ? 'Pro' : 'Free'}`
      : `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" width="14" height="14"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg> Subscription Required`;

    section.innerHTML = `<div style="padding:14px;background:var(--green-tint);border-radius:10px;border:1px solid #a8d5b5;font-size:0.83rem;color:var(--green)">
      ✓ Signed in as <strong>${escHtml(currentUser.email || currentUser.name)}</strong>. All features active.
    </div>`;
  } else {
    section.innerHTML = `<div id="subNotLoggedIn" style="padding:14px;background:var(--surface2);border-radius:10px;border:1px solid var(--border-light);font-size:0.83rem;color:var(--text2)">
      Sign in to sync your subscription status and unlock all features.
    </div>`;
  }
  renderUsageLimitBar();
}

// Daily apply usage (500/day cap) — same count main.js enforces against,
// shown read-only here. Works for guests too (local counter fallback).
async function renderUsageLimitBar() {
  const countEl = document.getElementById('usageLimitCount');
  const fillEl = document.getElementById('usageLimitFill');
  if (!countEl || !fillEl) return;
  try {
    const limit = await window.codeply.getApplyLimit();
    const count = limit?.count || 0;
    const cap = limit?.limit || 500;
    const pct = Math.min(100, (count / cap) * 100);
    countEl.textContent = `${formatNum(count)} / ${formatNum(cap)}`;
    fillEl.style.width = pct + '%';
    fillEl.style.background = pct >= 100 ? 'var(--red)' : pct >= 80 ? 'var(--yellow)' : 'var(--accent)';
  } catch (e) { /* leave the bar at its zero default on failure */ }
}

// ─── Settings ──────────────────────────────────────────────────────────────────
function populateSettings() {
  if (settings.hotkey) { const el = document.getElementById('s-hotkey'); if (el) el.value = settings.hotkey; }
}
// ─── Utilities ─────────────────────────────────────────────────────────────────
function escHtml(str) { return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function relTime(iso) {
  if (!iso) return '';
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60000), h = Math.floor(m/60), d = Math.floor(h/24);
  if (d > 0) return `${d}d ago`;
  if (h > 0) return `${h}h ago`;
  if (m > 0) return `${m}m ago`;
  return 'just now';
}
function showToast(msg, type = '') {
  const t = document.createElement('div');
  t.className = `toast ${type}`;
  t.innerHTML = `<div class="toast-dot"></div>${escHtml(msg)}`;
  document.body.appendChild(t);
  setTimeout(() => { t.style.opacity = '0'; t.style.transition = 'opacity .3s'; }, 2200);
  setTimeout(() => t.remove(), 2550);
}

function wireAllHandlers() {
  const codeply = requireCodeply();

  initReferralSurvey();
  bindClick('onboardingDoneBtn', () => {
    const modal = document.getElementById('onboardingDoneModal');
    if (modal) modal.style.display = 'none';
  });

  bindClick('paywallSignout', async () => {
    await codeply.auth.signOut();
    currentUser = null;
    resetAccountData();
    updateUserUI();
    showLogin();
    document.getElementById('paywallOverlay').classList.remove('show');
  });

  bindClick('paywallCta', () => {
    const url = 'https://whop.com/checkout/MN9HVEeGx1GObPQ5z-uz0u-rYbZ-C333-EYJzxEG4xD9b/';
    try {
      if (window.codeply && window.codeply.openExternal) {
        window.codeply.openExternal(url);
      } else {
        window.open(url, '_blank');
      }
    } catch(e) {
      window.open(url, '_blank');
    }
  });

  bindClick('googleBtn', () =>
    startOAuth('google', 'Google sign-in', () => codeply.auth.signInGoogle()));
  bindClick('githubBtn', () =>
    startOAuth('github', 'GitHub sign-in', () => codeply.auth.signInGitHub()));

  bindClick('loginBtn', async () => {
    clearLoginError(); clearLoginWaiting();
    const email    = document.getElementById('loginEmail').value.trim();
    const password = document.getElementById('loginPassword').value;
    if (!email || !password) { setLoginError('Please enter your email and password.', 'signin'); return; }
    const btn = document.getElementById('loginBtn');
    btn.disabled = true;
    btn.textContent = 'Signing in…';
    try {
      const res = await codeply.auth.signInEmail({ email, password });
      if (!res.success) { setLoginError(res.error || 'Incorrect email or password.', 'signin'); return; }
      if (res.needsOtp) { showOtpForm(res.email || email, res.mode || 'login'); return; }
      completeAuthSuccess(res.user);
    } catch (err) {
      setLoginError(err.message || 'Failed to sign in.', 'signin');
    } finally {
      btn.disabled = false;
      btn.textContent = 'Sign In';
    }
  });

  bindClick('signupBtn', async () => {
    clearLoginError(); clearLoginWaiting();
    const name     = document.getElementById('signupName').value.trim();
    const email    = document.getElementById('signupEmail').value.trim();
    const password = document.getElementById('signupPassword').value;
    if (!email || !password) { setLoginError('Please fill in all fields.', 'signup'); return; }
    if (password.length < 6)  { setLoginError('Password must be at least 6 characters.', 'signup'); return; }
    const btn = document.getElementById('signupBtn');
    btn.disabled = true;
    btn.textContent = 'Creating…';
    try {
      const res = await codeply.auth.signUpEmail({ email, password, name });
      if (!res.success) { setLoginError(res.error || 'Failed to create account.', 'signup'); return; }
      if (res.needsOtp) { showOtpForm(res.email || email, res.mode || 'signup'); return; }
      completeAuthSuccess(res.user);
    } catch (err) {
      setLoginError(err.message || 'Failed to create account.', 'signup');
    } finally {
      btn.disabled = false;
      btn.textContent = 'Create Account';
    }
  });

  // ── 6-digit code (OTP) handlers ──────────────────────────────────────────────
  bindClick('verifyOtpBtn', async () => {
    if (!otpPending) return;
    clearLoginError();
    const code = (document.getElementById('otpCode').value || '').replace(/\D/g, '');
    if (code.length < 6) { setLoginError('Enter the 8-digit code from your email.', 'otp'); return; }
    const btn = document.getElementById('verifyOtpBtn');
    btn.disabled = true; btn.textContent = 'Verifying…';
    try {
      const res = await codeply.auth.verifyOtp({ email: otpPending.email, token: code, mode: otpPending.mode });
      if (!res.success) { setLoginError(res.error || 'Incorrect code. Try again.', 'otp'); return; }
      const user = res.user;
      hideOtpForm();
      completeAuthSuccess(user);
    } catch (err) {
      setLoginError(err.message || 'Could not verify the code.', 'otp');
    } finally {
      btn.disabled = false; btn.textContent = 'Verify & continue';
    }
  });

  bindClick('otpResendBtn', async () => {
    if (!otpPending) return;
    clearLoginError();
    const btn = document.getElementById('otpResendBtn');
    const orig = btn.textContent;
    btn.disabled = true; btn.textContent = 'Sending…';
    try {
      const res = await codeply.auth.resendOtp({ email: otpPending.email, mode: otpPending.mode });
      if (!res.success) setLoginError(res.error || 'Could not resend the code.', 'otp');
      else setLoginWaiting(`A new code is on its way to ${otpPending.email}.`);
    } catch (err) {
      setLoginError(err.message || 'Could not resend the code.', 'otp');
    } finally {
      btn.disabled = false; btn.textContent = orig;
    }
  });

  bindClick('otpBackBtn', () => hideOtpForm());

  document.getElementById('otpCode')?.addEventListener('input', e => {
    e.target.value = e.target.value.replace(/\D/g, '').slice(0, 8);
  });
  document.getElementById('otpCode')?.addEventListener('keydown', e => {
    if (e.key === 'Enter') document.getElementById('verifyOtpBtn')?.click();
  });

  bindClick('loginSkip', () => {
    currentUser = null;
    updateUserUI();
    proceedAfterLogin();
  });

  bindClick('signOutBtn', async () => {
    await codeply.auth.signOut();
    currentUser = null;
    resetAccountData();
    updateUserUI();
    renderSubscriptionPage();
    showLogin();
    showToast('Signed out', 'success');
  });

  bindClick('goToLoginBtn', () => showLogin());

  document.querySelectorAll('.login-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.login-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      const mode = tab.dataset.tab;
      document.getElementById('signinForm').style.display = mode === 'signin' ? '' : 'none';
      document.getElementById('signupForm').style.display = mode === 'signup' ? '' : 'none';
      clearLoginError(); clearLoginWaiting();
    });
  });

  document.getElementById('loginPassword')?.addEventListener('keydown', e => {
    if (e.key === 'Enter') document.getElementById('loginBtn')?.click();
  });
  document.getElementById('signupPassword')?.addEventListener('keydown', e => {
    if (e.key === 'Enter') document.getElementById('signupBtn')?.click();
  });

  document.querySelectorAll('.nav-item').forEach(item => {
    item.addEventListener('click', () => {
      document.querySelectorAll('.nav-item').forEach(i => {
        i.classList.remove('active', 'b', 'g', 'y', 'r');
      });
      document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
      item.classList.add('active', item.dataset.color || 'b');
      const page = item.dataset.page;
      document.getElementById(`page-${page}`)?.classList.add('active');
      if (page === 'overview')      { renderOverview(); renderWatchCard(); }
      if (page === 'history')       { loadCloudHistoryData().then(() => renderHistory()); renderHistory(); }
      if (page === 'subscription')  renderSubscriptionPage();
      if (page === 'admin')         { loadBugReports(); loadReferralSources(); }
    });
  });

  // Submit a bug report.
  bindClick('submitBugBtn', async () => {
    const title = document.getElementById('bugTitle').value.trim();
    const desc  = document.getElementById('bugDesc').value.trim();
    if (!title && !desc) { showToast('Add a title or description first', 'error'); return; }
    const btn = document.getElementById('submitBugBtn');
    const orig = btn.textContent; btn.disabled = true; btn.textContent = 'Sending…';
    try {
      const res = await codeply.bugs.submit({ title, description: desc });
      if (res && res.success) {
        document.getElementById('bugTitle').value = '';
        document.getElementById('bugDesc').value = '';
        document.getElementById('bugThanks').style.display = 'block';
        setTimeout(() => { const t = document.getElementById('bugThanks'); if (t) t.style.display = 'none'; }, 4000);
        showToast('Bug report sent, thank you!', 'success');
      } else {
        showToast(res?.error || 'Could not send report', 'error');
      }
    } finally { btn.disabled = false; btn.textContent = orig; }
  });

  bindClick('refreshBugsBtn', loadBugReports);
  bindClick('refreshReferralsBtn', loadReferralSources);

  bindClick('pickFolderBtn', async () => {
    const result = await codeply.pickWatchFolder();
    if (result) {
      watchData.folder = result;
      watchData.activeFile = null;
      renderWatchCard();
      showToast('Watching ' + result.split(/[\\/]/).pop(), 'success');
    }
  });

  bindClick('clearHistoryBtn', async () => {
    if (!confirm('Clear all history?')) return;
    await codeply.resetUsage();
    usage = await codeply.getUsage();
    renderHistory(); renderOverview();
    showToast('History cleared', 'success');
  });

  bindClick('saveSettingsBtn', async () => {
    const newHotkey = document.getElementById('s-hotkey')?.value || '';
    const updated = { hotkey: newHotkey };
    const btn = document.getElementById('saveSettingsBtn');
    const orig = btn.textContent;
    btn.disabled = true; btn.textContent = 'Saving…';
    try {
      const result = await codeply.saveSettings(updated);
      if (result && result.success === false) {
        showToast(result.error || 'Save failed', 'error');
        return;
      }
      settings = { ...settings, ...updated };
      showToast('Settings applied, no restart needed', 'success');
    } finally {
      btn.disabled = false; btn.textContent = orig;
    }
  });

  bindClick('restartModalClose', () => {
    const modal = document.getElementById('restartModal');
    if (modal) modal.style.display = 'none';
    showToast('Settings saved, restart when ready', 'success');
  });

  bindClick('restartNowBtn', async () => {
    await codeply.app.restart();
  });

  bindClick('saveProfileBtn', async () => {
    const name  = document.getElementById('s-name').value.trim() || (currentUser?.name || 'User');
    const email = document.getElementById('s-email').value.trim();
    await codeply.saveSettings({ user: { ...currentUser, name, email } });
    if (currentUser) { currentUser.name = name; currentUser.email = email; }
    updateUserUI();
    showToast('Profile updated', 'success');
  });

  bindClick('resetUsageBtn', async () => {
    if (!confirm('Permanently delete all usage stats and history?')) return;
    await codeply.resetUsage();
    usage = await codeply.getUsage();
    renderOverview(); renderHistory();
    showToast('Usage data reset', 'success');
  });

  // Window controls handled by inline onclick attributes — no duplicate bindClick needed.
}