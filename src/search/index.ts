interface SearchResult {
  id: string;
  score: number;
  domain: string;
  data: Record<string, unknown>;
}

interface SearchIndex {
  domain: string;
  field: string;
}

class SearchService {
  private indices: SearchIndex[] = [];
  private documents: Map<string, Record<string, unknown>> = new Map();

  registerIndex(domain: string, field: string): void {
    this.indices.push({ domain, field });
  }

  async index(domain: string, id: string, data: Record<string, unknown>): Promise<void> {
    this.documents.set(`${domain}:${id}`, data);
    console.log(`[Search] Indexed ${domain}/${id}`);
  }

  async search(domain: string, query: string): Promise<SearchResult[]> {
    const results: SearchResult[] = [];
    const q = query.toLowerCase();

    for (const [key, data] of this.documents) {
      const [docDomain] = key.split(':');
      if (domain !== docDomain) continue;

      const searchable = Object.values(data).join(' ').toLowerCase();
      if (searchable.includes(q)) {
        results.push({
          id: key.split(':')[1],
          score: 1,
          domain,
          data,
        });
      }
    }

    return results.sort((a, b) => b.score - a.score);
  }

  async remove(domain: string, id: string): Promise<void> {
    this.documents.delete(`${domain}:${id}`);
  }
}

export const searchService = new SearchService();
