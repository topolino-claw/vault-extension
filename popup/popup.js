/**
 * @fileoverview Vault Chrome Extension — Popup Logic
 *
 * This file drives the entire popup UI. It is a single-page application with
 * a stack-based navigation model: screens are hidden/shown by toggling the
 * `.hidden` class; the `navigationStack` array tracks where the user can go
 * "back" to.
 *
 * ─── UI State Machine ────────────────────────────────────────────────────────
 *
 *   welcomeScreen
 *     ├── newWalletScreen → verifySeedScreen → setupEncryptScreen → mainScreen
 *     ├── restoreScreen                      → setupEncryptScreen → mainScreen
 *     └── unlockScreen                                            → mainScreen
 *
 *   mainScreen
 *     ├── generateScreen (open a site or add new one)
 *     └── settingsScreen
 *           ├── encryptScreen
 *           ├── viewSeedScreen
 *           ├── advancedScreen
 *           └── (Nostr backup/restore — inline, no dedicated screen)
 *
 * ─── Dependencies (script load order in popup.html) ─────────────────────────
 *   1. crypto-js.min.js    — CryptoJS AES + SHA256 (synchronous hashing)
 *   2. bip39WordList.js    — exposes global `words` array (2048 BIP39 words)
 *   3. nostr-tools.min.js  — exposes global `NostrTools` for relay/NIP ops
 *   4. vault-core.js       — exposes global `VaultCore` (password generation)
 *   5. vault-storage.js    — exposes global `VaultStorage` (chrome.storage wrapper)
 *   6. popup.js            — this file
 *
 * All event listeners are registered via `addEventListener` (not inline `onclick`)
 * to comply with the Manifest V3 Content Security Policy that forbids inline scripts.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Module-level state
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The in-memory vault object for the current popup session.
 * Populated from chrome.storage.local (encrypted blob or cached background state)
 * on open; cleared on lock.
 *
 * @type {{ privateKey: string, seedPhrase: string, users: Object.<string, Object.<string, number>>, settings: { hashLength: number } }}
 */
let vault = {
  privateKey: '',
  seedPhrase: '',
  /** users[username][site] = nonce (version number, 0-based) */
  users: {},
  settings: { hashLength: 16 },
};

/** Current nonce (version) value displayed on the generate screen. @type {number} */
let currentNonce = 0;

/**
 * The nonce value when the generate screen was opened (or when the password was
 * last copied/filled). Used to detect unsaved nonce changes (visual indicator).
 * @type {number}
 */
let originalNonce = 0;

/** Whether the generated password is currently shown in plaintext. @type {boolean} */
let passwordVisible = false;

/**
 * Navigation breadcrumb stack. Each entry is a screen element ID.
 * `goBack()` pops the current screen and shows the previous one.
 * @type {string[]}
 */
let navigationStack = ['welcomeScreen'];

/**
 * The registrable domain of the active browser tab when the popup opened.
 * Used for the domain banner and to highlight matching sites in the list.
 * @type {string|null}
 */
let currentTabDomain = null;

/**
 * Reference to the pending `setTimeout` that clears the clipboard after 30s.
 * Stored so it can be cancelled when the vault is locked.
 * @type {number|null}
 */
let clipboardClearTimer = null;

/** Consecutive failed unlock attempts (for rate limiting). @type {number} */
let unlockAttempts = 0;

/**
 * `Date.now()` timestamp at which the unlock lockout expires.
 * 0 means no active lockout.
 * @type {number}
 */
let unlockLockoutUntil = 0;

/** Maximum failed attempts before triggering a lockout. @type {number} */
const MAX_UNLOCK_ATTEMPTS = 5;

/** Lockout duration in milliseconds after too many failed unlock attempts. @type {number} */
const UNLOCK_LOCKOUT_MS = 30 * 1000;

// ── BIP39 autocomplete state ──
/** Index of the currently highlighted suggestion (keyboard navigation). @type {number} */
let activeSuggestionIndex = -1;

/** Current list of word suggestions shown in the autocomplete dropdown. @type {string[]} */
let currentSuggestions = [];

// ─────────────────────────────────────────────────────────────────────────────
// Init & Event Binding
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Entry point — runs once the popup DOM is ready.
 *
 * Sequence:
 *   1. Get the current tab's domain (for autofill context).
 *   2. Check if the vault is already unlocked in the background service worker.
 *      If yes, skip the welcome screen and go directly to the main screen.
 *   3. Check if an encrypted vault blob exists in storage (to style the Unlock button).
 *   4. Bind all button/input event listeners (MV3 requires addEventListener, not onclick).
 *
 * @listens DOMContentLoaded
 */
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

  // Check if vault is unlocked in background (service worker still alive)
  try {
    const response = await chrome.runtime.sendMessage({ type: 'GET_VAULT_STATE' });
    if (response?.unlocked) {
      vault.privateKey = response.privateKey;
      vault.seedPhrase = response.seedPhrase;
      vault.users = response.users || {};
      vault.settings = response.settings || { hashLength: 16 };
      showScreen('mainScreen');
      // Sync from Nostr in background (with loading indicator)
      syncFromNostrWithUI();
    }
  } catch (e) {
    console.error('Background check failed:', e);
  }

  // Check if there's an encrypted vault saved (show unlock button prominently)
  try {
    const stored = await VaultStorage.getEncrypted();
    if (stored && Object.keys(stored).length > 0) {
      // There's a saved vault — highlight unlock option
      $('btnUnlock').classList.add('btn-primary');
      $('btnUnlock').classList.remove('btn-ghost');
    }
  } catch (e) {}

  // ── Bind all event listeners ──

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

  // Setup encrypt screen (first-time mandatory step)
  $('setupEncryptPass2').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') setupEncryptAndContinue();
  });
  $('btnSetupEncrypt').addEventListener('click', setupEncryptAndContinue);

  // Encrypt screen (re-encrypt from settings)
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

  // Keyboard shortcuts (active only when the generate screen is visible)
  document.addEventListener('keydown', (e) => {
    const genScreen = $('generateScreen');
    if (genScreen.classList.contains('hidden')) return;
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
    if (e.key === 'Enter') { e.preventDefault(); copyPassword(); }
    if (e.key === 'Escape') { e.preventDefault(); showScreen('mainScreen'); }
  });
});

