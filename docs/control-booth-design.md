# Control Booth Design

## Evals

Target production behaviors, not accumulation. Each eval validates a specific control booth interaction that must work correctly end-to-end.

### Membership Operations

Positive cases — one per supported member type:

- Create a booth, add a `VibeWorkspace` by `workspace_id`, verify `controlBoothIncludes` exists.
- Create a booth, add a `VibeWorkspace` by `workspace_id`, verify `controlBoothIncludes` exists.
- Same for each of the 9 types: `VibeProject`, `VibeGitRepository`, `VibeBusinessObjective`, `VibeFeatureSpecification`, `VibeEngineeringTask`, `VibeIssue`, `VibeReleasePlan`, `VibeMilestone`.
- Remove a member, verify the relation is deleted and the entity survives.

Negative case:

- Attempt to add a `VibeImplementationSpecification` as a control-booth member. The schema permits this because `VibeImplementationSpecification` inherits membership through `ContentExpression` ancestry. This eval documents the broad-supertype trade-off: the schema allows it, the application must prevent it.

### Stable Identifier Contract

- For each new `*_id @key`: insert an entity, match on the key, verify exactly one result.
- For `remoteUrl @key` on `VibeGitRepository`: insert two repos with different URLs, verify both matchable; attempt duplicate URL, verify rejection.
- The critical write-path shape: match a booth by `control_booth_id` AND a member by its `*_id`, insert the `controlBoothIncludes` relation. This is the exact query from the write path section and should be an eval.

### Staged Query Pipeline

One eval per first-class traversal path:

- Pin a `VibeReleasePlan` → traverse to `VibeMilestone` via `milestoneInReleasePlan`.
- Pin a `VibeReleasePlan` → traverse to `VibeIssue` via `issueCommittedToRelease`.
- Pin a `VibeProject` → traverse to `VibeFeatureSpecification` via `specifiesFeatureFor`.
- Pin a `VibeFeatureSpecification` → traverse to content items via `containsItem`.
- Pin a `VibeGitRepository` → traverse to `VibeEngineeringTask` via `targetsRepository`.
- Pin a `VibeIssue` → traverse to `VibeEngineeringTask` via `taskAddressesIssue`.

Each eval should seed the data, run the staged pipeline, and assert the expected entities appear in the result set.

Deduplication eval:

- Pin a `VibeReleasePlan` AND a `VibeGitRepository` that both lead to the same `VibeEngineeringTask` through different paths. Verify the merged result contains it once.

### Ownership and Collaboration

- Create a booth, assign a `Person` as owner via `controlBoothOwnedBy`, verify.
- Add a `VibeAgent` as collaborator via `controlBoothHasCollaborator`, verify.
- Verify a booth can have multiple owners and multiple collaborators simultaneously.

### Edge Cases

- Empty booth: create a booth with no members, query its members, verify empty result set (not an error).
- Shared member: add the same `VibeGitRepository` to two different booths, verify both booth queries return it.
- Booth-in-booth: verify the schema permits it (since `Collection` plays `controlBoothIncludes:member`). This confirms the known consequence described in the design.

### What Not To Eval

- TypeDB connection plumbing or schema loading mechanics — infrastructure, not control booth behavior.
- Gist supertype inheritance — upstream concern.
- Application-layer invariants (parent-child pinning, member limits) — those belong in application test suites, not schema evals.

### Efficiency Metrics

When the staged query pipeline becomes a real application endpoint, track:

- Step ratio: how many TypeDB transactions does the pipeline take vs the ideal? Should be 1 for booth, 1 for members, 1 per traversal path.
- Result set size: does the pipeline return a manageable number of entities, or do broad booths explode into huge result sets?

These are operational evals, relevant when the application layer exists.

## Implementation Guide

This section is for the implementing agent.

### Phase 1: Schema Changes

Modify `schema/vibemachine.tql`:

1. Add the new attributes: `control_booth_id`, `boothName`, `workspace_id`, `project_id`, `objective_id`, `issue_id`, `release_plan_id`, `milestone_id`.
2. Add the new relations: `controlBoothIncludes`, `controlBoothOwnedBy`, `controlBoothHasCollaborator`.
3. Add the `VibeControlBooth` entity.
4. Add the broad-supertype `plays` declarations for control booth membership.
5. Add the `plays` declarations for `Person` and `VibeAgent` on ownership and collaboration.
6. Redefine existing entities to add stable identifier `@key` attributes: `VibeWorkspace`, `VibeProject`, `VibeBusinessObjective`, `VibeGitRepository`, `VibeIssue`, `VibeReleasePlan`, `VibeMilestone`.

