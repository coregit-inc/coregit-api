import { describe, it, expect } from "vitest";
import { resolveSearchTargets } from "../src/services/fork-resolver";
import type { Repo } from "../src/db/schema";

const baseRepo: Repo = {
  id: "child-id",
  orgId: "child-org",
  namespace: null,
  slug: "child",
  description: null,
  defaultBranch: "main",
  visibility: "private",
  autoIndex: false,
  isTemplate: false,
  forkedFromRepoId: null,
  forkedFromOrgId: null,
  forkedAt: null,
  forkRoot: "child-id",
  forkDepth: 0,
  forkChain: [],
  forkMode: "instant",
  createdAt: new Date(),
  wikiConfig: null,
  updatedAt: new Date(),
};

describe("resolveSearchTargets", () => {
  it("returns only self for non-fork repo", () => {
    const t = resolveSearchTargets(baseRepo);
    expect(t.selfNs).toBe("child-org/child-id");
    expect(t.parentNs).toBeNull();
    expect(t.parentRepoId).toBeNull();
    expect(t.graphRepoIds).toEqual(["child-id"]);
  });

  it("returns self + parent namespace for instant fork", () => {
    const fork: Repo = {
      ...baseRepo,
      forkedFromRepoId: "parent-id",
      forkedFromOrgId: "parent-org",
      forkedAt: new Date(),
      forkRoot: "parent-id",
      forkDepth: 1,
      forkChain: ["parent-id"],
      forkMode: "instant",
    };
    const t = resolveSearchTargets(fork);
    expect(t.selfNs).toBe("child-org/child-id");
    expect(t.parentNs).toBe("parent-org/parent-id");
    expect(t.parentRepoId).toBe("parent-id");
    expect(t.graphRepoIds).toEqual(["child-id", "parent-id"]);
  });

  it("treats deep/copied forks as self-contained — no parent fan-out", () => {
    // 'copied' forks have all blobs/graph already materialized into their own
    // namespace, so search routes do NOT need to query the parent.
    const copied: Repo = {
      ...baseRepo,
      forkedFromRepoId: "parent-id",
      forkedFromOrgId: "parent-org",
      forkMode: "copied",
    };
    expect(resolveSearchTargets(copied).parentNs).toBeNull();
    expect(resolveSearchTargets(copied).graphRepoIds).toEqual(["child-id"]);

    const deep: Repo = { ...copied, forkMode: "deep" };
    expect(resolveSearchTargets(deep).parentNs).toBeNull();
  });
});
