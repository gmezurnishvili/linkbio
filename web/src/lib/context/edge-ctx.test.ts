import { describe, expect, it } from "vitest";
import { parseEdgeContext } from "./edge-ctx";

/**
 * These cases are the header `api/edge/page.js` writes, read back. The two files
 * are the only writer and the only reader of this format on the web side, and a
 * disagreement between them is not a crash — it is a page computed under one
 * set of values and cached under a key built from another.
 */
describe("parseEdgeContext", () => {
  it("is null when the request did not come through the edge", () => {
    expect(parseEdgeContext(null)).toBeNull();
    expect(parseEdgeContext(undefined)).toBeNull();
    expect(parseEdgeContext("")).toBeNull();
  });

  it("reads a fully populated mask", () => {
    const edge = parseEdgeContext("v87|na.m.ig.en.1")!;
    expect(edge.version).toBe(87);
    expect(edge.context).toEqual({
      geo: "na",
      device: "mobile",
      referrer: "ig",
      lang: "en",
      webview: true,
    });
    expect(edge.dims).toEqual(["geo", "device", "referrer", "lang", "webview"]);
  });

  it("treats an unmasked slot as unknown rather than as a value", () => {
    const edge = parseEdgeContext("v3|-.d.-.-.-")!;
    expect(edge.context).toEqual({
      geo: undefined,
      device: "desktop",
      referrer: undefined,
      lang: undefined,
      webview: undefined,
    });
    expect(edge.dims).toEqual(["device"]);
  });

  it("reads the slots positionally, so a device-only mask is not read as geo", () => {
    // The bug this format exists to prevent: an earlier encoding emitted only
    // the masked dimensions, so `d` landed in the geo slot.
    const edge = parseEdgeContext("v1|-.t.-.-.-")!;
    expect(edge.context.geo).toBeUndefined();
    expect(edge.context.device).toBe("tablet");
  });

  it("maps every device character the edge can emit", () => {
    expect(parseEdgeContext("v1|-.m.-.-.-")!.context.device).toBe("mobile");
    expect(parseEdgeContext("v1|-.t.-.-.-")!.context.device).toBe("tablet");
    expect(parseEdgeContext("v1|-.d.-.-.-")!.context.device).toBe("desktop");
  });

  it("distinguishes webview false from webview absent", () => {
    expect(parseEdgeContext("v1|-.-.-.-.0")!.context.webview).toBe(false);
    expect(parseEdgeContext("v1|-.-.-.-.1")!.context.webview).toBe(true);
    expect(parseEdgeContext("v1|-.-.-.-.-")!.context.webview).toBeUndefined();
  });

  it("carries a maskless profile as a version with nothing keyed", () => {
    const edge = parseEdgeContext("v0|-.-.-.-.-")!;
    expect(edge.version).toBe(0);
    expect(edge.dims).toEqual([]);
  });

  it("survives a header with no version, and one with no slots", () => {
    expect(parseEdgeContext("na.m.ig.en.0")!.version).toBe(0);
    expect(parseEdgeContext("na.m.ig.en.0")!.context.geo).toBe("na");
    expect(parseEdgeContext("v9|")!.dims).toEqual([]);
    expect(parseEdgeContext("v9|")!.version).toBe(9);
  });

  it("does not turn a non-numeric version into NaN", () => {
    expect(parseEdgeContext("vabc|na.-.-.-.-")!.version).toBe(0);
  });
});