/**
 * Shorthand helper: `$(id)` is equivalent to `document.getElementById(id)`.
 *
 * @param  {string} id - The element's `id` attribute.
 * @returns {HTMLElement|null} The DOM element, or null if not found.
 */
function $(id) {
  return document.getElementById(id);
}

// ─────────────────────────────────────────────────────────────────────────────
// Navigation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Show a screen by ID and hide all others.
 *
 * All elements with class `.screen` are hidden first, then the target is revealed.
 * The screen ID is pushed onto `navigationStack` (unless it's already the top).
 *
 * Side effects by screen:
 *   - `mainScreen`     → re-renders the site list and shows/hides the domain banner.
 *   - `newWalletScreen` → generates a fresh 12-word mnemonic and renders the grid.
 *   - `advancedScreen`  → populates the hash-length input with the current setting.
 *
 * @param {string} screenId - The `id` of the screen element to show.
 */
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

/**
 * Navigate to the previous screen in the navigation stack.
 *
 * Pops the current screen off the stack and shows whatever is now at the top.
 * Falls back to `welcomeScreen` if the stack is empty.
 */
function goBack() {
  navigationStack.pop();
  const prev = navigationStack[navigationStack.length - 1] || 'welcomeScreen';
  showScreen(prev);
}

// ─────────────────────────────────────────────────────────────────────────────
// Toast / Loading
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Show a brief non-blocking toast notification at the bottom of the popup.
 *
 * The toast uses a CSS transition to slide up into view and auto-dismisses
 * after 2 seconds by removing the `.show` class.
 *
 * @param {string} message - The text to display in the toast.
 */
function showToast(message) {
  const toast = $('toast');
  toast.textContent = message;
  toast.classList.add('show');
  setTimeout(() => toast.classList.remove('show'), 2000);
}

/**
 * Show the full-screen loading modal with a custom message.
 * Used during async operations (Nostr sync, backup, restore).
 *
 * @param {string} text - Status text to display below the spinner.
 */
function showLoading(text) {
  $('loadingText').textContent = text;
  $('loadingModal').classList.remove('hidden');
}

/**
 * Hide the full-screen loading modal.
 */
function hideLoading() {
  $('loadingModal').classList.add('hidden');
}

// ─────────────────────────────────────────────────────────────────────────────
// Seed Phrase UI
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Generate a new BIP39 mnemonic and render it in the seed phrase grid.
 *
 * Called automatically when navigating to `newWalletScreen`.
 * Each word is rendered in a numbered tile for easy reading/transcription.
 * Uses `escapeHtml` as a safety measure even though BIP39 words are all ASCII.
 *
 * Mutates: `vault.seedPhrase`
 *
 * @async
 */
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

/**
 * Begin the seed verification step after the user claims to have saved their phrase.
 *
 * Picks 3 random word positions from the mnemonic and renders input fields for them.
 * The chosen indices are stored as a JSON string in `container.dataset.indices`
 * (not actually read from there — `verifySeedBackup` reads `input.dataset.index`
 * per field instead).
 *
 * Navigates to `verifySeedScreen` on completion.
 */
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

/**
 * Validate the 3 seed verification inputs against the stored mnemonic.
 *
 * Each `.verify-word` input has a `data-index` attribute pointing to the
 * expected word position. Input is compared case-insensitively after trimming.
 *
 * On success: initialises the vault with the seed phrase and navigates to the
 *             first-time encryption setup screen.
 * On failure: highlights incorrect fields in red and shows a toast.
 *
 * @async
 */
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
    // Prompt to set encryption password before going to main screen
    showScreen('setupEncryptScreen');
  } else {
    showToast('Incorrect words. Try again.');
  }
}

/**
 * Restore a vault from a user-provided BIP39 seed phrase.
 *
 * Validates the phrase via `VaultCore.verifyBip39SeedPhrase` (checks word list
 * membership AND BIP39 checksum). Invalid phrases are rejected with a toast.
 *
 * On success: initialises the vault and navigates to the encryption setup screen.
 *
 * @async
 */
async function restoreFromSeed() {
  const input = $('restoreSeedInput').value;
  const valid = await VaultCore.verifyBip39SeedPhrase(input);

  if (!valid) {
    showToast('Invalid seed phrase');
    return;
  }

  await initializeVault(input);
  // Prompt to set encryption password
  showScreen('setupEncryptScreen');
}

