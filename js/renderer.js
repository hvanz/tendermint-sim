import { NUM_NODES, MessageType, TimeoutType } from "./types.js";
import { formatValue, formatInboxMessage, compactInboxMessages, roundsInMessages, stepClass } from "./state-box.js";
import { getUserStrikes, getSidebandLog } from "./engine.js";

const SVG_NS = "http://www.w3.org/2000/svg";

const ROW_Y_OFFSET = 0;
const BOX_GAP = 90;
const BOX_PADDING = 6;
const INITIAL_X = 20;
const ROW_GUTTER = 16;
const MIN_ROW_HEIGHT = 120;

// Layout values shared with CSS. Set at the top of render() from the CSS
// custom properties in :root so there is exactly one source of truth.
let BOX_WIDTH = 129;
let COLUMN_HEADER_HEIGHT = 34;
let ROW_HEIGHT = MIN_ROW_HEIGHT;
let BOX_HEIGHT = MIN_ROW_HEIGHT - ROW_GUTTER;

function cssPx(varName) {
    const v = getComputedStyle(document.documentElement).getPropertyValue(varName);
    return parseFloat(v) || 0;
}

function computeRowHeight() {
    const mainArea = document.getElementById("main-area");
    const mainH = mainArea ? mainArea.clientHeight : window.innerHeight;
    const avail = mainH - COLUMN_HEADER_HEIGHT;
    return Math.max(MIN_ROW_HEIGHT, Math.floor(avail / NUM_NODES));
}

function boxX(stepIndex) {
    return INITIAL_X + stepIndex * (BOX_WIDTH + BOX_GAP);
}

function rowY(nodeId) {
    return ROW_Y_OFFSET + nodeId * ROW_HEIGHT;
}

function boxY(nodeId) {
    return rowY(nodeId) + (ROW_HEIGHT - BOX_HEIGHT) / 2;
}

function rowCenterY(nodeId) {
    return rowY(nodeId) + ROW_HEIGHT / 2;
}

function svgEl(tag, attrs = {}) {
    const el = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs)) {
        el.setAttribute(k, v);
    }
    return el;
}

function addText(parent, x, y, text, className = "") {
    const t = svgEl("text", { x, y, class: className });
    t.textContent = text;
    parent.appendChild(t);
}

function tspan(attrs, text) {
    const s = svgEl("tspan", attrs);
    s.textContent = text;
    return s;
}

function drawStateBox(parent, x, y, snapshot, nodeId, isInitial = false, globalStep = null, inbox = []) {
    const g = svgEl("g", { class: `state-box ${isInitial ? "step-initial" : stepClass(snapshot)}` });

    g.appendChild(svgEl("rect", {
        x, y, width: BOX_WIDTH, height: BOX_HEIGHT, rx: 6, ry: 6,
    }));

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
    let textY = y + 13;

    const varLines = isInitial
        ? ["round: -", "step: -", "locked: nil,-1", "valid: nil,-1"]
        : [
            `round: ${snapshot.round}`,
            `step: ${snapshot.decision !== null ? `decided (${formatValue(snapshot.decision)})` : snapshot.step}`,
            `locked: ${formatValue(snapshot.lockedValue)},${snapshot.lockedRound}`,
            `valid: ${formatValue(snapshot.validValue)},${snapshot.validRound}`,
        ];

    for (const line of varLines) {
        addText(g, textX, textY, line, "var-line");
        textY += varLineHeight;
    }

    const headerY = textY + 2;

    // Overlay matches .state-box-inbox: straight top edge, rounded bottom corners aligned with base rect.
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
        opacity: "0.6",
    }));
    const compacted = (!isInitial && inbox.length > 0)
        ? compactInboxMessages(inbox)
        : [];
    const rounds = roundsInMessages(compacted);
    const latestRound = rounds.length > 0 ? rounds[rounds.length - 1] : null;
    const headerText = latestRound !== null
        ? `inbox round: ${latestRound} `
        : `inbox round: - `;
    addText(g, textX, headerY, headerText, "inbox-header");

    if (latestRound !== null) {
        const visible = compacted.filter(m => m.round === latestRound);
        const userStrikes = nodeId != null ? getUserStrikes(nodeId) : new Set();
        let msgY = headerY + msgLineHeight;
        for (const msg of visible) {
            addMessageText(g, textX, msgY, msg, nodeId, userStrikes);
            msgY += msgLineHeight;
        }
    }

    parent.appendChild(g);
    return { x, y, width: BOX_WIDTH, height: BOX_HEIGHT };
}

