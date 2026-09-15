import type { Block, DailyStat, Profile } from '../domain/types.ts';
import type { TClickEvent } from '../domain/schema.ts';
import { ConflictError, NotFoundError, type CreateProfileInput, type Repo } from './repo.ts';
import { newId } from '../ids.ts';

/**
 * Mirrors the DynamoDB implementation's semantics — same conflict conditions,
 * same sort ordering, same transactional grouping — without needing a running
 * database. Ordering is derived from the same `BLOCK#<rank>#<id>` sort key.
 */
export class MemoryRepo implements Repo {
  profiles = new Map<string, Profile>();
  handles = new Map<string, string>();
  blocks = new Map<string, Block>();
  daily = new Map<string, DailyStat>();
  totals = new Map<string, Record<string, number>>();

  private bk = (p: string, b: string) => `${p}|${b}`;

  async createProfile(input: CreateProfileInput): Promise<Profile> {
    const h = input.handle.toLowerCase();
    if (this.handles.has(h)) throw new ConflictError(`handle ${h} is taken`);
    const now = Date.now();
    const p: Profile = { ...input, handle: h, id: newId('prof'), version: 1, createdAt: now, updatedAt: now };
    this.profiles.set(p.id, p);
    this.handles.set(h, p.id);
    return p;
  }

  async getProfile(id: string) { return this.profiles.get(id) ?? null; }

  async getProfileByHandle(handle: string) {
    const id = this.handles.get(handle.toLowerCase());
    return id ? this.profiles.get(id) ?? null : null;
  }

  async listProfiles(userId: string) {
    return [...this.profiles.values()]
      .filter((p) => p.userId === userId)
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  async updateProfile(id: string, patch: Partial<Profile>) {
    const p = this.profiles.get(id);
    if (!p) throw new NotFoundError(id);
    const next = { ...p, ...patch, id: p.id, version: p.version + 1, updatedAt: Date.now() };
    this.profiles.set(id, next);
    return next;
  }

  async claimHandle(profileId: string, oldHandle: string, newHandle: string) {
    const h = newHandle.toLowerCase();
    const holder = this.handles.get(h);
    if (holder && holder !== profileId) throw new ConflictError(`handle ${h} is taken`);
    this.handles.delete(oldHandle.toLowerCase());
    this.handles.set(h, profileId);
    return this.updateProfile(profileId, { handle: h });
  }

  async deleteProfile(id: string) {
    const p = this.profiles.get(id);
    if (!p) return;
    this.handles.delete(p.handle);
    this.profiles.delete(id);
    for (const [k, b] of this.blocks) if (b.profileId === id) this.blocks.delete(k);
  }

  async listBlocks(profileId: string) {
    return [...this.blocks.values()]
      .filter((b) => b.profileId === profileId)
      .sort((a, b) => (`${a.rank}#${a.id}` < `${b.rank}#${b.id}` ? -1 : 1));
  }

  async getBlock(profileId: string, blockId: string) {
    return this.blocks.get(this.bk(profileId, blockId)) ?? null;
  }

  async putBlock(block: Block) {
    this.blocks.set(this.bk(block.profileId, block.id), block);
    return block;
  }

  async updateBlock(profileId: string, blockId: string, patch: Partial<Block>) {
    const b = this.blocks.get(this.bk(profileId, blockId));
    if (!b) throw new NotFoundError(blockId);
    const next = { ...b, ...patch, id: b.id, profileId: b.profileId, rank: b.rank, updatedAt: Date.now() };
    this.blocks.set(this.bk(profileId, blockId), next);
    return next;
  }

  async moveBlock(profileId: string, blockId: string, newRank: string) {
    return this.updateBlock(profileId, blockId, {}).then((b) => {
      const next = { ...b, rank: newRank, updatedAt: Date.now() };
      this.blocks.set(this.bk(profileId, blockId), next);
      return next;
    });
  }

  async deleteBlock(profileId: string, blockId: string) {
    this.blocks.delete(this.bk(profileId, blockId));
  }

  async recordEvents(events: TClickEvent[], profileId: string) {
    for (const e of events) {
      const date = new Date(e.ts).toISOString().slice(0, 10);
      const key = `${profileId}|${date}`;
      const d = this.daily.get(key) ?? { date, views: 0, clicks: 0, byBlock: {} };
      if (e.blockId) {
        d.clicks++;
        d.byBlock[e.blockId] = (d.byBlock[e.blockId] ?? 0) + 1;
        const t = this.totals.get(profileId) ?? {};
        t[e.blockId] = (t[e.blockId] ?? 0) + 1;
        this.totals.set(profileId, t);
      } else {
        d.views++;
      }
      this.daily.set(key, d);
    }
  }

  async getDaily(profileId: string, from: string, to: string) {
    return [...this.daily.entries()]
      .filter(([k]) => k.startsWith(`${profileId}|`))
      .map(([, v]) => v)
      .filter((d) => d.date >= from && d.date <= to)
      .sort((a, b) => (a.date < b.date ? -1 : 1));
  }

  async getBlockTotals(profileId: string) { return this.totals.get(profileId) ?? {}; }

  async dueForRefresh(_shard: number, now: number, limit: number) {
    return [...this.blocks.values()]
      .filter((b) => b.kind === 'feed')
      .filter((b) => (b.updatedAt + (b.feed?.ttlSeconds ?? 3600) * 1000) <= now)
      .slice(0, limit);
  }
}
