// dev-link.mjs — link the DeepSeek Harness checkout into node_modules for
// development (type-checking + tests). Runtime resolution of @deepseek-ai/*
// is provided by the harness host when the plugin runs inside DSH; this file
// only matters for contributors running `npm test` / `npm run check` locally.
//
// Usage: npm run dev:link [-- /path/to/deepseek-harness]
// Default path: ../deepseek-harness (sibling checkout) or $DSH_REPO.

import { existsSync, mkdirSync, symlinkSync, rmSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const argv = process.argv.slice(2).filter((a) => a !== "--");
const dshRepo = resolve(argv[0] ?? process.env.DSH_REPO ?? join(root, "..", "deepseek-harness"));

if (!existsSync(join(dshRepo, "vendor/cordis/package.json"))) {
  console.error(`dev-link: DSH checkout not found at ${dshRepo}`);
  console.error("Set DSH_REPO=/path/to/deepseek-harness or pass it as an argument.");
  process.exit(1);
}

const LINKS = [
  ["@deepseek-ai/cordis", "vendor/cordis"],
  ["@deepseek-ai/dsh-agent", "packages/core/agent"],
  ["@deepseek-ai/dsh-session", "packages/core/session"],
  ["@deepseek-ai/dsh-tools", "packages/core/tools"],
  ["@deepseek-ai/dsh-commands", "packages/interaction/commands"],
  ["@deepseek-ai/dsh-credentials", "packages/credentials/credentials"],
  ["@deepseek-ai/dsh-storage-domain", "packages/storage/storage-domain"],
  ["@deepseek-ai/dsh-system-prompt", "packages/core/system-prompt"],
  ["@deepseek-ai/dsh-llm", "packages/llm/llm"],
];

let linked = 0;
for (const [name, rel] of LINKS) {
  const target = join(dshRepo, rel);
  if (!existsSync(target)) {
    console.warn(`dev-link: skip ${name} (missing ${rel})`);
    continue;
  }
  const link = join(root, "node_modules", ...name.split("/"));
  mkdirSync(dirname(link), { recursive: true });
  rmSync(link, { recursive: true, force: true });
  symlinkSync(target, link, "dir");
  linked++;
}

// Registry deps reused from a sibling checkout when present (zero-install dev).
const piSibling = join(root, "..", "pi-feishu-link");
const piLinks = [
  ["@larksuiteoapi/node-sdk", "node_modules/@larksuiteoapi/node-sdk"],
  ["qrcode-terminal", "node_modules/qrcode-terminal"],
  ["@types/qrcode-terminal", "node_modules/@types/qrcode-terminal"],
];
if (existsSync(piSibling)) {
  for (const [name, rel] of piLinks) {
    const target = join(piSibling, rel);
    if (!existsSync(target)) continue;
    const link = join(root, "node_modules", ...name.split("/"));
    mkdirSync(dirname(link), { recursive: true });
    rmSync(link, { recursive: true, force: true });
    symlinkSync(target, link, "dir");
    linked++;
  }
}

// Toolchain symlinks (typescript / tsdown / @types/node) from the DSH checkout.
const toolLinks = [
  ["typescript", "node_modules/typescript"],
  ["tsdown", "node_modules/tsdown"],
  ["@types/node", "node_modules/@types/node"],
];
for (const [name, rel] of toolLinks) {
  const target = join(dshRepo, rel);
  if (!existsSync(target)) continue;
  const link = join(root, "node_modules", ...name.split("/"));
  mkdirSync(dirname(link), { recursive: true });
  rmSync(link, { recursive: true, force: true });
  symlinkSync(target, link, "dir");
  linked++;
}

// .bin shims
const binDir = join(root, "node_modules", ".bin");
mkdirSync(binDir, { recursive: true });
const bins = [
  ["tsc", join(dshRepo, "node_modules/typescript/bin/tsc")],
  ["tsdown", join(dshRepo, "node_modules/tsdown/dist/run.mjs")],
];
for (const [name, target] of bins) {
  if (!existsSync(target)) continue;
  const shim = join(binDir, name);
  rmSync(shim, { force: true });
  symlinkSync(target, shim, "file");
}

console.log(`dev-link: linked ${linked} packages from ${dshRepo}`);
