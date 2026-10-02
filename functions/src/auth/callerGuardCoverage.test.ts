/**
 * Guards the guard: fails the build when an `api/` Callable is added without
 * `requireActiveUser`.
 *
 * Without this, the gate is a convention, and a convention is exactly what
 * was missing before: every `api/` Callable checked `if (!request.auth)` and
 * every one of them was reachable by an ID token minted straight against
 * Identity Toolkit's public `accounts:signUp`, with no `users/{uid}`
 * document behind it. A new Callable that copies its neighbour's `!auth`
 * check would reopen that hole silently, and no behavioural test would fail
 * - it would pass every check the author thought to run.
 *
 * This reads the TypeScript source rather than the compiled output because
 * the property under test is textual: the gate must be visible at the
 * trigger boundary in the file a reviewer reads.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {describe, it} from "node:test";

/**
 * Callables that are public on purpose. Each one documents why in its own
 * module header; adding a name here without that rationale in the source is
 * how this list rots.
 */
const PUBLIC_CALLABLE_FILES = [
  "listTlds.ts",
  "searchDomains.ts",
  "devForceRegistry503.ts",
  "devRegistryMaintenance.ts",
];

/**
 * Locates `functions/src/api` by walking up from the compiled test.
 *
 * Resolved rather than hard-coded because the same test runs from two output
 * layouts (`lib/` for `test:unit`, `lib-test/src/` for `test:registrar`),
 * which sit at different depths below `functions/`.
 *
 * @return {string} Absolute path to the Callable source directory.
 */
function findApiSourceDirectory(): string {
  let directory = __dirname;
  for (let depth = 0; depth < 8; depth += 1) {
    const candidate = path.join(directory, "src", "api");
    if (fs.existsSync(candidate)) {
      return candidate;
    }
    const parent = path.dirname(directory);
    if (parent === directory) {
      break;
    }
    directory = parent;
  }

  throw new Error(
    "Could not locate functions/src/api from " + __dirname,
  );
}

/**
 * Counts non-overlapping occurrences of a literal needle.
 *
 * @param {string} haystack Text to search.
 * @param {string} needle Literal to count.
 * @return {number} Number of occurrences.
 */
function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

describe("api Callable authorization coverage", () => {
  const apiDirectory = findApiSourceDirectory();
  const sourceFiles = fs
    .readdirSync(apiDirectory)
    .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
    .sort();

  it("finds Callable sources to check", () => {
    // A path bug that silently produced an empty list would make every
    // assertion below vacuously true.
    assert.ok(sourceFiles.length > 0, "no api/ sources found");
    assert.ok(
      sourceFiles.some((name) => name === "createOrder.ts"),
      "api/ sources look wrong: createOrder.ts is missing",
    );
  });

  it("only exempts Callables that still exist", () => {
    for (const exempt of PUBLIC_CALLABLE_FILES) {
      assert.ok(
        sourceFiles.includes(exempt),
        `${exempt} is exempted but no longer exists; drop it from ` +
          "PUBLIC_CALLABLE_FILES",
      );
    }
  });

  for (const name of sourceFiles) {
    if (PUBLIC_CALLABLE_FILES.includes(name)) {
      continue;
    }

    it(`gates every Callable in ${name}`, () => {
      const source = fs.readFileSync(
        path.join(apiDirectory, name),
        "utf8",
      );
      const callables = countOccurrences(source, "onCall(");
      if (callables === 0) {
        return;
      }

      const guards = countOccurrences(source, "requireActiveUser(");
      assert.ok(
        guards >= callables,
        `api/${name} defines ${callables} Callable(s) but calls ` +
          `requireActiveUser ${guards} time(s). Every member-facing ` +
          "Callable must start with `await requireActiveUser(request.auth)`; " +
          "if this one is public on purpose, say why in its module header " +
          "and add it to PUBLIC_CALLABLE_FILES in this test.",
      );
    });
  }
});
