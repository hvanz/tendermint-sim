// renderer.js -- SVG rendering: timeline rows, state boxes, transition arrows, message arrows

import { NUM_NODES, MessageType } from "./types.js";
import { proposer } from "./engine.js";

const SVG_NS = "http://www.w3.org/2000/svg";

// Layout constants
const ROW_HEIGHT = 140;
const ROW_Y_OFFSET = 40;        // top margin for node labels
const LABEL_WIDTH = 70;          // width reserved for node labels on left
const BOX_WIDTH = 130;
const BOX_HEIGHT = 110;
const BOX_GAP = 80;             // horizontal gap between boxes (includes arrow space)
const BOX_PADDING = 6;
const INITIAL_X = LABEL_WIDTH + 20;

function boxX(stepIndex) {
    return INITIAL_X + stepIndex * (BOX_WIDTH + BOX_GAP);
}

function rowY(nodeId) {
    return ROW_Y_OFFSET + nodeId * ROW_HEIGHT;
}

function boxCenterY(nodeId) {
    return rowY(nodeId) + BOX_HEIGHT / 2;
}

function formatValue(v) {
    return v === null ? "nil" : v;
}

function stepClass(snapshot) {
    if (snapshot === null) return "step-initial";
    if (snapshot.decision !== null) return "step-decided";
    return `step-${snapshot.step}`;
}

// Create an SVG element with attributes
function svgEl(tag, attrs = {}) {
    const el = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs)) {
        el.setAttribute(k, v);
    }
    return el;
}

// Draw a state box at position (x, y)
function drawStateBox(parent, x, y, snapshot, nodeId, isInitial = false) {
    const g = svgEl("g", { class: `state-box ${isInitial ? "step-initial" : stepClass(snapshot)}` });

    // Background rect
    g.appendChild(svgEl("rect", {
        x, y, width: BOX_WIDTH, height: BOX_HEIGHT, rx: 6, ry: 6,
    }));

    const textX = x + BOX_PADDING;
    let textY = y + 15;
    const lineHeight = 14;

    if (isInitial) {
        addText(g, textX, textY, `p${nodeId}`, "step-label");
        textY += lineHeight;
        addText(g, textX, textY, `round: -`);
        textY += lineHeight;
        addText(g, textX, textY, `step: -`);
        textY += lineHeight;
        addText(g, textX, textY, `locked: nil/-1`);
        textY += lineHeight;
        addText(g, textX, textY, `valid: nil/-1`);
        textY += lineHeight;
        addText(g, textX, textY, `decision: nil`);
    } else {
        const s = snapshot;
        const stepLabel = s.decision !== null ? "DECIDED" : s.step.toUpperCase();
        addText(g, textX, textY, `p${nodeId}  R${s.round}`, "step-label");
        textY += lineHeight;
        addText(g, textX, textY, `step: ${stepLabel}`);
        textY += lineHeight;
        addText(g, textX, textY, `locked: ${formatValue(s.lockedValue)}/${s.lockedRound}`);
        textY += lineHeight;
        addText(g, textX, textY, `valid: ${formatValue(s.validValue)}/${s.validRound}`);
        textY += lineHeight;
        addText(g, textX, textY, `decision: ${formatValue(s.decision)}`);
    }

    parent.appendChild(g);
    return { x, y, width: BOX_WIDTH, height: BOX_HEIGHT };
}

function addText(parent, x, y, text, className = "") {
    const t = svgEl("text", { x, y, class: className });
    t.textContent = text;
    parent.appendChild(t);
}

// Draw a horizontal arrow between two boxes on the same row
function drawTransitionArrow(parent, fromX, toX, y, label) {
    const g = svgEl("g", { class: "transition-arrow" });
    const midY = y + BOX_HEIGHT / 2;
    const startX = fromX + BOX_WIDTH;
    const endX = toX;

    // Arrow line
    g.appendChild(svgEl("line", {
        x1: startX, y1: midY, x2: endX - 6, y2: midY,
        "marker-end": "url(#arrowhead-gray)",
    }));

    // Label above arrow
    const labelX = (startX + endX) / 2;
    const labelEl = svgEl("text", { x: labelX, y: midY - 8, "text-anchor": "middle" });
    labelEl.textContent = label;
    g.appendChild(labelEl);

    parent.appendChild(g);
}

// Draw a cross-node message arrow (curved)
function drawMessageArrow(parent, fromBox, senderNodeId, toNodeId, message, nodeBoxPositions) {
    const toBox = nodeBoxPositions[toNodeId];
    if (!toBox) return;

    const toBoxX = toBox.x;
    const toBoxY = toBox.y;

    // Start from right edge of sender box, end at left edge of receiver's current box
    const fromX = fromBox.x + BOX_WIDTH + 2;
    const toX = toBoxX - 2;

    // Offset the Y start/end slightly based on message type to avoid overlap
    const typeOffset = message.type === MessageType.PROPOSAL ? -10
        : message.type === MessageType.PREVOTE ? 0 : 10;

    const fromY = fromBox.y + BOX_HEIGHT / 2 + typeOffset;
    const toY = toBoxY + BOX_HEIGHT / 2 + typeOffset;

    const isNil = message.value === null;
    const typeClass = `type-${message.type}`;
    const nilClass = isNil ? "nil-vote" : "";

    const g = svgEl("g", { class: `message-arrow ${typeClass} ${nilClass}` });

    // Use a quadratic bezier that curves away from the midpoint
    // The control point is offset horizontally and pulled toward the midpoint vertically
    const midX = (fromX + toX) / 2;
    const midY = (fromY + toY) / 2;
    // Pull control point slightly toward the direction of the receiver
    const cpX = midX;
    const cpY = midY;
    const d = `M ${fromX} ${fromY} Q ${cpX} ${cpY}, ${toX} ${toY}`;

    g.appendChild(svgEl("path", {
        d,
        "marker-end": `url(#arrowhead-${message.type.toLowerCase()})`,
    }));

    parent.appendChild(g);
}

