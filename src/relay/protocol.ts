import { z } from "zod";

const MAX_CONTROL_TEXT_BYTES = 16 * 1024;
const MAX_FRAME_BYTES = 24 * 1024;
const MAX_IDENTIFIER_LENGTH = 256;
const WORKSPACE_ID_PATTERN = /^ws_[a-f0-9]{16}$/;

const WorkspaceIdSchema = z.string().regex(WORKSPACE_ID_PATTERN, "INVALID_WORKSPACE_ID");
const BoundedIdentifierSchema = z.string().min(1).max(MAX_IDENTIFIER_LENGTH);
const ControlTextSchema = z.string().superRefine((value, context) => {
  if (Buffer.byteLength(value, "utf8") > MAX_CONTROL_TEXT_BYTES) {
    context.addIssue({
      code: "custom",
      message: "CONTROL_TEXT_TOO_LARGE",
    });
  }
});

const RelayClientFrameSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("hello"),
    workspace_id: WorkspaceIdSchema,
    token: z.string().min(1).max(MAX_IDENTIFIER_LENGTH),
    extension_id: BoundedIdentifierSchema,
  }),
  z.strictObject({
    type: z.literal("keepalive"),
    workspace_id: WorkspaceIdSchema,
    at: z.string().datetime(),
  }),
  z.strictObject({
    type: z.literal("outbound_sent"),
    workspace_id: WorkspaceIdSchema,
    envelope_id: BoundedIdentifierSchema,
  }),
  z.strictObject({
    type: z.literal("assistant_control"),
    workspace_id: WorkspaceIdSchema,
    text: ControlTextSchema,
    fingerprint: BoundedIdentifierSchema,
  }),
  z.strictObject({
    type: z.literal("tab_heartbeat"),
    workspace_id: WorkspaceIdSchema,
    conversation_id: z.string().min(1).max(2048),
  }),
]);

const RelayServerFrameSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("hello_ok"),
    workspace_id: WorkspaceIdSchema,
    server_time: z.string().datetime(),
  }),
  z.strictObject({
    type: z.literal("outbound_control"),
    workspace_id: WorkspaceIdSchema,
    envelope_id: BoundedIdentifierSchema,
    text: ControlTextSchema,
  }),
  z.strictObject({
    type: z.literal("assistant_ingested"),
    workspace_id: WorkspaceIdSchema,
    fingerprint: BoundedIdentifierSchema,
  }),
  z.strictObject({
    type: z.literal("relay_error"),
    code: BoundedIdentifierSchema,
    detail: z.string().max(16 * 1024),
  }),
]);

export const RelayFrameSchema = z.union([RelayClientFrameSchema, RelayServerFrameSchema]);

export type RelayClientFrame = z.infer<typeof RelayClientFrameSchema>;
export type RelayServerFrame = z.infer<typeof RelayServerFrameSchema>;
export type RelayFrame = z.infer<typeof RelayFrameSchema>;

function assertFrameSize(text: string): void {
  if (Buffer.byteLength(text, "utf8") > MAX_FRAME_BYTES) {
    throw new Error("RELAY_FRAME_TOO_LARGE");
  }
}

export function parseRelayFrame(text: string): RelayFrame {
  assertFrameSize(text);
  return RelayFrameSchema.parse(JSON.parse(text) as unknown);
}

export function serializeRelayFrame(frame: RelayFrame): string {
  const validated = RelayFrameSchema.parse(frame);
  const text = JSON.stringify(validated);
  assertFrameSize(text);
  return text;
}

export {
  MAX_CONTROL_TEXT_BYTES,
  MAX_FRAME_BYTES,
};
