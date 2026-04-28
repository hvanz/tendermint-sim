// ui.js -- Left pane (transitions), middle pane (current state), pseudocode panel, event wiring

import { NUM_NODES } from "./types.js";
import {
    getState, reset, undo, canUndo,
    computeEnabledTransitions, executeTransition, stepAll, proposer,
} from "./engine.js";
import { render } from "./renderer.js";
import { renderStateBoxContent, stepClass as stepClassFromSnapshot } from "./state-box.js";

// Per-node selected round for the Current State inbox filter.
// null => auto-follow latest round (the default).
// Cleared inside refreshAll so every state-change snaps back to latest.
const selectedRoundByNode = new Array(NUM_NODES).fill(null);

// --- Pseudocode lines (Algorithm 1, lines 10-67) ---

const PSEUDOCODE = [
    { num: 11, text: "Function StartRound(round):" },
    { num: 12, text: "   round_p \u2190 round" },
    { num: 13, text: "   step_p \u2190 propose" },
    { num: 14, text: "   if proposer(h_p, round_p) = p then" },
    { num: 15, text: "      if validValue_p != nil then" },
    { num: 16, text: "         proposal \u2190 validValue_p" },
    { num: 17, text: "      else" },
    { num: 18, text: "         proposal \u2190 getValue()" },
    { num: 19, text: "      broadcast \u27e8PROPOSAL, h_p, round_p, proposal, validRound_p\u27e9" },
    { num: 20, text: "   else" },
    { num: 21, text: "      schedule OnTimeoutPropose(h_p, round_p)" },
    { num: 0,  text: "" },
    { num: 22, text: "upon \u27e8PROPOSAL, h_p, round_p, v, \u22121\u27e9 from proposer(h_p, round_p)" },
    { num: 0,  text: "   while step_p = propose do", parent: 22 },
    { num: 23, text: "   if valid(v) \u2227 (lockedRound_p = \u22121 \u2228 lockedValue_p = v) then" },
    { num: 24, text: "      broadcast \u27e8PREVOTE, h_p, round_p, id(v)\u27e9" },
    { num: 25, text: "   else" },
    { num: 26, text: "      broadcast \u27e8PREVOTE, h_p, round_p, nil\u27e9" },
    { num: 27, text: "   step_p \u2190 prevote" },
    { num: 0,  text: "" },
    { num: 28, text: "upon \u27e8PROPOSAL, h_p, round_p, v, vr\u27e9 from proposer AND" },
    { num: 0,  text: "   2f+1 \u27e8PREVOTE, h_p, vr, id(v)\u27e9", parent: 28 },
    { num: 0,  text: "   while step_p = propose \u2227 (vr \u2265 0 \u2227 vr < round_p) do", parent: 28 },
    { num: 29, text: "   if valid(v) \u2227 (lockedRound_p \u2264 vr \u2228 lockedValue_p = v) then" },
    { num: 30, text: "      broadcast \u27e8PREVOTE, h_p, round_p, id(v)\u27e9" },
    { num: 31, text: "   else" },
    { num: 32, text: "      broadcast \u27e8PREVOTE, h_p, round_p, nil\u27e9" },
    { num: 33, text: "   step_p \u2190 prevote" },
    { num: 0,  text: "" },
    { num: 34, text: "upon 2f+1 \u27e8PREVOTE, h_p, round_p, *\u27e9" },
    { num: 0,  text: "   while step_p = prevote for the first time do", parent: 34 },
    { num: 35, text: "   schedule OnTimeoutPrevote(h_p, round_p)" },
    { num: 0,  text: "" },
    { num: 36, text: "upon \u27e8PROPOSAL, h_p, round_p, v, *\u27e9 from proposer AND" },
    { num: 0,  text: "   2f+1 \u27e8PREVOTE, h_p, round_p, id(v)\u27e9", parent: 36 },
    { num: 0,  text: "   while valid(v) \u2227 step_p \u2265 prevote for the first time do", parent: 36 },
    { num: 37, text: "   if step_p = prevote then" },
    { num: 38, text: "      lockedValue_p \u2190 v" },
    { num: 39, text: "      lockedRound_p \u2190 round_p" },
    { num: 40, text: "      broadcast \u27e8PRECOMMIT, h_p, round_p, id(v)\u27e9" },
    { num: 41, text: "      step_p \u2190 precommit" },
    { num: 42, text: "   validValue_p \u2190 v" },
    { num: 43, text: "   validRound_p \u2190 round_p" },
    { num: 0,  text: "" },
    { num: 44, text: "upon 2f+1 \u27e8PREVOTE, h_p, round_p, nil\u27e9 while step_p = prevote do" },
    { num: 45, text: "   broadcast \u27e8PRECOMMIT, h_p, round_p, nil\u27e9" },
    { num: 46, text: "   step_p \u2190 precommit" },
    { num: 0,  text: "" },
    { num: 47, text: "upon 2f+1 \u27e8PRECOMMIT, h_p, round_p, *\u27e9 for the first time do" },
    { num: 48, text: "   schedule OnTimeoutPrecommit(h_p, round_p)" },
    { num: 0,  text: "" },
    { num: 49, text: "upon \u27e8PROPOSAL, h_p, r, v, *\u27e9 from proposer(h_p, r) AND" },
    { num: 0,  text: "   2f+1 \u27e8PRECOMMIT, h_p, r, id(v)\u27e9 while decision_p[h_p] = nil do", parent: 49 },
    { num: 50, text: "   if valid(v) then" },
    { num: 51, text: "      decision_p[h_p] = v" },
    { num: 52, text: "      h_p \u2190 h_p + 1" },
    { num: 53, text: "      reset lockedRound_p, lockedValue_p, validRound_p, validValue_p" },
    { num: 54, text: "      StartRound(0)" },
    { num: 0,  text: "" },
    { num: 55, text: "upon f+1 \u27e8*, h_p, round, *\u27e9 with round > round_p do" },
    { num: 56, text: "   StartRound(round)" },
    { num: 0,  text: "" },
    { num: 57, text: "Function OnTimeoutPropose(height, round):" },
    { num: 58, text: "   if height = h_p \u2227 round = round_p \u2227 step_p = propose then" },
    { num: 59, text: "      broadcast \u27e8PREVOTE, h_p, round_p, nil\u27e9" },
    { num: 60, text: "      step_p \u2190 prevote" },
    { num: 0,  text: "" },
    { num: 61, text: "Function OnTimeoutPrevote(height, round):" },
    { num: 62, text: "   if height = h_p \u2227 round = round_p \u2227 step_p = prevote then" },
    { num: 63, text: "      broadcast \u27e8PRECOMMIT, h_p, round_p, nil\u27e9" },
    { num: 64, text: "      step_p \u2190 precommit" },
    { num: 0,  text: "" },
    { num: 65, text: "Function OnTimeoutPrecommit(height, round):" },
    { num: 66, text: "   if height = h_p \u2227 round = round_p then" },
    { num: 67, text: "      StartRound(round_p + 1)" },
];

