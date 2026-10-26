import { createDecipheriv, createHash, randomBytes } from "node:crypto";

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

// A submitted invoice or annulment, signed over its base64 text exactly as it
// appears in the request.
export type SignedOperation = { operation: string; data: string };

// manageInvoice and manageAnnulment also sign each operation, in index order.
export function requestSignature(
  requestId: string,
  timestamp: string,
  signingKey: string,
  operations: SignedOperation[] = [],
) {
  const operationHashes = operations.map(({ operation, data }) =>
    hash("sha3-512", operation + data),
  );

  return hash(
    "sha3-512",
    requestId +
      signatureTimestamp(timestamp) +
      signingKey +
      operationHashes.join(""),
  );
}

// The exchange key's 16 characters are the raw AES-128 key bytes.
export function decodeExchangeToken(encoded: string, exchangeKey: string) {
  const decipher = createDecipheriv(
    "aes-128-ecb",
    Buffer.from(exchangeKey, "utf8"),
    null,
  );

  return Buffer.concat([
    decipher.update(Buffer.from(encoded, "base64")),
    decipher.final(),
  ]).toString("utf8");
}
