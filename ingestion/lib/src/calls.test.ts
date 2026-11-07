import assert from "node:assert/strict";
import { test } from "node:test";
import { describeError } from "#src/calls.ts";

test("an AggregateError without a message is described by the errors inside it", () => {
  const refused = new AggregateError([
    new Error("connect ECONNREFUSED ::1:5432"),
    new Error("connect ECONNREFUSED 127.0.0.1:5432"),
  ]);
  assert.equal(describeError(refused), "connect ECONNREFUSED ::1:5432; connect ECONNREFUSED 127.0.0.1:5432");
});
