/**
 * Server part of the skills cutover (docs/cutover.md). OpenCode loads this directory from the `plugins`
 * array of opencode.jsonc. It keeps the builtin skills in OpenCode's native list, hides every other skill
 * from that list (they stay loadable by id), and disables the `vercel` MCP server that vercel-plugin
 * registers from its .mcp.json.
 *
 * The file imports nothing: OpenCode runs it as-is, so the SDK shapes it uses are declared below.
 */

/** Skills that stay in the native list (decision D1, option A). */
export const BUILTIN_SKILL_IDS: readonly string[] = ["opencode", "report", "browser"];

/** MCP servers that a plugin registers and config cannot switch off. */
export const PLUGIN_MCP_SERVER_IDS: readonly string[] = ["vercel"];

/** Emitted after a plugin activation has registered every plugin's transforms. */
const ACTIVATED_EVENT = "plugin.updated";

interface SkillDraft {
  readonly id: string;
  autoinvoke?: boolean;
}

export interface SkillEditor {
  list(): readonly SkillDraft[];
  update(id: string, update: (skill: SkillDraft) => void): void;
}

interface ServerDraft {
  disabled?: boolean;
}

export interface McpEditor {
  get(name: string): ServerDraft | undefined;
  update(name: string, update: (server: ServerDraft) => void): void;
}

interface Registration {
  dispose(): Promise<void>;
}

export interface CutoverContext {
  skill: { transform(callback: (editor: SkillEditor) => void): Promise<Registration> };
  mcp: { transform(callback: (editor: McpEditor) => void): Promise<Registration> };
  event: { subscribe(input: { types: string[]; signal?: AbortSignal }): AsyncIterable<{ type: string }> };
}

/** Sets autoinvoke to false on every skill except the builtins; `opencode/autoinvoke: false` in OpenCode's docs. */
export function hideNonBuiltinSkills(editor: SkillEditor): void {
  for (const skill of editor.list()) {
    if (BUILTIN_SKILL_IDS.includes(skill.id)) continue;
    editor.update(skill.id, (draft) => {
      draft.autoinvoke = false;
    });
  }
}

/** Disables the plugin-registered MCP servers; `update` does nothing when a server is not registered. */
export function disablePluginMcpServers(editor: McpEditor): void {
  for (const name of PLUGIN_MCP_SERVER_IDS) {
    if (editor.get(name) === undefined) continue;
    editor.update(name, (server) => {
      server.disabled = true;
    });
  }
}

export default {
  id: "skills-cutover",

  async setup(ctx: CutoverContext): Promise<() => Promise<void>> {
    // Config-scanned and compatibility skills register after this plugin (OpenCode runs configured
    // plugins before its own post-plugins), and a later registration of the same id replaces the whole
    // skill. So the hiding transform is registered again on every activation, after those skills exist,
    // and the previous registration is disposed so exactly one stays live.
    let current: Registration | undefined;
    let queued: Promise<void> = Promise.resolve();
    const apply = (): Promise<void> => {
      queued = queued
        .then(async () => {
          const next = await ctx.skill.transform(hideNonBuiltinSkills);
          const previous = current;
          current = next;
          await previous?.dispose();
        })
        .catch((error: unknown) => {
          console.error("skills-cutover: could not hide skills", error);
        });
      return queued;
    };

    await apply();
    await ctx.mcp.transform(disablePluginMcpServers);

    const stop = new AbortController();
    void (async () => {
      try {
        for await (const _event of ctx.event.subscribe({ types: [ACTIVATED_EVENT], signal: stop.signal })) {
          void apply();
        }
      } catch (error) {
        if (!stop.signal.aborted) console.error("skills-cutover: activation events stopped", error);
      }
    })();

    return async () => {
      stop.abort();
      await queued;
      await current?.dispose();
      current = undefined;
    };
  },
};
