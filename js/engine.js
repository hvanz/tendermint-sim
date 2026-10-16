// engine.js -- System state, enabled transition computation, execution, undo
//
// This is the orchestrator. It owns the system state (all nodes, all messages,
// the undo stack) and provides the main API: computeEnabledTransitions,
// executeTransition, undo, reset, stepAll.

import {
    Step, MessageType, InputType, OutputType, TimeoutType,
    NUM_NODES, QUORUM, SKIP_THRESHOLD,
    createNodeState, createMessage, valueLabelFromIndex,
    inputNewRoundProposer, inputNewRoundNonProposer,
    inputProposalFresh, inputProposalWithPOL,
    inputPolkaAny, inputProposalAndPolkaValue, inputPolkaNil,
    inputPrecommitAny, inputProposalAndCommitValue,
    inputRoundSkip, inputTimeoutPropose, inputTimeoutPrevote, inputTimeoutPrecommit,
} from "./types.js";

import { applyConsensusInput } from "./consensus.js";

// --- Threshold helpers (stateless, scan global message log) ---

export function proposer(height, round) {
    return round % NUM_NODES;
}

function getProposal(messages, height, round) {
    const prop = proposer(height, round);
    return messages.find(
        m => m.type === MessageType.PROPOSAL &&
             m.height === height &&
             m.round === round &&
             m.sender === prop
    ) || null;
}

function countVotes(messages, type, height, round, value) {
    // value === undefined means "any" (wildcard)
    return messages.filter(m =>
        m.type === type &&
        m.height === height &&
        m.round === round &&
        (value === undefined || m.value === value)
    ).length;
}

function hasQuorumPrevotes(messages, height, round, value) {
    return countVotes(messages, MessageType.PREVOTE, height, round, value) >= QUORUM;
}

function hasQuorumPrecommits(messages, height, round, value) {
    return countVotes(messages, MessageType.PRECOMMIT, height, round, value) >= QUORUM;
}

// Count all messages (any type) for a given height and round
function countAllMessagesForRound(messages, height, round) {
    return messages.filter(m => m.height === height && m.round === round).length;
}

// Find the minimum round > currentRound with f+1 messages
function findSkipRound(messages, height, currentRound) {
    const roundCounts = {};
    for (const m of messages) {
        if (m.height === height && m.round > currentRound) {
            roundCounts[m.round] = (roundCounts[m.round] || 0) + 1;
        }
    }
    let minRound = null;
    for (const [r, count] of Object.entries(roundCounts)) {
        if (count >= SKIP_THRESHOLD) {
            const rNum = Number(r);
            if (minRound === null || rNum < minRound) {
                minRound = rNum;
            }
        }
    }
    return minRound;
}

// Check if a node has already broadcast a specific vote type for a given round
function hasNodeBroadcast(messages, nodeId, type, height, round) {
    return messages.some(m =>
        m.type === type &&
        m.sender === nodeId &&
        m.height === height &&
        m.round === round
    );
}

function startRoundLines(isProposer, isFresh) {
    if (!isProposer) return [12, 13, 14, 20, 21];
    return isFresh ? [12, 13, 14, 17, 18, 19] : [12, 13, 14, 15, 16, 19];
}

function resolveStartRoundPlan(node, nextValueLabel, round, nodeId) {
    const isProposer = proposer(node.height, round) === nodeId;
    const isFresh = node.validValue === null;
    const value = isFresh ? valueLabelFromIndex(nextValueLabel) : node.validValue;
    return { round, isProposer, isFresh, value, lines: startRoundLines(isProposer, isFresh) };
}

// --- System State ---

function createSystemState() {
    const nodes = [];
    for (let i = 0; i < NUM_NODES; i++) {
        nodes.push({
            ...createNodeState(i),
            scheduledTimeouts: [],   // [{type, height, round}]
            firedOnceRules: new Set(), // "L34:r0", "L36:r0:A", "L47:r0"
            pendingStartRound: null,   // round number if a StartRound is pending
            inbox: [],                 // messages delivered to this node (includes own broadcasts)
            timedOutRounds: new Set(), // "h:r" keys for rounds where OnTimeoutPropose fired; used to render the PROPOSAL for that round as not-received
            lateReceivedProposals: new Set(), // "h:r" keys where a rule that uses the PROPOSAL fired after a prior timeout (the proposal was acknowledged late, un-striking the message from the PRECOMMIT/DECIDE step onward)
            userAckedProposalStrikes: new Set(), // "h:r" keys the user acked via click; subset of lateReceivedProposals that indicates the ack was user-driven (toggle-able)
            consumedMessages: new Set(), // "type:sender:h:r" keys for messages that were used by an upon-rule firing; these can no longer be user-struck
        });
    }
    return {
        nodes,
        gstDeclared: false,
        nextValueLabel: 0,
        stepCount: 0,
        timeline: [],
    };
}

