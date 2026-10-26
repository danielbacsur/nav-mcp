import type {
  CallToolResult,
  McpServer,
  ServerContext,
  ToolAnnotations,
} from "@modelcontextprotocol/server";
import { z } from "zod";

import {
  callNav,
  decodeInvoiceData,
  element,
  getServiceMetrics,
  type NavResult,
  requestExchangeToken,
} from "./_nav/client";
import {
  type NavCredentials,
  readCredentials,
  readEnv,
} from "./_nav/credentials";
import type { SignedOperation } from "./_nav/crypto";
import { readSoftware } from "./_nav/software";

type ToolDefinition = {
  name: string;
  title: string;
  description: string;
  annotations: ToolAnnotations;
  inputSchema: z.ZodObject;
  // Method syntax keeps the arguments bivariant, so each tool can narrow them.
  handler(
    args: Record<string, unknown>,
    ctx: ServerContext,
  ): Promise<CallToolResult>;
};

// Ties a handler's arguments to its input schema.
function implemented<Schema extends z.ZodObject>(
  definition: Omit<ToolDefinition, "inputSchema" | "handler"> & {
    inputSchema: Schema;
    handler: (
      args: z.infer<Schema>,
      ctx: ServerContext,
    ) => Promise<CallToolResult>;
  },
): ToolDefinition {
  return definition;
}

function errorResult(message: string): CallToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

function navResult(result: NavResult): CallToolResult {
  const value = result.ok ? result.data : { error: result.error };

  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
    structuredContent: value,
    isError: !result.ok,
  };
}

// Reads the caller's credentials and the server's software block before
// calling NAV, so each tool only builds its request body.
async function queryNav(
  ctx: ServerContext,
  operation: string,
  body: (credentials: NavCredentials) => string,
) {
  const { credentials, error } = readCredentials(ctx.http?.req);

  if (!credentials) {
    return { error };
  }

  const { software, error: softwareError } = readSoftware();

  if (!software) {
    return { error: softwareError };
  }

  return {
    result: await callNav(operation, credentials, software, body(credentials)),
  };
}

// Requests a fresh exchange token for every submission, since each token
// covers a single manageInvoice or manageAnnulment call.
async function submitNav(
  ctx: ServerContext,
  operation: string,
  operations: SignedOperation[],
  body: (token: string) => string,
) {
  const { credentials, error } = readCredentials(ctx.http?.req);

  if (!credentials) {
    return { error };
  }

  if (!credentials.exchangeKey) {
    return { error: "Send X-NAV-Exchange-Key to submit data." };
  }

  const { software, error: softwareError } = readSoftware();

  if (!software) {
    return { error: softwareError };
  }

  const token = await requestExchangeToken(
    credentials,
    software,
    credentials.exchangeKey,
  );

  if (!token.ok) {
    return { result: token };
  }

  return {
    result: await callNav(
      operation,
      credentials,
      software,
      body(token.token),
      operations,
    ),
  };
}

function base64(xml: string) {
  return Buffer.from(xml, "utf8").toString("base64");
}

const invoiceOperations = z.object({
  operations: z
    .array(
      z.object({
        operation: z
          .enum(["CREATE", "MODIFY", "STORNO"])
          .describe(
            "CREATE for an invoice, MODIFY or STORNO for a document that modifies or cancels one.",
          ),
        invoiceData: z
          .string()
          .min(1)
          .describe(
            "An InvoiceData XML document, valid against invoiceData.xsd.",
          ),
      }),
    )
    .min(1)
    .max(100),
});

function invoiceOperationsXml(operations: SignedOperation[]) {
  return [
    "<invoiceOperations>",
    element("compressedContent", "false"),
    ...operations.map(({ operation, data }, index) =>
      [
        "<invoiceOperation>",
        element("index", String(index + 1)),
        element("invoiceOperation", operation),
        element("invoiceData", data),
        "</invoiceOperation>",
      ].join(""),
    ),
    "</invoiceOperations>",
  ].join("");
}

