import { expect, test } from "bun:test";

test("throwaway failure for the CI gate check", () => {
  expect(1).toBe(2);
});
