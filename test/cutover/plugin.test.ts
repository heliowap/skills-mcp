import { describe, expect, test } from "bun:test";
import plugin, { type CutoverContext, type McpEditor, type SkillEditor } from "../../opencode-plugin/skills-cutover/server";

/**
 * A stand-in for OpenCode's plugin runtime: transforms replay in registration order onto a fresh value
 * on every read, and `plugin.updated` is emitted on demand. Each transform is typed against the
 * plugin's own editor types, so the fake needs no casts.
 */
interface SkillState {
  id: string;
  description?: string;
  autoinvoke?: boolean;
}

interface ServerState {
  disabled?: boolean;
}

/** The skill editor the fake replays into: OpenCode's editor plus `add`, which the test's own skills use. */
class SkillMap implements SkillEditor {
  readonly skills = new Map<string, SkillState>();

  list(): SkillState[] {
    return [...this.skills.values()];
  }

  add(skill: SkillState): void {
    this.skills.set(skill.id, { ...skill });
  }

  update(id: string, update: (skill: SkillState) => void): void {
    const current = this.skills.get(id);
    if (current !== undefined) update(current);
  }
}

class ServerMap implements McpEditor {
  constructor(readonly servers: Map<string, ServerState>) {}

  get(name: string): ServerState | undefined {
    return this.servers.get(name);
  }

  update(name: string, update: (server: ServerState) => void): void {
    const current = this.servers.get(name);
    if (current !== undefined) update(current);
  }
}

/** One live registration. Each `register` call makes a new entry, even for the same function. */
interface Entry<Editor> {
  readonly transform: (editor: Editor) => void;
}

class Registry<Editor> {
  readonly entries: Entry<Editor>[] = [];

  register(transform: (editor: Editor) => void): { dispose(): Promise<void> } {
    const entry: Entry<Editor> = { transform };
    this.entries.push(entry);
    return {
      dispose: async () => {
        const index = this.entries.indexOf(entry);
        if (index >= 0) this.entries.splice(index, 1);
      },
    };
  }

  replay(editor: Editor): void {
    for (const entry of this.entries) entry.transform(editor);
  }
}

class EventBus {
  private readonly subscribers = new Set<{ types: string[]; push(type: string): void; close(): void }>();

  subscribe(input: { types?: string[]; signal?: AbortSignal }): AsyncIterable<{ type: string }> {
    const queue: Array<{ type: string }> = [];
    let wake: (() => void) | undefined;
    let closed = false;
    const subscriber = {
      types: input.types ?? [],
      push: (type: string) => {
        queue.push({ type });
        wake?.();
      },
      close: () => {
        closed = true;
        wake?.();
      },
    };
    this.subscribers.add(subscriber);
    input.signal?.addEventListener("abort", () => {
      this.subscribers.delete(subscriber);
      subscriber.close();
    });
    return {
      [Symbol.asyncIterator]: () => ({
        next: async () => {
          for (;;) {
            const next = queue.shift();
            if (next !== undefined) return { value: next, done: false };
            if (closed) return { value: undefined, done: true };
            await new Promise<void>((resolve) => {
              wake = resolve;
            });
            wake = undefined;
          }
        },
      }),
    };
  }

  emit(type: string): void {
    for (const subscriber of this.subscribers) if (subscriber.types.includes(type)) subscriber.push(type);
  }
}

function fakeOpenCode() {
  const skills = new Registry<SkillMap>();
  const servers = new Registry<ServerMap>();
  const bus = new EventBus();
  const context: CutoverContext = {
    skill: { transform: async (callback) => skills.register(callback) },
    mcp: { transform: async (callback) => servers.register(callback) },
    event: { subscribe: (input) => bus.subscribe(input) },
  };
  return {
    context,
    bus,
    skills,
    /** A skill registered before the plugin, as the builtin skill plugin does. */
    seedSkill(skill: SkillState): void {
      skills.register((editor) => editor.add(skill));
    },
    /** A skill registered after the plugin, as the config-scanned skill plugin does. */
    addSkillLater(skill: SkillState): void {
      skills.register((editor) => editor.add(skill));
    },
    /** The skill list as OpenCode reads it now. */
    skillList(): SkillState[] {
      const map = new SkillMap();
      skills.replay(map);
      return map.list();
    },
    /** The MCP server map as OpenCode reads it now, from the configured servers. */
    serverMap(seed: Record<string, ServerState>): Map<string, ServerState> {
      const state = new Map<string, ServerState>(Object.entries(seed).map(([name, value]) => [name, { ...value }]));
      servers.replay(new ServerMap(state));
      return state;
    },
  };
}

