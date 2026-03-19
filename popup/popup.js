/**
 * Vault Chrome Extension — Popup Logic
 * All event handlers registered via addEventListener (MV3 CSP compliance)
 */

// ============================================
// State
// ============================================
let vault = {
  privateKey: '',
  seedPhrase: '',
  users: {},
  settings: { hashLength: 16 },
};

let currentNonce = 0;
let originalNonce = 0;
let passwordVisible = false;
let navigationStack = ['welcomeScreen'];
let currentTabDomain = null;
let clipboardClearTimer = null;
let unlockAttempts = 0;
let unlockLockoutUntil = 0;
const MAX_UNLOCK_ATTEMPTS = 5;
const UNLOCK_LOCKOUT_MS = 30 * 1000;

// Autocomplete state
let activeSuggestionIndex = -1;
let currentSuggestions = [];

// ============================================
// Init & Event Binding
// ============================================
document.addEventListener('DOMContentLoaded', async () => {
  // Get current tab domain
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.url) {
      currentTabDomain = VaultCore.extractDomain(tab.url);
    }
  } catch (e) {
    console.error('Could not get tab:', e);
  }

  // Check if vault is unlocked in background
  try {
    const response = await chrome.runtime.sendMessage({ type: 'GET_VAULT_STATE' });
    if (response?.unlocked) {
      vault.privateKey = response.privateKey;
      vault.seedPhrase = response.seedPhrase;
      vault.users = response.users || {};
      vault.settings = response.settings || { hashLength: 16 };
      showScreen('mainScreen');
    }
  } catch (e) {
    console.error('Background check failed:', e);
  }

  // ---- Bind all event listeners ----

  // Welcome screen
  $('btnNewVault').addEventListener('click', () => showScreen('newWalletScreen'));
  $('btnRestore').addEventListener('click', () => showScreen('restoreScreen'));
  $('btnUnlock').addEventListener('click', () => showScreen('unlockScreen'));

  // New wallet
  $('backFromNew').addEventListener('click', goBack);
  $('btnConfirmSeed').addEventListener('click', confirmSeedBackup);

  // Verify seed
  $('backFromVerify').addEventListener('click', goBack);
  $('btnVerifySeed').addEventListener('click', verifySeedBackup);

  // Restore
  $('backFromRestore').addEventListener('click', goBack);
  $('restoreSeedInput').addEventListener('input', onSeedInput);
  $('restoreSeedInput').addEventListener('keydown', onSeedKeydown);
  $('btnRestoreSeed').addEventListener('click', restoreFromSeed);

  // Unlock
  $('backFromUnlockScreen').addEventListener('click', goBack);
  $('unlockPassword').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') unlockVault();
  });
  $('btnUnlockVault').addEventListener('click', unlockVault);

  // Main screen
  $('btnSettings').addEventListener('click', () => showScreen('settingsScreen'));
  $('btnLock').addEventListener('click', lockVault);
  $('siteSearch').addEventListener('input', filterSites);
  $('siteSearch').addEventListener('keydown', handleSearchEnter);
  $('btnDomainBanner').addEventListener('click', openSiteFromBanner);

  // Generate screen
  $('backFromGenerate').addEventListener('click', goBack);
  $('genSite').addEventListener('input', updatePassword);
  $('genUser').addEventListener('input', updatePassword);
  $('btnToggleVis').addEventListener('click', togglePasswordVisibility);
  $('btnNonceDec').addEventListener('click', decrementNonce);
  $('btnNonceInc').addEventListener('click', incrementNonce);
  $('btnCopyPassword').addEventListener('click', copyPassword);
  $('btnFillPassword').addEventListener('click', fillPassword);

  // Settings
  $('backFromSettings').addEventListener('click', goBack);
  $('settEncrypt').addEventListener('click', () => showScreen('encryptScreen'));
  $('settViewSeed').addEventListener('click', showSeedPhrase);
  $('settAdvanced').addEventListener('click', () => showScreen('advancedScreen'));
  $('settNostrBackup').addEventListener('click', () => backupToNostr());
  $('settNostrRestore').addEventListener('click', restoreFromNostr);
  $('settExport').addEventListener('click', downloadData);
  $('settImport').addEventListener('click', triggerImport);

  // Encrypt screen
  $('backFromEncrypt').addEventListener('click', goBack);
  $('encryptPass2').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') saveEncrypted();
  });
  $('btnSaveEncrypted').addEventListener('click', saveEncrypted);

  // View seed
  $('backFromViewSeed').addEventListener('click', goBack);
  $('btnCopySeed').addEventListener('click', copySeedPhrase);

  // Advanced
  $('backFromAdvanced').addEventListener('click', goBack);
  $('btnSaveAdvanced').addEventListener('click', saveAdvancedSettings);

  // Keyboard shortcuts
  document.addEventListener('keydown', (e) => {
    const genScreen = $('generateScreen');
    if (genScreen.classList.contains('hidden')) return;
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
    if (e.key === 'Enter') { e.preventDefault(); copyPassword(); }
    if (e.key === 'Escape') { e.preventDefault(); showScreen('mainScreen'); }
  });
});

