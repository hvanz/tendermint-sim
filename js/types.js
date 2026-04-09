// types.js -- Enums, message constructors, and value helpers for Tendermint simulator

export const Step = Object.freeze({
    PROPOSE: "propose",
    PREVOTE: "prevote",
    PRECOMMIT: "precommit",
});

export const MessageType = Object.freeze({
    PROPOSAL: "PROPOSAL",
    PREVOTE: "PREVOTE",
    PRECOMMIT: "PRECOMMIT",
});

// Consensus inputs (one per pseudocode rule)
export const InputType = Object.freeze({
    NEW_ROUND_PROPOSER: "NewRoundProposer",
    NEW_ROUND_NON_PROPOSER: "NewRoundNonProposer",
    PROPOSAL_FRESH: "ProposalFresh",           // L22-27: vr = -1
    PROPOSAL_WITH_POL: "ProposalWithPOL",       // L28-33: vr >= 0
    POLKA_ANY: "PolkaAny",                      // L34-35
    PROPOSAL_AND_POLKA_VALUE: "ProposalAndPolkaValue", // L36-43
    POLKA_NIL: "PolkaNil",                      // L44-46
    PRECOMMIT_ANY: "PrecommitAny",              // L47-48
    PROPOSAL_AND_COMMIT_VALUE: "ProposalAndCommitValue", // L49-54
    ROUND_SKIP: "RoundSkip",                    // L55-56
    TIMEOUT_PROPOSE: "TimeoutPropose",          // L57-60
    TIMEOUT_PREVOTE: "TimeoutPrevote",          // L61-64
    TIMEOUT_PRECOMMIT: "TimeoutPrecommit",      // L65-67
});

// Consensus outputs
export const OutputType = Object.freeze({
    BROADCAST_PROPOSAL: "BroadcastProposal",
    BROADCAST_PREVOTE: "BroadcastPrevote",
    BROADCAST_PRECOMMIT: "BroadcastPrecommit",
    SCHEDULE_TIMEOUT: "ScheduleTimeout",
    DECIDED: "Decided",
    SKIP_TO_ROUND: "SkipToRound",
    NONE: "None",
});

export const TimeoutType = Object.freeze({
    PROPOSE: "propose",
    PREVOTE: "prevote",
    PRECOMMIT: "precommit",
});

// --- Constructors ---

export function createMessage(type, sender, height, round, value, validRound = -1) {
    return { type, sender, height, round, value, validRound };
}

export function createNodeState(id) {
    return {
        id,
        height: 0,
        round: -1,         // -1 means not yet started
        step: Step.PROPOSE,
        lockedValue: null,
        lockedRound: -1,
        validValue: null,
        validRound: -1,
        decision: null,
    };
}

// Input constructors
export function inputNewRoundProposer(round, value) {
    return { type: InputType.NEW_ROUND_PROPOSER, round, value };
}

export function inputNewRoundNonProposer(round) {
    return { type: InputType.NEW_ROUND_NON_PROPOSER, round };
}

export function inputProposalFresh(value) {
    return { type: InputType.PROPOSAL_FRESH, value };
}

export function inputProposalWithPOL(value, vr) {
    return { type: InputType.PROPOSAL_WITH_POL, value, vr };
}

export function inputPolkaAny() {
    return { type: InputType.POLKA_ANY };
}

export function inputProposalAndPolkaValue(value) {
    return { type: InputType.PROPOSAL_AND_POLKA_VALUE, value };
}

export function inputPolkaNil() {
    return { type: InputType.POLKA_NIL };
}

export function inputPrecommitAny() {
    return { type: InputType.PRECOMMIT_ANY };
}

export function inputProposalAndCommitValue(round, value) {
    return { type: InputType.PROPOSAL_AND_COMMIT_VALUE, round, value };
}

export function inputRoundSkip(round) {
    return { type: InputType.ROUND_SKIP, round };
}

export function inputTimeoutPropose() {
    return { type: InputType.TIMEOUT_PROPOSE };
}

export function inputTimeoutPrevote() {
    return { type: InputType.TIMEOUT_PREVOTE };
}

export function inputTimeoutPrecommit() {
    return { type: InputType.TIMEOUT_PRECOMMIT };
}

// Output constructors
export function outputBroadcastProposal(height, round, value, validRound) {
    return { type: OutputType.BROADCAST_PROPOSAL, height, round, value, validRound };
}

export function outputBroadcastPrevote(height, round, value) {
    return { type: OutputType.BROADCAST_PREVOTE, height, round, value };
}

export function outputBroadcastPrecommit(height, round, value) {
    return { type: OutputType.BROADCAST_PRECOMMIT, height, round, value };
}

export function outputScheduleTimeout(timeoutType, height, round) {
    return { type: OutputType.SCHEDULE_TIMEOUT, timeoutType, height, round };
}

export function outputDecided(height, value) {
    return { type: OutputType.DECIDED, height, value };
}

export function outputSkipToRound(round) {
    return { type: OutputType.SKIP_TO_ROUND, round };
}

export function outputNone() {
    return { type: OutputType.NONE };
}

// Value label generation: 0 -> "A", 1 -> "B", etc.
export function valueLabelFromIndex(index) {
    return String.fromCharCode(65 + index);
}

// Constants for n=4
export const NUM_NODES = 4;
export const QUORUM = 3;           // smallest integer > 2*4/3 = 2.67 -> 3
export const SKIP_THRESHOLD = 2;   // smallest integer > 4/3 = 1.33 -> 2
