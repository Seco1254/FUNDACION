import { VersionRepository } from '../repo/version-repo.js';
import { EventVersionEntity } from '../domain/types.js';

export class VersionService {
  constructor(private repo: VersionRepository) {}

  async getLatest(eventId: string): Promise<EventVersionEntity | null> {
    return this.repo.findLatestByEventId(eventId);
  }
}
