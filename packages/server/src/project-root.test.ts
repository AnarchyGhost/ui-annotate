import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SourceInfo } from "@ui-annotate/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { replacesRoot } from "./domain.js";
import { acceptableRoot, gitTopLevel, rootFromAgent, rootFromPort, rootFromSources } from "./project-root.js";
import { freePort } from "./test-helpers.js";

let home: string;
let repo: string;

beforeAll(() => {
  // A fake home: ~/work/app is a repository with a package.json, ~/.ssh is not a project.
  home = realpathSync(mkdtempSync(join(tmpdir(), "ui-annotate-home-")));
  repo = join(home, "work", "app");
  mkdirSync(join(repo, ".git"), { recursive: true });
  mkdirSync(join(repo, "packages", "web", "src"), { recursive: true });
  writeFileSync(join(repo, "package.json"), "{}");
  writeFileSync(join(repo, "packages", "web", "src", "App.vue"), "<template/>");
  mkdirSync(join(home, ".ssh"));
  writeFileSync(join(home, ".ssh", "id_rsa"), "secret");
});

afterAll(() => rmSync(home, { recursive: true, force: true }));

const source = (file: string) => SourceInfo.parse({ framework: "vue", file });

describe("roots from paths", () => {
  it("lifts a file to the repository top level", () => {
    expect(gitTopLevel(join(repo, "packages", "web", "src", "App.vue"))).toBe(repo);
    expect(rootFromSources([source(join(repo, "packages", "web", "src", "App.vue"))], home)).toBe(repo);
  });

  it("reads /@fs/ dev-server URLs as absolute paths", () => {
    expect(rootFromSources([source(`http://localhost:5173/@fs${repo}/packages/web/src/App.vue`)], home)).toBe(repo);
  });

  it("refuses the home directory and paths a page could forge", () => {
    expect(acceptableRoot(home, home)).toBe(false);
    expect(acceptableRoot("/", home)).toBe(false);
    expect(rootFromSources([source(join(home, ".ssh", "id_rsa"))], home)).toBeNull();
    expect(rootFromSources([source("src/App.vue")], home)).toBeNull();
  });

  it("does not take the home directory even when it is a repository", () => {
    mkdirSync(join(home, ".git"), { recursive: true });
    writeFileSync(join(home, "package.json"), "{}");
    try {
      expect(rootFromSources([source(join(home, ".ssh", "id_rsa"))], home)).toBeNull();
      // Inside the project the nearest repository still wins.
      expect(rootFromSources([source(join(repo, "package.json"))], home)).toBe(repo);
    } finally {
      rmSync(join(home, ".git"), { recursive: true, force: true });
      rmSync(join(home, "package.json"));
    }
  });

  it("links an agent from inside the project and refuses one started in home", () => {
    expect(rootFromAgent(join(repo, "packages", "web"), home)).toBe(repo);
    expect(() => rootFromAgent(home, home)).toThrow(/not inside a project/);
  });

  it("accepts a repository without a root package.json from the agent and the port, not from page paths", () => {
    // A repository with .git at the top and package.json only in a subfolder.
    const plain = join(home, "work", "plain");
    mkdirSync(join(plain, ".git"), { recursive: true });
    mkdirSync(join(plain, "portal", "src"), { recursive: true });
    writeFileSync(join(plain, "portal", "package.json"), "{}");
    writeFileSync(join(plain, "portal", "src", "page.js"), "");
    expect(rootFromAgent(join(plain, "portal"), home)).toBe(plain);
    // Page paths need a marker: the nearest one, portal/, not the bare repository.
    expect(rootFromSources([source(join(plain, "portal", "src", "page.js"))], home)).toBe(join(plain, "portal"));
  });
});

describe.runIf(process.platform === "linux")("roots from the dev-server process", () => {
  const children: ChildProcess[] = [];
  afterAll(() => children.forEach((child) => child.kill()));

  async function listen(cwd: string): Promise<number> {
    const port = await freePort();
    const child = spawn(process.execPath, ["-e", `require("node:http").createServer((q, s) => s.end("ok")).listen(${port}, "127.0.0.1")`], { cwd });
    children.push(child);
    for (let i = 0; i < 50; i += 1) {
      if (await fetch(`http://127.0.0.1:${port}/`).then(() => true, () => false)) return port;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error("test server did not start");
  }

  it("finds the project of the process listening on the page port", async () => {
    const port = await listen(join(repo, "packages", "web"));
    expect(await rootFromPort(`http://localhost:${port}/portal/`, home)).toBe(repo);
  });

  it("takes a repository without package.json at the top (server started from the repo root)", async () => {
    const plain = join(home, "work", "served");
    mkdirSync(join(plain, ".git"), { recursive: true });
    mkdirSync(join(plain, "portal", "server"), { recursive: true });
    const port = await listen(plain);
    expect(await rootFromPort(`http://localhost:${port}/portal/`, home)).toBe(plain);
  });

  it("gives up on a process outside the home directory (proxy, container)", async () => {
    const port = await listen("/");
    expect(await rootFromPort(`http://127.0.0.1:${port}/`, home)).toBeNull();
  });

  it("ignores non-local pages and free ports", async () => {
    expect(await rootFromPort("https://example.com/", home)).toBeNull();
    expect(await rootFromPort(`http://localhost:${await freePort()}/`, home)).toBeNull();
  });
});

describe("replacesRoot", () => {
  it.each([
    [null, "port", true],
    [null, "path", true],
    ["port", "path", false],
    ["port", "agent", true],
    ["agent", "port", false],
    ["agent", "agent", true],
    ["agent", "manual", true],
    ["manual", "agent", false],
    ["manual", "manual", true],
  ] as const)("%s ← %s: %s", (current, next, expected) => {
    expect(replacesRoot(current, next)).toBe(expected);
  });
});
