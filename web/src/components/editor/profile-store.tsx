"use client";

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useReducer,
  useRef,
  type ReactNode,
} from "react";
import { api, toBlock, toProfile } from "@/lib/api/client";
import {
  ApiError,
  type Block,
  type CacheDimension,
  type Profile,
} from "@/lib/api/types";
import type { BlockRule } from "@/lib/rules/schema";
import { byRank, rankBetween } from "@/lib/rank";

/**
 * One store for the whole editor.
 *
 * The thing it exists to get right: every mutation carries the profile version
 * as If-Match and every response carries the new version and the new cache
 * mask. A block edit bumps the profile version server-side, and if the client
 * kept editing against the old one it would write against a mask that no
 * longer describes the page — which fails silently rather than loudly. So the
 * store treats version and cacheDimensions as things only the server may set,
 * and a stale If-Match stops writes until the creator reloads rather than
 * retrying.
 */

interface State {
  profile: Profile;
  /** Ids with a write in flight, for per-row disabled state. */
  pending: Set<string>;
  /** Set on a stale If-Match. Every further write is blocked while this is true. */
  conflict: boolean;
  error: string | null;
}

type Action =
  | { type: "apply"; version: number; cacheDimensions: CacheDimension[] }
  | { type: "replace"; profile: Profile }
  /**
   * Undoing an optimistic edit, which is a different thing from applying a
   * server answer.
   *
   * They used to share `"replace"`, and `"replace"` cleared `conflict` — so
   * `updateProfileFields` set the lock on a 409 and then immediately cleared it
   * again by rolling back, and the banner never appeared for a profile edit.
   * Only `"loaded"` clears the lock now, because reloading is the only thing
   * that actually resolves one.
   */
  | { type: "rollback"; profile: Profile }
  | { type: "loaded"; profile: Profile }
  | { type: "blocks"; blocks: Block[] }
  | { type: "upsertBlock"; block: Block }
  | { type: "removeBlock"; id: string }
  | { type: "pending"; id: string; on: boolean }
  | { type: "conflict" }
  | { type: "error"; message: string | null };

export function reducer(state: State, action: Action): State {
  switch (action.type) {
    case "apply":
      return {
        ...state,
        profile: {
          ...state.profile,
          version: action.version,
          cacheDimensions: action.cacheDimensions,
        },
      };
    case "replace":
      return { ...state, profile: action.profile, error: null };
    case "rollback":
      return { ...state, profile: action.profile };
    case "loaded":
      return { ...state, profile: action.profile, conflict: false, error: null };
    case "blocks":
      return { ...state, profile: { ...state.profile, blocks: action.blocks } };
    case "upsertBlock": {
      const exists = state.profile.blocks.some((b) => b.id === action.block.id);
      const blocks = exists
        ? state.profile.blocks.map((b) => (b.id === action.block.id ? action.block : b))
        : [...state.profile.blocks, action.block];
      return { ...state, profile: { ...state.profile, blocks: blocks.sort(byRank) } };
    }
    case "removeBlock":
      return {
        ...state,
        profile: {
          ...state.profile,
          blocks: state.profile.blocks.filter((b) => b.id !== action.id),
        },
      };
    case "pending": {
      const pending = new Set(state.pending);
      if (action.on) pending.add(action.id);
      else pending.delete(action.id);
      return { ...state, pending };
    }
    case "conflict":
      return { ...state, conflict: true };
    case "error":
      return { ...state, error: action.message };
  }
}

/**
 * A completed write, tagged.
 *
 * `null` used to mean "it failed", which made a successful DELETE — 204, no
 * body — indistinguishable from an error, and the editor rolled the row back
 * in front of the creator while the server had in fact deleted it. Success and
 * the value are now separate facts.
 */
type Guarded<T> = { ok: true; value: T } | { ok: false };

export interface ProfileOps {
  updateProfileFields(
    patch: Partial<
      Pick<Profile, "displayName" | "bio" | "avatarUrl" | "mode" | "eventAt">
    > & { theme?: Partial<Profile["theme"]> },
  ): Promise<void>;
  claimHandle(handle: string): Promise<void>;
  reorder(blockId: string, toIndex: number): Promise<void>;
  createBlock(input: Pick<Block, "kind" | "label"> & Partial<Block>): Promise<void>;
  updateBlock(blockId: string, patch: Partial<Block>): Promise<void>;
  deleteBlock(blockId: string): Promise<void>;
  /** Replaces the block's whole rule set. Returns false if the write did not land. */
  saveBlockRules(blockId: string, rules: BlockRule[]): Promise<boolean>;
  publish(): Promise<void>;
  reload(): Promise<void>;
  dismissError(): void;
}

