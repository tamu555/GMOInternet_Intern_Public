/**
 * The BRIDGE layer's error type.
 *
 * Everything above BRIDGE decides "retry / recover / give up" from these
 * fields alone, so the defaults matter: a transport failure must be retryable
 * and a business rejection must not be.
 */
import {describe, it} from "node:test";
import assert from "node:assert/strict";
import {isRegistryError, RegistryError} from "../../src/bridge/errors";

/**
 * Builds an error with the given kind and sensible defaults.
 *
 * @param {string} kind Failure classification.
 * @param {boolean | undefined} retryable Explicit retry flag, if any.
 * @return {RegistryError} Error under test.
 */
function make(
  kind: RegistryError["kind"],
  retryable?: boolean,
): RegistryError {
  return new RegistryError({
    kind,
    registry: "kitaqsign",
    command: "domain:create",
    message: "boom",
    httpStatus: 409,
    resultCode: 2302,
    clTRID: "ORD-000001-CREATE-01",
    svTRID: "SV-1",
    retryable,
  });
}

describe("RegistryError", () => {
  it("treats a transport failure as retryable by default", () => {
    assert.equal(make("transport").retryable, true);
  });

  it("does not retry a business rejection by default", () => {
    assert.equal(make("objectExists").retryable, false);
    assert.equal(make("policyViolation").retryable, false);
    assert.equal(make("validation").retryable, false);
  });

  it("lets the caller override the retry flag", () => {
    assert.equal(make("transport", false).retryable, false);
  });

  it("keeps both halves of the two-stage judgement", () => {
    const error = make("objectExists");
    assert.equal(error.httpStatus, 409);
    assert.equal(error.resultCode, 2302);
  });

  it("carries the investigation keys into the log payload", () => {
    const payload = make("objectExists").toLogPayload();
    assert.equal(payload.clTRID, "ORD-000001-CREATE-01");
    assert.equal(payload.svTRID, "SV-1");
    assert.equal(payload.command, "domain:create");
  });

  it("is an Error, so it survives a rethrow", () => {
    assert.ok(make("unknown") instanceof Error);
    assert.equal(make("unknown").name, "RegistryError");
  });
});

describe("isRegistryError", () => {
  it("recognises its own type", () => {
    assert.equal(isRegistryError(make("transport")), true);
  });

  it("rejects anything else", () => {
    assert.equal(isRegistryError(new Error("plain")), false);
    assert.equal(isRegistryError("string"), false);
    assert.equal(isRegistryError(undefined), false);
  });
});
