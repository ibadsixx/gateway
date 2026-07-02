"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.searchService = void 0;
class SearchService {
    indices = [];
    documents = new Map();
    registerIndex(domain, field) {
        this.indices.push({ domain, field });
    }
    async index(domain, id, data) {
        this.documents.set(`${domain}:${id}`, data);
        console.log(`[Search] Indexed ${domain}/${id}`);
    }
    async search(domain, query) {
        const results = [];
        const q = query.toLowerCase();
        for (const [key, data] of this.documents) {
            const [docDomain] = key.split(':');
            if (domain !== docDomain)
                continue;
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
    async remove(domain, id) {
        this.documents.delete(`${domain}:${id}`);
    }
}
exports.searchService = new SearchService();
//# sourceMappingURL=index.js.map