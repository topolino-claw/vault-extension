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
 * │ "vault"         │ { users: {...}, settings: {...} } — non-sensitive only   │
 * │ "vaultEncrypted"│ { [sha256(password)]: AES-encrypted JSON string }        │
 * └─────────────────┴──────────────────────────────────────────────────────────┘
 *
 * IMPORTANT SECURITY NOTE:
 *   The "vault" key stores ONLY non-sensitive data (site list, settings).
 *   The seed phrase and private key are NEVER written to "vault".
 *   They are only stored (encrypted via AES) in "vaultEncrypted".
 *
 * Nostr backup:
 *   Users and settings can be backed up to Nostr relays as NIP-44 encrypted
 *   events (kind:30078, replaceable). The seed phrase and private key are
 *   NOT included in the backup. Only the site list is synced.
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
    /** Non-sensitive vault data: { users, settings } */
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
   * Retrieve the non-sensitive vault data from chrome.storage.local.
   *
   * Returns the stored `{ users, settings }` object, or `null` if no vault
   * has been saved yet (first run).
   *
   * @async
   * @returns {Promise<{ users: Object, settings: Object } | null>}
   */
  async function getVault() {
    const result = await chrome.storage.local.get(KEYS.VAULT);
    return result[KEYS.VAULT] || null;
  }

  /**
   * Persist non-sensitive vault data (site list + settings) to chrome.storage.local.
   *
   * Deliberately excludes `seedPhrase` and `privateKey` from the write.
   * Those sensitive values are only written through `saveEncrypted`, which
   * wraps them in AES encryption before storage.
   *
   * @async
   * @param {{ users?: Object, settings?: Object, [key: string]: any }} vaultData
   *   The full vault object; only `users` and `settings` will be persisted.
   * @returns {Promise<void>}
   */
  async function saveVault(vaultData) {
    // Save non-sensitive data (users, settings — NOT seed phrase or private key)
    const safe = {
      users: vaultData.users || {},
      settings: vaultData.settings || { hashLength: 16 },
    };
    await chrome.storage.local.set({ [KEYS.VAULT]: safe });
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
   * Remove the non-sensitive vault data from chrome.storage.local.
   *
   * Does NOT remove the encrypted blob — that must be done separately if
   * the user wants a full wipe. The encrypted blob is intentionally retained
   * so the user can still unlock after a "clear non-sensitive data" operation.
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
   * Decrypt a Nostr backup event using the appropriate NIP.
   *
   * Supports two encryption schemes used by different versions of the web app:
   *   - kind:30078 events → NIP-44 (newer, preferred — XChaCha20-Poly1305)
   *   - kind:1 events     → NIP-04 (legacy — AES-256-CBC + shared secret)
   *
   * NIP-44 uses a shared secret derived from the sender's SK and their own PK
   * (self-encryption pattern for backup data).
   *
   * @async
   * @param  {import('nostr-tools').Event} event - The Nostr event to decrypt.
   * @param  {string}                      sk    - Nostr secret key (hex).
   * @param  {string}                      pk    - Nostr public key (hex).
   * @returns {Promise<string>} Decrypted plaintext content.
   */
  async function decryptBackupEvent(event, sk, pk) {
    const { nip44, nip04 } = window.NostrTools;
    if (event.kind === 30078) {
      // NIP-44: self-encrypted (SK encrypts to own PK)
      const sharedSecret = nip44.getSharedSecret(sk, pk);
      return nip44.decrypt(sharedSecret, event.content);
    } else {
      // NIP-04: legacy encryption (used by older kind:1 backups)
      return await nip04.decrypt(sk, event.pubkey, event.content);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Nostr backup & restore (public API)
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Back up the vault's site list and settings to Nostr relays.
   *
   * Creates a kind:30078 (replaceable application-specific data) Nostr event:
   *   - Content: NIP-44 encrypted JSON `{ users, settings }` (NO private key/seed)
   *   - Tags:    `[["d", "vault-backup"]]` — makes it addressable and replaceable
   *   - Pubkey:  derived from the vault private key via `getNostrKeyPair`
   *
   * The event is published to all relays in `RELAYS` concurrently (fire-and-forget
   * per relay). Returns the count of relays that accepted the publish without error.
   *
   * Security: Only `users` (site→nonce map) and `settings` are included.
   *           The seed phrase and private key are never sent to relays.
   *
   * @async
   * @param  {{ privateKey: string, users: Object, settings: Object }} vault
   *   The current vault state (must have privateKey set).
   * @param  {boolean} [silent=false] - If true, suppresses console errors (used for background backup).
   * @returns {Promise<{ success: number, total?: number, error?: string }>}
   *           success — number of relays that accepted the event
   *           total   — total relays attempted
   *           error   — error message if vault has no private key
   */
  async function backupToNostr(vault, silent = false) {
    const { nip44, getEventHash, signEvent } = window.NostrTools;
    if (!vault.privateKey) return { success: 0, error: 'Vault not initialized' };

    try {
      const { sk, pk } = await getNostrKeyPair(vault.privateKey);

      // NIP-44 self-encryption: encrypt the backup to our own public key
      const sharedSecret = nip44.getSharedSecret(sk, pk);
      const data = JSON.stringify({ users: vault.users, settings: vault.settings });
      const encrypted = nip44.encrypt(sharedSecret, data);

      // Build the replaceable application data event (kind:30078)
      const event = {
        kind: 30078,
        pubkey: pk,
        created_at: Math.floor(Date.now() / 1000),
        tags: [['d', BACKUP_D_TAG]],
        content: encrypted,
      };
      event.id = getEventHash(event);
      event.sig = await signEvent(event, sk);

      // Publish to all relays; count successes
      let success = 0;
      for (const url of RELAYS) {
        try {
          const relay = await connectRelay(url);
          relay.publish(event);
          relay.close();
          success++;
        } catch (e) { console.error(url, e); }
      }

      return { success, total: RELAYS.length };
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
   * @param  {string} privateKey - Vault hex private key (used to derive Nostr keypair).
   * @returns {Promise<{ users: Object, settings: Object } | null>}
   *           The decrypted backup data, or null if no backup exists.
   */
  async function restoreFromNostr(privateKey) {
    if (!privateKey) return null;

    const { sk, pk } = await getNostrKeyPair(privateKey);
    let latest = null; // The most recent event found across all relays

    for (const url of RELAYS) {
      try {
        const relay = await connectRelay(url);
        const events = await subscribeAndCollect(relay, [
          // Current format: NIP-44 encrypted kind:30078
          { kinds: [30078], authors: [pk], '#d': [BACKUP_D_TAG], limit: 1 },
          // Legacy format: NIP-04 encrypted kind:1 with hashtag
          { kinds: [1], authors: [pk], '#t': ['nostr-pwd-backup'], limit: 1 },
        ], 6000);
        relay.close();
        // Pick the most recent event across all relays
        for (const e of events) {
          if (!latest || e.created_at > latest.created_at) latest = e;
        }
      } catch (e) { console.error(url, e); }
    }

    if (!latest) return null;

    try {
      const decrypted = await decryptBackupEvent(latest, sk, pk);
      return JSON.parse(decrypted);
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
    connectRelay,
    subscribeAndCollect,
    getNostrKeyPair,
    decryptBackupEvent,
    backupToNostr,
    restoreFromNostr,
  };
})();
