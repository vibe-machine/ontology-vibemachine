import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, "../..");
const workspaceRoot = path.resolve(root, "..");

const TYPEDB_IMAGE = process.env.TYPEDB_IMAGE ?? "typedb/typedb:3.8.0";
const CONTAINER_BIN = process.env.CONTAINER_BIN ?? "container";
const CONTAINER_GRPC_PORT = 41729;
const CONTAINER_HTTP_PORT = 48000;
const TYPEDB_CONSOLE = process.env.TYPEDB_BIN ?? path.join(os.homedir(), ".typedb", "typedb");

function assertCondition(condition, message) {
  if (!condition) throw new Error(message);
}

async function readJson(basePath, relativePath) {
  return JSON.parse(await fs.readFile(path.join(basePath, relativePath), "utf8"));
}

function packageRepoPath(name) {
  return path.join(workspaceRoot, `ontology-${name}`);
}

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
    kind: schemaAssets.has(assetPath) ? "schema" : "write",
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
  const merged = hasPut ? `${chunks.join("\n\n")}\n` : `${keyword}\n\n${chunks.join("\n\n")}\n`;
  await fs.writeFile(outPath, merged, "utf8");
}

async function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close((error) => (error ? reject(error) : resolve(address.port)));
    });
    server.on("error", reject);
  });
}

async function startTypedbContainer(tempRoot) {
  const containerName = `typedb-control-booth-${process.pid}`;
  const hostGrpcPort = await getFreePort();

  const runResult = spawnSync(
    CONTAINER_BIN,
    [
      "run",
      "-d",
      "--name",
      containerName,
      "-c",
      "2",
      "-m",
      "2G",
      "--mount",
      `type=bind,source=${tempRoot},target=/validation`,
      "--publish",
      `127.0.0.1:${hostGrpcPort}:${CONTAINER_GRPC_PORT}`,
      TYPEDB_IMAGE,
      `--server.address=0.0.0.0:${CONTAINER_GRPC_PORT}`,
      `--server.http.address=0.0.0.0:${CONTAINER_HTTP_PORT}`,
      "--diagnostics.reporting.metrics=false",
      "--diagnostics.reporting.errors=false",
      "--diagnostics.monitoring.enabled=false",
    ],
    { encoding: "utf8" },
  );

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

  return { containerName, hostGrpcPort };
}

async function stopContainer(containerName) {
  if (!containerName) return;
  spawnSync(CONTAINER_BIN, ["stop", "-t", "5", containerName], { encoding: "utf8" });
  spawnSync(CONTAINER_BIN, ["rm", containerName], { encoding: "utf8" });
}

function runTypedbScript(hostGrpcPort, scriptPath, cwd) {
  return spawnSync(
    TYPEDB_CONSOLE,
    [
      "console",
      `--address=127.0.0.1:${hostGrpcPort}`,
      "--username=admin",
      "--password=password",
      "--tls-disabled",
      "--script",
      scriptPath,
    ],
    { cwd, encoding: "utf8" },
  );
}

