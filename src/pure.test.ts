import { describe, it, expect } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import {
  parseHeadlessOutput,
  parseDshEventLine,
  errorHint,
  versionCmp,
  contextWindowFor,
  MODEL_CONTEXT_WINDOWS,
  streamRelayPatchYaml,
  shimJsTarget,
  resolveVaultRelativeDir,
  frontmatterAliases,
} from './pure';
import { estimateTokens } from './context-meter';

describe('estimateTokens', () => {
  it('returns 0 for empty input', () => {
    expect(estimateTokens('')).toBe(0);
  });

  it('counts CJK chars as 1 token each', () => {
    expect(estimateTokens('你好世界')).toBe(4);
  });

  it('counts Latin chars as 1 token per 4 chars', () => {
    expect(estimateTokens('hello world')).toBe(3); // ceil(11/4)
  });

  it('mixes CJK and Latin correctly', () => {
    expect(estimateTokens('你好ab')).toBe(3); // 2 CJK + ceil(2/4)
  });
});

describe('parseHeadlessOutput', () => {
  it('strips DLEVENT lines and keeps the answer', () => {
    expect(parseHeadlessOutput('DLEVENT\t{"t":"think"}\nhello')).toBe('hello');
  });

  it('keeps non-DLEVENT lines in order', () => {
    expect(parseHeadlessOutput('DLEVENT\t{}\nline1\nDLEVENT\t{}\nline2\n')).toBe('line1\nline2');
  });

  it('passes plain text through untouched', () => {
    expect(parseHeadlessOutput('plain text')).toBe('plain text');
  });

  it('returns empty string for empty input', () => {
    expect(parseHeadlessOutput('')).toBe('');
  });
});

describe('parseDshEventLine', () => {
  it('parses think events with string text', () => {
    expect(parseDshEventLine('DLEVENT\t{"t":"think","text":"hello"}'))
      .toEqual({ t: 'think', text: 'hello' });
  });

  it('parses tool start events and fills optional display fields', () => {
    expect(parseDshEventLine(
      'DLEVENT\t{"t":"tool","status":"start","id":"call-1","name":"bash","args":"ls","argsFull":"{\\"cmd\\":\\"ls\\"}"}',
    )).toEqual({
      t: 'tool',
      status: 'start',
      id: 'call-1',
      name: 'bash',
      args: 'ls',
      argsFull: '{"cmd":"ls"}',
    });
  });

  it('parses tool result events with ok false and summary', () => {
    expect(parseDshEventLine(
      'DLEVENT\t{"t":"tool","status":"result","id":"call-1","ok":false,"summary":"boom"}',
    )).toEqual({
      t: 'tool',
      status: 'result',
      id: 'call-1',
      ok: false,
      summary: 'boom',
    });
  });

  it('returns null for non-DLEVENT lines', () => {
    expect(parseDshEventLine('plain output')).toBeNull();
    expect(parseDshEventLine('DLEVENT')).toBeNull();
  });

  it('returns null for malformed JSON', () => {
    expect(parseDshEventLine('DLEVENT\t{"t":"think",}')).toBeNull();
  });

  it('returns null for unknown or incomplete event shapes', () => {
    expect(parseDshEventLine('DLEVENT\t{"t":"nope"}')).toBeNull();
    expect(parseDshEventLine('DLEVENT\t{"t":"think"}')).toBeNull();
    expect(parseDshEventLine('DLEVENT\t{"t":"tool","status":"start"}')).toBeNull();
    expect(parseDshEventLine('DLEVENT\t{"t":"tool","status":"result","id":"x"}')).toBeNull();
  });
});


