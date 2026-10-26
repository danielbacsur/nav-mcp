import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { POST } from "./route";

const HEADERS = {
  "X-NAV-Login": "tstuser01abcde",
  "X-NAV-Password": "Tst-Pw-123",
  "X-NAV-Signature-Key": "ac-ac3a-7f661bff7d342N43CYX4U9FG",
  "X-NAV-Tax-Number": "11111111",
};

// The optional vars are unset so a developer's own values can't leak in.
const ENV = {
  NAV_SOFTWARE_ID: "HU12345678-NAVMCP1",
  NAV_SOFTWARE_DEV_NAME: "Test Developer",
  NAV_SOFTWARE_DEV_CONTACT: "developer@example.com",
  NAV_SOFTWARE_DEV_COUNTRY_CODE: undefined,
  NAV_SOFTWARE_DEV_TAX_NUMBER: undefined,
};

// A 2025-era Streamable HTTP request, which the handler serves statelessly.
function rpc(
  method: string,
  params: Record<string, unknown>,
  headers: Record<string, string> = {},
) {
  return POST(
    new Request("http://localhost:3000/mcp", {
      method: "POST",
      headers: {
        host: "localhost:3000",
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": "2025-06-18",
        ...HEADERS,
        ...headers,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    }),
  );
}

// The answer arrives as a single server-sent event.
async function message(response: Response) {
  const [, data] = (await response.text()).match(/^data: (.*)$/m)!;

  return JSON.parse(data);
}

function stubFetch(body: string) {
  const fetch = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(
    async () => new Response(body),
  );

  vi.stubGlobal("fetch", fetch);

  return fetch;
}

beforeEach(() => {
  for (const [name, value] of Object.entries(ENV)) {
    vi.stubEnv(name, value);
  }
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("POST", () => {
  describe("mcp requests", () => {
    it("lists every tool with a schema a client can read", async () => {
      const { result } = await message(await rpc("tools/list", {}));

      expect(result.tools).toHaveLength(11);

      for (const tool of result.tools) {
        expect(tool.inputSchema).toMatchObject({ type: "object" });
      }
    });

    it("calls NAV as the technical user the headers name", async () => {
      const fetch = stubFetch(
        [
          '<?xml version="1.0" encoding="UTF-8"?>',
          "<QueryTaxpayerResponse>",
          "<result><funcCode>OK</funcCode></result>",
          "<taxpayerValidity>true</taxpayerValidity>",
          "</QueryTaxpayerResponse>",
        ].join(""),
      );

      const response = await rpc("tools/call", {
        name: "query_taxpayer",
        arguments: { taxNumber: "12345678" },
      });

      expect(await message(response)).toMatchObject({
        id: 1,
        result: {
          structuredContent: { taxpayerValidity: "true" },
          isError: false,
        },
      });

      expect(fetch.mock.calls[0][1]?.body).toContain(
        "<common:login>tstuser01abcde</common:login>",
      );
    });
  });

  describe("allowed hosts", () => {
    it("refuses a host header this server does not serve", async () => {
      const fetch = stubFetch("");

      const response = await rpc(
        "tools/call",
        { name: "query_taxpayer", arguments: {} },
        { host: "nav-mcp.example" },
      );

      expect(response.status).toBe(403);
      expect(fetch).not.toHaveBeenCalled();
    });

    it("refuses a cross-site request from another origin", async () => {
      const fetch = stubFetch("");

      const response = await rpc(
        "tools/call",
        { name: "query_taxpayer", arguments: {} },
        { origin: "https://nav-mcp.example" },
      );

      expect(response.status).toBe(403);
      expect(fetch).not.toHaveBeenCalled();
    });
  });
});
