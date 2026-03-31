import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn, spawnSync, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, "../..");
const workspaceRoot = path.resolve(root, "..");

const TYPEDB_IMAGE = process.env.TYPEDB_IMAGE ?? "typedb/typedb:3.8.0";
const CONTAINER_BIN = process.env.CONTAINER_BIN ?? "container";
const TYPEDB_CONSOLE = process.env.TYPEDB_BIN ?? path.join(os.homedir(), ".typedb", "typedb");

function assertCondition(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function readJson(basePath, relativePath) {
  return JSON.parse(await fs.readFile(path.join(basePath, relativePath), "utf8"));
}

function packageRepoPath(name) {
  return path.join(workspaceRoot, `ontology-${name}`);
}

// ── Semver helpers ────────────────────────────────────────

function parseSemver(value) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(value.trim());
  if (!match) return null;
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}

function semverString(parsed) {
  return `${parsed.major}.${parsed.minor}.${parsed.patch}`;
}

function semverCompare(a, b) {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  return a.patch - b.patch;
}

function semverInRange(version, rangeStr) {
  // Supports: "1.0.0", ">=1.0.0 <1.1.0", ">=1.0.0"
  const clauses = rangeStr.trim().split(/\s+/);
  for (const clause of clauses) {
    if (clause.startsWith(">=")) {
      const bound = parseSemver(clause.slice(2));
      if (!bound || semverCompare(version, bound) < 0) return false;
    } else if (clause.startsWith(">")) {
      const bound = parseSemver(clause.slice(1));
      if (!bound || semverCompare(version, bound) <= 0) return false;
    } else if (clause.startsWith("<=")) {
      const bound = parseSemver(clause.slice(2));
      if (!bound || semverCompare(version, bound) > 0) return false;
    } else if (clause.startsWith("<")) {
      const bound = parseSemver(clause.slice(1));
      if (!bound || semverCompare(version, bound) >= 0) return false;
    } else {
      const exact = parseSemver(clause);
      if (!exact || semverCompare(version, exact) !== 0) return false;
    }
  }
  return true;
}

// ── Git helpers ───────────────────────────────────────────

function gitTags(repoPath) {
  const output = execFileSync("git", ["tag", "--list", "v*"], { cwd: repoPath, encoding: "utf8" });
  return output.trim().split("\n").filter(Boolean);
}

function findBaseVersionTag(repoPath, fromRange) {
  const tags = gitTags(repoPath);
  const candidates = tags
    .map((tag) => ({ tag, version: parseSemver(tag) }))
    .filter(({ version }) => version && semverInRange(version, fromRange))
    .sort((a, b) => semverCompare(b.version, a.version)); // highest first

  assertCondition(candidates.length > 0, `No git tag matches migration from-range '${fromRange}'. Tags: ${tags.join(", ")}`);
  return candidates[0];
}

function checkoutToTemp(repoPath, tag) {
  const tempDir = execFileSync("mktemp", ["-d"], { encoding: "utf8" }).trim();
  execFileSync("git", ["worktree", "add", "--detach", tempDir, tag], { cwd: repoPath, encoding: "utf8" });
  return tempDir;
}

function removeWorktree(repoPath, worktreePath) {
  try {
    execFileSync("git", ["worktree", "remove", "--force", worktreePath], { cwd: repoPath, encoding: "utf8" });
  } catch {
    // Best effort
  }
}

// ── Package resolution ────────────────────────────────────

async function resolvePackageOrder(packageRoot, seen = new Set(), visiting = new Set()) {
  const manifest = await readJson(packageRoot, "package.json");
  const packageName = manifest.name;

  if (seen.has(packageName)) return [];
  if (visiting.has(packageName)) {
    throw new Error(`cyclic ontology dependency detected at ${packageName}`);
  }

  visiting.add(packageName);
  const ordered = [];
  for (const dependency of manifest.dependencies ?? []) {
    const dependencyRoot = packageRepoPath(dependency.name);
    await fs.access(path.join(dependencyRoot, "package.json"));
    ordered.push(...await resolvePackageOrder(dependencyRoot, seen, visiting));
  }
  visiting.delete(packageName);

  if (!seen.has(packageName)) {
    seen.add(packageName);
    ordered.push({ root: packageRoot, manifest });
  }
  return ordered;
}

