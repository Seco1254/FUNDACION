import { ArticleRepository } from '../repo/article-repo.js';
import { ArticleEntity } from '../domain/types.js';

export class ArticleService {
  constructor(private repo: ArticleRepository) {}

  async getById(id: string): Promise<ArticleEntity | null> {
    return this.repo.findById(id);
  }

  async getByUrl(url: string): Promise<ArticleEntity | null> {
    return this.repo.findByUrl(url);
  }

  async create(data: {
    mediaId: string;
    url: string;
    title: string;
    snippet: string;
    publishedAt?: Date | null;
  }): Promise<ArticleEntity> {
    return this.repo.create(data);
  }
}
