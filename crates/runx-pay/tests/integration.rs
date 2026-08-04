// Single integration binary: every tests/*.rs module is declared here so the
// crate links one test executable instead of one per file. Guarded by
// scripts/check-integration-test-modules.mjs.
mod contract_validation;
mod execution;
mod ledger_projection;
mod receipts;
mod refunds;
mod schema_generator_check;
mod state;
mod stripe_spt;
mod support;