function classifyAssemblyAssets(manifest) {
  const schemaAssets = new Set((manifest.schemas ?? []).map((schema) => schema.file));
  return (manifest.assembly?.loadOrder ?? []).map((assetPath) => ({
    relativePath: assetPath,
    kind: schemaAssets.has(assetPath) ? "schema" : "write"
  }));
}

function rewriteChunk(text, keyword, variablePrefix) {
  let chunk = text.replace(/^#.*\n/gm, "");
  chunk = chunk.replace(new RegExp(`^\\s*${keyword}\\s*\\n`, "i"), "");
  chunk = chunk.replace(/\$([A-Za-z][A-Za-z0-9_]*)/g, `\$${variablePrefix}_$1`);
  return chunk.trim();
}

async function writeMergedQueryFile(keyword, assets, outPath) {
  const chunks = [];
  for (const [index, asset] of assets.entries()) {
    let text = await fs.readFile(path.join(asset.packageRoot, asset.relativePath), "utf8");
    text = rewriteChunk(text, keyword, `${keyword}${index + 1}`);
    if (text) chunks.push(text);
  }
  const hasPut = chunks.some((chunk) => /^put /m.test(chunk));
  const merged = hasPut
    ? `${chunks.join("\n\n")}\n`
    : `${keyword}\n\n${chunks.join("\n\n")}\n`;
  await fs.writeFile(outPath, merged, "utf8");
}

// ── TypeDB container ──────────────────────────────────────

async function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close((error) => error ? reject(error) : resolve(address.port));
    });
    server.on("error", reject);
  });
}

async function startTypedbContainer(tempRoot) {
  const containerName = `typedb-migration-${process.pid}`;
  const hostGrpcPort = await getFreePort();
  const runResult = spawnSync(CONTAINER_BIN, [
    "run", "-d",
    "--name", containerName,
    "-c", "2", "-m", "2G",
    "--mount", `type=bind,source=${tempRoot},target=/validation`,
    "--publish", `127.0.0.1:${hostGrpcPort}:41729`,
    TYPEDB_IMAGE,
    "--server.address=0.0.0.0:41729",
    "--server.http.address=0.0.0.0:48000",
    "--diagnostics.reporting.metrics=false",
    "--diagnostics.reporting.errors=false",
    "--diagnostics.monitoring.enabled=false"
  ], { encoding: "utf8" });

  if (runResult.status !== 0) {
    throw new Error(`Failed to start TypeDB container:\n${runResult.stderr}`);
  }

  await new Promise((resolve, reject) => {
    const deadline = Date.now() + 60000;
    const poll = setInterval(() => {
      if (Date.now() > deadline) {
        clearInterval(poll);
        reject(new Error("TypeDB container did not become ready within 60s"));
        return;
      }
      const logs = spawnSync(CONTAINER_BIN, ["logs", containerName], { encoding: "utf8" });
      if (logs.stdout.includes("Ready!") || logs.stderr.includes("Ready!")) {
        clearInterval(poll);
        resolve();
      }
    }, 1000);
  });

  console.log(`TypeDB container '${containerName}' ready (host port: ${hostGrpcPort})`);
  return { containerName, hostGrpcPort };
}

async function stopContainer(containerName) {
  if (!containerName) return;
  spawnSync(CONTAINER_BIN, ["stop", "-t", "5", containerName], { encoding: "utf8" });
  spawnSync(CONTAINER_BIN, ["rm", containerName], { encoding: "utf8" });
  console.log(`TypeDB container '${containerName}' removed`);
}