async function makeDatabase(tempRoot, hostGrpcPort, databaseName) {
  const orderedPackages = await resolvePackageOrder(root);
  const schemaAssets = [];
  const writeAssets = [];
  for (const pkg of orderedPackages) {
    for (const asset of classifyAssemblyAssets(pkg.manifest)) {
      const entry = { packageRoot: pkg.root, relativePath: asset.relativePath };
      if (asset.kind === "schema") schemaAssets.push(entry);
      else writeAssets.push(entry);
    }
  }

  const mergedSchema = path.join(tempRoot, "merged-schema.tql");
  await writeMergedQueryFile("define", schemaAssets, mergedSchema);

  const dataFiles = [];
  for (const [index, asset] of writeAssets.entries()) {
    const text = await fs.readFile(path.join(asset.packageRoot, asset.relativePath), "utf8");
    const chunk = rewriteChunk(text, "insert", `write${index + 1}`);
    if (chunk) {
      const dataFile = path.join(tempRoot, `data-${index + 1}.tql`);
      await fs.writeFile(dataFile, `${chunk}\n`, "utf8");
      dataFiles.push(dataFile);
    }
  }

  const schemaScript = path.join(tempRoot, "schema-script.tql");
  await fs.writeFile(
    schemaScript,
    `database create ${databaseName}\n\ntransaction schema ${databaseName}\n\nsource ${mergedSchema}\n\ncommit\n\nexit\n`,
    "utf8",
  );
  const schemaResult = runTypedbScript(hostGrpcPort, schemaScript, root);
  assertCondition(schemaResult.status === 0, `TypeDB schema load failed:\n${schemaResult.stdout}\n${schemaResult.stderr}`);

  for (const dataFile of dataFiles) {
    const loadScript = path.join(tempRoot, `load-${path.basename(dataFile)}.tql`);
    await fs.writeFile(
      loadScript,
      `transaction write ${databaseName}\n\nsource ${dataFile}\n\ncommit\n\nexit\n`,
      "utf8",
    );
    const loadResult = runTypedbScript(hostGrpcPort, loadScript, root);
    assertCondition(
      loadResult.status === 0,
      `TypeDB data load failed for ${path.basename(dataFile)}:\n${loadResult.stdout}\n${loadResult.stderr}`,
    );
  }
}

async function runTransaction(tempRoot, hostGrpcPort, databaseName, mode, body, label) {
  const scriptPath = path.join(tempRoot, `${label}-${Date.now()}-${Math.random().toString(16).slice(2)}.tql`);
  const closing = mode === "write" ? "commit" : "close";
  await fs.writeFile(
    scriptPath,
    `transaction ${mode} ${databaseName}\n\n${body.trim()}\n\n${closing}\n\nexit\n`,
    "utf8",
  );
  return runTypedbScript(hostGrpcPort, scriptPath, root);
}

function parseAnswerCount(stdout) {
  const match = stdout.match(/Finished\. Total answers:\s+(\d+)/);
  return match ? Number(match[1]) : null;
}

async function expectReadCount(tempRoot, hostGrpcPort, databaseName, label, body, expectedCount) {
  const result = await runTransaction(tempRoot, hostGrpcPort, databaseName, "read", body, label);
  assertCondition(result.status === 0, `${label} failed:\n${result.stdout}\n${result.stderr}`);
  const count = parseAnswerCount(result.stdout);
  assertCondition(count === expectedCount, `${label}: expected ${expectedCount} answers, got ${count}\n${result.stdout}`);
}

async function expectWriteOk(tempRoot, hostGrpcPort, databaseName, label, body) {
  const result = await runTransaction(tempRoot, hostGrpcPort, databaseName, "write", body, label);
  assertCondition(result.status === 0, `${label} failed:\n${result.stdout}\n${result.stderr}`);
}

async function expectWriteFail(tempRoot, hostGrpcPort, databaseName, label, body) {
  const result = await runTransaction(tempRoot, hostGrpcPort, databaseName, "write", body, label);
  assertCondition(result.status !== 0, `${label}: expected write failure\n${result.stdout}\n${result.stderr}`);
}

async function seedControlBooth(tempRoot, hostGrpcPort, databaseName, boothId, name) {
  await expectWriteOk(
    tempRoot,
    hostGrpcPort,
    databaseName,
    `seed-booth-${boothId}`,
    `insert
$cb isa VibeControlBooth,
  has control_booth_id "${boothId}",
  has boothName "${name}",
  has description "test booth";`,
  );
}

function memberInsert(member) {
  return `insert
$m isa ${member.type},
  ${member.attrs.join(",\n  ")};`;
}

function memberMatch(member) {
  return `$m isa ${member.type}, has ${member.idAttr} "${member.idValue}";`;
}

