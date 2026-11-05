// A minimal in-process JSON-RPC client over the SDK's linked in-memory transport. The budget script
// and the tests use it to list tools and call them exactly as a harness would, without a process.

import type { McpServer } from "@modelcontextprotocol/server";
import {
  InMemoryTransport,
  isJSONRPCErrorResponse,
  isJSONRPCResultResponse,
  LATEST_PROTOCOL_VERSION,
  type JSONRPCMessage,
} from "@modelcontextprotocol/server";
import { z } from "zod";

/** An error response from the server; `code` is the JSON-RPC error code. */
export class RpcError extends Error {
  readonly code: number;

  constructor(message: string, code: number) {
    super(message);
    this.name = "RpcError";
    this.code = code;
  }
}

export interface InProcessClient {
  /** The `initialize` result: serverInfo, capabilities and the server's instructions. */
  readonly initialized: InitializeResponse;
  /** Sends a request. The result is parsed by `schema`, so a mismatch rejects. */
  request<S extends z.ZodType>(method: string, schema: S, params?: Record<string, unknown>): Promise<z.output<S>>;
  notify(method: string, params?: Record<string, unknown>): void;
  close(): Promise<void>;
}

const InitializeSchema = z.object({
  serverInfo: z.object({ name: z.string(), version: z.string() }),
  instructions: z.string().optional(),
  capabilities: z.object({ extensions: z.record(z.string(), z.unknown()).optional() }),
});

export type InitializeResponse = z.infer<typeof InitializeSchema>;

/** Connects a client, runs the initialize handshake and returns the client. */
export async function connectInProcess(server: McpServer): Promise<InProcessClient> {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const waiting = new Map<number, { resolve: (value: unknown) => void; reject: (err: Error) => void }>();
  let nextId = 1;

  clientSide.onmessage = (message: JSONRPCMessage) => {
    if (isJSONRPCResultResponse(message)) {
      const waiter = waiting.get(Number(message.id));
      waiting.delete(Number(message.id));
      waiter?.resolve(message.result);
    } else if (isJSONRPCErrorResponse(message)) {
      const waiter = waiting.get(Number(message.id));
      waiting.delete(Number(message.id));
      waiter?.reject(new RpcError(message.error.message, message.error.code));
    }
  };

  await server.connect(serverSide);
  await clientSide.start();

  const send = (method: string, params: Record<string, unknown>, id: number): void => {
    void clientSide.send({ jsonrpc: "2.0", id, method, params });
  };

  const request = <S extends z.ZodType>(
    method: string,
    schema: S,
    params: Record<string, unknown> = {},
  ): Promise<z.output<S>> => {
    const id = nextId++;
    const response = new Promise<unknown>((resolve, reject) => waiting.set(id, { resolve, reject }));
    send(method, params, id);
    return response.then((result) => schema.parse(result));
  };

  const notify = (method: string, params?: Record<string, unknown>): void => {
    void clientSide.send({ jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }) });
  };

  const initialized = await request("initialize", InitializeSchema, {
    protocolVersion: LATEST_PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: "skills-mcp-inprocess", version: "0.0.0" },
  });
  notify("notifications/initialized");

  return {
    initialized,
    request,
    notify,
    close: () => clientSide.close(),
  };
}
