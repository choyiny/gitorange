import { describe, expect, it } from 'vitest';
import { encoder } from '../git/bytes';
import { makeBlob, makeCommit, makeTree } from '../git/objects';
import { parseRefAdvertisement, pktLine, FLUSH } from '../git/pktline';
import { concat } from '../git/bytes';

// Expected hashes are what `git hash-object` / `git mktree` produce for the same content.
describe('git object encoding', () => {
  it('hashes blobs exactly like git', async () => {
    expect((await makeBlob('')).sha).toBe(
      'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391'
    );
    expect((await makeBlob('hello\n')).sha).toBe(
      'ce013625030ba8dba906f756967f9e9ca394464a'
    );
  });

  it('hashes the empty tree exactly like git', async () => {
    expect((await makeTree([])).sha).toBe(
      '4b825dc642cb6eb9a060e54bf8d69288fbee4904'
    );
  });

  it('orders directories as if suffixed with a slash', async () => {
    const blob = await makeBlob('x');
    const tree = await makeTree([
      {
        name: 'a',
        mode: '40000',
        hash: '4b825dc642cb6eb9a060e54bf8d69288fbee4904',
      },
      { name: 'a.txt', mode: '100644', hash: blob.sha },
    ]);
    const text = new TextDecoder('latin1').decode(tree.data);
    expect(text.indexOf('a.txt')).toBeLessThan(text.indexOf('40000 a\0'));
  });

  it('produces a stable commit hash for fixed input', async () => {
    const c = await makeCommit({
      tree: '4b825dc642cb6eb9a060e54bf8d69288fbee4904',
      parents: [],
      author: { name: 'A', email: 'a@example.com', timestamp: 1700000000 },
      message: 'init',
    });
    // Same bytes piped through `git hash-object -t commit --stdin`.
    expect(c.sha).toBe('0ecda3d68435b49f8de8d1bbaa00149ba94664b2');
  });
});

describe('ref advertisement', () => {
  it('parses refs and the HEAD symref', () => {
    const body = concat([
      pktLine('# service=git-upload-pack\n'),
      FLUSH,
      pktLine(
        `${'a'.repeat(40)} HEAD\0multi_ack symref=HEAD:refs/heads/main agent=x\n`
      ),
      pktLine(`${'b'.repeat(40)} refs/heads/feature\n`),
      pktLine(`${'a'.repeat(40)} refs/heads/main\n`),
      FLUSH,
    ]);
    const ad = parseRefAdvertisement(body);
    expect(ad.head).toBe('refs/heads/main');
    expect(ad.refs.get('refs/heads/feature')).toBe('b'.repeat(40));
    expect(ad.refs.get('refs/heads/main')).toBe('a'.repeat(40));
  });

  it('treats an empty repo advertisement as having no refs', () => {
    const body = concat([
      pktLine(`${'0'.repeat(40)} capabilities^{}\0agent=x\n`),
      FLUSH,
    ]);
    expect(parseRefAdvertisement(body).refs.size).toBe(0);
  });

  it('encodes pkt-line lengths in hex including the 4-byte prefix', () => {
    expect(new TextDecoder().decode(pktLine('hi\n'))).toBe('0007hi\n');
    expect(encoder.encode('0000')).toEqual(FLUSH);
  });
});