const members = [
  {
    label: "workspace",
    type: "VibeWorkspace",
    idAttr: "workspace_id",
    idValue: "ws-control-booth",
    attrs: ['has workspace_id "ws-control-booth"', 'has workspaceName "Workspace Control Booth"'],
  },
  {
    label: "project",
    type: "VibeProject",
    idAttr: "project_id",
    idValue: "project-control-booth",
    attrs: ['has project_id "project-control-booth"', 'has name "Project Control Booth"'],
  },
  {
    label: "repo",
    type: "VibeGitRepository",
    idAttr: "remoteUrl",
    idValue: "https://github.com/vibe-machine/control-booth-repo",
    attrs: [
      'has remoteUrl "https://github.com/vibe-machine/control-booth-repo"',
      'has repositoryName "control-booth-repo"',
      'has defaultBranch "main"',
    ],
  },
  {
    label: "objective",
    type: "VibeBusinessObjective",
    idAttr: "objective_id",
    idValue: "objective-control-booth",
    attrs: ['has objective_id "objective-control-booth"', 'has name "Objective Control Booth"'],
  },
  {
    label: "feature-spec",
    type: "VibeFeatureSpecification",
    idAttr: "document_id",
    idValue: "feature-spec-control-booth",
    attrs: ['has document_id "feature-spec-control-booth"', 'has name "Feature Spec Control Booth"'],
  },
  {
    label: "engineering-task",
    type: "VibeEngineeringTask",
    idAttr: "item_id",
    idValue: "engineering-task-control-booth",
    attrs: ['has item_id "engineering-task-control-booth"', 'has name "Engineering Task Control Booth"'],
  },
  {
    label: "issue",
    type: "VibeIssue",
    idAttr: "issue_id",
    idValue: "issue-control-booth",
    attrs: ['has issue_id "issue-control-booth"', 'has name "Issue Control Booth"'],
  },
  {
    label: "release-plan",
    type: "VibeReleasePlan",
    idAttr: "release_plan_id",
    idValue: "release-plan-control-booth",
    attrs: ['has release_plan_id "release-plan-control-booth"', 'has name "Release Plan Control Booth"'],
  },
  {
    label: "milestone",
    type: "VibeMilestone",
    idAttr: "milestone_id",
    idValue: "milestone-control-booth",
    attrs: ['has milestone_id "milestone-control-booth"', 'has name "Milestone Control Booth"'],
  },
];

async function runMembershipEvals(tempRoot, hostGrpcPort, databaseName) {
  await seedControlBooth(tempRoot, hostGrpcPort, databaseName, "cb-membership", "Membership Booth");

  for (const member of members) {
    await expectWriteOk(tempRoot, hostGrpcPort, databaseName, `insert-${member.label}`, memberInsert(member));
    await expectReadCount(
      tempRoot,
      hostGrpcPort,
      databaseName,
      `key-${member.label}`,
      `match
${memberMatch(member)}
limit 1;`,
      1,
    );
    await expectWriteOk(
      tempRoot,
      hostGrpcPort,
      databaseName,
      `link-${member.label}`,
      `match
$cb isa VibeControlBooth, has control_booth_id "cb-membership";
${memberMatch(member)}
insert
(member: $m, controlBooth: $cb) isa controlBoothIncludes;`,
    );
    await expectReadCount(
      tempRoot,
      hostGrpcPort,
      databaseName,
      `verify-link-${member.label}`,
      `match
$cb isa VibeControlBooth, has control_booth_id "cb-membership";
${memberMatch(member)}
(member: $m, controlBooth: $cb) isa controlBoothIncludes;
limit 1;`,
      1,
    );
  }

  await expectWriteOk(
    tempRoot,
    hostGrpcPort,
    databaseName,
    "insert-implementation-spec",
    `insert
$impl isa VibeImplementationSpecification,
  has document_id "impl-spec-control-booth",
  has name "Impl Spec Control Booth";`,
  );
  await expectWriteOk(
    tempRoot,
    hostGrpcPort,
    databaseName,
    "link-implementation-spec",
    `match
$cb isa VibeControlBooth, has control_booth_id "cb-membership";
$impl isa VibeImplementationSpecification, has document_id "impl-spec-control-booth";
insert
(member: $impl, controlBooth: $cb) isa controlBoothIncludes;`,
  );
  await expectReadCount(
    tempRoot,
    hostGrpcPort,
    databaseName,
    "verify-implementation-spec-link",
    `match
$cb isa VibeControlBooth, has control_booth_id "cb-membership";
$impl isa VibeImplementationSpecification, has document_id "impl-spec-control-booth";
(member: $impl, controlBooth: $cb) isa controlBoothIncludes;
limit 1;`,
    1,
  );

  await expectWriteOk(
    tempRoot,
    hostGrpcPort,
    databaseName,
    "remove-release-plan-link",
    `match
$cb isa VibeControlBooth, has control_booth_id "cb-membership";
$release isa VibeReleasePlan, has release_plan_id "release-plan-control-booth";
$rel isa controlBoothIncludes (member: $release, controlBooth: $cb);
delete
$rel;`,
  );
  await expectReadCount(
    tempRoot,
    hostGrpcPort,
    databaseName,
    "verify-release-plan-unlinked",
    `match
$cb isa VibeControlBooth, has control_booth_id "cb-membership";
$release isa VibeReleasePlan, has release_plan_id "release-plan-control-booth";
(member: $release, controlBooth: $cb) isa controlBoothIncludes;
limit 1;`,
    0,
  );
  await expectReadCount(
    tempRoot,
    hostGrpcPort,
    databaseName,
    "verify-release-plan-survives",
    `match
$release isa VibeReleasePlan, has release_plan_id "release-plan-control-booth";
limit 1;`,
    1,
  );
}

