# AUDIT.md — Vault Chrome Extension

Review checklist for Fabri. Go through each section, check the boxes, note anything off.

---

## 🔒 Security Review

### Seed Phrase & Private Key Handling
- [ ] Seed phrase is **never** stored in `chrome.storage.local` unencrypted
- [ ] Private key is **never** written to disk unencrypted
- [ ] `VaultStorage.saveVault()` only saves `{users, settings}` — verify no key/seed leaks
- [ ] `syncStateToBackground()` sends keys via `chrome.runtime.sendMessage` (in-memory only, acceptable for extension context)
- [ ] Clipboard is auto-cleared 30s after password copy (`copyPassword()`)
- [ ] ⚠️ `copySeedPhrase()` does NOT auto-clear clipboard — **potential issue**

### Content Security Policy
- [ ] MV3 enforces `script-src 'self'` by default — verify no inline scripts in `popup.html`
- [ ] All event handlers bound via `addEventListener` (no `onclick` attributes)
- [ ] No `eval()`, `new Function()`, or `innerHTML` with user input

### Content Script (`content.js`)
- [ ] Runs on `<all_urls>` — overly broad, but needed for autofill. Acceptable?
- [ ] Only responds to `FILL_PASSWORD` message type
- [ ] Uses `setNativeValue()` with native prototype setter — standard approach for React/Vue compat
- [ ] No data exfiltrated from page to extension (one-way: extension → page only)

### Storage
- [ ] `chrome.storage.local['vault']` stores site list **unencrypted** — privacy concern (reveals which services user has accounts on)
- [ ] `chrome.storage.local['vaultEncrypted']` stores AES-encrypted blob with privateKey + seedPhrase + users + settings
- [ ] Encryption key = `CryptoJS.SHA256(user_password)` — no PBKDF2/scrypt, fast to brute-force on weak passwords
- [ ] ⚠️ Encrypted blob only updates on manual save or initial setup — goes stale after site changes

### Nostr Backup
- [ ] Only `{users, settings}` is published (no seed phrase, no private key)
- [ ] NIP-44 encryption (self-encrypt with own Nostr key pair)
- [ ] Legacy NIP-04 fallback for reading old backups
- [ ] ⚠️ No publish verification — `relay.publish()` is fire-and-forget
- [ ] ⚠️ No rate limiting on silent backups (every copy/delete triggers a backup)

### Permissions
- [ ] `storage` — needed for chrome.storage.local
- [ ] `activeTab` — needed for domain detection
- [ ] `clipboardWrite` — needed for password copy
- [ ] `contextMenus` — needed for right-click menu
- [ ] No `tabs` permission (uses `activeTab` which is narrower) ✅

---

## 🧪 Functional Testing

### Create New Vault
1. Click extension → "Create New Vault"
2. Verify 12 words displayed in grid
3. Click "I've saved them"
4. Verify 3 random word verification prompts
5. Enter correct words → should proceed to encryption setup
6. Set password → should reach main screen
7. Close popup, reopen → should show "Unlock Saved Vault" option

### Restore from Seed
1. Use a known seed phrase from the **web version**
2. Restore in extension
3. After Nostr sync, verify same sites appear
4. Generate password for a site → verify it matches the web version output
5. **This is the critical compatibility test** — same seed + site + user + nonce = same password

### Unlock Saved Vault
1. Close and reopen popup after creating/restoring
2. Enter correct password → vault unlocks, sites visible
3. Enter wrong password 5 times → should lock out for 30s
4. Enter wrong password → verify attempt counter decrements

### Password Generation
1. Open a site (e.g., github.com)
2. Enter username → password should generate (but hidden)
3. Click 👁️ → verify password visible
4. Click 👁️ again → verify masked
5. Click "Copy Password" → paste elsewhere, verify it works
6. Wait 30s → paste again, verify clipboard was cleared
7. Increment version → verify password changes
8. Decrement back → verify original password returns

### Autofill
1. Navigate to a login page (e.g., github.com/login)
2. Open extension → generate for that domain
3. Click "Fill on Page" → verify password field gets filled
4. Check if username field was also filled (if provided)
5. Test on a React-based login (e.g., vercel.com) — the `setNativeValue` approach matters here