// Shorthand
function $(id) {
  return document.getElementById(id);
}

// ============================================
// Navigation
// ============================================
function showScreen(screenId) {
  document.querySelectorAll('.screen').forEach((s) => s.classList.add('hidden'));
  const target = $(screenId);
  if (target) {
    target.classList.remove('hidden');
    if (navigationStack[navigationStack.length - 1] !== screenId) {
      navigationStack.push(screenId);
    }
  }

  if (screenId === 'mainScreen') {
    renderSiteList();
    showDomainBanner();
  } else if (screenId === 'newWalletScreen') {
    generateNewSeed();
  } else if (screenId === 'advancedScreen') {
    $('hashLengthSetting').value = vault.settings.hashLength || 16;
  }
}

function goBack() {
  navigationStack.pop();
  const prev = navigationStack[navigationStack.length - 1] || 'welcomeScreen';
  showScreen(prev);
}

// ============================================
// Toast / Loading
// ============================================
function showToast(message) {
  const toast = $('toast');
  toast.textContent = message;
  toast.classList.add('show');
  setTimeout(() => toast.classList.remove('show'), 2000);
}

function showLoading(text) {
  $('loadingText').textContent = text;
  $('loadingModal').classList.remove('hidden');
}

function hideLoading() {
  $('loadingModal').classList.add('hidden');
}

// ============================================
// Seed Phrase UI
// ============================================
async function generateNewSeed() {
  const mnemonic = await VaultCore.generateMnemonic();
  vault.seedPhrase = mnemonic;

  const grid = $('seedGrid');
  grid.innerHTML = '';

  mnemonic.split(' ').forEach((word, i) => {
    const div = document.createElement('div');
    div.className = 'seed-word';
    div.innerHTML = `<span>${i + 1}.</span>${escapeHtml(word)}`;
    grid.appendChild(div);
  });
}

function confirmSeedBackup() {
  const seedWords = vault.seedPhrase.split(' ');
  const indices = [];
  while (indices.length < 3) {
    const r = Math.floor(Math.random() * seedWords.length);
    if (!indices.includes(r)) indices.push(r);
  }
  indices.sort((a, b) => a - b);

  const container = $('verifyInputs');
  container.innerHTML = '';
  container.dataset.indices = JSON.stringify(indices);

  indices.forEach((i) => {
    const div = document.createElement('div');
    div.className = 'input-group';

    const label = document.createElement('label');
    label.textContent = `Word #${i + 1}`;

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'verify-word';
    input.dataset.index = i;
    input.placeholder = `Enter word ${i + 1}`;
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') verifySeedBackup();
    });

    div.appendChild(label);
    div.appendChild(input);
    container.appendChild(div);
  });

  showScreen('verifySeedScreen');
}

async function verifySeedBackup() {
  const seedWords = vault.seedPhrase.split(' ');
  const inputs = document.querySelectorAll('.verify-word');
  let valid = true;

  inputs.forEach((input) => {
    const idx = parseInt(input.dataset.index);
    if (input.value.trim().toLowerCase() !== seedWords[idx]) {
      input.style.borderColor = 'var(--danger)';
      valid = false;
    } else {
      input.style.borderColor = 'var(--success)';
    }
  });

  if (valid) {
    await initializeVault(vault.seedPhrase);
    showScreen('mainScreen');
  } else {
    showToast('Incorrect words. Try again.');
  }
}

async function restoreFromSeed() {
  const input = $('restoreSeedInput').value;
  const valid = await VaultCore.verifyBip39SeedPhrase(input);

  if (!valid) {
    showToast('Invalid seed phrase');
    return;
  }

  await initializeVault(input);
  showScreen('mainScreen');
}

