import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Extension } from "@earendil-works/pi-coding-agent";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getExtensionPackageName, selectImpExtensions, shouldIncludeExtension } from "../src/session.js";

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

  // unpopulated-sourceInfo fixtures: packages referenced by resolvedPath only
  const piWardDir = join(root, "node_modules", "pi-ward");
  mkdirSync(join(piWardDir, "src"), { recursive: true });
  writeFileSync(join(piWardDir, "package.json"), JSON.stringify({ name: "pi-ward" }));
  writeFileSync(join(piWardDir, "src", "index.ts"), "export default () => {}");

  const piImpsDir = join(root, "node_modules", "pi-imps");
  mkdirSync(join(piImpsDir, "src"), { recursive: true });
  writeFileSync(join(piImpsDir, "package.json"), JSON.stringify({ name: "pi-imps" }));
  writeFileSync(join(piImpsDir, "src", "index.ts"), "export default () => {}");
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

  it("falls back to filename (minus .ts) for extension directory without package.json", () => {
    const ext = makeExtStub({
      origin: "top-level",
      source: "auto",
      baseDir: root,
      path: join(root, "extensions", "bar-ext", "src", "index.ts"),
    });
    // No package.json in bar-ext/src/ or bar-ext/ → falls back to basename
    expect(getExtensionPackageName(ext)).toBe("index");
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

  it("falls back to filename (minus .ts) when no package.json found anywhere in path", () => {
    // Paths that don't exist on the filesystem → no package.json found walking up
    const ext = makeExtStub({
      origin: "top-level",
      source: "auto",
      baseDir: undefined,
      path: "/some/random/path/myext.ts",
    });
    expect(getExtensionPackageName(ext)).toBe("myext");
  });

  it("uses nearest package.json not arbitrary parent", () => {
    // bar-ext has no package.json, so the walk goes past it — basename fallback
    const ext = makeExtStub({
      origin: "top-level",
      source: "auto",
      baseDir: root,
      path: join(root, "extensions", "bar-ext", "src", "index.ts"),
    });
    expect(getExtensionPackageName(ext)).toBe("index");
  });
});

// ─── unpopulated sourceInfo (pre-applyExtensionSourceInfo) ────────────────

describe("getExtensionPackageName — unpopulated sourceInfo", () => {
  it("resolves name via resolvedPath walk when origin='top-level' and baseDir is absent", () => {
    // Simulate the defaults present BEFORE applyExtensionSourceInfo() populates sourceInfo:
    // origin defaults to 'top-level', baseDir is undefined.
    // resolvedPath still points to the real file on disk.
    const ext: Extension = {
      path: join(root, "node_modules", "pi-ward", "src", "index.ts"),
      resolvedPath: join(root, "node_modules", "pi-ward", "src", "index.ts"),
      sourceInfo: {
        path: join(root, "node_modules", "pi-ward", "src", "index.ts"),
        source: "auto",
        scope: "user",
        origin: "top-level", // unpopulated default
        baseDir: undefined, // unpopulated default
      },
      handlers: new Map(),
      tools: new Map(),
      messageRenderers: new Map(),
      commands: new Map(),
      flags: new Map(),
      shortcuts: new Map(),
    } as unknown as Extension;
    expect(getExtensionPackageName(ext)).toBe("pi-ward");
  });
});

describe("shouldIncludeExtension — unpopulated sourceInfo", () => {
  function makeUnpopulatedExt(pkgDir: string, toolNames: string[]): Extension {
    const filePath = join(root, "node_modules", pkgDir, "src", "index.ts");
    const tools = new Map<string, unknown>();
    for (const t of toolNames) tools.set(t, {});
    return {
      path: filePath,
      resolvedPath: filePath,
      sourceInfo: {
        path: filePath,
        source: "auto",
        scope: "user",
        origin: "top-level" as const, // unpopulated default (not yet "package")
        baseDir: undefined, // unpopulated default
      },
      handlers: new Map(),
      tools: tools as Extension["tools"],
      messageRenderers: new Map(),
      commands: new Map(),
      flags: new Map(),
      shortcuts: new Map(),
    } as unknown as Extension;
  }

  it("excludes pi-imps (no recursion) even when sourceInfo is unpopulated", () => {
    const ext = makeUnpopulatedExt("pi-imps", ["summon", "wait", "dismiss", "list_imps"]);
    // Without allowlist
    expect(shouldIncludeExtension(ext, undefined, [])).toBe(false);
    // With allowlist that includes pi-imps tools
    expect(shouldIncludeExtension(ext, ["summon", "wait"], [])).toBe(false);
  });

  it("force-keeps additionalExtension when sourceInfo is unpopulated, even under restrictive allowlist", () => {
    const ext = makeUnpopulatedExt("pi-ward", ["guard_check"]);
    // guard_check is NOT in the allowlist, but pi-ward is in additionalExtensions
    expect(shouldIncludeExtension(ext, ["read", "edit"], ["pi-ward"])).toBe(true);
    // Empty allowlist — same: force-kept
    expect(shouldIncludeExtension(ext, [], ["pi-ward"])).toBe(true);
    // Not in additionalExtensions + restrictive allowlist → excluded
    expect(shouldIncludeExtension(ext, ["read", "edit"], [])).toBe(false);
  });
});

