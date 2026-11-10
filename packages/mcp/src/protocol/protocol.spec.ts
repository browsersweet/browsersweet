import { describe, expect, it } from 'vitest';
import {
  ExtensionToHostMessage,
  HostToExtensionMessage,
  negotiateProtocol,
  parseMessage,
} from './native.js';
import { ClientToHostMessage, HostRecord } from './socket.js';
import { ToolDescriptor } from './tools.js';
import { KeptNode, ListSpacesData, PageTextData } from './workspace.js';

const hello = {
  type: 'hello',
  protocolVersion: 1,
  extension: { id: 'aaaabbbbccccddddeeeeffffgggghhhh', version: '1.0.0' },
  browser: { name: 'Chrome' },
  profile: { id: '01HZXK3', label: 'Work' },
};

describe('protocol validation', () => {
  it('accepts a hello and rejects malformed ones', () => {
    expect(ExtensionToHostMessage.safeParse(hello).success).toBe(true);
    expect(
      ExtensionToHostMessage.safeParse({ ...hello, protocolVersion: 0 })
        .success,
    ).toBe(false);
    expect(
      ExtensionToHostMessage.safeParse({
        ...hello,
        profile: { id: '../../etc' },
      }).success,
    ).toBe(false);
  });

  it('validates tool descriptors', () => {
    const ok = {
      name: 'list_spaces',
      description: 'x',
      inputSchema: { type: 'object' },
    };
    expect(ToolDescriptor.safeParse(ok).success).toBe(true);
    expect(
      ToolDescriptor.safeParse({ ...ok, name: 'List Spaces' }).success,
    ).toBe(false);
    expect(
      ToolDescriptor.safeParse({ ...ok, inputSchema: { type: 'string' } })
        .success,
    ).toBe(false);
    expect(
      ToolDescriptor.safeParse({
        ...ok,
        inputSchema: { type: 'object', description: 'x'.repeat(70_000) },
      }).success,
    ).toBe(false);
  });

  it('requires exactly one of result and error', () => {
    const base = { type: 'tools.result', id: 'h1' };
    expect(
      ExtensionToHostMessage.safeParse({ ...base, result: {} }).success,
    ).toBe(true);
    expect(
      ExtensionToHostMessage.safeParse({
        ...base,
        error: { code: 'not_found', message: 'gone' },
      }).success,
    ).toBe(true);
    expect(ExtensionToHostMessage.safeParse(base).success).toBe(false);
    expect(
      ExtensionToHostMessage.safeParse({
        ...base,
        result: {},
        error: { code: 'x', message: 'y' },
      }).success,
    ).toBe(false);
  });

  it('bounds tools.call arguments and timeouts', () => {
    const call = {
      type: 'tools.call',
      id: 'h1',
      name: 'list_spaces',
      arguments: {},
      timeoutMs: 1000,
    };
    expect(HostToExtensionMessage.safeParse(call).success).toBe(true);
    expect(
      HostToExtensionMessage.safeParse({ ...call, timeoutMs: 10 ** 9 }).success,
    ).toBe(false);
    expect(
      HostToExtensionMessage.safeParse({
        ...call,
        arguments: { blob: 'x'.repeat(300_000) },
      }).success,
    ).toBe(false);
  });

  it('distinguishes unknown message types (ignored) from invalid ones', () => {
    const unknown = parseMessage(ExtensionToHostMessage, {
      type: 'future.thing',
    });
    expect(unknown).toMatchObject({ ok: false, unknownType: true });
    const invalid = parseMessage(ExtensionToHostMessage, { type: 'hello' });
    expect(invalid).toMatchObject({ ok: false, unknownType: false });
  });

  it('keeps unknown fields out (forward compatible, stripped)', () => {
    const parsed = parseMessage(ExtensionToHostMessage, {
      ...hello,
      futureField: 1,
    });
    expect(parsed.ok && 'futureField' in parsed.message).toBe(false);
  });

  it('negotiates the protocol version', () => {
    expect(negotiateProtocol(1)).toBe(1);
    expect(negotiateProtocol(5, 1)).toBe(1);
    expect(negotiateProtocol(5, 2)).toBeUndefined();
    expect(negotiateProtocol(2, 2, 3, 1)).toBe(2);
  });

  it('validates socket messages and records', () => {
    expect(
      ClientToHostMessage.safeParse({
        type: 'client.hello',
        protocolVersion: 1,
        token: 'f'.repeat(64),
        client: { name: 't', version: '1' },
      }).success,
    ).toBe(true);
    expect(
      ClientToHostMessage.safeParse({
        type: 'client.hello',
        protocolVersion: 1,
        token: 'short',
        client: { name: 't', version: '1' },
      }).success,
    ).toBe(false);
    expect(HostRecord.safeParse({ v: 1 }).success).toBe(false);
  });

  it('describes the v1 workspace data shapes', () => {
    expect(
      ListSpacesData.safeParse({
        spaces: [{ id: 's1', name: 'Work', keptCount: 3, tabCount: 5 }],
      }).success,
    ).toBe(true);
    expect(
      KeptNode.safeParse({
        type: 'folder',
        id: 'f',
        name: 'Docs',
        children: [
          { type: 'item', id: 'i', title: 'x', url: 'https://x', open: false },
        ],
      }).success,
    ).toBe(true);
    expect(
      PageTextData.safeParse({ tabId: 1, length: 10, truncated: false })
        .success,
    ).toBe(true);
  });
});
