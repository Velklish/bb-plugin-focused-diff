import { expect, it } from "vitest";
import { changedPaths } from "./tracking";

it("tracks successful source and destination paths without duplicates", () => {
  const change = { type: "item/completed", data: { item: { type: "fileChange", status: "completed", changes: [{ path: "/first/A.cs", movePath: "/second/B.cs" }, { path: "/first/A.cs" }] } } };
  expect(changedPaths([change])).toEqual(["/first/A.cs", "/second/B.cs"]);
});
it("ignores read-only commands, pending changes, failed changes and malformed events", () => {
  expect(changedPaths([
    { type: "item/completed", data: { item: { type: "commandExecution", command: "cat A.cs" } } },
    { type: "item/started", data: { item: { type: "fileChange", status: "pending", changes: [{ path: "A.cs" }] } } },
    { type: "item/completed", data: { item: { type: "fileChange", status: "failed", changes: [{ path: "A.cs" }] } } },
    { type: "item/completed", data: null },
  ])).toEqual([]);
});
