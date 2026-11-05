/**
 * The classifier could not use a decision answer, or the model timed out. The message names the
 * question key involved, never the task text, option values or any credential.
 */
export class ClassifierError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClassifierError";
  }
}
