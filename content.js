/**
 * Vault — Content Script
 * Detects password fields and fills credentials on command
 */

// ============================================
// Password Field Detection
// ============================================
function findPasswordFields() {
  return Array.from(document.querySelectorAll('input[type="password"]')).filter(
    (el) => el.offsetParent !== null // visible only
  );
}

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

// ============================================
// Fill Handler
// ============================================
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
 * Set value on an input using native setter to trigger React/Vue/Angular change detection
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