async function runRemoteUrlDuplicateEval(tempRoot, hostGrpcPort, databaseName) {
  await expectWriteOk(
    tempRoot,
    hostGrpcPort,
    databaseName,
    "insert-unique-repos",
    `insert
$a isa VibeGitRepository,
  has remoteUrl "https://github.com/vibe-machine/unique-repo-a",
  has repositoryName "unique-repo-a";
$b isa VibeGitRepository,
  has remoteUrl "https://github.com/vibe-machine/unique-repo-b",
  has repositoryName "unique-repo-b";`,
  );
  await expectReadCount(
    tempRoot,
    hostGrpcPort,
    databaseName,
    "verify-unique-repos",
    `match
$repo isa VibeGitRepository, has remoteUrl "https://github.com/vibe-machine/unique-repo-a";
limit 1;`,
    1,
  );
  await expectWriteFail(
    tempRoot,
    hostGrpcPort,
    databaseName,
    "duplicate-remote-url",
    `insert
$dup isa VibeGitRepository,
  has remoteUrl "https://github.com/vibe-machine/unique-repo-a",
  has repositoryName "duplicate-repo";`,
  );
}

async function runTraversalEvals(tempRoot, hostGrpcPort, databaseName) {
  await expectWriteOk(
    tempRoot,
    hostGrpcPort,
    databaseName,
    "seed-traversal",
    `insert
$cb_release isa VibeControlBooth, has control_booth_id "cb-traversal-release", has boothName "Traversal Release";
$cb_project isa VibeControlBooth, has control_booth_id "cb-traversal-project", has boothName "Traversal Project";
$cb_feature isa VibeControlBooth, has control_booth_id "cb-traversal-feature", has boothName "Traversal Feature";
$cb_repo isa VibeControlBooth, has control_booth_id "cb-traversal-repo", has boothName "Traversal Repo";
$cb_issue isa VibeControlBooth, has control_booth_id "cb-traversal-issue", has boothName "Traversal Issue";
$cb_task isa VibeControlBooth, has control_booth_id "cb-traversal-task", has boothName "Traversal Task";

$release isa VibeReleasePlan, has release_plan_id "release-traversal", has name "Release Traversal";
$milestone isa VibeMilestone, has milestone_id "milestone-traversal", has name "Milestone Traversal";
$issue isa VibeIssue, has issue_id "issue-traversal", has name "Issue Traversal";
$project isa VibeProject, has project_id "project-traversal", has name "Project Traversal";
$feature isa VibeFeatureSpecification, has document_id "feature-traversal", has name "Feature Traversal";
$requirement isa VibeRequirement, has item_id "requirement-traversal", has document_id "feature-traversal", has name "Requirement Traversal";
$repo isa VibeGitRepository, has remoteUrl "https://github.com/vibe-machine/repo-traversal", has repositoryName "repo-traversal";
$task isa VibeEngineeringTask, has item_id "task-traversal", has name "Task Traversal";

(controlBooth: $cb_release, member: $release) isa controlBoothIncludes;
(controlBooth: $cb_project, member: $project) isa controlBoothIncludes;
(controlBooth: $cb_feature, member: $feature) isa controlBoothIncludes;
(controlBooth: $cb_repo, member: $repo) isa controlBoothIncludes;
(controlBooth: $cb_issue, member: $issue) isa controlBoothIncludes;
(controlBooth: $cb_task, member: $task) isa controlBoothIncludes;

(releasePlan: $release, milestone: $milestone) isa milestoneInReleasePlan;
(issue: $issue, releasePlan: $release) isa issueCommittedToRelease;
(featureSpec: $feature, project: $project) isa specifiesFeatureFor;
(container: $feature, item: $requirement) isa containsItem;
(engineeringTask: $task, repository: $repo) isa targetsRepository;
(engineeringTask: $task, issue: $issue) isa taskAddressesIssue;
(engineeringTask: $task, requirement: $requirement) isa fulfillsRequirement;`,
  );

  await expectReadCount(
    tempRoot,
    hostGrpcPort,
    databaseName,
    "traverse-release-to-milestone",
    `match
$cb isa VibeControlBooth, has control_booth_id "cb-traversal-release";
$release isa VibeReleasePlan;
(member: $release, controlBooth: $cb) isa controlBoothIncludes;
(releasePlan: $release, milestone: $milestone) isa milestoneInReleasePlan;
$milestone isa VibeMilestone, has milestone_id "milestone-traversal";
limit 1;`,
    1,
  );
  await expectReadCount(
    tempRoot,
    hostGrpcPort,
    databaseName,
    "traverse-release-to-issue",
    `match
$cb isa VibeControlBooth, has control_booth_id "cb-traversal-release";
$release isa VibeReleasePlan;
(member: $release, controlBooth: $cb) isa controlBoothIncludes;
(issue: $issue, releasePlan: $release) isa issueCommittedToRelease;
$issue isa VibeIssue, has issue_id "issue-traversal";
limit 1;`,
    1,
  );
  await expectReadCount(
    tempRoot,
    hostGrpcPort,
    databaseName,
    "traverse-project-to-feature",
    `match
$cb isa VibeControlBooth, has control_booth_id "cb-traversal-project";
$project isa VibeProject;
(member: $project, controlBooth: $cb) isa controlBoothIncludes;
(featureSpec: $feature, project: $project) isa specifiesFeatureFor;
$feature isa VibeFeatureSpecification, has document_id "feature-traversal";
limit 1;`,
    1,
  );
  await expectReadCount(
    tempRoot,
    hostGrpcPort,
    databaseName,
    "traverse-feature-to-content-items",
    `match
$cb isa VibeControlBooth, has control_booth_id "cb-traversal-feature";
$feature isa VibeFeatureSpecification;
(member: $feature, controlBooth: $cb) isa controlBoothIncludes;
(container: $feature, item: $item) isa containsItem;
$item isa VibeRequirement, has item_id "requirement-traversal";
limit 1;`,
    1,
  );
  await expectReadCount(
    tempRoot,
    hostGrpcPort,
    databaseName,
    "traverse-repo-to-task",
    `match
$cb isa VibeControlBooth, has control_booth_id "cb-traversal-repo";
$repo isa VibeGitRepository;
(member: $repo, controlBooth: $cb) isa controlBoothIncludes;
(engineeringTask: $task, repository: $repo) isa targetsRepository;
$task isa VibeEngineeringTask, has item_id "task-traversal";
limit 1;`,
    1,
  );
  await expectReadCount(
    tempRoot,
    hostGrpcPort,
    databaseName,
    "traverse-issue-to-task",
    `match
$cb isa VibeControlBooth, has control_booth_id "cb-traversal-issue";
$issue isa VibeIssue;
(member: $issue, controlBooth: $cb) isa controlBoothIncludes;
(engineeringTask: $task, issue: $issue) isa taskAddressesIssue;
$task isa VibeEngineeringTask, has item_id "task-traversal";
limit 1;`,
    1,
  );
  await expectReadCount(
    tempRoot,
    hostGrpcPort,
    databaseName,
    "traverse-task-to-requirement",
    `match
$cb isa VibeControlBooth, has control_booth_id "cb-traversal-task";
$task isa VibeEngineeringTask;
(member: $task, controlBooth: $cb) isa controlBoothIncludes;
(engineeringTask: $task, requirement: $req) isa fulfillsRequirement;
$req isa VibeRequirement, has item_id "requirement-traversal";
limit 1;`,
    1,
  );
}

