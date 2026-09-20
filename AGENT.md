# Metarouter

A route planner for the **Grimoire** minigame in _Cookie Clicker_.

Given a list of upcoming spells — each with some subset of the four useful effects — the
app searches for the sequence of actions that **maximizes the score** before the list is
consumed. It is a search/solver, not a simulator: the interesting work is modeling the
action space accurately and pruning it aggressively enough to stay fast.

> The core model and tables are expected to change often. Prefer understanding the ideas
> in this document over memorizing current constants, flags, or numbers.

## The problem, in one paragraph

The player has a pool of magic and a queue of spells about to resolve. Each spell may carry
some number of _useful effects_, and the goal is to bank as many of them as possible. The
player may cast spells (spending magic) or take a small set of special actions, in any
order, to manipulate which effects actually land. The search picks the best sequence.

## Core concepts

- **Spell** — a queue entry with four effect flags (`bs`, `cf`, `ef`, `dfBs`) plus a `gfdRs`
  roll. Effects are the objective; the flags are what the search tries to secure.
- **Score** — the accumulated value of banked effects (`bs` dominates; `cf` and `ef` are
  worth a fixed bonus). **The score function is the definition of "good" for the whole
  search** — most heuristics and pruning rules are justified relative to it.
- **Magic** — the resource. Has a current magic and max magic, the latter is adjustable up
  to a cap (the `metamax`). Spending is bounded by the current magic.
- **Actions** — the moves available to the search. Conceptually they fall into groups:
  - **Casts** — cast one of the eight spells. Each has a _base_ cost and a _portion_ cost;
    the portion scales with max magic.
  - **Backfiring** — GFD rolls may also produce backfires that disable certain effects, so the
    roll should influence more than just spell selection.
  - **GFD** — the `g!` variants. A GFD casts a spell at a **reduced cost**, but only when
    its roll maps the spell onto the current GFD pool. If the intended spell is not
    available, the attempt is a no-op rather than a wasted cast, with the spent magic refunded.
    This mechanic allows for one row's effects to triggered more than once due to the order
    of the way the spells are incremented.
  - **Resolve** — a GFD's effect is _delayed_. Resolving is what actually applies the
    pending effect; the delay is what lets the player interleave other actions. Pending
    resolves form a queue and are the main source of ordering decisions.
  - **Refill** — restores a large, fixed chunk of magic, limited to a small number of
    charges. Refilling at the cap is strictly wasted and must stay illegal.
- **State** — everything a branch needs to be replayed or compared: queue position, magic,
  remaining refills, banked effects, and the pending-resolve queue. The search works by
  cloning and mutating state, so **state must stay cheap to duplicate and must never reach
  back into shared mutable data**.
- **Branch pruning** — discard strictly dominated branches. This is the largest expected
  speedup and should be expressed as an invariant on state, not ad-hoc checks.

## Architecture

```
src/
  index.ts              browser entry point (mounts the app)
  app/
    app.ts              top-level page shell
    route/
      route.ts          DOMAIN CORE: Action catalog, RouteState, and the search
      spelldata.ts      spell definitions (costs, ordering, indices)
      tables.ts         precomputed lookup tables used by the core
      seedgen.ts        base-game RNG shim: seed/save reading + spell generation
  lib/
    dom.ts              small DOM query helper
    spell.ts            spell flags, defaults, and small helpers
    max-magic.ts        the arithmetic linking max magic to towers
    url-params.ts       the planner's URL contract: read on load, build share links
  components/
    route-planner.ts    input form + result rendering, drives the search worker
    route-worker.ts     runs route() off the main thread and reports progress
    spell-table.ts      editable table of spells (one row per queue entry)
    save-import.ts      save/seed paste box: validation + the import callback
    spell-preview.ts    read-only table of the spells a seed generates
  styles/               SASS, split into base / variables / mixins + components
```

The important boundary is **`src/app/route/` is pure domain logic** (no DOM, deterministic,
directly testable). Everything under `components/` and `app/` is presentation that reads
user input and displays a result. When changing behavior, work in the core; when changing
how results are shown or collected, work in the components.

`seedgen.ts` is the one file in the core that leans on the browser: its RNG shim closes over
`window` while the module loads, so the node test bundle must not import it. It is also the
only place allowed to know how the game's randomness is laid out.

### The core, in pieces

1. **Definitions** — `spelldata.ts` names the spells and their cost profile; `spell.ts`
   holds the effect flags and how they are created/defaulted. Names of flags and spells
   should stay in sync across the app.
2. **Tables** — `tables.ts` precomputes expensive, input-independent data: per-spell cost
   ladders and the mapping from (magic, cap) to a GFD pool. These exist because the search
   visits the same combinations millions of times; anything computable ahead of time should
   be, and anything already in a table should not be recomputed inline.
3. **Actions** — a declarative catalog. Each action exposes _what it costs as a GFD_,
   _whether it is currently legal_, and _how it mutates state_. Adding an action is meant
   to be a localized change: describe its eligibility and its effect, and the search picks
   it up automatically. Actions that cannot apply report cancellation rather than throwing.
