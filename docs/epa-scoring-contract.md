# EPA scoring contract

The only score is `epa-reindexed-v1` in `src/utils/epaFormula.js`. The phone does not calculate EPA. Closed events keep the snapshot in `event.frozenScores`; recalculation appends the previous snapshot to `frozenScoreHistory`.

## Separate metrics

These are different numbers:

1. Feedback completion: how many required reviews were submitted. It is not an EPA score.
2. Skill score: the bias-corrected weighted score for one skill in one event.
3. Event EPA: the skill scores combined with the organizer's skill weights, or with committee relevance when the organizer chooses that.
4. Overall EPA: event scores combined only by the saved cross-event rule.
5. Contribution history: how many reviews a student submitted. It is not a rating.

## Settings

Every formula value comes from the event's scoring config. If a required setting is missing, or the scale is inverted, the event has no numeric score. The scorer does not substitute an example value.

Required settings: scale minimum and maximum, level influence, the three committee weights, credibility constant, credibility shrinkage, confidence prior, even-median rule, self-rating choice, blank-skill policy, unscored-skill policy, cross-event rule, whether relevance replaces skill weights, whether the event contributes to EPA, and a rank for every participant level plus a relevance for every committee and skill. Skill weights are required when relevance is not used as the skill weight.

Optional settings: a minimum review count, which labels a smaller sample provisional without changing the number; late-review policy; and whether anonymous comments are shown.

## Pipeline

Ratings outside the saved scale, blank scores, and skipped skills are absent. A blank score is absent even when the scale includes 0.

For each skill, the consensus is the median of received ratings. A rater's bias is the median of their deviations from consensus, and that bias is subtracted and clamped to the unit interval. Each corrected rating is weighted by level influence, committee weight, relevance, and shrunk credibility. The skill score is that weighted average, mapped back onto the organizer's scale. Confidence is the effective sample over the effective sample plus the saved prior. Confidence does not change the score.

Event confidence uses the same skill weights as event EPA. A skill with no usable weight produces no numeric score. If the organizer blocks unscored skills, one missing skill removes the event EPA.

## Privacy

Comments are returned only when the organizer turns them on, and never with the rater's identity. Whether the organizer can see who reviewed whom is optional and does not change the numeric score. A public profile is opt-in, revocable, and addressed by a hashed token. The raw token is not stored. Provisional scores stay visible and are labeled provisional.