describe('errorHint', () => {
  it('maps credential codes to a hint', () => {
    expect(errorHint('INVALID_CREDENTIAL')).toBeTruthy();
    expect(errorHint('MISSING_CREDENTIAL')).toBeTruthy();
    expect(errorHint('NO_ADAPTER')).toBeTruthy();
  });

  it('maps quota/rate/timeout to hints', () => {
    expect(errorHint('QUOTA')).toBeTruthy();
    expect(errorHint('RATE_LIMIT')).toBeTruthy();
    expect(errorHint('TIMEOUT')).toBeTruthy();
  });

  it('returns null for unknown codes', () => {
    expect(errorHint('SOMETHING_UNKNOWN')).toBeNull();
  });
});

describe('versionCmp', () => {
  it('orders by major version numerically (not lexicographically)', () => {
    expect(versionCmp('v18.0.0', 'v9.0.0')).toBeGreaterThan(0);
    expect(versionCmp('v9.0.0', 'v18.0.0')).toBeLessThan(0);
    expect(versionCmp('v10.0.0', 'v9.0.0')).toBeGreaterThan(0);
  });

  it('orders by minor and patch when major is equal', () => {
    expect(versionCmp('v18.2.0', 'v18.1.0')).toBeGreaterThan(0);
    expect(versionCmp('v18.0.1', 'v18.0.0')).toBeGreaterThan(0);
  });

  it('returns 0 for equal versions', () => {
    expect(versionCmp('v18.0.0', 'v18.0.0')).toBe(0);
  });
});

describe('contextWindowFor', () => {
  it('resolves known models', () => {
    expect(contextWindowFor('deepseek-v4-flash')).toBe(1_000_000);
    expect(contextWindowFor('deepseek-v4-pro')).toBe(1_000_000);
  });

  it('falls back to the default for unknown models', () => {
    expect(contextWindowFor('unknown-model')).toBe(1_000_000);
  });

  it('exposes a window for every known model', () => {
    expect(Object.keys(MODEL_CONTEXT_WINDOWS).length).toBeGreaterThan(0);
  });
});

