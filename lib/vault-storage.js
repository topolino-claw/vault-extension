/**
 * @fileoverview Vault Storage — chrome.storage.local abstraction + Nostr backup
 *
 * This module replaces the `localStorage` usage from the PasswordManagerWeb web
 * version with the extension-appropriate `chrome.storage.local` API.
 *
 * Storage layout in `chrome.storage.local`:
 * ┌─────────────────┬──────────────────────────────────────────────────────────┐
 * │ Key             │ Value                                                    │
 * ├─────────────────┼──────────────────────────────────────────────────────────┤
 * │ "vaultEncrypted"│ { [sha256(password)]: AES-encrypted JSON string }        │
 * └─────────────────┴──────────────────────────────────────────────────────────┘
 *
 * SECURITY: The plaintext "vault" key has been REMOVED.
 *   All vault data is stored exclusively in the encrypted blob ("vaultEncrypted"),
 *   which requires the user's encryption password to decrypt.
 *   The seed phrase and private key are only accessible after unlock.
 *
 * Nostr backup:
 *   Users and settings can be backed up to Nostr relays as NIP-44 encrypted
 *   events (kind:30078, replaceable), optionally double-encrypted with a
 *   backup password (AES-256-GCM via PBKDF2 as Layer 1, NIP-44 as Layer 2).
 *   The seed phrase and private key are NOT included in the backup.
 *
 * @module VaultStorage
 */

