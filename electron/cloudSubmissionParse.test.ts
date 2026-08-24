import assert from 'node:assert/strict';
import test from 'node:test';
import { DOMParser } from '@xmldom/xmldom';
import { parseCloudSubmissionPage } from './cloudSubmissionParse.ts';

const FORM_UID = 'ajAsiLXLghXg2c2BXFMQbV';
const PAGE_URL = `https://bf.dls.gov.bd/api/v2/assets/${FORM_UID}/data/?format=xml&start=0&limit=500`;

/**
 * Enketo submissions declare only *prefixed* namespaces, which leave the record
 * root in no namespace. These have always synced.
 */
const enketoRecord = (uuid: string) => `
    <${FORM_UID} xmlns:jr="http://openrosa.org/javarosa" xmlns:orx="http://openrosa.org/xforms" id="${FORM_UID}">
        <basic_info><owner>Enketo Owner</owner></basic_info>
        <start>2026-08-09T17:48:00.000+06:00</start>
        <meta><instanceID>uuid:${uuid}</instanceID></meta>
    </${FORM_UID}>`;

/**
 * MCP submissions inherit the XForms *default* namespace from the form model,
 * which puts the record root in a namespace. These used to be dropped.
 */
const namespacedRecord = (uuid: string) => `
    <${FORM_UID} xmlns="http://www.w3.org/2002/xforms" id="${FORM_UID}">
        <basic_info><owner>MCP Owner</owner></basic_info>
        <start>2026-08-09T17:48:00.000+06:00</start>
        <meta><instanceID>uuid:${uuid}</instanceID></meta>
    </${FORM_UID}>`;

const page = (body: string) => `<?xml version="1.0" encoding="utf-8"?><root><results>${body}</results></root>`;

test('the two production record shapes differ only by default vs prefixed namespace', () => {
    const parse = (xml: string) => {
        const root = new DOMParser().parseFromString(xml.trim(), 'text/xml').documentElement;
        assert.ok(root, 'fixture failed to parse');
        return root;
    };

    assert.equal(parse(enketoRecord('a')).namespaceURI, null);
    assert.equal(parse(namespacedRecord('a')).namespaceURI, 'http://www.w3.org/2002/xforms');
});

test('records carrying the default XForms namespace are kept', () => {
    const result = parseCloudSubmissionPage(page(namespacedRecord('mcp-1')), PAGE_URL);

    assert.equal(result.records.length, 1);
    assert.equal(result.records[0].uuid, 'uuid:mcp-1');
    assert.equal(result.records[0].form_id, FORM_UID);
    assert.equal(result.skipped, 0);
});

test('namespace-free Enketo records are still kept', () => {
    const result = parseCloudSubmissionPage(page(enketoRecord('enketo-1')), PAGE_URL);

    assert.equal(result.records.length, 1);
    assert.equal(result.records[0].uuid, 'uuid:enketo-1');
    assert.equal(result.records[0].form_id, FORM_UID);
    assert.equal(result.skipped, 0);
});

test('a mixed page keeps both record shapes', () => {
    const result = parseCloudSubmissionPage(
        page(`${enketoRecord('enketo-2')}${namespacedRecord('mcp-2')}${enketoRecord('enketo-3')}`),
        PAGE_URL,
    );

    assert.deepEqual(
        result.records.map((record) => record.uuid),
        ['uuid:enketo-2', 'uuid:mcp-2', 'uuid:enketo-3'],
    );
    assert.equal(result.skipped, 0);
});

test('a record with no instance ID is skipped and counted rather than lost silently', () => {
    const result = parseCloudSubmissionPage(
        page(`<${FORM_UID}><basic_info><owner>No Meta</owner></basic_info></${FORM_UID}>${enketoRecord('enketo-4')}`),
        PAGE_URL,
    );

    assert.deepEqual(
        result.records.map((record) => record.uuid),
        ['uuid:enketo-4'],
    );
    assert.equal(result.skipped, 1);
});

test('a relative next link resolves against the page URL', () => {
    const xml = `<root><results/><next>/api/v2/assets/${FORM_UID}/data/?format=xml&amp;start=500&amp;limit=500</next></root>`;
    const result = parseCloudSubmissionPage(xml, PAGE_URL);

    assert.equal(result.next, `https://bf.dls.gov.bd/api/v2/assets/${FORM_UID}/data/?format=xml&start=500&limit=500`);
});

test('escaped ampersands in next are decoded so every query parameter survives', () => {
    const xml = `<root><results/><next>https://bf.dls.gov.bd/api/v2/assets/${FORM_UID}/data/?format=xml&amp;start=500&amp;limit=500</next></root>`;
    const result = parseCloudSubmissionPage(xml, PAGE_URL);

    // Losing this decoding truncates pagination to the first page.
    assert.ok(!result.next?.includes('&amp;'));
    assert.equal(new URL(result.next as string).searchParams.get('start'), '500');
    assert.equal(new URL(result.next as string).searchParams.get('limit'), '500');
});

test('next of None ends the pagination chain', () => {
    const result = parseCloudSubmissionPage('<root><results/><next>None</next></root>', PAGE_URL);

    assert.equal(result.next, undefined);
});

test('an unexpected document shape throws rather than reporting an empty page', () => {
    assert.throws(() => parseCloudSubmissionPage('<detail>Not found.</detail>', PAGE_URL), /Unexpected submission response/);
});
