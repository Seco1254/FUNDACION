import { MediaRepository } from '../repo/media-repo.js';
import { MediaEntity } from '../domain/types.js';

export class MediaService {
  constructor(private repo: MediaRepository) {}

  async getByKey(mediaKey: string): Promise<MediaEntity | null> {
    return this.repo.findByKey(mediaKey);
  }

  async getAllowlisted(): Promise<MediaEntity[]> {
    return this.repo.findAllAllowlisted();
  }
}
