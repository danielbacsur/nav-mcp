import type { McpServer, ServerContext } from "@modelcontextprotocol/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { requestSignature } from "./_nav/crypto";
import { registerTools, tools } from "./_tools";

const HEADERS = {
  "X-NAV-Login": "tstuser01abcde",
  "X-NAV-Password": "Tst-Pw-123",
  "X-NAV-Signature-Key": "ac-ac3a-7f661bff7d342N43CYX4U9FG",
  "X-NAV-Exchange-Key": "TSTKEY0123456789",
  "X-NAV-Tax-Number": "11111111-2-42",
};

const ENV = {
  NAV_SOFTWARE_ID: "HU12345678-NAVMCP1",
  NAV_SOFTWARE_DEV_NAME: "Test Developer",
  NAV_SOFTWARE_DEV_CONTACT: "developer@example.com",
};

// Encrypted with `openssl enc -aes-128-ecb -K <hex of X-NAV-Exchange-Key>`.
const EXCHANGE_TOKEN = "b1aca173-d9e8-4561-9237-0511eed99eaa2P0ZHLXBRI2U";
const ENCODED_EXCHANGE_TOKEN =
  "eb7OSZwCZb8FyKoaMeke3ddOe+58NhWQ0XKNuqn4N2SHGdipOH4zIb/mgpWYBesWBbo0Z5EjlYzq/sA1IwjFqA==";

// An InvoiceData document, plain and gzipped by Python's gzip module.
const INVOICE_DATA =
  "PD94bWwgdmVyc2lvbj0iMS4wIiBlbmNvZGluZz0iVVRGLTgiPz48SW52b2ljZURhdGEgeG1sbnM9Imh0dHA6Ly9zY2hlbWFzLm5hdi5nb3YuaHUvT1NBLzMuMC9kYXRhIj48aW52b2ljZU51bWJlcj4wMDA0MjwvaW52b2ljZU51bWJlcj48aW52b2ljZUlzc3VlRGF0ZT4yMDI2LTEwLTAxPC9pbnZvaWNlSXNzdWVEYXRlPjwvSW52b2ljZURhdGE+";
const GZIPPED_INVOICE_DATA =
  "H4sIAAAAAAAA/1WOywrCMBREf6Vk39ybKCKSpggidKML9QNiGppAk0jTBj/fivjazpzDjKjvvi+yGZKLoSKMIilM0LF1oavI5bwv16SWogk5Om12alTFLIRUETuOtw1A0tZ4lWhQmXYxUzvB8bSFBUVoZ5pI4V7uYfJXM0hEXHIB/+GbaVKaniNGcuSrkmGJ7MN+SwE/f+QDA5HPcsMAAAA=";

// Arguments every tool accepts, for the checks that run before NAV is called.
const ARGS: Record<string, Record<string, unknown>> = {
  token_exchange: {},
  manage_invoice: {
    operations: [{ operation: "CREATE", invoiceData: "<InvoiceData/>" }],
  },
  manage_annulment: {
    annulments: [
      { invoiceNumber: "INV-1", code: "ERRATIC_DATA", reason: "Wrong data." },
    ],
  },
  query_transaction_status: { transactionId: "4LOVXPC8P27LKH1V" },
  query_transaction_list: {
    insertedFrom: "2026-10-01T00:00:00Z",
    insertedTo: "2026-10-26T00:00:00Z",
  },
  query_invoice_data: { invoiceNumber: "INV-1", direction: "OUTBOUND" },
  query_invoice_check: { invoiceNumber: "INV-1", direction: "OUTBOUND" },
  query_invoice_digest: {
    direction: "OUTBOUND",
    issueDateFrom: "2026-10-01",
    issueDateTo: "2026-10-26",
  },
  query_invoice_chain_digest: { invoiceNumber: "INV-1", direction: "OUTBOUND" },
  query_taxpayer: {},
  query_service_metrics: {},
};

