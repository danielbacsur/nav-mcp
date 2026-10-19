import type { McpServer, ToolAnnotations } from "@modelcontextprotocol/server";
import { z } from "zod";

type ToolDefinition = {
  name: string;
  title: string;
  description: string;
  annotations: ToolAnnotations;
};

const query: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
};

// One tool per NAV Online Invoice 3.0 operation, in snake case. Input
// schemas and handlers arrive with each operation's implementation.
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

  {
    name: "query_taxpayer",
    title: "Look up taxpayer",
    description:
      "Returns the validity, name and addresses of a Hungarian taxpayer by 8-digit tax number.",
    annotations: query,
  },

  {
    name: "query_service_metrics",
    title: "Get service metrics",
    description:
      "Returns NAV's per-minute service metrics for the last 60 minutes. Needs no credentials.",
    annotations: query,
  },
];

export function registerTools(server: McpServer) {
  for (const { name, ...config } of tools) {
    server.registerTool(
      name,
      { ...config, inputSchema: z.object({}) },
      async () => ({ content: [] }),
    );
  }
}
