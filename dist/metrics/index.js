"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.metricsService = void 0;
class MetricsService {
    points = [];
    counters = new Map();
    histograms = new Map();
    increment(counter, labels = {}) {
        const key = `${counter}:${JSON.stringify(labels)}`;
        this.counters.set(key, (this.counters.get(key) || 0) + 1);
        this.record(counter, this.counters.get(key), labels);
    }
    record(name, value, labels = {}) {
        this.points.push({ name, value, labels, timestamp: new Date() });
        const histKey = `${name}:${JSON.stringify(labels)}`;
        if (!this.histograms.has(histKey)) {
            this.histograms.set(histKey, []);
        }
        this.histograms.get(histKey).push(value);
        const maxPoints = 10000;
        if (this.points.length > maxPoints) {
            this.points.splice(0, this.points.length - maxPoints);
        }
    }
    getCounter(name, labels = {}) {
        const key = `${name}:${JSON.stringify(labels)}`;
        return this.counters.get(key) || 0;
    }
    getAverage(name, labels = {}) {
        const key = `${name}:${JSON.stringify(labels)}`;
        const values = this.histograms.get(key);
        if (!values || values.length === 0)
            return 0;
        return values.reduce((a, b) => a + b, 0) / values.length;
    }
    getSnapshot() {
        return {
            counters: Object.fromEntries(this.counters),
            points: this.points.slice(-1000),
        };
    }
}
exports.metricsService = new MetricsService();
//# sourceMappingURL=index.js.map