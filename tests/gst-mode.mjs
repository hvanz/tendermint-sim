import assert from "node:assert/strict";

import {
    computeEnabledTransitions,
    declareGST,
    executeTransition,
    getSidebandLog,
    getState,
    getUserStrikes,
    isGSTDeclared,
    reset,
    stepAll,
    strike,
    toggleProposalAck,
    undo,
    unstrike,
} from "../js/engine.js";
import { gstReleaseRenderData } from "../js/renderer.js";
import { senderTooltip } from "../js/state-box.js";
import { Step, TimeoutType } from "../js/types.js";
import { buildTraceJson, replayTrace } from "../js/ui.js";

assert.equal(
    senderTooltip({
        isOwn: false,
        engineStruck: false,
        consumed: false,
        userStruck: false,
        isPostGST: true,
    }),
    "After GST: delivery is guaranteed.",
    "post-GST senders explain why delivery controls are disabled",
);
assert.deepEqual(
    gstReleaseRenderData({
        globalStepIndex: 7,
        releasedDeliveries: [{ nodeId: 2, key: "PREVOTE:3:0:1" }],
    }),
    [{
        nodeId: 2,
        type: "PREVOTE",
        sender: 3,
        height: 0,
        round: 1,
        endpointKey: "PREVOTE:3:2:0:1",
        originKey: "PREVOTE:3:0:1",
        gstStep: 7,
    }],
    "GST renderer data identifies the released endpoint and GST boundary step",
);

reset();
assert.equal(isGSTDeclared(), false, "reset starts before GST");

const state = getState();
const timeoutNode = state.nodes[1];
timeoutNode.pendingStartRound = null;
timeoutNode.round = 0;
timeoutNode.step = Step.PROPOSE;
timeoutNode.scheduledTimeouts.push({ type: TimeoutType.PROPOSE, height: 0, round: 0 });
assert.ok(
    computeEnabledTransitions(1).some(t => t.timeoutToRemove),
    "before GST, a timeout remains enabled while another node can make protocol progress",
);

reset();
assert.equal(declareGST(), true, "first GST declaration changes phase");
assert.equal(isGSTDeclared(), true, "GST declaration changes the query result");
assert.equal(getState().stepCount, 1, "GST advances the global step");
assert.deepEqual(
    getState().timeline.map(({ kind, nodeId, transitionId, globalStepIndex }) => (
        { kind, nodeId, transitionId, globalStepIndex }
    )),
    [{ kind: "gst", nodeId: null, transitionId: "GST", globalStepIndex: 1 }],
    "GST is a tagged global timeline event",
);
assert.equal(declareGST(), false, "GST declaration is idempotent");
assert.equal(getState().timeline.length, 1, "idempotent GST does not append another event");

reset();
const userStrikeKey = "PREVOTE:0:0:0";
strike(1, userStrikeKey);
getState().nodes[1].timedOutRounds.add("0:0");
getState().nodes[1].timedOutRounds.add("0:1");
getState().nodes[1].lateReceivedProposals.add("0:1");
getState().nodes[1].userAckedProposalStrikes.add("0:1");
declareGST();
assert.equal(getUserStrikes(1).size, 0, "GST clears user strikes");
assert.deepEqual(
    getSidebandLog().at(-1),
    { kind: "unstrike", nodeId: 1, key: userStrikeKey, anchorStepCount: 1 },
    "GST records each newly visible user-struck message at its timeline anchor",
);
assert.ok(
    getState().nodes[1].lateReceivedProposals.has("0:0"),
    "GST acknowledges engine-struck timed-out proposals",
);
assert.equal(
    getState().nodes[1].userAckedProposalStrikes.size,
    0,
    "GST clears user-driven proposal strike acknowledgements",
);
toggleProposalAck(1, 0, 1);
assert.ok(
    getState().nodes[1].lateReceivedProposals.has("0:1"),
    "a post-GST user action cannot restore an engine proposal strike",
);
const sidebandLengthAtGST = getSidebandLog().length;
strike(1, "PRECOMMIT:2:0:0");
assert.equal(getUserStrikes(1).size, 0, "new user strikes are refused after GST");
assert.equal(
    getSidebandLog().length,
    sidebandLengthAtGST,
    "a refused post-GST strike records no sideband event",
);

