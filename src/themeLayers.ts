import { isEqual } from "es-toolkit";

import type {
  AcceptedSettingsPreview,
  ClearedSettingsPreview,
  SettingsAppearance,
} from "./settingsWindowProtocol";

function isNewer(
  epoch: number,
  revision: number,
  nextEpoch: number,
  nextRevision: number,
): boolean {
  return nextEpoch > epoch || (nextEpoch === epoch && nextRevision > revision);
}

export class ThemeLayers {
  private durable: SettingsAppearance = { theme: "system", highlightColors: {} };
  private preview: SettingsAppearance | null = null;
  private epoch = -1;
  private revision = -1;
  private initialized = false;

  setDurable(appearance: SettingsAppearance): SettingsAppearance | null {
    const previous = this.initialized ? this.effective() : null;
    this.durable = copyAppearance(appearance);
    this.initialized = true;
    return changedAppearance(previous, this.effective());
  }

  acceptPreview(event: AcceptedSettingsPreview): SettingsAppearance | null {
    if (!isNewer(this.epoch, this.revision, event.epoch, event.revision)) return null;
    const previous = this.initialized ? this.effective() : null;
    this.epoch = event.epoch;
    this.revision = event.revision;
    this.preview = copyAppearance(event.appearance);
    this.initialized = true;
    return changedAppearance(previous, this.effective());
  }

  clearPreview(event: ClearedSettingsPreview): SettingsAppearance | null {
    if (!isNewer(this.epoch, this.revision, event.epoch, event.revision)) return null;
    const previous = this.initialized ? this.effective() : null;
    this.epoch = event.epoch;
    this.revision = event.revision;
    this.durable = copyAppearance(event.durableAppearance);
    this.preview = null;
    this.initialized = true;
    return changedAppearance(previous, this.effective());
  }

  effective(): SettingsAppearance {
    return copyAppearance(this.preview ?? this.durable);
  }
}

function copyAppearance(appearance: SettingsAppearance): SettingsAppearance {
  return {
    theme: appearance.theme,
    highlightColors: { ...appearance.highlightColors },
  };
}

function changedAppearance(
  previous: SettingsAppearance | null,
  next: SettingsAppearance,
): SettingsAppearance | null {
  return previous !== null && isEqual(previous, next) ? null : next;
}
