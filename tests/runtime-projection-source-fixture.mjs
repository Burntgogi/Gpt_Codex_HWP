import { copyFile, cp, mkdir, symlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

const ROOT_FILES = [
  "package.json", ".npmrc", "LICENSE", "NOTICE", "THIRD_PARTY_NOTICES.md",
  "README.md", "README.en.md", "RELEASE_NOTES.md", "RELEASE_NOTES.en.md",
  ".agents/plugins/marketplace.json", ".claude-plugin/marketplace.json",
];
const PACKAGE_FILES = [".npmrc", "package.json", "package-lock.json", "tsconfig.json"];
const PACKAGE_DIRECTORIES = ["assets", "examples", "release-scripts", "scripts", "skills", "src", "vendor"];

export async function copyRuntimeProjectionSourceFixture(repositoryRoot, root) {
  await mkdir(root);
  for (const path of ROOT_FILES) {
    const destination = join(root, path);
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(join(repositoryRoot, path), destination);
  }
  await cp(join(repositoryRoot, "scripts"), join(root, "scripts"), {
    recursive: true, errorOnExist: true, force: false,
  });
  const source = join(root, "packages", "gpt-codex-hwp");
  const originalSource = join(repositoryRoot, "packages", "gpt-codex-hwp");
  await mkdir(source, { recursive: true });
  for (const path of PACKAGE_FILES) {
    await copyFile(join(originalSource, path), join(source, path));
  }
  for (const directory of PACKAGE_DIRECTORIES) {
    await cp(join(originalSource, directory), join(source, directory), {
      recursive: true, errorOnExist: true, force: false,
      filter: (path) => basename(path) !== "node_modules" && basename(path) !== ".git",
    });
  }
  const linkType = process.platform === "win32" ? "junction" : "dir";
  // The suites mutate only copied inputs; dependency and committed-output reads stay shared.
  await symlink(join(originalSource, "node_modules"), join(source, "node_modules"), linkType);
  await symlink(join(repositoryRoot, "plugins"), join(root, "plugins"), linkType);
  return { root, source };
}