describe('streamRelayPatchYaml', () => {
  it('emits a file:// URL specifier importable by Node ESM', () => {
    const relay = path.join(
      os.tmpdir(), 'vault', '.obsidian', 'plugins',
      'deepharness', 'generated', 'stream-relay.js',
    );
    const spec = nameSpecifier(streamRelayPatchYaml(relay));
    expect(spec).toMatch(/^file:\/\//);
    expect(spec).not.toContain('\\');
    expect(spec).toContain('stream-relay.js');
  });

  it('embeds the relay plugin id in an insert entry', () => {
    const yaml = streamRelayPatchYaml('/tmp/x/stream-relay.js');
    expect(yaml).toContain('- insert:');
    expect(yaml).toContain('- id: deepharness-stream-relay');
    expect(yaml).toContain('name:');
  });

  // Regression for the Windows startup failure
  // (ERR_UNSUPPORTED_ESM_URL_SCHEME: Received protocol 'd:').
  it.skipIf(process.platform !== 'win32')(
    'converts a Windows drive path to a file:// URL',
    () => {
      const spec = nameSpecifier(streamRelayPatchYaml(
        'D:\\daily_work\\kyb_vault.obsidian\\plugins\\deepharness\\generated\\stream-relay.js',
      ));
      expect(spec).toBe(
        'file:///D:/daily_work/kyb_vault.obsidian/plugins/deepharness/generated/stream-relay.js',
      );
    },
  );
});

/** Extract the JSON string value of the `name:` line from a relay patch. */
function nameSpecifier(yaml: string): string {
  const line = yaml.split('\n').find((l) => l.trim().startsWith('name:'));
  if (!line) throw new Error('no name: line in patch');
  return JSON.parse(line.slice(line.indexOf(':') + 1).trim()) as string;
}

describe('shimJsTarget', () => {
  // Content as npm generates it for a global install on Windows.
  const cmdShim = [
    '@ECHO off',
    'GOTO start',
    ':find_dp0',
    'SET dp0=%~dp0',
    'EXIT /b',
    ':start',
    'SETLOCAL',
    'CALL :find_dp0',
    '',
    'IF EXIST "%dp0%\\node.exe" (',
    '  SET "_prog=%dp0%\\node.exe"',
    ') ELSE (',
    '  SET "_prog=node"',
    '  SET PATHEXT=%PATHEXT:;.JS;=;%',
    ')',
    '',
    'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js" %*',
    '',
  ].join('\r\n');

  it('extracts the node script from an npm .cmd shim', () => {
    expect(shimJsTarget(cmdShim)).toBe('node_modules\\@deepseek-ai\\dsh\\lib\\bin.js');
  });

  it('extracts the node script from an npm .ps1 shim', () => {
    expect(shimJsTarget(
      '& "$basedir/node_modules/@deepseek-ai/dsh/lib/bin.js" $args',
    )).toBe('node_modules/@deepseek-ai/dsh/lib/bin.js');
  });

  it('extracts the node script from the extensionless POSIX sh shim', () => {
    expect(shimJsTarget(
      'exec node  "$basedir/node_modules/@deepseek-ai/dsh/lib/bin.js" "$@"',
    )).toBe('node_modules/@deepseek-ai/dsh/lib/bin.js');
  });

  it('returns null for non-shim content', () => {
    expect(shimJsTarget('#!/usr/bin/env node\nconsole.log(1)')).toBeNull();
    expect(shimJsTarget('random text')).toBeNull();
  });
});

describe('resolveVaultRelativeDir (extraSkillDirs boundary)', () => {
  // Path math only — nothing is read from / written to the filesystem.
  const vault = path.join(path.sep, 'Users', 'me', 'Vault');

  it('accepts a plain vault-relative subfolder', () => {
    expect(resolveVaultRelativeDir(vault, 'Library/Skills'))
      .toBe(path.join(vault, 'Library', 'Skills'));
  });

  it('accepts nested folders, whitespace and "."', () => {
    expect(resolveVaultRelativeDir(vault, 'a/b/c')).toBe(path.join(vault, 'a', 'b', 'c'));
    expect(resolveVaultRelativeDir(vault, '  Skills  ')).toBe(path.join(vault, 'Skills'));
    expect(resolveVaultRelativeDir(vault, '.')).toBe(vault);
    expect(resolveVaultRelativeDir(vault, 'Skills/..')).toBe(vault);
  });

  it('rejects empty and whitespace-only input', () => {
    expect(resolveVaultRelativeDir(vault, '')).toBeNull();
    expect(resolveVaultRelativeDir(vault, '   ')).toBeNull();
  });

  it('rejects absolute paths (even ones inside the vault)', () => {
    expect(resolveVaultRelativeDir(vault, '/etc')).toBeNull();
    expect(resolveVaultRelativeDir(vault, path.join(vault, 'Skills'))).toBeNull();
  });

  it('rejects "../" escapes out of the vault', () => {
    expect(resolveVaultRelativeDir(vault, '..')).toBeNull();
    expect(resolveVaultRelativeDir(vault, '../secret')).toBeNull();
    expect(resolveVaultRelativeDir(vault, 'Skills/../../secret')).toBeNull();
    expect(resolveVaultRelativeDir(vault, 'a/../../..')).toBeNull();
  });

  it.skipIf(process.platform !== 'win32')('rejects Windows drive-absolute input', () => {
    expect(resolveVaultRelativeDir('C:\\Users\\me\\Vault', 'D:\\evil')).toBeNull();
  });
});
describe('frontmatterAliases (P2-H)', () => {
  it('maps string arrays to trimmed string lists', () => {
    expect(frontmatterAliases(['One', 'Two', 3])).toEqual(['One', 'Two', '3']);
  });

  it('splits a comma-separated string and drops empty entries', () => {
    expect(frontmatterAliases(' One,  Two , ,Three ')).toEqual(['One', 'Two', 'Three']);
    expect(frontmatterAliases('')).toEqual([]);
  });

  it('returns [] for non-array / non-string garbage', () => {
    for (const raw of [undefined, null, 42, { a: 1 }]) {
      expect(frontmatterAliases(raw)).toEqual([]);
    }
  });
});
