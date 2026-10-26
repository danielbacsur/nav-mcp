import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import packageJson from "@/package.json";

import { readSoftware } from "./software";

const ENV = {
  NAV_SOFTWARE_ID: "HU12345678-NAVMCP1",
  NAV_SOFTWARE_DEV_NAME: "Test Developer",
  NAV_SOFTWARE_DEV_CONTACT: "developer@example.com",
  NAV_SOFTWARE_DEV_COUNTRY_CODE: "HU",
  NAV_SOFTWARE_DEV_TAX_NUMBER: "12345678",
};

function stubEnv(env: Partial<Record<keyof typeof ENV, string | undefined>>) {
  for (const [name, value] of Object.entries(env)) {
    vi.stubEnv(name, value);
  }
}

describe("readSoftware", () => {
  beforeEach(() => {
    stubEnv(ENV);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe("valid environment", () => {
    it("identifies this server as nav-mcp at its package version", () => {
      expect(readSoftware()).toEqual({
        software: {
          softwareId: "HU12345678-NAVMCP1",
          softwareName: "nav-mcp",
          softwareOperation: "ONLINE_SERVICE",
          softwareMainVersion: packageJson.version,
          softwareDevName: "Test Developer",
          softwareDevContact: "developer@example.com",
          softwareDevCountryCode: "HU",
          softwareDevTaxNumber: "12345678",
        },
      });
    });

    it("leaves the optional developer fields out when they are unset", () => {
      stubEnv({
        NAV_SOFTWARE_DEV_COUNTRY_CODE: undefined,
        NAV_SOFTWARE_DEV_TAX_NUMBER: undefined,
      });

      const { software } = readSoftware();

      expect(software).toBeDefined();
      expect(software?.softwareDevCountryCode).toBeUndefined();
      expect(software?.softwareDevTaxNumber).toBeUndefined();
    });
  });

  describe("invalid environment", () => {
    it("names every required variable missing from the environment", () => {
      stubEnv({
        NAV_SOFTWARE_ID: undefined,
        NAV_SOFTWARE_DEV_NAME: undefined,
        NAV_SOFTWARE_DEV_CONTACT: undefined,
      });

      expect(readSoftware()).toEqual({
        error:
          "The server is missing or has invalid NAV_SOFTWARE_ID, NAV_SOFTWARE_DEV_NAME, NAV_SOFTWARE_DEV_CONTACT.",
      });
    });

    it("rejects a software id that is not 18 upper-case characters", () => {
      for (const softwareId of ["hu12345678-navmcp1", "HU12345678-NAVMCP"]) {
        stubEnv({ NAV_SOFTWARE_ID: softwareId });

        expect(readSoftware()).toEqual({
          error: "The server is missing or has invalid NAV_SOFTWARE_ID.",
        });
      }
    });

    it("rejects a developer country code longer than two letters", () => {
      stubEnv({ NAV_SOFTWARE_DEV_COUNTRY_CODE: "HUN" });

      expect(readSoftware()).toEqual({
        error:
          "The server is missing or has invalid NAV_SOFTWARE_DEV_COUNTRY_CODE.",
      });
    });
  });
});
