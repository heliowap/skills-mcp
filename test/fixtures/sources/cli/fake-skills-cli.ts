// Fake `skills` CLI for the cli source tests.
// Usage: bun fake-skills-cli.ts <responses.json> <command words...>
// The responses file maps a space-joined command (e.g. "skills get x") to either a JSON
// value (printed as JSON) or a string (printed verbatim). Unknown commands exit 1 with
// an agent-desktop style error envelope.

export {};

const [responsesFile, ...command] = process.argv.slice(2);
const responses = JSON.parse(await Bun.file(responsesFile).text()) as Record<string, unknown>;
const key = command.join(" ");

if (!Object.hasOwn(responses, key)) {
  const envelope = { ok: false, command: command[0], error: { code: "INVALID_ARGS", message: `no response for: ${key}` } };
  process.stdout.write(JSON.stringify(envelope));
  process.exit(1);
}

const value = responses[key];
process.stdout.write(typeof value === "string" ? value : JSON.stringify(value));
