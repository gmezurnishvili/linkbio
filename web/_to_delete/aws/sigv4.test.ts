import { describe, expect, it } from "vitest";
import { __testing, credentialsFromEnv, signRequest } from "./sigv4";

/**
 * The signer is checked against the values AWS publishes, not against output
 * this repo captured from itself — a snapshot of a wrong signature is still a
 * passing test, and the failure it misses is a 403 from a live function URL
 * that looks exactly like a permissions problem.
 *
 * Three published anchors are used: the derived signing key from the SigV4
 * documentation, the canonical request and string-to-sign from the `get-vanilla`
 * case of AWS's signing test suite, and the empty-payload hash.
 */
const CREDENTIALS = {
  accessKeyId: "AKIDEXAMPLE",
  secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
};
const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

describe("key derivation", () => {
  it("matches the derived signing key AWS documents", async () => {
    // From "Examples of how to derive a signing key for Signature Version 4":
    // secret above, 20150830, us-east-1, iam.
    const key = await __testing.signingKey(CREDENTIALS.secretAccessKey, "20150830", "us-east-1", "iam");
    expect(__testing.hex(key)).toBe(
      "c4afb1cc5771d871763a393e44b703571b55cc28424d1a5e86da6ed3c154a4b9",
    );
  });
});

describe("get-vanilla", () => {
  const signed = signRequest({
    method: "GET",
    url: new URL("https://example.amazonaws.com/"),
    headers: new Headers(),
    service: "service",
    region: "us-east-1",
    credentials: CREDENTIALS,
    now: new Date("2015-08-30T12:36:00Z"),
    // The suite predates the header, so it is left off to reproduce the case
    // byte for byte.
    contentSha256Header: false,
  });

  it("builds the canonical request the suite specifies", async () => {
    await signed;
    expect(__testing.lastCanonicalRequest()).toBe(
      [
        "GET",
        "/",
        "",
        "host:example.amazonaws.com",
        "x-amz-date:20150830T123600Z",
        "",
        "host;x-amz-date",
        EMPTY_SHA256,
      ].join("\n"),
    );
  });

  it("builds the string to sign the suite specifies", async () => {
    await signed;
    const [algorithm, date, scope] = __testing.lastStringToSign().split("\n");
    expect(algorithm).toBe("AWS4-HMAC-SHA256");
    expect(date).toBe("20150830T123600Z");
    expect(scope).toBe("20150830/us-east-1/service/aws4_request");
  });

  it("produces the suite's Authorization header", async () => {
    expect((await signed).get("authorization")).toBe(
      "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, " +
        "SignedHeaders=host;x-amz-date, " +
        "Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31",
    );
  });
});

describe("signing this app's requests", () => {
  const base = {
    service: "lambda",
    region: "us-east-1",
    credentials: CREDENTIALS,
    now: new Date("2015-08-30T12:36:00Z"),
  };

  it("signs every header it is asked to send, and keeps the bearer out of Authorization", async () => {
    const headers = await signRequest({
      ...base,
      method: "POST",
      url: new URL("https://fn.lambda-url.us-east-1.on.aws/v1/profiles"),
      headers: new Headers({
        "content-type": "application/json",
        "x-authorization": "Bearer abc",
        "if-match": "7",
      }),
      body: '{"title":"x"}',
      credentials: { ...CREDENTIALS, sessionToken: "session-token" },
    });

    expect(headers.get("authorization")!.match(/SignedHeaders=([^,]+)/)![1]!.split(";")).toEqual([
      "content-type",
      "host",
      "if-match",
      "x-amz-content-sha256",
      "x-amz-date",
      "x-amz-security-token",
      "x-authorization",
    ]);
    expect(headers.get("authorization")).toMatch(/^AWS4-HMAC-SHA256 /);
    expect(headers.get("x-authorization")).toBe("Bearer abc");
    expect(headers.get("x-amz-security-token")).toBe("session-token");
    expect(headers.get("host")).toBe("fn.lambda-url.us-east-1.on.aws");
  });

  it("hashes the body, so two different bodies never share a signature", async () => {
    const sign = (body?: string) =>
      signRequest({
        ...base,
        method: "POST",
        url: new URL("https://fn.lambda-url.us-east-1.on.aws/v1/profiles"),
        headers: new Headers({ "content-type": "application/json" }),
        body,
      });

    expect((await sign()).get("x-amz-content-sha256")).toBe(EMPTY_SHA256);
    expect((await sign('{"a":1}')).get("x-amz-content-sha256")).not.toBe(EMPTY_SHA256);
    expect((await sign('{"a":1}')).get("authorization")).not.toBe(
      (await sign('{"a":2}')).get("authorization"),
    );
  });

  it("overwrites an Authorization the caller left behind rather than signing it", async () => {
    const withBearer = await signRequest({
      ...base,
      method: "GET",
      url: new URL("https://fn.lambda-url.us-east-1.on.aws/v1/me"),
      headers: new Headers({ authorization: "Bearer leftover" }),
    });
    expect(withBearer.get("authorization")).toMatch(/^AWS4-HMAC-SHA256 /);
    expect(__testing.lastCanonicalRequest()).not.toContain("leftover");
  });

  it("encodes query strings in the canonical order AWS expects", () => {
    expect(__testing.canonicalQuery(new URLSearchParams("b=2&a=1&a=0"))).toBe("a=0&a=1&b=2");
    expect(__testing.canonicalQuery(new URLSearchParams("q=a b*c"))).toBe("q=a%20b%2Ac");
  });

  it("percent-encodes path segments rather than leaving them raw", () => {
    expect(__testing.canonicalPath("/v1/profiles/abc")).toBe("/v1/profiles/abc");
    expect(__testing.canonicalPath("/v1/handles/a%20b")).toBe("/v1/handles/a%20b");
    expect(__testing.canonicalPath("/")).toBe("/");
  });
});

describe("credentialsFromEnv", () => {
  it("is null off Lambda, so the caller sends the request unsigned", () => {
    expect(credentialsFromEnv({})).toBeNull();
    expect(credentialsFromEnv({ AWS_ACCESS_KEY_ID: "only-half" })).toBeNull();
  });

  it("carries the session token when the role has one", () => {
    expect(
      credentialsFromEnv({
        AWS_ACCESS_KEY_ID: "id",
        AWS_SECRET_ACCESS_KEY: "secret",
        AWS_SESSION_TOKEN: "token",
      }),
    ).toEqual({ accessKeyId: "id", secretAccessKey: "secret", sessionToken: "token" });
  });
});
