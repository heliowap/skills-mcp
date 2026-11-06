import { describe, expect, test } from "bun:test";
import { MAX_CHOICE_OPTIONS, shardOf } from "../../src/rank/shard";

const items = (n: number) => Array.from({ length: n }, (_, i) => i);

describe("shardOf", () => {
  test("splits 175 candidates at shardSize 120 into 120 and 55, keeping order", () => {
    const shards = shardOf(items(175), 120);

    expect(shards.map((s) => s.length)).toEqual([120, 55]);
    expect(shards.flat()).toEqual(items(175));
  });

  test("never yields a shard above 255 options, even when shardSize asks for more", () => {
    const shards = shardOf(items(600), 1000);

    expect(Math.max(...shards.map((s) => s.length))).toBe(MAX_CHOICE_OPTIONS);
    expect(shards.flat()).toEqual(items(600));
  });

  test("an empty list yields no shards", () => {
    expect(shardOf([], 120)).toEqual([]);
  });

  test("rejects a shardSize that is not a positive integer", () => {
    expect(() => shardOf(items(3), 0)).toThrow(RangeError);
    expect(() => shardOf(items(3), 2.5)).toThrow(RangeError);
  });
});