Do not modify `data/vibemachine-provenance.tql`. That is regenerated during the release process.

Update `data/vibemachine-schema-docs.tql` to add `SchemaResource` entries for:

- `VibeControlBooth` entity — assign to the Delivery group (`$group_delivery`).
- `controlBoothIncludes` relation.
- `controlBoothOwnedBy` relation.
- `controlBoothHasCollaborator` relation.
- New attributes: `control_booth_id`, `boothName`, `workspace_id`, `project_id`, `objective_id`, `issue_id`, `release_plan_id`, `milestone_id`.

Follow the existing format: each resource gets a `put` with `docKey`, `iri`, `typeLabel`, `kind`, `prefLabel`, `definition`, `scopeNote`, plus `inModule` and `resourceInGroup` relations. Use the existing entries as templates.

### Phase 2: Evals

Write evals as a new Node.js test script at `tools/package_contract/validate_control_booth.mjs`, following the pattern in `tools/package_contract/validate_typedb_bootstrap.mjs`.

Each eval should:

1. Insert test fixture data (a booth, member entities with stable identifiers, ownership and collaboration relations).
2. Run the query under test.
3. Assert the expected result.
4. Clean up inserted data.

The script requires the TypeDB container running with the full schema loaded. Use the same container lifecycle approach as `validate_typedb_bootstrap.mjs`.

Reference `data/vibemachine-status-seeds.tql` for the fixture data format.

### Scope Boundary

Do not implement:

- Application-layer behavior (collaborator permissions, traversal UX, parent-child pinning enforcement).
- Resolution of open questions listed at the end of this document.
- Changes to seed data, schema-docs, or provenance files.

### Verification

After implementation, the following should pass:

1. `npm run validate:bootstrap` — existing integrity checks still pass.
2. `npm run test:typedb-bootstrap` — schema loads successfully with new additions.
3. `node tools/package_contract/validate_control_booth.mjs` — all control booth evals pass.

## Status

Draft design note for review. This document captures the current direction for `VibeControlBooth` and the main open questions before schema implementation.

## Purpose

`VibeControlBooth` is a user-configurable lens into the knowledge graph.

It is intended to answer:

- What is the current focus of this person or agent?
- Which graph entities are directly in scope?
- From those direct anchors, what related entities should the application surface?

The control booth is not a project, workspace, repository, or implementation specification. It is a saved grouping of graph entities that the caller can use as the starting point for traversal.

## Core Modeling Decision

### Decision

Model `VibeControlBooth` as a `Collection` with direct membership relations, plus owner and collaborator relations.

### Rationale

- A control booth is fundamentally a grouping construct.
- The existing relations in the schema such as `usesWorkspace` and `belongsToWorkspace` already have domain-specific meanings and should not be reused for lens membership.
- The graph should record what the user explicitly added to the control booth.
- The application layer should decide how to expand from those direct members into related entities.

## Non-Goals

- Do not encode lens-expansion behavior as boolean settings on `VibeControlBooth` for now.
- Do not create a separate `VibeControlBoothConfiguration` type for now.
- Do not materialize all derived entities into the control booth.
- Do not include `VibeImplementationSpecification` directly in the control booth.

## Proposed Schema Shape

```typeql
define

attribute control_booth_id, value string;
attribute boothName, value string;

# "this control booth includes this member"
relation controlBoothIncludes sub isMemberOf,
  relates member as isMemberOfSubject,
  relates controlBooth as isMemberOfObject;

# "this control booth is governed by this owner"
relation controlBoothOwnedBy sub isGovernedBy,
  relates controlBooth as isGovernedBySubject,
  relates owner as isGovernedByObject;

# "this control booth has this collaborator"
relation controlBoothHasCollaborator sub hasParticipant,
  relates controlBooth as hasParticipantSubject,
  relates collaborator as hasParticipantObject;

entity VibeControlBooth sub Collection,
  owns control_booth_id @key,
  owns boothName,
  owns description,
  plays controlBoothIncludes:controlBooth,
  plays controlBoothOwnedBy:controlBooth,
  plays controlBoothHasCollaborator:controlBooth;

# Broad supertypes allowed as direct control booth members
Collection plays controlBoothIncludes:member;
Project plays controlBoothIncludes:member;
FormattedContent plays controlBoothIncludes:member;
Component plays controlBoothIncludes:member;
Task plays controlBoothIncludes:member;
Intention plays controlBoothIncludes:member;
ContentExpression plays controlBoothIncludes:member;
ScheduledEvent plays controlBoothIncludes:member;

Person,
  plays controlBoothOwnedBy:owner,
  plays controlBoothHasCollaborator:collaborator;

VibeAgent,
  plays controlBoothOwnedBy:owner,
  plays controlBoothHasCollaborator:collaborator;
```