// Deliver a message to every node's inbox (instant delivery, including sender)
function deliverMessage(state, msg) {
    for (const n of state.nodes) {
        n.inbox.push(msg);
    }
}

// Deep clone the system state for undo
function cloneState(state) {
    return {
        nodes: state.nodes.map(n => ({
            ...n,
            scheduledTimeouts: [...n.scheduledTimeouts],
            firedOnceRules: new Set(n.firedOnceRules),
            inbox: n.inbox.map(m => ({ ...m })),
            timedOutRounds: new Set(n.timedOutRounds),
            lateReceivedProposals: new Set(n.lateReceivedProposals),
            userAckedProposalStrikes: new Set(n.userAckedProposalStrikes),
            consumedMessages: new Set(n.consumedMessages),
        })),
        gstDeclared: state.gstDeclared,
        nextValueLabel: state.nextValueLabel,
        stepCount: state.stepCount,
        timeline: state.timeline.map(e => ({
            ...e,
            messagesProduced: [...e.messagesProduced],
            ...(e.releasedDeliveries && {
                releasedDeliveries: e.releasedDeliveries.map(delivery => ({ ...delivery })),
            }),
        })),
    };
}

// --- Engine ---

let systemState = createSystemState();
let undoStack = [];

// Sideband user-driven "not received" state. Lives outside systemState so undo
// doesn't touch it (strikes persist across undo by design; dangling ack events
// are pruned after undo).
let userStrikesByNode = Array.from({ length: NUM_NODES }, () => new Set());
let sidebandLog = [];   // [{kind: "strike"|"unstrike", nodeId, key, anchorStepCount}]

function msgKey(type, senderId, height, round) {
    return `${type}:${senderId}:${height}:${round}`;
}

export function isMsgUserStruck(nodeId, msg) {
    return userStrikesByNode[nodeId].has(msgKey(msg.type, msg.sender, msg.height, msg.round));
}

export function getUserStrikes(nodeId) {
    return userStrikesByNode[nodeId];
}

export function getConsumedMessages(nodeId) {
    return systemState.nodes[nodeId].consumedMessages;
}

export function getSidebandLog() {
    return sidebandLog;
}

export function strike(nodeId, key) {
    if (systemState.gstDeclared) return;
    // Refuse to strike a message that has already been consumed by an upon-rule:
    // the rule has fired with that message, so it cannot retroactively be marked
    // as not-received.
    if (systemState.nodes[nodeId].consumedMessages.has(key)) return;
    userStrikesByNode[nodeId].add(key);
    sidebandLog.push({ kind: "strike", nodeId, key, anchorStepCount: systemState.stepCount });
}

// Toggle a user-driven acknowledgement of an engine-struck PROPOSAL (from
// OnTimeoutPropose firing). Adding/removing from lateReceivedProposals is
// what drives the visual un-strike; a sideband "unstrike" event gives the
// renderer an anchor for the late-arrival arrow. Only toggles when the
// engine strike exists AND the ack was user-driven (never unacks an ack
// that came from L36/L49 firing).
export function toggleProposalAck(nodeId, h, r) {
    const node = systemState.nodes[nodeId];
    const hr = `${h}:${r}`;
    if (!node.timedOutRounds.has(hr)) return;
    const key = `PROPOSAL:${proposer(h, r)}:${h}:${r}`;

    if (node.userAckedProposalStrikes.has(hr)) {
        node.userAckedProposalStrikes.delete(hr);
        node.lateReceivedProposals.delete(hr);
        for (let i = sidebandLog.length - 1; i >= 0; i--) {
            const e = sidebandLog[i];
            if (e.kind === "unstrike" && e.nodeId === nodeId && e.key === key) {
                sidebandLog.splice(i, 1);
                break;
            }
        }
        return;
    }
    // already engine-acked via L36/L49; don't touch
    if (node.lateReceivedProposals.has(hr)) return;

    userStrikesByNode[nodeId].delete(key);
    node.userAckedProposalStrikes.add(hr);
    node.lateReceivedProposals.add(hr);
    sidebandLog.push({ kind: "unstrike", nodeId, key, anchorStepCount: systemState.stepCount });
}

