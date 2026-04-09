// consensus.js -- Pure consensus state machine translating Algorithm 1 pseudocode
//
// Single function: applyConsensusInput(state, input) -> { newState, outputs[] }
// The state machine is deterministic: same state + input = same result.
// Multiple outputs are possible (e.g., L36-43 broadcasts PRECOMMIT AND updates validValue).

import {
    Step, InputType, OutputType,
    outputBroadcastProposal, outputBroadcastPrevote, outputBroadcastPrecommit,
    outputScheduleTimeout, outputDecided, outputSkipToRound, outputNone,
    TimeoutType,
} from "./types.js";

/**
 * Apply a consensus input to a node state, returning the new state and outputs.
 *
 * @param {object} state - Current node state (will not be mutated)
 * @param {object} input - Consensus input (from InputType)
 * @returns {{ newState: object, outputs: object[] }}
 */
export function applyConsensusInput(state, input) {
    // Clone state so we never mutate the original
    const s = { ...state };
    const outputs = [];

    switch (input.type) {

        // L11-19: StartRound when this node IS the proposer
        case InputType.NEW_ROUND_PROPOSER: {
            s.round = input.round;
            s.step = Step.PROPOSE;
            // L15-18: propose validValue if set, otherwise the new value from getValue()
            const proposal = s.validValue !== null ? s.validValue : input.value;
            // L19: broadcast PROPOSAL
            outputs.push(outputBroadcastProposal(s.height, s.round, proposal, s.validRound));
            break;
        }

        // L11-13, L20-21: StartRound when this node is NOT the proposer
        case InputType.NEW_ROUND_NON_PROPOSER: {
            s.round = input.round;
            s.step = Step.PROPOSE;
            // L21: schedule OnTimeoutPropose
            outputs.push(outputScheduleTimeout(TimeoutType.PROPOSE, s.height, s.round));
            break;
        }

        // L22-27: upon PROPOSAL(h, round, v, -1) from proposer while step = propose
        case InputType.PROPOSAL_FRESH: {
            const v = input.value;
            // L23: if valid(v) && (lockedRound == -1 || lockedValue == v)
            // For the simulator, all values from correct nodes are valid
            if (s.lockedRound === -1 || s.lockedValue === v) {
                // L24: broadcast PREVOTE for id(v)
                outputs.push(outputBroadcastPrevote(s.height, s.round, v));
            } else {
                // L26: broadcast PREVOTE for nil
                outputs.push(outputBroadcastPrevote(s.height, s.round, null));
            }
            // L27: step <- prevote
            s.step = Step.PREVOTE;
            break;
        }

        // L28-33: upon PROPOSAL(h, round, v, vr) + 2f+1 PREVOTE(h, vr, id(v))
        //         while step = propose && vr >= 0 && vr < round
        case InputType.PROPOSAL_WITH_POL: {
            const v = input.value;
            const vr = input.vr;
            // L29: if valid(v) && (lockedRound <= vr || lockedValue == v)
            if (s.lockedRound <= vr || s.lockedValue === v) {
                // L30: broadcast PREVOTE for id(v)
                outputs.push(outputBroadcastPrevote(s.height, s.round, v));
            } else {
                // L32: broadcast PREVOTE for nil
                outputs.push(outputBroadcastPrevote(s.height, s.round, null));
            }
            // L33: step <- prevote
            s.step = Step.PREVOTE;
            break;
        }

        // L34-35: upon 2f+1 PREVOTE(h, round, *) while step = prevote (first time)
        case InputType.POLKA_ANY: {
            // L35: schedule OnTimeoutPrevote
            outputs.push(outputScheduleTimeout(TimeoutType.PREVOTE, s.height, s.round));
            break;
        }

        // L36-43: upon PROPOSAL(h, round, v, *) + 2f+1 PREVOTE(h, round, id(v))
        //         while valid(v) && step >= prevote (first time)
        case InputType.PROPOSAL_AND_POLKA_VALUE: {
            const v = input.value;
            // L37: if step = prevote then lock and precommit
            if (s.step === Step.PREVOTE) {
                // L38-39: lock on v
                s.lockedValue = v;
                s.lockedRound = s.round;
                // L40: broadcast PRECOMMIT for id(v)
                outputs.push(outputBroadcastPrecommit(s.height, s.round, v));
                // L41: step <- precommit
                s.step = Step.PRECOMMIT;
            }
            // L42-43: always update validValue/validRound (even if step was precommit)
            s.validValue = v;
            s.validRound = s.round;
            break;
        }

        // L44-46: upon 2f+1 PREVOTE(h, round, nil) while step = prevote
        case InputType.POLKA_NIL: {
            // L45: broadcast PRECOMMIT for nil
            outputs.push(outputBroadcastPrecommit(s.height, s.round, null));
            // L46: step <- precommit
            s.step = Step.PRECOMMIT;
            break;
        }

        // L47-48: upon 2f+1 PRECOMMIT(h, round, *) (first time)
        case InputType.PRECOMMIT_ANY: {
            // L48: schedule OnTimeoutPrecommit
            outputs.push(outputScheduleTimeout(TimeoutType.PRECOMMIT, s.height, s.round));
            break;
        }

        // L49-54: upon PROPOSAL(h, r, v, *) + 2f+1 PRECOMMIT(h, r, id(v))
        //         while decision[h] = nil
        case InputType.PROPOSAL_AND_COMMIT_VALUE: {
            const v = input.value;
            // L50-51: if valid(v) then decide
            s.decision = v;
            // Note: L52-54 (increment height, reset, StartRound(0)) are NOT done
            // because V1 is single-height. Decision is terminal.
            outputs.push(outputDecided(s.height, v));
            break;
        }

        // L55-56: upon f+1 messages with round > round_p -> StartRound(round)
        case InputType.ROUND_SKIP: {
            outputs.push(outputSkipToRound(input.round));
            break;
        }

        // L57-60: OnTimeoutPropose
        case InputType.TIMEOUT_PROPOSE: {
            // L58: if height = h && round = round && step = propose
            // (guard checked by engine before calling)
            // L59: broadcast PREVOTE(h, round, nil)
            outputs.push(outputBroadcastPrevote(s.height, s.round, null));
            // L60: step <- prevote
            s.step = Step.PREVOTE;
            break;
        }

        // L61-64: OnTimeoutPrevote
        case InputType.TIMEOUT_PREVOTE: {
            // L63: broadcast PRECOMMIT(h, round, nil)
            outputs.push(outputBroadcastPrecommit(s.height, s.round, null));
            // L64: step <- precommit
            s.step = Step.PRECOMMIT;
            break;
        }

        // L65-67: OnTimeoutPrecommit
        case InputType.TIMEOUT_PRECOMMIT: {
            // L67: StartRound(round + 1)
            outputs.push(outputSkipToRound(s.round + 1));
            break;
        }

        default:
            throw new Error(`Unknown input type: ${input.type}`);
    }

    return { newState: s, outputs };
}