// ─────────────────────────────────────────────────────────────────────────────
// Vault Init & Lock
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Initialise the vault from a seed phrase.
 *
 * Steps:
 *   1. Normalise the seed phrase (collapse whitespace, lowercase).
 *   2. Derive the hex private key via `VaultCore.derivePrivateKey`.
 *   3. Load any previously saved site data from chrome.storage.local and merge.
 *   4. Sync the vault state to the background service worker (so it survives
 *      popup close/reopen within the same service worker lifetime).
 *
 * Mutates: `vault.seedPhrase`, `vault.privateKey`, `vault.users`, `vault.settings`
 *
 * @async
 * @param {string} seedPhrase - Raw seed phrase string (any whitespace/case).
 */
async function initializeVault(seedPhrase) {
  vault.seedPhrase = seedPhrase.replace(/\s+/g, ' ').trim().toLowerCase();
  vault.privateKey = await VaultCore.derivePrivateKey(vault.seedPhrase);

  // Clean up any legacy plaintext vault data (migration)
  await VaultStorage.getVault(); // triggers cleanup if plaintext key exists

  // Sync vault state to background service worker
  await syncStateToBackground();
}

/**
 * Sync from Nostr relays with a visible relay-status indicator.
 *
 * Called after the vault is initialised and the main screen is shown.
 * Updates the relay orb: syncing (amber) → connected (green) or offline (red).
 * Merges fetched data into the vault and re-renders the site list on success.
 *
 * @async
 */
async function syncFromNostrWithUI() {
  if (!vault.privateKey) return;

  updateRelayStatus('syncing');

  try {
    const data = await VaultStorage.restoreFromNostr(
      vault.privateKey,
      () => showBackupPasswordPrompt('enter')
    );
    if (data) {
      vault.users = { ...vault.users, ...data.users };
      if (data.settings) vault.settings = { ...vault.settings, ...data.settings };
      await syncStateToBackground();
      renderSiteList();
      updateRelayStatus('connected');
      showToast('Synced from Nostr!');

      // If backup was single-layer (legacy), nudge user to set a backup password
      if (data.isLegacy && !vault.settings.hasBackupPassword) {
        showBackupPasswordNudge();
      }
      // If vault has backup password but session cache is empty, prompt early
      // so silent backups don't pile up as pending
      if (vault.settings.hasBackupPassword && !VaultStorage.getSessionBackupPassword()) {
        const pwd = await showBackupPasswordPrompt('enter');
        if (pwd) {
          VaultStorage.setSessionBackupPassword(pwd);
          await syncStateToBackground();
        }
      }
    } else {
      updateRelayStatus('connected');
    }
  } catch (e) {
    console.error('Remote backup check failed:', e);
    updateRelayStatus('offline');
  }
}

/**
 * Update the relay status orb indicator in the main screen header.
 *
 * CSS classes map to colours: relay-syncing (amber/pulse), relay-connected (green),
 * relay-offline (red). See popup.css `.relay-orb` and `.relay-*` rules.
 *
 * @param {'syncing'|'connected'|'offline'} status - The new relay connection state.
 */
function updateRelayStatus(status) {
  const orb = $('relayStatus');
  if (!orb) return;
  orb.className = 'relay-orb relay-' + status;
  orb.title = status === 'syncing' ? 'Syncing with relays...'
    : status === 'connected' ? 'Connected to relays'
    : 'Offline';
}

/**
 * Lock the vault: wipe in-memory state, clear clipboard, reset to welcome screen.
 *
 * Steps:
 *   1. Optionally prompt for confirmation (skipped when `skipConfirm` is true).
 *   2. Cancel any pending clipboard-clear timer.
 *   3. Overwrite the clipboard with an empty string to prevent leakage.
 *   4. Reset the `vault` object to empty defaults.
 *   5. Reset the navigation stack.
 *   6. Tell the background service worker to clear its copy of the vault state.
 *   7. Navigate back to the welcome screen.
 *
 * @async
 * @param {boolean} [skipConfirm=false] - If true, skip the confirmation dialog.
 */