## Relation Naming

The first draft used relation names like `boothIncludes`, `boothOwnedBy`, and `boothCollaborator`.

That shape works technically, but it pushes too much of the type name into every relation and starts to read like `boothFoo`.

The current proposal uses:

- `controlBoothIncludes`
- `controlBoothOwnedBy`
- `controlBoothHasCollaborator`

These names are all subject-first and read in a more consistent voice:

- control booth includes member
- control booth is owned by owner
- control booth has collaborator

## Direct Membership Model

The control booth stores direct membership only.

Example user actions:

- Add a `VibeReleasePlan` to a control booth.
- Add a `VibeGitRepository` to a control booth.
- Add a `VibeFeatureSpecification` to a control booth.

The graph records those actions as `controlBoothIncludes` relations.

It does not copy the included entity into the control booth.

## Supported Direct Member Types

The current agreed starting set is:

- `VibeWorkspace`
- `VibeProject`
- `VibeGitRepository`
- `VibeBusinessObjective`
- `VibeFeatureSpecification`
- `VibeEngineeringTask`
- `VibeIssue`
- `VibeReleasePlan`
- `VibeMilestone`

`VibeImplementationSpecification` is intentionally excluded.

Future roadmap entities can be added later.

## Supertype Membership Strategy

The design currently favors a broad-supertype approach over a strict allowlist.

### Why

- The application controls the write path.
- New concrete types can become control-booth members without repeated booth-specific schema edits, as long as they descend from an allowed supertype.
- This keeps the ontology stable while the product evolves.

### Important Detail

The broad-supertype list must actually cover the agreed member types.

The original draft missed two necessary supertypes:

- `Project`, so that `VibeProject` can be included
- `FormattedContent`, so that `VibeFeatureSpecification` can be included

Those are included in the proposed schema above.

## Control Booth in Control Booth

Because `VibeControlBooth` is itself a subtype of `Collection`, and `Collection` plays `controlBoothIncludes:member`, one control booth can be directly included in another control booth.

This is not a v1 feature.

### Consequence

- The schema may technically permit nested control booths under the broad-supertype approach.
- The application should not expose or rely on that behavior in v1.
- If nesting becomes a real product requirement later, it can be designed deliberately instead of arriving accidentally.

## Parent and Child Pinning

### Engineering Tasks

Do not allow both parent and child `VibeEngineeringTask` items to be pinned in the same control booth as separate focus anchors.

Rationale:

- Users care about the root engineering task and drill down from there.
- Child engineering tasks are transient.
- The control booth should reflect stable focus anchors rather than every execution-level child.

### Important Constraint Note

This is an application-layer invariant, not a schema-level constraint.

The schema can permit both items to be direct members. The UI and write-path logic are responsible for preventing the unsupported combination.

### Release Planning

For release planning, the expectation is different. If a user is viewing a `VibeReleasePlan`, they should naturally be able to see its `VibeMilestone` children through traversal.

This is a query and UX concern, not necessarily a reason to store both as direct control booth members.

For v1, traversal UX is sufficient. No special direct-pinning rule is needed for milestones beyond the normal direct-member behavior.

## Query Model

### Decision

Use a staged query pipeline.

### Shape

1. Query the `VibeControlBooth`.
2. Query its direct `controlBoothIncludes` members.
3. Inspect the member types.
4. Run application-selected traversal queries from those members.
5. Merge and deduplicate the results.

### Rationale

- The control booth is user-configurable.
- Different direct members imply different traversal paths.
- The caller already knows the schema and can decide whether to expand from a `VibeReleasePlan` to `VibeMilestone`, from a `VibeProject` to `VibeGitRepository`, or from a `VibeGitRepository` to `VibeEngineeringTask`.
- This avoids putting volatile UI behavior into the ontology.

### Example

If a control booth directly includes:

