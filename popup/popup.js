/**
 * Vault Chrome Extension — Popup Logic
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

// Autocomplete state
let activeSuggestionIndex = -1;
let currentSuggestions = [];

const RELAYS = [
  'wss://relay.damus.io',
  'wss://nostr-pub.wellorder.net',
  'wss://relay.snort.social',
  'wss://nos.lol',
];

// ============================================
// Init
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

  // Check for saved encrypted vault
  const encrypted = await VaultStorage.getEncrypted();
  if (encrypted && Object.keys(encrypted).length > 0) {
    // Has saved vault — show unlock option prominently
  }

  // Check if vault data exists in session (background keeps unlocked state)
  const response = await chrome.runtime.sendMessage({ type: 'GET_VAULT_STATE' });
  if (response?.unlocked) {
    vault.privateKey = response.privateKey;
    vault.seedPhrase = response.seedPhrase;
    vault.users = response.users || {};
    vault.settings = response.settings || { hashLength: 16 };
    showScreen('mainScreen');
  }
});

// ============================================
// Navigation
// ============================================
function showScreen(screenId) {
  document.querySelectorAll('.screen').forEach((s) => s.classList.add('hidden'));
  const target = document.getElementById(screenId);
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
    document.getElementById('hashLengthSetting').value =
      vault.settings.hashLength || 16;
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
  const toast = document.getElementById('toast');
  toast.textContent = message;
  toast.classList.add('show');
  setTimeout(() => toast.classList.remove('show'), 2000);
}

function showLoading(text) {
  document.getElementById('loadingText').textContent = text;
  document.getElementById('loadingModal').classList.remove('hidden');
}

function hideLoading() {
  document.getElementById('loadingModal').classList.add('hidden');
}

// ============================================
// Seed Phrase UI
// ============================================
async function generateNewSeed() {
  const mnemonic = await VaultCore.generateMnemonic();
  vault.seedPhrase = mnemonic;

  const grid = document.getElementById('seedGrid');
  grid.innerHTML = '';

  mnemonic.split(' ').forEach((word, i) => {
    const div = document.createElement('div');
    div.className = 'seed-word';
    div.innerHTML = `<span>${i + 1}.</span>${word}`;
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

  const container = document.getElementById('verifyInputs');
  container.innerHTML = '';
  container.dataset.indices = JSON.stringify(indices);

  indices.forEach((i) => {
    const div = document.createElement('div');
    div.className = 'input-group';
    div.innerHTML = `
      <label>Word #${i + 1}</label>
      <input type="text" class="verify-word" data-index="${i}" 
             placeholder="Enter word ${i + 1}" 
             onkeydown="if(event.key==='Enter')verifySeedBackup()">
    `;
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
  const input = document.getElementById('restoreSeedInput').value;
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

  // Sync vault state to background service worker
  await chrome.runtime.sendMessage({
    type: 'SET_VAULT_STATE',
    data: {
      privateKey: vault.privateKey,
      seedPhrase: vault.seedPhrase,
      users: vault.users,
      settings: vault.settings,
    },
  });

  // Try to load saved site data
  const saved = await VaultStorage.getVault();
  if (saved) {
    vault.users = { ...vault.users, ...saved.users };
    if (saved.settings)
      vault.settings = { ...vault.settings, ...saved.settings };
  }
}

async function lockVault() {
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

// ============================================
// Domain Banner (current tab detection)
// ============================================
function showDomainBanner() {
  const banner = document.getElementById('domainBanner');
  const bannerText = document.getElementById('domainBannerText');

  if (!currentTabDomain || currentTabDomain === 'newtab' || currentTabDomain.includes('chrome')) {
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
  const container = document.getElementById('siteList');
  const emptyState = document.getElementById('emptyState');
  const searchTerm = document.getElementById('siteSearch').value.toLowerCase();

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
  container.innerHTML = filtered
    .map((s) => {
      const isCurrentSite = s.site === currentTabDomain;
      return `
      <div class="site-item ${isCurrentSite ? 'current-site' : ''}" 
           onclick="openSite('${escapeAttr(s.site)}', '${escapeAttr(s.user)}', ${s.nonce})">
        <div class="site-icon">${s.site.charAt(0)}</div>
        <div class="site-info">
          <div class="site-name">${escapeHtml(s.site)}</div>
          <div class="site-user">${escapeHtml(s.user)}</div>
        </div>
      </div>
    `;
    })
    .join('');
}

function filterSites() {
  renderSiteList();
}

function handleSearchEnter(event) {
  if (event.key === 'Enter') {
    const term = document.getElementById('siteSearch').value.trim();
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

function escapeAttr(str) {
  return str.replace(/'/g, "\\'").replace(/"/g, '&quot;');
}

// ============================================
// Password Generation Screen
// ============================================
function openSite(site, user, nonce) {
  document.getElementById('genSite').value = site;
  document.getElementById('genUser').value = user;
  currentNonce = nonce || 0;
  originalNonce = currentNonce;
  document.getElementById('nonceDisplay').textContent = currentNonce + 1;
  passwordVisible = false;
  document.getElementById('genPassword').textContent = '••••••••••••';
  document.getElementById('visibilityIcon').textContent = '👁️';
  updateNonceIndicator();

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
  const site = document.getElementById('genSite').value.trim();
  const user = document.getElementById('genUser').value.trim();

  if (!site || !user || !vault.privateKey) {
    document.getElementById('genPassword').textContent = '••••••••••••';
    return;
  }

  const pass = VaultCore.generatePassword(
    vault.privateKey,
    user,
    site,
    currentNonce,
    vault.settings.hashLength || 16
  );

  if (passwordVisible) {
    document.getElementById('genPassword').textContent = pass;
  }
}

function togglePasswordVisibility() {
  passwordVisible = !passwordVisible;
  document.getElementById('visibilityIcon').textContent = passwordVisible
    ? '🙈'
    : '👁️';

  if (passwordVisible) {
    updatePassword();
  } else {
    document.getElementById('genPassword').textContent = '••••••••••••';
  }
}

function incrementNonce() {
  currentNonce++;
  document.getElementById('nonceDisplay').textContent = currentNonce + 1;
  updateNonceIndicator();
  if (passwordVisible) updatePassword();
}

function decrementNonce() {
  if (currentNonce > 0) {
    currentNonce--;
    document.getElementById('nonceDisplay').textContent = currentNonce + 1;
    updateNonceIndicator();
    if (passwordVisible) updatePassword();
  }
}

async function copyPassword() {
  const site = document.getElementById('genSite').value.trim();
  const user = document.getElementById('genUser').value.trim();

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
  } catch {
    showToast('Copy failed');
  }

  // Persist
  await VaultStorage.saveVault(vault);
  await syncStateToBackground();
}

async function fillPassword() {
  const site = document.getElementById('genSite').value.trim();
  const user = document.getElementById('genUser').value.trim();

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
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
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
// Encryption
// ============================================
async function unlockVault() {
  const password = document.getElementById('unlockPassword').value;
  if (!password) {
    showToast('Enter password');
    return;
  }

  try {
    const key = VaultCore.hash(password);
    const stored = await VaultStorage.getEncrypted();
    const encrypted = stored[key];

    if (!encrypted) {
      showToast('No vault found for this password');
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

    await syncStateToBackground();
    showToast('Vault unlocked!');
    showScreen('mainScreen');
  } catch (e) {
    console.error(e);
    showToast('Invalid password');
  }
}

async function saveEncrypted() {
  const pass1 = document.getElementById('encryptPass1').value;
  const pass2 = document.getElementById('encryptPass2').value;

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

  const grid = document.getElementById('viewSeedGrid');
  grid.innerHTML = '';

  vault.seedPhrase.split(' ').forEach((word, i) => {
    const div = document.createElement('div');
    div.className = 'seed-word';
    div.innerHTML = `<span>${i + 1}.</span>${word}`;
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
  const len =
    parseInt(document.getElementById('hashLengthSetting').value) || 16;
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
// Nostr Backup (simplified — no relay lib in extension context, use fetch-based)
// ============================================
async function backupToNostr(silent = false) {
  // TODO: Port Nostr backup to extension context
  // For now, show a message
  if (!silent) showToast('Nostr backup coming soon');
}

async function restoreFromNostr() {
  showToast('Nostr restore coming soon');
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
  document.getElementById('wordCount').textContent = wordCount;

  const suggestions = document.getElementById('seedSuggestions');

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
  const suggestions = document.getElementById('seedSuggestions');
  suggestions.innerHTML = currentSuggestions
    .map((word, i) => {
      const matchPart = word.slice(0, typed.length);
      const restPart = word.slice(typed.length);
      return `<div class="seed-suggestion ${i === activeSuggestionIndex ? 'active' : ''}" 
                   onclick="selectSuggestion('${word}')">
          <span class="seed-suggestion-match">${matchPart}</span>${restPart}
      </div>`;
    })
    .join('');
}

function onSeedKeydown(event) {
  const suggestions = document.getElementById('seedSuggestions');

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
  const textarea = document.getElementById('restoreSeedInput');
  const cursorPos = textarea.selectionStart;
  const beforeCursor = textarea.value.slice(0, cursorPos);
  const wordMatch = beforeCursor.match(/[a-z]+$/i);
  return wordMatch ? wordMatch[0].toLowerCase() : '';
}

function selectSuggestion(word) {
  const textarea = document.getElementById('restoreSeedInput');
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

  document.getElementById('seedSuggestions').classList.add('hidden');
  currentSuggestions = [];

  const wordCount = newValue
    .trim()
    .split(/\s+/)
    .filter((w) => w.length > 0).length;
  document.getElementById('wordCount').textContent = wordCount;
}