async function lockVault(skipConfirm = false) {
  if (!skipConfirm && vault.privateKey) {
    if (!confirm('Lock vault? Make sure you have your seed phrase saved.')) return;
  }
  if (clipboardClearTimer) clearTimeout(clipboardClearTimer);
  clipboardClearTimer = null;
  navigator.clipboard.writeText('').catch(() => {});

  // Clear session backup password
  VaultStorage.setSessionBackupPassword(null);

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

/**
 * Push the current vault state (private key, seed, users, settings) to the
 * background service worker's in-memory cache.
 *
 * This ensures the vault remains "unlocked" across popup opens/closes within the
 * same service worker lifetime, without requiring the user to re-enter their password.
 *
 * @async
 */
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

/**
 * Auto-save is now a no-op — plaintext vault storage has been removed.
 *
 * The vault state lives only in:
 *   1. In-memory `vault` object (this popup session)
 *   2. Background service worker cache (survives popup close)
 *   3. Encrypted blob in chrome.storage.local (survives SW death — requires password)
 *   4. Nostr relays (remote backup — requires NIP-44 + optional backup password)
 *
 * The encrypted blob can only be updated when we have the user's encryption
 * password, which happens at setup/re-encrypt time. The background SW cache
 * is updated via syncStateToBackground() on every mutation.
 *
 * @async
 */
async function autoSaveEncrypted() {
  // No-op: plaintext storage removed. Background sync handles in-session persistence.
}

// ─────────────────────────────────────────────────────────────────────────────
// Domain Banner (current tab detection)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Show or hide the "Generate for [domain]?" banner at the bottom of the main screen.
 *
 * The banner appears only if:
 *   - `currentTabDomain` is set (not a new tab, not chrome:// pages)
 *   - The domain does NOT already exist in the vault's saved sites
 *
 * If the domain already has a saved entry, the user can find it in the site list
 * (it's sorted to the top), so the banner is hidden to avoid duplication.
 */
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

/**
 * Open the password generate screen pre-filled with the current tab's domain.
 * Triggered by clicking the domain banner "Generate" button.
 */
function openSiteFromBanner() {
  if (currentTabDomain) {
    openSite(currentTabDomain, '', 0);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Site List
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Render the saved-sites list on the main screen.
 *
 * Behaviour:
 *   - Flattens `vault.users` (nested object) into `[{ user, site, nonce }]` array.
 *   - Sorts: current tab domain first, then alphabetically by site name.
 *   - Filters by the current search term (matches site OR user).
 *   - Shows `#emptyState` when there are no sites and no active search.
 *   - Each rendered row has a click handler that opens the generate screen and
 *     a delete button (visible on hover).
 *
 * Uses `textContent` for user-supplied data (site names, usernames) to prevent XSS.
 */
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
    nameEl.textContent = s.site;       // textContent — safe, no XSS
    const userEl = document.createElement('div');
    userEl.className = 'site-user';
    userEl.textContent = s.user;       // textContent — safe, no XSS
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

/**
 * Re-render the site list whenever the search input changes.
 * Bound to the `input` event on `#siteSearch`.
 */
function filterSites() {
  renderSiteList();
}

/**
 * Allow pressing Enter in the search bar to open the generate screen with the
 * search term pre-filled as the site name.
 *
 * This enables the workflow: type "github.com" → press Enter → generate screen.
 *
 * @param {KeyboardEvent} event - Keydown event on the search input.
 */
function handleSearchEnter(event) {
  if (event.key === 'Enter') {
    const term = $('siteSearch').value.trim();
    if (term) {
      openSite(term, '', 0);
    }
  }
}

/**
 * Escape a string for safe insertion as HTML text content.
 *
 * Uses the browser's native text node escaping by setting `div.textContent`
 * and reading back `div.innerHTML`. This converts &, <, >, ", ' to HTML entities.
 *
 * Used for seed word grid rendering (innerHTML context). Site/username rendering
 * uses `textContent` directly and does not require this function.
 *
 * @param  {string} str - Raw string to escape.
 * @returns {string} HTML-escaped string safe for use inside innerHTML.
 */
function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// ─────────────────────────────────────────────────────────────────────────────
// Password Generation Screen
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Open the password generation screen, pre-filling site, username, and nonce.
 *
 * If both `site` and `user` are provided (existing site), the password is
 * generated immediately. If either is empty (new site), the user must fill
 * them in before a password is shown.
 *
 * Always resets: password visibility, nonce changed indicator.
 * Always shows: the password strength indicator (based on current hashLength setting).
 *
 * @param {string} site  - Domain name to pre-fill (e.g., "github.com").
 * @param {string} user  - Username or email to pre-fill.
 * @param {number} nonce - Version number (0-based) to pre-fill.
 */
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

/**
 * Update the nonce-changed visual indicator on the version control.
 *
 * If the user has incremented or decremented the nonce away from its saved value
 * (`originalNonce`), the nonce display turns purple to signal "unsaved change".
 * Once the password is copied/filled (which saves the nonce), the indicator resets.
 */
function updateNonceIndicator() {
  const nonceControl = document.querySelector('.nonce-control');
  if (currentNonce !== originalNonce) {
    nonceControl.classList.add('nonce-changed');
  } else {
    nonceControl.classList.remove('nonce-changed');
  }
}

/**
 * Regenerate and display the current password based on site/user/nonce inputs.
 *
 * Called on every `input` event for the site and user fields, and after nonce
 * changes. Only generates if all three inputs are non-empty AND the vault is
 * unlocked (has a private key).
 *
 * If `passwordVisible` is false, the generated password is computed but NOT
 * displayed (the placeholder bullets remain). This avoids exposing the password
 * in the DOM while the user is still typing.
 *
 * Also updates the password strength indicator on every call.
 */
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

/**
 * Toggle the password visibility on the generate screen.
 *
 * When revealing: calls `updatePassword()` to put the plaintext in the DOM.
 * When hiding: replaces with bullet characters.
 * Updates the eye icon accordingly (👁️ / 🙈).
 */
function togglePasswordVisibility() {
  passwordVisible = !passwordVisible;
  $('visibilityIcon').textContent = passwordVisible ? '🙈' : '👁️';

  if (passwordVisible) {
    updatePassword();
  } else {
    $('genPassword').textContent = '••••••••••••';
  }
}

/**
 * Increment the nonce (version) counter by 1.
 *
 * Used when the user needs to generate a new password for the same site/user
 * (e.g., after a forced password reset on the target site).
 * Updates the display and regenerates the password if visible.
 */
function incrementNonce() {
  currentNonce++;
  $('nonceDisplay').textContent = currentNonce + 1;
  updateNonceIndicator();
  if (passwordVisible) updatePassword();
}

/**
 * Decrement the nonce (version) counter by 1, minimum 0.
 *
 * Prevents going below 0. Updates the display and regenerates if visible.
 */
function decrementNonce() {
  if (currentNonce > 0) {
    currentNonce--;
    $('nonceDisplay').textContent = currentNonce + 1;
    updateNonceIndicator();
    if (passwordVisible) updatePassword();
  }
}

/**
 * Generate the password, save the site entry, copy to clipboard, and schedule
 * a 30-second auto-clear.
 *
 * Steps:
 *   1. Validate site and user inputs.
 *   2. Save `{ site: nonce }` under the user key in `vault.users`.
 *   3. Generate the password deterministically.
 *   4. Copy to clipboard via `navigator.clipboard.writeText`.
 *   5. Schedule a 30 000 ms timer to overwrite the clipboard with an empty string.
 *   6. Persist updated vault to chrome.storage.local and background service worker.
 *   7. Trigger a silent Nostr backup (fire-and-forget).
 *
 * @async
 */
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
  // Silent Nostr backup (debounced)
  backupToNostrDebounced();
}

/**
 * Generate the password, save the site entry, and autofill it into the active tab.
 *
 * Sends a `FILL_PASSWORD` message to the content script running in the active tab
 * via `chrome.tabs.sendMessage`. The content script finds the password field(s) and
 * fills them using native event dispatching (see content.js).
 *
 * Falls back to "try copying instead" toast if the content script is not injected
 * (e.g., on chrome:// pages or pages where the content script was blocked).
 *
 * @async
 */
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

// ─────────────────────────────────────────────────────────────────────────────
// Encryption
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Unlock the vault using the user's encryption password.
 *
 * Authentication mechanism:
 *   - The encrypted vault is keyed by `SHA256(password)` in chrome.storage.local.
 *   - The function hashes the entered password, looks up the key, and attempts AES decryption.
 *   - A wrong password results in no matching key or a failed JSON parse.
 *
 * Rate limiting:
 *   - After `MAX_UNLOCK_ATTEMPTS` (5) failures, locks for `UNLOCK_LOCKOUT_MS` (30s).
 *   - Counter and lockout timestamp are module-level (reset on popup close).
 *
 * On success:
 *   - Merges decrypted data into `vault`.
 *   - Navigates to main screen.
 *   - Triggers a background Nostr sync.
 *
 * @async
 */
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
    // The vault blob is keyed by SHA256(password), not the password itself
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
    // Sync from Nostr after unlock
    syncFromNostrWithUI();
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

/**
 * First-time encryption setup: encrypt the vault with a chosen password and
 * save it to chrome.storage.local, then proceed to the main screen.
 *
 * This is the mandatory step after creating a new vault or restoring from seed.
 * It ensures the vault survives service worker restarts and browser updates.
 *
 * Encryption: CryptoJS AES with the plaintext password as the key material.
 * Storage key: SHA256(password) — allows verifying the password without
 *              attempting to decrypt an incorrect blob.
 *
 * @async
 */
async function setupEncryptAndContinue() {
  const pass1 = $('setupEncryptPass1').value;
  const pass2 = $('setupEncryptPass2').value;

  if (!pass1 || pass1 !== pass2) {
    showToast("Passwords don't match");
    return;
  }

  if (pass1.length < 4) {
    showToast('Password too short');
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

  showToast('Vault saved securely!');
  showScreen('mainScreen');
  // Now sync from Nostr
  syncFromNostrWithUI();
}

/**
 * Re-encrypt and save the vault with a new password from the settings screen.
 *
 * Identical to `setupEncryptAndContinue` but uses the settings screen's password
 * inputs and navigates back to settings on success.
 *
 * Multiple passwords can co-exist in the encrypted blob (each hashed key maps to
 * its own AES-encrypted copy of the vault data). Calling this with a new password
 * adds a new entry rather than replacing the old one — clearing old entries requires
 * a vault wipe and re-setup.
 *
 * @async
 */
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

// ─────────────────────────────────────────────────────────────────────────────
// Settings
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Navigate to the view-seed screen, rendering the current seed phrase as a grid.
 *
 * Only available when `vault.seedPhrase` is set. Shows a toast and returns
 * early if the seed phrase is not available (e.g., vault restored from an old
 * encrypted blob that didn't include the seed phrase).
 *
 * Uses `escapeHtml` for each word before rendering to prevent XSS (even though
 * BIP39 words are safe ASCII, it's a good defensive habit).
 */
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

/**
 * Copy the current seed phrase to the clipboard.
 *
 * NOTE: Unlike `copyPassword`, there is no auto-clear timer here. The seed phrase
 * is the master secret and clipboard persistence could be a security concern.
 * Consider adding a short clear timer in a future security pass.
 *
 * @async
 */
async function copySeedPhrase() {
  try {
    await navigator.clipboard.writeText(vault.seedPhrase);
    showToast('Seed phrase copied — clipboard clears in 15s');
    setTimeout(() => navigator.clipboard.writeText('').catch(() => {}), 15000);
  } catch {
    showToast('Copy failed');
  }
}

/**
 * Save the hash length setting from the advanced settings screen.
 *
 * The hash length controls how many hex characters from the SHA-256 output
 * are included in the generated password. Clamped to the range [8, 64].
 * Changing this setting affects all future-generated passwords — existing
 * passwords are unaffected until the user explicitly re-copies them.
 *
 * @async
 */
async function saveAdvancedSettings() {
  const len = parseInt($('hashLengthSetting').value) || 16;
  vault.settings.hashLength = Math.max(8, Math.min(64, len));
  await VaultStorage.saveVault(vault);
  await syncStateToBackground();
  showToast('Settings saved');
  showScreen('settingsScreen');
}

/**
 * Export the vault's site list and settings as a JSON file download.
 *
 * The export does NOT include the private key or seed phrase — only the
 * non-sensitive `users` and `settings` objects. This file can be re-imported
 * into any Vault instance (browser extension or web app) that shares the same
 * seed phrase.
 *
 * Uses a Blob + temporary anchor element for the download (MV3-compatible).
 */
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

// ─────────────────────────────────────────────────────────────────────────────
// Site Management
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Delete a saved site entry from the vault and persist the change.
 *
 * If deleting the site leaves the user with no remaining sites, the user entry
 * is also removed from `vault.users` to keep the structure clean.
 *
 * Triggers a silent Nostr backup after deletion to keep remotes in sync.
 *
 * @async
 * @param {string} site - Domain name to delete (e.g., "github.com").
 * @param {string} user - Username associated with the site entry.
 */
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
  backupToNostrDebounced();
}

// ─────────────────────────────────────────────────────────────────────────────
// Import
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Trigger a file picker for JSON vault import and merge the data into the vault.
 *
 * Import merge strategy:
 *   - New users and sites are added.
 *   - For existing site/user combinations, the higher nonce wins
 *     (preserves the most recent "password reset" version).
 *   - Settings from the import file are merged (imported values take precedence).
 *
 * The private key and seed phrase in the import file are IGNORED — only
 * `users` and `settings` are imported.
 *
 * Shows a summary toast and triggers a silent Nostr backup on success.
 */
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
          // Keep the higher nonce (most recent password version wins)
          if (vault.users[user][site] === undefined || nonce > vault.users[user][site]) {
            vault.users[user][site] = nonce;
          }
        });
      });
      if (data.settings) vault.settings = { ...vault.settings, ...data.settings };
      renderSiteList();
      await VaultStorage.saveVault(vault);
      await syncStateToBackground();
      backupToNostrDebounced();
      showToast(`Imported ${siteCount} site(s)!`);
    } catch (err) {
      console.error(err);
      showToast('Failed to import file');
    }
  };
  input.click();
}

