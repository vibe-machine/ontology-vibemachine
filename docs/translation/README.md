# Package Contract

This repository publishes the `vibemachine` ontology package using the self-describing documentation and provenance contract established by `ontology-gist`.

Current package boundaries:

- `schema/`: package schema plus the shared self-describing/provenance schemas
- `data/`: package seed data, queryable provenance records, and schema documentation records
- `manifests/`: machine-readable package manifest for deterministic artifact tracking
- `tools/package_contract/`: bootstrap validation for this hand-authored package

Current status:

- `data/vibemachine-schema-docs.tql` is the authoritative documentation path for package-local schema resources.
- `data/vibemachine-provenance.tql` records the package build, source artifacts, and generated artifact checksums.
- `manifests/vibemachine-v0.6.0.package-manifest.json` is the filesystem source of truth for the package contract.
- Legacy TypeDoc files are retired and are no longer part of active package assembly.

Design references:

- `Design: TypeDB Schema Documentation & Provenance`
  - https://www.notion.so/31bc633a07178161923fd6f322f0e5fb
- `Design: Self-Describing Schema`
  - https://www.notion.so/31cc633a07178180b139cb56c3c80268

Canonical contract reference:

- `ontology-gist`
  - https://github.com/vibe-machine/ontology-vibemachine

This package is hand-authored, so it does not vendor upstream ontology source files or ship OWL translation tooling. It still follows the same documentation/provenance contract so downstream loaders and tooling can treat ontology packages consistently.