const Ctx = createContext<{ state: State; ops: ProfileOps } | null>(null);

export function ProfileProvider({
  initial,
  children,
}: {
  initial: Profile;
  children: ReactNode;
}) {
  const [state, dispatch] = useReducer(reducer, {
    profile: { ...initial, blocks: [...initial.blocks].sort(byRank) },
    pending: new Set<string>(),
    conflict: false,
    error: null,
  });

  /**
   * The authoritative profile version, written by the code that dispatches
   * rather than by render.
   *
   * It used to be `ref.current = state` during render, which is only fresh
   * once React has re-rendered. Two writes issued from the same async
   * continuation — the block sheet saves a label and then its rules — both read
   * the version from before the first one, so the second arrived with a stale
   * If-Match and came back 409 every time. Keeping just the version, updated
   * the moment a response carries a new one, means the second write sees what
   * the first one earned.
   */
  const versionRef = useRef(initial.version);
  const conflictRef = useRef(false);
  const blocksRef = useRef(state.profile.blocks);
  const profileRef = useRef(state.profile);
  profileRef.current = state.profile;
  blocksRef.current = state.profile.blocks;

  const applyVersion = useCallback((version: number, cacheDimensions: CacheDimension[]) => {
    versionRef.current = version;
    dispatch({ type: "apply", version, cacheDimensions });
  }, []);

  const guard = useCallback(
    async <T,>(id: string, run: (version: number) => Promise<T>): Promise<Guarded<T>> => {
      if (conflictRef.current) return { ok: false };
      dispatch({ type: "pending", id, on: true });
      try {
        return { ok: true, value: await run(versionRef.current) };
      } catch (err) {
        if (err instanceof ApiError && err.isVersionConflict) {
          conflictRef.current = true;
          // The server tells us what it holds, so the banner's reload is a read
          // rather than a guess.
          if (err.current !== null) versionRef.current = err.current;
          dispatch({ type: "conflict" });
        } else if (err instanceof ApiError && err.isUnauthorized) {
          window.location.href = "/login?error=expired";
        } else {
          dispatch({
            type: "error",
            message: err instanceof Error ? err.message : "That didn't save.",
          });
        }
        return { ok: false };
      } finally {
        dispatch({ type: "pending", id, on: false });
      }
    },
    [],
  );

  const ops = useMemo<ProfileOps>(() => {
    const pid = initial.id;

    /** A profile envelope carries the profile alone; the blocks we hold are still ours. */
    const withBlocks = (data: Parameters<typeof toProfile>[0], dims: CacheDimension[]): Profile => ({
      ...toProfile(data, [], dims),
      blocks: profileRef.current.blocks,
    });

    const reload = async () => {
      try {
        const fresh = await api.profile(pid);
        versionRef.current = fresh.version;
        conflictRef.current = false;
        dispatch({ type: "loaded", profile: { ...fresh, blocks: [...fresh.blocks].sort(byRank) } });
      } catch (err) {
        if (err instanceof ApiError && err.isUnauthorized) {
          window.location.href = "/login?error=expired";
        }
      }
    };

    return {
      async updateProfileFields(patch) {
        const previous = profileRef.current;
        dispatch({
          type: "replace",
          profile: {
            ...previous,
            ...patch,
            theme: patch.theme ? { ...previous.theme, ...patch.theme } : previous.theme,
          },
        });
        const res = await guard("profile", (version) =>
          api.updateProfile(pid, patch, { version }),
        );
        if (!res.ok) {
          dispatch({ type: "rollback", profile: previous });
          return;
        }
        dispatch({
          type: "replace",
          profile: withBlocks(res.value.data, res.value.cacheDimensions),
        });
        applyVersion(res.value.version, res.value.cacheDimensions);
      },

      async claimHandle(handle) {
        const res = await guard("handle", (version) =>
          api.claimHandle(pid, handle, { version }),
        );
        if (!res.ok) return;
        dispatch({
          type: "replace",
          profile: withBlocks(res.value.data, res.value.cacheDimensions),
        });
        applyVersion(res.value.version, res.value.cacheDimensions);
      },

      async reorder(blockId, toIndex) {
        const current = blocksRef.current;
        const from = current.findIndex((b) => b.id === blockId);
        if (from === -1 || from === toIndex) return;

        const moved = current[from]!;
        const without = current.filter((b) => b.id !== blockId);
        const after = toIndex > 0 ? without[toIndex - 1] ?? null : null;
        const before = without[toIndex] ?? null;

        // Optimistic rank so the list stays sorted while the write is in
        // flight. Thrown away the moment the server answers — it mints the
        // real key and may rebalance neighbours in the process.
        let optimistic = moved.rank;
        try {
          optimistic = rankBetween(after?.rank ?? null, before?.rank ?? null);
        } catch {
          /* Gap too small to split. The server will rebalance; order still
             shows correctly because we splice the array directly. */
        }
        const next = [...without];
        next.splice(toIndex, 0, { ...moved, rank: optimistic });
        dispatch({ type: "blocks", blocks: next });

        const res = await guard(blockId, (version) =>
          api.moveBlock(
            pid,
            blockId,
            { afterId: after?.id ?? null, beforeId: before?.id ?? null },
            { version },
          ),
        );

        if (!res.ok) {
          dispatch({ type: "blocks", blocks: current });
          return;
        }
        const placed = toBlock(res.value.data);
        dispatch({
          type: "blocks",
          blocks: next.map((b) => (b.id === blockId ? placed : b)).sort(byRank),
        });
        applyVersion(res.value.version, res.value.cacheDimensions);
      },

      async createBlock(input) {
        const res = await guard("new", (version) => api.createBlock(pid, input, { version }));
        if (!res.ok) return;
        dispatch({ type: "upsertBlock", block: toBlock(res.value.data) });
        applyVersion(res.value.version, res.value.cacheDimensions);
      },

      async updateBlock(blockId, patch) {
        const previous = blocksRef.current.find((b) => b.id === blockId);
        if (previous) dispatch({ type: "upsertBlock", block: { ...previous, ...patch } });

        const res = await guard(blockId, (version) =>
          api.updateBlock(pid, blockId, patch, { version }),
        );
        if (!res.ok) {
          if (previous) dispatch({ type: "upsertBlock", block: previous });
          return;
        }
        dispatch({ type: "upsertBlock", block: toBlock(res.value.data) });
        applyVersion(res.value.version, res.value.cacheDimensions);
      },

      async deleteBlock(blockId) {
        const previous = blocksRef.current;
        dispatch({ type: "removeBlock", id: blockId });
        const res = await guard(blockId, (version) =>
          api.deleteBlock(pid, blockId, { version }),
        );
        if (!res.ok) {
          dispatch({ type: "blocks", blocks: previous });
          return;
        }
        // 204, so there is no envelope to read a version from — but the delete
        // went through the same gate every write does and bumped it. Guessing
        // +1 would be right until it wasn't, so re-read: the next write has to
        // carry a version the server will accept.
        await reload();
      },

      async saveBlockRules(blockId, rules) {
        const previous = blocksRef.current.find((b) => b.id === blockId);
        if (previous) dispatch({ type: "upsertBlock", block: { ...previous, rules } });

        const res = await guard(`${blockId}:rules`, (version) =>
          api.saveBlockRules(pid, blockId, rules, { version }),
        );
        if (!res.ok) {
          if (previous) dispatch({ type: "upsertBlock", block: previous });
          return false;
        }
        dispatch({ type: "upsertBlock", block: toBlock(res.value.data) });
        applyVersion(res.value.version, res.value.cacheDimensions);
        return true;
      },

      async publish() {
        const res = await guard("publish", (version) => api.publish(pid, { version }));
        if (!res.ok) return;
        dispatch({
          type: "replace",
          profile: withBlocks(res.value.data, res.value.cacheDimensions),
        });
        applyVersion(res.value.version, res.value.cacheDimensions);
      },

      reload,

      dismissError() {
        dispatch({ type: "error", message: null });
      },
    };
  }, [applyVersion, guard, initial.id]);

  return <Ctx.Provider value={{ state, ops }}>{children}</Ctx.Provider>;
}

export function useProfile() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useProfile must be used inside ProfileProvider");
  return ctx;
}

/**
 * A block's rules, in the order the evaluator runs them: lowest priority first,
 * ties broken by id so two rules at the same priority cannot swap places
 * between renders. `pick` in api/src/rules/rules.ts sorts exactly this way.
 */
export function orderedRules(rules: BlockRule[]): BlockRule[] {
  return [...rules].sort((a, b) => a.priority - b.priority || (a.id < b.id ? -1 : 1));
}
