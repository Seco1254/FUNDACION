import { EventRepository } from '../../events/repo/event-repo.js';

export class FeedRepository {
  constructor(private eventRepo: EventRepository) {}

  async getFeed(cursor?: { publishedAt: Date; eventId: string }, pageSize: number = 20, topicFilter?: string) {
    return this.eventRepo.findPublishedFeed(cursor, pageSize, topicFilter);
  }

  async countEventsByState(): Promise<Record<string, number>> {
    return this.eventRepo.countByState();
  }
}