// ─────────────────────────────────────────────────────────────────────────────
// Backup Password Prompt
// ─────────────────────────────────────────────────────────────────────────────

/** Whether the backup password nudge has been shown this session. @type {boolean} */
let backupPasswordNudgeShown = false;

/**
 * Show a modal dialog for backup password entry.
 * Uses the loading modal area repurposed as a simple prompt.
 *
 * @param {'set'|'enter'} mode - 'set' to create a new password, 'enter' to decrypt.
 * @returns {Promise<string|null>} The password, or null if cancelled.
 */
function showBackupPasswordPrompt(mode) {
  return new Promise((resolve) => {
    // Create modal overlay
    const overlay = document.createElement('div');
    overlay.className = 'loading-modal';
    overlay.style.cssText = 'display:flex;align-items:center;justify-content:center;z-index:1000;';

    const box = document.createElement('div');
    box.style.cssText = 'background:var(--bg-secondary,#1a1a2e);border-radius:12px;padding:20px;width:280px;text-align:center;';

    const title = document.createElement('h3');
    title.style.cssText = 'margin:0 0 8px;color:var(--text-primary,#fff);font-size:14px;';
    title.textContent = mode === 'set' ? 'Set Backup Password' : 'Enter Backup Password';

    const desc = document.createElement('p');
    desc.style.cssText = 'margin:0 0 12px;color:var(--text-secondary,#aaa);font-size:11px;line-height:1.4;';
    desc.textContent = mode === 'set'
      ? 'This password adds a second encryption layer to your cloud backup. Remember it — it\'s never stored.'
      : 'This backup is double-encrypted. Enter the backup password you set when creating it.';

    const pass1 = document.createElement('input');
    pass1.type = 'password';
    pass1.placeholder = 'Backup password';
    pass1.style.cssText = 'width:100%;box-sizing:border-box;margin-bottom:8px;';

    let pass2 = null;
    if (mode === 'set') {
      pass2 = document.createElement('input');
      pass2.type = 'password';
      pass2.placeholder = 'Confirm password';
      pass2.style.cssText = 'width:100%;box-sizing:border-box;margin-bottom:12px;';
    }

    const btnRow = document.createElement('div');
    btnRow.style.cssText = 'display:flex;gap:8px;justify-content:center;';

    const btnConfirm = document.createElement('button');
    btnConfirm.className = 'btn btn-primary btn-sm';
    btnConfirm.textContent = mode === 'set' ? 'Set & Backup' : 'Decrypt';

    const btnCancel = document.createElement('button');
    btnCancel.className = 'btn btn-ghost btn-sm';
    btnCancel.textContent = 'Cancel';

    btnRow.appendChild(btnConfirm);
    btnRow.appendChild(btnCancel);

    box.appendChild(title);
    box.appendChild(desc);
    box.appendChild(pass1);
    if (pass2) box.appendChild(pass2);
    box.appendChild(btnRow);
    overlay.appendChild(box);
    document.body.appendChild(overlay);

    setTimeout(() => pass1.focus(), 50);

    function cleanup() {
      document.body.removeChild(overlay);
    }

    function onConfirm() {
      const p1 = pass1.value;
      if (!p1) { showToast('Password required'); return; }
      if (mode === 'set' && pass2 && p1 !== pass2.value) {
        showToast("Passwords don't match");
        return;
      }
      cleanup();
      resolve(p1);
    }

    function onCancel() {
      cleanup();
      resolve(null);
    }

    btnConfirm.addEventListener('click', onConfirm);
    btnCancel.addEventListener('click', onCancel);
    pass1.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') onConfirm();
      if (e.key === 'Escape') onCancel();
    });
    if (pass2) {
      pass2.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') onConfirm();
        if (e.key === 'Escape') onCancel();
      });
    }
  });
}

