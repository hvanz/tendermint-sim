// state-box.js -- Shared state box formatting for current state and timeline boxes

import { NUM_NODES } from "./types.js";

function escapeHtml(text) {
    return String(text)
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll("\"", "&quot;")
        .replaceAll("'", "&#39;");
}

export function formatValue(value) {
    return value === null ? "nil" : value;
}

export function stepClass(snapshot) {
    if (snapshot === null || snapshot.round < 0) return "step-initial";
    if (snapshot.decision !== null) return "step-decided";
    return `step-${snapshot.step}`;
}

function stepLabel(snapshot) {
    return snapshot.decision !== null
        ? `decided (${formatValue(snapshot.decision)})`
        : snapshot.step;
}

// Format one inbox entry. Sender-first: "{senderLabel}: TYPE(value)". The round
// context is implicit from the round-filter header, so we don't prefix "r{N}:".
// A compacted entry carries a precomputed _senderLabel (e.g. "all" or "p1,p2");
// otherwise fall back to the original single sender.
export function formatInboxMessage(message) {
    const from = message._senderLabel !== undefined
        ? message._senderLabel
        : `p${message.sender}`;
    return `${from}: ${message.type}(${formatValue(message.value)})`;
}

// Sort: height desc, round desc; within equal (height, round), Array.sort is
// stable so input insertion order is preserved (matches inbox insertion order).
export function sortInboxMessages(messages) {
    return [...messages].sort((a, b) =>
        b.height - a.height
        || b.round - a.round
    );
}

// Sort + compact: group messages by (type, round, value). If a group has >=2
// distinct senders, collapse the group into a single entry whose _senderLabel is:
//   - "all" when every node sent this combination (NUM_NODES senders)
//   - a comma-joined list like "p1,p2" otherwise
// The compacted entry is emitted at the position of the group's first message in
// sorted (insertion) order; subsequent members of the same group are dropped.
// Single-sender groups pass through unchanged.
export function compactInboxMessages(messages) {
    const sorted = sortInboxMessages(messages);
    const groupKey = m => `${m.type}|${m.round}|${m.value === null ? "nil" : m.value}`;

    // Collect distinct senders per group in the order they first appeared.
    const groupSenders = new Map();
    for (const m of sorted) {
        const k = groupKey(m);
        if (!groupSenders.has(k)) groupSenders.set(k, []);
        const list = groupSenders.get(k);
        if (!list.includes(m.sender)) list.push(m.sender);
    }

    const labelFor = senders => senders.length === NUM_NODES
        ? "all"
        : [...senders].sort((a, b) => a - b).map(s => `p${s}`).join(",");

    const emitted = new Set();
    const result = [];
    for (const m of sorted) {
        const k = groupKey(m);
        const senders = groupSenders.get(k);
        if (senders.length >= 2) {
            if (!emitted.has(k)) {
                emitted.add(k);
                result.push({ ...m, _senderLabel: labelFor(senders) });
            }
            // else: member of an already-emitted compacted group; skip.
        } else {
            result.push(m);
        }
    }
    return result;
}

// Collect distinct rounds present in a message list, ascending.
export function roundsInMessages(messages) {
    return [...new Set(messages.map(m => m.round))].sort((a, b) => a - b);
}

// Build the "---- inbox round: 0 1 2 ----" header.
// If nodeId is provided, round numbers become clickable <span class="round-link"> with
// data attributes that a parent click delegate can read. If nodeId is null, rounds are
// rendered as plain text (used by the SVG timeline via a separate renderer; HTML state
// pane always passes a nodeId).
function renderInboxHeader(rounds, effectiveRound, nodeId) {
    if (rounds.length === 0) {
        return `<div class="state-box-header">inbox round: - </div>`;
    }
    const linkMarkup = rounds.map(r => {
        const selected = r === effectiveRound;
        const classes = selected ? "round-link selected" : "round-link";
        const dataAttrs = (!selected && nodeId !== null)
            ? ` data-node="${nodeId}" data-round="${r}"`
            : "";
        return `<span class="${classes}"${dataAttrs}>${r}</span>`;
    }).join(" ");
    return `<div class="state-box-header">inbox round: ${linkMarkup} </div>`;
}

export function renderStateBoxContent(snapshot, { globalStep = null, selectedRound = null, nodeId = null } = {}) {
    const isInitial = snapshot === null || snapshot.round < 0;
    const allMessages = compactInboxMessages(snapshot?.availableMessages || []);

    const rounds = roundsInMessages(allMessages);
    const latestRound = rounds.length > 0 ? rounds[rounds.length - 1] : null;
    // null selection = auto-follow latest; explicit selection = sticky for this render.
    const effectiveRound = (selectedRound !== null && rounds.includes(selectedRound))
        ? selectedRound
        : latestRound;
    const visibleMessages = effectiveRound !== null
        ? allMessages.filter(m => m.round === effectiveRound)
        : [];

    const variableLines = isInitial
        ? [
            "round: -",
            "step: -",
            "locked: nil/-1",
            "valid: nil/-1",
        ]
        : [
            `round: ${snapshot.round}`,
            `step: ${stepLabel(snapshot)}`,
            `locked: ${formatValue(snapshot.lockedValue)}/${snapshot.lockedRound}`,
            `valid: ${formatValue(snapshot.validValue)}/${snapshot.validRound}`,
        ];

    const messageMarkup = visibleMessages.map((message) => {
        const className = message.isReceived === false
            ? "state-box-message is-not-received"
            : "state-box-message";
        const senderLabel = message._senderLabel !== undefined
            ? message._senderLabel
            : `p${message.sender}`;
        const valueText = formatValue(message.value);
        const typeClass = `msg-type-${message.type.toLowerCase()}`;
        // Color the TYPE token only, matching the pseudocode pane's .pc-msg-* palette.
        return `<div class="${className}">${escapeHtml(senderLabel)}: `
            + `<span class="${typeClass}">${escapeHtml(message.type)}</span>`
            + `(${escapeHtml(valueText)})</div>`;
    }).join("");

    const stepNumberMarkup = globalStep !== null
        ? `<div class="state-box-number">#${escapeHtml(globalStep)}</div>`
        : "";

    return `
        <div class="state-box-content">
            ${stepNumberMarkup}
            <div class="state-box-vars">
                ${variableLines.map((line) => `<div>${escapeHtml(line)}</div>`).join("")}
            </div>
            <div class="state-box-inbox">
                ${renderInboxHeader(rounds, effectiveRound, nodeId)}
                <div class="state-box-messages">${messageMarkup}</div>
            </div>
        </div>
    `;
}
