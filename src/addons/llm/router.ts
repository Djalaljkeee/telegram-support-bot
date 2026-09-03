/**
 * Which model answers which task.
 *
 * The gateway serves hundreds of models behind one key and bills a flat rate per
 * token - input and output cost the same, and the gap between tiers is cents per
 * month at our ticket volume. So the choice here is about answer quality and how
 * long the customer waits, not about the bill: the default is the strongest
 * model, and anything cheaper has to earn its place by being measurably faster.
 *
 * One lane runs today (`answer`, every customer message). `escalate` is a
 * second, optional model tried once when the first returns something unusable;
 * it is off unless configured, because a retry doubles the customer's wait.
 */
import cache from '../../cache';

/** A task the assistant performs, as named in `llm_models`. */
export type Lane = 'answer' | 'escalate';

/**
 * The model used when nothing is configured.
 *
 * Plain `claude-opus-5`, deliberately without one of the gateway's `-low` /
 * `-thinking-high` effort suffixes: measured against this gateway they returned
 * `reasoning_tokens: 0` and the same latency as the bare id, so they buy nothing
 * here and only make the configured model harder to recognise.
 */
export const DEFAULT_MODEL = 'claude-opus-5';

function conf() {
  return cache.config as any;
}

function trimmed(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * The model configured for a lane.
 *
 * `llm_models.<lane>` wins, then the single `llm_model`, then the default. The
 * `answer` lane always resolves to something; `escalate` stays null unless it is
 * both set and different from `answer` - retrying the same model on the same
 * prompt is just a retry, and calling that an escalation hides what happened.
 *
 * @param lane - The task to route.
 * @returns The model id, or null when the lane is switched off.
 */
export function modelFor(lane: Lane): string | null {
  const lanes = conf().llm_models;
  const configured = trimmed(lanes && typeof lanes === 'object' ? lanes[lane] : '');

  if (lane === 'answer') {
    return configured || trimmed(conf().llm_model) || DEFAULT_MODEL;
  }
  return configured && configured !== modelFor('answer') ? configured : null;
}
