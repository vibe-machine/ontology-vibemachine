# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

A TypeDB ontology package (`vibemachine`) that models workspace, product, and software delivery concepts. The schema is written in TypeQL and layers on top of the `gist` upper ontology (>=1.1.0). This is a schema-only package — no application code to execute.

## Commands

```bash
# Fast validation (no external deps) — checks manifest hashes and package.json integrity
npm run validate:bootstrap

# Full test — loads schema into a real TypeDB instance via container
npm run test:typedb-bootstrap

# Both
npm test

# Regenerate manifest from hand-authored sources (requires sibling ontology-gist repo)
npm run refresh:package-contract

# Release (requires sibling ontology-tooling repo)
npm run release
npm run release:check   # validate-only, no commit
```

TypeDB bootstrap test requires: a container runtime (`docker`/`podman` or `CONTAINER_BIN`), TypeDB 3.8.0 image (`TYPEDB_IMAGE`), and TypeDB CLI at `~/.typedb/typedb` (`TYPEDB_BIN`).

## Architecture

### Schema Layering

All Vibe entities and relations specialize GIST base types (`Category`, `Intention`, `Specification`, `Determination`, `Collection`, `Task`, etc.). Every GIST relation used gets a domain-specific specialization with natural-language role names so queries read like English:

```typeql
relation motivatedBy sub isBasedOn,
  relates featureSpec as isBasedOnSubject,
  relates objective as isBasedOnObject;
```

### Domain Model Layers

- **Why** — `VibeBusinessObjective` (drives product work)
- **What** — `VibeFeatureSpecification` containing `VibeRequirement`, `VibeDecision`, `VibeConstraint`, `VibeQuestion`
- **How** — `VibeImplementationSpecification` containing `VibeEngineeringTask`, `VibeVerification`, `VibeEval`, `VibeDependency`
- **Who** — `VibeAgent`, `Person`, `Organization` via `VibeTaskAssignment` + `VibeAgentProfile`
- **Where** — `VibeWorkspace`, `VibeProject`, `VibeRepository`, `VibeProduct`
- **Lifecycle** — `VibeSubmission` → `VibeIssue` with triage/planning/resolution/closure decisions; `VibeReleasePlan` + `VibeMilestone`

### Assembly Load Order

Files load in this exact sequence (defined in `package.json` → `assembly.loadOrder`):

1. `schema/self-describing-schema.tql` — meta-schema (generated)
2. `schema/package-provenance.tql` — provenance schema (generated)
3. `schema/vibemachine.tql` — main domain ontology (hand-authored)
4. `data/vibemachine-status-seeds.tql` — category instances (hand-authored)
5. `data/vibemachine-provenance.tql` — build provenance records (generated)
6. `data/vibemachine-schema-docs.tql` — queryable schema docs (generated)

### Package Contract

Artifact integrity is tracked via SHA256 hashes in `manifests/vibemachine-v{VERSION}.package-manifest.json`. The bootstrap validator (`tools/package_contract/validate_bootstrap.mjs`) checks all source and generated artifact hashes match the manifest.

### Migrations

Live in `migrations/` with three phases: `preflight/` (assert pre-state) → migration file → `verify/` (assert post-state). Migration mode is `replace`. Current path: 0.7.x → 0.8.0.

## Naming Conventions

- All domain entities prefixed with `Vibe` (e.g., `VibeIssue`, `VibeEngineeringTask`)
- Category entities use `owns name @key` or `owns status_label @key`
- Content items use `owns item_id @key` and `owns document_id`
- Attributes: `camelCase` for multi-word (`workspaceName`, `remoteUrl`), `snake_case` for identifiers (`item_id`, `status_label`)
- Relations: present-tense verbs (`motivatedBy`, `implementsFeature`, `fulfillsRequirement`)

## Sibling Repositories

Scripts reference sibling repos at `../ontology-gist` and `../ontology-tooling`. These must be checked out as siblings for `refresh:package-contract` and `release` commands.