/**
 * Show a non-blocking nudge toast suggesting the user set a backup password.
 * Shown once per session after restoring from a legacy single-layer backup.
 */
function showBackupPasswordNudge() {
  if (backupPasswordNudgeShown) return;
  backupPasswordNudgeShown = true;

  const toast = $('toast');
  toast.innerHTML = '';

  const text = document.createElement('span');
  text.textContent = 'Backup not password-protected. ';

  const btn = document.createElement('button');
  btn.textContent = 'Set now';
  btn.style.cssText = 'background:none;border:none;color:var(--accent,#7c5cff);cursor:pointer;text-decoration:underline;font-size:inherit;padding:0;margin-left:4px;';
  btn.addEventListener('click', async () => {
    toast.classList.remove('show');
    const mode = vault.settings.hasBackupPassword ? 'enter' : 'set';
    const pwd = await showBackupPasswordPrompt(mode);
    if (pwd) {
      VaultStorage.setSessionBackupPassword(pwd);
      vault.settings.hasBackupPassword = true;
      _pendingBackupAfterPassword = false;
      await syncStateToBackground();
      showLoading('Syncing backup...');
      const result = await VaultStorage.backupToNostr(vault, false, pwd);
      hideLoading();
      if (result.success > 0) {
        showToast(`Backed up to ${result.success} relay(s)`);
      } else {
        showToast('Backup failed');
      }
    }
  });

  toast.appendChild(text);
  toast.appendChild(btn);
  toast.classList.add('show');
  setTimeout(() => {
    if (toast.classList.contains('show')) {
      toast.classList.remove('show');
    }
  }, 8000); // Longer display for actionable toast
}

