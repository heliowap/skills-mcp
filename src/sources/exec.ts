import type { Subprocess } from "bun";
import { SourceError } from "./shared";

export interface RunOptions {
  cwd?: string;
  /** Full environment for the child. Defaults to the parent's environment. */
  env?: Record<string, string>;
  timeoutMs: number;
  signal?: AbortSignal;
  /** Stdout beyond this many bytes kills the child and rejects. */
  maxStdoutBytes: number;
}

export interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/** Stderr kept for error messages; anything beyond is drained and discarded. */
const STDERR_KEEP_BYTES = 64 * 1024;

/**
 * Runs a program from an argv array. No shell is involved, so arguments are passed literally.
 * Resolves with the exit code for any program that ran to completion (a non-zero exit is not
 * an error here). Rejects with SourceError when the program cannot start, exceeds the timeout,
 * is aborted, or writes more stdout than allowed.
 */
export async function runArgv(argv: readonly string[], opts: RunOptions): Promise<RunResult> {
  const [program] = argv;
  if (program === undefined) throw new SourceError("cannot run an empty command");
  const label = argv.slice(0, 2).join(" ");
  if (opts.signal?.aborted) throw new SourceError(`aborted before starting: ${label}`);

  const controller = new AbortController();
  const state: { reason: "timeout" | "aborted" | "overflow" | null } = { reason: null };
  const stop = (reason: "timeout" | "aborted" | "overflow") => {
    state.reason ??= reason;
    controller.abort();
  };
  const onAbort = () => stop("aborted");
  opts.signal?.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => stop("timeout"), opts.timeoutMs);
  const cleanup = () => {
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", onAbort);
  };

  let proc: Subprocess<"ignore", "pipe", "pipe">;
  try {
    proc = Bun.spawn({
      cmd: [...argv],
      cwd: opts.cwd,
      env: opts.env,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      signal: controller.signal,
    });
  } catch (err) {
    cleanup();
    throw new SourceError(`cannot start ${program}: ${(err as Error).message}`);
  }

  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      readCapped(proc.stdout, opts.maxStdoutBytes, () => stop("overflow")),
      readCapped(proc.stderr, STDERR_KEEP_BYTES),
      proc.exited,
    ]);
    switch (state.reason) {
      case "timeout":
        throw new SourceError(`timed out after ${opts.timeoutMs} ms: ${label}`);
      case "aborted":
        throw new SourceError(`aborted: ${label}`);
      case "overflow":
        throw new SourceError(`output exceeds ${opts.maxStdoutBytes} bytes: ${label}`);
    }
    return { stdout, stderr, exitCode };
  } finally {
    cleanup();
  }
}

/** Reads a stream to the end. Keeps the first `limit` bytes; calls onOverflow once past the limit. */
async function readCapped(
  stream: ReadableStream<Uint8Array>,
  limit: number,
  onOverflow?: () => void,
): Promise<string> {
  const kept: Uint8Array[] = [];
  let keptBytes = 0;
  let total = 0;
  let overflowed = false;
  for await (const chunk of stream) {
    total += chunk.byteLength;
    if (total > limit && !overflowed) {
      overflowed = true;
      onOverflow?.();
    }
    if (keptBytes < limit) {
      kept.push(chunk);
      keptBytes += chunk.byteLength;
    }
  }
  return new TextDecoder().decode(Buffer.concat(kept).subarray(0, limit));
}
