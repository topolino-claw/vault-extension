# Vault — Chrome Extension

Deterministic password manager as a Chrome extension. Same math as [Vault Web](https://github.com/fabricio333/PasswordManagerWeb), now with autofill.

## Features

- **Deterministic passwords** — same inputs = same password, always
- **BIP39 seed phrase** — write it down, recover anywhere
- **Autofill** — detects password fields and fills with one click
- **Current site detection** — shows the active tab's domain automatically
- **Domain matching** — sites you've saved bubble to the top when you visit them
- **Context menu** — right-click → "Generate password with Vault"
- **No server, no sync** — everything runs locally in the extension

## Install (Developer Mode)

1. Clone this repo
2. Open `chrome://extensions/`
3. Enable **Developer mode** (top right)
4. Click **Load unpacked**
5. Select the `vault-extension` folder
6. Click the puzzle piece icon → pin Vault

## Usage

1. Click the Vault icon in the toolbar
2. Create a new vault or restore an existing seed phrase
3. Visit a site → Vault detects the domain and offers to generate
4. Click **Copy Password** or **Fill on Page**

## Password Generation

Same algorithm as the web version:

```
password = "PASS" + SHA256(privateKey + "/" + username + "/" + site + "/" + version).slice(0, 16) + "249+"
```

## Compatibility

Fully compatible with the web version — same seed phrase generates the same passwords.

## Files

```
manifest.json          — Extension manifest (v3)
background.js          — Service worker (state, context menu)
content.js             — Content script (field detection, autofill)
popup/                 — Popup UI
  popup.html
  popup.css
  popup.js
lib/                   — Shared libraries
  vault-core.js        — Password generation & BIP39
  vault-storage.js     — chrome.storage.local wrapper
  crypto-js.min.js     — SHA256/AES
  bip39WordList.js     — BIP39 wordlist
  nostr-tools.min.js   — Nostr protocol (for future backup)
icons/                 — Extension icons
```

## TODO

- [ ] Nostr backup/restore (port from web version)
- [ ] Auto-detect and pre-fill username from saved sites
- [ ] Keyboard shortcut (Ctrl+Shift+V) to open popup
- [ ] Import from web version's localStorage

## License

MIT