// ─────────────────────────────────────────────────────────────────────────────
// Nostr Backup — NIP-44 + kind:30078 (double-encrypted)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Debounced version of silent Nostr backup.
 * Coalesces rapid vault mutations (e.g. multiple copies/deletes) into a single
 * backup after 3 seconds of inactivity.
 */
let _backupDebounceTimer = null;
function backupToNostrDebounced() {
  if (_backupDebounceTimer) clearTimeout(_backupDebounceTimer);
  _backupDebounceTimer = setTimeout(() => {
    backupToNostr(true);
    _backupDebounceTimer = null;
  }, 3000);
}

/**
 * Manually back up the vault to Nostr relays (initiated from Settings).
 *
 * Shows a loading modal during the operation and a toast with the result.
 * Delegates actual relay work to `VaultStorage.backupToNostr`.
 *
 * @async
 * @param {boolean} [silent=false] - If true, skip the loading modal and toast
 *   (used for automatic background backups triggered by copy/fill/delete).
 */
let _pendingBackupAfterPassword = false;

async function backupToNostr(silent = false) {
  if (!vault.privateKey) {
    if (!silent) showToast('Vault not initialized');
    return;
  }

  // Ensure backup password is available — NEVER fall back to single-layer
  if (!VaultStorage.getSessionBackupPassword()) {
    if (silent) {
      // Queue backup for when password becomes available
      _pendingBackupAfterPassword = true;
      const msg = vault.settings.hasBackupPassword
        ? 'Backup pending — re-enter backup password'
        : 'Backup pending — set password to sync';
      showToast(msg);
      return;
    } else {
      // Interactive — prompt for password
      const mode = vault.settings.hasBackupPassword ? 'enter' : 'set';
      const pwd = await showBackupPasswordPrompt(mode);
      if (pwd) {
        VaultStorage.setSessionBackupPassword(pwd);
        vault.settings.hasBackupPassword = true;
        await syncStateToBackground();
      } else {
        showToast('Backup cancelled');
        return;
      }
    }
  }

  if (!silent) showLoading('Backing up to Nostr...');

  const result = await VaultStorage.backupToNostr(vault, silent);

  if (result.deferred) {
    // Should not happen since we checked above, but handle defensively
    _pendingBackupAfterPassword = true;
    if (!silent) { hideLoading(); showToast('Backup pending — set backup password'); }
    return;
  }

  if (!silent) {
    hideLoading();
    if (result.success > 0) {
      showToast(`Backed up to ${result.success} relay(s)`);
    } else {
      showToast('Backup failed');
    }
  }
}

