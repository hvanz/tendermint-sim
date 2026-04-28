// renderer.js -- SVG rendering: timeline rows, state boxes, transition arrows, message arrows

import { NUM_NODES, MessageType } from "./types.js";
import { formatValue, formatInboxMessage, compactInboxMessages, roundsInMessages, stepClass } from "./state-box.js";

const SVG_NS = "http://www.w3.org/2000/svg";

// Layout constants (fixed)
const ROW_Y_OFFSET = 0;         // no offset; column header provides top spacing
const BOX_WIDTH = 129;  // matches the rendered width of .current-state-box in the state pane
const BOX_GAP = 90;             // horizontal gap between boxes (includes arrow space)
const BOX_PADDING = 6;
const INITIAL_X = 20;           // no label width needed; labels are in left pane
const ROW_GUTTER = 16;          // total vertical gap between adjacent boxes (matches state-pane's 8+8 section padding so timeline boxes equal the current-state boxes in height)
const MIN_ROW_HEIGHT = 120;
// Approximate chrome above+below the timeline SVG in the viewport.
// Tuned to leave room for h1, controls, column-header, legend, traces, body padding.
const VIEWPORT_CHROME = 260;

// Dynamic per-render layout: row height tracks the viewport; box grows with the row
// but always leaves ROW_GUTTER of space for the message-arrow labels in between.
let ROW_HEIGHT = MIN_ROW_HEIGHT;
let BOX_HEIGHT = MIN_ROW_HEIGHT - ROW_GUTTER;

function computeRowHeight() {
    const avail = window.innerHeight - VIEWPORT_CHROME;
    return Math.max(MIN_ROW_HEIGHT, Math.floor(avail / NUM_NODES));
}

function boxX(stepIndex) {
    return INITIAL_X + stepIndex * (BOX_WIDTH + BOX_GAP);
}

function rowY(nodeId) {
    return ROW_Y_OFFSET + nodeId * ROW_HEIGHT;
}

// Box Y position: centered within the row (gutter split top/bottom)
function boxY(nodeId) {
    return rowY(nodeId) + (ROW_HEIGHT - BOX_HEIGHT) / 2;
}

