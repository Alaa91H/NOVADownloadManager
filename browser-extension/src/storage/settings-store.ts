import { defaultSettings, Settings, SettingsSchema } from '../contracts/settings.schema';
import { StorageRepository } from './storage-repository';

const SETTINGS_KEY = 'adm.settings';

export class SettingsStore {
  private readonly repo = new StorageRepository(SETTINGS_KEY, SettingsSchema.catch(defaultSettings), { budgetKind: 'settings-import' });

  async get(): Promise<Settings> {
    return this.repo.get();
  }

  async set(settings: Settings): Promise<void> {
    await this.repo.set(settings);
  }
}
