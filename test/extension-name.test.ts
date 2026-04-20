import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Extension } from "@mariozechner/pi-coding-agent";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getExtensionPackageName } from "../src/session.js";

// ─── temp fixture ──────────────────────────────────────────────────────────

const root = join(tmpdir(), `pi-imps-test-${Date.now()}`);

function makeExtStub(sourceInfo: Partial<Extension["sourceInfo"]>): Extension {
  return {
    path: sourceInfo.path ?? "",
    resolvedPath: sourceInfo.path ?? "",
    sourceInfo: {
      path: sourceInfo.path ?? "",
      source: sourceInfo.source ?? "auto",
      scope: sourceInfo.scope ?? "user",
      origin: sourceInfo.origin ?? "top-level",
      baseDir: sourceInfo.baseDir,
    },
    handlers: new Map(),
    tools: new Map(),
    messageRenderers: new Map(),
    commands: new Map(),
    flags: new Map(),
    shortcuts: new Map(),
  } as Extension;
}

beforeAll(() => {
  // npm package: root/node_modules/pi-sandbox/package.json
  const npmDir = join(root, "node_modules", "pi-sandbox");
  mkdirSync(join(npmDir, "src"), { recursive: true });
  writeFileSync(join(npmDir, "package.json"), JSON.stringify({ name: "pi-sandbox" }));

  // top-level structured: root/extensions/pi-medium/package.json
  const extDir = join(root, "extensions", "pi-medium", "src");
  mkdirSync(extDir, { recursive: true });
  writeFileSync(join(root, "extensions", "pi-medium", "package.json"), JSON.stringify({ name: "pi-medium" }));

  // top-level single file: root/extensions/foo.ts (no package.json)
  mkdirSync(join(root, "extensions"), { recursive: true });
  writeFileSync(join(root, "extensions", "foo.ts"), "export default () => {}");

  // top-level structured without package.json: root/extensions/bar-ext/src/index.ts
  mkdirSync(join(root, "extensions", "bar-ext", "src"), { recursive: true });
  writeFileSync(join(root, "extensions", "bar-ext", "src", "index.ts"), "export default () => {}");
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

// ─── tests ─────────────────────────────────────────────────────────────────

describe("getExtensionPackageName", () => {
  it("reads name from baseDir/package.json for package extensions", () => {
    const ext = makeExtStub({
      origin: "package",
      source: "npm:pi-sandbox@1.0.0",
      baseDir: join(root, "node_modules", "pi-sandbox"),
      path: join(root, "node_modules", "pi-sandbox", "src", "index.ts"),
    });
    expect(getExtensionPackageName(ext)).toBe("pi-sandbox");
  });

  it("reads name from package.json for structured top-level extension", () => {
    const ext = makeExtStub({
      origin: "top-level",
      source: "auto",
      baseDir: root,
      path: join(root, "extensions", "pi-medium", "src", "index.ts"),
    });
    expect(getExtensionPackageName(ext)).toBe("pi-medium");
  });

  it("falls back to directory name for top-level extension without package.json", () => {
    const ext = makeExtStub({
      origin: "top-level",
      source: "auto",
      baseDir: root,
      path: join(root, "extensions", "bar-ext", "src", "index.ts"),
    });
    expect(getExtensionPackageName(ext)).toBe("bar-ext");
  });

  it("falls back to filename (minus .ts) for single-file extension", () => {
    const ext = makeExtStub({
      origin: "top-level",
      source: "auto",
      baseDir: root,
      path: join(root, "extensions", "foo.ts"),
    });
    expect(getExtensionPackageName(ext)).toBe("foo");
  });

  it("returns undefined when baseDir is missing", () => {
    const ext = makeExtStub({
      origin: "top-level",
      source: "auto",
      baseDir: undefined,
      path: "/some/random/path/index.ts",
    });
    expect(getExtensionPackageName(ext)).toBeUndefined();
  });

  it("returns undefined when path does not start with baseDir/extensions/", () => {
    const ext = makeExtStub({
      origin: "top-level",
      source: "auto",
      baseDir: root,
      path: "/completely/different/path/index.ts",
    });
    expect(getExtensionPackageName(ext)).toBeUndefined();
  });
});