export function unstrike(nodeId, key) {
    userStrikesByNode[nodeId].delete(key);
    // If the matching strike happened at the same stepCount (no engine progress
    // in between), collapse: drop the strike and don't record an unstrike. Visual
    // effect: original arrow restored, no late-arrival arrow drawn.
    const anchor = systemState.stepCount;
    for (let i = sidebandLog.length - 1; i >= 0; i--) {
        const e = sidebandLog[i];
        if (e.nodeId !== nodeId || e.key !== key) continue;
        if (e.kind === "strike" && e.anchorStepCount === anchor) {
            sidebandLog.splice(i, 1);
            return;
        }
        break;
    }
    sidebandLog.push({ kind: "unstrike", nodeId, key, anchorStepCount: anchor });
}

// Initialize: all nodes get pendingStartRound = 0
function initializeState() {
    for (const node of systemState.nodes) {
        node.pendingStartRound = 0;
    }
}

export function getState() {
    return systemState;
}

export function isGSTDeclared() {
    return systemState.gstDeclared;
}

export function declareGST() {
    if (systemState.gstDeclared) return false;

    undoStack.push({
        state: cloneState(systemState),
        userStrikesByNode: userStrikesByNode.map(strikes => new Set(strikes)),
        sidebandLog: sidebandLog.map(event => ({ ...event })),
    });
    systemState.gstDeclared = true;
    systemState.stepCount++;

    const releasedDeliveries = [];
    const releasedDeliveryKeys = new Set();
    const recordReleasedDelivery = (nodeId, key) => {
        const deliveryKey = `${nodeId}:${key}`;
        if (releasedDeliveryKeys.has(deliveryKey)) return;
        releasedDeliveryKeys.add(deliveryKey);
        releasedDeliveries.push({ nodeId, key });
    };

    for (let nodeId = 0; nodeId < NUM_NODES; nodeId++) {
        for (const key of userStrikesByNode[nodeId]) {
            recordReleasedDelivery(nodeId, key);
            sidebandLog.push({
                kind: "unstrike",
                nodeId,
                key,
                anchorStepCount: systemState.stepCount,
            });
        }
        userStrikesByNode[nodeId].clear();
        const node = systemState.nodes[nodeId];
        node.userAckedProposalStrikes.clear();
        for (const key of node.timedOutRounds) {
            const newlyAcknowledged = !node.lateReceivedProposals.has(key);
            node.lateReceivedProposals.add(key);
            if (!newlyAcknowledged) continue;
            const [height, round] = key.split(":").map(Number);
            const proposal = node.inbox.find(message =>
                message.type === MessageType.PROPOSAL
                && message.sender === proposer(height, round)
                && message.height === height
                && message.round === round
            );
            if (proposal) {
                recordReleasedDelivery(
                    nodeId,
                    msgKey(proposal.type, proposal.sender, proposal.height, proposal.round),
                );
            }
        }
    }

    systemState.timeline.push({
        kind: "gst",
        nodeId: null,
        transitionId: "GST",
        label: "GST",
        shortLabel: "GST",
        inboxSnapshots: systemState.nodes.map(n => n.inbox.slice()),
        lateReceivedSnapshot: systemState.nodes.map(n => new Set(n.lateReceivedProposals)),
        releasedDeliveries,
        messagesProduced: [],
        scheduledTimeout: false,
        firedTimeout: null,
        globalStepIndex: systemState.stepCount,
    });
    return true;
}

export function reset() {
    systemState = createSystemState();
    undoStack = [];
    userStrikesByNode = Array.from({ length: NUM_NODES }, () => new Set());
    sidebandLog = [];
    initializeState();
}

export function canUndo() {
    return undoStack.length > 0;
}

export function undo() {
    if (undoStack.length === 0) return false;
    const snapshot = undoStack.pop();
    systemState = snapshot.state;
    if (snapshot.userStrikesByNode) {
        userStrikesByNode = snapshot.userStrikesByNode;
        sidebandLog = snapshot.sidebandLog;
        return true;
    }
    // Active strikes persist across ordinary undo. If their latest serializable
    // event would otherwise be pruned, move that strike back to the restored
    // step so trace replay reconstructs the same overlay.
    for (let nodeId = 0; nodeId < NUM_NODES; nodeId++) {
        for (const key of userStrikesByNode[nodeId]) {
            let latestRetainedEvent = null;
            for (const event of sidebandLog) {
                if (
                    event.nodeId === nodeId
                    && event.key === key
                    && event.anchorStepCount <= systemState.stepCount
                ) {
                    latestRetainedEvent = event;
                }
            }
            if (latestRetainedEvent?.kind === "strike") continue;
            for (let i = sidebandLog.length - 1; i >= 0; i--) {
                const event = sidebandLog[i];
                if (
                    event.kind === "strike"
                    && event.nodeId === nodeId
                    && event.key === key
                    && event.anchorStepCount > systemState.stepCount
                ) {
                    event.anchorStepCount = systemState.stepCount;
                    break;
                }
            }
        }
    }
    sidebandLog = sidebandLog.filter(e => e.anchorStepCount <= systemState.stepCount);

    // The live overlay also intentionally preserves unstrikes across ordinary
    // undo. If pruning their future unstrike leaves a strike as the latest
    // retained event, remove that stale strike so trace replay stays unstruck.
    const deliveries = new Set(sidebandLog.map(event => `${event.nodeId}\0${event.key}`));
    for (const delivery of deliveries) {
        const separator = delivery.indexOf("\0");
        const nodeId = Number(delivery.slice(0, separator));
        const key = delivery.slice(separator + 1);
        if (userStrikesByNode[nodeId].has(key)) continue;
        while (true) {
            const latestIndex = sidebandLog.findLastIndex(
                event => event.nodeId === nodeId && event.key === key
            );
            if (latestIndex < 0 || sidebandLog[latestIndex].kind !== "strike") break;
            sidebandLog.splice(latestIndex, 1);
        }
    }
    return true;
}

