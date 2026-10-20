import { z } from "zod";

import { passwordHash } from "./crypto";

const headersSchema = z
  .object({
    "x-nav-login": z.string().regex(/^[a-zA-Z0-9]{6,15}$/),
    "x-nav-password": z.string().min(1).optional(),
    "x-nav-password-hash": z
      .string()
      .regex(/^[0-9A-Fa-f]{128}$/)
      .optional(),
    "x-nav-signature-key": z.string().min(1),
    "x-nav-tax-number": z.string().regex(/^\d{8}(-?\d-?\d{2})?$/),
    "x-nav-env": z.enum(["test", "production"]).default("test"),
  })
  .refine(
    (headers) => headers["x-nav-password"] || headers["x-nav-password-hash"],
    { message: "Send X-NAV-Password or X-NAV-Password-Hash." },
  );

export type NavCredentials = {
  login: string;
  passwordHash: string;
  signingKey: string;
  taxNumber: string;
  env: "test" | "production";
};

// x-nav-signature-key -> X-NAV-Signature-Key
function headerName(name: string) {
  return name
    .split("-")
    .map((part, index) =>
      index < 2 ? part.toUpperCase() : part[0].toUpperCase() + part.slice(1),
    )
    .join("-");
}

const envSchema = z.enum(["test", "production"]).catch("test");

// Metrics need no credentials, only the environment to ask.
export function readEnv(request: Request | undefined) {
  return envSchema.parse(request?.headers.get("x-nav-env") ?? undefined);
}

// Errors name the offending header but never echo its value, because every
// X-NAV-* header is a secret.
export function readCredentials(request: Request | undefined) {
  const headers = Object.fromEntries(
    Object.keys(headersSchema.shape).map((name) => [
      name,
      request?.headers.get(name) ?? undefined,
    ]),
  );

  const result = headersSchema.safeParse(headers);

  if (!result.success) {
    const issues = result.error.issues.map((issue) =>
      issue.path.length > 0
        ? `${headerName(String(issue.path[0]))} is missing or invalid.`
        : issue.message,
    );

    return { error: issues.join(" ") } as const;
  }

  const parsed = result.data;

  const credentials: NavCredentials = {
    login: parsed["x-nav-login"],
    passwordHash: (
      parsed["x-nav-password-hash"] ?? passwordHash(parsed["x-nav-password"]!)
    ).toUpperCase(),
    signingKey: parsed["x-nav-signature-key"],
    taxNumber: parsed["x-nav-tax-number"].slice(0, 8),
    env: parsed["x-nav-env"],
  };

  return { credentials } as const;
}
