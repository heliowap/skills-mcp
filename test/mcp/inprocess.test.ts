import { describe, expect, test } from "bun:test";
import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { connectInProcess, RpcError } from "../../src/mcp/inprocess";

function serverWithPing(): McpServer {
  const server = new McpServer({ name: "inprocess-test", version: "0.0.0" });
  server.registerTool("ping", { description: "Answers pong." }, async () => ({
    content: [{ type: "text", text: "pong" }],
  }));
  return server;
}

describe("in-process client", () => {
  test("the initialize handshake result is validated and exposed as initialized", async () => {
    const client = await connectInProcess(serverWithPing());

    expect(client.initialized.serverInfo.name).toBe("inprocess-test");
    await client.close();
  });

  test("a result that matches the schema resolves with the parsed value", async () => {
    const client = await connectInProcess(serverWithPing());

    const listed = await client.request("tools/list", z.object({ tools: z.array(z.object({ name: z.string() })) }));

    expect(listed.tools.map((tool) => tool.name)).toEqual(["ping"]);
    await client.close();
  });

  test("a result that does not match the schema rejects instead of being trusted", async () => {
    const client = await connectInProcess(serverWithPing());

    await expect(client.request("tools/list", z.object({ tools: z.number() }))).rejects.toThrow();
    await client.close();
  });

  test("an error response rejects with an RpcError, not a generic Error", async () => {
    const client = await connectInProcess(serverWithPing());

    const error: unknown = await client.request("no/such-method", z.unknown()).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(RpcError);
    expect(error).toMatchObject({ name: "RpcError", code: expect.any(Number) });
    await client.close();
  });
});
