import { z } from 'zod';

/*
 * Wire shapes for the `data` of the v1 read tools (plan §5.15). The extension owns the tools'
 * input schemas (generated from its registry, D20); these are the agreed output shapes. The
 * client passes `data` through as JSON, so extra fields are fine; missing required ones are a
 * bug the extension's tests should catch with these schemas.
 */

const Id = z.string().min(1).max(128);
const Url = z.string().max(8192);
const EpochMs = z.number();

export const SpaceInfo = z.object({
  id: Id,
  name: z.string(),
  color: z.string().optional(),
  emoji: z.string().optional(),
  keptCount: z.int().min(0),
  /** Open tabs in the Space, kept and Today. */
  tabCount: z.int().min(0),
});
export type SpaceInfo = z.infer<typeof SpaceInfo>;

/** `list_spaces` → */
export const ListSpacesData = z.object({
  spaces: z.array(SpaceInfo),
  /** The Space shown in the last-focused normal window. */
  activeSpaceId: Id.optional(),
});

export interface KeptItemNode {
  type: 'item';
  id: string;
  title: string;
  /** Home URL. */
  url: string;
  /** Open as a tab right now. */
  open: boolean;
  tabId?: number;
}
export interface KeptFolderNode {
  type: 'folder';
  id: string;
  name: string;
  children: KeptNode[];
}
export type KeptNode = KeptItemNode | KeptFolderNode;

export const KeptItemNode = z.object({
  type: z.literal('item'),
  id: Id,
  title: z.string(),
  url: Url,
  open: z.boolean(),
  tabId: z.int().optional(),
});
export const KeptFolderNode: z.ZodType<KeptFolderNode> = z.object({
  type: z.literal('folder'),
  id: Id,
  name: z.string(),
  get children() {
    return z.array(KeptNode);
  },
});
export const KeptNode: z.ZodType<KeptNode> = z.union([
  KeptItemNode,
  KeptFolderNode,
]);

/** `get_kept_tree` (input: `{ spaceId? }`, default the active Space) → */
export const KeptTreeData = z.object({
  space: z.object({ id: Id, name: z.string() }),
  favorites: z.array(KeptItemNode),
  tree: z.array(KeptNode),
});

export const TabInfo = z.object({
  tabId: z.int(),
  windowId: z.int(),
  url: Url.optional(),
  /** Page-controlled text. */
  title: z.string().optional(),
  kind: z.enum(['kept', 'favorite', 'today']),
  spaceId: Id.optional(),
  active: z.boolean(),
  pinned: z.boolean().optional(),
  audible: z.boolean().optional(),
  discarded: z.boolean().optional(),
  /** Epoch ms the tab was opened (Today tabs). */
  openedAt: EpochMs.optional(),
  /** The user has granted site access, so `get_page_text` works on it. */
  siteAccess: z.boolean().optional(),
});
export type TabInfo = z.infer<typeof TabInfo>;

/** `list_tabs` (input: `{ spaceId?, windowId? }`) → */
export const ListTabsData = z.object({ tabs: z.array(TabInfo) });

/**
 * `get_active_tab` → the active tab in the focused profile's last-focused normal window, whether
 * or not the browser has focus (agents usually run in another app). `tab` is absent only when
 * the profile has no normal window.
 */
export const ActiveTabData = z.object({ tab: TabInfo.optional() });

export const ArchiveEntryInfo = z.object({
  id: Id,
  url: Url,
  title: z.string(),
  archivedAt: EpochMs,
  reason: z.enum(['idle', 'clear']),
  space: z.object({ id: Id, name: z.string() }).optional(),
});

/** `search_archive` (input: `{ query?, since?, until?, spaceId?, limit? }`) → newest first */
export const SearchArchiveData = z.object({
  entries: z.array(ArchiveEntryInfo),
  /** More matches exist beyond `limit`. */
  truncated: z.boolean().optional(),
});

export const HandoffInfo = z.object({
  id: Id,
  kind: z.enum(['tab', 'selection', 'capture', 'space', 'folder']),
  title: z.string(),
  createdAt: EpochMs,
  url: Url.optional(),
  /** Selection text (page content: the client labels the whole result untrusted). */
  text: z.string().optional(),
  /** For a Space/folder handoff. */
  items: z.array(z.object({ title: z.string(), url: Url })).optional(),
});

/** `get_handoffs` → */
export const HandoffsData = z.object({ handoffs: z.array(HandoffInfo) });

/**
 * `get_page_text` (input: `{ tabId? }`, default the active tab) → `data` is this metadata; the
 * text itself goes in a `content` part with `untrusted: true` and `source: { url, title, tabId }`.
 * Without site access the extension answers error `permission_required`.
 */
export const PageTextData = z.object({
  tabId: z.int(),
  url: Url.optional(),
  title: z.string().optional(),
  /** Characters of text returned. */
  length: z.int().min(0),
  /** The extension cut the text short. */
  truncated: z.boolean(),
});
