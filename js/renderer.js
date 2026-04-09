// renderer.js -- SVG rendering: timeline rows, state boxes, transition arrows, message arrows

import { NUM_NODES, MessageType } from "./types.js";

const SVG_NS = "http://www.w3.org/2000/svg";

// Layout constants
const ROW_HEIGHT = 120;
const ROW_Y_OFFSET = 0;         // no offset; column header provides top spacing
const BOX_WIDTH = 112;
const BOX_HEIGHT = 84;
const BOX_GAP = 80;             // horizontal gap between boxes (includes arrow space)
const BOX_PADDING = 6;
const INITIAL_X = 20;           // no label width needed; labels are in left pane

function boxX(stepIndex) {
    return INITIAL_X + stepIndex * (BOX_WIDTH + BOX_GAP);
}

function rowY(nodeId) {
    return ROW_Y_OFFSET + nodeId * ROW_HEIGHT;
}

// Box Y position: centered within the row
function boxY(nodeId) {
    return rowY(nodeId) + (ROW_HEIGHT - BOX_HEIGHT) / 2;
}

function rowCenterY(nodeId) {
    return rowY(nodeId) + ROW_HEIGHT / 2;
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

// Draw a state box at position (x, y). globalStep is the step number (shown as #N in top-right).
function drawStateBox(parent, x, y, snapshot, nodeId, isInitial = false, globalStep = null) {
    const g = svgEl("g", { class: `state-box ${isInitial ? "step-initial" : stepClass(snapshot)}` });

    // Background rect
    g.appendChild(svgEl("rect", {
        x, y, width: BOX_WIDTH, height: BOX_HEIGHT, rx: 6, ry: 6,
    }));

    // Step number in top-right corner
    if (globalStep !== null) {
        const t = svgEl("text", {
            x: x + BOX_WIDTH - BOX_PADDING, y: y + 12,
            "text-anchor": "end", class: "step-number",
        });
        t.textContent = `#${globalStep}`;
        g.appendChild(t);
    }

    const textX = x + BOX_PADDING;
    let textY = y + 15;
    const lineHeight = 14;

    if (isInitial) {
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
        addText(g, textX, textY, `round: ${s.round}`);
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

// Format a full message label (all params except height)
function msgLabel(message) {
    const val = message.value === null ? "nil" : message.value;
    const r = message.round;
    switch (message.type) {
        case "PROPOSAL": return `PROPOSAL(r=${r}, ${val}, vr=${message.validRound})`;
        case "PREVOTE": return `PREVOTE(r=${r}, ${val})`;
        case "PRECOMMIT": return `PRECOMMIT(r=${r}, ${val})`;
        default: return message.type;
    }
}

// Draw a cross-node message arrow (vertical, targeting the receiver's row line)
// xOffset spaces apart multiple messages sent from the same transition
// drawLabel: if true, add the label to labelGroup (rendered on top of everything)
function drawMessageArrow(parent, labelGroup, fromBox, senderNodeId, toNodeId, message, xOffset, drawLabel) {
    // Arrow starts ~20px before the sender's state box, moves forward (rightward)
    const startX = fromBox.x - 20 - xOffset;
    const endX = startX + 14;

    // Y positions: center of each row
    const fromY = rowCenterY(senderNodeId);
    const toY = rowCenterY(toNodeId);

    const isNil = message.value === null;
    const typeClass = `type-${message.type}`;
    const nilClass = isNil ? "nil-vote" : "";

    const g = svgEl("g", { class: `message-arrow ${typeClass} ${nilClass}` });

    const d = `M ${startX} ${fromY} L ${endX} ${toY}`;

    g.appendChild(svgEl("path", {
        d,
        "marker-end": `url(#arrowhead-${message.type.toLowerCase()})`,
    }));

    // Place label in the gap above the sender (between sender and the row above).
    // For p0 (topmost), use the gap below (between p0 and p1).
    if (drawLabel) {
        let upperNode, lowerNode;
        if (senderNodeId === 0) {
            upperNode = 0;
            lowerNode = 1;
        } else {
            upperNode = senderNodeId - 1;
            lowerNode = senderNodeId;
        }
        const upperBoxBottom = boxY(upperNode) + BOX_HEIGHT;
        const lowerBoxTop = boxY(lowerNode);
        const labelY = (upperBoxBottom + lowerBoxTop) / 2 + 3;
        const t = svgEl("text", {
            x: endX + 4, y: labelY,
            "text-anchor": "start",
            class: "msg-label",
        });
        t.textContent = msgLabel(message);
        labelGroup.appendChild(t);
    }

    parent.appendChild(g);
}

// --- Main render function ---

export function render(systemState) {
    const container = document.getElementById("timeline-container");
    // Preserve the column header, clear everything else
    const header = container.querySelector(".column-header");
    container.innerHTML = "";
    if (header) container.appendChild(header);

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
    const svgHeight = ROW_Y_OFFSET + NUM_NODES * ROW_HEIGHT;

    const svg = svgEl("svg", { width: svgWidth, height: svgHeight });

    // Arrowhead markers
    const defs = svgEl("defs");
    for (const [name, color] of [
        ["arrowhead-gray", "#aaa"],
        ["arrowhead-proposal", "#3b82f6"],
        ["arrowhead-prevote", "#f97316"],
        ["arrowhead-precommit", "#d4a017"],
    ]) {
        const marker = svgEl("marker", {
            id: name, viewBox: "0 0 10 7", refX: 10, refY: 3.5,
            markerWidth: 8, markerHeight: 6, orient: "auto-start-reverse",
        });
        marker.appendChild(svgEl("polygon", { points: "0 0, 10 3.5, 0 7", fill: color }));
        defs.appendChild(marker);
    }
    svg.appendChild(defs);

    // Row grid: center lane lines only (no separator lines)
    const gridGroup = svgEl("g", { class: "grid" });
    for (let i = 0; i < NUM_NODES; i++) {
        const centerY = rowCenterY(i);
        gridGroup.appendChild(svgEl("line", {
            x1: 0, y1: centerY, x2: svgWidth, y2: centerY, class: "lane-line",
        }));
    }
    svg.appendChild(gridGroup);

    // Draw initial state boxes (node labels are now in the left pane)
    const stateBoxes = svgEl("g", { id: "state-boxes" });
    const latestBoxPerNode = {};
    for (let i = 0; i < NUM_NODES; i++) {
        const x = INITIAL_X;
        const y = boxY(i);
        drawStateBox(stateBoxes, x, y, null, i, true);
        latestBoxPerNode[i] = { x, y, stepIndex: 0 };
    }

    // Draw timeline entries
    const transitionArrows = svgEl("g", { id: "transition-arrows" });
    const messageArrows = svgEl("g", { id: "message-arrows" });
    const messageLabels = svgEl("g", { id: "message-labels" });

    // Track box positions for message arrow targets
    // For each entry, record where that node's box is after this transition
    const boxPositionsAtStep = []; // indexed by timeline entry index

    for (let idx = 0; idx < entryPositions.length; idx++) {
        const entry = entryPositions[idx];
        const nodeId = entry.nodeId;
        const x = boxX(entry.xIndex);
        const y = boxY(nodeId);

        // Draw state box with global step number
        drawStateBox(stateBoxes, x, y, entry.stateSnapshot, nodeId, false, entry.globalStepIndex);

        // Draw transition arrow from previous box to this box
        const prevBox = latestBoxPerNode[nodeId];
        drawTransitionArrow(transitionArrows, prevBox.x, x, y, entry.shortLabel);

        // Update latest box position for this node
        latestBoxPerNode[nodeId] = { x, y, stepIndex: entry.xIndex };

        // Draw message arrows, spacing multiple messages apart horizontally
        const MSG_SPACING = 14;
        for (let mi = 0; mi < entry.messagesProduced.length; mi++) {
            const msg = entry.messagesProduced[mi];
            const xOffset = mi * MSG_SPACING;
            let firstTarget = true;
            for (let targetNode = 0; targetNode < NUM_NODES; targetNode++) {
                if (targetNode === nodeId) continue;
                drawMessageArrow(
                    messageArrows,
                    messageLabels,
                    { x, y },
                    nodeId,
                    targetNode,
                    msg,
                    xOffset,
                    firstTarget,
                );
                firstTarget = false;
            }
        }
    }

    // Layer order: arrows (back), state boxes, message labels (front)
    svg.appendChild(messageArrows);
    svg.appendChild(transitionArrows);
    svg.appendChild(stateBoxes);
    svg.appendChild(messageLabels);
    container.appendChild(svg);

    // Auto-scroll to the right
    container.scrollLeft = container.scrollWidth;
}
