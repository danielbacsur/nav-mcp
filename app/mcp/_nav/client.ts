import { gunzipSync } from "node:zlib";

import { XMLParser } from "fast-xml-parser";

import type { NavCredentials } from "./credentials";
import { createRequestId, requestSignature } from "./crypto";
import type { NavSoftware } from "./software";

const HOSTS = {
  test: "https://api-test.onlineszamla.nav.gov.hu",
  production: "https://api.onlineszamla.nav.gov.hu",
};

// NAV gives up after 60 seconds, so stop just before that.
const TIMEOUT_MS = 55_000;

// Repeatable NAV elements, kept as arrays even when only one comes back.
const LIST_ELEMENTS = new Set([
  "additionalInvoiceData",
  "additionalLineData",
  "businessValidationMessages",
  "invoiceDigest",
  "line",
  "metric",
  "metricDescription",
  "metricValues",
  "processingResult",
  "productCode",
  "summaryByVatRate",
  "taxpayerAddressItem",
  "technicalValidationMessages",
  "transaction",
]);

// Tag values stay strings so tax numbers and invoice numbers keep their
// leading zeros; NAV answers with varying namespace prefixes.
const parser = new XMLParser({
  ignoreAttributes: true,
  parseTagValue: false,
  removeNSPrefix: true,
  isArray: (name) => LIST_ELEMENTS.has(name),
});

export type NavError = {
  httpStatus: number;
  funcCode?: string;
  errorCode?: string;
  message: string;
  technicalValidationMessages?: unknown;
  requestId?: string;
};

export type NavResult =
  | { ok: true; data: Record<string, unknown> }
  | { ok: false; error: NavError };

export function escapeXml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

export function element(name: string, value: string | undefined) {
  return value === undefined ? "" : `<${name}>${escapeXml(value)}</${name}>`;
}

function softwareXml(software: NavSoftware) {
  return [
    "<software>",
    element("softwareId", software.softwareId),
    element("softwareName", software.softwareName),
    element("softwareOperation", software.softwareOperation),
    element("softwareMainVersion", software.softwareMainVersion),
    element("softwareDevName", software.softwareDevName),
    element("softwareDevContact", software.softwareDevContact),
    element("softwareDevCountryCode", software.softwareDevCountryCode),
    element("softwareDevTaxNumber", software.softwareDevTaxNumber),
    "</software>",
  ].join("");
}

function envelope(
  operation: string,
  credentials: NavCredentials,
  software: NavSoftware,
  requestId: string,
  bodyXml: string,
) {
  const timestamp = new Date().toISOString();

  const signature = requestSignature(
    requestId,
    timestamp,
    credentials.signingKey,
  );

  const root = `${operation[0].toUpperCase()}${operation.slice(1)}Request`;

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<${root} xmlns="http://schemas.nav.gov.hu/OSA/3.0/api"`,
    ' xmlns:common="http://schemas.nav.gov.hu/NTCA/1.0/common">',
    "<common:header>",
    element("common:requestId", requestId),
    element("common:timestamp", timestamp),
    element("common:requestVersion", "3.0"),
    element("common:headerVersion", "1.0"),
    "</common:header>",
    "<common:user>",
    element("common:login", credentials.login),
    `<common:passwordHash cryptoType="SHA-512">${credentials.passwordHash}</common:passwordHash>`,
    element("common:taxNumber", credentials.taxNumber),
    `<common:requestSignature cryptoType="SHA3-512">${signature}</common:requestSignature>`,
    "</common:user>",
    softwareXml(software),
    bodyXml,
    `</${root}>`,
  ].join("");
}

function parseXml(text: string) {
  try {
    const parsed = parser.parse(text) as Record<string, unknown>;
    const rootName = Object.keys(parsed).find((key) => key !== "?xml");

    return rootName ? (parsed[rootName] as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

function toResult(
  response: Response,
  text: string,
  requestId?: string,
): NavResult {
  const root = parseXml(text);

  // GeneralExceptionResponse has no result wrapper, so its funcCode sits at
  // the root. NAV also reports downtime as OK with this message.
  const result = (root?.result ?? root) as Record<string, string> | undefined;

  const failed =
    !response.ok ||
    !result ||
    result.funcCode !== "OK" ||
    /endpoint is currently down/i.test(result.message ?? "");

  if (failed) {
    return {
      ok: false,
      error: {
        httpStatus: response.status,
        funcCode: result?.funcCode,
        errorCode: result?.errorCode,
        message:
          result?.message ?? (text.trim().slice(0, 200) || response.statusText),
        technicalValidationMessages: root?.technicalValidationMessages,
        requestId,
      },
    };
  }

  const data = { ...root };

  delete data.header;
  delete data.result;
  delete data.software;

  return { ok: true, data };
}

// Invoices come back as base64 XML, gzipped when the submitter compressed
// them, inside the response XML.
export function decodeInvoiceData(base64: string, compressed: boolean) {
  const bytes = Buffer.from(base64, "base64");

  return parseXml((compressed ? gunzipSync(bytes) : bytes).toString("utf8"));
}

async function send(url: string, init: RequestInit, requestId?: string) {
  try {
    const response = await fetch(url, {
      ...init,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    return toResult(response, await response.text(), requestId);
  } catch (error) {
    return {
      ok: false,
      error: {
        httpStatus: 0,
        message: error instanceof Error ? error.message : String(error),
        requestId,
      },
    } satisfies NavResult;
  }
}

export function callNav(
  operation: string,
  credentials: NavCredentials,
  software: NavSoftware,
  bodyXml: string,
) {
  const requestId = createRequestId();

  return send(
    `${HOSTS[credentials.env]}/invoiceService/v3/${operation}`,
    {
      method: "POST",
      headers: {
        "content-type": "application/xml;charset=UTF-8",
        accept: "application/xml",
      },
      body: envelope(operation, credentials, software, requestId, bodyXml),
    },
    requestId,
  );
}

export function getServiceMetrics(
  env: "test" | "production",
  metricName?: string,
) {
  const path = metricName
    ? `metric/${encodeURIComponent(metricName)}`
    : "metric";

  return send(`${HOSTS[env]}/metricService/v3/queryServiceMetrics/${path}`, {
    headers: { accept: "application/xml" },
  });
}