// ============================================
// Vault Init & Lock
// ============================================
async function initializeVault(seedPhrase) {
  vault.seedPhrase = seedPhrase.replace(/\s+/g, ' ').trim().toLowerCase();
  vault.privateKey = await VaultCore.derivePrivateKey(vault.seedPhrase);

  // Try to load saved site data
  const saved = await VaultStorage.getVault();
  if (saved) {
    vault.users = { ...vault.users, ...saved.users };
    if (saved.settings)
      vault.settings = { ...vault.settings, ...saved.settings };
  }

  // Sync vault state to background service worker
  await syncStateToBackground();

  // Auto-sync from Nostr (silent)
  checkForRemoteBackups();
}

async function checkForRemoteBackups() {
  try {
    const data = await VaultStorage.restoreFromNostr(vault.privateKey);
    if (data) {
      vault.users = { ...vault.users, ...data.users };
      if (data.settings) vault.settings = { ...vault.settings, ...data.settings };
      await VaultStorage.saveVault(vault);
      await syncStateToBackground();
      renderSiteList();
      showToast('Synced from cloud backup!');
    }
  } catch (e) {
    console.error('Remote backup check failed:', e);
  }
}

async function lockVault(skipConfirm = false) {
  if (!skipConfirm && vault.privateKey) {
    if (!confirm('Lock vault? Make sure you have your seed phrase saved.')) return;
  }
  if (clipboardClearTimer) clearTimeout(clipboardClearTimer);
  clipboardClearTimer = null;
  navigator.clipboard.writeText('').catch(() => {});

  vault = {
    privateKey: '',
    seedPhrase: '',
    users: {},
    settings: { hashLength: 16 },
  };
  navigationStack = ['welcomeScreen'];

  await chrome.runtime.sendMessage({ type: 'LOCK_VAULT' });
  showScreen('welcomeScreen');
  showToast('Vault locked');
}

async function syncStateToBackground() {
  await chrome.runtime.sendMessage({
    type: 'SET_VAULT_STATE',
    data: {
      privateKey: vault.privateKey,
      seedPhrase: vault.seedPhrase,
      users: vault.users,
      settings: vault.settings,
    },
  });
}

// ============================================
// Domain Banner (current tab detection)
// ============================================
function showDomainBanner() {
  const banner = $('domainBanner');
  const bannerText = $('domainBannerText');

  if (
    !currentTabDomain ||
    currentTabDomain === 'newtab' ||
    currentTabDomain.includes('chrome')
  ) {
    banner.classList.add('hidden');
    return;
  }

  // Check if we already have this site
  let found = false;
  for (const [user, sites] of Object.entries(vault.users || {})) {
    if (sites[currentTabDomain] !== undefined) {
      found = true;
      break;
    }
  }

  if (!found) {
    bannerText.textContent = `Generate for ${currentTabDomain}?`;
    banner.classList.remove('hidden');
  } else {
    banner.classList.add('hidden');
  }
}

function openSiteFromBanner() {
  if (currentTabDomain) {
    openSite(currentTabDomain, '', 0);
  }
}

// ============================================
// Site List
// ============================================
function renderSiteList() {
  const container = $('siteList');
  const emptyState = $('emptyState');
  const searchTerm = $('siteSearch').value.toLowerCase();

  const sites = [];
  Object.entries(vault.users || {}).forEach(([user, userSites]) => {
    Object.entries(userSites).forEach(([site, nonce]) => {
      sites.push({ user, site, nonce });
    });
  });

  // Sort: current domain first, then alphabetical
  sites.sort((a, b) => {
    if (currentTabDomain) {
      if (a.site === currentTabDomain && b.site !== currentTabDomain) return -1;
      if (b.site === currentTabDomain && a.site !== currentTabDomain) return 1;
    }
    return a.site.localeCompare(b.site);
  });

  const filtered = sites.filter(
    (s) =>
      s.site.toLowerCase().includes(searchTerm) ||
      s.user.toLowerCase().includes(searchTerm)
  );

  if (filtered.length === 0 && !searchTerm) {
    container.innerHTML = '';
    emptyState.classList.remove('hidden');
    return;
  }

  emptyState.classList.add('hidden');
  container.innerHTML = '';

  filtered.forEach((s) => {
    const div = document.createElement('div');
    div.className = 'site-item';
    if (s.site === currentTabDomain) div.classList.add('current-site');

    const icon = document.createElement('div');
    icon.className = 'site-icon';
    icon.textContent = s.site.charAt(0).toUpperCase();

    const info = document.createElement('div');
    info.className = 'site-info';
    const nameEl = document.createElement('div');
    nameEl.className = 'site-name';
    nameEl.textContent = s.site;
    const userEl = document.createElement('div');
    userEl.className = 'site-user';
    userEl.textContent = s.user;
    info.appendChild(nameEl);
    info.appendChild(userEl);

    const delBtn = document.createElement('button');
    delBtn.className = 'btn-delete';
    delBtn.textContent = '✕';
    delBtn.title = 'Delete';
    delBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      deleteSite(s.site, s.user);
    });

    div.appendChild(icon);
    div.appendChild(info);
    div.appendChild(delBtn);
    div.addEventListener('click', () => openSite(s.site, s.user, s.nonce));
    container.appendChild(div);
  });
}