// --- Compute enabled transitions ---

function computeRawEnabledTransitions(nodeId) {
    const node = systemState.nodes[nodeId];
    // Hide user-struck messages from rule evaluation: struck = "not received",
    // so a rule that needs the message cannot fire.
    const userStrikes = userStrikesByNode[nodeId];
    const msgs = userStrikes.size === 0
        ? node.inbox
        : node.inbox.filter(m => !userStrikes.has(msgKey(m.type, m.sender, m.height, m.round)));
    const transitions = [];

    // If the node has decided, no more transitions
    if (node.decision !== null) return transitions;

    const h = node.height;
    const r = node.round;

    // 1. StartRound (pending from initialization, timeout, or round skip)
    if (node.pendingStartRound !== null) {
        const plan = resolveStartRoundPlan(node, systemState.nextValueLabel, node.pendingStartRound, nodeId);
        if (plan.isProposer) {
            transitions.push({
                id: `n${nodeId}:startRound:${plan.round}`,
                nodeId,
                ruleRef: "L11-19",
                label: `StartRound(${plan.round}) [proposer] \u2192 PROPOSAL(${plan.value})`,
                shortLabel: `StartRound(${plan.round})`,
                inputFn: () => inputNewRoundProposer(plan.round, plan.value),
                isFreshValue: plan.isFresh,
                executedLines: plan.lines,
            });
        } else {
            transitions.push({
                id: `n${nodeId}:startRound:${plan.round}`,
                nodeId,
                ruleRef: "L11-21",
                label: `StartRound(${plan.round}) [non-proposer] \u2192 schedule timeoutPropose`,
                shortLabel: `StartRound(${plan.round})`,
                inputFn: () => inputNewRoundNonProposer(plan.round),
                executedLines: plan.lines,
            });
        }
    }

    // Only check message-triggered rules if node has started (round >= 0)
    if (r < 0) return transitions;

    // 2. L22-27: upon PROPOSAL(h, r, v, -1) from proposer while step = propose
    if (node.step === Step.PROPOSE) {
        const proposal = getProposal(msgs, h, r);
        if (proposal && proposal.validRound === -1) {
            const v = proposal.value;
            const willVoteFor = (node.lockedRound === -1 || node.lockedValue === v);
            const voteLabel = willVoteFor ? v : "nil";
            transitions.push({
                id: `n${nodeId}:L22:r${r}:${v}`,
                nodeId,
                ruleRef: "L22-27",
                label: `Upon PROPOSAL(${v}, vr=-1) \u2192 PREVOTE(${voteLabel},${r})`,
                shortLabel: `PREVOTE(${voteLabel},${r})`,
                inputFn: () => inputProposalFresh(v),
                executedLines: willVoteFor ? [22, 23, 24, 27] : [22, 23, 25, 26, 27],
            });
        }
    }

    // 3. L28-33: upon PROPOSAL(h, r, v, vr) + 2f+1 PREVOTE(h, vr, id(v))
    //    while step = propose && vr >= 0 && vr < round
    if (node.step === Step.PROPOSE) {
        const proposal = getProposal(msgs, h, r);
        if (proposal && proposal.validRound >= 0 && proposal.validRound < r) {
            const v = proposal.value;
            const vr = proposal.validRound;
            if (hasQuorumPrevotes(msgs, h, vr, v)) {
                const willVoteFor = (node.lockedRound <= vr || node.lockedValue === v);
                const voteLabel = willVoteFor ? v : "nil";
                transitions.push({
                    id: `n${nodeId}:L28:r${r}:${v}:vr${vr}`,
                    nodeId,
                    ruleRef: "L28-33",
                    label: `Upon PROPOSAL(${v}, vr=${vr}) + polka \u2192 PREVOTE(${voteLabel},${r})`,
                    shortLabel: `PREVOTE(${voteLabel},${r})`,
                    inputFn: () => inputProposalWithPOL(v, vr),
                    executedLines: willVoteFor ? [28, 29, 30, 33] : [28, 29, 31, 32, 33],
                });
            }
        }
    }

    // 4. L34-35: upon 2f+1 PREVOTE(h, r, *) while step = prevote (first time)
    if (node.step === Step.PREVOTE && !node.firedOnceRules.has(`L34:r${r}`)) {
        if (countVotes(msgs, MessageType.PREVOTE, h, r, undefined) >= QUORUM) {
            transitions.push({
                id: `n${nodeId}:L34:r${r}`,
                nodeId,
                ruleRef: "L34-35",
                label: `2f+1 PREVOTE(any) \u2192 schedule timeoutPrevote`,
                shortLabel: `schedule timeoutPrevote`,
                inputFn: () => inputPolkaAny(),
                onceKey: `L34:r${r}`,
                executedLines: [34, 35],
            });
        }
    }

    // 5. L36-43: upon PROPOSAL(h, r, v, *) + 2f+1 PREVOTE(h, r, id(v))
    //    while valid(v) && step >= prevote (first time)
    if (node.step === Step.PREVOTE || node.step === Step.PRECOMMIT) {
        const proposal = getProposal(msgs, h, r);
        if (proposal) {
            const v = proposal.value;
            const onceKey = `L36:r${r}:${v}`;
            if (!node.firedOnceRules.has(onceKey) && hasQuorumPrevotes(msgs, h, r, v)) {
                const actionDesc = node.step === Step.PREVOTE
                    ? `lock(${v}) + PRECOMMIT(${v},${r})`
                    : `update valid(${v})`;
                const execLines = node.step === Step.PREVOTE
                    ? [36, 37, 38, 39, 40, 41, 42, 43]
                    : [36, 42, 43];
                transitions.push({
                    id: `n${nodeId}:L36:r${r}:${v}`,
                    nodeId,
                    ruleRef: "L36-43",
                    label: `PROPOSAL(${v}) + 2f+1 PREVOTE(${v}) \u2192 ${actionDesc}`,
                    shortLabel: node.step === Step.PREVOTE ? `PRECOMMIT(${v},${r})` : `set valid=${v},${r}`,
                    inputFn: () => inputProposalAndPolkaValue(v),
                    onceKey,
                    executedLines: execLines,
                });
            }
        }
    }

    // 6. L44-46: upon 2f+1 PREVOTE(h, r, nil) while step = prevote
    if (node.step === Step.PREVOTE) {
        if (hasQuorumPrevotes(msgs, h, r, null)) {
            transitions.push({
                id: `n${nodeId}:L44:r${r}`,
                nodeId,
                ruleRef: "L44-46",
                label: `2f+1 PREVOTE(nil) \u2192 PRECOMMIT(nil,${r})`,
                shortLabel: `PRECOMMIT(nil,${r})`,
                inputFn: () => inputPolkaNil(),
                executedLines: [44, 45, 46],
            });
        }
    }

    // 7. L47-48: upon 2f+1 PRECOMMIT(h, r, *) (first time) -- no step guard
    if (!node.firedOnceRules.has(`L47:r${r}`)) {
        if (countVotes(msgs, MessageType.PRECOMMIT, h, r, undefined) >= QUORUM) {
            transitions.push({
                id: `n${nodeId}:L47:r${r}`,
                nodeId,
                ruleRef: "L47-48",
                label: `2f+1 PRECOMMIT(any) \u2192 schedule timeoutPrecommit`,
                shortLabel: `schedule timeoutPrecommit`,
                inputFn: () => inputPrecommitAny(),
                onceKey: `L47:r${r}`,
                executedLines: [47, 48],
            });
        }
    }

    // 8. L49-54: upon PROPOSAL(h, r', v, *) + 2f+1 PRECOMMIT(h, r', id(v))
    //    while decision[h] = nil -- checks ANY round r'
    if (node.decision === null) {
        // Check all rounds that have proposals
        const checkedRounds = new Set();
        for (const m of msgs) {
            if (m.type === MessageType.PROPOSAL && m.height === h && !checkedRounds.has(m.round)) {
                checkedRounds.add(m.round);
                const propRound = m.round;
                const prop = getProposal(msgs, h, propRound);
                if (prop && hasQuorumPrecommits(msgs, h, propRound, prop.value)) {
                    transitions.push({
                        id: `n${nodeId}:L49:r${propRound}:${prop.value}`,
                        nodeId,
                        ruleRef: "L49-54",
                        label: `PROPOSAL(${prop.value}, r=${propRound}) + 2f+1 PRECOMMIT(${prop.value}) \u2192 DECIDE(${prop.value})`,
                        shortLabel: `DECIDE(${prop.value})`,
                        inputFn: () => inputProposalAndCommitValue(propRound, prop.value),
                        executedLines: [49, 50, 51, 52, 53, 54],
                    });
                }
            }
        }
    }

    // 9. L55-56: upon f+1 messages with round > round_p
    const skipRound = findSkipRound(msgs, h, r);
    if (skipRound !== null) {
        const skipPlan = resolveStartRoundPlan(node, systemState.nextValueLabel, skipRound, nodeId);
        transitions.push({
            id: `n${nodeId}:L55:skip_to_r${skipRound}`,
            nodeId,
            ruleRef: "L55-56",
            label: `f+1 msgs for round ${skipRound} \u2192 StartRound(${skipRound})`,
            shortLabel: `skip \u2192 StartRound(${skipRound})`,
            inputFn: () => inputRoundSkip(skipRound),
            executedLines: [55, 56, ...skipPlan.lines],
            chainsStartRound: { round: skipPlan.round, isProposer: skipPlan.isProposer, value: skipPlan.value, isFresh: skipPlan.isFresh },
        });
    }

    // 10. Timeouts
    for (const timeout of node.scheduledTimeouts) {
        if (timeout.height !== h || timeout.round !== r) continue;
        switch (timeout.type) {
            case TimeoutType.PROPOSE:
                if (node.step === Step.PROPOSE) {
                    transitions.push({
                        id: `n${nodeId}:timeout:propose:r${r}`,
                        nodeId,
                        ruleRef: "L57-60",
                        label: `OnTimeoutPropose(r=${r}) \u2192 PREVOTE(nil,${r})`,
                        shortLabel: `timeout\u2192PREVOTE(nil,${r})`,
                        inputFn: () => inputTimeoutPropose(),
                        timeoutToRemove: timeout,
                        executedLines: [57, 58, 59, 60],
                    });
                }
                break;
            case TimeoutType.PREVOTE:
                if (node.step === Step.PREVOTE) {
                    transitions.push({
                        id: `n${nodeId}:timeout:prevote:r${r}`,
                        nodeId,
                        ruleRef: "L61-64",
                        label: `OnTimeoutPrevote(r=${r}) \u2192 PRECOMMIT(nil,${r})`,
                        shortLabel: `timeout\u2192PRECOMMIT(nil,${r})`,
                        inputFn: () => inputTimeoutPrevote(),
                        timeoutToRemove: timeout,
                        executedLines: [61, 62, 63, 64],
                    });
                }
                break;
            case TimeoutType.PRECOMMIT:
                {
                    const plan = resolveStartRoundPlan(node, systemState.nextValueLabel, r + 1, nodeId);
                    transitions.push({
                        id: `n${nodeId}:timeout:precommit:r${r}`,
                        nodeId,
                        ruleRef: "L65-67",
                        label: `OnTimeoutPrecommit(r=${r}) \u2192 StartRound(${plan.round})`,
                        shortLabel: `timeout\u2192StartRound(${plan.round})`,
                        inputFn: () => inputTimeoutPrecommit(),
                        timeoutToRemove: timeout,
                        executedLines: [65, 66, 67, ...plan.lines],
                        chainsStartRound: { round: plan.round, isProposer: plan.isProposer, value: plan.value, isFresh: plan.isFresh },
                    });
                }
                break;
        }
    }

    return transitions;
}