async function runDedupEval(tempRoot, hostGrpcPort, databaseName) {
  await expectWriteOk(
    tempRoot,
    hostGrpcPort,
    databaseName,
    "seed-dedup",
    `insert
$cb isa VibeControlBooth, has control_booth_id "cb-dedup", has boothName "Dedup Booth";
$repo isa VibeGitRepository, has remoteUrl "https://github.com/vibe-machine/repo-dedup", has repositoryName "repo-dedup";
$issue isa VibeIssue, has issue_id "issue-dedup", has name "Issue Dedup";
$task isa VibeEngineeringTask, has item_id "task-dedup", has name "Task Dedup";

(member: $repo, controlBooth: $cb) isa controlBoothIncludes;
(member: $issue, controlBooth: $cb) isa controlBoothIncludes;
(engineeringTask: $task, repository: $repo) isa targetsRepository;
(engineeringTask: $task, issue: $issue) isa taskAddressesIssue;`,
  );

  const repoPathResult = await runTransaction(
    tempRoot,
    hostGrpcPort,
    databaseName,
    "read",
    `match
$cb isa VibeControlBooth, has control_booth_id "cb-dedup";
$repo isa VibeGitRepository;
(member: $repo, controlBooth: $cb) isa controlBoothIncludes;
(engineeringTask: $task, repository: $repo) isa targetsRepository;
$task isa VibeEngineeringTask, has item_id $taskId;
select $taskId;`,
    "dedup-repo-path",
  );
  assertCondition(repoPathResult.status === 0, `dedup-repo-path failed:\n${repoPathResult.stdout}\n${repoPathResult.stderr}`);

  const issuePathResult = await runTransaction(
    tempRoot,
    hostGrpcPort,
    databaseName,
    "read",
    `match
$cb isa VibeControlBooth, has control_booth_id "cb-dedup";
$issue isa VibeIssue;
(member: $issue, controlBooth: $cb) isa controlBoothIncludes;
(engineeringTask: $task, issue: $issue) isa taskAddressesIssue;
$task isa VibeEngineeringTask, has item_id $taskId;
select $taskId;`,
    "dedup-issue-path",
  );
  assertCondition(issuePathResult.status === 0, `dedup-issue-path failed:\n${issuePathResult.stdout}\n${issuePathResult.stderr}`);

  const ids = new Set(
    `${repoPathResult.stdout}\n${issuePathResult.stdout}`
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.includes("task-dedup"))
      .map(() => "task-dedup"),
  );
  assertCondition(ids.size === 1, `dedup expected merged size 1, got ${ids.size}`);
}

