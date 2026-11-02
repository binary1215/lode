import path from "node:path";

// Loaded only by an exact-parent test module hook. It simulates SDK discovery,
// metadata views and EOF; it supplies no OS, actual SDK or model-call evidence.
export async function openCodexNativeRegistrationRpc() {
  const fixture = globalThis[Symbol.for("lode-test-native-registration")];
  if (!fixture) throw Error("Native metadata fixture context is missing");
  fixture.starts++;
  for (const file of fixture.files)
    if (!fixture.state.db.prepare("SELECT id FROM threads WHERE id=?").get(file.threadId))
      fixture.state.row("threads", {
        id: file.threadId,
        rollout_path: path.join(fixture.target, file.path),
        cwd: fixture.cwd,
        model: "SDK_DISCOVERED_SOURCE",
        model_provider: "synthetic",
        reasoning_effort: "low",
        sandbox_policy: "read-only",
        approval_mode: "never",
      });
  return {
    assertExclusiveWriter: async () => {},
    async request(method, params) {
      fixture.calls.push({ method, threadId: params.threadId ?? null });
      if (method === "config/read")
        return {
          config: {
            model: "CURRENT_TARGET",
            model_provider: "synthetic",
            approval_policy: "never",
            sandbox_mode: "read-only",
            model_reasoning_effort: "low",
            service_tier: null,
            approvals_reviewer: "user",
          },
        };
      if (method === "thread/resume") {
        fixture.state.db
          .prepare("UPDATE threads SET model=? WHERE id=?")
          .run(params.model, params.threadId);
        return {
          thread: {
            id: params.threadId,
            cwd: fixture.cwd,
            environments: [
              { environmentId: "local", cwd: fixture.cwd, runtimeWorkspaceRoots: [fixture.cwd] },
            ],
          },
          cwd: fixture.cwd,
          runtimeWorkspaceRoots: [fixture.cwd],
          model: params.model,
          modelProvider: params.modelProvider,
          approvalPolicy: params.approvalPolicy,
          reasoningEffort: "low",
          serviceTier: params.serviceTier,
          approvalsReviewer: "user",
          activePermissionProfile: null,
          sandbox: { type: "readOnly", networkAccess: false },
        };
      }
      if (method === "thread/read")
        return {
          thread: {
            id: params.threadId,
            path: path.join(
              fixture.target,
              fixture.files.find((file) => file.threadId === params.threadId).path,
            ),
            cwd: fixture.cwd,
          },
        };
      const expected = fixture.expectations.get(params.threadId);
      if (method === "thread/turns/list")
        return {
          data: expected.turns.map((turn) => ({
            ...turn,
            itemsView: "full",
            items: expected.items
              .filter((item) => item.turnId === turn.id)
              .map((item) => ({
                ...item.item,
                startedAtMs: item.startedAtMs,
                completedAtMs: item.completedAtMs,
              })),
          })),
          nextCursor: null,
        };
      if (method === "thread/items/list") return { data: expected.items, nextCursor: null };
      if (method === "thread/unsubscribe") return {};
      throw Error("Unexpected fixture RPC method");
    },
    async close() {
      fixture.closes++;
      if (fixture.changeAtFirstClose && fixture.closes === 1)
        fixture.state.db
          .prepare("UPDATE threads SET model=? WHERE id=?")
          .run("EXTERNAL_TARGET_EDIT", fixture.second);
      return { cleanup: { treeCleanupVerified: true } };
    },
  };
}
