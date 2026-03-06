/**
 * Vault Core — deterministic password generation & BIP39 utilities
 * Shared between popup, background, and content scripts
 */

const VaultCore = (() => {
  function decimalStringToHex(decStr) {
    if (!/^\d+$/.test(decStr)) throw new Error('Invalid decimal string');
    return BigInt(decStr).toString(16);
  }

  function wordsToIndices(inputWords) {
    const wordsArray = inputWords.trim().split(/\s+/);
    return wordsArray
      .map((word) => {
        const index = words.indexOf(word.toLowerCase());
        if (index === -1) throw new Error(`Word "${word}" not found`);
        return index.toString().padStart(4, '0');
      })
      .join('');
  }

  async function verifyBip39SeedPhrase(seedPhrase) {
    const normalized = seedPhrase.replace(/\s+/g, ' ').trim().toLowerCase();
    const seedWords = normalized.split(' ');

    if (![12, 15, 18, 21, 24].includes(seedWords.length)) return false;

    const invalid = seedWords.filter((w) => !words.includes(w));
    if (invalid.length > 0) return false;

    const totalBits = seedWords.length * 11;
    const checksumBits = totalBits % 32;
    const entropyBits = totalBits - checksumBits;

    const binary = seedWords
      .map((w) => words.indexOf(w).toString(2).padStart(11, '0'))
      .join('');
    const entropy = binary.slice(0, entropyBits);
    const checksum = binary.slice(entropyBits);

    const entropyBytes = new Uint8Array(entropy.length / 8);
    for (let i = 0; i < entropy.length; i += 8) {
      entropyBytes[i / 8] = parseInt(entropy.slice(i, i + 8), 2);
    }

    const hashBuffer = await crypto.subtle.digest('SHA-256', entropyBytes);
    const hashBinary = Array.from(new Uint8Array(hashBuffer))
      .map((b) => b.toString(2).padStart(8, '0'))
      .join('');

    return checksum === hashBinary.slice(0, checksumBits);
  }

  async function generateMnemonic() {
    const entropy = new Uint8Array(16);
    crypto.getRandomValues(entropy);

    const entropyBinary = Array.from(entropy)
      .map((b) => b.toString(2).padStart(8, '0'))
      .join('');
    const hashBuffer = await crypto.subtle.digest('SHA-256', entropy);
    const hashBinary = Array.from(new Uint8Array(hashBuffer))
      .map((b) => b.toString(2).padStart(8, '0'))
      .join('');
    const checksumBits = entropyBinary.length / 32;

    const fullBinary = entropyBinary + hashBinary.slice(0, checksumBits);
    const mnemonic = [];
    for (let i = 0; i < fullBinary.length; i += 11) {
      mnemonic.push(words[parseInt(fullBinary.slice(i, i + 11), 2)]);
    }

    return mnemonic.join(' ');
  }

  async function derivePrivateKey(seedPhrase) {
    const normalized = seedPhrase.replace(/\s+/g, ' ').trim().toLowerCase();
    const indices = wordsToIndices(normalized);
    return decimalStringToHex(indices);
  }

  function hash(text) {
    return CryptoJS.SHA256(text).toString();
  }

  function generatePassword(privateKey, user, site, nonce, hashLength = 16) {
    const concat = `${privateKey}/${user}/${site}/${nonce}`;
    const entropy = hash(concat).substring(0, hashLength);
    return 'PASS' + entropy + '249+';
  }

  /**
   * Extract the registrable domain from a URL
   * e.g. "https://mail.google.com/inbox" → "google.com"
   */
  function extractDomain(url) {
    try {
      const hostname = new URL(url).hostname;
      // Simple: take last 2 parts (or 3 for co.uk etc.)
      const parts = hostname.split('.');
      if (parts.length <= 2) return hostname;
      // Handle common two-part TLDs
      const twoPartTLDs = ['co.uk', 'com.au', 'com.br', 'co.jp', 'co.kr', 'com.ar'];
      const lastTwo = parts.slice(-2).join('.');
      if (twoPartTLDs.includes(lastTwo)) {
        return parts.slice(-3).join('.');
      }
      return parts.slice(-2).join('.');
    } catch {
      return url;
    }
  }

  return {
    decimalStringToHex,
    wordsToIndices,
    verifyBip39SeedPhrase,
    generateMnemonic,
    derivePrivateKey,
    hash,
    generatePassword,
    extractDomain,
  };
})();

if (typeof module !== 'undefined') module.exports = VaultCore;