export function computeEnabledTransitions(nodeId) {
    if (!systemState.gstDeclared) {
        return computeRawEnabledTransitions(nodeId);
    }

    const rawByNode = systemState.nodes.map((_, id) => computeRawEnabledTransitions(id));
    const hasNonTimeout = rawByNode.some(transitions =>
        transitions.some(transition => transition.timeoutToRemove === undefined)
    );
    return hasNonTimeout
        ? rawByNode[nodeId].filter(transition => transition.timeoutToRemove === undefined)
        : rawByNode[nodeId];
}

function recordConsumedMessages(node, input) {
    const h = node.height;
    const r = node.round;
    const nodeId = node.id;
    const visible = node.inbox.filter(m => !userStrikesByNode[nodeId].has(
        msgKey(m.type, m.sender, m.height, m.round)
    ));
    const add = (m) => node.consumedMessages.add(msgKey(m.type, m.sender, m.height, m.round));
    const consumeMatching = (predicate) => {
        for (const m of visible) {
            if (predicate(m)) add(m);
        }
    };
    const consumeProposal = (height, round) => {
        const propSender = proposer(height, round);
        consumeMatching(m =>
            m.type === MessageType.PROPOSAL && m.sender === propSender
            && m.height === height && m.round === round
        );
    };

    switch (input.type) {
        case InputType.PROPOSAL_FRESH:
            consumeProposal(h, r);
            return;
        case InputType.PROPOSAL_WITH_POL:
            consumeProposal(h, r);
            consumeMatching(m =>
                m.type === MessageType.PREVOTE && m.height === h
                && m.round === input.vr && m.value === input.value
            );
            return;
        case InputType.POLKA_ANY:
            consumeMatching(m =>
                m.type === MessageType.PREVOTE && m.height === h && m.round === r
            );
            return;
        case InputType.PROPOSAL_AND_POLKA_VALUE:
            consumeProposal(h, r);
            consumeMatching(m =>
                m.type === MessageType.PREVOTE && m.height === h
                && m.round === r && m.value === input.value
            );
            return;
        case InputType.POLKA_NIL:
            consumeMatching(m =>
                m.type === MessageType.PREVOTE && m.height === h
                && m.round === r && m.value === null
            );
            return;
        case InputType.PRECOMMIT_ANY:
            consumeMatching(m =>
                m.type === MessageType.PRECOMMIT && m.height === h && m.round === r
            );
            return;
        case InputType.PROPOSAL_AND_COMMIT_VALUE:
            consumeProposal(h, input.round);
            consumeMatching(m =>
                m.type === MessageType.PRECOMMIT && m.height === h
                && m.round === input.round && m.value === input.value
            );
            return;
        case InputType.ROUND_SKIP:
            consumeMatching(m => m.height === h && m.round === input.round);
            return;
    }
}