// Parse "L22-27" -> { start: 22, end: 27 }
function parseRuleRef(ruleRef) {
    const m = ruleRef.match(/L(\d+)-(\d+)/);
    if (!m) return null;
    return { start: parseInt(m[1]), end: parseInt(m[2]) };
}

// --- UI helpers ---

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

// Build a render snapshot from a live node. Always returns a snapshot object; a pre-started
// node (round < 0) is signaled by round: -1 so the renderer shows initial-state placeholders
// but still renders any inbox messages already received. The node's own broadcasts are
// included in availableMessages alongside peer messages. Proposals for rounds where the
// node fired OnTimeoutPropose are decorated with isReceived: false for strike-through.
function nodeToSnapshot(node) {
    // Look-ahead: if an enabled transition would late-receive a proposal, consider
    // that proposal already received for display (matches the timeline's "state that
    // triggers the step" un-strike). Rule refs: "L36-43" uses (h, node.round);
    // "L49-54" uses the proposal's round, parsed from the transition id.
    const pendingLate = new Set();
    if (node.round >= 0) {
        for (const t of computeEnabledTransitions(node.id)) {
            if (t.ruleRef === "L36-43") {
                const key = `${node.height}:${node.round}`;
                if (node.timedOutRounds.has(key)) pendingLate.add(key);
            } else if (t.ruleRef === "L49-54") {
                const m = t.id.match(/:L49:r(\d+):/);
                if (m) {
                    const key = `${node.height}:${parseInt(m[1])}`;
                    if (node.timedOutRounds.has(key)) pendingLate.add(key);
                }
            }
        }
    }
    const availableMessages = node.inbox.map(m => {
        if (m.type !== "PROPOSAL") return m;
        const key = `${m.height}:${m.round}`;
        const acknowledged = node.lateReceivedProposals.has(key) || pendingLate.has(key);
        const struck = node.timedOutRounds.has(key) && !acknowledged;
        return struck ? { ...m, isReceived: false } : m;
    });
    return {
        round: node.round,
        step: node.step,
        lockedValue: node.lockedValue,
        lockedRound: node.lockedRound,
        validValue: node.validValue,
        validRound: node.validRound,
        decision: node.decision,
        availableMessages,
    };
}

