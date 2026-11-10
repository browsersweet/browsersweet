import { z } from 'zod';
import {
  MAX_ARGUMENTS_BYTES,
  MAX_INPUT_SCHEMA_BYTES,
  MAX_TOOLS,
} from './constants.js';
import { jsonByteLength } from './common.js';

/** MCP-safe tool names: snake_case (the registry's `toMcpToolName`). */
export const ToolName = z
  .string()
  .regex(/^[a-z][a-z0-9_]{0,63}$/, 'tool names are snake_case, ≤ 64 chars');

/** A JSON Schema for tool input. Must describe an object. */
export const ToolInputSchema = z
  .record(z.string(), z.unknown())
  .refine((schema) => schema['type'] === 'object', {
    message: 'inputSchema.type must be "object"',
  })
  .refine((schema) => jsonByteLength(schema) <= MAX_INPUT_SCHEMA_BYTES, {
    message: `inputSchema is larger than ${MAX_INPUT_SCHEMA_BYTES} bytes`,
  });

export const ToolAnnotations = z.object({
  readOnlyHint: z.boolean().optional(),
  destructiveHint: z.boolean().optional(),
  idempotentHint: z.boolean().optional(),
  openWorldHint: z.boolean().optional(),
  /** Results contain web-page content. The client labels every part untrusted. */
  untrustedOutput: z.boolean().optional(),
});

/** One tool, as the extension's registry generates it (D20). */
export const ToolDescriptor = z.object({
  name: ToolName,
  title: z.string().max(200).optional(),
  description: z.string().max(4096),
  inputSchema: ToolInputSchema,
  annotations: ToolAnnotations.optional(),
});
export type ToolDescriptor = z.infer<typeof ToolDescriptor>;

export const ToolDescriptorList = z.array(ToolDescriptor).max(MAX_TOOLS);

/** Where untrusted text came from, shown in the label. */
export const ContentSource = z.object({
  url: z.string().max(8192).optional(),
  title: z.string().max(1024).optional(),
  tabId: z.int().optional(),
});

export const TextPart = z.object({
  type: z.literal('text'),
  text: z.string(),
  /** Web-page content (page text, selections). The client wraps it with an untrusted label. */
  untrusted: z.boolean().optional(),
  source: ContentSource.optional(),
});
export type TextPart = z.infer<typeof TextPart>;

export const IMAGE_MIME_TYPES = ['image/png', 'image/jpeg'] as const;

/**
 * An image (e.g. a capture handoff). Rendered as MCP image content. Big images make big
 * messages: send them with `encodeForWire`, which chunks anything over the native message cap.
 */
export const ImagePart = z.object({
  type: z.literal('image'),
  mimeType: z.enum(IMAGE_MIME_TYPES),
  /** Base64, standard alphabet, padded. */
  data: z
    .string()
    .min(1)
    .regex(/^[A-Za-z0-9+/]+={0,2}$/, 'image data must be base64'),
  /** Comes from a web page (a capture). The client labels it untrusted. */
  untrusted: z.boolean().optional(),
  source: ContentSource.optional(),
});
export type ImagePart = z.infer<typeof ImagePart>;

/** Content part types this version understands. */
export const CONTENT_PART_TYPES: readonly string[] = ['text', 'image'];

/**
 * A part of a type this version doesn't know, from a newer extension. Accepted and skipped, so
 * adding a part type later isn't a breaking change. Known types must match their own schema.
 */
export const UnknownContentPart = z
  .looseObject({
    type: z.string().regex(/^[a-z][a-z0-9_.-]{0,63}$/),
  })
  .refine((part) => !CONTENT_PART_TYPES.includes(part.type), {
    message: 'invalid content part',
  });

export const ContentPart = z.union([TextPart, ImagePart, UnknownContentPart]);
export type ContentPart = z.infer<typeof ContentPart>;

export function isTextPart(part: ContentPart): part is TextPart {
  return part.type === 'text';
}

export function isImagePart(part: ContentPart): part is ImagePart {
  return part.type === 'image';
}

/**
 * A tool result. `data` is the structured answer (see `workspace.ts` for the v1 shapes); the
 * client renders it as JSON text. `content` carries free text (notably untrusted page text) and
 * images.
 */
export const ToolResult = z.object({
  content: z.array(ContentPart).max(256).optional(),
  data: z.unknown().optional(),
});
export type ToolResult = z.infer<typeof ToolResult>;

/** Arguments with a size cap. */
export const BoundedToolArguments = z
  .record(z.string(), z.unknown())
  .refine((args) => jsonByteLength(args) <= MAX_ARGUMENTS_BYTES, {
    message: `arguments are larger than ${MAX_ARGUMENTS_BYTES} bytes`,
  });

/** The v1 read tools (plan §5.15). The extension generates their descriptors from its registry. */
export const V1_READ_TOOLS = [
  'list_spaces',
  'get_kept_tree',
  'list_tabs',
  'get_active_tab',
  'search_archive',
  'get_handoffs',
  'get_page_text',
] as const;
export type V1ReadTool = (typeof V1_READ_TOOLS)[number];

/**
 * Tools whose output is always labeled untrusted, whatever the extension says: page text, and
 * handoffs (selections and captures come from pages).
 */
export const ALWAYS_UNTRUSTED_TOOLS: readonly string[] = [
  'get_page_text',
  'get_handoffs',
];

/** Names the client defines itself. Extension tools with these names are ignored. */
export const RESERVED_TOOL_NAMES: readonly string[] = ['list_browser_profiles'];

/** The argument the client adds to every tool to pick a browser profile. */
export const PROFILE_ARGUMENT = 'profile';