/**
 * Manually restore vault data from Nostr relays (initiated from Settings).
 *
 * Shows a loading modal, fetches from all configured relays, and merges the
 * latest event's data into the current vault.
 *
 * @async
 */
async function restoreFromNostr() {
  if (!vault.privateKey) {
    showToast('Vault not initialized');
    return;
  }

  showLoading('Restoring from Nostr...');

  try {
    const data = await VaultStorage.restoreFromNostr(
      vault.privateKey,
      () => { hideLoading(); return showBackupPasswordPrompt('enter'); }
    );
    hideLoading();

    if (data) {
      vault.users = { ...vault.users, ...data.users };
      if (data.settings) vault.settings = { ...vault.settings, ...data.settings };
      renderSiteList();
      await syncStateToBackground();
      showToast('Restored from Nostr!');

      // If backup was legacy single-layer, prompt to upgrade
      if (data.isLegacy && !vault.settings.hasBackupPassword) {
        showBackupPasswordNudge();
      }
    } else {
      showToast('No backup found');
    }
  } catch (e) {
    console.error(e);
    hideLoading();
    if (e.message === 'Backup password required but cancelled') {
      showToast('Restore cancelled — backup password required');
    } else {
      showToast('Restore error');
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Seed Autocomplete (BIP39 word suggestions)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Handle input events on the restore seed textarea to show BIP39 word suggestions.
 *
 * Algorithm:
 *   1. Extract the partial word immediately before the cursor (regex: `[a-z]+$`).
 *   2. Filter the BIP39 `words` array to those starting with the partial word.
 *   3. Show up to 6 suggestions in the dropdown.
 *   4. Update the word count display.
 *
 * The dropdown is hidden if:
 *   - The partial word is empty.
 *   - The only suggestion is an exact match (the word is already complete).
 *
 * @param {InputEvent} event - Input event from the seed phrase textarea.
 */
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

/**
 * Render the BIP39 autocomplete suggestion list.
 *
 * Each suggestion has the matched prefix highlighted in purple (`.seed-suggestion-match`).
 * The active suggestion (keyboard-selected) gets the `.active` class.
 *
 * Clicking a suggestion calls `selectSuggestion(word)`.
 *
 * @param {string} typed - The currently typed partial word (used for prefix highlighting).
 */
function renderSuggestions(typed) {
  const suggestions = $('seedSuggestions');
  suggestions.innerHTML = '';

  currentSuggestions.forEach((word, i) => {
    const div = document.createElement('div');
    div.className = 'seed-suggestion' + (i === activeSuggestionIndex ? ' active' : '');

    // Highlight the typed prefix in purple
    const matchSpan = document.createElement('span');
    matchSpan.className = 'seed-suggestion-match';
    matchSpan.textContent = word.slice(0, typed.length);

    div.appendChild(matchSpan);
    div.appendChild(document.createTextNode(word.slice(typed.length)));

    div.addEventListener('click', () => selectSuggestion(word));
    suggestions.appendChild(div);
  });
}

/**
 * Handle keyboard navigation within the BIP39 autocomplete dropdown.
 *
 * Keys handled (only when the suggestion dropdown is visible):
 *   - ArrowDown  → highlight the next suggestion (wraps around)
 *   - ArrowUp    → highlight the previous suggestion (wraps around)
 *   - Tab/Enter  → select the currently highlighted suggestion
 *   - Escape     → hide the dropdown without selecting
 *
 * All handled keys call `preventDefault()` to suppress default browser behaviour
 * (tab focus change, form submission, etc.).
 *
 * @param {KeyboardEvent} event - Keydown event on the seed phrase textarea.
 */
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

/**
 * Get the word currently being typed in the seed phrase textarea (at cursor position).
 *
 * Reads the textarea value and cursor position to extract the partial word
 * immediately to the left of the cursor (same logic as `onSeedInput`).
 *
 * @returns {string} The lowercase partial word, or an empty string.
 */
function getCurrentTypedWord() {
  const textarea = $('restoreSeedInput');
  const cursorPos = textarea.selectionStart;
  const beforeCursor = textarea.value.slice(0, cursorPos);
  const wordMatch = beforeCursor.match(/[a-z]+$/i);
  return wordMatch ? wordMatch[0].toLowerCase() : '';
}

/**
 * Insert the selected suggestion word into the textarea at the cursor position.
 *
 * Replaces the currently-typed partial word with the complete suggestion and
 * appends a space, then moves the cursor to after the space so the user can
 * immediately start typing the next word.
 *
 * Updates the word count display after insertion.
 *
 * @param {string} word - The complete BIP39 word to insert.
 */
function selectSuggestion(word) {
  const textarea = $('restoreSeedInput');
  const cursorPos = textarea.selectionStart;
  const value = textarea.value;

  const beforeCursor = value.slice(0, cursorPos);
  const wordMatch = beforeCursor.match(/[a-z]+$/i);
  const wordStart = wordMatch ? cursorPos - wordMatch[0].length : cursorPos;

  // Replace partial word with complete word + space
  const newValue =
    value.slice(0, wordStart) + word + ' ' + value.slice(cursorPos);
  textarea.value = newValue;

  // Move cursor to after the inserted word + space
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