// --- Main render function ---

export function render(systemState) {
    const container = document.getElementById("timeline-container");
    container.innerHTML = "";

    const timeline = systemState.timeline;

    // Compute per-node step indices: each node's boxes are numbered independently
    // But we use globalStepIndex for x-positioning so boxes align chronologically
    const nodeStepCounts = new Array(NUM_NODES).fill(0);

    // Build a mapping: for each timeline entry, compute its x position
    // Global step indices start at 1. The initial state is at index 0.
    const entryPositions = [];
    for (const entry of timeline) {
        nodeStepCounts[entry.nodeId]++;
        entryPositions.push({
            ...entry,
            xIndex: entry.globalStepIndex,
        });
    }

    // Compute SVG dimensions
    const maxStepIndex = timeline.length > 0
        ? Math.max(...timeline.map(e => e.globalStepIndex))
        : 0;
    const svgWidth = Math.max(800, boxX(maxStepIndex + 1) + BOX_WIDTH + 40);
    const svgHeight = ROW_Y_OFFSET + NUM_NODES * ROW_HEIGHT + 20;

    const svg = svgEl("svg", { width: svgWidth, height: svgHeight });

    // Arrowhead markers
    const defs = svgEl("defs");
    for (const [name, color] of [
        ["arrowhead-gray", "#aaa"],
        ["arrowhead-proposal", "#3b82f6"],
        ["arrowhead-prevote", "#22c55e"],
        ["arrowhead-precommit", "#f97316"],
    ]) {
        const marker = svgEl("marker", {
            id: name, viewBox: "0 0 10 7", refX: 10, refY: 3.5,
            markerWidth: 8, markerHeight: 6, orient: "auto-start-reverse",
        });
        marker.appendChild(svgEl("polygon", { points: "0 0, 10 3.5, 0 7", fill: color }));
        defs.appendChild(marker);
    }
    svg.appendChild(defs);

    // Row guide lines
    const gridGroup = svgEl("g", { class: "grid" });
    for (let i = 0; i < NUM_NODES; i++) {
        const y = rowY(i) + BOX_HEIGHT / 2;
        gridGroup.appendChild(svgEl("line", {
            x1: 0, y1: y, x2: svgWidth, y2: y, class: "row-guide",
        }));
    }
    svg.appendChild(gridGroup);

    // Node labels
    const labelGroup = svgEl("g");
    for (let i = 0; i < NUM_NODES; i++) {
        const y = rowY(i) + BOX_HEIGHT / 2 + 5;
        const isP = proposer(0, systemState.nodes[i].round >= 0 ? systemState.nodes[i].round : 0) === i;
        const t = svgEl("text", {
            x: 10, y, class: `node-row-label ${isP ? "is-proposer" : ""}`,
            "font-family": "monospace", "font-size": "13", "font-weight": "600",
            fill: isP ? "#7c3aed" : "#555",
        });
        t.textContent = `p${i}${isP ? " *" : ""}`;
        labelGroup.appendChild(t);
    }
    svg.appendChild(labelGroup);

    // Draw initial state boxes
    const stateBoxes = svgEl("g", { id: "state-boxes" });
    const latestBoxPerNode = {};
    for (let i = 0; i < NUM_NODES; i++) {
        const x = INITIAL_X;
        const y = rowY(i);
        const box = drawStateBox(stateBoxes, x, y, null, i, true);
        latestBoxPerNode[i] = { x, y: y, stepIndex: 0 };
    }

    // Draw timeline entries
    const transitionArrows = svgEl("g", { id: "transition-arrows" });
    const messageArrows = svgEl("g", { id: "message-arrows" });

    // Track box positions for message arrow targets
    // For each entry, record where that node's box is after this transition
    const boxPositionsAtStep = []; // indexed by timeline entry index

    for (let idx = 0; idx < entryPositions.length; idx++) {
        const entry = entryPositions[idx];
        const nodeId = entry.nodeId;
        const x = boxX(entry.xIndex);
        const y = rowY(nodeId);

        // Draw state box
        drawStateBox(stateBoxes, x, y, entry.stateSnapshot, nodeId);

        // Draw transition arrow from previous box to this box
        const prevBox = latestBoxPerNode[nodeId];
        drawTransitionArrow(transitionArrows, prevBox.x, x, y, entry.shortLabel);

        // Update latest box position for this node
        latestBoxPerNode[nodeId] = { x, y, stepIndex: entry.xIndex };

        // Draw message arrows
        for (const msg of entry.messagesProduced) {
            for (let targetNode = 0; targetNode < NUM_NODES; targetNode++) {
                if (targetNode === nodeId) continue; // don't draw arrow to self
                drawMessageArrow(
                    messageArrows,
                    { x, y },
                    nodeId,
                    targetNode,
                    msg,
                    latestBoxPerNode,
                );
            }
        }
    }

    // Message arrows behind everything, then transition arrows, then state boxes on top
    svg.appendChild(messageArrows);
    svg.appendChild(transitionArrows);
    svg.appendChild(stateBoxes);
    container.appendChild(svg);

    // Auto-scroll to the right
    container.scrollLeft = container.scrollWidth;
}