const annulments = z.object({
  annulments: z
    .array(
      z.object({
        invoiceNumber: z
          .string()
          .min(1)
          .max(50)
          .describe("The invoice or modification document to annul."),
        code: z.enum([
          "ERRATIC_DATA",
          "ERRATIC_INVOICE_NUMBER",
          "ERRATIC_INVOICE_ISSUE_DATE",
          "ERRATIC_ELECTRONIC_HASH_VALUE",
        ]),
        reason: z.string().min(1).max(1024),
      }),
    )
    .min(1)
    .max(100),
});

function invoiceAnnulmentXml(
  annulment: z.infer<typeof annulments>["annulments"][number],
) {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<InvoiceAnnulment xmlns="http://schemas.nav.gov.hu/OSA/3.0/annul">',
    element("annulmentReference", annulment.invoiceNumber),
    element("annulmentTimestamp", new Date().toISOString()),
    element("annulmentCode", annulment.code),
    element("annulmentReason", annulment.reason),
    "</InvoiceAnnulment>",
  ].join("");
}

function annulmentOperationsXml(operations: SignedOperation[]) {
  return [
    "<annulmentOperations>",
    ...operations.map(({ operation, data }, index) =>
      [
        "<annulmentOperation>",
        element("index", String(index + 1)),
        element("annulmentOperation", operation),
        element("invoiceAnnulment", data),
        "</annulmentOperation>",
      ].join(""),
    ),
    "</annulmentOperations>",
  ].join("");
}

const direction = z
  .enum(["OUTBOUND", "INBOUND"])
  .describe(
    "OUTBOUND for invoices the taxpayer issued, INBOUND for ones it received.",
  );

const taxNumber = z.string().regex(/^\d{8}$/);

const invoiceNumberQuery = z
  .object({
    invoiceNumber: z.string().min(1).max(50),
    direction,
    batchIndex: z
      .int()
      .min(1)
      .optional()
      .describe("The invoice's position within a batch modification."),
    supplierTaxNumber: taxNumber
      .optional()
      .describe("The supplier's tax number, for INBOUND invoices only."),
  })
  .refine(
    (query) => !query.supplierTaxNumber || query.direction === "INBOUND",
    { message: "supplierTaxNumber is only allowed with INBOUND." },
  );

function invoiceNumberQueryXml(query: z.infer<typeof invoiceNumberQuery>) {
  return [
    "<invoiceNumberQuery>",
    element("invoiceNumber", query.invoiceNumber),
    element("invoiceDirection", query.direction),
    element("batchIndex", query.batchIndex?.toString()),
    element("supplierTaxNumber", query.supplierTaxNumber),
    "</invoiceNumberQuery>",
  ].join("");
}

const invoiceDigestQuery = z
  .object({
    direction,
    page: z.int().min(1).default(1),
    issueDateFrom: z.iso.date().optional(),
    issueDateTo: z.iso.date().optional(),
    insertedFrom: z.iso
      .datetime({ offset: true })
      .optional()
      .describe("When NAV received the invoice, as an ISO timestamp."),
    insertedTo: z.iso.datetime({ offset: true }).optional(),
    originalInvoiceNumber: z
      .string()
      .min(1)
      .optional()
      .describe("Finds the modifications of this invoice."),
    partnerTaxNumber: taxNumber.optional(),
    partnerName: z.string().min(5).optional(),
    invoiceCategory: z.enum(["NORMAL", "SIMPLIFIED", "AGGREGATE"]).optional(),
    paymentMethod: z
      .enum(["TRANSFER", "CASH", "CARD", "VOUCHER", "OTHER"])
      .optional(),
    invoiceAppearance: z
      .enum(["PAPER", "ELECTRONIC", "EDI", "UNKNOWN"])
      .optional(),
    source: z.enum(["WEB", "XML", "MGM", "OPG", "OSZ"]).optional(),
    currency: z.string().length(3).optional(),
  })
  .refine(
    (query) =>
      [
        query.issueDateFrom && query.issueDateTo,
        query.insertedFrom && query.insertedTo,
        query.originalInvoiceNumber,
      ].filter(Boolean).length === 1,
    {
      message:
        "Give exactly one of issueDateFrom and issueDateTo, insertedFrom and insertedTo, or originalInvoiceNumber.",
    },
  );

