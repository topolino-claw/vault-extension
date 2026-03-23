/**
 * @fileoverview Vault — Background Service Worker (Manifest V3)
 *
 * Responsibilities:
 *   1. Hold the unlocked vault state in-memory while the service worker is alive.
 *      The service worker can be killed by the browser at any time (after ~30 s of
 *      inactivity in MV3), so this is a best-effort cache — the popup must handle
 *      a "cold start" where vaultState is null.
 *   2. Route messages between the popup and content scripts.
 *   3. Create and handle the right-click context menu item.
 *
 * Lifecycle notes (MV3 service workers):
 *   - Service workers start when an extension event fires (message, context menu
 *     click, alarm, etc.) and go idle after activity stops.
 *   - `vaultState` is module-level and therefore lives only as long as this
 *     service worker instance. It is intentionally NOT persisted to disk here —
 *     the encrypted blob in chrome.storage.local is the persistence layer.
 *   - The popup always calls GET_VAULT_STATE on open; if the worker was killed and
 *     restarted, it returns { unlocked: false } and the popup shows the welcome
 *     screen instead of auto-navigating to the main screen.
 */

// ─────────────────────────────────────────────────────────────────────────────
// In-memory vault state
// ─────────────────────────────────────────────────────────────────────────────

/**
 * In-memory snapshot of the unlocked vault.
 * Set by the popup via SET_VAULT_STATE; cleared by LOCK_VAULT.
 * Intentionally null after a service-worker restart (forces re-unlock).
 *
 * @type {{ privateKey: string, seedPhrase: string, users: Object, settings: Object } | null}
 */
let vaultState = null;

// ─────────────────────────────────────────────────────────────────────────────
// Message Handling
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Central message router for all extension-internal communication.
 *
 * Message types handled:
 *  - GET_VAULT_STATE   → returns current in-memory vault (or { unlocked: false })
 *  - SET_VAULT_STATE   → stores the unlocked vault payload in memory
 *  - LOCK_VAULT        → wipes in-memory vault state
 *  - GENERATE_FOR_DOMAIN → content script probe: is the vault currently unlocked?
 *
 * All handlers return `true` to signal async response (required by Chrome
 * even for synchronous handlers so the message channel stays open).
 *
 * @param {{ type: string, data?: Object }} message - Message from popup or content script.
 * @param {chrome.runtime.MessageSender}   sender   - Sender metadata (tab id, url, etc.).
 * @param {function}                       sendResponse - Callback to reply to sender.
 * @returns {boolean} true — keeps the message channel open for async replies.
 */
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  switch (message.type) {

    /**
     * GET_VAULT_STATE
     * Called by the popup on every open to check if the vault is already
     * unlocked from a previous session in the same service worker lifetime.
     * Response: { unlocked: true, privateKey, seedPhrase, users, settings }
     *        or { unlocked: false }
     */
    case 'GET_VAULT_STATE':
      if (vaultState) {
        sendResponse({ unlocked: true, ...vaultState });
      } else {
        sendResponse({ unlocked: false });
      }
      return true;

    /**
     * SET_VAULT_STATE
     * Called by the popup after the vault is initialized or unlocked.
     * Stores the full vault payload in memory so other event handlers
     * (e.g., context menu) can access it without reopening the popup.
     * Response: { ok: true }
     */
    case 'SET_VAULT_STATE':
      vaultState = message.data;
      sendResponse({ ok: true });
      return true;

    /**
     * LOCK_VAULT
     * Wipes the in-memory vault state. Called when the user clicks Lock.
     * The encrypted blob in chrome.storage.local is NOT deleted — only the
     * in-memory decrypted copy is cleared.
     * Response: { ok: true }
     */
    case 'LOCK_VAULT':
      vaultState = null;
      sendResponse({ ok: true });
      return true;

    /**
     * GENERATE_FOR_DOMAIN
     * Sent by the content script when it detects a login form on the page.
     * The background replies with whether the vault is unlocked so the
     * content script can decide whether to show a UI hint.
     * (Currently informational only — no UI is injected from the content script.)
     * Response: { unlocked: boolean }
     */
    case 'GENERATE_FOR_DOMAIN':
      if (vaultState) {
        sendResponse({ unlocked: true });
      } else {
        sendResponse({ unlocked: false });
      }
      return true;
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Context Menu
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Register the right-click context menu item on extension install or update.
 *
 * `onInstalled` fires on:
 *   - First install
 *   - Extension update (version bump in manifest.json)
 *   - Chrome update (browser-initiated worker restart)
 *
 * We recreate the menu every time because Chrome removes context menus when
 * the service worker is terminated, and they must be re-registered on startup.
 *
 * Menu item appears on:
 *   - `page`     → right-clicking a blank area of any page
 *   - `editable` → right-clicking inside a text / password input
 */
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: 'vault-generate',
    title: 'Generate password with Vault',
    contexts: ['page', 'editable'],
  });
});

/**
 * Handle a click on the "Generate password with Vault" context menu item.
 *
 * MV3 limitation: extensions cannot programmatically open their popup.
 * Instead, when the vault is locked we flash a badge on the extension icon
 * to visually prompt the user to click the toolbar icon and unlock first.
 *
 * Badge behavior:
 *   - Sets badge text to "!" with a red background for 3 seconds.
 *   - Scoped to the specific tab where the right-click occurred (`tabId`).
 *   - Auto-clears after 3 000 ms so it doesn't persist indefinitely.
 *
 * If the vault IS unlocked, the user still needs to open the popup manually
 * and use "Fill on Page" — this handler is a future extension point.
 *
 * @param {chrome.contextMenus.OnClickData} info - Details about the click (menuItemId, pageUrl, etc.).
 * @param {chrome.tabs.Tab}                 tab  - The tab where the right-click happened.
 */
chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId === 'vault-generate') {
    // Open popup — can't programmatically open popup, so open in a new tab
    // or badge the icon to indicate action needed
    if (!vaultState) {
      // Flash badge to indicate need to unlock
      chrome.action.setBadgeText({ text: '!', tabId: tab.id });
      chrome.action.setBadgeBackgroundColor({
        color: '#ff4d6a',
        tabId: tab.id,
      });
      setTimeout(() => {
        chrome.action.setBadgeText({ text: '', tabId: tab.id });
      }, 3000);
    }
  }
});
