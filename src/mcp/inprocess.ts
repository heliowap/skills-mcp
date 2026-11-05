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

export interface InProcessClient {
  /** The `initialize` result: serverInfo, capabilities and the server's instructions. */
  readonly initialized: InitializeResponse;
  request<T = unknown>(method: string, params?: unknown): Promise<T>;
  notify(method: string, params?: unknown): void;
  close(): Promise<void>;
}

export interface InitializeResponse {
  serverInfo: { name: string; version: string };
  instructions?: string;
  capabilities: { extensions?: Record<string, unknown> };
}

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
      waiter?.reject(new Error(message.error.message));
    }
  };

  await server.connect(serverSide);
  await clientSide.start();

  const request = <T = unknown>(method: string, params: unknown = {}): Promise<T> => {
    const id = nextId++;
    const response = new Promise<unknown>((resolve, reject) => waiting.set(id, { resolve, reject }));
    void clientSide.send({ jsonrpc: "2.0", id, method, params: params as Record<string, unknown> });
    return response as Promise<T>;
  };
  const notify = (method: string, params?: unknown): void => {
    void clientSide.send({
      jsonrpc: "2.0",
      method,
      ...(params === undefined ? {} : { params: params as Record<string, unknown> }),
    });
  };

  const initialized = await request<InitializeResponse>("initialize", {
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