const VaultStorage = (() => {

  // ─────────────────────────────────────────────────────────────────────────
  // Storage key constants
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Named constants for chrome.storage.local keys.
   * Centralising them prevents typos and makes refactoring easier.
   *
   * @readonly
   * @enum {string}
   */
  const KEYS = {
    /** @deprecated Plaintext vault key — removed for security. Kept for migration/cleanup only. */
    VAULT: 'vault',
    /** Legacy: tracks whether the vault is locked (currently unused in logic) */
    LOCKED: 'vaultLocked',
    /** Map of password-hash → AES-encrypted vault JSON strings */
    ENCRYPTED: 'vaultEncrypted',
  };

  // ─────────────────────────────────────────────────────────────────────────
  // chrome.storage.local CRUD helpers
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * @deprecated Plaintext vault storage has been removed for security.
   * Always returns null. Any legacy plaintext data is deleted on first call.
   *
   * The vault is now only accessible via the encrypted store after unlock.
   *
   * @async
   * @returns {Promise<null>}
   */
  async function getVault() {
    // Migration: remove any leftover plaintext vault data from older versions
    try {
      const result = await chrome.storage.local.get(KEYS.VAULT);
      if (result[KEYS.VAULT]) {
        await chrome.storage.local.remove([KEYS.VAULT]);
        console.log('VaultStorage: removed legacy plaintext vault key');
      }
    } catch (_) {}
    return null;
  }

  /**
   * @deprecated Plaintext vault storage has been removed for security.
   * This function is now a no-op. All vault persistence goes through the
   * encrypted store (saveEncrypted).
   *
   * Callers are kept intact to avoid breaking changes during the transition;
   * they simply do nothing when called.
   *
   * @async
   * @param {Object} _vaultData - Ignored.
   * @returns {Promise<void>}
   */
  async function saveVault(_vaultData) {
    // No-op: plaintext vault storage eliminated for security.
    // All persistence now goes through the encrypted store.
  }

  /**
   * Retrieve the encrypted vault map from chrome.storage.local.
   *
   * The encrypted store is a dictionary keyed by `SHA256(password)`.
   * Multiple passwords can encrypt the same vault data (multi-password support).
   * Each value is an AES-encrypted JSON string (via CryptoJS.AES.encrypt).
   *
   * Returns an empty object `{}` if no encrypted vault has been saved yet.
   *
   * @async
   * @returns {Promise<Object.<string, string>>}
   *   Map of { [sha256Hash]: aesEncryptedString }
   */
  async function getEncrypted() {
    const result = await chrome.storage.local.get(KEYS.ENCRYPTED);
    return result[KEYS.ENCRYPTED] || {};
  }

  /**
   * Persist the encrypted vault map to chrome.storage.local.
   *
   * The caller is responsible for adding / updating the specific password-keyed
   * entry before calling this function.
   *
   * @async
   * @param {Object.<string, string>} data
   *   Map of { [sha256Hash]: aesEncryptedString }
   * @returns {Promise<void>}
   */
  async function saveEncrypted(data) {
    await chrome.storage.local.set({ [KEYS.ENCRYPTED]: data });
  }

  /**
   * Remove any legacy plaintext vault data from chrome.storage.local.
   *
   * Does NOT remove the encrypted blob — that must be done separately if
   * the user wants a full wipe. The encrypted blob is intentionally retained
   * so the user can still unlock after a "clear" operation.
   *
   * @async
   * @returns {Promise<void>}
   */
  async function clear() {
    await chrome.storage.local.remove([KEYS.VAULT]);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Nostr relay helpers
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Default Nostr relay URLs used for backup and restore.
   * Tried in order; the backup succeeds if at least one relay accepts the event.
   *
   * @type {string[]}
   */
  const RELAYS = [
    'wss://relay.damus.io',
    'wss://nostr-pub.wellorder.net',
    'wss://relay.snort.social',
    'wss://nos.lol',
  ];

  /**
   * The `d` tag value used on Nostr kind:30078 (replaceable application data) events.
   * This tag makes the event addressable and replaceable — a second backup
   * with the same `d` tag replaces the first on supporting relays.
   *
   * @type {string}
   */
  const BACKUP_D_TAG = 'vault-backup';

  /**
   * Connect to a single Nostr WebSocket relay with a timeout.
   *
   * Uses the `nostr-tools` `relayInit` helper. Resolves when the relay
   * emits `connect`, rejects if the connection errors or exceeds `timeoutMs`.
   *
   * @async
   * @param  {string} url        - WebSocket URL of the relay (wss://...).
   * @param  {number} [timeoutMs=5000] - Maximum milliseconds to wait for connection.
   * @returns {Promise<import('nostr-tools').Relay>} The connected relay instance.
   * @throws {string|Error} "timeout" string or the relay's error event payload.
   */
  async function connectRelay(url, timeoutMs = 5000) {
    const { relayInit } = window.NostrTools;
    const relay = relayInit(url);
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => { try { relay.close(); } catch(e) {} reject('timeout'); }, timeoutMs);
      relay.on('connect', () => { clearTimeout(t); resolve(); });
      relay.on('error', (e) => { clearTimeout(t); reject(e); });
      relay.connect();
    });
    return relay;
  }

  /**
   * Subscribe to a relay with given filters and collect all matching events.
   *
   * Resolves when either:
   *   - The relay sends an `EOSE` (End Of Stored Events) message, or
   *   - The `timeoutMs` deadline is reached (whichever comes first).
   *
   * This prevents the promise from hanging indefinitely on slow/unresponsive relays.
   *
   * @param  {import('nostr-tools').Relay} relay     - A connected relay instance.
   * @param  {Object[]}                   filters   - Nostr filter objects (kind, authors, etc.).
   * @param  {number}                     [timeoutMs=8000] - Fallback timeout in ms.
   * @returns {Promise<import('nostr-tools').Event[]>} Array of collected Nostr events.
   */
  function subscribeAndCollect(relay, filters, timeoutMs = 8000) {
    return new Promise(resolve => {
      const events = [];
      const sub = relay.sub(filters);
      const t = setTimeout(() => { sub.unsub(); resolve(events); }, timeoutMs);
      sub.on('event', e => events.push(e));
      sub.on('eose', () => { clearTimeout(t); sub.unsub(); resolve(events); });
    });
  }

  /**
   * Derive the Nostr keypair for the current vault session.
   *
   * Combines `VaultCore.deriveNostrKeys` (which produces the secret key)
   * with `nostr-tools.getPublicKey` (secp256k1 scalar multiplication) to
   * produce both halves of the keypair.
   *
   * @async
   * @param  {string} privateKey - Vault hex private key.
   * @returns {Promise<{ sk: string, pk: string }>}
   *           sk — Nostr secret key (hex)
   *           pk — Nostr public key (hex)
   */
  async function getNostrKeyPair(privateKey) {
    const { getPublicKey } = window.NostrTools;
    const { sk } = await VaultCore.deriveNostrKeys(privateKey);
    const pk = getPublicKey(sk);
    return { sk, pk };
  }

  /**
   * Decrypt a Nostr backup event, auto-detecting format:
   *   1. NIP-44 decrypt (kind:30078) or NIP-04 decrypt (legacy kind:1)
   *   2. Check if inner payload is a v2 double-encrypted envelope
   *   3. If v2: use cached backup password or call `passwordPromptFn` to ask user
   *   4. If plain JSON: return directly (legacy single-layer)
   *
   * @async
   * @param  {import('nostr-tools').Event} event - The Nostr event to decrypt.
   * @param  {string}  sk - Nostr secret key (hex).
   * @param  {string}  pk - Nostr public key (hex).
   * @param  {Function|null} [passwordPromptFn=null] - Async function that returns
   *   the backup password string, or null to cancel. Called when a v2 envelope
   *   is found and no cached password exists. If null and password is needed, throws.
   * @returns {Promise<{ data: string, isLegacy: boolean }>}
   *   data     — Decrypted plaintext JSON string.
   *   isLegacy — true if the backup was single-layer (no v2 envelope).
   */
  async function decryptBackupEvent(event, sk, pk, passwordPromptFn = null) {
    const { nip44, nip04 } = window.NostrTools;

    // Layer 2: NIP-44 or NIP-04 decrypt
    let layer2Decrypted;
    if (event.kind === 30078) {
      const sharedSecret = nip44.getSharedSecret(sk, pk);
      layer2Decrypted = nip44.decrypt(sharedSecret, event.content);
    } else {
      layer2Decrypted = await nip04.decrypt(sk, event.pubkey, event.content);
    }

    // Check for double-encrypted v2 envelope
    const envelope = parseDoubleEncryptedEnvelope(layer2Decrypted);
    if (!envelope) {
      // Legacy single-layer backup
      return { data: layer2Decrypted, isLegacy: true };
    }

    // Double-encrypted: need backup password
    let backupPwd = _sessionBackupPassword;
    if (!backupPwd && passwordPromptFn) {
      backupPwd = await passwordPromptFn();
      if (!backupPwd) throw new Error('Backup password required but cancelled');
    }
    if (!backupPwd) {
      throw new Error('Double-encrypted backup requires password');
    }

    const decrypted = await decryptWithBackupPassword(envelope, backupPwd, pk);
    // Cache the successful password for this session
    _sessionBackupPassword = backupPwd;
    return { data: decrypted, isLegacy: false };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Nostr backup & restore (public API)
  // ─────────────────────────────────────────────────────────────────────────

  // ─────────────────────────────────────────────────────────────────────────
  // Double-Encrypted Backup — Layer 1: AES-256-GCM via WebCrypto
  // ─────────────────────────────────────────────────────────────────────────

  /** OWASP 2023 recommendation for PBKDF2-SHA256 iterations. */
  const BACKUP_PASSWORD_ITERATIONS = 600000;

  /** Version marker for double-encrypted backups (v2 envelope). */
  const BACKUP_ENCRYPTED_VERSION = 2;

  /** Session-only backup password cache — never persisted to storage. */
  let _sessionBackupPassword = null;

  /**
   * Derive an AES-256 key from a user password using PBKDF2.
   * Uses the npub (hex public key) as salt (unique per vault, not secret).
   *
   * @param {string} password - User-chosen backup password.
   * @param {string} npubHex  - Hex-encoded Nostr public key (used as salt).
   * @returns {Promise<CryptoKey>} AES-256-GCM key.
   */
  async function deriveBackupKey(password, npubHex) {
    const enc = new TextEncoder();
    const keyMaterial = await crypto.subtle.importKey(
      'raw', enc.encode(password), 'PBKDF2', false, ['deriveKey']
    );
    return crypto.subtle.deriveKey(
      {
        name: 'PBKDF2',
        salt: enc.encode(npubHex),
        iterations: BACKUP_PASSWORD_ITERATIONS,
        hash: 'SHA-256',
      },
      keyMaterial,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    );
  }

  /**
   * Encrypt vault data with AES-256-GCM using a password-derived key (Layer 1).
   * Returns a versioned envelope that can be detected on restore.
   *
   * @param {string} plaintext - JSON string of vault data.
   * @param {string} password  - User-chosen backup password.
   * @param {string} npubHex   - Hex Nostr public key (PBKDF2 salt).
   * @returns {Promise<{ v: number, iv: string, ciphertext: string }>}
   */
  async function encryptWithBackupPassword(plaintext, password, npubHex) {
    const key = await deriveBackupKey(password, npubHex);
    const iv = crypto.getRandomValues(new Uint8Array(12)); // 96-bit IV for GCM
    const enc = new TextEncoder();
    const ciphertextBuf = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      key,
      enc.encode(plaintext)
    );
    return {
      v: BACKUP_ENCRYPTED_VERSION,
      iv: btoa(String.fromCharCode(...iv)),
      ciphertext: btoa(String.fromCharCode(...new Uint8Array(ciphertextBuf))),
    };
  }

  /**
   * Decrypt a Layer 1 envelope using the backup password.
   *
   * @param {{ v: number, iv: string, ciphertext: string }} envelope
   * @param {string} password  - User-chosen backup password.
   * @param {string} npubHex   - Hex Nostr public key (PBKDF2 salt).
   * @returns {Promise<string>} Decrypted plaintext JSON string.
   * @throws {DOMException} If password is incorrect (auth tag mismatch).
   */
  async function decryptWithBackupPassword(envelope, password, npubHex) {
    const key = await deriveBackupKey(password, npubHex);
    const iv = Uint8Array.from(atob(envelope.iv), c => c.charCodeAt(0));
    const ciphertext = Uint8Array.from(atob(envelope.ciphertext), c => c.charCodeAt(0));
    const plaintextBuf = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv },
      key,
      ciphertext
    );
    return new TextDecoder().decode(plaintextBuf);
  }

  /**
   * Check if a decrypted NIP-44 payload is a double-encrypted (v2) envelope.
   *
   * @param {string} decryptedContent - The NIP-44 decrypted string.
   * @returns {{ v: number, iv: string, ciphertext: string }|null}
   */
  function parseDoubleEncryptedEnvelope(decryptedContent) {
    try {
      const parsed = JSON.parse(decryptedContent);
      if (parsed && parsed.v === BACKUP_ENCRYPTED_VERSION && parsed.iv && parsed.ciphertext) {
        return parsed;
      }
    } catch (_) {}
    return null;
  }

  /**
   * Set the session backup password (called from popup UI after user sets it).
   * @param {string|null} password
   */
  function setSessionBackupPassword(password) {
    _sessionBackupPassword = password;
  }

  /**
   * Get the current session backup password.
   * @returns {string|null}
   */
  function getSessionBackupPassword() {
    return _sessionBackupPassword;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Nostr backup (public API)
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Back up the vault's site list and settings to Nostr relays.
   *
   * Double-encryption flow:
   *   Layer 1: AES-256-GCM with PBKDF2(backupPassword, npub) — if backup password is set
   *   Layer 2: NIP-44 self-encrypt (XChaCha20-Poly1305)
   *
   * If no backup password is set and the backup is silent, falls back to
   * single-layer NIP-44 only (backwards compatible).
   *
   * @async
   * @param  {{ privateKey: string, users: Object, settings: Object }} vault
   * @param  {boolean} [silent=false] - If true, suppresses console errors.
   * @param  {string}  [overridePassword=null] - Use this instead of cached password.
   * @returns {Promise<{ success: number, total?: number, error?: string, needsPassword?: boolean }>}
   */
  async function backupToNostr(vault, silent = false, overridePassword = null) {
    const { nip44, getEventHash, signEvent } = window.NostrTools;
    if (!vault.privateKey) return { success: 0, error: 'Vault not initialized' };

    try {
      const { sk, pk } = await getNostrKeyPair(vault.privateKey);
      const sharedSecret = nip44.getSharedSecret(sk, pk);
      const vaultData = JSON.stringify({ users: vault.users, settings: vault.settings });

      // Determine backup password — NEVER fall back to single-layer
      const backupPwd = overridePassword || _sessionBackupPassword;

      if (!backupPwd) {
        // No backup password available — caller must handle this
        return {
          success: 0,
          total: RELAYS.length,
          needsPassword: true,
          deferred: true,
        };
      }

      // Layer 1: AES-256-GCM with password-derived key (always)
      const envelope = await encryptWithBackupPassword(vaultData, backupPwd, pk);
      const layer1Payload = JSON.stringify(envelope);

      // Layer 2: NIP-44 encryption (always)
      const encrypted = nip44.encrypt(sharedSecret, layer1Payload);

      const event = {
        kind: 30078,
        pubkey: pk,
        created_at: Math.floor(Date.now() / 1000),
        tags: [['d', BACKUP_D_TAG]],
        content: encrypted,
      };
      event.id = getEventHash(event);
      event.sig = await signEvent(event, sk);

      // Publish to all relays; await each with timeout
      let success = 0;
      for (const url of RELAYS) {
        try {
          const relay = await connectRelay(url);
          await Promise.race([
            relay.publish(event),
            new Promise((_, reject) => setTimeout(() => reject(new Error('publish timeout')), 5000)),
          ]);
          relay.close();
          success++;
        } catch (e) {
          if (!silent) console.error(url, e);
        }
      }

      return {
        success,
        total: RELAYS.length,
        needsPassword: !backupPwd,
      };
    } catch (e) {
      console.error(e);
      return { success: 0, error: e.message };
    }
  }

  /**
   * Restore vault data (site list + settings) from Nostr relays.
   *
   * Query strategy:
   *   1. For each relay in `RELAYS`, open a subscription with two filters:
   *      a. kind:30078 with `#d` = "vault-backup" (current NIP-44 backup format)
   *      b. kind:1 with `#t` = "nostr-pwd-backup" (legacy NIP-04 format)
   *   2. Collect events from all relays, picking the one with the most recent
   *      `created_at` timestamp.
   *   3. Decrypt the chosen event and parse the JSON payload.
   *
   * Returns `null` if no backup is found on any relay.
   *
   * @async
   * @param  {string}        privateKey        - Vault hex private key.
   * @param  {Function|null} [passwordPromptFn=null] - Async fn to prompt for backup password.
   * @returns {Promise<{ users: Object, settings: Object, isLegacy: boolean } | null>}
   *           The decrypted backup data with legacy flag, or null if no backup exists.
   */
  async function restoreFromNostr(privateKey, passwordPromptFn = null) {
    if (!privateKey) return null;

    const { sk, pk } = await getNostrKeyPair(privateKey);
    let latest = null;

    for (const url of RELAYS) {
      try {
        const relay = await connectRelay(url);
        const events = await subscribeAndCollect(relay, [
          { kinds: [30078], authors: [pk], '#d': [BACKUP_D_TAG], limit: 1 },
          { kinds: [1], authors: [pk], '#t': ['nostr-pwd-backup'], limit: 1 },
        ], 6000);
        relay.close();
        for (const e of events) {
          if (!latest || e.created_at > latest.created_at) latest = e;
        }
      } catch (e) { console.error(url, e); }
    }

    if (!latest) return null;

    try {
      const { data, isLegacy } = await decryptBackupEvent(latest, sk, pk, passwordPromptFn);
      const parsed = JSON.parse(data);
      parsed.isLegacy = isLegacy;
      return parsed;
    } catch (e) {
      console.error('Decrypt failed:', e);
      return null;
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Public API
  // ─────────────────────────────────────────────────────────────────────────

  return {
    KEYS,
    getVault,
    saveVault,
    getEncrypted,
    saveEncrypted,
    clear,
    RELAYS,
    BACKUP_D_TAG,
    BACKUP_ENCRYPTED_VERSION,
    connectRelay,
    subscribeAndCollect,
    getNostrKeyPair,
    decryptBackupEvent,
    encryptWithBackupPassword,
    decryptWithBackupPassword,
    parseDoubleEncryptedEnvelope,
    setSessionBackupPassword,
    getSessionBackupPassword,
    backupToNostr,
    restoreFromNostr,
  };
})();
