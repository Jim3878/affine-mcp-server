#!/usr/bin/env node
/**
 * NineDay: member-typed document properties store workspace user ids. This covers the
 * id / email / display-name resolution that set_doc_property runs before writing.
 */
import assert from "node:assert/strict";

import { fetchAllWorkspaceMembers, resolveMemberReferences } from "../dist/tools/members.js";

const members = [
  { id: "u-1", name: "Alice", email: "alice@example.test", avatarUrl: null, role: "Owner", status: "Accepted" },
  { id: "u-2", name: "Bob", email: "Bob@Example.test", avatarUrl: null, role: "Collaborator", status: "Accepted" },
  { id: "u-3", name: "bob", email: "bob2@example.test", avatarUrl: null, role: "Collaborator", status: "Accepted" },
  { id: "u-4", name: null, email: "noname@example.test", avatarUrl: null, role: "Collaborator", status: "Accepted" },
];
const ids = references => resolveMemberReferences(members, references).map(member => member.id);

assert.deepEqual(ids(["u-1"]), ["u-1"], "exact id");
assert.deepEqual(ids(["ALICE@example.test"]), ["u-1"], "email is case-insensitive");
assert.deepEqual(ids([" alice "]), ["u-1"], "unique display name, trimmed and case-insensitive");
assert.deepEqual(ids(["bob@example.test"]), ["u-2"], "email wins even when the display name is ambiguous");
assert.deepEqual(ids(["u-4", "Alice", "u-1", "alice@example.test"]), ["u-4", "u-1"], "duplicates collapse, order kept");
assert.deepEqual(ids(["", "  "]), [], "blank references are ignored");
assert.throws(() => ids(["Bob"]), /ambiguous \(2 matches\)/, "ambiguous display name is rejected");
assert.throws(() => ids(["Carol"]), /No workspace member matches "Carol"/, "unknown reference is rejected");
assert.throws(() => ids(["u-1", "nobody"]), /No workspace member matches/, "one bad reference rejects the whole list");

// Paging: 100 per page until a short page arrives; repeated ids are dropped.
const calls = [];
const gql = {
  async request(_query, variables) {
    calls.push(variables);
    const page = variables.skip === 0
      ? Array.from({ length: 100 }, (_, i) => ({ id: `m-${i}`, name: `M${i}`, email: null, role: "Collaborator", status: "Accepted" }))
      : [{ id: "m-99" }, { id: "m-100", name: "Last" }, { id: "" }];
    return { workspace: { memberCount: 101, members: page } };
  },
};
const all = await fetchAllWorkspaceMembers(gql, "workspace-1");
assert.equal(all.length, 101, "all members across pages, without the repeated or empty id");
assert.deepEqual(calls.map(call => [call.skip, call.take]), [[0, 100], [100, 100]]);
assert.equal(all[100].name, "Last");
assert.equal(all[0].email, null);

console.log("Member resolution tests passed");
