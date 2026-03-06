/**
 * Vault — Background Service Worker
 * Keeps vault state alive while extension is open
 * Handles context menu and messaging
 */

// In-memory vault state (cleared when service worker dies)
let vaultState = null;

// ============================================
// Message Handling
// ============================================
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  switch (message.type) {
    case 'GET_VAULT_STATE':
      if (vaultState) {
        sendResponse({ unlocked: true, ...vaultState });
      } else {
        sendResponse({ unlocked: false });
      }
      return true;

    case 'SET_VAULT_STATE':
      vaultState = message.data;
      sendResponse({ ok: true });
      return true;

    case 'LOCK_VAULT':
      vaultState = null;
      sendResponse({ ok: true });
      return true;

    case 'GENERATE_FOR_DOMAIN':
      // Content script detected a login form
      if (vaultState) {
        sendResponse({ unlocked: true });
      } else {
        sendResponse({ unlocked: false });
      }
      return true;
  }
});

// ============================================
// Context Menu
// ============================================
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: 'vault-generate',
    title: 'Generate password with Vault',
    contexts: ['page', 'editable'],
  });
});

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