// --- Execute a transition ---

export function executeTransition(nodeId, transitionId) {
    // Find the transition
    const transitions = computeEnabledTransitions(nodeId);
    const transition = transitions.find(t => t.id === transitionId);
    if (!transition) {
        throw new Error(`Transition ${transitionId} not found for node ${nodeId}`);
    }

    // Save state for undo
    undoStack.push({ state: cloneState(systemState) });

    const node = systemState.nodes[nodeId];
    const input = transition.inputFn();

    // Track "for the first time" rules
    if (transition.onceKey) {
        node.firedOnceRules.add(transition.onceKey);
    }

    // Remove fired timeout (by value, not reference, since clone may have changed refs)
    if (transition.timeoutToRemove) {
        const t = transition.timeoutToRemove;
        const idx = node.scheduledTimeouts.findIndex(
            st => st.type === t.type && st.height === t.height && st.round === t.round
        );
        if (idx >= 0) node.scheduledTimeouts.splice(idx, 1);
    }

    // Clear pendingStartRound if this was a StartRound transition
    if (input.type === InputType.NEW_ROUND_PROPOSER || input.type === InputType.NEW_ROUND_NON_PROPOSER) {
        node.pendingStartRound = null;
    }

    // OnTimeoutPropose means this node gave up waiting for round r's PROPOSAL.
    // Record the (h, r) so the renderer can strike through any PROPOSAL for that
    // round in this node's inbox (present or future arrival).
    if (input.type === InputType.TIMEOUT_PROPOSE) {
        node.timedOutRounds.add(`${node.height}:${node.round}`);
    }

    // Record messages consumed by this upon-rule. Once a rule has used a message
    // to enable itself, the user can no longer retroactively mark it as not
    // received. Read from the filtered inbox (struck messages weren't visible
    // to the rule, so they weren't used).
    recordConsumedMessages(node, input);

    // Late-receive detection. If a rule that uses the PROPOSAL fires for a (h, r)
    // where the node had previously timed out, the node has effectively acknowledged
    // receipt of that proposal after all. The renderer un-strikes the message from
    // this step onward and draws a new "late delivery" arrow at this step.
    //   L36-43 uses the proposal from the CURRENT round (node.round).
    //   L49-54 uses the proposal from input.round (can be any past round).
    let lateReceivedBy = null;
    if (input.type === InputType.PROPOSAL_AND_POLKA_VALUE) {
        const key = `${node.height}:${node.round}`;
        if (node.timedOutRounds.has(key) && !node.lateReceivedProposals.has(key)) {
            node.lateReceivedProposals.add(key);
            lateReceivedBy = { height: node.height, round: node.round };
        }
    } else if (input.type === InputType.PROPOSAL_AND_COMMIT_VALUE) {
        const key = `${node.height}:${input.round}`;
        if (node.timedOutRounds.has(key) && !node.lateReceivedProposals.has(key)) {
            node.lateReceivedProposals.add(key);
            lateReceivedBy = { height: node.height, round: input.round };
        }
    }

    const { newState, outputs } = applyConsensusInput(node, input);

    const messagesProduced = [];
    let scheduledTimeout = false;

    function broadcast(msgType, output) {
        const msg = createMessage(
            msgType, nodeId, output.height, output.round, output.value, output.validRound
        );
        deliverMessage(systemState, msg);
        messagesProduced.push(msg);
    }
    function scheduleTimeout(output) {
        node.scheduledTimeouts.push({
            type: output.timeoutType,
            height: output.height,
            round: output.round,
        });
        scheduledTimeout = true;
    }
    function assignNodeState(ns) {
        Object.assign(node, {
            height: ns.height,
            round: ns.round,
            step: ns.step,
            lockedValue: ns.lockedValue,
            lockedRound: ns.lockedRound,
            validValue: ns.validValue,
            validRound: ns.validRound,
            decision: ns.decision,
        });
    }
    function processOutputs(outs, isFreshValue) {
        for (const output of outs) {
            switch (output.type) {
                case OutputType.BROADCAST_PROPOSAL:
                    if (isFreshValue) systemState.nextValueLabel++;
                    broadcast(MessageType.PROPOSAL, output);
                    break;
                case OutputType.BROADCAST_PREVOTE:
                    broadcast(MessageType.PREVOTE, output);
                    break;
                case OutputType.BROADCAST_PRECOMMIT:
                    broadcast(MessageType.PRECOMMIT, output);
                    break;
                case OutputType.SCHEDULE_TIMEOUT:
                    scheduleTimeout(output);
                    break;
                case OutputType.SKIP_TO_ROUND: {
                    const sr = transition.chainsStartRound;
                    if (!sr) {
                        // Fallback: shouldn't happen with current transitions
                        node.pendingStartRound = output.round;
                        break;
                    }
                    const srInput = sr.isProposer
                        ? inputNewRoundProposer(sr.round, sr.value)
                        : inputNewRoundNonProposer(sr.round);
                    const srResult = applyConsensusInput(node, srInput);
                    assignNodeState(srResult.newState);
                    processOutputs(srResult.outputs, sr.isFresh);
                    break;
                }
                case OutputType.DECIDED:
                case OutputType.NONE:
                    break;
            }
        }
    }

    assignNodeState(newState);
    processOutputs(outputs, transition.isFreshValue);

    // Record timeline entry
    systemState.stepCount++;
    systemState.timeline.push({
        nodeId,
        transitionId,
        ruleRef: transition.ruleRef,
        label: transition.label,
        shortLabel: transition.shortLabel,
        stateSnapshot: {
            round: node.round,
            step: node.step,
            lockedValue: node.lockedValue,
            lockedRound: node.lockedRound,
            validValue: node.validValue,
            validRound: node.validRound,
            decision: node.decision,
        },
        // Per-node inbox snapshot (raw; isReceived is a live overlay applied at
        // render time against the node's CURRENT timedOutRounds, so strike-through
        // retroactively covers all prior states once a node times out).
        inboxSnapshots: systemState.nodes.map(n => n.inbox.slice()),
        // Per-node snapshot of lateReceivedProposals at the END of this step.
        // Unlike strike-through (retroactive via live state), un-strike is step-wise:
        // a state box renders unstruck only if this entry's snapshot contains the key.
        lateReceivedSnapshot: systemState.nodes.map(n => new Set(n.lateReceivedProposals)),
        // If this transition caused a previously-struck proposal to become acknowledged,
        // carries the (height, round) of that proposal so the renderer can draw a new
        // "late delivery" arrow from the proposer's broadcast step to this step.
        lateReceivedBy,
        messagesProduced,
        scheduledTimeout,
        firedTimeout: transition.timeoutToRemove ? { ...transition.timeoutToRemove } : null,
        globalStepIndex: systemState.stepCount,
    });

    return { transition, messagesProduced };
}

// --- Step All: fire a random enabled transition for each node ---

export function stepAll() {
    // Random order of nodes
    const order = Array.from({ length: NUM_NODES }, (_, i) => i);
    for (let i = order.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [order[i], order[j]] = [order[j], order[i]];
    }

    let anyFired = false;
    for (const nodeId of order) {
        const transitions = computeEnabledTransitions(nodeId);
        if (transitions.length > 0) {
            const pick = transitions[Math.floor(Math.random() * transitions.length)];
            executeTransition(nodeId, pick.id);
            anyFired = true;
        }
    }
    return anyFired;
}

// Initialize on load
initializeState();
