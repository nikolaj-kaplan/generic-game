/**
 * The text a model receives for one bridge request: the system prompt, every
 * message and the reply format. Shared by bridge-show (for a human) and
 * bridge-claude (piped into a headless Claude).
 */

export interface BridgeRequest {
  messages: Array<{ role: string; content: string | null }>;
  response_format?: { json_schema?: { name?: string; schema?: { properties?: Record<string, any>; required?: string[] } } };
}

export function schemaName(request: BridgeRequest): string {
  return request.response_format?.json_schema?.name ?? 'chat';
}

export function formatRequest(id: string, request: BridgeRequest, replyFile: string): string {
  const lines = [`ID: ${id}   schema: ${schemaName(request)}`];
  for (const m of request.messages) {
    lines.push(`\n===== ${m.role.toUpperCase()} =====\n${m.content ?? ''}`);
  }
  if (schemaName(request) !== 'chat') {
    const schema = request.response_format?.json_schema?.schema ?? {};
    const props = Object.keys(schema.properties ?? {});
    const screens = schema.properties?.screens?.properties;
    lines.push(`\n===== REPLY FORMAT =====\nA JSON object. Fields: ${props.join(', ')}. Required: ${(schema.required ?? []).join(', ')}.`);
    if (screens) lines.push(`Allowed screen keys: ${Object.keys(screens).join(', ')}`);
  }
  lines.push(`\nWrite the reply to: ${replyFile}`);
  return lines.join('\n');
}