function filterSites() {
  renderSiteList();
}

function handleSearchEnter(event) {
  if (event.key === 'Enter') {
    const term = $('siteSearch').value.trim();
    if (term) {
      openSite(term, '', 0);
    }
  }
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// ============================================
// Password Generation Screen
// ============================================
function openSite(site, user, nonce) {
  $('genSite').value = site;
  $('genUser').value = user;
  currentNonce = nonce || 0;
  originalNonce = currentNonce;
  $('nonceDisplay').textContent = currentNonce + 1;
  passwordVisible = false;
  $('genPassword').textContent = '••••••••••••';
  $('visibilityIcon').textContent = '👁️';
  updateNonceIndicator();

  // Always show strength
  const strengthEl = $('passwordStrength');
  if (strengthEl) {
    const s = VaultCore.getPasswordStrength(vault.settings.hashLength || 16);
    strengthEl.innerHTML = `<span style="color:${s.color}">● ${s.label}</span> · ${s.bits}-bit · ${s.len} chars`;
  }

  if (site && user) {
    updatePassword();
  }

  showScreen('generateScreen');
}

function updateNonceIndicator() {
  const nonceControl = document.querySelector('.nonce-control');
  if (currentNonce !== originalNonce) {
    nonceControl.classList.add('nonce-changed');
  } else {
    nonceControl.classList.remove('nonce-changed');
  }
}

function updatePassword() {
  const site = $('genSite').value.trim();
  const user = $('genUser').value.trim();
  const strengthEl = $('passwordStrength');

  if (!site || !user || !vault.privateKey) {
    $('genPassword').textContent = '••••••••••••';
    if (strengthEl) strengthEl.textContent = '';
    return;
  }

  const hl = vault.settings.hashLength || 16;
  const pass = VaultCore.generatePassword(vault.privateKey, user, site, currentNonce, hl);

  if (passwordVisible) {
    $('genPassword').textContent = pass;
  }

  if (strengthEl) {
    const s = VaultCore.getPasswordStrength(hl);
    strengthEl.innerHTML = `<span style="color:${s.color}">● ${s.label}</span> · ${s.bits}-bit · ${s.len} chars`;
  }
}

function togglePasswordVisibility() {
  passwordVisible = !passwordVisible;
  $('visibilityIcon').textContent = passwordVisible ? '🙈' : '👁️';

  if (passwordVisible) {
    updatePassword();
  } else {
    $('genPassword').textContent = '••••••••••••';
  }
}

function incrementNonce() {
  currentNonce++;
  $('nonceDisplay').textContent = currentNonce + 1;
  updateNonceIndicator();
  if (passwordVisible) updatePassword();
}

function decrementNonce() {
  if (currentNonce > 0) {
    currentNonce--;
    $('nonceDisplay').textContent = currentNonce + 1;
    updateNonceIndicator();
    if (passwordVisible) updatePassword();
  }
}

async function copyPassword() {
  const site = $('genSite').value.trim();
  const user = $('genUser').value.trim();

  if (!site || !user) {
    showToast('Enter site and username');
    return;
  }

  // Save site
  if (!vault.users[user]) vault.users[user] = {};
  vault.users[user][site] = currentNonce;
  originalNonce = currentNonce;
  updateNonceIndicator();

  const pass = VaultCore.generatePassword(
    vault.privateKey,
    user,
    site,
    currentNonce,
    vault.settings.hashLength || 16
  );

  try {
    await navigator.clipboard.writeText(pass);
    showToast('Saved & copied!');
    // Auto-clear clipboard after 30 seconds
    if (clipboardClearTimer) clearTimeout(clipboardClearTimer);
    clipboardClearTimer = setTimeout(() => {
      navigator.clipboard.writeText('').catch(() => {});
    }, 30000);
  } catch {
    showToast('Copy failed');
  }

  // Persist
  await VaultStorage.saveVault(vault);
  await syncStateToBackground();
  // Silent Nostr backup
  VaultStorage.backupToNostr(vault).catch(e => console.error('Silent backup failed:', e));
}

async function fillPassword() {
  const site = $('genSite').value.trim();
  const user = $('genUser').value.trim();

  if (!site || !user) {
    showToast('Enter site and username');
    return;
  }

  // Save site
  if (!vault.users[user]) vault.users[user] = {};
  vault.users[user][site] = currentNonce;
  originalNonce = currentNonce;

  const pass = VaultCore.generatePassword(
    vault.privateKey,
    user,
    site,
    currentNonce,
    vault.settings.hashLength || 16
  );

  // Send fill command to content script
  try {
    const [tab] = await chrome.tabs.query({
      active: true,
      currentWindow: true,
    });
    if (tab?.id) {
      await chrome.tabs.sendMessage(tab.id, {
        type: 'FILL_PASSWORD',
        password: pass,
        username: user,
      });
      showToast('Filled!');
    }
  } catch (e) {
    console.error('Fill failed:', e);
    showToast('Could not fill — try copying instead');
  }

  await VaultStorage.saveVault(vault);
  await syncStateToBackground();
}

// ============================================
// Encryption
// ============================================
async function unlockVault() {
  // Rate limiting
  const now = Date.now();
  if (now < unlockLockoutUntil) {
    const secs = Math.ceil((unlockLockoutUntil - now) / 1000);
    showToast(`Too many attempts. Wait ${secs}s`);
    return;
  }

  const password = $('unlockPassword').value;
  if (!password) {
    showToast('Enter password');
    return;
  }

  try {
    const key = VaultCore.hash(password);
    const stored = await VaultStorage.getEncrypted();
    const encrypted = stored[key];

    if (!encrypted) {
      unlockAttempts++;
      if (unlockAttempts >= MAX_UNLOCK_ATTEMPTS) {
        unlockLockoutUntil = Date.now() + UNLOCK_LOCKOUT_MS;
        unlockAttempts = 0;
        showToast('Too many attempts. Locked for 30s');
      } else {
        showToast(`Wrong password (${MAX_UNLOCK_ATTEMPTS - unlockAttempts} attempts left)`);
      }
      return;
    }

    const decrypted = CryptoJS.AES.decrypt(encrypted, password).toString(
      CryptoJS.enc.Utf8
    );
    const data = JSON.parse(decrypted);

    if (data.privateKey) {
      vault.privateKey = data.privateKey;
      vault.seedPhrase = data.seedPhrase || '';
      vault.users = data.users || {};
      vault.settings = data.settings || { hashLength: 16 };
    } else {
      vault = data;
    }

    unlockAttempts = 0;
    await syncStateToBackground();
    showToast('Vault unlocked!');
    showScreen('mainScreen');
  } catch (e) {
    console.error(e);
    unlockAttempts++;
    if (unlockAttempts >= MAX_UNLOCK_ATTEMPTS) {
      unlockLockoutUntil = Date.now() + UNLOCK_LOCKOUT_MS;
      unlockAttempts = 0;
      showToast('Too many attempts. Locked for 30s');
    } else {
      showToast('Invalid password');
    }
  }
}

async function saveEncrypted() {
  const pass1 = $('encryptPass1').value;
  const pass2 = $('encryptPass2').value;

  if (!pass1 || pass1 !== pass2) {
    showToast("Passwords don't match");
    return;
  }

  const key = VaultCore.hash(pass1);
  const saveData = {
    privateKey: vault.privateKey,
    seedPhrase: vault.seedPhrase,
    users: vault.users,
    settings: vault.settings,
  };
  const encrypted = CryptoJS.AES.encrypt(
    JSON.stringify(saveData),
    pass1
  ).toString();

  const stored = await VaultStorage.getEncrypted();
  stored[key] = encrypted;
  await VaultStorage.saveEncrypted(stored);

  showToast('Vault saved!');
  showScreen('settingsScreen');
}

// ============================================
// Settings
// ============================================
function showSeedPhrase() {
  if (!vault.seedPhrase) {
    showToast('Seed phrase not available');
    return;
  }

  const grid = $('viewSeedGrid');
  grid.innerHTML = '';

  vault.seedPhrase.split(' ').forEach((word, i) => {
    const div = document.createElement('div');
    div.className = 'seed-word';
    div.innerHTML = `<span>${i + 1}.</span>${escapeHtml(word)}`;
    grid.appendChild(div);
  });

  showScreen('viewSeedScreen');
}

async function copySeedPhrase() {
  try {
    await navigator.clipboard.writeText(vault.seedPhrase);
    showToast('Seed phrase copied!');
  } catch {
    showToast('Copy failed');
  }
}

async function saveAdvancedSettings() {
  const len = parseInt($('hashLengthSetting').value) || 16;
  vault.settings.hashLength = Math.max(8, Math.min(64, len));
  await VaultStorage.saveVault(vault);
  await syncStateToBackground();
  showToast('Settings saved');
  showScreen('settingsScreen');
}

function downloadData() {
  const data = { users: vault.users, settings: vault.settings };
  const blob = new Blob([JSON.stringify(data, null, 2)], {
    type: 'application/json',
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'vault-export.json';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  showToast('Downloaded!');
}

// ============================================
// Site Management
// ============================================
async function deleteSite(site, user) {
  if (!confirm(`Delete ${site} (${user})?`)) return;

  if (vault.users[user]) {
    delete vault.users[user][site];
    if (Object.keys(vault.users[user]).length === 0) {
      delete vault.users[user];
    }
  }

  showToast('Site deleted');
  renderSiteList();
  await VaultStorage.saveVault(vault);
  await syncStateToBackground();
  VaultStorage.backupToNostr(vault).catch(e => console.error('Silent backup failed:', e));
}

// ============================================
// Import
// ============================================
function triggerImport() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.json,application/json';
  input.onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const text = await file.text();
      const data = JSON.parse(text);
      if (!data.users || typeof data.users !== 'object') {
        showToast('Invalid vault file');
        return;
      }
      const siteCount = Object.values(data.users).reduce((n, u) => n + Object.keys(u).length, 0);
      if (!confirm(`Import ${siteCount} site(s)? This will merge with your current vault.`)) return;
      Object.entries(data.users).forEach(([user, sites]) => {
        if (!vault.users[user]) vault.users[user] = {};
        Object.entries(sites).forEach(([site, nonce]) => {
          if (vault.users[user][site] === undefined || nonce > vault.users[user][site]) {
            vault.users[user][site] = nonce;
          }
        });
      });
      if (data.settings) vault.settings = { ...vault.settings, ...data.settings };
      renderSiteList();
      await VaultStorage.saveVault(vault);
      await syncStateToBackground();
      VaultStorage.backupToNostr(vault).catch(e => console.error('Backup failed:', e));
      showToast(`Imported ${siteCount} site(s)!`);
    } catch (err) {
      console.error(err);
      showToast('Failed to import file');
    }
  };
  input.click();
}

