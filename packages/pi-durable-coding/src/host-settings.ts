/** Apply product compaction policy through the native settings public API. */
import type { Model } from '@earendil-works/pi-ai';
import { compactionReserveFor } from './compaction-reserve.ts';
import type { SettingsManager } from "@earendil-works/pi-coding-agent";

type CompactionModel = Pick<Model<string>, 'provider' | 'id'> & { contextWindow?: number };

export type HostSettingsManager = SettingsManager & {
  setHostAutoCompactWindow(window: number | undefined): void;
  getCompactionReserveTokens(model?: CompactionModel): number;
  getCompactionSettings(model?: CompactionModel): ReturnType<SettingsManager['getCompactionSettings']>;
};

export function withHostCompactionPolicy(settings: SettingsManager): HostSettingsManager {
  let window: number | undefined;
  const reserve = (model?: CompactionModel) => compactionReserveFor(
    model?.contextWindow, settings.getCompactionReserveTokens(model), window,
  );
  const overrides = {
    setHostAutoCompactWindow: (next: number | undefined) => { window = next; },
    getCompactionReserveTokens: reserve,
    getCompactionSettings: (model?: CompactionModel) => ({
      ...settings.getCompactionSettings(model), reserveTokens: reserve(model),
    }),
  };
  const bound = new WeakMap<object, unknown>();
  return new Proxy(settings, {
    get(target, key) {
      if (Object.hasOwn(overrides, key)) return Reflect.get(overrides, key);
      const member = Reflect.get(target, key, target);
      if (typeof member !== 'function') return member;
      if (!bound.has(member)) bound.set(member, member.bind(target));
      return bound.get(member);
    },
  }) as HostSettingsManager;
}
