import { gzipSync } from "node:zlib";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  callNav,
  decodeInvoiceData,
  element,
  escapeXml,
  getServiceMetrics,
  requestExchangeToken,
} from "./client";
import type { NavCredentials } from "./credentials";
import { createRequestId } from "./crypto";
import type { NavSoftware } from "./software";

vi.mock("./crypto", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./crypto")>()),
  createRequestId: vi.fn(),
}));

// The technical user of NAV's sample requests (nav-gov-hu/Online-Invoice,
// sample/API sample), whose signing key sits in a comment beside each one.
const CREDENTIALS: NavCredentials = {
  login: "lwilsmn0uqdxe6u",
  passwordHash:
    "2F43840A882CFDB7DB0FEC07D419D030D864B47B6B541DC280EF81B937B7A176E33C052B0D26638CC18A7A2C08D8D311733078A774BF43F6CA57FE8CD74DC28E",
  signingKey: "ac-ac3a-7f661bff7d342N43CYX4U9FG",
  exchangeKey: "TSTKEY0123456789",
  taxNumber: "11111111",
  env: "test",
};

const SOFTWARE: NavSoftware = {
  softwareId: "HU12345678-NAVMCP1",
  softwareName: "nav-mcp",
  softwareOperation: "ONLINE_SERVICE",
  softwareMainVersion: "0.0.0",
  softwareDevName: "Kovács & Társa",
  softwareDevContact: "developer@example.com",
};

// Encrypted with `openssl enc -aes-128-ecb -K <hex of the exchange key>`.
const EXCHANGE_TOKEN = "b1aca173-d9e8-4561-9237-0511eed99eaa2P0ZHLXBRI2U";
const ENCODED_EXCHANGE_TOKEN =
  "eb7OSZwCZb8FyKoaMeke3ddOe+58NhWQ0XKNuqn4N2SHGdipOH4zIb/mgpWYBesWBbo0Z5EjlYzq/sA1IwjFqA==";

// An InvoiceData document, plain and gzipped by Python's gzip module.
const INVOICE_DATA =
  "PD94bWwgdmVyc2lvbj0iMS4wIiBlbmNvZGluZz0iVVRGLTgiPz48SW52b2ljZURhdGEgeG1sbnM9Imh0dHA6Ly9zY2hlbWFzLm5hdi5nb3YuaHUvT1NBLzMuMC9kYXRhIj48aW52b2ljZU51bWJlcj4wMDA0MjwvaW52b2ljZU51bWJlcj48aW52b2ljZUlzc3VlRGF0ZT4yMDI2LTEwLTAxPC9pbnZvaWNlSXNzdWVEYXRlPjwvSW52b2ljZURhdGE+";
const GZIPPED_INVOICE_DATA =
  "H4sIAAAAAAAA/1WOywrCMBREf6Vk39ybKCKSpggidKML9QNiGppAk0jTBj/fivjazpzDjKjvvi+yGZKLoSKMIilM0LF1oavI5bwv16SWogk5Om12alTFLIRUETuOtw1A0tZ4lWhQmXYxUzvB8bSFBUVoZ5pI4V7uYfJXM0hEXHIB/+GbaVKaniNGcuSrkmGJ7MN+SwE/f+QDA5HPcsMAAAA=";

// NAV answers with the common namespace as ns2 and the api one as default.
function response(root: string, ...children: string[]) {
  return [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    `<${root} xmlns="http://schemas.nav.gov.hu/OSA/3.0/api" xmlns:ns2="http://schemas.nav.gov.hu/NTCA/1.0/common">`,
    "<ns2:header><ns2:requestId>RID896801578348</ns2:requestId></ns2:header>",
    ...children,
    `</${root}>`,
  ].join("");
}

function result(funcCode: string, errorCode?: string, message?: string) {
  return [
    "<ns2:result>",
    `<ns2:funcCode>${funcCode}</ns2:funcCode>`,
    errorCode && `<ns2:errorCode>${errorCode}</ns2:errorCode>`,
    message && `<ns2:message>${message}</ns2:message>`,
    "</ns2:result>",
  ].join("");
}