// ============================================
// Nostr Backup — NIP-44 + kind:30078
// ============================================
async function backupToNostr(silent = false) {
  if (!vault.privateKey) {
    if (!silent) showToast('Vault not initialized');
    return;
  }

  if (!silent) showLoading('Backing up to Nostr...');

  const result = await VaultStorage.backupToNostr(vault);

  if (!silent) {
    hideLoading();
    if (result.success > 0) {
      showToast(`Backed up to ${result.success} relay(s)`);
    } else {
      showToast('Backup failed');
    }
  }
}

async function restoreFromNostr() {
  if (!vault.privateKey) {
    showToast('Vault not initialized');
    return;
  }

  showLoading('Restoring from Nostr...');

  try {
    const data = await VaultStorage.restoreFromNostr(vault.privateKey);
    hideLoading();

    if (data) {
      vault.users = { ...vault.users, ...data.users };
      if (data.settings) vault.settings = { ...vault.settings, ...data.settings };
      renderSiteList();
      await VaultStorage.saveVault(vault);
      await syncStateToBackground();
      showToast('Restored from Nostr!');
    } else {
      showToast('No backup found');
    }
  } catch (e) {
    console.error(e);
    hideLoading();
    showToast('Restore error');
  }
}

// ============================================
// Seed Autocomplete
// ============================================
function onSeedInput(event) {
  const textarea = event.target;
  const value = textarea.value;
  const cursorPos = textarea.selectionStart;
  const beforeCursor = value.slice(0, cursorPos);
  const wordMatch = beforeCursor.match(/[a-z]+$/i);
  const currentWord = wordMatch ? wordMatch[0].toLowerCase() : '';

  const wordCount = value
    .trim()
    .split(/\s+/)
    .filter((w) => w.length > 0).length;
  $('wordCount').textContent = wordCount;

  const suggestions = $('seedSuggestions');

  if (currentWord.length < 1) {
    suggestions.classList.add('hidden');
    currentSuggestions = [];
    return;
  }

  currentSuggestions = words
    .filter((w) => w.startsWith(currentWord))
    .slice(0, 6);

  if (
    currentSuggestions.length === 0 ||
    (currentSuggestions.length === 1 && currentSuggestions[0] === currentWord)
  ) {
    suggestions.classList.add('hidden');
    return;
  }

  activeSuggestionIndex = 0;
  renderSuggestions(currentWord);
  suggestions.classList.remove('hidden');
}

