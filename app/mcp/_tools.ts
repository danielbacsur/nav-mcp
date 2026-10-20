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
} from "./_nav/client";
import {
  type NavCredentials,
  readCredentials,
  readEnv,
} from "./_nav/credentials";
import { readSoftware } from "./_nav/software";

type ToolDefinition = {
  name: string;
  title: string;
  description: string;
  annotations: ToolAnnotations;
  inputSchema?: z.ZodObject;
  // Method syntax keeps the arguments bivariant, so each tool can narrow them.
  handler?(
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

const query: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
};

// One tool per NAV Online Invoice 3.0 operation, in snake case. Tools
// without a handler are not implemented yet.
export const tools: ToolDefinition[] = [
  {
    name: "token_exchange",
    title: "Request exchange token",
    description:
      "Requests a single-use exchange token for one manage_invoice or manage_annulment call.",
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  },

  {
    name: "manage_invoice",
    title: "Submit invoice data",
    description:
      "Submits 1-100 invoice data reports (CREATE, MODIFY or STORNO) and returns a transactionId to poll with query_transaction_status.",
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  },

  {
    name: "manage_annulment",
    title: "Submit invoice annulments",
    description:
      "Submits 1-100 technical annulments of earlier reports. Each annulment takes effect only after approval on the NAV portal.",
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
  },

  {
    name: "query_transaction_status",
    title: "Get transaction status",
    description:
      "Returns the per-invoice processing status and validation messages of a transaction.",
    annotations: query,
  },

  {
    name: "query_transaction_list",
    title: "List transactions",
    description:
      "Lists the taxpayer's transactions submitted within a date window of at most 35 days.",
    annotations: query,
  },

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
    server.registerTool(
      name,
      { ...config, inputSchema: inputSchema ?? z.object({}) },
      handler ?? (async () => errorResult(`${name} is not implemented yet.`)),
    );
  }
}