### Domain Detection
1. Visit github.com → open extension
2. Verify domain banner shows "Generate for github.com?"
3. Add and save a password for github.com
4. Reopen extension on github.com → banner should be hidden, site should appear at top of list
5. Visit a `chrome://` page → verify no banner shown

### Context Menu
1. Right-click on a page → verify "Generate password with Vault" appears
2. ⚠️ Click it when vault is locked → verify badge shows `!` for 3 seconds
3. ⚠️ Click it when vault is unlocked → **nothing happens** (known issue, handler is incomplete)

### Nostr Sync
1. Create vault on web version, add a few sites, backup to Nostr
2. Restore same seed in extension → verify sites sync from Nostr
3. Add a site in extension, let it backup silently
4. Restore in web version → verify the new site appears

### Import/Export
1. Export JSON from extension → verify file downloads
2. Import same JSON → verify "already exists" sites aren't duplicated
3. Import a JSON from web version → verify compatibility

---

## 📁 File-by-File Review

### `manifest.json`
- [ ] MV3 format, no deprecated fields
- [ ] Permissions minimal for functionality needed
- [ ] Content script `<all_urls>` — acceptable or should be restricted?

### `background.js`
- [ ] Message routing covers: GET_VAULT_STATE, SET_VAULT_STATE, LOCK_VAULT, GENERATE_FOR_DOMAIN
- [ ] Context menu created on `onInstalled` (runs once)
- [ ] Context menu click handler — review the unlocked case (currently no-op)

### `content.js`
- [ ] `findPasswordFields()` — only finds visible `input[type="password"]`
- [ ] `findUsernameField()` — walks backwards from password field, handles forms and formless pages
- [ ] `setNativeValue()` — uses prototype setter pattern for framework compat
- [ ] Dispatches both `input` and `change` events after fill

### `popup/popup.js`
- [ ] All event listeners bound in `DOMContentLoaded` (no inline handlers)
- [ ] State machine navigation: `showScreen()` / `goBack()` / `navigationStack`
- [ ] `syncFromNostrWithUI()` — auto-syncs after unlock, shows relay orb status
- [ ] `autoSaveEncrypted()` — **defined but never called** (dead code)
- [ ] Encryption setup is mandatory after vault creation (good)

### `lib/vault-core.js`
- [ ] Password generation matches web version formula exactly
- [ ] `extractDomain()` — hardcoded TLD list, may miss some multi-part TLDs
- [ ] `deriveNostrKeys()` — returns `{sk}` only, no npub (web version returns more)

### `lib/vault-storage.js`
- [ ] `saveVault()` stores `{users, settings}` only — no sensitive data ✅
- [ ] `getEncrypted()`/`saveEncrypted()` — AES blob management
- [ ] Nostr functions: `connectRelay`, `backupToNostr`, `restoreFromNostr`
- [ ] References `window.NostrTools` — works in popup, would crash in service worker context

### `popup/popup.html`
- [ ] Clean HTML, no inline scripts or handlers
- [ ] Script load order matters: crypto → bip39 → nostr → core → storage → popup

### `popup/popup.css`
- [ ] Review for anything unexpected (no security concern, just visual)

---

## ⚠️ Known Issues & TODOs

From code review:

1. **Encrypted backup goes stale** — only updated on manual save, not after site changes
2. **Plaintext site list** in `chrome.storage.local['vault']` — privacy leak
3. **No inactivity auto-lock** — web version has 5-minute timeout, extension has none
4. **Context menu unlocked case** — no handler, does nothing
5. **`autoSaveEncrypted()` is dead code** — defined but never called
6. **`copySeedPhrase()` doesn't auto-clear clipboard**
7. **No Nostr publish verification** — fire-and-forget
8. **No backup debounce** — rapid copies spam relay connections
9. **No backup history view** — web version has one, extension doesn't
10. **Service worker state loss** — expected MV3 behavior, but UX could be smoother
11. **`extractDomain()` TLD list incomplete** — misses `.co.nz`, `.com.mx`, etc.
12. **No per-site timestamps** — merge conflicts resolved by last-write-wins

From README:
- [ ] Nostr backup/restore (partially implemented — working but no history view)
- [ ] Auto-detect and pre-fill username from saved sites
- [ ] Keyboard shortcut (Ctrl+Shift+V) to open popup
- [ ] Import from web version's localStorage

---

_Generated by Adonis — 2026-03-23_
