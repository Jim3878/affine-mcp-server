// NineDay: workspace member listing, and the name/email -> user id resolution that
// member-typed document properties build on.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { GraphQLClient } from "../graphqlClient.js";
import { text } from "../util/mcp.js";

export type WorkspaceMember = {
  id: string;
  name: string | null;
  email: string | null;
  avatarUrl: string | null;
  role: string | null;
  status: string | null;
};

const MEMBER_PAGE_SIZE = 100;
/** Hard stop for the paging loop; a workspace this large should use `query` instead. */
const MAX_MEMBERS = 2000;

const MEMBERS_QUERY = `query WorkspaceMembers($id:String!,$skip:Int,$take:Int,$query:String){
  workspace(id:$id){ memberCount members(skip:$skip,take:$take,query:$query){ id name email avatarUrl role status } }
}`;

type MembersResponse = {
  workspace: { memberCount: number; members: Array<Record<string, unknown>> };
};

function toMember(raw: Record<string, unknown>): WorkspaceMember {
  const str = (value: unknown) => (typeof value === "string" && value.length > 0 ? value : null);
  return {
    id: String(raw.id ?? ""),
    name: str(raw.name),
    email: str(raw.email),
    avatarUrl: str(raw.avatarUrl),
    role: str(raw.role),
    status: str(raw.status),
  };
}

/** Fetch one page of workspace members; needs the Workspace.Users.Read permission (any member has it). */
export async function fetchWorkspaceMemberPage(
  gql: GraphQLClient,
  workspaceId: string,
  options: { skip?: number; take?: number; query?: string } = {},
): Promise<{ memberCount: number; members: WorkspaceMember[] }> {
  const data = await gql.request<MembersResponse>(MEMBERS_QUERY, {
    id: workspaceId,
    skip: options.skip ?? 0,
    take: options.take ?? MEMBER_PAGE_SIZE,
    query: options.query?.trim() ? options.query.trim() : null,
  });
  return {
    memberCount: data.workspace.memberCount,
    members: data.workspace.members.map(toMember).filter(member => member.id),
  };
}

/** Fetch every member of a workspace (paged). */
export async function fetchAllWorkspaceMembers(gql: GraphQLClient, workspaceId: string): Promise<WorkspaceMember[]> {
  const all: WorkspaceMember[] = [];
  const seen = new Set<string>();
  for (let skip = 0; skip < MAX_MEMBERS; skip += MEMBER_PAGE_SIZE) {
    const page = await fetchWorkspaceMemberPage(gql, workspaceId, { skip, take: MEMBER_PAGE_SIZE });
    for (const member of page.members) {
      if (seen.has(member.id)) continue;
      seen.add(member.id);
      all.push(member);
    }
    if (page.members.length < MEMBER_PAGE_SIZE) break;
  }
  return all;
}

/**
 * Resolve user ids, emails, or display names to workspace members.
 * Order of precedence per reference: exact id, then email, then a unique display name.
 * Throws when a reference matches nobody or a name matches more than one member, so a
 * typo never silently assigns the wrong person. Duplicates collapse, input order is kept.
 */
export function resolveMemberReferences(members: WorkspaceMember[], references: string[]): WorkspaceMember[] {
  const resolved: WorkspaceMember[] = [];
  const seen = new Set<string>();
  for (const reference of references) {
    const wanted = reference.trim();
    if (!wanted) continue;
    const lowered = wanted.toLowerCase();
    let match = members.find(member => member.id === wanted)
      ?? members.find(member => (member.email || "").toLowerCase() === lowered);
    if (!match) {
      const byName = members.filter(member => (member.name || "").trim().toLowerCase() === lowered);
      if (byName.length > 1) {
        throw new Error(
          `Member name "${wanted}" is ambiguous (${byName.length} matches). Use the user id or email from list_workspace_members instead.`,
        );
      }
      match = byName[0];
    }
    if (!match) {
      throw new Error(
        `No workspace member matches "${wanted}". Call list_workspace_members to see the available ids, names, and emails.`,
      );
    }
    if (seen.has(match.id)) continue;
    seen.add(match.id);
    resolved.push(match);
  }
  return resolved;
}

export function registerMemberTools(server: McpServer, gql: GraphQLClient, defaults: { workspaceId?: string }) {
  const listWorkspaceMembersHandler = async (parsed: {
    workspaceId?: string;
    query?: string;
    skip?: number;
    take?: number;
  }) => {
    const workspaceId = parsed.workspaceId || defaults.workspaceId;
    if (!workspaceId) {
      throw new Error("workspaceId is required. Provide it as a parameter or set AFFINE_WORKSPACE_ID in environment.");
    }
    const skip = parsed.skip ?? 0;
    const take = parsed.take ?? 50;
    const page = await fetchWorkspaceMemberPage(gql, workspaceId, { skip, take, query: parsed.query });
    return text({
      workspaceId,
      memberCount: page.memberCount,
      members: page.members,
      skip,
      take,
      query: parsed.query?.trim() || null,
      hasMore: !parsed.query?.trim() && skip + page.members.length < page.memberCount,
    });
  };
  server.registerTool(
    "list_workspace_members",
    {
      title: "List Workspace Members",
      description:
        "List or search the members of a workspace (id, name, email, role, status). Use the returned ids, emails, or unique names as the value of a member-typed document property in set_doc_property.",
      inputSchema: {
        workspaceId: z.string().min(1).optional().describe("AFFiNE workspace id. Omit only when AFFINE_WORKSPACE_ID is configured."),
        query: z.string().max(255).optional().describe("Optional search text matched by AFFiNE against member name and email."),
        skip: z.number().int().min(0).max(1_000_000).optional().describe("Zero-based offset (default 0)."),
        take: z.number().int().min(1).max(MEMBER_PAGE_SIZE).optional().describe(`Page size (default 50, maximum ${MEMBER_PAGE_SIZE}).`),
      },
    },
    listWorkspaceMembersHandler as any,
  );
}
