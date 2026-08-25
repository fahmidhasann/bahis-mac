import test from 'node:test';
import assert from 'node:assert/strict';
import { KoboClient } from '../src/kobo.js';
import type { Config } from '../src/config.js';

const config: Config = {
    dbPath: '/tmp/unused.db',
    journalPath: '/tmp/unused-journal.db',
    bahisServerUrl: 'https://example.test',
    koboKfApiUrl: 'https://kf.example.test/api/v2/',
    koboKcApiUrl: 'https://kc.example.test/api/v1/',
    allowProductionWrites: false,
};

test('upload retries a server error and accepts HTTP 201', async () => {
    let calls = 0;
    const fetchMock: typeof fetch = async () => {
        calls += 1;
        return new Response('', { status: calls === 1 ? 500 : 201 });
    };
    const client = new KoboClient(config, 'token', fetchMock, async () => undefined);
    assert.equal(await client.upload('<data/>'), 201);
    assert.equal(calls, 2);
});

test('UUID verification uses the normalized _uuid query and extracts submission XML', async () => {
    let requested = '';
    const fetchMock: typeof fetch = async (input) => {
        requested = String(input);
        return new Response('<root><results><form><meta><instanceID>uuid:abc</instanceID></meta></form></results></root>', {
            status: 200,
            headers: { 'content-type': 'application/xml' },
        });
    };
    const client = new KoboClient(config, 'token', fetchMock, async () => undefined);
    const result = await client.fetchSubmissionXml('uuid:abc');
    assert.match(result ?? '', /^<form>/);
    const url = new URL(requested);
    assert.equal(JSON.parse(url.searchParams.get('query') ?? '{}')._uuid, 'abc');
});

test('form download rejects a cross-origin URL before sending the token', async () => {
    let calls = 0;
    const fetchMock: typeof fetch = async () => {
        calls += 1;
        return new Response(
            '<xforms><xform><formID>ajAsiLXLghXg2c2BXFMQbV</formID><downloadUrl>https://evil.test/form.xml</downloadUrl></xform></xforms>',
            { status: 200 },
        );
    };
    const client = new KoboClient(config, 'token', fetchMock, async () => undefined);
    await assert.rejects(client.fetchCurrentFormDefinition(), /untrusted/);
    assert.equal(calls, 1);
});