const SOFTWARE_ECHO =
  "<software><softwareId>HU12345678-NAVMCP1</softwareId></software>";

function stubFetch(body: string, init?: ResponseInit) {
  const fetch = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(
    async () => new Response(body, init),
  );

  vi.stubGlobal("fetch", fetch);

  return fetch;
}

beforeEach(() => {
  vi.mocked(createRequestId).mockReturnValue("RID896801578348");
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("escapeXml", () => {
  it("escapes the five characters xml treats as markup", () => {
    expect(escapeXml(`<a href="x">Tom & Jerry's</a>`)).toBe(
      "&lt;a href=&quot;x&quot;&gt;Tom &amp; Jerry&apos;s&lt;/a&gt;",
    );
  });

  it("escapes an existing entity again to keep it as text", () => {
    expect(escapeXml("&lt;")).toBe("&amp;lt;");
  });

  it("leaves accented letters and other text unchanged", () => {
    expect(escapeXml("Árvíztűrő Kft. 1/2")).toBe("Árvíztűrő Kft. 1/2");
  });
});

describe("element", () => {
  it("wraps an escaped value in opening and closing tags", () => {
    expect(element("name", "A & B")).toBe("<name>A &amp; B</name>");
  });

  it("omits the whole tag when the value is undefined", () => {
    expect(element("name", undefined)).toBe("");
  });

  it("keeps an empty string as an empty element, not none", () => {
    expect(element("name", "")).toBe("<name></name>");
  });
});

describe("callNav", () => {
  describe("request envelope", () => {
    it("matches the header and user of NAV's sample request", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2019-09-11T10:55:31.440Z"));

      const fetch = stubFetch(response("TokenExchangeResponse", result("OK")));

      await callNav("tokenExchange", CREDENTIALS, SOFTWARE, "");

      expect(fetch.mock.calls[0][1]?.body).toBe(
        [
          '<?xml version="1.0" encoding="UTF-8"?>',
          '<TokenExchangeRequest xmlns="http://schemas.nav.gov.hu/OSA/3.0/api" xmlns:common="http://schemas.nav.gov.hu/NTCA/1.0/common">',
          "<common:header>",
          "<common:requestId>RID896801578348</common:requestId>",
          "<common:timestamp>2019-09-11T10:55:31.440Z</common:timestamp>",
          "<common:requestVersion>3.0</common:requestVersion>",
          "<common:headerVersion>1.0</common:headerVersion>",
          "</common:header>",
          "<common:user>",
          "<common:login>lwilsmn0uqdxe6u</common:login>",
          '<common:passwordHash cryptoType="SHA-512">2F43840A882CFDB7DB0FEC07D419D030D864B47B6B541DC280EF81B937B7A176E33C052B0D26638CC18A7A2C08D8D311733078A774BF43F6CA57FE8CD74DC28E</common:passwordHash>',
          "<common:taxNumber>11111111</common:taxNumber>",
          '<common:requestSignature cryptoType="SHA3-512">B4B5E0F197BFFD3DF69BCC98D3BE775F65FD5445EEF95C9D6B6C59425F2B81C4F6DA1FD563B0C7E7D98AF1E1725E5C63C2803B5D3A93D1C02ED354AC92F2CC94</common:requestSignature>',
          "</common:user>",
          "<software>",
          "<softwareId>HU12345678-NAVMCP1</softwareId>",
          "<softwareName>nav-mcp</softwareName>",
          "<softwareOperation>ONLINE_SERVICE</softwareOperation>",
          "<softwareMainVersion>0.0.0</softwareMainVersion>",
          "<softwareDevName>Kovács &amp; Társa</softwareDevName>",
          "<softwareDevContact>developer@example.com</softwareDevContact>",
          "</software>",
          "</TokenExchangeRequest>",
        ].join(""),
      );
    });

    it("signs operations like NAV's manageAnnulment sample", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2019-09-11T13:37:09.385Z"));
      vi.mocked(createRequestId).mockReturnValue("RID338592103413");

      const fetch = stubFetch(
        response("ManageAnnulmentResponse", result("OK")),
      );

      // The base64 text is all that is signed, so a stand-in body will do.
      await callNav("manageAnnulment", CREDENTIALS, SOFTWARE, "<body/>", [
        {
          operation: "ANNUL",
          data: "PD94bWwgdmVyc2lvbj0iMS4wIiBlbmNvZGluZz0iVVRGLTgiIHN0YW5kYWxvbmU9InllcyI/Pgo8SW52b2ljZUFubnVsbWVudCB4bWxucz0iaHR0cDovL3NjaGVtYXMubmF2Lmdvdi5odS9PU0EvMy4wL2FubnVsIj4KCQk8YW5udWxtZW50UmVmZXJlbmNlPjIyMjIyMjIyPC9hbm51bG1lbnRSZWZlcmVuY2U+CgkJPGFubnVsbWVudFRpbWVzdGFtcD4yMDE4LTA2LTE4VDA5OjEwOjQ1LjMwOVo8L2FubnVsbWVudFRpbWVzdGFtcD4KCQk8YW5udWxtZW50Q29kZT5FUlJBVElDX0RBVEE8L2FubnVsbWVudENvZGU+CgkJPGFubnVsbWVudFJlYXNvbj5jcmVhdGUgc3phbWxhIGFubnVsPC9hbm51bG1lbnRSZWFzb24+CjwvSW52b2ljZUFubnVsbWVudD4=",
        },
      ]);

      const body = fetch.mock.calls[0][1]?.body as string;

      expect(body).toContain(
        '<common:requestSignature cryptoType="SHA3-512">96AA3EA7857159C9CC08E418B6A6BA744462C3DBC2D15C4FA82316032934B505D89F1501FD47780FA98E45C6D97C6875912911857223062946261304BC2A9378</common:requestSignature>',
      );

      expect(body).toMatch(/^<\?xml .*<ManageAnnulmentRequest /);
      expect(body).toMatch(/<\/software><body\/><\/ManageAnnulmentRequest>$/);
    });

    it("sends the software block's optional developer fields", async () => {
      const fetch = stubFetch(response("QueryTaxpayerResponse", result("OK")));

      await callNav(
        "queryTaxpayer",
        CREDENTIALS,
        {
          ...SOFTWARE,
          softwareDevCountryCode: "HU",
          softwareDevTaxNumber: "12345678",
        },
        "",
      );

      expect(fetch.mock.calls[0][1]?.body).toContain(
        "<softwareDevContact>developer@example.com</softwareDevContact><softwareDevCountryCode>HU</softwareDevCountryCode><softwareDevTaxNumber>12345678</softwareDevTaxNumber></software>",
      );
    });

    it("posts xml to the operation's test url with a timeout", async () => {
      const fetch = stubFetch(response("QueryTaxpayerResponse", result("OK")));

      await callNav("queryTaxpayer", CREDENTIALS, SOFTWARE, "");

      const [url, init] = fetch.mock.calls[0];

      expect(url).toBe(
        "https://api-test.onlineszamla.nav.gov.hu/invoiceService/v3/queryTaxpayer",
      );

      expect(init).toMatchObject({
        method: "POST",
        headers: {
          "content-type": "application/xml;charset=UTF-8",
          accept: "application/xml",
        },
      });

      expect(init?.signal).toBeInstanceOf(AbortSignal);
    });

    it("posts to the production host when the caller asks", async () => {
      const fetch = stubFetch(response("QueryTaxpayerResponse", result("OK")));

      await callNav(
        "queryTaxpayer",
        { ...CREDENTIALS, env: "production" },
        SOFTWARE,
        "",
      );

      expect(fetch.mock.calls[0][0]).toBe(
        "https://api.onlineszamla.nav.gov.hu/invoiceService/v3/queryTaxpayer",
      );
    });
  });

  describe("successful responses", () => {
    it("returns the body without header, result and software", async () => {
      stubFetch(
        response(
          "QueryTaxpayerResponse",
          result("OK"),
          SOFTWARE_ECHO,
          "<infoDate>2026-10-26T10:00:00.000Z</infoDate>",
          "<taxpayerValidity>true</taxpayerValidity>",
        ),
      );

      expect(await callNav("queryTaxpayer", CREDENTIALS, SOFTWARE, "")).toEqual(
        {
          ok: true,
          data: {
            infoDate: "2026-10-26T10:00:00.000Z",
            taxpayerValidity: "true",
          },
        },
      );
    });

    it("keeps numbers and leading zeros as NAV's strings", async () => {
      stubFetch(
        response(
          "QueryInvoiceDigestResponse",
          result("OK"),
          "<invoiceDigestResult>",
          "<currentPage>1</currentPage>",
          "<invoiceDigest>",
          "<invoiceNumber>0001234</invoiceNumber>",
          "<supplierTaxNumber>01234567</supplierTaxNumber>",
          "<invoiceNetAmount>1000.50</invoiceNetAmount>",
          "</invoiceDigest>",
          "</invoiceDigestResult>",
        ),
      );

      expect(
        await callNav("queryInvoiceDigest", CREDENTIALS, SOFTWARE, ""),
      ).toEqual({
        ok: true,
        data: {
          invoiceDigestResult: {
            currentPage: "1",
            invoiceDigest: [
              {
                invoiceNumber: "0001234",
                supplierTaxNumber: "01234567",
                invoiceNetAmount: "1000.50",
              },
            ],
          },
        },
      });
    });

    it("returns a repeatable element as an array when alone", async () => {
      stubFetch(
        response(
          "QueryTransactionStatusResponse",
          result("OK"),
          "<processingResults>",
          "<processingResult>",
          "<index>1</index>",
          "<technicalValidationMessages><ns2:message>a</ns2:message></technicalValidationMessages>",
          "<businessValidationMessages><message>b</message></businessValidationMessages>",
          "</processingResult>",
          "</processingResults>",
        ),
      );

      expect(
        await callNav("queryTransactionStatus", CREDENTIALS, SOFTWARE, ""),
      ).toEqual({
        ok: true,
        data: {
          processingResults: {
            processingResult: [
              {
                index: "1",
                technicalValidationMessages: [{ message: "a" }],
                businessValidationMessages: [{ message: "b" }],
              },
            ],
          },
        },
      });
    });

    it("strips any namespace prefix NAV puts on an element", async () => {
      stubFetch(
        [
          '<?xml version="1.0" encoding="UTF-8"?>',
          '<ns3:QueryTaxpayerResponse xmlns:ns2="common" xmlns:ns3="api" xmlns:ns4="base">',
          "<ns2:result><ns2:funcCode>OK</ns2:funcCode></ns2:result>",
          "<ns3:taxpayerData><ns3:taxpayerAddressList>",
          "<ns3:taxpayerAddressItem><ns4:postalCode>1011</ns4:postalCode></ns3:taxpayerAddressItem>",
          "</ns3:taxpayerAddressList></ns3:taxpayerData>",
          "</ns3:QueryTaxpayerResponse>",
        ].join(""),
      );

      expect(await callNav("queryTaxpayer", CREDENTIALS, SOFTWARE, "")).toEqual(
        {
          ok: true,
          data: {
            taxpayerData: {
              taxpayerAddressList: {
                taxpayerAddressItem: [{ postalCode: "1011" }],
              },
            },
          },
        },
      );
    });
  });

  describe("failed responses", () => {
    it("reports a GeneralErrorResponse with its messages", async () => {
      stubFetch(
        response(
          "GeneralErrorResponse",
          result("ERROR", "INVALID_REQUEST_SIGNATURE", "Helytelen aláírás!"),
          SOFTWARE_ECHO,
          "<technicalValidationMessages>",
          "<ns2:validationResultCode>ERROR</ns2:validationResultCode>",
          "<ns2:validationErrorCode>SCHEMA_VIOLATION</ns2:validationErrorCode>",
          "</technicalValidationMessages>",
        ),
        { status: 400 },
      );

      expect(await callNav("queryTaxpayer", CREDENTIALS, SOFTWARE, "")).toEqual(
        {
          ok: false,
          error: {
            httpStatus: 400,
            funcCode: "ERROR",
            errorCode: "INVALID_REQUEST_SIGNATURE",
            message: "Helytelen aláírás!",
            technicalValidationMessages: [
              {
                validationResultCode: "ERROR",
                validationErrorCode: "SCHEMA_VIOLATION",
              },
            ],
            requestId: "RID896801578348",
          },
        },
      );
    });

    it("reads the root fields of a GeneralExceptionResponse", async () => {
      stubFetch(
        [
          '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
          '<GeneralExceptionResponse xmlns="http://schemas.nav.gov.hu/OSA/3.0/api" xmlns:ns2="http://schemas.nav.gov.hu/NTCA/1.0/common">',
          "<ns2:funcCode>ERROR</ns2:funcCode>",
          "<ns2:errorCode>INVALID_REQUEST</ns2:errorCode>",
          "<ns2:message>Helytelen kérés!</ns2:message>",
          "</GeneralExceptionResponse>",
        ].join(""),
        { status: 400 },
      );

      expect(
        await callNav("queryTaxpayer", CREDENTIALS, SOFTWARE, ""),
      ).toMatchObject({
        ok: false,
        error: {
          httpStatus: 400,
          funcCode: "ERROR",
          errorCode: "INVALID_REQUEST",
          message: "Helytelen kérés!",
        },
      });
    });

    it("treats an OK saying the endpoint is down as failure", async () => {
      stubFetch(
        [
          '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
          '<GeneralExceptionResponse xmlns="http://schemas.nav.gov.hu/OSA/3.0/api" xmlns:ns2="http://schemas.nav.gov.hu/NTCA/1.0/common">',
          "<ns2:funcCode>OK</ns2:funcCode>",
          "<ns2:message>The endpoint is currently down for maintenance.</ns2:message>",
          "</GeneralExceptionResponse>",
        ].join(""),
      );

      expect(await callNav("queryTaxpayer", CREDENTIALS, SOFTWARE, "")).toEqual(
        {
          ok: false,
          error: {
            httpStatus: 200,
            funcCode: "OK",
            message: "The endpoint is currently down for maintenance.",
            requestId: "RID896801578348",
          },
        },
      );
    });

    it("fails on an http error even when funcCode says OK", async () => {
      stubFetch(response("QueryTaxpayerResponse", result("OK")), {
        status: 500,
      });

      expect(
        await callNav("queryTaxpayer", CREDENTIALS, SOFTWARE, ""),
      ).toMatchObject({
        ok: false,
        error: { httpStatus: 500, funcCode: "OK" },
      });
    });

    it("fails on funcCode ERROR even when http status is 200", async () => {
      stubFetch(
        response(
          "QueryTaxpayerResponse",
          result("ERROR", "INVALID_REQUEST", "Helytelen kérés!"),
        ),
      );

      expect(await callNav("queryTaxpayer", CREDENTIALS, SOFTWARE, "")).toEqual(
        {
          ok: false,
          error: {
            httpStatus: 200,
            funcCode: "ERROR",
            errorCode: "INVALID_REQUEST",
            message: "Helytelen kérés!",
            requestId: "RID896801578348",
          },
        },
      );
    });

    it("fails on a non-xml body even when http status is 200", async () => {
      stubFetch("Service temporarily unavailable");

      expect(await callNav("queryTaxpayer", CREDENTIALS, SOFTWARE, "")).toEqual(
        {
          ok: false,
          error: {
            httpStatus: 200,
            message: "Service temporarily unavailable",
            requestId: "RID896801578348",
          },
        },
      );
    });

    it("quotes the first 200 characters of a non-xml body", async () => {
      stubFetch(`upstream connect error ${"x".repeat(300)}`, {
        status: 502,
      });

      const result = await callNav("queryTaxpayer", CREDENTIALS, SOFTWARE, "");

      expect(result).toEqual({
        ok: false,
        error: {
          httpStatus: 502,
          message: `upstream connect error ${"x".repeat(177)}`,
          requestId: "RID896801578348",
        },
      });
    });

    it("uses the status text when the error body is empty", async () => {
      stubFetch("", { status: 503, statusText: "Service Unavailable" });

      expect(
        await callNav("queryTaxpayer", CREDENTIALS, SOFTWARE, ""),
      ).toMatchObject({
        ok: false,
        error: { httpStatus: 503, message: "Service Unavailable" },
      });
    });

    it("reports a network failure as status 0 with the cause", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => {
          throw new TypeError("fetch failed");
        }),
      );

      expect(await callNav("queryTaxpayer", CREDENTIALS, SOFTWARE, "")).toEqual(
        {
          ok: false,
          error: {
            httpStatus: 0,
            message: "fetch failed",
            requestId: "RID896801578348",
          },
        },
      );
    });
  });

  describe("timeout", () => {
    it("gives up after 55 seconds, before NAV gives up at 60", async () => {
      vi.useFakeTimers();

      const timeout = vi
        .spyOn(AbortSignal, "timeout")
        .mockImplementation((ms) => {
          const controller = new AbortController();

          setTimeout(
            () =>
              controller.abort(
                new DOMException(
                  "The operation was aborted due to timeout",
                  "TimeoutError",
                ),
              ),
            ms,
          );

          return controller.signal;
        });

      // Like fetch, rejects with the signal's reason once it aborts.
      vi.stubGlobal(
        "fetch",
        vi.fn(
          (_url: string, init: RequestInit) =>
            new Promise<Response>((_resolve, reject) => {
              init.signal?.addEventListener("abort", () =>
                reject(init.signal?.reason),
              );
            }),
        ),
      );

      let settled = false;

      const pending = callNav("queryTaxpayer", CREDENTIALS, SOFTWARE, "").then(
        (result) => {
          settled = true;
          return result;
        },
      );

      await vi.advanceTimersByTimeAsync(54_999);

      expect(settled).toBe(false);

      await vi.advanceTimersByTimeAsync(1);

      expect(await pending).toEqual({
        ok: false,
        error: {
          httpStatus: 0,
          message: "The operation was aborted due to timeout",
          requestId: "RID896801578348",
        },
      });

      expect(timeout).toHaveBeenCalledWith(55_000);
    });
  });
});