- `VibeReleasePlan: Release 1.2`
- `VibeGitRepository: api-server`

Then the application might:

1. Load direct members.
2. Traverse `VibeReleasePlan -> VibeMilestone`.
3. Traverse `VibeGitRepository -> VibeEngineeringTask`.
4. Stop at one hop in v1 unless the user pins the intermediate entity directly.

## Write Path

The database write path for control booth membership should stay simple.

### Add a direct member

```typeql
match
  $cb isa VibeControlBooth, has control_booth_id "cb-release-1-2";
  $release isa VibeReleasePlan, has release_plan_id "release-1-2";
insert
  (member: $release, controlBooth: $cb) isa controlBoothIncludes;
```

### Remove a direct member

```typeql
match
  $cb isa VibeControlBooth, has control_booth_id "cb-release-1-2";
  $release isa VibeReleasePlan, has release_plan_id "release-1-2";
  $rel isa controlBoothIncludes (member: $release, controlBooth: $cb);
delete
  $rel;
```

### Important Note

Stable identifiers belong on the entity being included, not on the `controlBoothIncludes` relation.

The relation should only gain attributes later if we need metadata about the inclusion itself, such as:

- who added it
- when it was added
- a note about why it was added

## Stable Identifier Review

### Good as-is

- `VibeFeatureSpecification`: `document_id @key`
- `VibeEngineeringTask`: `item_id @key`

### Good candidate but needs constraint

- `VibeGitRepository`: `remoteUrl` should become `@key` for now

### Missing stable key

- `VibeWorkspace`
- `VibeProject`
- `VibeBusinessObjective`
- `VibeIssue`
- `VibeReleasePlan`
- `VibeMilestone`

### Proposed Identifier Attributes

```typeql
define

attribute workspace_id, value string;
attribute project_id, value string;
attribute objective_id, value string;
attribute issue_id, value string;
attribute release_plan_id, value string;
attribute milestone_id, value string;
```

`issue_id` should be an internal graph-native identifier, such as a UUID or durable slug.

Rationale:

- `VibeIssue` is the graph's normalized tracked entity, not a mirror of a single external tracker record.
- External tracker IDs are not globally unique across systems.
- External tracker identity creates unnecessary coupling if systems change later.

If external issue trackers need to be correlated later, that should use a separate external-reference attribute or relation rather than replacing `issue_id`.

### Proposed Entity Changes

```typeql
redefine

entity VibeWorkspace sub Collection,
  owns workspaceName,
  owns workspace_id @key,
  owns description,
  plays usesWorkspace:workspace,
  plays belongsToWorkspace:workspace;

entity VibeProject sub Project,
  owns name,
  owns project_id @key,
  owns description,
  plays usesWorkspace:project,
  plays producesProduct:project,
  plays specifiesFeatureFor:project;

entity VibeBusinessObjective sub Intention,
  owns name,
  owns objective_id @key,
  owns description,
  plays motivatedBy:objective;

entity VibeGitRepository sub VibeRepository,
  owns remoteUrl @key,
  owns defaultBranch,
  plays targetsRepository:repository,
  plays isCategorizedBy:isCategorizedBySubject;

entity VibeIssue sub ContentExpression,
  owns name,
  owns issue_id @key,
  owns description,
  plays issueDerivedFromSubmission:issue,
  plays issueProducedByTriage:issue,
  plays taskAddressesIssue:issue,
  plays issueAboutProject:issue,
  plays issueAboutRepository:issue,
  plays issueCommittedToRelease:issue,
  plays issueTargetsMilestone:issue,
  plays duplicateOfIssue:duplicateIssue,
  plays duplicateOfIssue:canonicalIssue,
  plays planningDecisionAboutIssue:issue,
  plays resolutionDecisionAboutIssue:issue,
  plays closureDecisionAboutIssue:issue;

entity VibeReleasePlan sub ScheduledEvent,
  owns name,
  owns release_plan_id @key,
  owns description,
  plays milestoneInReleasePlan:releasePlan,
  plays issueCommittedToRelease:releasePlan;

entity VibeMilestone sub ScheduledEvent,
  owns name,
  owns milestone_id @key,
  owns description,
  plays milestoneInReleasePlan:milestone,
  plays issueTargetsMilestone:milestone;
```

## Ownership and Collaboration

Current direction:

- A control booth has one or more owners.
- A control booth can also have collaborators.
- Both people and agents may participate.

