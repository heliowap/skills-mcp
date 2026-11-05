import { describe, expect, test } from "bun:test";
import { measure, renderToolLine } from "../../scripts/budget";

// Expected lines are copied from OpenCode's live Code Mode catalog for a server with the same shape
// (a multi-line signature with a property JSDoc, and an empty-input tool). They pin the renderer port.
describe("renderToolLine matches OpenCode's Code Mode catalog", () => {
  test("a tool with one documented input and no output schema", () => {
    const line = renderToolLine("chrome-devtools.close_page", {
      description: "Closes the page by its index. The last open page cannot be closed.",
      inputSchema: {
        type: "object",
        properties: {
          pageId: { type: "number", description: "The ID of the page to close. Call list_pages to list pages." },
        },
        required: ["pageId"],
        additionalProperties: false,
      },
      outputSchema: {},
    });

    expect(line).toBe(
      [
        '  - tools["chrome-devtools"].close_page({',
        "  /** The ID of the page to close. Call list_pages to list pages. */",
        "  pageId: number,",
        "}): Promise<unknown> // Closes the page by its index. The last open page cannot be closed.",
      ].join("\n"),
    );
  });

  test("a tool with no inputs renders empty parentheses", () => {
    const line = renderToolLine("chrome-devtools.list_pages", {
      description: "Get a list of pages open in the browser.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      outputSchema: {},
    });

    expect(line).toBe(
      '  - tools["chrome-devtools"].list_pages(): Promise<unknown> // Get a list of pages open in the browser.',
    );
  });
});

describe("measure", () => {
  test("the fixed cost of the skills server is within the 320-token hard limit", async () => {
    const result = await measure();

    expect(result.tokens).toBeGreaterThan(0);
    expect(result.tokens).toBeLessThanOrEqual(320);
    expect(result.text).toContain("- skills (4 tools)");
    expect(result.text).toContain('Use tools from this server through `execute` under `tools["skills"]`.');
  });
});
