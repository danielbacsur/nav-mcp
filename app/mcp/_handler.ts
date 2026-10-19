import { createMcpHandler } from "mcp-handler";

import packageJson from "@/package.json";

export const mcpHandler = createMcpHandler(() => {}, {
  serverInfo: { name: "nav-mcp", version: packageJson.version },
});