function rowCenterY(nodeId) {
    return rowY(nodeId) + ROW_HEIGHT / 2;
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
// inbox is the node's message snapshot at this step (empty for initial and current-state-only boxes).
function drawStateBox(parent, x, y, snapshot, nodeId, isInitial = false, globalStep = null, inbox = []) {
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
    const varLineHeight = 12;
    const msgLineHeight = 11;
    // First variable baseline: top padding (3) + var font size (10)
    let textY = y + 13;

    const varLines = isInitial
        ? ["round: -", "step: -", "locked: nil/-1", "valid: nil/-1"]
        : [
            `round: ${snapshot.round}`,
            `step: ${snapshot.decision !== null ? `decided (${formatValue(snapshot.decision)})` : snapshot.step}`,
            `locked: ${formatValue(snapshot.lockedValue)}/${snapshot.lockedRound}`,
            `valid: ${formatValue(snapshot.validValue)}/${snapshot.validRound}`,
        ];

    for (const line of varLines) {
        addText(g, textX, textY, line, "var-line");
        textY += varLineHeight;
    }

    // Inbox round-filter header (non-interactive in SVG). Displays every round present
    // in the historical snapshot; messages below only show the latest round.
    const headerY = textY + 2;

    // Semi-transparent white overlay to tint the inbox region lighter than the base
    // step color. Matches the HTML .state-box-inbox look: straight top edge (no
    // rounded top), rounded bottom corners aligned with the base rect's rounded
    // bottom corners.
    const overlayY = headerY - 9;
    const cornerR = 6;
    const left = x;
    const right = x + BOX_WIDTH;
    const bottom = y + BOX_HEIGHT;
    const overlayPath = [
        `M ${left} ${overlayY}`,
        `L ${right} ${overlayY}`,
        `L ${right} ${bottom - cornerR}`,
        `Q ${right} ${bottom} ${right - cornerR} ${bottom}`,
        `L ${left + cornerR} ${bottom}`,
        `Q ${left} ${bottom} ${left} ${bottom - cornerR}`,
        "Z",
    ].join(" ");
    g.appendChild(svgEl("path", {
        d: overlayPath,
        fill: "#ffffff",
        opacity: "0.7",
    }));
    const compacted = (!isInitial && inbox.length > 0)
        ? compactInboxMessages(inbox)
        : [];
    const rounds = roundsInMessages(compacted);
    const latestRound = rounds.length > 0 ? rounds[rounds.length - 1] : null;
    // Timeline boxes are frozen snapshots — show only the round whose messages are
    // displayed below, not the full round history. (The HTML state pane shows all
    // rounds because it's interactive; the timeline is read-only.)
    const headerText = latestRound !== null
        ? `inbox round: ${latestRound} `
        : `inbox round: - `;
    addText(g, textX, headerY, headerText, "inbox-header");

    // Messages: show only the latest round's messages in this snapshot.
    if (latestRound !== null) {
        const visible = compacted.filter(m => m.round === latestRound);
        let msgY = headerY + msgLineHeight;
        for (const msg of visible) {
            addMessageText(g, textX, msgY, msg);
            msgY += msgLineHeight;
        }
    }

    parent.appendChild(g);
    return { x, y, width: BOX_WIDTH, height: BOX_HEIGHT };
}

function addText(parent, x, y, text, className = "") {
    const t = svgEl("text", { x, y, class: className });
    t.textContent = text;
    parent.appendChild(t);
}

// SVG equivalent of the HTML message row: "{sender}: {TYPE}({value})", where
// only the TYPE token is colored via a <tspan class="msg-type-{proposal|...}">.
// Matches the pseudocode pane's .pc-msg-* palette.
function addMessageText(parent, x, y, message) {
    const senderLabel = message._senderLabel !== undefined
        ? message._senderLabel
        : `p${message.sender}`;
    const valueText = formatValue(message.value);
    const typeClass = `msg-type-${message.type.toLowerCase()}`;
    const t = svgEl("text", { x, y, class: "msg-line" });

    const prefix = document.createElementNS(SVG_NS, "tspan");
    prefix.textContent = `${senderLabel}: `;
    t.appendChild(prefix);

    const typeSpan = document.createElementNS(SVG_NS, "tspan");
    typeSpan.setAttribute("class", typeClass);
    typeSpan.textContent = message.type;
    t.appendChild(typeSpan);

    const suffix = document.createElementNS(SVG_NS, "tspan");
    suffix.textContent = `(${valueText})`;
    t.appendChild(suffix);

    parent.appendChild(t);
}

// Split a label into lines that fit within maxWidth (approx, at 6px/char for the
// 10px monospace font used on transition arrows). Prefers splitting at spaces;
// if no good split point exists the label is returned as a single line.
function wrapTransitionLabel(label, maxWidth) {
    const charWidth = 6;
    const labelPadding = 8;
    const avail = maxWidth - labelPadding;
    if (label.length * charWidth <= avail) return [label];
    const mid = Math.floor(label.length / 2);
    const spaces = [];
    for (let i = 0; i < label.length; i++) {
        if (label[i] === " ") spaces.push(i);
    }
    if (spaces.length === 0) return [label];
    spaces.sort((a, b) => Math.abs(a - mid) - Math.abs(b - mid));
    const splitAt = spaces[0];
    return [label.slice(0, splitAt), label.slice(splitAt + 1)];
}

// Draw a horizontal arrow between two boxes on the same row
function drawTransitionArrow(parent, fromX, toX, y, label, scheduledTimeout) {
    const g = svgEl("g", { class: "transition-arrow" });
    const midY = y + BOX_HEIGHT / 2;
    const startX = fromX + BOX_WIDTH;
    const endX = toX;
    const arrowWidth = endX - startX;

    // Arrow line
    g.appendChild(svgEl("line", {
        x1: startX, y1: midY, x2: endX - 6, y2: midY,
        "marker-end": "url(#arrowhead-gray)",
    }));

    // Label above arrow, wrapped onto multiple lines when the label is wider than
    // the arrow (happens when consecutive steps belong to the same node and the
    // arrow is just BOX_GAP wide).
    const labelX = (startX + endX) / 2;
    const lines = wrapTransitionLabel(label, arrowWidth);
    const lineHeight = 11;
    const topBaseline = midY - 8 - (lines.length - 1) * lineHeight;
    const labelEl = svgEl("text", {
        x: labelX, y: topBaseline, "text-anchor": "middle",
    });
    for (let i = 0; i < lines.length; i++) {
        const tspan = svgEl("tspan", {
            x: labelX,
            dy: i === 0 ? 0 : lineHeight,
        });
        tspan.textContent = lines[i];
        labelEl.appendChild(tspan);
    }
    g.appendChild(labelEl);

    // Timer emoji below arrow when a timeout was scheduled
    if (scheduledTimeout) {
        const timerEl = svgEl("text", { x: labelX, y: midY + 14, "text-anchor": "middle", "font-size": "12" });
        timerEl.textContent = "\u23f3";
        g.appendChild(timerEl);
    }

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
        // Linear-interpolate along the arrow to find its X at labelY so the label
        // sits right next to the arrow line instead of offset from the arrowhead.
        const dy = toY - fromY;
        const arrowXAtLabelY = dy !== 0
            ? startX + ((labelY - fromY) / dy) * (endX - startX)
            : endX;
        const t = svgEl("text", {
            x: arrowXAtLabelY + 2, y: labelY,
            "text-anchor": "start",
            class: "msg-label",
        });
        t.textContent = msgLabel(message);
        labelGroup.appendChild(t);
    }

    parent.appendChild(g);
    return g;
}

