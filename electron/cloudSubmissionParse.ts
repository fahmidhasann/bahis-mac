import { DOMParser } from '@xmldom/xmldom';
import type { Element as XmlElement, Node as XmlNode } from '@xmldom/xmldom';
import type { CloudFormData } from './bahis.model.ts';
import type { SubmissionPage } from './submissionSyncCore.ts';

export interface CloudSubmissionPage extends SubmissionPage<CloudFormData> {
    /** Records the server returned that carried no resolvable instance ID. */
    skipped: number;
}

const elementChildren = (node: XmlNode): XmlElement[] =>
    Array.from(node.childNodes).filter((child): child is XmlElement => child.nodeType === 1);

const localName = (element: XmlElement): string => element.localName || element.nodeName.replace(/^.*:/, '');

const findChild = (node: XmlNode, name: string): XmlElement | undefined =>
    elementChildren(node).find((child) => localName(child) === name);

/**
 * Read one Kobo submission page.
 *
 * Every lookup matches on local name only. Records built from an XForm inherit the
 * form's default XForms namespace, and an unprefixed XPath name test matches only
 * elements in no namespace, so namespaced records used to resolve no instance ID
 * and were dropped without a trace.
 */
export const parseCloudSubmissionPage = (xml: string, pageUrl: string): CloudSubmissionPage => {
    const doc = new DOMParser().parseFromString(xml, 'text/xml');
    const root = doc.documentElement;
    if (!root || localName(root) !== 'root') {
        throw new Error(`Unexpected submission response while reading ${pageUrl}`);
    }

    const results = findChild(root, 'results');
    const records: CloudFormData[] = [];
    let skipped = 0;

    if (results) {
        for (const child of elementChildren(results)) {
            const meta = findChild(child, 'meta');
            const instanceID = meta && findChild(meta, 'instanceID');
            if (!instanceID?.textContent) {
                skipped += 1;
                continue;
            }
            records.push({
                uuid: instanceID.textContent,
                form_id: localName(child),
                xml: child.toString(),
            });
        }
    }

    const nextNode = findChild(root, 'next');
    const nextText = nextNode?.textContent?.trim();
    const next = nextText && nextText !== 'None' ? new URL(nextText, pageUrl).toString() : undefined;
    return { records, next, skipped };
};
