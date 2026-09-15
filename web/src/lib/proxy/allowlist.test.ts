import { describe, expect, it } from "vitest";
import { isAllowedProxyPath } from "./allowlist";

describe("proxy allowlist", () => {
  it("allows the shapes the dashboard actually calls", () => {
    expect(isAllowedProxyPath("GET", ["v1", "me"])).toBe(true);
    expect(isAllowedProxyPath("POST", ["v1", "profiles"])).toBe(true);
    expect(isAllowedProxyPath("PATCH", ["v1", "profiles", "p_1"])).toBe(true);
    expect(isAllowedProxyPath("POST", ["v1", "profiles", "p_1", "publish"])).toBe(true);
    expect(isAllowedProxyPath("GET", ["v1", "handles", "giorgi"])).toBe(true);
    expect(isAllowedProxyPath("DELETE", ["v1", "profiles", "p_1", "blocks", "b_2"])).toBe(true);
    expect(isAllowedProxyPath("POST", ["v1", "profiles", "p_1", "blocks", "b_2", "move"])).toBe(
      true,
    );
    expect(isAllowedProxyPath("PUT", ["v1", "profiles", "p_1", "blocks", "b_2", "rules"])).toBe(
      true,
    );
    expect(isAllowedProxyPath("POST", ["v1", "profiles", "p_1", "preview"])).toBe(true);
  });

  it("refuses the profile-level rule endpoints, which no longer exist", () => {
    // Rules belong to a block and are replaced as a set. These shapes forwarded
    // an authenticated request to a 404 for no one's benefit.
    expect(isAllowedProxyPath("POST", ["v1", "profiles", "p_1", "rules"])).toBe(false);
    expect(isAllowedProxyPath("PATCH", ["v1", "profiles", "p_1", "rules", "r_3"])).toBe(false);
    expect(isAllowedProxyPath("DELETE", ["v1", "profiles", "p_1", "rules", "r_3"])).toBe(false);
  });

  it("refuses endpoints no page here calls, whatever the token could do with them", () => {
    expect(isAllowedProxyPath("POST", ["v1", "auth", "token"])).toBe(false);
    expect(isAllowedProxyPath("POST", ["v1", "auth", "refresh"])).toBe(false);
    expect(isAllowedProxyPath("GET", ["v1", "admin", "users"])).toBe(false);
    expect(isAllowedProxyPath("GET", ["internal", "metrics"])).toBe(false);
    expect(isAllowedProxyPath("GET", [])).toBe(false);
  });

  it("refuses a method the shape does not have", () => {
    expect(isAllowedProxyPath("DELETE", ["v1", "profiles", "p_1"])).toBe(false);
    expect(isAllowedProxyPath("POST", ["v1", "me"])).toBe(false);
    expect(isAllowedProxyPath("PUT", ["v1", "profiles", "p_1"])).toBe(false);
  });

  it("refuses id segments that would reshape the path once joined", () => {
    expect(isAllowedProxyPath("PATCH", ["v1", "profiles", ".."])).toBe(false);
    expect(isAllowedProxyPath("PATCH", ["v1", "profiles", "."])).toBe(false);
    expect(isAllowedProxyPath("PATCH", ["v1", "profiles", ""])).toBe(false);
    expect(isAllowedProxyPath("PATCH", ["v1", "profiles", "p_1/../../auth"])).toBe(false);
  });

  it("does not care how the method is cased", () => {
    expect(isAllowedProxyPath("get", ["v1", "me"])).toBe(true);
  });
});
