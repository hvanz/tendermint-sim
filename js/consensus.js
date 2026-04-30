import {
    Step, InputType, OutputType,
    outputBroadcastProposal, outputBroadcastPrevote, outputBroadcastPrecommit,
    outputScheduleTimeout, outputDecided, outputSkipToRound, outputNone,
    TimeoutType,
} from "./types.js";

export function applyConsensusInput(state, input) {
    const s = { ...state };
    const outputs = [];

    switch (input.type) {
        // L11-19: StartRound, proposer
        case InputType.NEW_ROUND_PROPOSER: {
            s.round = input.round;
            s.step = Step.PROPOSE;
            const proposal = s.validValue !== null ? s.validValue : input.value;
            outputs.push(outputBroadcastProposal(s.height, s.round, proposal, s.validRound));
            break;
        }

        // L11-13, L20-21: StartRound, non-proposer
        case InputType.NEW_ROUND_NON_PROPOSER: {
            s.round = input.round;
            s.step = Step.PROPOSE;
            outputs.push(outputScheduleTimeout(TimeoutType.PROPOSE, s.height, s.round));
            break;
        }

        // L22-27: PROPOSAL(h, round, v, -1) while step = propose
        case InputType.PROPOSAL_FRESH: {
            const v = input.value;
            const prevoteValue = (s.lockedRound === -1 || s.lockedValue === v) ? v : null;
            outputs.push(outputBroadcastPrevote(s.height, s.round, prevoteValue));
            s.step = Step.PREVOTE;
            break;
        }

        // L28-33: PROPOSAL(h, round, v, vr) + 2f+1 PREVOTE(h, vr, id(v))
        //         while step = propose && vr >= 0 && vr < round
        case InputType.PROPOSAL_WITH_POL: {
            const v = input.value;
            const vr = input.vr;
            const prevoteValue = (s.lockedRound <= vr || s.lockedValue === v) ? v : null;
            outputs.push(outputBroadcastPrevote(s.height, s.round, prevoteValue));
            s.step = Step.PREVOTE;
            break;
        }

        // L34-35: 2f+1 PREVOTE(h, round, *) while step = prevote (first time)
        case InputType.POLKA_ANY: {
            outputs.push(outputScheduleTimeout(TimeoutType.PREVOTE, s.height, s.round));
            break;
        }

        // L36-43: PROPOSAL(h, round, v, *) + 2f+1 PREVOTE(h, round, id(v))
        //         while valid(v) && step >= prevote (first time)
        case InputType.PROPOSAL_AND_POLKA_VALUE: {
            const v = input.value;
            if (s.step === Step.PREVOTE) {
                s.lockedValue = v;
                s.lockedRound = s.round;
                outputs.push(outputBroadcastPrecommit(s.height, s.round, v));
                s.step = Step.PRECOMMIT;
            }
            s.validValue = v;
            s.validRound = s.round;
            break;
        }

        // L44-46: 2f+1 PREVOTE(h, round, nil) while step = prevote
        case InputType.POLKA_NIL: {
            outputs.push(outputBroadcastPrecommit(s.height, s.round, null));
            s.step = Step.PRECOMMIT;
            break;
        }

        // L47-48: 2f+1 PRECOMMIT(h, round, *) (first time)
        case InputType.PRECOMMIT_ANY: {
            outputs.push(outputScheduleTimeout(TimeoutType.PRECOMMIT, s.height, s.round));
            break;
        }

        // L49-54: PROPOSAL(h, r, v, *) + 2f+1 PRECOMMIT(h, r, id(v))
        //         while decision[h] = nil. L52-54 omitted (single-height).
        case InputType.PROPOSAL_AND_COMMIT_VALUE: {
            s.decision = input.value;
            outputs.push(outputDecided(s.height, input.value));
            break;
        }

        // L55-56: f+1 messages with round > round_p -> StartRound(round)
        case InputType.ROUND_SKIP: {
            outputs.push(outputSkipToRound(input.round));
            break;
        }

        // L57-60: OnTimeoutPropose
        case InputType.TIMEOUT_PROPOSE: {
            outputs.push(outputBroadcastPrevote(s.height, s.round, null));
            s.step = Step.PREVOTE;
            break;
        }

        // L61-64: OnTimeoutPrevote
        case InputType.TIMEOUT_PREVOTE: {
            outputs.push(outputBroadcastPrecommit(s.height, s.round, null));
            s.step = Step.PRECOMMIT;
            break;
        }

        // L65-67: OnTimeoutPrecommit
        case InputType.TIMEOUT_PRECOMMIT: {
            outputs.push(outputSkipToRound(s.round + 1));
            break;
        }

        default:
            throw new Error(`Unknown input type: ${input.type}`);
    }

    return { newState: s, outputs };
}
