import { NUM_NODES } from "./types.js";

export function senderTooltip({ isOwn, engineStruck, consumed, userStruck, isPostGST = false }) {
    if (isOwn) return "Own broadcast";
    if (isPostGST) return "After GST: delivery is guaranteed.";
    if (consumed) return "Already used by a fired rule — cannot mark as not received";
    if (engineStruck) return "Mark as received (arrived late)";
    if (userStruck) return "Mark as received (late arrival)";
    return "Mark as not received";
}

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

export function formatInboxMessage(message) {
    const from = message._senderLabel !== undefined
        ? message._senderLabel
        : `p${message.sender}`;
    const value = formatValue(message.value);
    const args = message.type === "PROPOSAL"
        ? `${value},vr=${message.validRound}`
        : value;
    return `${from}: ${message.type}(${args})`;
}

export function sortInboxMessages(messages) {
    return [...messages].sort((a, b) =>
        b.height - a.height
        || b.round - a.round
    );
}

function senderLabel(senders) {
    if (senders.length === NUM_NODES) return "all";
    return [...senders].sort((a, b) => a - b).map(s => `p${s}`).join(",");
}

export function compactInboxMessages(messages) {
    // Drop exact duplicates: a Byzantine node can send the same content twice.
    const seen = new Set();
    const sorted = sortInboxMessages(messages).filter(m => {
        const k = `${m.type}|${m.sender}|${m.round}|${m.value}|${m.validRound}`;
        return !seen.has(k) && seen.add(k);
    });
    // After the filter, two messages with the same type, round, and sender
    // have different content: the sender equivocates.
    const perSender = new Map();
    for (const m of sorted) {
        const k = `${m.type}|${m.round}|${m.sender}`;
        perSender.set(k, (perSender.get(k) || 0) + 1);
    }
    const equivocators = (m, senders) =>
        senders.filter(s => perSender.get(`${m.type}|${m.round}|${s}`) > 1);
    const groupKey = m => `${m.type}|${m.round}|${m.value === null ? "nil" : m.value}`;

    const groupSenders = new Map();
    for (const m of sorted) {
        const k = groupKey(m);
        if (!groupSenders.has(k)) groupSenders.set(k, []);
        const list = groupSenders.get(k);
        if (!list.includes(m.sender)) list.push(m.sender);
    }

    const emitted = new Set();
    const result = [];
    for (const m of sorted) {
        const k = groupKey(m);
        const senders = groupSenders.get(k);
        if (senders.length < 2) {
            result.push({ ...m, _senders: [m.sender], _equivocators: equivocators(m, [m.sender]) });
            continue;
        }
        if (emitted.has(k)) continue;
        emitted.add(k);
        const sortedSenders = [...senders].sort((a, b) => a - b);
        result.push({
            ...m,
            _senders: sortedSenders,
            _senderLabel: senderLabel(sortedSenders),
            _equivocators: equivocators(m, sortedSenders),
        });
    }
    return result;
}

export function roundsInMessages(messages) {
    return [...new Set(messages.map(m => m.round))].sort((a, b) => a - b);
}

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

function renderSenderSpan(message, senderId, { nodeId, isStruck, isConsumed, engineStruck, isPostGST, isEquivocating }) {
    const key = `${message.type}:${senderId}:${message.height}:${message.round}`;
    const isOwn = senderId === nodeId;
    const disabled = isOwn || isConsumed || isPostGST;
    const classes = ["msg-sender"];
    if (isStruck) classes.push("is-not-received");
    if (disabled) classes.push("is-disabled");
    if (isPostGST) classes.push("is-gst-locked");
    if (isEquivocating) classes.push("is-equivocating");
    const conflict = isEquivocating
        ? `p${senderId} sent conflicting ${message.type} messages in round ${message.round}.\n`
        : "";
    const tooltip = conflict + senderTooltip({
        isOwn,
        engineStruck,
        consumed: isConsumed,
        userStruck: isStruck && !engineStruck,
        isPostGST,
    });
    const dataAttrs = disabled
        ? ""
        : ` data-node="${nodeId}" data-msg-key="${escapeHtml(key)}"`;
    return `<span class="${classes.join(" ")}"${dataAttrs} title="${escapeHtml(tooltip)}">p${senderId}${isEquivocating ? "\u{1F608}" : ""}</span>`;
}

function renderMessageRow(message, { nodeId, isSenderStruck, isSenderConsumed, isPostGST }) {
    const senders = message._senders || [message.sender];
    const userStruck = isSenderStruck || (() => false);
    const consumedPred = isSenderConsumed || (() => false);
    const engineStruck = message.isReceived === false;
    const struckByIdx = senders.map(s => engineStruck || userStruck(message, s));
    const consumedByIdx = senders.map(s => consumedPred(message, s));
    const allStruck = struckByIdx.every(Boolean);
    const rowClass = allStruck ? "state-box-message is-not-received" : "state-box-message";
    const typeClass = `msg-type-${message.type.toLowerCase()}`;
    const value = formatValue(message.value);
    const args = message.type === "PROPOSAL"
        ? `${value},vr=${message.validRound}`
        : value;
    const senderSpans = senders.map((senderId, idx) => renderSenderSpan(message, senderId, {
        nodeId,
        isStruck: struckByIdx[idx],
        isConsumed: consumedByIdx[idx],
        engineStruck,
        isPostGST,
        isEquivocating: (message._equivocators || []).includes(senderId),
    })).join('<span class="msg-comma">,</span>');
    return `<div class="${rowClass}">${senderSpans}: `
        + `<span class="${typeClass}">${escapeHtml(message.type)}</span>`
        + `(${escapeHtml(args)})</div>`;
}

export function renderStateBoxContent(snapshot, {
    globalStep = null,
    selectedRound = null,
    nodeId = null,
    isSenderStruck = null,
    isSenderConsumed = null,
    isPostGST = false,
} = {}) {
    const isInitial = snapshot === null || snapshot.round < 0;
    const allMessages = compactInboxMessages(snapshot?.availableMessages || []);

    const rounds = roundsInMessages(allMessages);
    const latestRound = rounds.length > 0 ? rounds[rounds.length - 1] : null;
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
            "locked: nil,-1",
            "valid: nil,-1",
        ]
        : [
            `round: ${snapshot.round}`,
            `step: ${stepLabel(snapshot)}`,
            `locked: ${formatValue(snapshot.lockedValue)},${snapshot.lockedRound}`,
            `valid: ${formatValue(snapshot.validValue)},${snapshot.validRound}`,
        ];

    const messageMarkup = visibleMessages
        .map(message => renderMessageRow(message, {
            nodeId,
            isSenderStruck,
            isSenderConsumed,
            isPostGST,
        }))
        .join("");

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