describe("requestExchangeToken", () => {
  it("decodes the token and keeps its validity window", async () => {
    const fetch = stubFetch(
      response(
        "TokenExchangeResponse",
        result("OK"),
        SOFTWARE_ECHO,
        `<encodedExchangeToken>${ENCODED_EXCHANGE_TOKEN}</encodedExchangeToken>`,
        "<tokenValidityFrom>2026-10-26T10:00:00.000Z</tokenValidityFrom>",
        "<tokenValidityTo>2026-10-26T10:05:00.000Z</tokenValidityTo>",
      ),
    );

    expect(
      await requestExchangeToken(CREDENTIALS, SOFTWARE, "TSTKEY0123456789"),
    ).toEqual({
      ok: true,
      token: EXCHANGE_TOKEN,
      validFrom: "2026-10-26T10:00:00.000Z",
      validTo: "2026-10-26T10:05:00.000Z",
    });

    expect(fetch.mock.calls[0][0]).toBe(
      "https://api-test.onlineszamla.nav.gov.hu/invoiceService/v3/tokenExchange",
    );

    expect(fetch.mock.calls[0][1]?.body).toMatch(
      /<\/software><\/TokenExchangeRequest>$/,
    );
  });

  it("blames the exchange key when the token won't decode", async () => {
    stubFetch(
      response(
        "TokenExchangeResponse",
        result("OK"),
        `<encodedExchangeToken>${ENCODED_EXCHANGE_TOKEN}</encodedExchangeToken>`,
      ),
    );

    expect(
      await requestExchangeToken(CREDENTIALS, SOFTWARE, "WRONGKEY01234567"),
    ).toEqual({
      ok: false,
      error: {
        httpStatus: 200,
        message: "X-NAV-Exchange-Key could not decode the exchange token.",
      },
    });
  });

  it("passes NAV's error through when it refuses a token", async () => {
    stubFetch(
      response(
        "GeneralErrorResponse",
        result("ERROR", "INVALID_SECURITY_USER", "Helytelen authentikáció!"),
      ),
      { status: 401 },
    );

    expect(
      await requestExchangeToken(CREDENTIALS, SOFTWARE, "TSTKEY0123456789"),
    ).toMatchObject({
      ok: false,
      error: { httpStatus: 401, errorCode: "INVALID_SECURITY_USER" },
    });
  });
});