function renderSuggestions(typed) {
  const suggestions = $('seedSuggestions');
  suggestions.innerHTML = '';

  currentSuggestions.forEach((word, i) => {
    const div = document.createElement('div');
    div.className = 'seed-suggestion' + (i === activeSuggestionIndex ? ' active' : '');

    const matchSpan = document.createElement('span');
    matchSpan.className = 'seed-suggestion-match';
    matchSpan.textContent = word.slice(0, typed.length);

    div.appendChild(matchSpan);
    div.appendChild(document.createTextNode(word.slice(typed.length)));

    div.addEventListener('click', () => selectSuggestion(word));
    suggestions.appendChild(div);
  });
}

function onSeedKeydown(event) {
  const suggestions = $('seedSuggestions');

  if (
    suggestions.classList.contains('hidden') ||
    currentSuggestions.length === 0
  ) {
    return;
  }

  if (event.key === 'ArrowDown') {
    event.preventDefault();
    activeSuggestionIndex =
      (activeSuggestionIndex + 1) % currentSuggestions.length;
    renderSuggestions(getCurrentTypedWord());
  } else if (event.key === 'ArrowUp') {
    event.preventDefault();
    activeSuggestionIndex =
      activeSuggestionIndex <= 0
        ? currentSuggestions.length - 1
        : activeSuggestionIndex - 1;
    renderSuggestions(getCurrentTypedWord());
  } else if (event.key === 'Tab' || event.key === 'Enter') {
    if (currentSuggestions.length > 0) {
      event.preventDefault();
      selectSuggestion(currentSuggestions[activeSuggestionIndex]);
    }
  } else if (event.key === 'Escape') {
    suggestions.classList.add('hidden');
  }
}

function getCurrentTypedWord() {
  const textarea = $('restoreSeedInput');
  const cursorPos = textarea.selectionStart;
  const beforeCursor = textarea.value.slice(0, cursorPos);
  const wordMatch = beforeCursor.match(/[a-z]+$/i);
  return wordMatch ? wordMatch[0].toLowerCase() : '';
}

function selectSuggestion(word) {
  const textarea = $('restoreSeedInput');
  const cursorPos = textarea.selectionStart;
  const value = textarea.value;

  const beforeCursor = value.slice(0, cursorPos);
  const wordMatch = beforeCursor.match(/[a-z]+$/i);
  const wordStart = wordMatch ? cursorPos - wordMatch[0].length : cursorPos;

  const newValue =
    value.slice(0, wordStart) + word + ' ' + value.slice(cursorPos);
  textarea.value = newValue;

  const newCursorPos = wordStart + word.length + 1;
  textarea.setSelectionRange(newCursorPos, newCursorPos);
  textarea.focus();

  $('seedSuggestions').classList.add('hidden');
  currentSuggestions = [];

  const wordCount = newValue
    .trim()
    .split(/\s+/)
    .filter((w) => w.length > 0).length;
  $('wordCount').textContent = wordCount;
}
