import type { MiniAppManifest } from "@discourse-mini-app/sdk/pack";
import { bundleModules, pack } from "@discourse-mini-app/sdk/pack";
import { createHash } from "node:crypto";
import { copyFile, readFile } from "node:fs/promises";
import { mediaAssets } from "./media.ts";

const manifest = JSON.parse(
  await readFile("manifest.json", "utf8")
) as MiniAppManifest;
manifest.id = process.env.MINI_APP_ID || manifest.id;
manifest.version = process.env.MINI_APP_VERSION || manifest.version;
await copyFile("src/template.html", "dist/web/index.html");
await copyFile("src/strings.json", "dist/web/strings.json");
const files = mediaAssets();
function assetPath(path: string) {
  if (
    !path ||
    path.includes("\\") ||
    path.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    throw new Error("Invalid package asset path");
  }
  return `dist/web/${path}`;
}
if (manifest.code?.moduleBundle && manifest.code.modules?.length) {
  const modules: Record<string, string> = {};
  for (const path of manifest.code.modules) {
    modules[path] = await readFile(assetPath(path), "utf8");
  }
  files[manifest.code.moduleBundle] = Buffer.from(
    await bundleModules({ files: modules })
  );
}
for (const name of ["index.html", "app.js", "app.css", "strings.json"]) {
  files[name] = await readFile(`dist/web/${name}`);
}
for (const path of manifest.assets || []) {
  if (!Object.hasOwn(files, path)) {
    files[path] = await readFile(assetPath(path));
  }
}
for (const path of Object.keys(manifest.code?.worklets || {})) {
  manifest.code!.worklets![path] =
    manifest.remote_assets?.[path]?.sha256 ??
    createHash("sha256").update(files[path]!).digest("hex");
}
const result = await pack({ manifest, files, outputDirectory: "dist/package" });
console.log(
  `Created ${result.file} (${result.size} bytes), app ${manifest.id}, version ${manifest.version}`
);
