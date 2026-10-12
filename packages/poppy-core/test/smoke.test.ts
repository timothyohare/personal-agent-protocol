import { expect, test } from "vitest";
import * as core from "../src/index.ts";

test("poppy-core loads", () => {
  expect(core).toBeTypeOf("object");
});