// ─── selectImpExtensions ───────────────────────────────────────────────────

describe("selectImpExtensions", () => {
  const selRoot = join(tmpdir(), `pi-imps-select-test-${Date.now()}`);

  beforeAll(() => {
    for (const name of ["pi-imps", "pi-ward", "pi-sandbox", "pi-medium"]) {
      const dir = join(selRoot, "node_modules", name, "src");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(selRoot, "node_modules", name, "package.json"), JSON.stringify({ name }));
    }
  });

  afterAll(() => {
    rmSync(selRoot, { recursive: true, force: true });
  });

  function makePkgExt(pkgDir: string, toolNames: string[]): Extension {
    const filePath = join(selRoot, "node_modules", pkgDir, "src", "index.ts");
    const tools = new Map<string, unknown>();
    for (const t of toolNames) tools.set(t, {});
    return {
      path: filePath,
      resolvedPath: filePath,
      sourceInfo: {
        path: filePath,
        source: `npm:${pkgDir}@1.0.0`,
        scope: "user",
        origin: "package" as const,
        baseDir: join(selRoot, "node_modules", pkgDir),
      },
      handlers: new Map(),
      tools: tools as Extension["tools"],
      messageRenderers: new Map(),
      commands: new Map(),
      flags: new Map(),
      shortcuts: new Map(),
    } as unknown as Extension;
  }

  it("filters a mixed collection: excludes pi-imps, keeps additionalExtensions, keeps allowed tools, drops disallowed", () => {
    const impsExt = makePkgExt("pi-imps", ["summon", "wait"]);
    const wardExt = makePkgExt("pi-ward", ["guard_check"]); // additionalExtensions, tool not allowed
    const sandboxExt = makePkgExt("pi-sandbox", ["read"]); // allowed tool
    const disallowedExt = makePkgExt("pi-medium", ["fetch_content"]); // not allowed, not additional
    const inlineExt = {
      path: "<inline:1>",
      resolvedPath: "<inline:1>",
      sourceInfo: { path: "<inline:1>", source: "temporary", scope: "user", origin: "top-level", baseDir: undefined },
      handlers: new Map(),
      tools: new Map(),
      messageRenderers: new Map(),
      commands: new Map(),
      flags: new Map(),
      shortcuts: new Map(),
    } as unknown as Extension;

    const extensions = [impsExt, wardExt, sandboxExt, disallowedExt, inlineExt];
    const result = selectImpExtensions(extensions, ["read"], ["pi-ward"]);

    // Exact expected object identities, in original relative order.
    expect(result).toEqual([wardExt, sandboxExt, inlineExt]);
    expect(result[0]).toBe(wardExt);
    expect(result[1]).toBe(sandboxExt);
    expect(result[2]).toBe(inlineExt);
  });

  it("does not mutate the input array", () => {
    const sandboxExt = makePkgExt("pi-sandbox", ["read"]);
    const disallowedExt = makePkgExt("pi-medium", ["fetch_content"]);
    const extensions = [sandboxExt, disallowedExt];
    const snapshot = [...extensions];

    selectImpExtensions(extensions, ["read"], []);

    expect(extensions).toEqual(snapshot);
    expect(extensions.length).toBe(2);
  });

  it("undefined allowlist keeps all non-excluded extensions (parity with shouldIncludeExtension)", () => {
    const sandboxExt = makePkgExt("pi-sandbox", ["read"]);
    const disallowedExt = makePkgExt("pi-medium", ["fetch_content"]);
    const impsExt = makePkgExt("pi-imps", ["summon"]);

    const result = selectImpExtensions([sandboxExt, disallowedExt, impsExt], undefined, []);

    expect(result).toEqual([sandboxExt, disallowedExt]);
  });

  it("empty allowlist keeps only additionalExtensions (parity with shouldIncludeExtension)", () => {
    const sandboxExt = makePkgExt("pi-sandbox", ["read"]);
    const disallowedExt = makePkgExt("pi-medium", ["fetch_content"]);

    const result = selectImpExtensions([sandboxExt, disallowedExt], [], ["pi-sandbox"]);

    expect(result).toEqual([sandboxExt]);
  });
});