function invoiceDigestQueryXml(query: z.infer<typeof invoiceDigestQuery>) {
  const mandatory = query.originalInvoiceNumber
    ? element("originalInvoiceNumber", query.originalInvoiceNumber)
    : query.insertedFrom && query.insertedTo
      ? [
          "<insDate>",
          element("dateTimeFrom", new Date(query.insertedFrom).toISOString()),
          element("dateTimeTo", new Date(query.insertedTo).toISOString()),
          "</insDate>",
        ].join("")
      : [
          "<invoiceIssueDate>",
          element("dateFrom", query.issueDateFrom),
          element("dateTo", query.issueDateTo),
          "</invoiceIssueDate>",
        ].join("");

  const additional = [
    element("taxNumber", query.partnerTaxNumber),
    element("name", query.partnerName),
    element("invoiceCategory", query.invoiceCategory),
    element("paymentMethod", query.paymentMethod),
    element("invoiceAppearance", query.invoiceAppearance),
    element("source", query.source),
    element("currency", query.currency),
  ].join("");

  return [
    element("page", query.page.toString()),
    element("invoiceDirection", query.direction),
    "<invoiceQueryParams>",
    `<mandatoryQueryParams>${mandatory}</mandatoryQueryParams>`,
    additional &&
      `<additionalQueryParams>${additional}</additionalQueryParams>`,
    "</invoiceQueryParams>",
  ].join("");
}

const invoiceChainQuery = z
  .object({
    invoiceNumber: z.string().min(1).max(50),
    direction,
    page: z.int().min(1).default(1),
    supplierTaxNumber: taxNumber
      .optional()
      .describe("The supplier's tax number, for INBOUND invoices only."),
  })
  .refine(
    (query) => !query.supplierTaxNumber || query.direction === "INBOUND",
    { message: "supplierTaxNumber is only allowed with INBOUND." },
  );

function invoiceChainQueryXml(query: z.infer<typeof invoiceChainQuery>) {
  return [
    element("page", query.page.toString()),
    "<invoiceChainQuery>",
    element("invoiceNumber", query.invoiceNumber),
    element("invoiceDirection", query.direction),
    element("taxNumber", query.supplierTaxNumber),
    "</invoiceChainQuery>",
  ].join("");
}

const transactionListQuery = z.object({
  insertedFrom: z.iso
    .datetime({ offset: true })
    .describe("When NAV received the submission, as an ISO timestamp."),
  insertedTo: z.iso.datetime({ offset: true }),
  page: z.int().min(1).default(1),
  requestStatus: z
    .enum(["RECEIVED", "PROCESSING", "SAVED", "FINISHED", "NOTIFIED"])
    .optional(),
});

function transactionListQueryXml(query: z.infer<typeof transactionListQuery>) {
  return [
    element("page", query.page.toString()),
    "<insDate>",
    element("dateTimeFrom", new Date(query.insertedFrom).toISOString()),
    element("dateTimeTo", new Date(query.insertedTo).toISOString()),
    "</insDate>",
    element("requestStatus", query.requestStatus),
  ].join("");
}

const transactionStatusQuery = z.object({
  transactionId: z.string().regex(/^[+a-zA-Z0-9_]{1,30}$/),
  returnOriginalRequest: z
    .boolean()
    .default(false)
    .describe("Also return each submitted invoice, decoded."),
});

const query: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
};

