import type { Selector } from '../core/types.js';

/** S0 control: preload nothing and leave every candidate available to the agent. */
export class NoneSelector implements Selector {
  async select(input: Parameters<Selector['select']>[0]): ReturnType<Selector['select']> {
    return {
      selected: [],
      unselected: input.candidates.map(({ id }) => id),
      scores: [],
      meta: { kind: 'none' },
    };
  }
}
