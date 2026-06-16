# Act-model reconciliation

This note settles a recurring question: do the runx core contracts still need an
"act-model" reconciliation, or is the live shape final? Short answer: **the live
contracts are the reconciled model.** Older plan vocabulary around governed units,
sealed receipt entries, and effect-form naming was aspirational, not a pending
reshape of the core contracts.

## The live model (source of truth)

The normalized act-model is implemented and shipping in `crates/runx-contracts`:

- **Act** (`src/act.rs:130`) — a unit of governed work. Its kind is **`ActForm`**
  (`src/act.rs:49`): `revision`, `reply`, `review`, `observation`, `verification`.
  An Act carries `criterion_bindings`, `change_request`/`change_plan`
  (`RevisionDetails`), target/source/artifact refs, and a closure.
- **Decision** (`src/decision.rs:64`) — a governed choice, with a `Closure`
  (`ClosureDisposition`: `closed`, `deferred`, `superseded`, `declined`, `blocked`,
  `failed`, `killed`, `timed_out`).
- **Signal** (`src/signal.rs:64`) — an inbound trigger, with a `SignalSchema` and a
  `SignalTrustLevel`.
- **Receipt** (`src/receipt.rs:321`) — the sealed, flat record of a run. It inlines
  `signals: Vec<Reference>`, `decisions: Vec<Decision>`, `acts: Vec<ReceiptAct>`, a
  `seal`, `authority`, `subject`, `idempotency`, and optional `lineage`. The journal
  is a *projection* computed on demand from the receipt
  (`runx-runtime/src/journal.rs::project_receipt_journal`), not a separately
  persisted artifact.

The `runx.receipt.v1` cutover is live and green; these types are what the runtime
emits and seals.

## Skills, runs, and acts

A skill is a definition; a run is an act. The relationship is fixed:

- **Each run is an act by default.** Every governed run seals at least one act.
  When a skill declares nothing, that act is a generic `observation`: it ran, it
  was admitted by the harness, it succeeded or failed. Nothing executes
  ungoverned; the only open question is how richly the act is described. In the
  runtime this default is `RuntimeAct::observation`
  (`crates/runx-runtime/src/receipts/act.rs`).
- **A skill describes the act it performs.** A skill may declare its act in an
  `act:` block: the `ActForm` (`review`/`reply`/`revision`/`verification`/
  `observation`), the purpose, and how the target, decision, and effect are read
  from trusted, driver-pinned inputs. The runtime fills the structure from those
  inputs; the model authors only the reason prose. That trust boundary is the
  point: the skill and its inputs declare what act this is and what it targets, so
  a receipt reads "operator reviewed claim c-4417, rejected" with the model unable
  to forge the structure, only to narrate it. A declared act seals a domain act
  (`receipts::seal::domain_act_receipt`); an undeclared one seals the observation.
- **Acts chain.** An act records the authority it held (`Receipt.authority`,
  including the credentials it carried, as `grant_refs`) and chains by lineage:
  `lineage.previous` (this act follows the one it acts on, e.g. a review follows
  the delivery it reviewed), `lineage.parent`/`children` (a graph turn is the
  parent act and its steps are child acts), and `Intent.derived_from` (the acts an
  act reasoned from). A graph is therefore a composition of chained acts, not a
  separate kind of thing.
- **One act per run.** The discipline that keeps a receipt honest: a run produces
  one declared (or default) act, composed into chains by lineage, never a loose
  bag of acts. A standalone skill is a one-act run; a graph is a chain of acts; a
  paused run is an act left open mid-chain.

## Plan vocabulary -> live contracts

Some plans (`plans/runx.md`, `plans/aster.md`) use an alternate vocabulary. It maps
onto the live shape with no contract change required:

| Plan concept                  | Live contract                                                        |
| ----------------------------- | -------------------------------------------------------------------- |
| governed unit of work         | the run's `Subject` + its `Act`s                                     |
| sealed receipt entry          | an `Act` carried in a sealed `Receipt` (`Receipt.acts` + `Receipt.seal`) |
| effect form                   | `ActForm`                                                            |
| decision                      | `Decision`                                                           |
| signal                        | `Signal`                                                             |

There is intentionally **no** `SealedAct` type and **no** `effect.form` enum in the
code: introducing aliases for unused vocabulary would be speculative cruft. If a
future version adopts that naming, it can be added then.

## Conclusion

v1 finalizes the act/decision/signal/receipt model; the alternate plan vocabulary is
future-aspirational, not an outstanding reconciliation against the core contracts.
The remaining act-model work is in *enforcement and adoption* (e.g. aster gating its
dispatch on declared act forms and verification status), not in reshaping these
types. Those live on the aster/consumer side, not in the kernel contracts.