The ownership relation is currently modeled as a specialization of `isGovernedBy`, and the collaborator relation is currently modeled as a specialization of `hasParticipant`.

That is not a perfect semantic fit, but it preserves the package pattern of specializing gist relations instead of introducing entirely package-local relations where a reasonable super-relation exists.

This document now assumes owner-only rename and delete, with collaborators allowed to curate direct membership.

## Future Application Decisions

These are not schema blockers, but they should be decided as the control-booth UX takes shape.

### Recommended v1 Lifecycle

1. A user can create a `VibeControlBooth`.
2. A user can rename a `VibeControlBooth`.
3. A user can archive a `VibeControlBooth`.
4. Archived control booths should be hidden from the default working view.
5. Deletion should be rare and treated as a hard delete only when explicitly requested.

Rationale:

- Archival is safer than deletion for a saved lens.
- Control booths are user-curated context and may be worth restoring later.
- The graph benefits from preserving historical user organization unless the user intentionally removes it.

### Recommended v1 Default-Control-Booth Behavior

1. Do not create a mandatory default `VibeControlBooth` in the schema.
2. The application may offer a convenience "create my first control booth" flow.
3. If the application wants a starter experience, it should create an ordinary `VibeControlBooth`, not a special system-only type.

Rationale:

- A default control booth is a product convenience, not an ontology concept.
- Avoid introducing special schema semantics for what is fundamentally onboarding behavior.

### Recommended v1 Direct-Member Limits

1. The schema should not enforce a hard maximum member count.
2. The application should discourage oversized control booths.
3. A practical UI guideline is that a control booth should remain a focused lens, not a bulk container.

Rationale:

- Hard cardinality limits in schema are brittle without real usage data.
- The right limit is likely product- and UI-driven rather than ontology-driven.

### Recommended v1 Collaborator Permissions

1. Owners can manage membership, collaborators, and archival.
2. Collaborators can add and remove direct members.
3. Collaborators should not be allowed to delete the control booth.
4. Collaborators should not be allowed to rename the control booth.

Rationale:

- Collaboration should support shared curation.
- Destructive or identity-changing actions should remain with owners in v1.

### Recommended v1 Traversal Scope

1. The application should support only a small set of explicit first-class traversal paths in v1.
2. Those paths should be one hop from a direct control-booth member.
3. If the user needs two hops, they should pin the intermediate entity directly.

Rationale:

- The ontology should remain stable while the UI learns which expansions are actually useful.
- Explainable traversal matters more than maximal traversal power in the first version.

Important note:

- This is a product and application recommendation, not a schema-level constraint.
- Because traversal is owned by the application layer, the application can technically perform arbitrary recursive graph expansion.
- The v1 design intent is simply that the application should choose not to expose or depend on unconstrained recursive expansion as standard control-booth behavior.

### Recommended First-Class v1 Traversal Paths

| From direct member | Traverse to | Via relation | Why |
| --- | --- | --- | --- |
| `VibeReleasePlan` | `VibeMilestone` | `milestoneInReleasePlan` | Natural parent-child view |
| `VibeReleasePlan` | `VibeIssue` | `issueCommittedToRelease` | "What's in this release?" |
| `VibeProject` | `VibeFeatureSpecification` | `specifiesFeatureFor` | "What's being built?" |
| `VibeFeatureSpecification` | spec content items | `containsItem` | Drill into the specification |
| `VibeGitRepository` | `VibeEngineeringTask` | `targetsRepository` | "What work targets this repo?" |
| `VibeIssue` | `VibeEngineeringTask` | `taskAddressesIssue` | "What tasks address this issue?" |
| `VibeEngineeringTask` | `VibeRequirement` | `fulfillsRequirement` | Traceability |

Deferred until after v1:

- `VibeWorkspace` -> projects or repositories
- `VibeBusinessObjective` -> features
- multi-hop chains such as feature spec -> implementation spec -> engineering task
- issue -> decisions
- issue -> submissions

## Open Questions

1. Should control-booth nesting remain technically possible in schema while unsupported in the application, or should schema be tightened to exclude it?
2. If external issue trackers are linked later, what is the right external-reference pattern for `VibeIssue`?

## Summary

The current recommendation is to keep `VibeControlBooth` minimal:

- direct membership only
- owner and collaborator relations
- no booth-level traversal settings
- stable identifiers on all directly includable entities
- traversal behavior owned by the application layer
