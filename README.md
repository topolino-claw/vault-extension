# Vault Extension — Chrome Password Manager

Same deterministic algorithm as [Vault Web](https://github.com/topolino-claw/PasswordManagerWeb), built into your browser with autofill.

**Install:** download ZIP from [releases](https://github.com/topolino-claw/vault-extension/releases) → Chrome → `chrome://extensions/` → Developer mode → Load unpacked

---

## How It Works

```
password = "PASS" + SHA256(privateKey + "/" + username + "/" + domain + "/" + nonce).slice(0,16) + "249+"
```

Same seed phrase → same passwords as the web app. Always.

---

## Setup

1. Install the extension (see above)
2. Click the Vault icon in toolbar
3. Create new vault or restore with existing seed phrase
4. Set a backup password when prompted (protects Nostr cloud sync)
5. Visit any site → Vault detects the domain → click Fill or Copy

---

## Master Keys

| Key | Where it lives |
|---|---|
| **Seed phrase** | Paper, 2 copies, separate locations. Never digital. |
| **Vault password** | Unlocks the local encrypted vault each session |
| **Backup password** | Protects Nostr backup — never stored, only in your head |

---

## Features

- **Autofill:** detects password fields, fills with one click (React/Vue compatible)
- **Domain detection:** current tab's domain auto-filled, saved sites bubble to top
- **Nostr backup:** double-encrypted sync (same as web app)
- **Context menu:** right-click → "Generate password with Vault"

---

## Nostr Backup

Same double-encryption as web app:
1. `PBKDF2(backupPassword, npub, 600k)` → `AES-256-GCM` (Layer 1)
2. `NIP-44` with Nostr key derived from seed (Layer 2)

Auto-syncs after every change. No single-layer fallback — if backup password not set, sync is deferred until you provide it.

---

## Files

```
manifest.json       — MV3 manifest
background.js       — service worker (state, context menu)
content.js          — autofill injection
popup/              — 12-screen popup UI
lib/
  vault-core.js     — password generation, BIP39, key derivation
  vault-storage.js  — storage + Nostr backup
  crypto-js.min.js
  bip39WordList.js
  nostr-tools.min.js
```

---

## Recreating From Scratch

Lost your device? New browser?

1. Install extension from [releases](https://github.com/topolino-claw/vault-extension/releases)
2. Open popup → Restore
3. Enter seed phrase → Enter backup password
4. All sites restored from Nostr

---

## Compatibility

Fully compatible with Vault Web — same seed phrase generates identical passwords on both.

Repo: https://github.com/topolino-claw/vault-extension
