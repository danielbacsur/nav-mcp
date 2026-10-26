import { describe, expect, it } from "vitest";

import {
  createRequestId,
  decodeExchangeToken,
  passwordHash,
  requestSignature,
} from "./crypto";

// The fictitious manageInvoice example in section 1.5.1 of the NAV Online
// Invoice 3.0 interface specification.
const SPEC_EXAMPLE = {
  requestId: "TSTKFT1222564",
  timestamp: "2017-12-30T18:25:45.000Z",
  signingKey: "ce-8f5e-215119fa7dd621DLMRHRLH2S",
  operations: [
    { operation: "CREATE", data: "QWJjZDEyMzQ=" },
    { operation: "MODIFY", data: "RGNiYTQzMjE=" },
  ],
  signature:
    "60BC80609EE3B8F42FE904200A49A1921A1DADA08D55319ACD40C59F626514B74EEA49011D372600A10DBCF8199D590DA9C2841D987308F2D83DAE17C2470C42",
};

// The signing key NAV's sample requests (nav-gov-hu/Online-Invoice, sample/API
// sample) leave in a comment next to their requestSignature.
const SAMPLE_SIGNING_KEY = "ac-ac3a-7f661bff7d342N43CYX4U9FG";

// The invoiceAnnulment of sample/API sample/manageAnnulment.xml.
const SAMPLE_ANNULMENT =
  "PD94bWwgdmVyc2lvbj0iMS4wIiBlbmNvZGluZz0iVVRGLTgiIHN0YW5kYWxvbmU9InllcyI/Pgo8SW52b2ljZUFubnVsbWVudCB4bWxucz0iaHR0cDovL3NjaGVtYXMubmF2Lmdvdi5odS9PU0EvMy4wL2FubnVsIj4KCQk8YW5udWxtZW50UmVmZXJlbmNlPjIyMjIyMjIyPC9hbm51bG1lbnRSZWZlcmVuY2U+CgkJPGFubnVsbWVudFRpbWVzdGFtcD4yMDE4LTA2LTE4VDA5OjEwOjQ1LjMwOVo8L2FubnVsbWVudFRpbWVzdGFtcD4KCQk8YW5udWxtZW50Q29kZT5FUlJBVElDX0RBVEE8L2FubnVsbWVudENvZGU+CgkJPGFubnVsbWVudFJlYXNvbj5jcmVhdGUgc3phbWxhIGFubnVsPC9hbm51bG1lbnRSZWFzb24+CjwvSW52b2ljZUFubnVsbWVudD4=";

// Encrypted with `openssl enc -aes-128-ecb -K <hex of EXCHANGE_KEY> -nosalt`.
const EXCHANGE_KEY = "TSTKEY0123456789";
const EXCHANGE_TOKEN = "b1aca173-d9e8-4561-9237-0511eed99eaa2P0ZHLXBRI2U";
const ENCODED_EXCHANGE_TOKEN =
  "eb7OSZwCZb8FyKoaMeke3ddOe+58NhWQ0XKNuqn4N2SHGdipOH4zIb/mgpWYBesWBbo0Z5EjlYzq/sA1IwjFqA==";

describe("createRequestId", () => {
  it("returns 30 characters that NAV's requestId allows", () => {
    expect(createRequestId()).toMatch(/^[a-zA-Z0-9]{30}$/);
  });

  it("returns a new id on every call, as retries require", () => {
    const ids = new Set(Array.from({ length: 1000 }, createRequestId));

    expect(ids.size).toBe(1000);
  });
});

describe("passwordHash", () => {
  it("matches the published sha-512 test vector for abc", () => {
    expect(passwordHash("abc")).toBe(
      "DDAF35A193617ABACC417349AE20413112E6FA4E89A97EA20A9EEEE64B55D39A2192992A274FC1A836BA3C23A3FEEBBD454D4423643CE80E2A9AC94FA54CA49F",
    );
  });

  it("hashes the utf-8 bytes of a password with accents", () => {
    expect(passwordHash("árvíztűrő tükörfúrógép")).toBe(
      "25BAEE1AA530F222FB3B413797853E2096A0AE0C3D44DD987C92D92F44EB3F45EE455D7F451A1AAC607B16340D88E6F4D6FC0D6D17ED6569883060E8F34CB82A",
    );
  });

  it("returns 128 upper-case hex digits for any password", () => {
    expect(passwordHash("")).toMatch(/^[0-9A-F]{128}$/);
  });
});

