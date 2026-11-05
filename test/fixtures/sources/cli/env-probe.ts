// Command for the environment test. `list` prints one skill; `get` prints a body that reports
// whether TYPESAFE_AI_API_KEY reached the command.
export {};

const [mode] = process.argv.slice(2);
if (mode === "list") {
  process.stdout.write(JSON.stringify({ data: { skills: [{ name: "probe" }] } }));
} else {
  const key = process.env.TYPESAFE_AI_API_KEY ?? "absent";
  process.stdout.write(JSON.stringify({ data: { content: `key=${key}` } }));
}