function tool(name: string) {
  const definition = tools.find((tool) => tool.name === name);

  if (!definition) {
    throw new Error(`There is no ${name} tool.`);
  }

  return definition;
}

// Validates the arguments like the MCP server does before calling a handler.
function call(
  name: string,
  args: Record<string, unknown> = ARGS[name],
  headers: Record<string, string> = HEADERS,
) {
  const { inputSchema, handler } = tool(name);

  const ctx = {
    http: {
      req: new Request("http://localhost:3000/mcp", {
        method: "POST",
        headers,
      }),
    },
  } as ServerContext;

  return handler(inputSchema.parse(args), ctx);
}

function issues(name: string, args: Record<string, unknown>) {
  const result = tool(name).inputSchema.safeParse(args);

  return result.success
    ? []
    : result.error.issues.map((issue) => issue.message);
}

function ok(root: string, ...children: string[]) {
  return [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    `<${root} xmlns="http://schemas.nav.gov.hu/OSA/3.0/api" xmlns:ns2="http://schemas.nav.gov.hu/NTCA/1.0/common">`,
    "<ns2:header><ns2:requestId>RID</ns2:requestId></ns2:header>",
    "<ns2:result><ns2:funcCode>OK</ns2:funcCode></ns2:result>",
    ...children,
    `</${root}>`,
  ].join("");
}

const TOKEN_EXCHANGE = ok(
  "TokenExchangeResponse",
  `<encodedExchangeToken>${ENCODED_EXCHANGE_TOKEN}</encodedExchangeToken>`,
  "<tokenValidityFrom>2026-10-26T10:00:00.000Z</tokenValidityFrom>",
  "<tokenValidityTo>2026-10-26T10:05:00.000Z</tokenValidityTo>",
);

// Answers each NAV operation, named by the last segment of its url, and
// records what was sent.
function stubNav(responses: Record<string, string | Response> = {}) {
  const fetch = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(
    async (url) => {
      const response = responses[url.split("/").pop()!];

      if (response instanceof Response) {
        return response;
      }

      return response === undefined
        ? new Response("", { status: 404, statusText: "Not Found" })
        : new Response(response);
    },
  );

  vi.stubGlobal("fetch", fetch);

  return fetch;
}

// The operation-specific part of a request, between software and the end.
function requestBody(fetch: ReturnType<typeof stubNav>, index = 0) {
  const body = fetch.mock.calls[index][1]?.body as string;

  return body.slice(
    body.indexOf("</software>") + "</software>".length,
    body.lastIndexOf("</"),
  );
}

