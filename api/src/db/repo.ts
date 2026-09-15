import type { Block, DailyStat, Profile } from '../domain/types.ts';
import type { TClickEvent } from '../domain/schema.ts';

export type CreateProfileInput = Omit<Profile, 'id' | 'version' | 'createdAt' | 'updatedAt'>;

/**
 * Every persistence operation the API performs. Two implementations exist:
 * `DynamoRepo` for production and `MemoryRepo` for tests. Keeping the surface
 * this narrow is what lets the route layer stay free of key-encoding details.
 */
export interface Repo {
  /** Atomically claims the handle and writes the profile, or throws ConflictError. */
  createProfile(input: CreateProfileInput): Promise<Profile>;
  getProfile(id: string): Promise<Profile | null>;
  getProfileByHandle(handle: string): Promise<Profile | null>;
  listProfiles(userId: string): Promise<Profile[]>;
  updateProfile(id: string, patch: Partial<Profile>): Promise<Profile>;
  /** Transactionally releases the old handle and claims the new one. */
  claimHandle(profileId: string, oldHandle: string, newHandle: string): Promise<Profile>;
  deleteProfile(id: string): Promise<void>;

  listBlocks(profileId: string): Promise<Block[]>;
  getBlock(profileId: string, blockId: string): Promise<Block | null>;
  putBlock(block: Block): Promise<Block>;
  updateBlock(profileId: string, blockId: string, patch: Partial<Block>): Promise<Block>;
  /** Rank lives in the sort key, so a move is a delete plus a put in one transaction. */
  moveBlock(profileId: string, blockId: string, newRank: string): Promise<Block>;
  deleteBlock(profileId: string, blockId: string): Promise<void>;

  recordEvents(events: TClickEvent[], profileId: string): Promise<void>;
  getDaily(profileId: string, from: string, to: string): Promise<DailyStat[]>;
  getBlockTotals(profileId: string): Promise<Record<string, number>>;

  /** Feed blocks due for a refresh, from one shard of the sparse GSI2 index. */
  dueForRefresh(shard: number, now: number, limit: number): Promise<Block[]>;
}

export class ConflictError extends Error {}
export class NotFoundError extends Error {}
