/**
 * @fileoverview Vault — Content Script
 *
 * Injected into every page the user visits (see manifest.json `content_scripts`).
 * Its sole purpose is to:
 *   1. Find visible password (and username) input fields in the DOM.
 *   2. Listen for a FILL_PASSWORD message from the popup and fill those fields.
 *
 * The content script is intentionally passive — it does NOT inject any UI into
 * the page and does NOT send any data back to the background on its own.
 * All communication is initiated by the popup (or background) via
 * `chrome.tabs.sendMessage`.
 *
 * Message API (inbound):
 *   FILL_PASSWORD { password: string, username?: string }
 *     → Finds visible password field(s), sets their value, and triggers
 *       framework-compatible input/change events.
 *
 * Security considerations:
 *   - The content script has access to the page DOM but NOT to extension storage
 *     or the vault private key.
 *   - Passwords are received only from the trusted extension popup (same-extension
 *     message origin), never from the page itself.
 *   - `setNativeValue` uses the native prototype setter to avoid being blocked
 *     by React/Vue/Angular input abstractions.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Password Field Detection
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Find all visible `<input type="password">` elements in the current document.
 *
 * Visibility check: `el.offsetParent !== null` filters out elements that are
 * hidden via `display:none` or inside a hidden ancestor. This avoids filling
 * password fields that are part of hidden components or carousels.
 *
 * @returns {HTMLInputElement[]} Array of visible password input elements.
 */
function findPasswordFields() {
  return Array.from(document.querySelectorAll('input[type="password"]')).filter(
    (el) => el.offsetParent !== null // visible only
  );
}

/**
 * Find the username or email field most likely associated with a given
 * password field.
 *
 * Strategy:
 *   1. Search within the same `<form>` element if one exists; otherwise
 *      fall back to `document.body` (for single-page apps with no `<form>`).
 *   2. Collect all text/email/username-autocomplete inputs that are visible.
 *   3. Walk backwards through the tab order (DOM order) from the password field.
 *      The first matching input found before the password field is the best
 *      candidate — this mirrors how browsers implement autofill association.
 *   4. If no preceding field is found, fall back to the first visible candidate.
 *
 * Selector covers:
 *   - `input[type="text"]`           — generic text fields
 *   - `input[type="email"]`          — email-specific fields
 *   - `input[name*="user"]`          — common "username" name attributes
 *   - `input[name*="email"]`         — common "email" name attributes
 *   - `input[name*="login"]`         — common "login" name attributes
 *   - `input[autocomplete="username"]` — explicit WHATWG autocomplete hint
 *   - `input[autocomplete="email"]`    — explicit WHATWG autocomplete hint
 *
 * @param {HTMLInputElement} passwordField - The password field to find a partner for.
 * @returns {HTMLInputElement|null} The best candidate username/email field, or null.
 */
function findUsernameField(passwordField) {
  // Walk backwards through the form to find the username/email input
  const form = passwordField.closest('form');
  const container = form || document.body;

  const inputs = Array.from(
    container.querySelectorAll(
      'input[type="text"], input[type="email"], input[name*="user"], input[name*="email"], input[name*="login"], input[autocomplete="username"], input[autocomplete="email"]'
    )
  ).filter((el) => el.offsetParent !== null);

  if (inputs.length === 0) return null;

  // Prefer the input closest (before) the password field in DOM order
  const allInputs = Array.from(container.querySelectorAll('input')).filter(
    (el) => el.offsetParent !== null
  );
  const pwIndex = allInputs.indexOf(passwordField);

  for (let i = pwIndex - 1; i >= 0; i--) {
    const inp = allInputs[i];
    if (
      inp.type === 'text' ||
      inp.type === 'email' ||
      inp.autocomplete === 'username' ||
      inp.autocomplete === 'email'
    ) {
      return inp;
    }
  }

  return inputs[0];
}

// ─────────────────────────────────────────────────────────────────────────────
// Fill Handler
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Listen for FILL_PASSWORD messages sent by the popup via `chrome.tabs.sendMessage`.
 *
 * Flow:
 *   1. Popup generates the password (vault must already be unlocked).
 *   2. Popup calls `chrome.tabs.sendMessage(tabId, { type: 'FILL_PASSWORD', ... })`.
 *   3. This handler finds all visible password fields and fills them.
 *   4. If a username is provided, it also fills the associated username field.
 *   5. Responds with `{ filled: true }` on success or `{ filled: false, reason }` on failure.
 *
 * Note: Multiple password fields are filled to handle "confirm password" forms.
 *
 * @listens chrome.runtime#onMessage
 * @param {{ type: string, password: string, username?: string }} message
 * @param {chrome.runtime.MessageSender} sender
 * @param {function} sendResponse
 * @returns {boolean} true — keep the channel open for async responses.
 */
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'FILL_PASSWORD') {
    const passwordFields = findPasswordFields();

    if (passwordFields.length === 0) {
      sendResponse({ filled: false, reason: 'No password field found' });
      return true;
    }

    // Fill password field(s)
    passwordFields.forEach((field) => {
      setNativeValue(field, message.password);
    });

    // Fill username if provided
    if (message.username) {
      const usernameField = findUsernameField(passwordFields[0]);
      if (usernameField) {
        setNativeValue(usernameField, message.username);
      }
    }

    sendResponse({ filled: true });
    return true;
  }
});

/**
 * Set value on an input using native setter to trigger React/Vue/Angular change detection.
 *
 * The problem with `element.value = x`:
 *   Modern JS frameworks (React, Vue, Angular) intercept DOM mutations via
 *   property descriptors. If you set `.value` directly, the framework's
 *   synthetic event system may not be notified and the input's bound state
 *   variable won't update — the password appears filled visually but the
 *   form submission sends an empty value.
 *
 * Solution:
 *   1. Grab the native `value` setter from `HTMLInputElement.prototype` —
 *      this is the low-level setter that React/Vue patch over.
 *   2. Call it with `.call(element, value)` to bypass the framework's wrapper.
 *   3. Dispatch `input` and `change` events with `bubbles: true` so that
 *      framework event listeners up the tree are notified.
 *   4. Focus the field to trigger any focus-dependent framework bindings.
 *
 * @param {HTMLInputElement} element - The input element to fill.
 * @param {string}           value   - The value to set.
 */
function setNativeValue(element, value) {
  const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    'value'
  ).set;
  nativeInputValueSetter.call(element, value);

  // Dispatch events to trigger framework change handlers
  element.dispatchEvent(new Event('input', { bubbles: true }));
  element.dispatchEvent(new Event('change', { bubbles: true }));

  // Focus the field briefly
  element.focus();
}
