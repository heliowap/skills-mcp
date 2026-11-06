import { describe, expect, test } from "bun:test";
import { CoverageError, readOpenCodeListing } from "../../scripts/coverage";

describe("readOpenCodeListing", () => {
  test("an OpenCode process that cannot run is a CoverageError", async () => {
    await expect(readOpenCodeListing(process.cwd(), "/nonexistent/opencode-bin")).rejects.toBeInstanceOf(CoverageError);
  });
});
