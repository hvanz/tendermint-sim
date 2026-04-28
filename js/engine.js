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
        });
    }
    return {
        nodes,
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
        })),
        nextValueLabel: state.nextValueLabel,
        stepCount: state.stepCount,
        timeline: state.timeline.map(e => ({ ...e, messagesProduced: [...e.messagesProduced] })),
    };
}

// --- Engine ---

let systemState = createSystemState();
let undoStack = [];

// Initialize: all nodes get pendingStartRound = 0
function initializeState() {
    for (const node of systemState.nodes) {
        node.pendingStartRound = 0;
    }
}

export function getState() {
    return systemState;
}

export function reset() {
    systemState = createSystemState();
    undoStack = [];
    initializeState();
}

export function canUndo() {
    return undoStack.length > 0;
}

export function undo() {
    if (undoStack.length === 0) return false;
    systemState = undoStack.pop();
    return true;
}

// --- Compute enabled transitions ---

export function computeEnabledTransitions(nodeId) {
    const node = systemState.nodes[nodeId];
    const msgs = node.inbox;
    const transitions = [];

    // If the node has decided, no more transitions
    if (node.decision !== null) return transitions;

    const h = node.height;
    const r = node.round;

    // 1. StartRound (pending from initialization, timeout, or round skip)
    if (node.pendingStartRound !== null) {
        const pendingRound = node.pendingStartRound;
        const isProposer = proposer(h, pendingRound) === nodeId;
        if (isProposer) {
            // Determine what value will be proposed
            const isFresh = node.validValue === null;
            const valueLabel = isFresh
                ? valueLabelFromIndex(systemState.nextValueLabel)
                : node.validValue;
            transitions.push({
                id: `n${nodeId}:startRound:${pendingRound}`,
                nodeId,
                ruleRef: "L11-19",
                label: `StartRound(${pendingRound}) [proposer] \u2192 PROPOSAL(${valueLabel})`,
                shortLabel: `StartRound(${pendingRound})`,
                inputFn: () => inputNewRoundProposer(pendingRound, valueLabel),
                isFreshValue: isFresh,
                executedLines: isFresh ? [12, 13, 14, 17, 18, 19] : [12, 13, 14, 15, 16, 19],
            });
        } else {
            transitions.push({
                id: `n${nodeId}:startRound:${pendingRound}`,
                nodeId,
                ruleRef: "L11-21",
                label: `StartRound(${pendingRound}) [non-proposer] \u2192 schedule timeoutPropose`,
                shortLabel: `StartRound(${pendingRound})`,
                inputFn: () => inputNewRoundNonProposer(pendingRound),
                executedLines: [12, 13, 14, 20, 21],
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
                label: `Upon PROPOSAL(${v}, vr=-1) \u2192 PREVOTE(${voteLabel})`,
                shortLabel: `PREVOTE(${voteLabel})`,
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
                    label: `Upon PROPOSAL(${v}, vr=${vr}) + polka \u2192 PREVOTE(${voteLabel})`,
                    shortLabel: `PREVOTE(${voteLabel})`,
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
                    ? `lock(${v}) + PRECOMMIT(${v})`
                    : `update valid(${v})`;
                const execLines = node.step === Step.PREVOTE
                    ? [36, 37, 38, 39, 40, 41, 42, 43]
                    : [36, 42, 43];
                transitions.push({
                    id: `n${nodeId}:L36:r${r}:${v}`,
                    nodeId,
                    ruleRef: "L36-43",
                    label: `PROPOSAL(${v}) + 2f+1 PREVOTE(${v}) \u2192 ${actionDesc}`,
                    shortLabel: node.step === Step.PREVOTE ? `PRECOMMIT(${v})` : `valid=${v}`,
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
                label: `2f+1 PREVOTE(nil) \u2192 PRECOMMIT(nil)`,
                shortLabel: `PRECOMMIT(nil)`,
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
        const isSkipProposer = proposer(h, skipRound) === nodeId;
        const isFreshSkip = node.validValue === null;
        const skipValueLabel = isFreshSkip
            ? valueLabelFromIndex(systemState.nextValueLabel)
            : node.validValue;
        const skipStartLines = isSkipProposer
            ? (isFreshSkip ? [12, 13, 14, 17, 18, 19] : [12, 13, 14, 15, 16, 19])
            : [12, 13, 14, 20, 21];
        transitions.push({
            id: `n${nodeId}:L55:skip_to_r${skipRound}`,
            nodeId,
            ruleRef: "L55-56",
            label: `f+1 msgs for round ${skipRound} \u2192 StartRound(${skipRound})`,
            shortLabel: `skip \u2192 StartRound(${skipRound})`,
            inputFn: () => inputRoundSkip(skipRound),
            executedLines: [55, 56, ...skipStartLines],
            chainsStartRound: { round: skipRound, isProposer: isSkipProposer, value: skipValueLabel, isFresh: isFreshSkip },
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
                        label: `OnTimeoutPropose(r=${r}) \u2192 PREVOTE(nil)`,
                        shortLabel: `timeout \u2192 PREVOTE(nil)`,
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
                        label: `OnTimeoutPrevote(r=${r}) \u2192 PRECOMMIT(nil)`,
                        shortLabel: `timeout \u2192 PRECOMMIT(nil)`,
                        inputFn: () => inputTimeoutPrevote(),
                        timeoutToRemove: timeout,
                        executedLines: [61, 62, 63, 64],
                    });
                }
                break;
            case TimeoutType.PRECOMMIT:
                {
                    const nextRound = r + 1;
                    const isNextProposer = proposer(h, nextRound) === nodeId;
                    const isFresh = node.validValue === null;
                    const valueLabel = isFresh
                        ? valueLabelFromIndex(systemState.nextValueLabel)
                        : node.validValue;
                    const startRoundLines = isNextProposer
                        ? (isFresh ? [12, 13, 14, 17, 18, 19] : [12, 13, 14, 15, 16, 19])
                        : [12, 13, 14, 20, 21];
                    transitions.push({
                        id: `n${nodeId}:timeout:precommit:r${r}`,
                        nodeId,
                        ruleRef: "L65-67",
                        label: `OnTimeoutPrecommit(r=${r}) \u2192 StartRound(${nextRound})`,
                        shortLabel: `timeout \u2192 StartRound(${nextRound})`,
                        inputFn: () => inputTimeoutPrecommit(),
                        timeoutToRemove: timeout,
                        executedLines: [65, 66, 67, ...startRoundLines],
                        chainsStartRound: { round: nextRound, isProposer: isNextProposer, value: valueLabel, isFresh },
                    });
                }
                break;
        }
    }

    return transitions;
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
    undoStack.push(cloneState(systemState));

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

    // Apply consensus state machine
    const { newState, outputs } = applyConsensusInput(node, input);

    // Update node state
    Object.assign(node, {
        height: newState.height,
        round: newState.round,
        step: newState.step,
        lockedValue: newState.lockedValue,
        lockedRound: newState.lockedRound,
        validValue: newState.validValue,
        validRound: newState.validRound,
        decision: newState.decision,
    });

    // Process outputs
    const messagesProduced = [];
    let scheduledTimeout = false;
    for (const output of outputs) {
        switch (output.type) {
            case OutputType.BROADCAST_PROPOSAL: {
                // Increment label counter if a fresh value was allocated
                if (transition.isFreshValue) {
                    systemState.nextValueLabel++;
                }
                const msg = createMessage(
                    MessageType.PROPOSAL, nodeId, output.height, output.round,
                    output.value, output.validRound
                );
                deliverMessage(systemState, msg);
                messagesProduced.push(msg);
                break;
            }
            case OutputType.BROADCAST_PREVOTE: {
                const msg = createMessage(
                    MessageType.PREVOTE, nodeId, output.height, output.round, output.value
                );
                deliverMessage(systemState, msg);
                messagesProduced.push(msg);
                break;
            }
            case OutputType.BROADCAST_PRECOMMIT: {
                const msg = createMessage(
                    MessageType.PRECOMMIT, nodeId, output.height, output.round, output.value
                );
                deliverMessage(systemState, msg);
                messagesProduced.push(msg);
                break;
            }
            case OutputType.SCHEDULE_TIMEOUT: {
                node.scheduledTimeouts.push({
                    type: output.timeoutType,
                    height: output.height,
                    round: output.round,
                });
                scheduledTimeout = true;
                break;
            }
            case OutputType.DECIDED: {
                // Decision is already recorded in node state
                break;
            }
            case OutputType.SKIP_TO_ROUND: {
                // Chain-execute StartRound immediately (compound transition)
                const sr = transition.chainsStartRound;
                if (sr) {
                    const srInput = sr.isProposer
                        ? inputNewRoundProposer(sr.round, sr.value)
                        : inputNewRoundNonProposer(sr.round);
                    const srResult = applyConsensusInput(node, srInput);
                    // Update node state from StartRound
                    Object.assign(node, {
                        height: srResult.newState.height,
                        round: srResult.newState.round,
                        step: srResult.newState.step,
                        lockedValue: srResult.newState.lockedValue,
                        lockedRound: srResult.newState.lockedRound,
                        validValue: srResult.newState.validValue,
                        validRound: srResult.newState.validRound,
                        decision: srResult.newState.decision,
                    });
                    // Process StartRound outputs
                    for (const srOut of srResult.outputs) {
                        switch (srOut.type) {
                            case OutputType.BROADCAST_PROPOSAL: {
                                if (sr.isFresh) systemState.nextValueLabel++;
                                const msg = createMessage(
                                    MessageType.PROPOSAL, nodeId, srOut.height, srOut.round,
                                    srOut.value, srOut.validRound
                                );
                                deliverMessage(systemState, msg);
                                messagesProduced.push(msg);
                                break;
                            }
                            case OutputType.SCHEDULE_TIMEOUT: {
                                node.scheduledTimeouts.push({
                                    type: srOut.timeoutType,
                                    height: srOut.height,
                                    round: srOut.round,
                                });
                                scheduledTimeout = true;
                                break;
                            }
                        }
                    }
                } else {
                    // Fallback: set pending (shouldn't happen with current transitions)
                    node.pendingStartRound = output.round;
                }
                break;
            }
            case OutputType.NONE:
                break;
        }
    }

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