describe("getServiceMetrics", () => {
  const METRICS = response(
    "QueryServiceMetricsResponse",
    result("OK"),
    "<metricsLastUpdateTime>2026-10-26T10:00:00.000Z</metricsLastUpdateTime>",
    "<metric>",
    "<metricDefinition>",
    "<metricName>INVOICE_SERVICE_CALL</metricName>",
    "<metricType>COUNTER</metricType>",
    "<metricDescription><language>EN</language><localizedDescription>Calls</localizedDescription></metricDescription>",
    "</metricDefinition>",
    "<metricValues><value>042</value><timestamp>2026-10-26T09:59:00.000Z</timestamp></metricValues>",
    "</metric>",
  );

  it("gets every metric from NAV's public test service", async () => {
    const fetch = stubFetch(METRICS);

    expect(await getServiceMetrics("test")).toEqual({
      ok: true,
      data: {
        metricsLastUpdateTime: "2026-10-26T10:00:00.000Z",
        metric: [
          {
            metricDefinition: {
              metricName: "INVOICE_SERVICE_CALL",
              metricType: "COUNTER",
              metricDescription: [
                { language: "EN", localizedDescription: "Calls" },
              ],
            },
            metricValues: [
              { value: "042", timestamp: "2026-10-26T09:59:00.000Z" },
            ],
          },
        ],
      },
    });

    const [url, init] = fetch.mock.calls[0];

    expect(url).toBe(
      "https://api-test.onlineszamla.nav.gov.hu/metricService/v3/queryServiceMetrics/metric",
    );

    expect(init?.method).toBeUndefined();
    expect(init?.headers).toEqual({ accept: "application/xml" });
  });

  it("gets one metric by url-encoded name in production", async () => {
    const fetch = stubFetch(METRICS);

    await getServiceMetrics("production", "INVOICE/SERVICE CALL");

    expect(fetch.mock.calls[0][0]).toBe(
      "https://api.onlineszamla.nav.gov.hu/metricService/v3/queryServiceMetrics/metric/INVOICE%2FSERVICE%20CALL",
    );
  });

  it("reports NAV's 404 for a metric name it does not know", async () => {
    stubFetch("", { status: 404, statusText: "Not Found" });

    expect(await getServiceMetrics("test", "NO_SUCH_METRIC")).toEqual({
      ok: false,
      error: { httpStatus: 404, message: "Not Found" },
    });
  });
});

