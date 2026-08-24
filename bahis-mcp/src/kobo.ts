import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
import type { Element as XmlElement, Node as XmlNode } from '@xmldom/xmldom';
import { MAX_UPLOAD_ATTEMPTS, PATIENT_REGISTRY_FORM_UID } from './constants.js';
import type { Config } from './config.js';
import { safeError, sleep as defaultSleep } from './util.js';

class HttpError extends Error {
    constructor(
        readonly status: number,
        message: string,
    ) {
        super(message);
    }

    get retryable(): boolean {
        return this.status === 429 || this.status >= 500;
    }
}

function children(node: XmlNode): XmlElement[] {
    return Array.from(node.childNodes).filter((child): child is XmlElement => child.nodeType === 1);
}

function localName(element: XmlElement): string {
    return element.localName || element.nodeName.replace(/^.*:/, '');
}

export class KoboClient {
    constructor(
        private readonly config: Config,
        private readonly token: string,
        private readonly fetchImpl: typeof fetch = fetch,
        private readonly sleepImpl: (milliseconds: number) => Promise<void> = defaultSleep,
    ) {}

    private headers(accept = 'application/json'): HeadersInit {
        return { Authorization: `TOKEN ${this.token}`, Accept: accept, 'User-Agent': 'BAHIS-Patient-Registry-MCP/0.1.0' };
    }

    async health(): Promise<boolean> {
        const url = new URL(`assets/${PATIENT_REGISTRY_FORM_UID}/`, this.config.koboKfApiUrl);
        const response = await this.fetchImpl(url, { headers: this.headers() });
        return response.ok;
    }

    async fetchCurrentFormDefinition(): Promise<string> {
        const formListUrl = new URL('/formList', this.config.koboKcApiUrl);
        const listResponse = await this.fetchImpl(formListUrl, { headers: this.headers('*/*') });
        if (!listResponse.ok) throw new HttpError(listResponse.status, `Kobo form list returned HTTP ${listResponse.status}.`);
        const document = new DOMParser().parseFromString(await listResponse.text(), 'application/xml');
        const xforms = Array.from(document.getElementsByTagName('*')).filter((element) => localName(element) === 'xform');
        const matching = xforms.find((xform) =>
            children(xform).some(
                (child) => localName(child) === 'formID' && (child.textContent ?? '').trim() === PATIENT_REGISTRY_FORM_UID,
            ),
        );
        if (!matching) throw new Error('The signed-in user is not assigned the Patient Registry form.');
        const downloadUrl = children(matching)
            .find((child) => localName(child) === 'downloadUrl')
            ?.textContent?.trim();
        if (!downloadUrl) throw new Error('Kobo did not provide a Patient Registry form download URL.');
        let trustedDownloadUrl: URL;
        try {
            trustedDownloadUrl = new URL(downloadUrl);
        } catch {
            throw new Error('Kobo provided an invalid Patient Registry form download URL.');
        }
        if (trustedDownloadUrl.protocol !== 'https:' || trustedDownloadUrl.origin !== formListUrl.origin) {
            throw new Error('Kobo provided an untrusted Patient Registry form download URL.');
        }
        const formResponse = await this.fetchImpl(trustedDownloadUrl, {
            headers: this.headers('*/*'),
            redirect: 'manual',
        });
        if (!formResponse.ok) throw new HttpError(formResponse.status, `Kobo form download returned HTTP ${formResponse.status}.`);
        return formResponse.text();
    }

    async upload(xml: string): Promise<201 | 202> {
        let lastError: unknown;
        for (let attempt = 1; attempt <= MAX_UPLOAD_ATTEMPTS; attempt += 1) {
            try {
                const formData = new FormData();
                formData.append('xml_submission_file', new Blob([xml], { type: 'text/xml' }), 'submission.xml');
                const response = await this.fetchImpl(new URL('submissions', this.config.koboKcApiUrl), {
                    method: 'POST',
                    headers: this.headers('*/*'),
                    body: formData,
                });
                if (response.status === 201 || response.status === 202) return response.status;
                throw new HttpError(response.status, `Kobo submission returned HTTP ${response.status}.`);
            } catch (error) {
                lastError = error;
                const retryable = !(error instanceof HttpError) || error.retryable;
                if (!retryable || attempt === MAX_UPLOAD_ATTEMPTS) break;
                await this.sleepImpl(1_000 * 2 ** (attempt - 1));
            }
        }
        throw new Error(`Upload failed after ${MAX_UPLOAD_ATTEMPTS} attempts: ${safeError(lastError)}`);
    }

    async fetchSubmissionXml(uuid: string): Promise<string | undefined> {
        const url = new URL(`assets/${PATIENT_REGISTRY_FORM_UID}/data/`, this.config.koboKfApiUrl);
        url.searchParams.set('format', 'xml');
        url.searchParams.set('limit', '2');
        url.searchParams.set('query', JSON.stringify({ _uuid: uuid.replace(/^uuid:/, '') }));
        const response = await this.fetchImpl(url, { headers: this.headers('application/xml') });
        if (!response.ok) throw new HttpError(response.status, `Kobo verification returned HTTP ${response.status}.`);
        const document = new DOMParser().parseFromString(await response.text(), 'application/xml');
        const root = document.documentElement;
        if (!root) throw new Error('Kobo returned malformed submission XML.');
        const results = children(root).find((element) => localName(element) === 'results');
        const submission = results ? children(results)[0] : undefined;
        return submission ? new XMLSerializer().serializeToString(submission) : undefined;
    }
}