reset();
executeTransition(0, "n0:startRound:0");
const releasedProposalKey = "PROPOSAL:0:0:0";
strike(1, releasedProposalKey);
getState().nodes[1].timedOutRounds.add("0:0");
getState().nodes[2].timedOutRounds.add("0:0");
getState().nodes[3].timedOutRounds.add("0:0");
getState().nodes[3].lateReceivedProposals.add("0:0");
getState().nodes[3].timedOutRounds.add("9:9");
declareGST();
const expectedGSTReleases = [
    { nodeId: 1, key: releasedProposalKey },
    { nodeId: 2, key: releasedProposalKey },
];
assert.deepEqual(
    getState().timeline.at(-1).releasedDeliveries,
    expectedGSTReleases,
    "GST exposes each actual released delivery once, including user-struck and engine-timeout-only proposals",
);
executeTransition(1, "n1:startRound:0");
getState().timeline.find(event => event.kind === "gst").releasedDeliveries[0].key = "mutated";
undo();
assert.deepEqual(
    getState().timeline.at(-1).releasedDeliveries,
    expectedGSTReleases,
    "timeline snapshots deep-clone GST release metadata",
);

reset();
const postGSTState = getState();
const suppressedTimeoutNode = postGSTState.nodes[1];
suppressedTimeoutNode.pendingStartRound = null;
suppressedTimeoutNode.round = 0;
suppressedTimeoutNode.step = Step.PROPOSE;
suppressedTimeoutNode.scheduledTimeouts.push({
    type: TimeoutType.PROPOSE,
    height: 0,
    round: 0,
});
declareGST();
assert.equal(
    computeEnabledTransitions(1).some(t => t.timeoutToRemove),
    false,
    "after GST, protocol progress anywhere suppresses every timeout",
);
assert.throws(
    () => executeTransition(1, "n1:timeout:propose:r0"),
    /not found/,
    "manual execution cannot bypass post-GST timeout filtering",
);
const originalRandom = Math.random;
Math.random = () => 0;
try {
    stepAll();
} finally {
    Math.random = originalRandom;
}
assert.equal(
    suppressedTimeoutNode.timedOutRounds.size,
    0,
    "stepAll does not fire a globally suppressed timeout",
);

reset();
const quiescentState = getState();
for (const node of quiescentState.nodes) {
    node.pendingStartRound = null;
    node.decision = "done";
}
const onlyTimeoutNode = quiescentState.nodes[1];
onlyTimeoutNode.decision = null;
onlyTimeoutNode.round = 0;
onlyTimeoutNode.step = Step.PROPOSE;
onlyTimeoutNode.scheduledTimeouts.push({ type: TimeoutType.PROPOSE, height: 0, round: 0 });
declareGST();
assert.ok(
    computeEnabledTransitions(1).some(t => t.timeoutToRemove),
    "after GST, a timeout remains available when every enabled transition is a timeout",
);

reset();
const undoStrikeKey = "PREVOTE:3:0:0";
strike(1, undoStrikeKey);
getState().nodes[1].timedOutRounds.add("0:0");
const sidebandBeforeGST = getSidebandLog().map(event => ({ ...event }));
declareGST();
assert.equal(undo(), true, "GST declaration is undoable");
assert.equal(isGSTDeclared(), false, "undo restores the pre-GST phase");
assert.equal(getState().stepCount, 0, "undo removes the GST global step");
assert.equal(getState().timeline.length, 0, "undo removes the GST timeline event");
assert.deepEqual(
    [...getUserStrikes(1)],
    [undoStrikeKey],
    "undo restores the user strikes cleared by GST",
);
assert.equal(
    getState().nodes[1].lateReceivedProposals.has("0:0"),
    false,
    "undo restores late-arrival state changed by GST",
);
assert.deepEqual(
    getSidebandLog(),
    sidebandBeforeGST,
    "undo restores sideband history exactly across GST",
);

