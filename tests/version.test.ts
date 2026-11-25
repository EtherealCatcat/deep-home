import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { APP_VERSION } from "../src/version.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

describe("version single source", () => {
  it("keeps the runtime version equal to package.json", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as {
      version: string;
    };
    expect(pkg.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(APP_VERSION).toBe(pkg.version);
  });

  it("builds the outbound User-Agent from APP_VERSION", () => {
    const web = fs.readFileSync(path.join(root, "src/web.ts"), "utf8");
    // 必须是模板字符串：双引号里的 ${APP_VERSION} 只会被原样发出去。
    expect(web).toMatch(/"user-agent":\s*`[^`]*DeepHome\/\$\{APP_VERSION\}[^`]*`/);
    expect(web).not.toMatch(/DeepHome\/\d/);
  });

  it("points the Tauri bundle at the root package.json", () => {
    const tauri = JSON.parse(
      fs.readFileSync(path.join(root, "src-tauri/tauri.conf.json"), "utf8"),
    ) as { version: string };
    expect(tauri.version).toBe("../package.json");
  });
});
