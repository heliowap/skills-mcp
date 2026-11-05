// Typed decision errors. Messages never contain credentials or request bodies,
// and the errors carry no `cause`: SDK errors can hold request bodies or headers.

/** The provider rejected the credentials (HTTP 401 or 403). Not retried. */
export class DecisionAuthError extends Error {
  readonly status: number;

  constructor(status: number) {
    super(`decision model rejected the credentials (HTTP ${status}); check the API key variables`);
    this.name = "DecisionAuthError";
    this.status = status;
  }
}

/** The call did not finish within the configured timeout. */
export class DecisionTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`decision model did not answer within ${timeoutMs} ms`);
    this.name = "DecisionTimeoutError";
  }
}

/** The model declined to answer one or more questions. Not retried. */
export class DecisionRefusedError extends Error {
  readonly questionIds: string[];

  constructor(questionIds: string[]) {
    super(`decision model refused to answer: ${questionIds.join(", ")}`);
    this.name = "DecisionRefusedError";
    this.questionIds = questionIds;
  }
}

/** The model's answer does not match the questions asked. Names the question keys, never the answer content. */
export class DecisionResponseError extends Error {
  readonly questionKeys: string[];

  constructor(questionKeys: readonly string[], detail: string) {
    super(`decision model returned an unexpected answer for ${questionKeys.map((key) => `"${key}"`).join(", ")}: ${detail}`);
    this.name = "DecisionResponseError";
    this.questionKeys = [...questionKeys];
  }
}

/** The configured decision model cannot be used: unknown id or missing key. `reason` is safe to show the agent. */
export class DecisionUnavailableError extends Error {
  readonly reason: string;

  constructor(reason: string) {
    super(reason);
    this.name = "DecisionUnavailableError";
    this.reason = reason;
  }
}
