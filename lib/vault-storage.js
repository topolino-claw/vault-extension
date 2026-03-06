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

  return {
    KEYS,
    getVault,
    saveVault,
    getEncrypted,
    saveEncrypted,
    clear,
  };
})();
