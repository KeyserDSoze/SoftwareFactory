import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createProject } from "../domain/defaults";
import { generateFiles } from "../application/scaffold";

const project = createProject();
project.config.name = "Factory CI Example";
project.config.description = "Smoke test of the generated ASP.NET Core API and React frontend.";
const root = resolve("generated-fixture");
const files = generateFiles(project);
for (const [name, content] of Object.entries(files)) {
  const file = resolve(root, name);
  if (!file.startsWith(root + "/")) throw new Error("Invalid generated path");
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content, "utf8");
}
process.stdout.write("Generated " + Object.keys(files).length + " files to " + root + "\n");
