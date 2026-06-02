/**
 * Codeply Dashboard — Renderer
 */

// ─── State ─────────────────────────────────────────────────────────────────────
let usage = { totalTokens: 0, totalRequests: 0, sessions: [], history: [] };
let settings = {};
let user = null;

// ─── Init ──────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  settings = await window.codeply.getSettings();
  usage = await window.codeply.getUsage();
  user = settings.user || null;

  if (user) {
    hideLogin();
  }
  // Login page is shown by default (z-index overlay)

  populateSettings();
  renderOverview();
  renderHistory();
  updateUserUI();
});

// ─── Login ─────────────────────────────────────────────────────────────────────
function hideLogin() {
  const lp = document.getElementById('loginPage');
  lp.style.opacity = '0';
  lp.style.transition = 'opacity 0.3s';
  setTimeout(() => { lp.style.display = 'none'; }, 300);
}

document.getElementById('loginBtn').onclick = async () => {
  const name = document.getElementById('loginName').value.trim() || 'Dev';
  const email = document.getElementById('loginEmail').value.trim();
  user = { name, email, createdAt: new Date().toISOString() };
  await window.codeply.saveSettings({ ...settings, user });
  settings.user = user;
  updateUserUI();
  hideLogin();
};

document.getElementById('loginSkip').onclick = () => {
  user = { name: 'Guest', email: '' };
  updateUserUI();
  hideLogin();
};

function updateUserUI() {
  const name = user?.name || 'Guest';
  const initial = name.charAt(0).toUpperCase();
  document.getElementById('userAvatar').textContent = initial;
  document.getElementById('userName').textContent = name;
  document.getElementById('settingsAvatar').textContent = initial;
  document.getElementById('settingsUserName').textContent = name;
  document.getElementById('settingsUserEmail').textContent = user?.email || 'No email set';
  if (user?.name) document.getElementById('s-name').value = user.name;
  if (user?.email) document.getElementById('s-email').value = user.email;
}

// ─── Navigation ────────────────────────────────────────────────────────────────
document.querySelectorAll('.nav-item').forEach(item => {
  item.addEventListener('click', () => {
    document.querySelectorAll('.nav-item').forEach(i => i.classList.remove('active'));
    document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
    item.classList.add('active');
    const page = item.dataset.page;
    document.getElementById(`page-${page}`).classList.add('active');
    if (page === 'overview') renderOverview();
    if (page === 'history') renderHistory();
  });
});

// ─── Overview ──────────────────────────────────────────────────────────────────
function renderOverview() {
  document.getElementById('statTokens').textContent = formatNum(usage.totalTokens);
  document.getElementById('statRequests').textContent = usage.totalRequests;
  const avg = usage.totalRequests > 0 ? Math.round(usage.totalTokens / usage.totalRequests) : 0;
  document.getElementById('statAvg').textContent = avg > 0 ? formatNum(avg) : '–';
  document.getElementById('historyBadge').textContent = usage.history?.length || 0;

  renderChart();
  renderRecentActivity();
}

function formatNum(n) {
  if (n >= 1000) return (n / 1000).toFixed(1) + 'k';
  return n.toString();
}

function renderChart() {
  const chart = document.getElementById('usageChart');
  const history = usage.history || [];
  const last7 = history.slice(0, 7).reverse();

  if (last7.length === 0) {
    chart.innerHTML = '<div style="color:var(--muted);font-size:0.72rem;font-family:var(--mono);margin:auto">No data yet</div>';
    return;
  }

  const maxTokens = Math.max(...last7.map(h => h.tokens || 0), 1);
  chart.innerHTML = last7.map(h => {
    const pct = Math.max(4, ((h.tokens || 0) / maxTokens) * 100);
    const label = new Date(h.timestamp).toLocaleDateString('en', { weekday: 'short' }).slice(0, 3);
    return `
      <div class="chart-bar-wrap" title="${h.tokens} tokens">
        <div class="chart-bar" style="height:${pct}%"></div>
        <div class="chart-label">${label}</div>
      </div>`;
  }).join('');
}

