/**
 * Web's device identity (TAD §8.6). Generated in the browser with
 * @wpt/crypto; only the PUBLIC halves are ever sent to the backend (inside
 * the linking registration). The private halves stay in this browser.
 *
 * One identity per pending link: it is reused across QR refreshes so the
 * backend links the device that registered, and discarded on log-off so the
 * next link is a new device.
 *
 * Storage: localStorage, so a linked tab survives a reload (WEB-R1.7).
 * Moving private keys to a non-extractable WebCrypto/IndexedDB store is a
 * follow-up for the E2E messaging cards.
 */

import { generateIdentityKeyPair, generateX25519KeyPair } from "@wpt/crypto";
import type { LinkingIdentityBundle } from "@wpt/shared";

const KEY = "wpt.web.identity";

interface StoredIdentity {
  identityPublicKey: string;
  identityPrivateKey: string;
  signingPublicKey: string;
  signingPrivateKey: string;
}

const b64 = (u: Uint8Array) => {
  let s = "";
  for (const b of u) s += String.fromCharCode(b);
  return btoa(s);
};

function read(): StoredIdentity | null {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as StoredIdentity) : null;
  } catch {
    return null;
  }
}

/** The current identity bundle, creating one if this browser has none. */
export function getOrCreateIdentity(): LinkingIdentityBundle {
  let id = read();
  if (!id) {
    const dh = generateX25519KeyPair();
    const sig = generateIdentityKeyPair();
    id = {
      identityPublicKey: b64(dh.publicKey),
      identityPrivateKey: b64(dh.privateKey),
      signingPublicKey: b64(sig.publicKey),
      signingPrivateKey: b64(sig.privateKey),
    };
    try {
      localStorage.setItem(KEY, JSON.stringify(id));
    } catch {
      // Private mode / storage blocked: the identity lives for this tab only.
    }
  }
  return { identityPublicKey: id.identityPublicKey, signingPublicKey: id.signingPublicKey };
}

export function clearIdentity(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* nothing stored */
  }
}