// --- Pseudocode panel state ---

let selectedPseudocodeNode = 0;
// Map from pseudocode line number to transition ID (for click handling)
let lineToTransition = {};

// Syntax-color pseudocode text (single-pass to avoid regex conflicts)
function colorizePseudocode(text) {
    const tokens = {
        // Message types
        "PROPOSAL": "pc-msg-proposal",
        "PRECOMMIT": "pc-msg-precommit",
        "PREVOTE": "pc-msg-prevote",
    };
    const keywords = new Set([
        "upon", "if", "then", "else", "while", "do", "Function",
        "broadcast", "schedule", "reset",
    ]);
    const variables = new Set([
        "step_p", "round_p", "lockedValue_p", "lockedRound_p",
        "validValue_p", "validRound_p", "decision_p", "h_p", "proposal",
    ]);
    const constants = new Set(["nil", "propose", "prevote", "precommit"]);

    // Match word-like tokens (including underscored identifiers)
    return text.replace(/[A-Za-z_][A-Za-z0-9_]*/g, (word) => {
        if (tokens[word]) return `<span class="${tokens[word]}">${word}</span>`;
        if (keywords.has(word)) return `<span class="pc-keyword">${word}</span>`;
        if (variables.has(word)) return `<span class="pc-var">${word}</span>`;
        if (constants.has(word)) return `<span class="pc-const">${word}</span>`;
        return word;
    });
}

function buildPseudocodeLines() {
    const container = document.getElementById("pseudocode-lines");
    container.innerHTML = "";
    for (const entry of PSEUDOCODE) {
        const div = document.createElement("div");
        if (entry.num === 0 && entry.text === "") {
            div.className = "pc-line pc-blank";
        } else {
            div.className = "pc-line";
            if (entry.num > 0) {
                div.dataset.line = entry.num;
            } else if (entry.parent) {
                div.dataset.line = entry.parent;
            }
            const numSpan = document.createElement("span");
            numSpan.className = "pc-line-number";
            numSpan.textContent = entry.num > 0 ? String(entry.num) : "";
            div.appendChild(numSpan);
            const codeSpan = document.createElement("span");
            codeSpan.innerHTML = colorizePseudocode(entry.text);
            div.appendChild(codeSpan);
        }
        container.appendChild(div);
    }
}