function applyStruckMarker(endpoint, overlayParent) {
    if (!endpoint) return;
    if (endpoint.el) endpoint.el.style.opacity = "0.25";
    const xMark = svgEl("text", {
        x: endpoint.x, y: endpoint.y + 5,
        "text-anchor": "middle",
        "font-size": "14",
        "font-weight": "bold",
        fill: "#dc2626",
    });
    xMark.textContent = "✖";
    overlayParent.appendChild(xMark);
}

// Both endpoints leave/arrive at 60° from horizontal; sign follows vertical travel direction.
function drawLateArrivalArrow(parent, startX, fromY, toX, toY, msgType, isNilVote = false) {
    const nilClass = isNilVote ? " nil-vote" : "";
    const g = svgEl("g", { class: `message-arrow type-${msgType} late-arrival${nilClass}` });
    const span = Math.max(1, toX - startX);
    const angleRad = 60 * Math.PI / 180;
    const dirY = toY >= fromY ? 1 : -1;
    const tanLen = Math.max(40, Math.min(140, span * 0.22));
    const cosT = Math.cos(angleRad);
    const sinT = Math.sin(angleRad) * dirY;
    const c1x = startX + tanLen * cosT;
    const c1y = fromY + tanLen * sinT;
    const c2x = toX - tanLen * cosT;
    const c2y = toY - tanLen * sinT;
    g.appendChild(svgEl("path", {
        d: `M ${startX} ${fromY} C ${c1x} ${c1y} ${c2x} ${c2y} ${toX} ${toY}`,
        "marker-end": `url(#arrowhead-${msgType.toLowerCase()})`,
    }));
    parent.appendChild(g);
}

function addMessageText(parent, x, y, message, recipientNodeId, userStrikes) {
    const senders = message._senders || [message.sender];
    const valueText = formatValue(message.value);
    const argsText = message.type === MessageType.PROPOSAL
        ? `${valueText},vr=${message.validRound}`
        : valueText;
    const typeClass = `msg-type-${message.type.toLowerCase()}`;
    const engineStruck = message.isReceived === false;

    const userStruck = senders.map(s =>
        userStrikes.has(`${message.type}:${s}:${message.height}:${message.round}`)
    );
    const allStruck = senders.every((s, i) => engineStruck || userStruck[i]);
    const lineClass = allStruck ? "msg-line is-not-received" : "msg-line";
    const t = svgEl("text", { x, y, class: lineClass });

    senders.forEach((senderId, i) => {
        if (i > 0) t.appendChild(tspan({}, ","));
        const classes = ["msg-sender"];
        if (engineStruck || userStruck[i]) classes.push("is-not-received");
        t.appendChild(tspan({ class: classes.join(" ") }, `p${senderId}`));
    });

    t.appendChild(tspan({}, ": "));
    t.appendChild(tspan({ class: typeClass }, message.type));
    t.appendChild(tspan({}, `(${argsText})`));

    parent.appendChild(t);
}

// Splits at the space closest to the mid-point; 6px/char for the 10px mono font.
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

function drawTransitionArrow(parent, fromX, toX, y, label, scheduledTimeout) {
    const g = svgEl("g", { class: "transition-arrow" });
    const midY = y + BOX_HEIGHT / 2;
    const startX = fromX + BOX_WIDTH;
    const endX = toX;
    const arrowWidth = endX - startX;

    g.appendChild(svgEl("line", {
        x1: startX, y1: midY, x2: endX - 6, y2: midY,
        "marker-end": "url(#arrowhead-gray)",
    }));

    const labelX = (startX + endX) / 2;
    const lines = wrapTransitionLabel(label, arrowWidth);
    const lineHeight = 11;
    const topBaseline = midY - 8 - (lines.length - 1) * lineHeight;
    const labelEl = svgEl("text", {
        x: labelX, y: topBaseline, "text-anchor": "middle",
    });
    for (let i = 0; i < lines.length; i++) {
        labelEl.appendChild(tspan({ x: labelX, dy: i === 0 ? 0 : lineHeight }, lines[i]));
    }
    g.appendChild(labelEl);

    if (scheduledTimeout) {
        const timerEl = svgEl("text", { x: labelX, y: midY + 14, "text-anchor": "middle", "font-size": "12" });
        timerEl.textContent = "⏳";
        g.appendChild(timerEl);
    }

    parent.appendChild(g);
}