const BUILTINS = ["browser", "opencode", "report"];

/** The ids OpenCode advertises: described and not autoinvoke: false. */
function advertised(list: SkillState[]): string[] {
  return list
    .filter((skill) => skill.description !== undefined && skill.autoinvoke !== false)
    .map((skill) => skill.id)
    .sort();
}

/** Waits for a condition the plugin reaches asynchronously; fails after two seconds. */
async function waitFor(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 2000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("the plugin did not reach the expected state");
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

describe("skills-cutover plugin: skill list", () => {
  test("keeps the builtins advertised and hides every other skill, including one registered after the plugin", async () => {
    const runtime = fakeOpenCode();
    runtime.seedSkill({ id: "opencode", description: "about opencode" });
    runtime.seedSkill({ id: "report", description: "report a bug" });
    runtime.seedSkill({ id: "browser", description: "browse" });
    runtime.seedSkill({ id: "configured", description: "from config" });
    const cleanup = await plugin.setup(runtime.context);
    runtime.addSkillLater({ id: "late", description: "from a later plugin" });

    runtime.bus.emit("plugin.updated");
    await waitFor(() => advertised(runtime.skillList()).join() === BUILTINS.join());

    expect(advertised(runtime.skillList())).toEqual(BUILTINS);
    await cleanup();
  });

  test("before plugin.updated, a skill registered after the plugin is still advertised: the re-application hides it", async () => {
    const runtime = fakeOpenCode();
    await plugin.setup(runtime.context);
    runtime.addSkillLater({ id: "late", description: "from a later plugin" });

    expect(advertised(runtime.skillList())).toEqual(["late"]);
  });

  test("hiding sets autoinvoke and never removes the skill, so it stays loadable by id", async () => {
    const runtime = fakeOpenCode();
    runtime.seedSkill({ id: "configured", description: "from config" });
    await plugin.setup(runtime.context);
    runtime.bus.emit("plugin.updated");
    await waitFor(() => runtime.skillList()[0]?.autoinvoke === false);

    expect(runtime.skillList().map((skill) => skill.id)).toEqual(["configured"]);
  });

  test("holds one hiding transform however many activations happen", async () => {
    const runtime = fakeOpenCode();
    await plugin.setup(runtime.context);
    const first = runtime.skills.entries[0];

    runtime.bus.emit("plugin.updated");
    await waitFor(() => runtime.skills.entries[0] !== first);
    const second = runtime.skills.entries[0];
    runtime.bus.emit("plugin.updated");
    await waitFor(() => runtime.skills.entries[0] !== second);

    expect(runtime.skills.entries).toHaveLength(1);
  });

  test("after cleanup, an activation no longer changes the skill transforms", async () => {
    const runtime = fakeOpenCode();
    const cleanup = await plugin.setup(runtime.context);
    const live = runtime.skills.entries[0];
    runtime.bus.emit("plugin.updated");
    await waitFor(() => runtime.skills.entries[0] !== live);

    await cleanup();
    runtime.bus.emit("plugin.updated");
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(runtime.skills.entries).toHaveLength(0);
  });
});

describe("skills-cutover plugin: MCP servers", () => {
  test("disables the vercel server and leaves the other servers as they were", async () => {
    const runtime = fakeOpenCode();
    await plugin.setup(runtime.context);

    const servers = runtime.serverMap({ vercel: {}, skills: {}, "agent-desktop": {} });

    expect(servers.get("vercel")?.disabled).toBe(true);
    expect(servers.get("skills")?.disabled).toBeUndefined();
    expect(servers.get("agent-desktop")?.disabled).toBeUndefined();
  });

  test("does nothing when vercel is not registered", async () => {
    const runtime = fakeOpenCode();
    await plugin.setup(runtime.context);

    const servers = runtime.serverMap({ skills: {} });

    expect([...servers.keys()]).toEqual(["skills"]);
  });
});
