import { cosineDistance, l2Normalize } from '../vector.js';

interface NeighborHit {
  id: number;
  dist: number;
}

/**
 * Small in-process HNSW (Malkov & Yashunin) for offline ANN.
 * Graphs are per tenant. Swap the KnowledgeEngine index for pgvector or
 * Qdrant without changing the MemoryService API.
 */
export class HnswIndex {
  private readonly vectors: Float32Array[] = [];
  private readonly neighbors: number[][][] = [];
  private readonly levels: number[] = [];
  private entryId = -1;
  private maxLevel = 0;
  private readonly m0: number;

  constructor(
    private readonly m = 16,
    private readonly efConstruction = 64,
    private readonly efSearch = 64,
    private readonly random: () => number = Math.random,
  ) {
    this.m0 = m * 2;
  }

  get size(): number {
    return this.vectors.length;
  }

  add(vector: Float32Array): number {
    const point = l2Normalize(vector);
    const id = this.vectors.length;
    const level = id === 0 ? 0 : this.randomLevel();
    const links: number[][] = [];
    for (let layer = 0; layer <= level; layer++) links.push([]);
    this.vectors.push(point);
    this.neighbors.push(links);
    this.levels.push(level);

    if (this.entryId === -1) {
      this.entryId = id;
      this.maxLevel = level;
      return id;
    }

    let entry = this.entryId;
    for (let layer = this.maxLevel; layer > level; layer--) {
      const nearest = this.searchLayer(point, entry, 1, layer);
      const first = nearest[0];
      if (first) entry = first.id;
    }

    const limit = Math.min(this.maxLevel, level);
    for (let layer = limit; layer >= 0; layer--) {
      const nearest = this.searchLayer(point, entry, this.efConstruction, layer);
      const cap = layer === 0 ? this.m0 : this.m;
      const selected = nearest.slice(0, cap);
      for (const neighbor of selected) {
        this.connect(id, neighbor.id, layer);
        this.prune(neighbor.id, layer, cap, id);
      }
      const closest = nearest[0];
      if (closest) entry = closest.id;
    }

    if (level > this.maxLevel) {
      this.maxLevel = level;
      this.entryId = id;
    }
    return id;
  }

  search(query: Float32Array, k: number, ef = this.efSearch): Array<{ id: number; distance: number }> {
    if (this.entryId < 0 || k <= 0) return [];
    const point = l2Normalize(query);
    let entry = this.entryId;
    for (let layer = this.maxLevel; layer > 0; layer--) {
      const nearest = this.searchLayer(point, entry, 1, layer);
      const first = nearest[0];
      if (first) entry = first.id;
    }
    const found = this.searchLayer(point, entry, Math.max(ef, k), 0);
    return found.slice(0, k).map((hit) => ({ id: hit.id, distance: hit.dist }));
  }

  private randomLevel(): number {
    let level = 0;
    const max = 16;
    while (level < max && this.random() < 1 / this.m) level++;
    return level;
  }

  private connect(left: number, right: number, layer: number): void {
    if (left === right) return;
    const a = this.ensureLayer(left, layer);
    const b = this.ensureLayer(right, layer);
    if (!a.includes(right)) a.push(right);
    if (!b.includes(left)) b.push(left);
  }

  private ensureLayer(id: number, layer: number): number[] {
    const links = this.neighbors[id];
    if (!links) throw new Error(`missing hnsw node ${id}`);
    while (links.length <= layer) links.push([]);
    const list = links[layer];
    if (!list) throw new Error(`missing hnsw layer ${layer}`);
    return list;
  }

  private prune(id: number, layer: number, cap: number, protect?: number): void {
    const list = this.neighbors[id]?.[layer];
    if (!list || list.length <= cap) return;
    const origin = this.vectors[id];
    if (!origin) return;
    const scored = list.map((other) => ({
      id: other,
      dist: cosineDistance(origin, this.vectors[other] ?? origin),
    }));
    scored.sort((a, b) => a.dist - b.dist || a.id - b.id);
    let kept = scored.slice(0, cap).map((item) => item.id);
    if (protect !== undefined && list.includes(protect) && !kept.includes(protect)) {
      kept = kept.slice(0, Math.max(0, cap - 1));
      kept.push(protect);
    }
    const links = this.neighbors[id];
    if (links) links[layer] = kept;
  }

  private searchLayer(query: Float32Array, entry: number, ef: number, layer: number): NeighborHit[] {
    const visited = new Set<number>([entry]);
    const entryVector = this.vectors[entry];
    if (!entryVector) return [];
    const entryDist = cosineDistance(query, entryVector);
    const candidates = new MinHeap<NeighborHit>((a, b) => a.dist < b.dist || (a.dist === b.dist && a.id < b.id));
    const found = new MinHeap<NeighborHit>((a, b) => a.dist > b.dist || (a.dist === b.dist && a.id > b.id));
    candidates.push({ id: entry, dist: entryDist });
    found.push({ id: entry, dist: entryDist });

    while (candidates.size > 0) {
      const current = candidates.pop();
      const furthest = found.peek();
      if (!current || !furthest) break;
      if (found.size >= ef && current.dist > furthest.dist) break;
      const list = this.neighbors[current.id]?.[layer] ?? [];
      for (const neighborId of list) {
        if (visited.has(neighborId)) continue;
        visited.add(neighborId);
        const vector = this.vectors[neighborId];
        if (!vector) continue;
        const dist = cosineDistance(query, vector);
        const worst = found.peek();
        if (!worst) continue;
        if (found.size < ef || dist <= worst.dist) {
          candidates.push({ id: neighborId, dist });
          found.push({ id: neighborId, dist });
          if (found.size > ef) found.pop();
        }
      }
    }

    const out: NeighborHit[] = [];
    while (found.size > 0) {
      const item = found.pop();
      if (item) out.push(item);
    }
    out.sort((a, b) => a.dist - b.dist || a.id - b.id);
    return out;
  }
}

class MinHeap<T> {
  private readonly data: T[] = [];

  constructor(private readonly less: (a: T, b: T) => boolean) {}

  get size(): number {
    return this.data.length;
  }

  peek(): T | undefined {
    return this.data[0];
  }

  push(item: T): void {
    const data = this.data;
    data.push(item);
    let index = data.length - 1;
    while (index > 0) {
      const parent = (index - 1) >> 1;
      const current = data[index];
      const parentItem = data[parent];
      if (current === undefined || parentItem === undefined || !this.less(current, parentItem)) break;
      data[index] = parentItem;
      data[parent] = current;
      index = parent;
    }
  }

  pop(): T | undefined {
    const data = this.data;
    if (data.length === 0) return undefined;
    const top = data[0];
    const last = data.pop();
    if (data.length > 0 && last !== undefined) {
      data[0] = last;
      let index = 0;
      for (;;) {
        const left = index * 2 + 1;
        const right = left + 1;
        let best = index;
        const leftItem = data[left];
        const rightItem = data[right];
        if (leftItem !== undefined && this.less(leftItem, data[best]!)) best = left;
        if (rightItem !== undefined && this.less(rightItem, data[best]!)) best = right;
        if (best === index) break;
        const tmp = data[index]!;
        data[index] = data[best]!;
        data[best] = tmp;
        index = best;
      }
    }
    return top;
  }
}
