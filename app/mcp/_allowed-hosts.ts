import {
  hostHeaderValidationResponse,
  localhostAllowedHostnames,
  originValidationResponse,
} from "@modelcontextprotocol/server";

// Vercel sets these at runtime: the production domain (custom domain if one
// is attached), the branch domain and the per-deployment domain.
const allowedHostnames = [
  ...localhostAllowedHostnames(),
  process.env.VERCEL_PROJECT_PRODUCTION_URL,
  process.env.VERCEL_BRANCH_URL,
  process.env.VERCEL_URL,
].filter((hostname): hostname is string => Boolean(hostname));

// The MCP spec requires Host and Origin checks against DNS rebinding and
// cross-site requests; neither mcp-handler nor the SDK does them.
export function withAllowedHosts(
  handler: (request: Request) => Promise<Response>,
): (request: Request) => Promise<Response> {
  return async (request) =>
    hostHeaderValidationResponse(request, allowedHostnames) ??
    originValidationResponse(request, allowedHostnames) ??
    handler(request);
}