function refreshPseudocode() {
    // Clear all highlights, bold, and hover
    document.querySelectorAll(".pc-line").forEach(el => {
        el.classList.remove("highlighted", "executed", "hovered");
        el.style.cursor = "";
        el.onclick = null;
        el.onmouseenter = null;
        el.onmouseleave = null;
    });
    lineToTransition = {};

    const transitions = computeEnabledTransitions(selectedPseudocodeNode);

    for (const t of transitions) {
        const range = parseRuleRef(t.ruleRef);
        if (!range) continue;
        const execSet = new Set(t.executedLines || []);
        document.querySelectorAll(".pc-line[data-line]").forEach(el => {
            const lineNum = parseInt(el.dataset.line);
            const inRange = lineNum >= range.start && lineNum <= range.end;
            const isExec = execSet.has(lineNum);
            if (inRange || isExec) {
                el.classList.add("highlighted");
                if (isExec) {
                    el.classList.add("executed");
                }
                lineToTransition[lineNum] = { nodeId: selectedPseudocodeNode, transitionId: t.id };
                el.onclick = () => {
                    executeTransition(selectedPseudocodeNode, t.id);
                    refreshAll();
                };
                // Hover: highlight every line of the same rule, not just the one
                // the cursor is over (CSS :hover only affects the hovered element).
                el.onmouseenter = () => highlightPseudocodeLines(t.ruleRef, t.executedLines, true);
                el.onmouseleave = () => highlightPseudocodeLines(t.ruleRef, t.executedLines, false);
            }
        });
    }

    // Update tab active state
    document.querySelectorAll(".pc-tab").forEach(btn => {
        btn.classList.toggle("active", parseInt(btn.dataset.node) === selectedPseudocodeNode);
    });
}

function highlightPseudocodeLines(ruleRef, executedLines, add) {
    const range = parseRuleRef(ruleRef);
    if (!range) return;
    const execSet = new Set(executedLines || []);
    document.querySelectorAll(".pc-line[data-line]").forEach(el => {
        const lineNum = parseInt(el.dataset.line);
        const inRange = lineNum >= range.start && lineNum <= range.end;
        const isExec = execSet.has(lineNum);
        if (inRange || isExec) {
            el.classList.toggle("hovered", add);
        }
    });
}

// --- Build panes ---

function buildLeftPane() {
    const pane = document.getElementById("left-pane");
    const header = pane.querySelector(".column-header");
    pane.innerHTML = "";
    if (header) pane.appendChild(header);

    for (let i = 0; i < NUM_NODES; i++) {
        const section = document.createElement("div");
        section.className = "node-section";
        section.dataset.node = i;

        const hdr = document.createElement("div");
        hdr.className = "node-section-header";
        const name = document.createElement("span");
        name.className = "node-name";
        name.dataset.node = i;
        hdr.appendChild(name);
        section.appendChild(hdr);

        const list = document.createElement("div");
        list.className = "transition-list";
        list.dataset.node = i;
        section.appendChild(list);

        pane.appendChild(section);
    }
}

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

// --- Refresh functions ---

function refreshLeftPane() {
    const state = getState();

    for (let i = 0; i < NUM_NODES; i++) {
        const node = state.nodes[i];
        const currentRound = node.round >= 0 ? node.round : 0;
        const isP = proposer(0, currentRound) === i;

        const nameEl = document.querySelector(`.node-name[data-node="${i}"]`);
        if (nameEl) {
            nameEl.textContent = `p${i}${isP ? ` (proposer round ${currentRound})` : ""}`;
            nameEl.classList.toggle("is-proposer", isP);
        }

        const listEl = document.querySelector(`.transition-list[data-node="${i}"]`);
        if (!listEl) continue;
        listEl.innerHTML = "";

        if (node.decision !== null) {
            const decided = document.createElement("div");
            decided.className = "node-section-decided";
            decided.textContent = `decided ${node.decision}`;
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
            // Hover: switch pseudocode tab to this node and highlight the hovered rule
            item.addEventListener("mouseenter", () => {
                if (selectedPseudocodeNode !== i) {
                    selectedPseudocodeNode = i;
                    refreshPseudocode();
                }
                highlightPseudocodeLines(t.ruleRef, t.executedLines, true);
            });
            item.addEventListener("mouseleave", () => {
                highlightPseudocodeLines(t.ruleRef, t.executedLines, false);
            });
            listEl.appendChild(item);
        }
    }
}

function refreshStatePane() {
    const state = getState();

    for (let i = 0; i < NUM_NODES; i++) {
        const node = state.nodes[i];
        const box = document.querySelector(`.current-state-box[data-node="${i}"]`);
        if (!box) continue;

        const snapshot = nodeToSnapshot(node);
        box.className = `current-state-box ${stepClassFromSnapshot(snapshot)}`;
        box.innerHTML = renderStateBoxContent(snapshot, {
            selectedRound: selectedRoundByNode[i],
            nodeId: i,
        });
    }
}

