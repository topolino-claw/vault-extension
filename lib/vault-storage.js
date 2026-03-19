/**
 * Vault Storage — chrome.storage.local wrapper
 * Replaces localStorage from the web version
 */

const VaultStorage = (() => {
  const KEYS = {
    VAULT: 'vault',
    LOCKED: 'vaultLocked',
    ENCRYPTED: 'vaultEncrypted',
  };

  async function getVault() {
    const result = await chrome.storage.local.get(KEYS.VAULT);
    return result[KEYS.VAULT] || null;
  }

  async function saveVault(vaultData) {
    // Save non-sensitive data (users, settings — NOT seed phrase or private key)
    const safe = {
      users: vaultData.users || {},
      settings: vaultData.settings || { hashLength: 16 },
    };
    await chrome.storage.local.set({ [KEYS.VAULT]: safe });
  }

  async function getEncrypted() {
    const result = await chrome.storage.local.get(KEYS.ENCRYPTED);
    return result[KEYS.ENCRYPTED] || {};
  }

  async function saveEncrypted(data) {
    await chrome.storage.local.set({ [KEYS.ENCRYPTED]: data });
  }

  async function clear() {
    await chrome.storage.local.remove([KEYS.VAULT]);
  }

  // ============================================
  // Nostr Relay Helpers
  // ============================================
  const RELAYS = [
    'wss://relay.damus.io',
    'wss://nostr-pub.wellorder.net',
    'wss://relay.snort.social',
    'wss://nos.lol',
  ];

  const BACKUP_D_TAG = 'vault-backup';

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

  function subscribeAndCollect(relay, filters, timeoutMs = 8000) {
    return new Promise(resolve => {
      const events = [];
      const sub = relay.sub(filters);
      const t = setTimeout(() => { sub.unsub(); resolve(events); }, timeoutMs);
      sub.on('event', e => events.push(e));
      sub.on('eose', () => { clearTimeout(t); sub.unsub(); resolve(events); });
    });
  }

  async function getNostrKeyPair(privateKey) {
    const { getPublicKey } = window.NostrTools;
    const { sk } = await VaultCore.deriveNostrKeys(privateKey);
    const pk = getPublicKey(sk);
    return { sk, pk };
  }

  async function decryptBackupEvent(event, sk, pk) {
    const { nip44, nip04 } = window.NostrTools;
    if (event.kind === 30078) {
      const sharedSecret = nip44.getSharedSecret(sk, pk);
      return nip44.decrypt(sharedSecret, event.content);
    } else {
      return await nip04.decrypt(sk, event.pubkey, event.content);
    }
  }

  async function backupToNostr(vault, silent = false) {
    const { nip44, getEventHash, signEvent } = window.NostrTools;
    if (!vault.privateKey) return { success: 0, error: 'Vault not initialized' };

    try {
      const { sk, pk } = await getNostrKeyPair(vault.privateKey);
      const sharedSecret = nip44.getSharedSecret(sk, pk);
      const data = JSON.stringify({ users: vault.users, settings: vault.settings });
      const encrypted = nip44.encrypt(sharedSecret, data);

      const event = {
        kind: 30078,
        pubkey: pk,
        created_at: Math.floor(Date.now() / 1000),
        tags: [['d', BACKUP_D_TAG]],
        content: encrypted,
      };
      event.id = getEventHash(event);
      event.sig = await signEvent(event, sk);

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

  async function restoreFromNostr(privateKey) {
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
      const decrypted = await decryptBackupEvent(latest, sk, pk);
      return JSON.parse(decrypted);
    } catch (e) {
      console.error('Decrypt failed:', e);
      return null;
    }
  }

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