beforeEach(() => {
  for (const [name, value] of Object.entries(ENV)) {
    vi.stubEnv(name, value);
  }
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("registerTools", () => {
  it("registers one tool per NAV operation with its own config", () => {
    const registerTool = vi.fn();

    registerTools({ registerTool } as unknown as McpServer);

    expect(registerTool.mock.calls.map(([name]) => name)).toEqual([
      "token_exchange",
      "manage_invoice",
      "manage_annulment",
      "query_transaction_status",
      "query_transaction_list",
      "query_invoice_data",
      "query_invoice_check",
      "query_invoice_digest",
      "query_invoice_chain_digest",
      "query_taxpayer",
      "query_service_metrics",
    ]);

    for (const [name, config, handler] of registerTool.mock.calls) {
      expect(config).toEqual({
        title: tool(name).title,
        description: tool(name).description,
        annotations: tool(name).annotations,
        inputSchema: tool(name).inputSchema,
      });

      expect(handler).toBe(tool(name).handler);
    }
  });

  it("marks the query tools read-only and only annulment destructive", () => {
    for (const { name, annotations } of tools) {
      expect(annotations.readOnlyHint).toBe(name.startsWith("query_"));
      expect(annotations.destructiveHint).toBe(name === "manage_annulment");
    }
  });
});

describe("input schemas", () => {
  describe("query_invoice_digest", () => {
    const EXACTLY_ONE =
      "Give exactly one of issueDateFrom and issueDateTo, insertedFrom and insertedTo, or originalInvoiceNumber.";

    const CRITERIA = {
      issueDate: { issueDateFrom: "2026-10-01", issueDateTo: "2026-10-26" },
      inserted: {
        insertedFrom: "2026-10-01T00:00:00Z",
        insertedTo: "2026-10-26T00:00:00+02:00",
      },
      original: { originalInvoiceNumber: "INV-1" },
    };

    it("accepts each of the three search criteria when given alone", () => {
      for (const criterion of Object.values(CRITERIA)) {
        expect(
          issues("query_invoice_digest", {
            direction: "OUTBOUND",
            ...criterion,
          }),
        ).toEqual([]);
      }
    });

    it("rejects a search that gives none of the three search criteria", () => {
      expect(issues("query_invoice_digest", { direction: "OUTBOUND" })).toEqual(
        [EXACTLY_ONE],
      );
    });

    it("rejects a search that combines two of the three search criteria", () => {
      expect(
        issues("query_invoice_digest", {
          direction: "OUTBOUND",
          ...CRITERIA.issueDate,
          ...CRITERIA.original,
        }),
      ).toEqual([EXACTLY_ONE]);
    });

    it("rejects a date range that gives only one end of the window", () => {
      expect(
        issues("query_invoice_digest", {
          direction: "OUTBOUND",
          issueDateFrom: "2026-10-01",
        }),
      ).toEqual([EXACTLY_ONE]);
    });

    it("starts a search at the first page unless asked for another", () => {
      expect(
        tool("query_invoice_digest").inputSchema.parse({
          direction: "INBOUND",
          ...CRITERIA.original,
        }),
      ).toMatchObject({ page: 1 });
    });
  });

  describe("supplierTaxNumber", () => {
    const TOOLS = [
      "query_invoice_data",
      "query_invoice_check",
      "query_invoice_chain_digest",
    ];

    it("accepts a supplier tax number on an inbound invoice lookup", () => {
      for (const name of TOOLS) {
        expect(
          issues(name, {
            invoiceNumber: "INV-1",
            direction: "INBOUND",
            supplierTaxNumber: "12345678",
          }),
        ).toEqual([]);
      }
    });

    it("rejects a supplier tax number on an outbound invoice lookup", () => {
      for (const name of TOOLS) {
        expect(
          issues(name, {
            invoiceNumber: "INV-1",
            direction: "OUTBOUND",
            supplierTaxNumber: "12345678",
          }),
        ).toEqual(["supplierTaxNumber is only allowed with INBOUND."]);
      }
    });

    it("rejects a supplier tax number that is not exactly 8 digits", () => {
      for (const name of TOOLS) {
        expect(
          issues(name, {
            invoiceNumber: "INV-1",
            direction: "INBOUND",
            supplierTaxNumber: "12345678-2-42",
          }),
        ).toHaveLength(1);
      }
    });
  });

  describe("operation limits", () => {
    const OPERATIONS = {
      manage_invoice: (count: number) => ({
        operations: Array.from({ length: count }, () => ({
          operation: "CREATE",
          invoiceData: "<InvoiceData/>",
        })),
      }),
      manage_annulment: (count: number) => ({
        annulments: Array.from({ length: count }, (_, index) => ({
          invoiceNumber: `INV-${index}`,
          code: "ERRATIC_DATA",
          reason: "Wrong data.",
        })),
      }),
    };

    it("accepts between one and a hundred operations in one request", () => {
      for (const [name, args] of Object.entries(OPERATIONS)) {
        expect(issues(name, args(1))).toEqual([]);
        expect(issues(name, args(100))).toEqual([]);
      }
    });

    it("rejects a request with no operations or more than a hundred", () => {
      for (const [name, args] of Object.entries(OPERATIONS)) {
        expect(issues(name, args(0))).toHaveLength(1);
        expect(issues(name, args(101))).toHaveLength(1);
      }
    });
  });

  describe("other lookups", () => {
    it("accepts only transaction ids in the pattern NAV issues them", () => {
      expect(
        issues("query_transaction_status", {
          transactionId: "4LOVXPC8P27LKH1V",
        }),
      ).toEqual([]);

      expect(
        issues("query_transaction_status", { transactionId: "../4LOVX" }),
      ).toHaveLength(1);
    });

    it("looks a taxpayer up only by the first 8 digits of its number", () => {
      expect(issues("query_taxpayer", { taxNumber: "12345678" })).toEqual([]);

      expect(
        issues("query_taxpayer", { taxNumber: "12345678-2-42" }),
      ).toHaveLength(1);
    });
  });
});

describe("request bodies", () => {
  describe("query_invoice_digest", () => {
    it("sends an issue date search with every additional filter", async () => {
      const fetch = stubNav({
        queryInvoiceDigest: ok("QueryInvoiceDigestResponse"),
      });

      await call("query_invoice_digest", {
        direction: "INBOUND",
        page: 2,
        issueDateFrom: "2026-10-01",
        issueDateTo: "2026-10-26",
        partnerTaxNumber: "12345678",
        partnerName: "Kovács & Társa Kft.",
        invoiceCategory: "NORMAL",
        paymentMethod: "TRANSFER",
        invoiceAppearance: "ELECTRONIC",
        source: "XML",
        currency: "HUF",
      });

      expect(requestBody(fetch)).toBe(
        [
          "<page>2</page>",
          "<invoiceDirection>INBOUND</invoiceDirection>",
          "<invoiceQueryParams>",
          "<mandatoryQueryParams><invoiceIssueDate><dateFrom>2026-10-01</dateFrom><dateTo>2026-10-26</dateTo></invoiceIssueDate></mandatoryQueryParams>",
          "<additionalQueryParams>",
          "<taxNumber>12345678</taxNumber>",
          "<name>Kovács &amp; Társa Kft.</name>",
          "<invoiceCategory>NORMAL</invoiceCategory>",
          "<paymentMethod>TRANSFER</paymentMethod>",
          "<invoiceAppearance>ELECTRONIC</invoiceAppearance>",
          "<source>XML</source>",
          "<currency>HUF</currency>",
          "</additionalQueryParams>",
          "</invoiceQueryParams>",
        ].join(""),
      );
    });

    it("sends insertion times converted from their offset to utc", async () => {
      const fetch = stubNav({
        queryInvoiceDigest: ok("QueryInvoiceDigestResponse"),
      });

      await call("query_invoice_digest", {
        direction: "OUTBOUND",
        insertedFrom: "2026-10-01T00:00:00+02:00",
        insertedTo: "2026-10-26T12:30:00Z",
      });

      expect(requestBody(fetch)).toBe(
        [
          "<page>1</page>",
          "<invoiceDirection>OUTBOUND</invoiceDirection>",
          "<invoiceQueryParams>",
          "<mandatoryQueryParams><insDate><dateTimeFrom>2026-09-30T22:00:00.000Z</dateTimeFrom><dateTimeTo>2026-10-26T12:30:00.000Z</dateTimeTo></insDate></mandatoryQueryParams>",
          "</invoiceQueryParams>",
        ].join(""),
      );
    });

    it("sends an original invoice number without additional filters", async () => {
      const fetch = stubNav({
        queryInvoiceDigest: ok("QueryInvoiceDigestResponse"),
      });

      await call("query_invoice_digest", {
        direction: "OUTBOUND",
        originalInvoiceNumber: "INV/2026/<1>",
      });

      expect(requestBody(fetch)).toBe(
        [
          "<page>1</page>",
          "<invoiceDirection>OUTBOUND</invoiceDirection>",
          "<invoiceQueryParams>",
          "<mandatoryQueryParams><originalInvoiceNumber>INV/2026/&lt;1&gt;</originalInvoiceNumber></mandatoryQueryParams>",
          "</invoiceQueryParams>",
        ].join(""),
      );
    });
  });

  describe("invoice number lookups", () => {
    it("sends the batch index and supplier of an inbound invoice", async () => {
      const fetch = stubNav({
        queryInvoiceData: ok("QueryInvoiceDataResponse"),
      });

      await call("query_invoice_data", {
        invoiceNumber: "INV-1",
        direction: "INBOUND",
        batchIndex: 3,
        supplierTaxNumber: "12345678",
      });

      expect(requestBody(fetch)).toBe(
        "<invoiceNumberQuery><invoiceNumber>INV-1</invoiceNumber><invoiceDirection>INBOUND</invoiceDirection><batchIndex>3</batchIndex><supplierTaxNumber>12345678</supplierTaxNumber></invoiceNumberQuery>",
      );
    });

    it("checks an outbound invoice by its number and its direction", async () => {
      const fetch = stubNav({
        queryInvoiceCheck: ok("QueryInvoiceCheckResponse"),
      });

      await call("query_invoice_check", ARGS.query_invoice_check);

      expect(fetch.mock.calls[0][0]).toMatch(/\/queryInvoiceCheck$/);

      expect(requestBody(fetch)).toBe(
        "<invoiceNumberQuery><invoiceNumber>INV-1</invoiceNumber><invoiceDirection>OUTBOUND</invoiceDirection></invoiceNumberQuery>",
      );
    });

    it("sends the page and the supplier of an invoice chain lookup", async () => {
      const fetch = stubNav({
        queryInvoiceChainDigest: ok("QueryInvoiceChainDigestResponse"),
      });

      await call("query_invoice_chain_digest", {
        invoiceNumber: "INV-1",
        direction: "INBOUND",
        page: 2,
        supplierTaxNumber: "12345678",
      });

      expect(requestBody(fetch)).toBe(
        "<page>2</page><invoiceChainQuery><invoiceNumber>INV-1</invoiceNumber><invoiceDirection>INBOUND</invoiceDirection><taxNumber>12345678</taxNumber></invoiceChainQuery>",
      );
    });
  });

  describe("transactions", () => {
    it("lists transactions in a utc window filtered by their status", async () => {
      const fetch = stubNav({
        queryTransactionList: ok("QueryTransactionListResponse"),
      });

      await call("query_transaction_list", {
        insertedFrom: "2026-10-01T00:00:00+02:00",
        insertedTo: "2026-10-26T00:00:00Z",
        requestStatus: "FINISHED",
      });

      expect(requestBody(fetch)).toBe(
        "<page>1</page><insDate><dateTimeFrom>2026-09-30T22:00:00.000Z</dateTimeFrom><dateTimeTo>2026-10-26T00:00:00.000Z</dateTimeTo></insDate><requestStatus>FINISHED</requestStatus>",
      );
    });

    it("asks for a transaction's status without the original request", async () => {
      const fetch = stubNav({
        queryTransactionStatus: ok("QueryTransactionStatusResponse"),
      });

      await call("query_transaction_status", ARGS.query_transaction_status);

      expect(requestBody(fetch)).toBe(
        "<transactionId>4LOVXPC8P27LKH1V</transactionId><returnOriginalRequest>false</returnOriginalRequest>",
      );
    });
  });

  describe("query_taxpayer", () => {
    it("looks up the caller's own taxpayer unless given another one", async () => {
      const fetch = stubNav({ queryTaxpayer: ok("QueryTaxpayerResponse") });

      await call("query_taxpayer", {});
      await call("query_taxpayer", { taxNumber: "87654321" });

      expect(requestBody(fetch, 0)).toBe("<taxNumber>11111111</taxNumber>");
      expect(requestBody(fetch, 1)).toBe("<taxNumber>87654321</taxNumber>");
    });
  });

  describe("submissions", () => {
    it("submits base64 invoice data with a fresh token and signs it", async () => {
      const fetch = stubNav({
        tokenExchange: TOKEN_EXCHANGE,
        manageInvoice: ok("ManageInvoiceResponse"),
      });

      const operations = [
        { operation: "CREATE", invoiceData: "<InvoiceData>á</InvoiceData>" },
        { operation: "STORNO", invoiceData: "<InvoiceData/>" },
      ];

      const data = operations.map(({ operation, invoiceData }) => ({
        operation,
        data: Buffer.from(invoiceData, "utf8").toString("base64"),
      }));

      await call("manage_invoice", { operations });

      expect(fetch.mock.calls.map(([url]) => url.split("/").pop())).toEqual([
        "tokenExchange",
        "manageInvoice",
      ]);

      expect(requestBody(fetch, 1)).toBe(
        [
          `<exchangeToken>${EXCHANGE_TOKEN}</exchangeToken>`,
          "<invoiceOperations>",
          "<compressedContent>false</compressedContent>",
          `<invoiceOperation><index>1</index><invoiceOperation>CREATE</invoiceOperation><invoiceData>${data[0].data}</invoiceData></invoiceOperation>`,
          `<invoiceOperation><index>2</index><invoiceOperation>STORNO</invoiceOperation><invoiceData>${data[1].data}</invoiceData></invoiceOperation>`,
          "</invoiceOperations>",
        ].join(""),
      );

      const body = fetch.mock.calls[1][1]?.body as string;
      const [, requestId] = body.match(/<common:requestId>(.*?)</)!;
      const [, timestamp] = body.match(/<common:timestamp>(.*?)</)!;

      expect(body).toContain(
        `<common:requestSignature cryptoType="SHA3-512">${requestSignature(
          requestId,
          timestamp,
          HEADERS["X-NAV-Signature-Key"],
          data,
        )}</common:requestSignature>`,
      );
    });

    it("submits each annulment as base64 InvoiceAnnulment xml to sign", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2026-10-26T10:00:00.000Z"));

      const fetch = stubNav({
        tokenExchange: TOKEN_EXCHANGE,
        manageAnnulment: ok("ManageAnnulmentResponse"),
      });

      await call("manage_annulment", {
        annulments: [
          {
            invoiceNumber: "INV-1",
            code: "ERRATIC_INVOICE_NUMBER",
            reason: "Számozási hiba & elírás",
          },
        ],
      });

      const [, index, operation, annulment] = requestBody(fetch, 1).match(
        /^<exchangeToken>.*<\/exchangeToken><annulmentOperations><annulmentOperation><index>(.*)<\/index><annulmentOperation>(.*)<\/annulmentOperation><invoiceAnnulment>(.*)<\/invoiceAnnulment><\/annulmentOperation><\/annulmentOperations>$/,
      )!;

      expect([index, operation]).toEqual(["1", "ANNUL"]);

      expect(Buffer.from(annulment, "base64").toString("utf8")).toBe(
        [
          '<?xml version="1.0" encoding="UTF-8"?>',
          '<InvoiceAnnulment xmlns="http://schemas.nav.gov.hu/OSA/3.0/annul">',
          "<annulmentReference>INV-1</annulmentReference>",
          "<annulmentTimestamp>2026-10-26T10:00:00.000Z</annulmentTimestamp>",
          "<annulmentCode>ERRATIC_INVOICE_NUMBER</annulmentCode>",
          "<annulmentReason>Számozási hiba &amp; elírás</annulmentReason>",
          "</InvoiceAnnulment>",
        ].join(""),
      );

      expect(fetch.mock.calls[1][1]?.body).toContain(
        `<common:requestSignature cryptoType="SHA3-512">${requestSignature(
          (fetch.mock.calls[1][1]?.body as string).match(
            /<common:requestId>(.*?)</,
          )![1],
          "2026-10-26T10:00:00.000Z",
          HEADERS["X-NAV-Signature-Key"],
          [{ operation: "ANNUL", data: annulment }],
        )}</common:requestSignature>`,
      );
    });
  });
});

describe("handlers", () => {
  describe("refusals", () => {
    it("refuses every NAV tool without credentials and calls nothing", async () => {
      const fetch = stubNav();

      for (const { name } of tools) {
        if (name === "query_service_metrics") continue;

        expect(await call(name, ARGS[name], {})).toEqual({
          content: [
            {
              type: "text",
              text: "X-NAV-Login is missing or invalid. X-NAV-Signature-Key is missing or invalid. X-NAV-Tax-Number is missing or invalid. Send X-NAV-Password or X-NAV-Password-Hash.",
            },
          ],
          isError: true,
        });
      }

      expect(fetch).not.toHaveBeenCalled();
    });

    it("refuses every NAV tool while the server's software is unset", async () => {
      vi.stubEnv("NAV_SOFTWARE_ID", undefined);

      const fetch = stubNav();

      for (const { name } of tools) {
        if (name === "query_service_metrics") continue;

        expect(await call(name)).toEqual({
          content: [
            {
              type: "text",
              text: "The server is missing or has invalid NAV_SOFTWARE_ID.",
            },
          ],
          isError: true,
        });
      }

      expect(fetch).not.toHaveBeenCalled();
    });

    it("refuses to submit or request a token without an exchange key", async () => {
      const fetch = stubNav();

      const headers = Object.fromEntries(
        Object.entries(HEADERS).filter(
          ([name]) => name !== "X-NAV-Exchange-Key",
        ),
      );

      expect(await call("token_exchange", {}, headers)).toEqual({
        content: [
          { type: "text", text: "Send X-NAV-Exchange-Key to request a token." },
        ],
        isError: true,
      });

      for (const name of ["manage_invoice", "manage_annulment"]) {
        expect(await call(name, ARGS[name], headers)).toEqual({
          content: [
            { type: "text", text: "Send X-NAV-Exchange-Key to submit data." },
          ],
          isError: true,
        });
      }

      expect(fetch).not.toHaveBeenCalled();
    });
  });

  describe("results", () => {
    it("returns NAV's data both as json text and as structured content", async () => {
      stubNav({
        queryTaxpayer: ok(
          "QueryTaxpayerResponse",
          "<taxpayerValidity>true</taxpayerValidity>",
        ),
      });

      expect(await call("query_taxpayer")).toEqual({
        content: [
          {
            type: "text",
            text: JSON.stringify({ taxpayerValidity: "true" }, null, 2),
          },
        ],
        structuredContent: { taxpayerValidity: "true" },
        isError: false,
      });
    });

    it("returns NAV's error as an error result with structured content", async () => {
      stubNav({
        queryTaxpayer: new Response(
          ok("GeneralErrorResponse").replace(
            "<ns2:funcCode>OK</ns2:funcCode>",
            "<ns2:funcCode>ERROR</ns2:funcCode><ns2:errorCode>INVALID_SECURITY_USER</ns2:errorCode><ns2:message>Helytelen authentikáció!</ns2:message>",
          ),
          { status: 401 },
        ),
      });

      const result = await call("query_taxpayer");

      expect(result.isError).toBe(true);

      expect(result.structuredContent).toMatchObject({
        error: {
          httpStatus: 401,
          funcCode: "ERROR",
          errorCode: "INVALID_SECURITY_USER",
          message: "Helytelen authentikáció!",
          requestId: expect.stringMatching(/^[a-zA-Z0-9]{30}$/),
        },
      });
    });

    it("returns only the token's validity, never the decoded token", async () => {
      stubNav({ tokenExchange: TOKEN_EXCHANGE });

      const result = await call("token_exchange");

      expect(result.structuredContent).toEqual({
        tokenValidityFrom: "2026-10-26T10:00:00.000Z",
        tokenValidityTo: "2026-10-26T10:05:00.000Z",
      });

      expect(JSON.stringify(result)).not.toContain(EXCHANGE_TOKEN);
      expect(JSON.stringify(result)).not.toContain(ENCODED_EXCHANGE_TOKEN);
    });

    it("returns the transaction id that NAV assigns to a submission", async () => {
      stubNav({
        tokenExchange: TOKEN_EXCHANGE,
        manageInvoice: ok(
          "ManageInvoiceResponse",
          "<transactionId>4LOVXPC8P27LKH1V</transactionId>",
        ),
      });

      expect(await call("manage_invoice")).toMatchObject({
        structuredContent: { transactionId: "4LOVXPC8P27LKH1V" },
        isError: false,
      });
    });

    it("stops a submission when NAV refuses to issue it a token", async () => {
      const fetch = stubNav({
        tokenExchange: new Response("", {
          status: 503,
          statusText: "Service Unavailable",
        }),
      });

      expect(await call("manage_annulment")).toMatchObject({
        structuredContent: {
          error: { httpStatus: 503, message: "Service Unavailable" },
        },
        isError: true,
      });

      expect(fetch).toHaveBeenCalledTimes(1);
    });

    it("decodes the invoice data, whether it was gzipped or not", async () => {
      for (const [invoiceData, compressed] of [
        [INVOICE_DATA, "false"],
        [GZIPPED_INVOICE_DATA, "true"],
      ]) {
        stubNav({
          queryInvoiceData: ok(
            "QueryInvoiceDataResponse",
            "<invoiceDataResult>",
            `<invoiceData>${invoiceData}</invoiceData>`,
            `<compressedContentIndicator>${compressed}</compressedContentIndicator>`,
            "</invoiceDataResult>",
          ),
        });

        expect((await call("query_invoice_data")).structuredContent).toEqual({
          invoiceDataResult: {
            invoiceData: {
              invoiceNumber: "00042",
              invoiceIssueDate: "2026-10-01",
            },
            compressedContentIndicator: compressed,
          },
        });
      }
    });

    it("decodes the original request of every processed invoice", async () => {
      stubNav({
        queryTransactionStatus: ok(
          "QueryTransactionStatusResponse",
          "<processingResults>",
          "<processingResult><index>1</index><invoiceStatus>DONE</invoiceStatus>",
          "<compressedContentIndicator>false</compressedContentIndicator>",
          `<originalRequest>${INVOICE_DATA}</originalRequest>`,
          "</processingResult>",
          "<processingResult><index>2</index><invoiceStatus>DONE</invoiceStatus>",
          "<compressedContentIndicator>true</compressedContentIndicator>",
          `<originalRequest>${GZIPPED_INVOICE_DATA}</originalRequest>`,
          "</processingResult>",
          "<processingResult><index>3</index><invoiceStatus>ABORTED</invoiceStatus></processingResult>",
          "</processingResults>",
        ),
      });

      const invoice = {
        invoiceNumber: "00042",
        invoiceIssueDate: "2026-10-01",
      };

      expect(
        (
          await call("query_transaction_status", {
            transactionId: "4LOVXPC8P27LKH1V",
            returnOriginalRequest: true,
          })
        ).structuredContent,
      ).toEqual({
        processingResults: {
          processingResult: [
            {
              index: "1",
              invoiceStatus: "DONE",
              compressedContentIndicator: "false",
              originalRequest: invoice,
            },
            {
              index: "2",
              invoiceStatus: "DONE",
              compressedContentIndicator: "true",
              originalRequest: invoice,
            },
            { index: "3", invoiceStatus: "ABORTED" },
          ],
        },
      });
    });

    it("gets service metrics without credentials from the asked host", async () => {
      vi.stubEnv("NAV_SOFTWARE_ID", undefined);

      const fetch = stubNav({
        metric: ok("QueryServiceMetricsResponse", "<metric></metric>"),
      });

      expect(
        await call("query_service_metrics", {}, { "X-NAV-Env": "production" }),
      ).toMatchObject({ structuredContent: { metric: [""] }, isError: false });

      expect(fetch.mock.calls[0][0]).toBe(
        "https://api.onlineszamla.nav.gov.hu/metricService/v3/queryServiceMetrics/metric",
      );
    });
  });
});