// --- Main render function ---

export function render(systemState) {
    // Recompute row/box dimensions each render so the layout tracks the viewport.
    // Exposed as a CSS custom property so the HTML panes (left, state) follow.
    ROW_HEIGHT = computeRowHeight();
    BOX_HEIGHT = ROW_HEIGHT - ROW_GUTTER;
    document.documentElement.style.setProperty("--row-height", `${ROW_HEIGHT}px`);

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
    const svgWidth = boxX(maxStepIndex) + BOX_WIDTH + 30;
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

    // Track the last message arrow endpoint per target node (for red X on timeouts)
    // Each entry: { x, y } of the arrowhead tip on the target node's lane
    const lastArrowEndpoint = {};  // nodeId -> { x, y }

    for (let idx = 0; idx < entryPositions.length; idx++) {
        const entry = entryPositions[idx];
        const nodeId = entry.nodeId;
        const x = boxX(entry.xIndex);
        const y = boxY(nodeId);

        // Draw state box with global step number and this node's inbox at this step
        const inbox = entry.inboxSnapshots ? entry.inboxSnapshots[nodeId] : [];
        drawStateBox(stateBoxes, x, y, entry.stateSnapshot, nodeId, false, entry.globalStepIndex, inbox);

        // Draw transition arrow from previous box to this box
        const prevBox = latestBoxPerNode[nodeId];
        drawTransitionArrow(transitionArrows, prevBox.x, x, y, entry.shortLabel, entry.scheduledTimeout);

        // Red X on the tip of the last incoming message arrow if a timeout fired
        if (entry.firedTimeout && lastArrowEndpoint[nodeId]) {
            const ep = lastArrowEndpoint[nodeId];
            // Grey out the arrow
            if (ep.el) {
                ep.el.style.opacity = "0.25";
            }
            // Draw red X at the arrowhead
            const xMark = svgEl("text", {
                x: ep.x, y: ep.y + 5,
                "text-anchor": "middle",
                "font-size": "14",
                "font-weight": "bold",
                fill: "#dc2626",
            });
            xMark.textContent = "\u2716";
            stateBoxes.appendChild(xMark);
        }

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
                const arrowEl = drawMessageArrow(
                    messageArrows,
                    messageLabels,
                    { x, y },
                    nodeId,
                    targetNode,
                    msg,
                    xOffset,
                    firstTarget,
                );
                // Record the arrow endpoint and element on the target node's lane
                const arrowEndX = x - 20 - xOffset + 14;
                const arrowEndY = rowCenterY(targetNode);
                lastArrowEndpoint[targetNode] = { x: arrowEndX, y: arrowEndY, el: arrowEl };
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
