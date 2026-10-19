import { withAllowedHosts } from "./_allowed-hosts";
import { mcpHandler } from "./_handler";

const handler = withAllowedHosts(mcpHandler);

export { handler as GET, handler as POST };