reset();
executeTransition(0, "n0:startRound:0");
const ordinaryUndoUnstrikeKey = "PROPOSAL:0:0:0";
strike(1, ordinaryUndoUnstrikeKey);
executeTransition(1, "n1:startRound:0");
unstrike(1, ordinaryUndoUnstrikeKey);
undo();
const originalUnstruckOverlay = [...getUserStrikes(1)];
assert.equal(
    originalUnstruckOverlay.length,
    0,
    "ordinary undo leaves a currently unstruck delivery unstruck",
);
assert.deepEqual(
    getSidebandLog(),
    [],
    "ordinary undo removes a stale retained strike when its future unstrike is pruned",
);
declareGST();
const unstruckSavedTrace = buildTraceJson("unstruck undo GST replay");
assert.deepEqual(
    unstruckSavedTrace.steps,
    ["n0:startRound:0", { kind: "gst" }],
    "trace save serializes the current unstruck overlay without a stale strike",
);
replayTrace(unstruckSavedTrace);
undo();
assert.deepEqual(
    [...getUserStrikes(1)],
    originalUnstruckOverlay,
    "undoing replayed GST restores the original unstruck pre-GST overlay",
);
assert.deepEqual(
    getSidebandLog(),
    [],
    "undoing replayed GST preserves empty sideband history for the unstruck delivery",
);

reset();
executeTransition(0, "n0:startRound:0");
strike(1, ordinaryUndoUnstrikeKey);
executeTransition(1, "n1:startRound:0");
unstrike(1, ordinaryUndoUnstrikeKey);
const retainedLateArrivalHistory = getSidebandLog().map(event => ({ ...event }));
executeTransition(2, "n2:startRound:0");
undo();
assert.equal(
    getUserStrikes(1).size,
    0,
    "ordinary undo keeps the delivery unstruck when its unstrike anchor remains",
);
assert.deepEqual(
    getSidebandLog(),
    retainedLateArrivalHistory,
    "ordinary undo preserves normal non-GST late-arrival history within the restored timeline",
);

reset();
executeTransition(0, "n0:startRound:0");
executeTransition(1, "n1:startRound:0");
const ordinaryUndoStrikeKey = "PROPOSAL:0:0:0";
strike(1, ordinaryUndoStrikeKey);
undo();
assert.ok(
    getUserStrikes(1).has(ordinaryUndoStrikeKey),
    "ordinary consensus undo preserves current user strikes",
);
assert.deepEqual(
    getSidebandLog(),
    [{ kind: "strike", nodeId: 1, key: ordinaryUndoStrikeKey, anchorStepCount: 1 }],
    "ordinary undo re-anchors the active strike so trace serialization preserves it",
);
declareGST();
assert.deepEqual(
    getSidebandLog(),
    [
        { kind: "strike", nodeId: 1, key: ordinaryUndoStrikeKey, anchorStepCount: 1 },
        { kind: "unstrike", nodeId: 1, key: ordinaryUndoStrikeKey, anchorStepCount: 2 },
    ],
    "GST adds only its implied release after an ordinary undo",
);
const savedTrace = buildTraceJson("undo GST replay");
assert.deepEqual(
    savedTrace.steps,
    [
        "n0:startRound:0",
        {
            kind: "strike",
            nodeId: 1,
            key: { type: "PROPOSAL", sender: 0, height: 0, round: 0 },
        },
        { kind: "gst" },
    ],
    "trace save keeps the re-anchored strike and serializes GST only as its global event",
);

replayTrace(savedTrace);
undo();
assert.deepEqual(
    [...getUserStrikes(1)],
    [ordinaryUndoStrikeKey],
    "undoing replayed GST restores the serialized pre-GST strike",
);
assert.deepEqual(
    getSidebandLog(),
    [{ kind: "strike", nodeId: 1, key: ordinaryUndoStrikeKey, anchorStepCount: 1 }],
    "undoing replayed GST restores the serialized sideband history",
);

console.log("gst-mode: all engine GST behavior");
