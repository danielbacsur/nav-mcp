import { describe, expect, it } from "vitest";

import { readCredentials, readEnv } from "./credentials";

const HEADERS = {
  "X-NAV-Login": "tstuser01abcde",
  "X-NAV-Password": "Tst-Pw-123",
  "X-NAV-Signature-Key": "ac-ac3a-7f661bff7d342N43CYX4U9FG",
  "X-NAV-Exchange-Key": "TSTKEY0123456789",
  "X-NAV-Tax-Number": "11111111-2-42",
};

// SHA-512 of HEADERS["X-NAV-Password"], computed with Python's hashlib.
const PASSWORD_HASH =
  "2FF2A0823711252A87F0B82BF7AF53FC48289CF83BA6DBA91CAAB67804C268CD14783ACC2408C5BEA79290B8A50F7FE5D0B0B06E593FA967D3BD5C543FC3ECC2";

function request(headers: Record<string, string>) {
  return new Request("http://localhost:3000/mcp", { headers });
}

function without(...names: (keyof typeof HEADERS)[]) {
  return Object.fromEntries(
    Object.entries(HEADERS).filter(
      ([name]) => !names.includes(name as keyof typeof HEADERS),
    ),
  );
}

describe("readCredentials", () => {
  describe("valid headers", () => {
    it("maps every header onto the credentials it signs with", () => {
      expect(readCredentials(request(HEADERS))).toEqual({
        credentials: {
          login: "tstuser01abcde",
          passwordHash: PASSWORD_HASH,
          signingKey: "ac-ac3a-7f661bff7d342N43CYX4U9FG",
          exchangeKey: "TSTKEY0123456789",
          taxNumber: "11111111",
          env: "test",
        },
      });
    });

    it("reads the headers whatever case the caller uses", () => {
      const lowerCase = Object.fromEntries(
        Object.entries(HEADERS).map(([name, value]) => [
          name.toLowerCase(),
          value,
        ]),
      );

      expect(readCredentials(request(lowerCase))).toEqual(
        readCredentials(request(HEADERS)),
      );
    });

    it("upper-cases a password hash given in lower case", () => {
      const { credentials } = readCredentials(
        request({
          ...without("X-NAV-Password"),
          "X-NAV-Password-Hash": PASSWORD_HASH.toLowerCase(),
        }),
      );

      expect(credentials?.passwordHash).toBe(PASSWORD_HASH);
    });

    it("prefers the password hash when given a password too", () => {
      const { credentials } = readCredentials(
        request({ ...HEADERS, "X-NAV-Password-Hash": "A".repeat(128) }),
      );

      expect(credentials?.passwordHash).toBe("A".repeat(128));
    });

    it("keeps the first 8 digits of every tax number format", () => {
      for (const taxNumber of [
        "11111111",
        "11111111242",
        "11111111-2-42",
        "11111111-242",
        "111111112-42",
      ]) {
        const { credentials } = readCredentials(
          request({ ...HEADERS, "X-NAV-Tax-Number": taxNumber }),
        );

        expect(credentials?.taxNumber).toBe("11111111");
      }
    });

    it("leaves the exchange key out when the caller omits it", () => {
      const { credentials } = readCredentials(
        request(without("X-NAV-Exchange-Key")),
      );

      expect(credentials).toBeDefined();
      expect(credentials?.exchangeKey).toBeUndefined();
    });

    it("selects production only when the caller asks for it", () => {
      const { credentials } = readCredentials(
        request({ ...HEADERS, "X-NAV-Env": "production" }),
      );

      expect(credentials?.env).toBe("production");
    });
  });

  describe("invalid headers", () => {
    it("lists every missing header for a request without any", () => {
      expect(readCredentials(undefined)).toEqual({
        error:
          "X-NAV-Login is missing or invalid. X-NAV-Signature-Key is missing or invalid. X-NAV-Tax-Number is missing or invalid. Send X-NAV-Password or X-NAV-Password-Hash.",
      });
    });

    it("lists every invalid header once in a single error", () => {
      expect(
        readCredentials(
          request({
            ...HEADERS,
            "X-NAV-Login": "short",
            "X-NAV-Password-Hash": "not-a-hash",
            "X-NAV-Exchange-Key": "too-short",
            "X-NAV-Tax-Number": "1234-5678",
            "X-NAV-Env": "staging",
          }),
        ),
      ).toEqual({
        error:
          "X-NAV-Login is missing or invalid. X-NAV-Password-Hash is missing or invalid. X-NAV-Exchange-Key is missing or invalid. X-NAV-Tax-Number is missing or invalid. X-NAV-Env is missing or invalid.",
      });
    });

    it("asks for a password along with other missing headers", () => {
      expect(
        readCredentials(request(without("X-NAV-Password", "X-NAV-Login"))),
      ).toEqual({
        error:
          "X-NAV-Login is missing or invalid. Send X-NAV-Password or X-NAV-Password-Hash.",
      });
    });

    it("never echoes a rejected header's value in the error", () => {
      const secrets = {
        "X-NAV-Login": "secret-login-value",
        "X-NAV-Password": "",
        "X-NAV-Password-Hash": "secret-password-hash-value",
        "X-NAV-Signature-Key": "",
        "X-NAV-Exchange-Key": "secret-exchange-key-value",
        "X-NAV-Tax-Number": "secret-tax-number-value",
        "X-NAV-Env": "secret-env-value",
      };

      const { error } = readCredentials(request(secrets));

      expect(error).toBeDefined();

      for (const value of Object.values(secrets).filter(Boolean)) {
        expect(error).not.toContain(value);
      }
    });
  });
});

describe("readEnv", () => {
  it("defaults to the test environment with no X-NAV-Env", () => {
    expect(readEnv(undefined)).toBe("test");
    expect(readEnv(request({}))).toBe("test");
  });

  it("returns the production environment when asked for", () => {
    expect(readEnv(request({ "X-NAV-Env": "production" }))).toBe("production");
  });

  it("falls back to test for an unknown X-NAV-Env value", () => {
    expect(readEnv(request({ "X-NAV-Env": "staging" }))).toBe("test");
  });
});