function refreshUndoButton() {
    document.getElementById("btn-undo").disabled = !canUndo();
}

function refreshAll() {
    // Auto-follow: any state-change re-render snaps every node's filter back to latest.
    selectedRoundByNode.fill(null);
    render(getState());
    refreshLeftPane();
    refreshStatePane();
    refreshPseudocode();
    refreshUndoButton();
}

// --- Traces ---

async function loadTraceIndex() {
    try {
        const resp = await fetch("traces/index.json");
        const index = await resp.json();
        const container = document.getElementById("traces-list");
        container.innerHTML = "";
        for (let i = 0; i < index.length; i++) {
            const entry = index[i];
            if (i > 0) container.appendChild(document.createTextNode(" | "));
            const link = document.createElement("a");
            link.className = "trace-link";
            link.href = "#";
            link.textContent = entry.name;
            link.title = entry.description;
            link.addEventListener("click", (e) => { e.preventDefault(); loadTrace(entry.file); });
            container.appendChild(link);
        }
    } catch (e) {
        console.warn("Could not load traces/index.json:", e);
    }
}

async function loadTrace(file) {
    try {
        const resp = await fetch(`traces/${file}`);
        const trace = await resp.json();
        reset();
        for (const stepId of trace.steps) {
            // Find the node from the step ID (format: "nX:...")
            const nodeId = parseInt(stepId.match(/^n(\d+):/)[1]);
            executeTransition(nodeId, stepId);
        }
        refreshAll();
    } catch (e) {
        console.error("Failed to load trace:", e);
    }
}

function saveTrace() {
    const name = prompt("Trace name:");
    if (!name) return;
    const state = getState();
    const steps = state.timeline.map(e => e.transitionId);
    const filename = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/-+$/, "") + ".json";
    const trace = { name, description: "", steps };
    const json = JSON.stringify(trace, null, 2);
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
    alert(`Trace downloaded as "${filename}". To add it to predefined traces, move it to the traces/ directory, add an entry to traces/index.json, and reload this page.`);
}

export function initUI() {
    buildLeftPane();
    buildStatePane();
    buildPseudocodeLines();
    loadTraceIndex().catch(e => console.error("Trace index load failed:", e));

    // Pseudocode tab switching
    document.querySelectorAll(".pc-tab").forEach(btn => {
        btn.addEventListener("click", () => {
            selectedPseudocodeNode = parseInt(btn.dataset.node);
            refreshPseudocode();
        });
    });

    // Close pseudocode panel (X button)
    document.getElementById("btn-close-pseudocode").addEventListener("click", () => {
        document.getElementById("pseudocode-pane").classList.add("hidden");
        document.body.classList.remove("pseudocode-open");
        document.getElementById("btn-pseudocode").disabled = false;
    });

    // Reopen pseudocode panel
    document.getElementById("btn-pseudocode").addEventListener("click", () => {
        document.getElementById("pseudocode-pane").classList.remove("hidden");
        document.body.classList.add("pseudocode-open");
        document.getElementById("btn-pseudocode").disabled = true;
        refreshPseudocode();
    });

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

    document.getElementById("btn-save-trace").addEventListener("click", saveTrace);

    // Click delegation for inbox-header round-filter links in the state pane.
    // One listener survives all innerHTML replacements in refreshStatePane.
    document.getElementById("state-pane").addEventListener("click", (e) => {
        const link = e.target.closest(".round-link[data-node]");
        if (!link) return;
        const nodeId = parseInt(link.dataset.node, 10);
        const round = parseInt(link.dataset.round, 10);
        if (Number.isNaN(nodeId) || Number.isNaN(round)) return;
        selectedRoundByNode[nodeId] = round;
        refreshStatePane();
    });

    // Re-render on viewport resize so dynamic row height tracks the window.
    window.addEventListener("resize", () => refreshAll());

    refreshAll();
}