// One tool per NAV Online Invoice 3.0 operation, in snake case.
export const tools: ToolDefinition[] = [
  implemented({
    name: "token_exchange",
    title: "Check write access",
    description:
      "Requests an exchange token and decodes it with X-NAV-Exchange-Key, then returns only its validity. manage_invoice and manage_annulment request their own tokens.",
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputSchema: z.object({}),
    handler: async (_args, ctx) => {
      const { credentials, error } = readCredentials(ctx.http?.req);

      if (!credentials) {
        return errorResult(error);
      }

      if (!credentials.exchangeKey) {
        return errorResult("Send X-NAV-Exchange-Key to request a token.");
      }

      const { software, error: softwareError } = readSoftware();

      if (!software) {
        return errorResult(softwareError);
      }

      const token = await requestExchangeToken(
        credentials,
        software,
        credentials.exchangeKey,
      );

      return navResult(
        token.ok
          ? {
              ok: true,
              data: {
                tokenValidityFrom: token.validFrom,
                tokenValidityTo: token.validTo,
              },
            }
          : token,
      );
    },
  }),

  implemented({
    name: "manage_invoice",
    title: "Submit invoice data",
    description:
      "Submits 1-100 invoice data reports (CREATE, MODIFY or STORNO) and returns a transactionId to poll with query_transaction_status. Needs X-NAV-Exchange-Key.",
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputSchema: invoiceOperations,
    handler: async (args, ctx) => {
      const operations = args.operations.map((item) => ({
        operation: item.operation,
        data: base64(item.invoiceData),
      }));

      const { result, error } = await submitNav(
        ctx,
        "manageInvoice",
        operations,
        (token) =>
          element("exchangeToken", token) + invoiceOperationsXml(operations),
      );

      return result ? navResult(result) : errorResult(error);
    },
  }),

  implemented({
    name: "manage_annulment",
    title: "Submit invoice annulments",
    description:
      "Submits 1-100 technical annulments of earlier reports and returns a transactionId. Each annulment takes effect only after approval on the NAV portal. Needs X-NAV-Exchange-Key.",
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputSchema: annulments,
    handler: async (args, ctx) => {
      const operations = args.annulments.map((annulment) => ({
        operation: "ANNUL",
        data: base64(invoiceAnnulmentXml(annulment)),
      }));

      const { result, error } = await submitNav(
        ctx,
        "manageAnnulment",
        operations,
        (token) =>
          element("exchangeToken", token) + annulmentOperationsXml(operations),
      );

      return result ? navResult(result) : errorResult(error);
    },
  }),

  implemented({
    name: "query_transaction_status",
    title: "Get transaction status",
    description:
      "Returns the per-invoice processing status and validation messages of a transaction.",
    annotations: query,
    inputSchema: transactionStatusQuery,
    handler: async (args, ctx) => {
      const { result, error } = await queryNav(
        ctx,
        "queryTransactionStatus",
        () =>
          element("transactionId", args.transactionId) +
          element("returnOriginalRequest", String(args.returnOriginalRequest)),
      );

      if (!result) {
        return errorResult(error);
      }

      const processing = result.ok
        ? (result.data.processingResults as
            | { processingResult?: Record<string, unknown>[] }
            | undefined)
        : undefined;

      for (const item of processing?.processingResult ?? []) {
        if (typeof item.originalRequest === "string") {
          item.originalRequest = decodeInvoiceData(
            item.originalRequest,
            item.compressedContentIndicator === "true",
          );
        }
      }

      return navResult(result);
    },
  }),

  implemented({
    name: "query_transaction_list",
    title: "List transactions",
    description:
      "Lists the taxpayer's transactions submitted within a date window of at most 35 days.",
    annotations: query,
    inputSchema: transactionListQuery,
    handler: async (args, ctx) => {
      const { result, error } = await queryNav(
        ctx,
        "queryTransactionList",
        () => transactionListQueryXml(args),
      );

      return result ? navResult(result) : errorResult(error);
    },
  }),

  implemented({
    name: "query_invoice_data",
    title: "Get invoice data",
    description:
      "Returns the full data of one invoice by invoice number and direction, decoded from NAV's XML.",
    annotations: query,
    inputSchema: invoiceNumberQuery,
    handler: async (args, ctx) => {
      const { result, error } = await queryNav(ctx, "queryInvoiceData", () =>
        invoiceNumberQueryXml(args),
      );

      if (!result) {
        return errorResult(error);
      }

      const invoice = result.ok
        ? (result.data.invoiceDataResult as Record<string, unknown> | undefined)
        : undefined;

      if (invoice && typeof invoice.invoiceData === "string") {
        invoice.invoiceData = decodeInvoiceData(
          invoice.invoiceData,
          invoice.compressedContentIndicator === "true",
        );
      }

      return navResult(result);
    },
  }),

  implemented({
    name: "query_invoice_check",
    title: "Check invoice exists",
    description:
      "Checks whether an invoice with the given number and direction exists in NAV.",
    annotations: query,
    inputSchema: invoiceNumberQuery,
    handler: async (args, ctx) => {
      const { result, error } = await queryNav(ctx, "queryInvoiceCheck", () =>
        invoiceNumberQueryXml(args),
      );

      return result ? navResult(result) : errorResult(error);
    },
  }),

  implemented({
    name: "query_invoice_digest",
    title: "Search invoices",
    description:
      "Searches invoices by issue date, insertion date or original invoice number, with optional filters. Date windows are at most 35 days, and pages hold up to 100 invoices.",
    annotations: query,
    inputSchema: invoiceDigestQuery,
    handler: async (args, ctx) => {
      const { result, error } = await queryNav(ctx, "queryInvoiceDigest", () =>
        invoiceDigestQueryXml(args),
      );

      return result ? navResult(result) : errorResult(error);
    },
  }),

  implemented({
    name: "query_invoice_chain_digest",
    title: "Get invoice modification chain",
    description:
      "Returns an invoice's original report and every modification or cancellation after it, one page at a time.",
    annotations: query,
    inputSchema: invoiceChainQuery,
    handler: async (args, ctx) => {
      const { result, error } = await queryNav(
        ctx,
        "queryInvoiceChainDigest",
        () => invoiceChainQueryXml(args),
      );

      return result ? navResult(result) : errorResult(error);
    },
  }),

  implemented({
    name: "query_taxpayer",
    title: "Look up taxpayer",
    description:
      "Returns the validity, name and addresses of a Hungarian taxpayer by 8-digit tax number. Defaults to the caller's own taxpayer.",
    annotations: query,
    inputSchema: z.object({
      taxNumber: z
        .string()
        .regex(/^\d{8}$/)
        .optional()
        .describe("The first 8 digits of the tax number."),
    }),
    handler: async ({ taxNumber }, ctx) => {
      const { result, error } = await queryNav(
        ctx,
        "queryTaxpayer",
        (credentials) =>
          element("taxNumber", taxNumber ?? credentials.taxNumber),
      );

      return result ? navResult(result) : errorResult(error);
    },
  }),

  implemented({
    name: "query_service_metrics",
    title: "Get service metrics",
    description:
      "Returns NAV's per-minute service metrics for the last 60 minutes. Needs no credentials.",
    annotations: query,
    inputSchema: z.object({
      metricName: z
        .string()
        .optional()
        .describe("A single metric to return, such as INVOICE_SERVICE_CALL."),
    }),
    handler: async ({ metricName }, ctx) =>
      navResult(await getServiceMetrics(readEnv(ctx.http?.req), metricName)),
  }),
];

export function registerTools(server: McpServer) {
  for (const { name, inputSchema, handler, ...config } of tools) {
    server.registerTool(name, { ...config, inputSchema }, handler);
  }
}
