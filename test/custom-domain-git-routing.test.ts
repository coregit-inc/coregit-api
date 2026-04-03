import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { customDomainGit } from "../src/routes/custom-domain-git";

describe("customDomainGit routing", () => {
  it("passes standard info/refs requests through when customDomain is not set", async () => {
    const app = new Hono();
    app.route("/", customDomainGit);
    app.get("/:org/:repo/info/refs", (c) => c.text("standard-git-route"));

    const res = await app.request(
      "/strayl/demo.git/info/refs?service=git-upload-pack",
    );

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("standard-git-route");
  });

  it("passes standard git-upload-pack requests through when customDomain is not set", async () => {
    const app = new Hono();
    app.route("/", customDomainGit);
    app.post("/:org/:repo/git-upload-pack", (c) =>
      c.text("standard-upload-pack"),
    );

    const res = await app.request("/strayl/demo.git/git-upload-pack", {
      method: "POST",
    });

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("standard-upload-pack");
  });
});
