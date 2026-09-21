import type { ModelTier, RoleModelRegistry } from './types.js';

export class StaticRoleModelRegistry implements RoleModelRegistry {
  private readonly tiers: Map<string, ModelTier>;

  constructor(tiers: ModelTier[], private readonly roles: Record<string, string>) {
    this.tiers = new Map(tiers.map((tier) => [tier.id, tier]));
    for (const [role, tier] of Object.entries(roles)) {
      if (!this.tiers.has(tier)) throw new Error(`Role ${role} references unknown tier ${tier}`);
    }
  }

  get(role: string): ModelTier {
    const tierId = this.roles[role] ?? this.roles.fallback;
    if (!tierId) throw new Error(`No model tier configured for role ${role} or fallback`);
    const tier = this.tiers.get(tierId);
    if (!tier) throw new Error(`Unknown model tier: ${tierId}`);
    return tier;
  }
}