async function runOwnershipAndEdgeCaseEvals(tempRoot, hostGrpcPort, databaseName) {
  await seedControlBooth(tempRoot, hostGrpcPort, databaseName, "cb-empty", "Empty Booth");
  await expectReadCount(
    tempRoot,
    hostGrpcPort,
    databaseName,
    "empty-booth-members",
    `match
$cb isa VibeControlBooth, has control_booth_id "cb-empty";
(member: $m, controlBooth: $cb) isa controlBoothIncludes;
limit 1;`,
    0,
  );

  await expectWriteOk(
    tempRoot,
    hostGrpcPort,
    databaseName,
    "ownership-collaboration",
    `insert
$cb isa VibeControlBooth, has control_booth_id "cb-owners", has boothName "Owners Booth";
$p1 isa Person;
$p2 isa Person;
$agent1 isa VibeAgent, has name "Agent One";
$agent2 isa VibeAgent, has name "Agent Two";

(controlBooth: $cb, owner: $p1) isa controlBoothOwnedBy;
(controlBooth: $cb, owner: $p2) isa controlBoothOwnedBy;
(controlBooth: $cb, collaborator: $agent1) isa controlBoothHasCollaborator;
(controlBooth: $cb, collaborator: $agent2) isa controlBoothHasCollaborator;`,
  );
  await expectReadCount(
    tempRoot,
    hostGrpcPort,
    databaseName,
    "owners-count",
    `match
$cb isa VibeControlBooth, has control_booth_id "cb-owners";
(controlBooth: $cb, owner: $owner) isa controlBoothOwnedBy;
$owner isa Person;`,
    2,
  );
  await expectReadCount(
    tempRoot,
    hostGrpcPort,
    databaseName,
    "collaborators-count",
    `match
$cb isa VibeControlBooth, has control_booth_id "cb-owners";
(controlBooth: $cb, collaborator: $collab) isa controlBoothHasCollaborator;
$collab isa VibeAgent;`,
    2,
  );

  await expectWriteOk(
    tempRoot,
    hostGrpcPort,
    databaseName,
    "shared-member",
    `insert
$cb1 isa VibeControlBooth, has control_booth_id "cb-shared-1", has boothName "Shared Booth 1";
$cb2 isa VibeControlBooth, has control_booth_id "cb-shared-2", has boothName "Shared Booth 2";
$repo isa VibeGitRepository, has remoteUrl "https://github.com/vibe-machine/shared-repo", has repositoryName "shared-repo";
(member: $repo, controlBooth: $cb1) isa controlBoothIncludes;
(member: $repo, controlBooth: $cb2) isa controlBoothIncludes;`,
  );
  await expectReadCount(
    tempRoot,
    hostGrpcPort,
    databaseName,
    "shared-member-booth-1",
    `match
$cb isa VibeControlBooth, has control_booth_id "cb-shared-1";
$repo isa VibeGitRepository, has remoteUrl "https://github.com/vibe-machine/shared-repo";
(member: $repo, controlBooth: $cb) isa controlBoothIncludes;
limit 1;`,
    1,
  );
  await expectReadCount(
    tempRoot,
    hostGrpcPort,
    databaseName,
    "shared-member-booth-2",
    `match
$cb isa VibeControlBooth, has control_booth_id "cb-shared-2";
$repo isa VibeGitRepository, has remoteUrl "https://github.com/vibe-machine/shared-repo";
(member: $repo, controlBooth: $cb) isa controlBoothIncludes;
limit 1;`,
    1,
  );

  await expectWriteOk(
    tempRoot,
    hostGrpcPort,
    databaseName,
    "booth-in-booth",
    `insert
$parent isa VibeControlBooth, has control_booth_id "cb-parent", has boothName "Parent Booth";
$child isa VibeControlBooth, has control_booth_id "cb-child", has boothName "Child Booth";
(member: $child, controlBooth: $parent) isa controlBoothIncludes;`,
  );
  await expectReadCount(
    tempRoot,
    hostGrpcPort,
    databaseName,
    "verify-booth-in-booth",
    `match
$parent isa VibeControlBooth, has control_booth_id "cb-parent";
$child isa VibeControlBooth, has control_booth_id "cb-child";
(member: $child, controlBooth: $parent) isa controlBoothIncludes;
limit 1;`,
    1,
  );
}

async function main() {
  const typedbTemp = await fs.mkdtemp(path.join(os.tmpdir(), "control-booth-validation-"));
  const databaseName = `control_booth_${process.pid}`;

  let containerName;
  try {
    const container = await startTypedbContainer(typedbTemp);
    containerName = container.containerName;
    await makeDatabase(typedbTemp, container.hostGrpcPort, databaseName);

    await runMembershipEvals(typedbTemp, container.hostGrpcPort, databaseName);
    await runRemoteUrlDuplicateEval(typedbTemp, container.hostGrpcPort, databaseName);
    await runTraversalEvals(typedbTemp, container.hostGrpcPort, databaseName);
    await runDedupEval(typedbTemp, container.hostGrpcPort, databaseName);
    await runOwnershipAndEdgeCaseEvals(typedbTemp, container.hostGrpcPort, databaseName);

    console.log("control booth validation ok");
  } finally {
    await stopContainer(containerName);
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