function runTypedbScript(hostGrpcPort, scriptPath, cwd) {
  return spawnSync(TYPEDB_CONSOLE, [
    "console",
    `--address=127.0.0.1:${hostGrpcPort}`,
    "--username=admin",
    "--password=password",
    "--tls-disabled",
    "--script", scriptPath
  ], { cwd, encoding: "utf8" });
}

// ── Schema/data loading helpers ───────────────────────────

async function loadSchemaAndData(hostGrpcPort, databaseName, packages, tempDir, label) {
  const schemaAssets = [];
  const writeAssets = [];
  for (const pkg of packages) {
    for (const asset of classifyAssemblyAssets(pkg.manifest)) {
      const entry = { packageRoot: pkg.root, relativePath: asset.relativePath };
      if (asset.kind === "schema") {
        schemaAssets.push(entry);
      } else {
        writeAssets.push(entry);
      }
    }
  }

  const mergedSchema = path.join(tempDir, `${label}-schema.tql`);
  await writeMergedQueryFile("define", schemaAssets, mergedSchema);

  const schemaScript = path.join(tempDir, `${label}-schema-script.tql`);
  await fs.writeFile(
    schemaScript,
    `transaction schema ${databaseName}\n\nsource ${mergedSchema}\n\ncommit\n\nexit\n`,
    "utf8"
  );
  const schemaResult = runTypedbScript(hostGrpcPort, schemaScript, tempDir);
  assertCondition(schemaResult.status === 0, `${label} schema load failed:\n${schemaResult.stdout}\n${schemaResult.stderr}`);
  console.log(`${label}: schema loaded`);

  for (const [index, asset] of writeAssets.entries()) {
    const text = await fs.readFile(path.join(asset.packageRoot, asset.relativePath), "utf8");
    const chunk = rewriteChunk(text, "insert", `${label}_write${index + 1}`);
    if (!chunk) continue;
    const dataFile = path.join(tempDir, `${label}-data-${index + 1}.tql`);
    await fs.writeFile(dataFile, `${chunk}\n`, "utf8");
    const loadScript = path.join(tempDir, `${label}-load-${index + 1}.tql`);
    await fs.writeFile(
      loadScript,
      `transaction write ${databaseName}\n\nsource ${dataFile}\n\ncommit\n\nexit\n`,
      "utf8"
    );
    const load = runTypedbScript(hostGrpcPort, loadScript, tempDir);
    assertCondition(load.status === 0, `${label} data load failed for asset ${index + 1}:\n${load.stdout}\n${load.stderr}`);
  }
  console.log(`${label}: data loaded`);
}

// ── Main ──────────────────────────────────────────────────

