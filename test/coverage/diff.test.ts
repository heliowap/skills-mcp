import { describe, expect, test } from "bun:test";
import {
  CoverageError,
  type ServedSkill,
  type SkillLocation,
  diffCoverage,
  exitCodeFor,
  parseOpenCodeSkills,
} from "../../scripts/coverage";

const located = (id: string, dir: string, digest: string = `digest of ${id}`): SkillLocation => ({ id, dir, digest });
const served = (id: string, dir: string, digest: string = `digest of ${id}`, sourceId = "local"): ServedSkill => ({
  id,
  dir,
  digest,
  sourceId,
});

describe("parseOpenCodeSkills", () => {
  test("reads the id and path of each registered skill", () => {
    const text = JSON.stringify({
      location: { directory: "/repo" },
      data: [
        { id: "tdd", name: "tdd", path: "/home/u/.agents/skills/tdd/SKILL.md", content: "# TDD" },
        { id: "opencode", name: "OpenCode", path: "/builtin/opencode.md", content: "# OpenCode" },
      ],
    });

    expect(parseOpenCodeSkills(text)).toEqual([
      { id: "tdd", path: "/home/u/.agents/skills/tdd/SKILL.md" },
      { id: "opencode", path: "/builtin/opencode.md" },
    ]);
  });

  test("rejects a response without a skill list, naming the missing field", () => {
    expect(() => parseOpenCodeSkills('{"location":{}}')).toThrow(CoverageError);
    expect(() => parseOpenCodeSkills('{"location":{}}')).toThrow(/data/);
  });

  test("rejects text that is not JSON", () => {
    expect(() => parseOpenCodeSkills("opencode: command not found")).toThrow(CoverageError);
  });
});

describe("diffCoverage", () => {
  test("a skill OpenCode registers that the catalog does not serve is missing", () => {
    const report = diffCoverage({
      opencode: [located("ghost", "/a/ghost")],
      builtins: [],
      served: [],
      shadowed: [],
    });

    expect(report.missing).toEqual(["ghost"]);
  });

  test("a served skill in the directory OpenCode resolves is matched", () => {
    const report = diffCoverage({
      opencode: [located("tdd", "/a/tdd")],
      builtins: [],
      served: [served("tdd", "/a/tdd")],
      shadowed: [],
    });

    expect(report.matched).toEqual(["tdd"]);
    expect(report.sameContent).toEqual([]);
    expect(report.differentWinner).toEqual([]);
    expect(report.missing).toEqual([]);
  });

  test("the same id in another directory with identical SKILL.md is matched by content", () => {
    const report = diffCoverage({
      opencode: [located("tdd", "/a/tdd", "same bytes")],
      builtins: [],
      served: [served("tdd", "/b/tdd", "same bytes", "claude")],
      shadowed: [],
    });

    expect(report.sameContent).toEqual([{ id: "tdd", opencodeDir: "/a/tdd", servedDir: "/b/tdd", sourceId: "claude" }]);
    expect(report.matched).toEqual([]);
    expect(report.differentWinner).toEqual([]);
    expect(report.missing).toEqual([]);
  });

  test("the same id in another directory with different SKILL.md is a different winner", () => {
    const report = diffCoverage({
      opencode: [located("tdd", "/a/tdd", "opencode bytes")],
      builtins: [],
      served: [served("tdd", "/b/tdd", "served bytes", "claude")],
      shadowed: [],
    });

    expect(report.differentWinner).toEqual([
      { id: "tdd", opencodeDir: "/a/tdd", servedDir: "/b/tdd", sourceId: "claude" },
    ]);
    expect(report.missing).toEqual([]);
  });

  test("a served skill OpenCode does not know is extra and does not count as missing", () => {
    const report = diffCoverage({
      opencode: [],
      builtins: [],
      served: [served("find-docs", "/c/find-docs", "x", "context7")],
      shadowed: [],
    });

    expect(report.extra).toEqual([{ id: "find-docs", sourceId: "context7" }]);
    expect(report.missing).toEqual([]);
  });

  test("builtins are listed apart and never counted as missing", () => {
    const report = diffCoverage({
      opencode: [],
      builtins: ["opencode", "report", "browser"],
      served: [],
      shadowed: [],
    });

    expect(report.builtins).toEqual(["opencode", "report", "browser"]);
    expect(report.missing).toEqual([]);
  });

  test("shadowed skills pass through with their winning source", () => {
    const report = diffCoverage({
      opencode: [],
      builtins: [],
      served: [],
      shadowed: [{ id: "arena", sourceId: "claude", by: "agents" }],
    });

    expect(report.shadowed).toEqual([{ id: "arena", sourceId: "claude", by: "agents" }]);
  });

  test("results are sorted by id so the summary is stable", () => {
    const report = diffCoverage({
      opencode: [located("zeta", "/z"), located("alpha", "/a")],
      builtins: [],
      served: [],
      shadowed: [],
    });

    expect(report.missing).toEqual(["alpha", "zeta"]);
  });
});

describe("exitCodeFor", () => {
  test("is 0 when nothing is missing and nothing is unresolved", () => {
    expect(exitCodeFor({ missing: [], unresolved: [] })).toBe(0);
  });

  test("is 1 when an OpenCode skill is missing from the catalog", () => {
    expect(exitCodeFor({ missing: ["ghost"], unresolved: [] })).toBe(1);
  });

  test("is 1 when an OpenCode skill file cannot be read, because it cannot be compared", () => {
    expect(exitCodeFor({ missing: [], unresolved: [{ id: "ghost", path: "/gone", reason: "no such file" }] })).toBe(1);
  });
});