4. **Search** — a depth-first exploration over the action space, choosing branches by the
   score function, with cycle protection so self-cancelling actions (resolve/refill that
   change nothing) cannot recurse forever. It runs **unbounded** by default: a caller that
   wants a bounded answer passes a `stepLimit` and must then handle the truncated result.
   An optional `onProgress` callback reports how many branches have been explored and the
   best score so far, so a caller can show live counters and stop the search from the outside.
5. **Seed generation** — `seedgen.ts` rebuilds the queue from the game instead of from a
   hand-typed table: it seeds the base-game RNG with the save's seed and the cast count of
   the row it wants, decides that row's roll and buffs, and `purifyPlannerData` folds the
   result into the same `Spell` shape the table produces. It also reads the seed and the
   cast count back out of a pasted save. A raw row carries the success, DF-variant and
   backfire buff for both the no-change and the one-change case — that is what the preview
   renders; the router only ever sees the purified `Spell`s.

### UI

The UI is intentionally thin. The queue usually comes from the game: `save-import.ts` turns
a pasted save — or a bare 5-character seed plus a cast count — into a seed, and
`route-planner.ts` regenerates the queue through `seedgen` whenever the cast count or the
lookahead changes. `spell-table.ts` is the manual fallback, hidden behind a "direct spell
input" toggle so a hand-edited queue cannot quietly disagree with an imported seed, and
`spell-preview.ts` renders those same generated rows read-only, so what the router is about
to work on is visible next to the box that produced it.

The inputs the search needs — cast count, lookahead, max magic, current magic, refills and the
two availability selectors (Supreme Intellect / Reality Bending, which set the run's
`siAllowed` / `rbAllowed`) — are deliberately mandatory: the run button stays disabled until
every one of them holds a value, and the ones an import can supply (cast count, lookahead) or
that need a seed to mean anything (max magic, current, refills, the selectors) are hidden
until the first successful import. Max magic is one control made of three linked fields (max
magic, tower count, tower level) with `lib/max-magic.ts` owning the conversion, since they
describe a single fact.

A whole form state travels in the URL: on load the planner reads `?seed`, `?casts`,
`?maxmagic`, `?towercount`, `?towerlevel`, `?refills`, `?si`, `?rb`, `?currentmagic` and
`?lookahead` (plus `?execute=true` to route as soon as the form is complete), and the share
button at the right of the "direct spell input" row copies those same parameters back out as
a link.
The format lives in `lib/url-params.ts`; a shared link never carries `execute`, so opening
one cannot start a search by surprise.

The search is a long synchronous loop, so it runs in `components/route-worker.ts` and the form
only reads progress messages from it; the run button becomes a halt button that terminates
the worker (a worker inside the search cannot answer a message). While it runs the form shows
the live counters — branches, branch throughput on a smoothed average, best combo and elapsed
time. A finished run reports its final combo, resources, and whether the result was truncated —
because a truncated result is a _different claim_ than an optimal one and should never be
presented as the answer.

## Build & run

- `npm run dev` — watch + serve (esbuild) at `http://localhost:3000`
- `npm run build` — clean production build into `dist/`
- `npm run typecheck` — `tsc --noEmit`
- `npm test` — bundle `src/app/tests/route.test.ts` and run it on node's built-in test runner
- `npm run format` / `format:check` — Prettier

Tooling: TypeScript (strict, no emit — esbuild does the transpiling), esbuild for bundling,
dart-sass for styles (`scripts/build.mjs` wires a SASS plugin and mirrors `public/` into
`dist/`). `scripts/test.mjs` bundles `src/app/tests/route.test.ts` with esbuild and hands it to
node's test runner — there is no framework, just the core driven directly. That file covers the
core structurally (the score function, the `RouteState` copy contract, action legality) and
checks the precomputed tables against fresh recomputations — including `offsetGraph.js`, the
graph section's own encoding of the raw transmutation table, which the tests drive under node.

## Design guidance

- Keep the core **pure and deterministic** — no DOM, no globals, no hidden state. The
  `seedgen` RNG shim is the one deliberate exception, and it stays quarantined there.
- **Precompute** input-independent work into tables; recomputing inside the search is the
  most common performance mistake.
- Express new rules as **action properties** and **state invariants**, not as special cases
  sprinkled through the search loop.
- Prefer **making illegal actions unavailable** over detecting and rejecting them later
  (this is both faster and removes whole subtrees).
- State the **meaning of the score** in one place and keep every pruning/ordering rule
  consistent with it.

## Roadmap / open ideas

These are directions the model is expected to grow toward; they are not implemented.

- **Search ordering** — visit promising branches first so pruning fires earlier and time on
  dead branches shrinks.
- **Refund modeling** — when a GFD cannot cast its selected spell, it refunds instead.
  Capture this by letting actions express "cast at the maximal cost" without iterating over
  every possible magic count (which is far too slow).
- **Above-cap magic** — resolving a GFD briefly permits magic above `metamax`; the model
  currently does not represent that window.
- **Human-viable sequences** — metrics that restrict the optimal answer to sequences a
  player can actually perform, so the output is a route, not just a score.
- **Preview fidelity** — the upcoming-spells box assumes the base backfire chance, while the
  router scales it with `di`/`diB` (and, in the game, with the golden cookies on screen), so
  a row can backfire in a run and not in the preview.
