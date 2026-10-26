import { z } from "zod";

import packageJson from "@/package.json";

// Next loads `KEY=""` as an empty string, so an empty optional variable
// counts as unset rather than failing validation or sending an empty element.
const optional = <T extends z.ZodType>(schema: T) =>
  z.preprocess(
    (value) => (value === "" ? undefined : value),
    schema.optional(),
  );

const envSchema = z.object({
  NAV_SOFTWARE_ID: z.string().regex(/^[0-9A-Z-]{18}$/),
  NAV_SOFTWARE_DEV_NAME: z.string().min(1),
  NAV_SOFTWARE_DEV_CONTACT: z.string().min(1),
  NAV_SOFTWARE_DEV_COUNTRY_CODE: optional(z.string().length(2)),
  NAV_SOFTWARE_DEV_TAX_NUMBER: optional(z.string().min(1)),
});

export type NavSoftware = {
  softwareId: string;
  softwareName: string;
  softwareOperation: "ONLINE_SERVICE";
  softwareMainVersion: string;
  softwareDevName: string;
  softwareDevContact: string;
  softwareDevCountryCode?: string;
  softwareDevTaxNumber?: string;
};

// The software block identifies this server to NAV, not the caller, so it
// comes from server environment variables rather than request headers.
export function readSoftware() {
  const result = envSchema.safeParse(process.env);

  if (!result.success) {
    const names = result.error.issues.map((issue) => issue.path.join("."));

    return {
      error: `The server is missing or has invalid ${names.join(", ")}.`,
    } as const;
  }

  const env = result.data;

  const software: NavSoftware = {
    softwareId: env.NAV_SOFTWARE_ID,
    softwareName: "nav-mcp",
    softwareOperation: "ONLINE_SERVICE",
    softwareMainVersion: packageJson.version,
    softwareDevName: env.NAV_SOFTWARE_DEV_NAME,
    softwareDevContact: env.NAV_SOFTWARE_DEV_CONTACT,
    softwareDevCountryCode: env.NAV_SOFTWARE_DEV_COUNTRY_CODE,
    softwareDevTaxNumber: env.NAV_SOFTWARE_DEV_TAX_NUMBER,
  };

  return { software } as const;
}
