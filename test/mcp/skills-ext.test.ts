import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { createApp } from "../../src/app";
import { connectInProcess, type InProcessClient } from "../../src/mcp/inprocess";
import { buildServer } from "../../src/mcp/server";
import { ANTHROPICS, useSandbox } from "./helpers";

useSandbox();

const SkillsListSchema = z.object({
  skills: z.array(
    z.object({
      uri: z.string(),
      frontmatter: z.object({ name: z.string(), description: z.string() }),
      resources: z.unknown(),
    }),
  ),
});

const ResourceReadSchema = z.object({ contents: z.array(z.object({ text: z.string().optional() })) });

async function connect(): Promise<InProcessClient> {
  return connectInProcess(buildServer(await createApp()));
}

describe("skills extension over the catalog", () => {
  test("skills/list serves every catalog skill with its frontmatter, and resources are dynamic", async () => {
    const client = await connect();

    const result = await client.request("skills/list", SkillsListSchema);

    expect(result.skills.map((skill) => skill.frontmatter.name).sort()).toEqual(["docx", "pdf"]);
    expect(result.skills.every((skill) => skill.resources === "dynamic")).toBe(true);
  });

  test("resources/read serves a skill file by its skill:// URI, byte for byte", async () => {
    const client = await connect();

    const result = await client.request("resources/read", ResourceReadSchema, { uri: "skill://pdf/forms.md" });
    const expected = await readFile(join(ANTHROPICS, "skills", "pdf", "forms.md"), "utf8");

    expect(result.contents[0]?.text).toBe(expected);
  });

  test("resources/read serves SKILL.md itself, with its frontmatter, so a client can parse the skill", async () => {
    const client = await connect();

    const result = await client.request("resources/read", ResourceReadSchema, { uri: "skill://pdf/SKILL.md" });
    const expected = await readFile(join(ANTHROPICS, "skills", "pdf", "SKILL.md"), "utf8");

    expect(result.contents[0]?.text).toBe(expected);
    expect(result.contents[0]?.text?.startsWith("---\nname: pdf\n")).toBe(true);
  });

  test("a skill:// URI that climbs out of its skill is refused", async () => {
    const client = await connect();

    await expect(
      client.request("resources/read", z.unknown(), { uri: "skill://pdf/../docx/SKILL.md" }),
    ).rejects.toThrow();
  });
});
