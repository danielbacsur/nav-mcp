import { createHash, randomBytes } from "node:crypto";

const REQUEST_ID_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

function hash(algorithm: "sha512" | "sha3-512", value: string) {
  return createHash(algorithm)
    .update(value, "utf8")
    .digest("hex")
    .toUpperCase();
}

export function passwordHash(password: string) {
  return hash("sha512", password);
}

// NAV requires a new requestId on every attempt, including retries, and
// counts rejected signatures as used.
export function createRequestId() {
  return Array.from(
    randomBytes(30),
    (byte) => REQUEST_ID_ALPHABET[byte % REQUEST_ID_ALPHABET.length],
  ).join("");
}

// Milliseconds are truncated, not rounded: 10:55:31.999Z signs as 105531.
function signatureTimestamp(timestamp: string) {
  return timestamp.slice(0, 19).replace(/[-T:]/g, "");
}

export function requestSignature(
  requestId: string,
  timestamp: string,
  signingKey: string,
) {
  return hash(
    "sha3-512",
    requestId + signatureTimestamp(timestamp) + signingKey,
  );
}
