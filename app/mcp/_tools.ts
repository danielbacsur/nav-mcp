import type {
  CallToolResult,
  McpServer,
  ServerContext,
  ToolAnnotations,
} from "@modelcontextprotocol/server";
import { z } from "zod";

import {
  callNav,
  element,
  getServiceMetrics,
  type NavResult,
} from "./_nav/client";
import { readCredentials, readEnv } from "./_nav/credentials";
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

  {
    name: "query_invoice_data",
    title: "Get invoice data",
    description:
      "Returns the full data of one invoice by invoice number and direction.",
    annotations: query,
  },

  {
    name: "query_invoice_check",
    title: "Check invoice exists",
    description:
      "Checks whether an invoice with the given number and direction exists in NAV.",
    annotations: query,
  },

  {
    name: "query_invoice_digest",
    title: "Search invoices",
    description:
      "Searches invoices by issue date, insertion date or original invoice number, with optional filters, one page at a time.",
    annotations: query,
  },

  {
    name: "query_invoice_chain_digest",
    title: "Get invoice modification chain",
    description:
      "Returns the modification chain of an invoice, one page at a time.",
    annotations: query,
  },

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
      const { credentials, error } = readCredentials(ctx.http?.req);

      if (!credentials) {
        return errorResult(error);
      }

      const { software, error: softwareError } = readSoftware();

      if (!software) {
        return errorResult(softwareError);
      }

      return navResult(
        await callNav(
          "queryTaxpayer",
          credentials,
          software,
          element("taxNumber", taxNumber ?? credentials.taxNumber),
        ),
      );
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