describe("requestSignature", () => {
  describe("specification example", () => {
    it("signs both operations of the manageInvoice example", () => {
      expect(
        requestSignature(
          SPEC_EXAMPLE.requestId,
          SPEC_EXAMPLE.timestamp,
          SPEC_EXAMPLE.signingKey,
          SPEC_EXAMPLE.operations,
        ),
      ).toBe(SPEC_EXAMPLE.signature);
    });

    it("signs partial authentication alone without operations", () => {
      // Section 1.5.2 gives no value, so this is SHA3-512 computed with
      // Python's hashlib over the example's partial authentication string.
      expect(
        requestSignature(
          SPEC_EXAMPLE.requestId,
          SPEC_EXAMPLE.timestamp,
          SPEC_EXAMPLE.signingKey,
        ),
      ).toBe(
        "0493F2F0247A2DF076775631FFDFA8B6D39D051F4928D26426CD29895EEDB24960A23E4C6443A54806EA8B0E126A7B97940169FEADE6EE42FC99E3BE6F74AB04",
      );
    });

    it("changes the signature when operations swap order", () => {
      expect(
        requestSignature(
          SPEC_EXAMPLE.requestId,
          SPEC_EXAMPLE.timestamp,
          SPEC_EXAMPLE.signingKey,
          [...SPEC_EXAMPLE.operations].reverse(),
        ),
      ).not.toBe(SPEC_EXAMPLE.signature);
    });
  });

  describe("sample requests", () => {
    it("matches the signature of NAV's tokenExchange sample", () => {
      expect(
        requestSignature(
          "RID896801578348",
          "2019-09-11T10:55:31.440Z",
          SAMPLE_SIGNING_KEY,
        ),
      ).toBe(
        "B4B5E0F197BFFD3DF69BCC98D3BE775F65FD5445EEF95C9D6B6C59425F2B81C4F6DA1FD563B0C7E7D98AF1E1725E5C63C2803B5D3A93D1C02ED354AC92F2CC94",
      );
    });

    it("matches the signature of NAV's manageAnnulment sample", () => {
      expect(
        requestSignature(
          "RID338592103413",
          "2019-09-11T13:37:09.385Z",
          SAMPLE_SIGNING_KEY,
          [{ operation: "ANNUL", data: SAMPLE_ANNULMENT }],
        ),
      ).toBe(
        "96AA3EA7857159C9CC08E418B6A6BA744462C3DBC2D15C4FA82316032934B505D89F1501FD47780FA98E45C6D97C6875912911857223062946261304BC2A9378",
      );
    });
  });

  describe("timestamp mask", () => {
    it("truncates milliseconds instead of rounding them", () => {
      const sign = (timestamp: string) =>
        requestSignature("RID896801578348", timestamp, SAMPLE_SIGNING_KEY);

      expect(sign("2019-09-11T10:55:31.999Z")).toBe(
        sign("2019-09-11T10:55:31.000Z"),
      );

      expect(sign("2019-09-11T10:55:31.999Z")).not.toBe(
        sign("2019-09-11T10:55:32.000Z"),
      );
    });
  });
});

describe("decodeExchangeToken", () => {
  it("decrypts an aes-128-ecb token that openssl encrypted", () => {
    expect(decodeExchangeToken(ENCODED_EXCHANGE_TOKEN, EXCHANGE_KEY)).toBe(
      EXCHANGE_TOKEN,
    );
  });

  it("throws when the exchange key does not fit the token", () => {
    expect(() =>
      decodeExchangeToken(ENCODED_EXCHANGE_TOKEN, "WRONGKEY01234567"),
    ).toThrow();
  });

  it("throws when the exchange key is not 16 utf-8 bytes", () => {
    expect(() =>
      decodeExchangeToken(ENCODED_EXCHANGE_TOKEN, "TSTKEY012345678é"),
    ).toThrow(/key length/i);
  });
});
