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

### Single-file build

To produce a `file://`-openable bundle (e.g. to share by double-click), run:

```bash
python3 build.py
open dist/tendermint-sim.html
```

`build.py` uses the Python stdlib plus `npx esbuild` (Node required). The
result is a single `dist/tendermint-sim.html` with all JS, CSS, and predefined
traces inlined. The repository tracks `dist/tendermint-sim.html`. Run
`build.py` again after you change a source file.

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
picks which one fires next via a per-node list.

- **Every run starts Before GST.** This retains the simulator's unrestricted
  interleavings: any enabled protocol action or timeout action can be chosen,
  even when another node could make protocol progress.
- **Delivery is an availability overlay, not a network clock.** A broadcast is
  appended to every node's inbox immediately. Before GST, clicking a sender can
  mark that copy as not received, which hides it from that node's rule guards;
  clicking again restores it or acknowledges a late proposal.
- **Declare GST switches the scheduler.** It makes all currently hidden
  messages available, disables new not-received marks, and globally suppresses
  every timeout action whenever any non-timeout protocol action is enabled on
  any node. A timeout becomes selectable after GST only when all enabled
  actions system-wide are timeouts.
- **GST is deliberately abstract.** It represents the stable regime “after GST
  with sufficiently large timeouts.” This is stronger than formal DLS partial
  synchrony: the simulator has no logical clock, explicit GST time, or
  Δ-bounded delivery.
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
- **Before/After GST:** Shows the scheduler phase. **Declare GST** performs the
  one-way phase transition described above; Undo can restore the prior phase.
- **Undo:** Undoing an ordinary consensus transition restores protocol state
  while delivery strikes persist and are re-anchored to the restored timeline
  when needed. Undoing GST restores the phase, strikes, and late-arrival state
  exactly to their pre-GST snapshot.
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
   message arrows whose delivery is marked not received.
   Declaring GST adds a labeled boundary and a tinted background to the
   post-GST portion of the timeline.

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
  node's inbox, and the "fired once" set. Returns a list of transition
  descriptors with human-readable labels. After GST, it computes raw
  transitions for every node so that any non-timeout action can suppress
  timeout actions globally.

- **`executeTransition(nodeId, transitionId)`**: Pushes a full state snapshot to
  the undo stack, applies the consensus state machine, processes outputs
  (copy broadcast messages into every node's inbox, schedule timeouts, record
  decisions, chain compound transitions like TimeoutPrecommit -> StartRound).

- **`declareGST()`**: Records an undoable global timeline event, reveals
  user-hidden and timeout-struck messages, and enables post-GST scheduling.

- **`stepAll()`**: For each node in random order, fires a random enabled
  transition.

- **`undo()` / `reset()`**: State navigation via full snapshot stack
  (custom cloning preserves inboxes and `Set`-backed bookkeeping).

Key design decisions:

- **Stateless threshold checking.** Instead of maintaining incremental vote
  tallies, threshold helpers scan the evaluating node's visible inbox each
  time. User-struck entries are filtered out before guard evaluation. With 4
  nodes and a single height, each inbox stays small. This simplifies undo
  (restoring a snapshot automatically fixes all threshold computations).
- **"For the first time" tracking.** Rules L34, L36, and L47 must fire only once
  per round. Tracked via a `firedOnceRules: Set<string>` per node (e.g.,
  `"L34:r0"`), included in undo snapshots.
- **Inbox availability instead of delivery time.** Broadcast messages are
  copied into every node inbox immediately. Before GST, per-recipient strike
  state removes selected messages from guard evaluation; this models
  availability choices without queues or timestamps.
- **Global post-GST priority.** `gstDeclared` changes only scheduling and message
  availability, not the consensus state machine. Non-timeout protocol actions
  keep their normal nondeterministic ordering, but collectively take priority
  over every timeout.

### renderer.js

Renders the SVG Lamport diagram:

- Computes layout positions from timeline entries (each entry has a global step
  index for x-positioning).
- Draws initial state boxes, then iterates timeline entries to draw subsequent
  boxes, within-node transition arrows, and cross-node message arrows.
- Message arrows are vertical lines from sender to receiver row, with labels
  showing full message parameters. Deliveries marked not received are greyed
  with a red X, whether caused by a proposal timeout or a user strike.
- Hourglass emoji on transitions that schedule timeouts.
- Draws the GST boundary and shades the post-GST timeline.
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
- Wires the phase indicator and Declare GST control.
- Loads predefined traces from `traces/index.json` and replays engine-step
  strings plus tagged GST and sideband entries.
- Save trace downloads the current execution as a JSON file.

### Data Flow

```
UI action
  -> transition click: engine.executeTransition()
  -> Random: engine.stepAll() executes currently enabled transitions
  -> Declare GST: engine.declareGST() reveals messages and appends a GST event
  -> transition execution snapshots state, calls consensus.applyConsensusInput(),
     processes outputs, and appends a timeline entry
  -> ui.js calls refreshAll()
    -> renderer rebuilds SVG from timeline entries
    -> left pane: recompute enabled transitions per node
    -> state pane: update current state boxes
    -> pseudocode: highlight enabled rules, bold executed lines
```

## Predefined Traces

Clickable traces below the legend load prerecorded executions instantly.
Traces are stored as JSON files in the `traces/` directory.

Trace `steps` are transition-ID strings, `{ "kind": "gst" }` global events, or
tagged `strike`/`unstrike` sideband objects. Unstrikes generated internally by
declaring GST are not serialized separately: replaying the GST event recreates
them.

| Trace | Description |
|-------|-------------|
| **Happy path** | All 4 nodes decide value A in round 0. The simplest successful execution. |
| **Timeout and prevote nil** | p1 times out waiting for the proposal, prevotes nil, but still locks and decides A when the polka arrives. Shows how late messages are still processed. |
| **Cross-round decision** | p0-p2 decide in round 0. p3 times out through all phases, moves to round 1, then decides A using round 0's proposal and precommits (L49-54 checks any round). |
| **Locking behavior** | All nodes lock on A (L36-43) but timeout before deciding. They move to round 1 with `lockedValue=A` and `validValue=A`. The round 1 proposer re-proposes A. |
| **Round skip (L55)** | p2 and p3 skip to round 1 after seeing f+1 round-1 messages. |
| **Reached round 1** | All nodes timeout through prevote and precommit in round 0, moving to round 1. |
| **User strike and proposal ack** | Demonstrates user-hidden messages, late proposal acknowledgement, and same-anchor strike cancellation. |
| **GST recovery after missed proposal** | p1 hides and times out on a proposal before GST while protocol progress is available; GST reveals it and post-GST protocol actions lead all nodes to decide A. |

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
- The GST scheduler is a pedagogical abstraction of “after GST with
  sufficiently large timeouts,” stronger than DLS partial synchrony. There is
  no logical clock, explicit GST time, Δ bound, or timed delivery queue.
- Message loss and delay are per-recipient availability annotations, not a
  model of transport, retransmission, or elapsed time.
- No real-time animation (transitions are discrete, user-driven steps).
- Values are abstract labels (A, B, C), not actual block data.
