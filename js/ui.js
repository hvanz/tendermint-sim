// ui.js -- DOM controls: dropdowns, buttons, event wiring

import { NUM_NODES } from "./types.js";
import {
    getState, reset, undo, canUndo,
    computeEnabledTransitions, executeTransition, stepAll, proposer,
} from "./engine.js";
import { render } from "./renderer.js";

// Build per-node control rows
function buildNodeControls() {
    const container = document.getElementById("node-controls");
    container.innerHTML = "";

    for (let i = 0; i < NUM_NODES; i++) {
        const row = document.createElement("div");
        row.className = "node-row-control";
        row.dataset.node = i;

        const label = document.createElement("span");
        label.className = "node-label";
        label.textContent = `p${i}`;

        const select = document.createElement("select");
        select.className = "transition-select";
        select.dataset.node = i;

        const fireBtn = document.createElement("button");
        fireBtn.className = "btn-fire";
        fireBtn.textContent = "Fire";
        fireBtn.dataset.node = i;
        fireBtn.addEventListener("click", () => {
            const transitionId = select.value;
            if (!transitionId) return;
            executeTransition(i, transitionId);
            refreshAll();
        });

        row.appendChild(label);
        row.appendChild(select);
        row.appendChild(fireBtn);
        container.appendChild(row);
    }
}

// Refresh dropdowns with current enabled transitions
function refreshDropdowns() {
    const state = getState();

    for (let i = 0; i < NUM_NODES; i++) {
        const row = document.querySelector(`.node-row-control[data-node="${i}"]`);
        if (!row) continue;

        const select = row.querySelector(".transition-select");
        const fireBtn = row.querySelector(".btn-fire");
        const label = row.querySelector(".node-label");

        // Update proposer indicator
        const node = state.nodes[i];
        const currentRound = node.round >= 0 ? node.round : 0;
        const isP = proposer(0, currentRound) === i;
        label.textContent = `p${i}${isP ? " *" : ""}`;
        label.classList.toggle("is-proposer", isP);

        const transitions = computeEnabledTransitions(i);

        select.innerHTML = "";

        if (transitions.length === 0) {
            const opt = document.createElement("option");
            opt.value = "";
            opt.textContent = node.decision !== null
                ? "-- decided --"
                : "-- no enabled transitions --";
            select.appendChild(opt);
            select.disabled = true;
            fireBtn.disabled = true;
        } else {
            const placeholder = document.createElement("option");
            placeholder.value = "";
            placeholder.textContent = `-- ${transitions.length} transition(s) --`;
            select.appendChild(placeholder);

            for (const t of transitions) {
                const opt = document.createElement("option");
                opt.value = t.id;
                opt.textContent = `[${t.ruleRef}] ${t.label}`;
                select.appendChild(opt);
            }
            select.disabled = false;
            fireBtn.disabled = false;
        }
    }
}

function refreshUndoButton() {
    document.getElementById("btn-undo").disabled = !canUndo();
}

function refreshAll() {
    render(getState());
    refreshDropdowns();
    refreshUndoButton();
}

// Wire up controls
export function initUI() {
    buildNodeControls();

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
