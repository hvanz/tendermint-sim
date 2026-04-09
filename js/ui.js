// ui.js -- Left pane (transitions), middle pane (current state), event wiring

import { NUM_NODES } from "./types.js";
import {
    getState, reset, undo, canUndo,
    computeEnabledTransitions, executeTransition, stepAll, proposer,
} from "./engine.js";
import { render } from "./renderer.js";

// Classify a transition for color-coding the left border
function actionClass(transition) {
    const sl = transition.shortLabel;
    if (sl.startsWith("DECIDE")) return "action-decide";
    if (sl.startsWith("StartRound")) return "action-proposal";
    if (sl.includes("PRECOMMIT")) return "action-precommit";
    if (sl.includes("PREVOTE")) return "action-prevote";
    if (sl.startsWith("timeout")) return "action-timeout";
    if (sl.startsWith("skip")) return "action-skip";
    if (sl.startsWith("schedule")) return "action-schedule";
    if (sl.includes("valid=")) return "action-schedule";
    return "";
}

function formatValue(v) {
    return v === null ? "nil" : v;
}

function stepClass(node) {
    if (node.decision !== null) return "step-decided";
    if (node.round < 0) return "step-initial";
    return `step-${node.step}`;
}

// Build the left pane with per-node sections (transitions only)
function buildLeftPane() {
    const pane = document.getElementById("left-pane");
    // Keep the column header, remove everything else
    const header = pane.querySelector(".column-header");
    pane.innerHTML = "";
    if (header) pane.appendChild(header);

    for (let i = 0; i < NUM_NODES; i++) {
        const section = document.createElement("div");
        section.className = "node-section";
        section.dataset.node = i;

        const header = document.createElement("div");
        header.className = "node-section-header";
        const name = document.createElement("span");
        name.className = "node-name";
        name.dataset.node = i;
        header.appendChild(name);
        section.appendChild(header);

        const list = document.createElement("div");
        list.className = "transition-list";
        list.dataset.node = i;
        section.appendChild(list);

        pane.appendChild(section);
    }
}

// Build the state pane with per-node state boxes
function buildStatePane() {
    const pane = document.getElementById("state-pane");
    const header = pane.querySelector(".column-header");
    pane.innerHTML = "";
    if (header) pane.appendChild(header);

    for (let i = 0; i < NUM_NODES; i++) {
        const section = document.createElement("div");
        section.className = "state-box-section";

        const box = document.createElement("div");
        box.className = "current-state-box";
        box.dataset.node = i;
        section.appendChild(box);

        pane.appendChild(section);
    }
}

// Refresh left pane (transitions)
function refreshLeftPane() {
    const state = getState();

    for (let i = 0; i < NUM_NODES; i++) {
        const node = state.nodes[i];
        const currentRound = node.round >= 0 ? node.round : 0;
        const isP = proposer(0, currentRound) === i;

        const nameEl = document.querySelector(`.node-name[data-node="${i}"]`);
        if (nameEl) {
            nameEl.textContent = `p${i}${isP ? " (proposer)" : ""}`;
            nameEl.classList.toggle("is-proposer", isP);
        }

        const listEl = document.querySelector(`.transition-list[data-node="${i}"]`);
        if (!listEl) continue;
        listEl.innerHTML = "";

        if (node.decision !== null) {
            const decided = document.createElement("div");
            decided.className = "node-section-decided";
            decided.textContent = "decided";
            listEl.appendChild(decided);
            continue;
        }

        const transitions = computeEnabledTransitions(i);

        if (transitions.length === 0) {
            const empty = document.createElement("div");
            empty.className = "node-section-empty";
            empty.textContent = "no step enabled";
            listEl.appendChild(empty);
            continue;
        }

        for (const t of transitions) {
            const item = document.createElement("div");
            item.className = `transition-item ${actionClass(t)}`;
            item.textContent = t.shortLabel;
            item.title = `[${t.ruleRef}] ${t.label}`;
            item.addEventListener("click", () => {
                executeTransition(i, t.id);
                refreshAll();
            });
            listEl.appendChild(item);
        }
    }
}

// Refresh state pane (current state boxes)
function refreshStatePane() {
    const state = getState();

    for (let i = 0; i < NUM_NODES; i++) {
        const node = state.nodes[i];
        const box = document.querySelector(`.current-state-box[data-node="${i}"]`);
        if (!box) continue;

        // Reset classes
        box.className = `current-state-box ${stepClass(node)}`;

        if (node.round < 0) {
            box.innerHTML = `round: -<br>`
                + `step: -<br>`
                + `locked: nil/-1<br>`
                + `valid: nil/-1<br>`
                + `decision: nil`;
        } else {
            const stepLabel = node.decision !== null ? "DECIDED" : node.step.toUpperCase();
            box.innerHTML = `round: ${node.round}<br>`
                + `step: ${stepLabel}<br>`
                + `locked: ${formatValue(node.lockedValue)}/${node.lockedRound}<br>`
                + `valid: ${formatValue(node.validValue)}/${node.validRound}<br>`
                + `decision: ${formatValue(node.decision)}`;
        }
    }
}

function refreshUndoButton() {
    document.getElementById("btn-undo").disabled = !canUndo();
}

function refreshAll() {
    render(getState());
    refreshLeftPane();
    refreshStatePane();
    refreshUndoButton();
}

export function initUI() {
    buildLeftPane();
    buildStatePane();

    document.getElementById("btn-reset").addEventListener("click", () => {
        reset();
        refreshAll();
    });

    document.getElementById("btn-undo").addEventListener("click", () => {
        undo();
        refreshAll();
    });

    document.getElementById("btn-step-all").addEventListener("click", () => {
        stepAll();
        refreshAll();
    });

    refreshAll();
}