function renderRecentActivity() {
  const container = document.getElementById('recentActivity');
  const history = (usage.history || []).slice(0, 5);

  if (history.length === 0) {
    container.innerHTML = '<div class="empty-state"><span>◈</span>No requests yet. Use the overlay to get started.</div>';
    return;
  }

  container.innerHTML = `
    <table class="history-table">
      <thead><tr>
        <th>Snippet</th><th>File</th><th>Model</th><th>Tokens</th><th>Time</th>
      </tr></thead>
      <tbody>
        ${history.map(h => `
          <tr>
            <td class="td-code">${escHtml(h.snippet || '–')}</td>
            <td class="td-file">${escHtml(h.file || '–')}</td>
            <td><span class="badge-model">${escHtml(shortModel(h.model))}</span></td>
            <td class="td-tokens">${h.tokens || 0}</td>
            <td class="td-time">${relTime(h.timestamp)}</td>
          </tr>`).join('')}
      </tbody>
    </table>`;
}

// ─── History ───────────────────────────────────────────────────────────────────
function renderHistory() {
  const container = document.getElementById('historyTableWrap');
  const history = usage.history || [];

  document.getElementById('historyBadge').textContent = history.length;

  if (history.length === 0) {
    container.innerHTML = '<div class="empty-state"><span>◈</span>No history yet.</div>';
    return;
  }

  container.innerHTML = `
    <table class="history-table">
      <thead><tr>
        <th>Snippet</th><th>File</th><th>Model</th><th>Tokens</th><th>Time</th>
      </tr></thead>
      <tbody>
        ${history.map(h => `
          <tr>
            <td class="td-code">${escHtml(h.snippet || '–')}</td>
            <td class="td-file">${escHtml(h.file || '–')}</td>
            <td><span class="badge-model">${escHtml(shortModel(h.model))}</span></td>
            <td class="td-tokens">${h.tokens || 0}</td>
            <td class="td-time">${relTime(h.timestamp)}</td>
          </tr>`).join('')}
      </tbody>
    </table>`;
}

document.getElementById('clearHistoryBtn').onclick = async () => {
  if (!confirm('Clear all history?')) return;
  await window.codeply.resetUsage();
  usage = await window.codeply.getUsage();
  renderHistory();
  renderOverview();
  showToast('History cleared', 'success');
};

// ─── Settings ──────────────────────────────────────────────────────────────────
function populateSettings() {
  if (settings.provider) document.getElementById('s-provider').value = settings.provider;
  if (settings.model) document.getElementById('s-model').value = settings.model;
  if (settings.apiKey) document.getElementById('s-apiKey').value = settings.apiKey;
  if (settings.hotkey) document.getElementById('s-hotkey').value = settings.hotkey;
}

document.getElementById('s-provider').addEventListener('change', (e) => {
  const models = { openrouter: 'openai/gpt-4o-mini', groq: 'llama-3.1-8b-instant' };
  document.getElementById('s-model').value = models[e.target.value] || '';
});

document.getElementById('saveSettingsBtn').onclick = async () => {
  const updated = {
    provider: document.getElementById('s-provider').value,
    model: document.getElementById('s-model').value,
    apiKey: document.getElementById('s-apiKey').value,
    hotkey: document.getElementById('s-hotkey').value,
  };
  await window.codeply.saveSettings(updated);
  settings = { ...settings, ...updated };
  showToast('Settings saved ✓', 'success');
};

document.getElementById('saveProfileBtn').onclick = async () => {
  const name = document.getElementById('s-name').value.trim() || 'Dev';
  const email = document.getElementById('s-email').value.trim();
  user = { ...user, name, email };
  await window.codeply.saveSettings({ user });
  settings.user = user;
  updateUserUI();
  showToast('Profile updated ✓', 'success');
};

document.getElementById('resetUsageBtn').onclick = async () => {
  if (!confirm('This will permanently delete all usage stats and history. Continue?')) return;
  await window.codeply.resetUsage();
  usage = await window.codeply.getUsage();
  renderOverview();
  renderHistory();
  showToast('Usage data reset', 'success');
};

// ─── Utilities ─────────────────────────────────────────────────────────────────
function escHtml(str) {
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function shortModel(model) {
  if (!model) return '–';
  return model.split('/').pop() || model;
}

function relTime(iso) {
  if (!iso) return '–';
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60000);
  const h = Math.floor(m / 60);
  const d = Math.floor(h / 24);
  if (d > 0) return `${d}d ago`;
  if (h > 0) return `${h}h ago`;
  if (m > 0) return `${m}m ago`;
  return 'just now';
}

function showToast(msg, type = '') {
  const t = document.createElement('div');
  t.className = `toast ${type}`;
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => { t.style.opacity = '0'; t.style.transition = 'opacity 0.3s'; }, 2000);
  setTimeout(() => t.remove(), 2400);
}
