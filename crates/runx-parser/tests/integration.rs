//! Single integration-test binary for runx-parser.
//!
//! Each module below is one integration test file, compiled and linked once
//! as a single binary instead of one binary per file. `autotests = false` in
//! Cargo.toml keeps Cargo from also building each file as its own binary.
//! See .scafld/specs/active/test-surface-build-consolidation.md.

mod parser_catalog;
mod parser_fixtures;
mod parser_graph_allowed_tools;
mod parser_graph_context_edges;
mod parser_rejections;
mod parser_sandbox;
mod parser_source_kind;
