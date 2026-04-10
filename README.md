# Tendermint Consensus Simulator

An interactive, educational web-based simulator for the Tendermint BFT consensus
algorithm. Explore nondeterministic executions step-by-step, visualizing how
node states evolve through propose, prevote, and precommit phases.

Based on **Algorithm 1** from
["The latest gossip on BFT consensus"](https://arxiv.org/abs/1807.04938)
(Buchman, Kwon, Milosevic, 2019) and the
[Malachite pseudocode specification](https://github.com/circlefin/malachite/blob/main/specs/consensus/pseudo-code.md).

## Quick Start

Serve the directory over HTTP (ES modules require it):

```bash
python3 -m http.server 8080 --directory .
```

Open [http://localhost:8080](http://localhost:8080) in a browser.

No build step, no dependencies, no framework. Just vanilla HTML, CSS, JavaScript,
and SVG.

## How It Works

The simulator models 4 nodes (n = 3f + 1, f = 1) running a single height of the
Tendermint consensus algorithm. Each node maintains the full set of algorithm
variables from the pseudocode:

| Variable | Meaning |
|----------|---------|
| `round` | Current round number |
| `step` | Current phase: propose, prevote, or precommit |
| `lockedValue` / `lockedRound` | Value the node is locked on and the round it locked |
| `validValue` / `validRound` | Most recent value with 2f+1 prevotes and the round |
| `decision` | Decided value (nil until consensus is reached) |

### Execution Model

The simulator is **nondeterministic**. At each state, it computes which
transitions (rules from Algorithm 1) are *enabled* for each node. The user
picks which one fires next via a per-node dropdown.

- **Message delivery is instant.** When a node broadcasts a message (PROPOSAL,
  PREVOTE, or PRECOMMIT), it is immediately available in every node's message
  log. There is no network delay modeling.
- **Timeouts are user-triggered.** When a timeout is scheduled (e.g.,
  `timeoutPropose`), it appears as an enabled transition. The user decides
  when to fire it, enabling exploration of timeout scenarios.
- **Random steps** fires a random enabled transition for each node (in random
  order), advancing the simulation quickly.

### Enabled Transitions

Each pseudocode rule maps to an enabled transition when its guard condition is
satisfied:

| Rule (Lines) | Trigger |
|--------------|---------|
| L11-19 | `StartRound(r)` when node is the proposer: broadcast PROPOSAL |
| L11-21 | `StartRound(r)` when non-proposer: schedule `timeoutPropose` |
| L22-27 | Received PROPOSAL with `vr = -1`, in propose step: broadcast PREVOTE |
| L28-33 | Received PROPOSAL with `vr >= 0` + 2f+1 PREVOTE from `vr`: broadcast PREVOTE |
| L34-35 | 2f+1 PREVOTE (any value), in prevote step, first time: schedule `timeoutPrevote` |
| L36-43 | PROPOSAL + 2f+1 PREVOTE for value, step >= prevote, first time: lock + PRECOMMIT |
| L44-46 | 2f+1 PREVOTE for nil, in prevote step: PRECOMMIT nil |
| L47-48 | 2f+1 PRECOMMIT (any value), first time: schedule `timeoutPrecommit` |
| L49-54 | PROPOSAL + 2f+1 PRECOMMIT for value (any round), undecided: DECIDE |
| L55-56 | f+1 messages from a higher round: skip to that round |
| L57-60 | `OnTimeoutPropose`: PREVOTE nil |
| L61-64 | `OnTimeoutPrevote`: PRECOMMIT nil |
| L65-67 | `OnTimeoutPrecommit`: start next round |

### Thresholds

With 4 nodes (n = 4, f = 1):

- **Quorum (2f+1):** 3 nodes
- **Skip threshold (f+1):** 2 nodes

### Proposer Selection

Round-robin: `proposer(height, round) = round % 4`.

## User Interface

### Controls

- **Reset:** Restart the simulation from the initial state.
- **Undo:** Revert the last transition (full state snapshot restoration).
- **Random steps:** Fire a random enabled transition for each node.

### Layout

The interface has four areas:

1. **Next Step (left pane):** Clickable enabled transitions per node. Single
   click fires a transition. Color-coded borders by action type. Tooltips show
   full rule descriptions. Hovering auto-switches the pseudocode tab.

2. **Current State (middle pane):** Color-coded state box per node showing all
   algorithm variables. Always visible regardless of timeline scroll.

3. **Timeline (scrollable):** Lamport diagram showing execution history. State
   boxes flow left to right with transition arrows. A dashed center lane line
   runs behind each row. Global step numbers (#N) in the top-right corner of
   each box. Hourglass emoji on transitions that schedule timeouts. Red X on
   message arrows where timeouts fired (message arrived too late).

4. **Pseudocode (right panel):** Algorithm 1 lines 11-67. Per-node tabs show
   which rules are enabled (yellow highlight). Lines actually executed are bold.
   Click highlighted lines to fire transitions. Toggle with the Pseudocode button.

### State Boxes

Color-coded by step: blue (propose), orange (prevote), yellow (precommit),
green (decided).

### Message Arrows

Vertical arrows from sender to receiver rows. Blue (PROPOSAL), orange
(PREVOTE), yellow (PRECOMMIT). Dashed for nil votes. Full message parameters
shown as labels (e.g., `PROPOSAL(r=0, A, vr=-1)`).

## Architecture

```
index.html              Entry point. Loads all JS/CSS. Page shell.
css/
  style.css             All styling: layout, colors, SVG classes.
js/
  types.js              Shared vocabulary: enums, constructors, constants.
  consensus.js          Pure consensus state machine.
  engine.js             Orchestrator: system state, transitions, undo.
  renderer.js           SVG rendering: boxes, arrows, layout.
  ui.js                 DOM controls: panes, pseudocode panel, traces.
  main.js               Bootstrap: wires engine + renderer + ui.
traces/
  index.json            Manifest of predefined traces.
  happy-path.json       Trace: all nodes decide A in round 0.
  ...                   Additional trace files.
```

### types.js

Defines all shared types and constants:

- **Enums:** `Step` (propose/prevote/precommit), `MessageType`
  (PROPOSAL/PREVOTE/PRECOMMIT), `InputType` (13 consensus inputs),
  `OutputType` (7 consensus outputs), `TimeoutType`.
- **Constructors:** `createMessage()`, `createNodeState()`, input/output
  factory functions.
- **Constants:** `NUM_NODES = 4`, `QUORUM = 3`, `SKIP_THRESHOLD = 2`.

### consensus.js

A **pure function** with no side effects:

```
applyConsensusInput(state, input) -> { newState, outputs[] }
```

Given a node's current state and a consensus input, returns the new state and a
list of output actions. This is a direct translation of Algorithm 1's pseudocode
lines 10-67. Each `InputType` maps to a specific set of pseudocode lines.

The state machine never reads the message log or interacts with other nodes. It
only processes pre-validated inputs and produces declarative outputs.

### engine.js

The orchestrator that owns the system state and provides the main API:

- **`computeEnabledTransitions(nodeId)`**: For each of the ~13 pseudocode rules,
  checks whether the guard condition is satisfied given the node's state, the
  global message log, and the "fired once" set. Returns a list of transition
  descriptors with human-readable labels.

- **`executeTransition(nodeId, transitionId)`**: Pushes a full state snapshot to
  the undo stack, applies the consensus state machine, processes outputs
  (broadcast messages to the global log, schedule timeouts, record decisions,
  chain compound transitions like TimeoutPrecommit -> StartRound).

- **`stepAll()`**: For each node in random order, fires a random enabled
  transition.

- **`undo()` / `reset()`**: State navigation via full snapshot stack
  (`structuredClone()`).

Key design decisions:

- **Stateless threshold checking.** Instead of maintaining incremental vote
  tallies, threshold helpers scan the global message log each time. With 4 nodes
  and a single height, the log stays small. This simplifies undo (restoring a
  snapshot automatically fixes all threshold computations).
- **"For the first time" tracking.** Rules L34, L36, and L47 must fire only once
  per round. Tracked via a `firedOnceRules: Set<string>` per node (e.g.,
  `"L34:r0"`), included in undo snapshots.
- **Instant message delivery.** Broadcast messages are appended to a global log
  shared by all nodes. No per-node message buffers.

### renderer.js

Renders the SVG Lamport diagram:

- Computes layout positions from timeline entries (each entry has a global step
  index for x-positioning).
- Draws initial state boxes, then iterates timeline entries to draw subsequent
  boxes, within-node transition arrows, and cross-node message arrows.
- Message arrows are vertical lines from sender to receiver row, with labels
  showing full message parameters. Arrows that timed out are greyed with a red X.
- Hourglass emoji on transitions that schedule timeouts.
- SVG layers: message arrows (back), transition arrows, state boxes, message
  labels (front).
- Auto-scrolls the container to the rightmost state.

### ui.js

Handles all DOM interaction:

- Builds the left pane (clickable transition lists), state pane (current state
  boxes), and pseudocode panel (highlighted lines with per-node tabs).
- `refreshAll()` re-renders the timeline, updates all panes, and refreshes
  pseudocode highlights after every state change.
- Hover on transitions auto-switches the pseudocode tab and highlights the
  corresponding rule block.
- Loads predefined traces from `traces/index.json` and replays them on click.
- Save trace downloads the current execution as a JSON file.

### Data Flow

```
User clicks a transition / Random steps
  -> ui.js calls engine.executeTransition()
    -> engine pushes undo snapshot
    -> engine calls consensus.applyConsensusInput()
    -> engine processes outputs (broadcast, schedule timeout, decide)
    -> engine appends timeline entry
  -> ui.js calls refreshAll()
    -> renderer rebuilds SVG from timeline entries
    -> left pane: recompute enabled transitions per node
    -> state pane: update current state boxes
    -> pseudocode: highlight enabled rules, bold executed lines
```

## Predefined Traces

Clickable traces below the legend load prerecorded executions instantly.
Traces are stored as JSON files in the `traces/` directory.

| Trace | Description |
|-------|-------------|
| **Happy path** | All 4 nodes decide value A in round 0. The simplest successful execution. |
| **Timeout and prevote nil** | p1 times out waiting for the proposal, prevotes nil, but still locks and decides A when the polka arrives. Shows how late messages are still processed. |
| **Cross-round decision** | p0-p2 decide in round 0. p3 times out through all phases, moves to round 1, then decides A using round 0's proposal and precommits (L49-54 checks any round). |
| **Locking behavior** | All nodes lock on A (L36-43) but timeout before deciding. They move to round 1 with `lockedValue=A` and `validValue=A`. The round 1 proposer re-proposes A. |
| **Reached round 1** | All nodes timeout through prevote and precommit in round 0, moving to round 1. |

### Saving Traces

Click "Save trace" in the timeline header to download the current execution
as a JSON file. To add it as a predefined trace, move the file to `traces/`
and add an entry to `traces/index.json`.

## References

- [The latest gossip on BFT consensus (arXiv)](https://arxiv.org/abs/1807.04938)
- [Malachite pseudocode specification](https://github.com/circlefin/malachite/blob/main/specs/consensus/pseudo-code.md)
- [Malachite overview](https://github.com/circlefin/malachite/blob/main/specs/consensus/overview.md)

## Limitations

- Fixed at 4 nodes (no configurable node count).
- Single consensus height (no multi-height progression).
- All nodes are correct (no Byzantine behavior simulation).
- No real-time animation (transitions are discrete, user-driven steps).
- Values are abstract labels (A, B, C), not actual block data.
