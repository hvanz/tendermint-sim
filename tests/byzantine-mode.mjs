import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
    agreementHolds,
    computeEnabledTransitions,
    declareGST,
    executeTransition,
    getState,
    makeByzantine,
    reset,
    sendByzantine,
    stepAll,
    undo,
} from "../js/engine.js";
import { compactInboxMessages } from "../js/state-box.js";
import { buildTraceJson, replayTrace } from "../js/ui.js";

const loadTrace = file => JSON.parse(readFileSync(new URL(`../traces/${file}`, import.meta.url), "utf8"));
const decisions = () => getState().nodes.map(n => n.decision);

// Each predefined trace replays, keeps agreement, and saves back unchanged.
for (const [file, expected] of [
    ["byzantine-proposal-equivocation.json", [null, "A", "A", "A"]],
    ["byzantine-silent-node-gst.json", [null, "A", "A", "A"]],
    ["byzantine-vote-equivocation-split-lock.json", ["A", "A", "A", null]],
    ["byzantine-amnesia.json", ["A", "A", "A", null]],
]) {
    const trace = loadTrace(file);
    replayTrace(trace);
    assert.deepEqual(decisions(), expected, `${file}: decisions`);
    assert.ok(agreementHolds(), `${file}: agreement holds`);
    assert.deepEqual(buildTraceJson(trace.name).steps, trace.steps, `${file}: save round-trip`);
}

// Only one node can be Byzantine; undo removes the event.
reset();
assert.equal(makeByzantine(3), true);
assert.equal(makeByzantine(2), false, "a second Byzantine node is refused");
assert.equal(getState().timeline.at(-1).kind, "byzantine");
undo();
assert.equal(getState().byzantineNode, null, "undo removes the Byzantine event");
assert.equal(makeByzantine(2), true, "after undo, another node can be Byzantine");

// Guards count distinct senders, once for each value (paper, Sec. II).
reset();
makeByzantine(3);
for (const id of [0, 1, 2]) executeTransition(id, `n${id}:startRound:0`);
executeTransition(0, "n0:L22:r0:A");
sendByzantine({ type: "PREVOTE", round: 0, value: "A" }, [1]);
sendByzantine({ type: "PREVOTE", round: 0, value: null }, [1]);
executeTransition(1, "n1:L22:r0:A");
const p1Ids = computeEnabledTransitions(1).map(t => t.id);
assert.ok(p1Ids.includes("n1:L36:r0:A"), "p3 counts toward the A polka (p0, p1, p3)");
assert.ok(p1Ids.includes("n1:L34:r0"), "L34 sees 3 distinct senders");
const p1Inbox = compactInboxMessages(getState().nodes[1].inbox);
assert.deepEqual(
    p1Inbox.filter(m => m._equivocators.length > 0).map(m => [m.value, m._equivocators]),
    [["A", [3]], [null, [3]]],
    "the inbox marks p3 as an equivocator in both rows",
);
reset();
makeByzantine(3);
for (const id of [0, 1, 2]) executeTransition(id, `n${id}:startRound:0`);
executeTransition(2, "n2:timeout:propose:r0");
sendByzantine({ type: "PREVOTE", round: 0, value: "A" }, [2]);
sendByzantine({ type: "PREVOTE", round: 0, value: null }, [2]);
assert.ok(
    !computeEnabledTransitions(2).some(t => t.id === "n2:L34:r0"),
    "two votes from one sender plus one own vote are 2 senders, not a quorum",
);

// After GST, the Byzantine node neither hides nor gets hidden; gossip
// forwards its messages to all correct nodes.
reset();
makeByzantine(0);
for (const id of [1, 2, 3]) executeTransition(id, `n${id}:startRound:0`);
sendByzantine({ type: "PREVOTE", round: 0, value: "B" }, [1]);
declareGST();
assert.ok(
    computeEnabledTransitions(0).some(t => t.id === "n0:startRound:0"),
    "the Byzantine node keeps its actions after GST",
);
assert.ok(
    computeEnabledTransitions(1).some(t => t.timeoutToRemove),
    "a Byzantine action does not hide correct timeouts",
);
for (const id of [2, 3]) {
    assert.ok(
        getState().nodes[id].inbox.some(m => m.sender === 0 && m.value === "B"),
        `GST gossip delivers the Byzantine PREVOTE to p${id}`,
    );
}
assert.ok(
    getState().timeline.at(-1).releasedDeliveries.some(d => d.nodeId === 2 && d.key === "PREVOTE:0:0:0"),
    "GST records gossip deliveries for the late-arrival arrows",
);
sendByzantine({ type: "PRECOMMIT", round: 0, value: "B" }, [1]);
assert.deepEqual(getState().timeline.at(-1).recipients, [1, 2, 3], "after GST, a send reaches all correct nodes");

// Random never moves the Byzantine node.
reset();
makeByzantine(2);
for (let i = 0; i < 5; i++) stepAll();
assert.equal(getState().nodes[2].round, -1, "stepAll skips the Byzantine node");

// The agreement check ignores the Byzantine node.
reset();
makeByzantine(3);
getState().nodes[0].decision = "A";
getState().nodes[3].decision = "B";
assert.ok(agreementHolds(), "a Byzantine decision does not count");
getState().nodes[1].decision = "B";
assert.ok(!agreementHolds(), "two different correct decisions violate agreement");

console.log("byzantine-mode: all engine Byzantine behavior");