function msgLabel(message) {
    const val = message.value === null ? "nil" : message.value;
    const r = message.round;
    switch (message.type) {
        case "PROPOSAL": return `PROPOSAL(${val},${r},${message.validRound})`;
        case "PREVOTE": return `PREVOTE(${val},${r})`;
        case "PRECOMMIT": return `PRECOMMIT(${val},${r})`;
        default: return message.type;
    }
}

function drawMessageArrow(parent, labelGroup, fromBox, senderNodeId, toNodeId, message, xOffset, drawLabel) {
    const startX = fromBox.x - 20 - xOffset;
    const endX = startX + 14;
    const fromY = rowCenterY(senderNodeId);
    const toY = rowCenterY(toNodeId);

    const isNil = message.value === null;
    const nilClass = isNil ? "nil-vote" : "";
    const g = svgEl("g", { class: `message-arrow type-${message.type} ${nilClass}` });

    g.appendChild(svgEl("path", {
        d: `M ${startX} ${fromY} L ${endX} ${toY}`,
        "marker-end": `url(#arrowhead-${message.type.toLowerCase()})`,
    }));

    // Label sits in the gap above the sender; p0 uses the gap below since it has no row above.
    if (drawLabel) {
        const upperNode = senderNodeId === 0 ? 0 : senderNodeId - 1;
        const lowerNode = senderNodeId === 0 ? 1 : senderNodeId;
        const upperBoxBottom = boxY(upperNode) + BOX_HEIGHT;
        const lowerBoxTop = boxY(lowerNode);
        const labelY = (upperBoxBottom + lowerBoxTop) / 2 + 3;
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

function drawAlarmGlyph(parent, prevBoxX, x, y) {
    const midY = y + BOX_HEIGHT / 2;
    const labelX = (prevBoxX + BOX_WIDTH + x) / 2;
    const alarm = svgEl("text", {
        x: labelX, y: midY + 14, "text-anchor": "middle", "font-size": "12",
    });
    alarm.textContent = "⏰";
    parent.appendChild(alarm);
}

function lateArrivalEntryY(fromY, box) {
    const targetCenter = box.y + BOX_HEIGHT / 2;
    return fromY > targetCenter ? box.y + BOX_HEIGHT : box.y;
}

export function render(systemState) {
    BOX_WIDTH = cssPx("--box-width");
    COLUMN_HEADER_HEIGHT = cssPx("--column-header-height");
    ROW_HEIGHT = computeRowHeight();
    BOX_HEIGHT = ROW_HEIGHT - ROW_GUTTER;
    document.documentElement.style.setProperty("--row-height", `${ROW_HEIGHT}px`);

    const container = document.getElementById("timeline-container");
    container.innerHTML = "";

    const timeline = systemState.timeline;

    const nodeStepCounts = new Array(NUM_NODES).fill(0);
    const entryPositions = [];
    for (const entry of timeline) {
        nodeStepCounts[entry.nodeId]++;
        entryPositions.push({ ...entry, xIndex: entry.globalStepIndex });
    }

    const maxStepIndex = timeline.length > 0
        ? Math.max(...timeline.map(e => e.globalStepIndex))
        : 0;
    const svgWidth = boxX(maxStepIndex) + BOX_WIDTH + 30;
    const svgHeight = ROW_Y_OFFSET + NUM_NODES * ROW_HEIGHT;

    const svg = svgEl("svg", { width: svgWidth, height: svgHeight });

    // Arrowhead colors track the CSS --accent-* tokens in style.css.
    const defs = svgEl("defs");
    for (const [name, color] of [
        ["arrowhead-gray", "#94a3b8"],
        ["arrowhead-proposal", "#2563eb"],
        ["arrowhead-prevote", "#ea580c"],
        ["arrowhead-precommit", "#db2777"],
    ]) {
        const marker = svgEl("marker", {
            id: name, viewBox: "0 0 10 7", refX: 10, refY: 3.5,
            markerWidth: 8, markerHeight: 6, orient: "auto-start-reverse",
        });
        marker.appendChild(svgEl("polygon", { points: "0 0, 10 3.5, 0 7", fill: color }));
        defs.appendChild(marker);
    }
    svg.appendChild(defs);

    const gridGroup = svgEl("g", { class: "grid" });
    for (let i = 0; i < NUM_NODES; i++) {
        const centerY = rowCenterY(i);
        gridGroup.appendChild(svgEl("line", {
            x1: 0, y1: centerY, x2: svgWidth, y2: centerY, class: "lane-line",
        }));
    }
    svg.appendChild(gridGroup);

    const stateBoxes = svgEl("g", { id: "state-boxes" });
    const latestBoxPerNode = {};
    const boxHistoryPerNode = Array.from({ length: NUM_NODES }, () => []);
    for (let i = 0; i < NUM_NODES; i++) {
        const x = INITIAL_X;
        const y = boxY(i);
        drawStateBox(stateBoxes, x, y, null, i, true);
        latestBoxPerNode[i] = { x, y, stepIndex: 0 };
        boxHistoryPerNode[i].push({ x, y, stepIndex: 0 });
    }

    const transitionArrows = svgEl("g", { id: "transition-arrows" });
    const messageArrows = svgEl("g", { id: "message-arrows" });
    const messageLabels = svgEl("g", { id: "message-labels" });

    const messageArrowEndpoints = {};
    const messageOrigins = {};

    // If this node's NEXT entry late-receives (h, r), propagate back so the triggering state un-strikes too.
    const lookAheadLate = entryPositions.map(() => new Set());
    for (let i = 0; i < entryPositions.length; i++) {
        const e = entryPositions[i];
        for (let j = i + 1; j < entryPositions.length; j++) {
            if (entryPositions[j].nodeId !== e.nodeId) continue;
            const lrb = entryPositions[j].lateReceivedBy;
            if (lrb) lookAheadLate[i].add(`${lrb.height}:${lrb.round}`);
            break;
        }
    }

    // Endpoint keys that will end up with a late-arrival arrow (engine-driven
    // via lateReceivedBy, or user-driven via a sideband "unstrike" event).
    // The original straight arrow and any ✖ marker are suppressed for these
    // recipients so each message renders as a single arrow.
    const ackedEndpoints = new Set();
    for (const e of entryPositions) {
        if (!e.lateReceivedBy) continue;
        const { height, round } = e.lateReceivedBy;
        ackedEndpoints.add(`${MessageType.PROPOSAL}:${round % NUM_NODES}:${e.nodeId}:${height}:${round}`);
    }
    for (const ev of getSidebandLog()) {
        if (ev.kind !== "unstrike") continue;
        const [type, sender, h, r] = ev.key.split(":");
        ackedEndpoints.add(`${type}:${sender}:${ev.nodeId}:${h}:${r}`);
    }

    for (let idx = 0; idx < entryPositions.length; idx++) {
        const entry = entryPositions[idx];
        const nodeId = entry.nodeId;
        const x = boxX(entry.xIndex);
        const y = boxY(nodeId);

        const rawInbox = entry.inboxSnapshots ? entry.inboxSnapshots[nodeId] : [];
        const currentTimedOut = systemState.nodes[nodeId].timedOutRounds;
        const entryLateReceived = entry.lateReceivedSnapshot ? entry.lateReceivedSnapshot[nodeId] : null;
        const entryLookAhead = lookAheadLate[idx];
        const inbox = rawInbox.map(m => {
            if (m.type !== MessageType.PROPOSAL) return m;
            const key = `${m.height}:${m.round}`;
            const acknowledgedHere = (entryLateReceived && entryLateReceived.has(key)) || entryLookAhead.has(key);
            const struck = currentTimedOut.has(key) && !acknowledgedHere;
            return struck ? { ...m, isReceived: false } : m;
        });
        drawStateBox(stateBoxes, x, y, entry.stateSnapshot, nodeId, false, entry.globalStepIndex, inbox);

        const prevBox = latestBoxPerNode[nodeId];
        drawTransitionArrow(transitionArrows, prevBox.x, x, y, entry.shortLabel, entry.scheduledTimeout);

        if (entry.firedTimeout) {
            drawAlarmGlyph(transitionArrows, prevBox.x, x, y);
        }

        if (entry.lateReceivedBy) {
            const { height: lrH, round: lrR } = entry.lateReceivedBy;
            // PROPOSAL is always sent by proposer(h,r) = r % NUM_NODES.
            const originKey = `${MessageType.PROPOSAL}:${lrR % NUM_NODES}:${lrH}:${lrR}`;
            const origin = messageOrigins[originKey];
            if (origin) {
                const fromY = rowCenterY(origin.senderNodeId);
                const toX = prevBox.x + BOX_WIDTH / 2;
                const toY = lateArrivalEntryY(fromY, prevBox);
                drawLateArrivalArrow(messageArrows, origin.startX, fromY, toX, toY, MessageType.PROPOSAL);
            }
        }

        if (entry.firedTimeout && entry.firedTimeout.type === TimeoutType.PROPOSE) {
            const { height: tH, round: tR } = entry.firedTimeout;
            const key = `${MessageType.PROPOSAL}:${tR % NUM_NODES}:${nodeId}:${tH}:${tR}`;
            // Skip the ✖ if the message ends up acknowledged later — the
            // late-arrival curved arrow is the only visual for this delivery.
            if (!ackedEndpoints.has(key)) {
                applyStruckMarker(messageArrowEndpoints[key], stateBoxes);
            }
        }

        latestBoxPerNode[nodeId] = { x, y, stepIndex: entry.xIndex };
        boxHistoryPerNode[nodeId].push({ x, y, stepIndex: entry.globalStepIndex });

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
                const arrowEndX = x - 20 - xOffset + 14;
                const arrowEndY = rowCenterY(targetNode);
                messageArrowEndpoints[`${msg.type}:${nodeId}:${targetNode}:${msg.height}:${msg.round}`] = {
                    x: arrowEndX, y: arrowEndY, el: arrowEl,
                };
                const originKey = `${msg.type}:${nodeId}:${msg.height}:${msg.round}`;
                if (!messageOrigins[originKey]) {
                    messageOrigins[originKey] = {
                        senderNodeId: nodeId,
                        startX: x - 20 - xOffset,
                    };
                }
                firstTarget = false;
            }
        }
    }

    for (let nid = 0; nid < NUM_NODES; nid++) {
        for (const strikeKey of getUserStrikes(nid)) {
            const [type, sender, h, r] = strikeKey.split(":");
            const endpointKey = `${type}:${sender}:${nid}:${h}:${r}`;
            if (ackedEndpoints.has(endpointKey)) continue;
            applyStruckMarker(messageArrowEndpoints[endpointKey], stateBoxes);
        }
    }

    // Hide the original straight arrows for any delivery that ends up with a
    // late-arrival curved arrow. Drawing already happened above; flipping
    // display to none leaves the curved arrow as the sole visual.
    for (const endpointKey of ackedEndpoints) {
        const ep = messageArrowEndpoints[endpointKey];
        if (ep && ep.el) ep.el.style.display = "none";
    }

    for (const ev of getSidebandLog()) {
        if (ev.kind !== "unstrike") continue;
        const [type, senderStr, h, r] = ev.key.split(":");
        const origin = messageOrigins[`${type}:${senderStr}:${h}:${r}`];
        if (!origin) continue;
        const history = boxHistoryPerNode[ev.nodeId];
        let anchorBox = null;
        for (let i = history.length - 1; i >= 0; i--) {
            if (history[i].stepIndex <= ev.anchorStepCount) {
                anchorBox = history[i];
                break;
            }
        }
        if (!anchorBox) continue;
        const fromY = rowCenterY(origin.senderNodeId);
        const toX = anchorBox.x + BOX_WIDTH / 2;
        const toY = lateArrivalEntryY(fromY, anchorBox);
        const senderNum = Number(senderStr);
        const hNum = Number(h);
        const rNum = Number(r);
        const msg = systemState.nodes[ev.nodeId].inbox.find(m =>
            m.type === type && m.sender === senderNum && m.height === hNum && m.round === rNum
        );
        const isNil = msg ? msg.value === null : false;
        drawLateArrivalArrow(messageArrows, origin.startX, fromY, toX, toY, type, isNil);
    }

    // Layer order: arrows (back), state boxes, message labels (front).
    svg.appendChild(messageArrows);
    svg.appendChild(transitionArrows);
    svg.appendChild(stateBoxes);
    svg.appendChild(messageLabels);
    container.appendChild(svg);

    container.scrollLeft = container.scrollWidth;
}