async function main() {
  const manifest = await readJson(root, "package.json");
  const migration = manifest.migration;

  if (!migration || !Array.isArray(migration.plans) || migration.plans.length === 0) {
    console.log("No migration plans declared — skipping migration test.");
    return;
  }

  const plan = migration.plans[0];
  console.log(`Migration plan: ${plan.id} (from: ${plan.from}, to: ${plan.to})`);

  // Find the base version tag that matches the from-range
  const base = findBaseVersionTag(root, plan.from);
  console.log(`Base version: ${base.tag} (${semverString(base.version)})`);

  // Check out base version into a temporary worktree
  let baseWorktree;
  let containerName;
  const typedbTemp = await fs.mkdtemp(path.join(os.tmpdir(), "ontology-migration-test-"));
  const databaseName = `ontology_migration_${process.pid}`;

  try {
    baseWorktree = checkoutToTemp(root, base.tag);
    console.log(`Checked out ${base.tag} to ${baseWorktree}`);

    // Resolve base version package order (using base worktree for this package, live workspace for deps)
    const baseManifest = await readJson(baseWorktree, "package.json");
    const basePackages = [];
    for (const dep of baseManifest.dependencies ?? []) {
      const depRoot = packageRepoPath(dep.name);
      const depPackages = await resolvePackageOrder(depRoot);
      basePackages.push(...depPackages);
    }
    basePackages.push({ root: baseWorktree, manifest: baseManifest });

    // Start TypeDB
    const container = await startTypedbContainer(typedbTemp);
    containerName = container.containerName;
    const { hostGrpcPort } = container;

    // Step 1: Create database and load base version
    const createScript = path.join(typedbTemp, "create-db.tql");
    await fs.writeFile(createScript, `database create ${databaseName}\n\nexit\n`, "utf8");
    const createResult = runTypedbScript(hostGrpcPort, createScript, typedbTemp);
    assertCondition(createResult.status === 0, `Database creation failed:\n${createResult.stdout}\n${createResult.stderr}`);

    await loadSchemaAndData(hostGrpcPort, databaseName, basePackages, typedbTemp, "base");
    console.log(`Base version ${base.tag} loaded successfully`);

    // Step 2: Apply migration phases
    for (const phase of plan.phases) {
      console.log(`Running migration phase '${phase.id}' (${phase.units.length} units)`);
      for (const unit of phase.units) {
        const unitPath = path.join(root, unit.path);
        const unitContent = await fs.readFile(unitPath, "utf8");
        const unitFile = path.join(typedbTemp, `migration-${path.basename(unit.path)}`);
        await fs.writeFile(unitFile, unitContent, "utf8");

        const transactionType = unit.kind === "schema" ? "schema" : "write";
        const migrationScript = path.join(typedbTemp, `run-migration-${path.basename(unit.path)}.tql`);
        await fs.writeFile(
          migrationScript,
          `transaction ${transactionType} ${databaseName}\n\nsource ${unitFile}\n\ncommit\n\nexit\n`,
          "utf8"
        );
        const result = runTypedbScript(hostGrpcPort, migrationScript, typedbTemp);
        assertCondition(
          result.status === 0,
          `Migration unit '${unit.path}' (${unit.kind}) failed:\n${result.stdout}\n${result.stderr}`
        );
        console.log(`  Applied ${unit.kind} unit: ${path.basename(unit.path)}`);
      }
    }
    console.log("Migration phases completed");

    // Step 3: Apply current version schema and data (simulates post-migration bootstrap)
    const currentPackages = await resolvePackageOrder(root);
    await loadSchemaAndData(hostGrpcPort, databaseName, currentPackages, typedbTemp, "current");
    console.log("Current version schema and data applied successfully");

    // Step 4: Verify provenance
    for (const pkg of currentPackages) {
      const packageName = pkg.manifest.name;
      const moduleRepoUrl = pkg.manifest.source
        ?? pkg.manifest.upstream?.repoUrl
        ?? pkg.manifest.upstream?.repo;
      assertCondition(typeof moduleRepoUrl === "string" && moduleRepoUrl.length > 0, `Missing module repo URL for ${packageName}`);
      const queryScript = path.join(typedbTemp, `verify-${packageName}.tql`);
      await fs.writeFile(
        queryScript,
        `transaction read ${databaseName}\n\nmatch\n$module isa OntologyModule,\n  has moduleRepoUrl "${moduleRepoUrl}";\n$v isa OntologyModuleVersion;\n(version: $v, module: $module) isa ontologyModuleVersionOf;\nlimit 1;\n\nclose\n\nexit\n`,
        "utf8"
      );
      const query = runTypedbScript(hostGrpcPort, queryScript, typedbTemp);
      assertCondition(query.status === 0, `Provenance query failed for ${packageName}:\n${query.stdout}\n${query.stderr}`);
      assertCondition(
        query.stdout.includes("Finished. Total answers: 1"),
        `Expected OntologyModuleVersion row for ${packageName}:\n${query.stdout}`
      );
    }
    console.log("Provenance verified");

  } finally {
    await stopContainer(containerName);
    if (baseWorktree) removeWorktree(root, baseWorktree);
    await fs.rm(typedbTemp, { recursive: true, force: true });
  }

  console.log("typedb migration validation ok");
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
