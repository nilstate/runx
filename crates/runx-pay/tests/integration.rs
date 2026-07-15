// Single integration binary: every tests/*.rs module is declared here so the
// crate links one test executable instead of one per file. Guarded by
// scripts/check-integration-test-modules.mjs.
mod execution;
mod ledger_projection;
mod receipts;
mod refunds;
mod state;
mod stripe_spt;
