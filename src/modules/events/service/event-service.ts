import { EventRepository } from '../repo/event-repo.js';
import { EventEntity } from '../domain/types.js';

export class EventService {
  constructor(private repo: EventRepository) {}

  async getById(id: string): Promise<EventEntity | null> {
    return this.repo.findById(id);
  }

  async create(): Promise<EventEntity> {
    return this.repo.create({});
  }
}
