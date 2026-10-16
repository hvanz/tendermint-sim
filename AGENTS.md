# Agent instructions

This repository is a browser simulator of Tendermint consensus (Algorithm 1 of the paper). It has 4 nodes (n = 3f+1, f = 1) and a single height. It uses vanilla JavaScript, HTML, CSS, and SVG. It has no framework and no package.json.

`README.md` describes the execution model, the architecture, and the trace format. Read it before you change the engine.

## Layout

- `js/types.js`: shared constants and types.
- `js/consensus.js`: the pure state machine of one node. It has no DOM access.
- `js/engine.js`: the system state, enabled transitions, delivery strikes, GST, the Byzantine node, undo, and the timeline.
- `js/renderer.js`: the SVG timeline.
- `js/state-box.js`: the HTML Current State boxes and the inbox.
- `js/ui.js`: the controls, the composer, the pseudocode panel, and trace load and save.
- `js/main.js`: the entry point.
- `traces/*.json`: predefined traces. `traces/index.json` lists them.
- `docs/tendermint-paper.pdf`, `docs/pseudo-code.md`: the reference algorithm. Rule names such as L22 and L36 are line numbers of Algorithm 1.
- `dist/tendermint-sim.html`: the single-file build. Git tracks this file.
- `TODO.md`, `NOTES.md`, `PLAN-*.md`: local notes of the user. Git ignores them. Do not commit them.

## Commands

- Start the development server: `python3 -m http.server 8080`, then open `http://localhost:8080`.
- Build the single file: `python3 build.py`. The build needs `npx` for esbuild.
- Run the tests:
  ```bash
  node tests/gst-mode.mjs
  node tests/byzantine-mode.mjs
  ```
- Get the paper as text: `pdftotext docs/tendermint-paper.pdf -`.

## Protocol semantics

- Follow the paper when it differs from CometBFT or Malachite. Tell the user about the implementation alternative, but do not implement it.
- Before you state a protocol property, read the paper text. An earlier claim about gossip after GST was wrong because the paper was not checked.
- Thresholds count distinct senders, once for each value (paper, Section II). A node that equivocates counts toward each value.
- After GST, gossip forwards each message that a correct node received to all correct nodes (paper, Section II).
- Each node has its own round. A label that depends on the round, such as "proposer", uses the round of that node.
- Keep `js/consensus.js` pure, and keep the paper conditions in it as they are. Put scheduling and network behavior in `js/engine.js`.

## Engine and UI rules

- Write each user action as an undoable timeline entry. A saved trace must replay to the same state.
- Add new node state and new system state to `cloneState` in `js/engine.js`. If you do not, undo does not restore it.
- Strikes and the sideband log are outside the cloned state. They stay after an ordinary undo.
- Make the trace loader call the same engine functions as the UI click. A different path makes a saved trace replay to a different state.
- Call `refreshAll()` after each state change. It clears the memo of `computeEnabledTransitions`.
- Trace steps are transition ids, such as `n1:L22:r0:A`, or tagged objects: `{kind:"gst"}`, `{kind:"byzantine",nodeId}`, and `{kind:"send",nodeId,message,recipients}`. Add each new trace to `traces/index.json`.
- Make the Current State boxes and the timeline boxes the same in style and dimensions. Change `js/state-box.js` and `drawStateBox` in `js/renderer.js` together.
- Keep colors and layout constants in `:root` of `css/style.css`. `js/renderer.js` reads the layout constants with `getComputedStyle`. The arrowhead colors in `js/renderer.js` are copies of the `--accent-*` tokens, so change both.
- Give each color one meaning. Violet is for the Byzantine node only.
- Keep the UI minimal. Use an emoji instead of a text tag or a badge. Do not add status labels that the user did not ask for.
- Do not use `prompt()` or `alert()`. Use a `<dialog>`.
- If a simplification has a known limit, write a comment at the code, as at `msgKey` in `js/engine.js`. Add the limit to the Limitations section of `README.md`.

## Checks before a commit

- Run both tests.
- Make sure that a new test fails without your change.
- If you change `js/engine.js` or `js/consensus.js`, replay all traces on `HEAD` and on your change. Compare the final states. Only the differences that you expect are allowed.
- For a visual change, make a screenshot of `dist/tendermint-sim.html` with headless Chrome. Load a trace with a script that sets `#trace-select` and sends a `change` event.
- Run `python3 build.py`. Commit `dist/tendermint-sim.html` together with the source change.
- If behavior changes, update `README.md` and the About and Legend dialogs in `index.html`.

## Commits

- Commit on `main`.
- Use Conventional Commits: `feat: subject`, `fix: subject`. Do not use `NoStory` as a scope.
- In the body, first tell why the change is necessary. Then add one bullet for each area, for example `engine:`, `ui:`, `traces:`, `tests:`, `docs:`, and `dist:`.
- Ask the user before you amend, rebase, or reset. Never push. Give the user the push command.
- When you rewrite history, rebuild `dist/` in each commit, for example with `git rebase --exec 'python3 build.py && git commit -a --amend --no-edit'`.

## Prose

- Write `README.md`, the UI text, and commit messages in ASD-STE100 Simplified Technical English.
- In titles, capitalize only the first word.