describe("decodeInvoiceData", () => {
  it("parses plain base64 invoice data into its fields", () => {
    expect(decodeInvoiceData(INVOICE_DATA, false)).toEqual({
      invoiceNumber: "00042",
      invoiceIssueDate: "2026-10-01",
    });
  });

  it("gunzips invoice data that the submitter compressed", () => {
    expect(decodeInvoiceData(GZIPPED_INVOICE_DATA, true)).toEqual({
      invoiceNumber: "00042",
      invoiceIssueDate: "2026-10-01",
    });
  });

  it("keeps a single invoice line as an array of lines", () => {
    const xml = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<InvoiceData xmlns="http://schemas.nav.gov.hu/OSA/3.0/data" xmlns:base="http://schemas.nav.gov.hu/OSA/3.0/base">',
      "<invoiceMain><invoice><invoiceLines>",
      "<line><lineNumber>1</lineNumber><productCodes><productCode><base:productCodeValue>0100</base:productCodeValue></productCode></productCodes></line>",
      "</invoiceLines></invoice></invoiceMain>",
      "</InvoiceData>",
    ].join("");

    expect(decodeInvoiceData(gzipSync(xml).toString("base64"), true)).toEqual({
      invoiceMain: {
        invoice: {
          invoiceLines: {
            line: [
              {
                lineNumber: "1",
                productCodes: { productCode: [{ productCodeValue: "0100" }] },
              },
            ],
          },
        },
      },
    });
  });

  it("throws when data marked as compressed is not gzip", () => {
    expect(() => decodeInvoiceData(INVOICE_DATA, true)).toThrow();
  });
});
