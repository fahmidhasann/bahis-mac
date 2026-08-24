import { app } from 'electron';
import { existsSync } from 'fs';
import { log } from './log';
import { auth } from '../conf/axios.ts';
import Xml2Js from 'xml2js';
import { CloudFormData, Form, FormListObj } from './bahis.model.ts';
import { setStatus, Toast } from './utils.ts';
import { buildSubmissionDataUrl, recentSubmissionBoundary, reconcileSubmissionPasses } from './submissionSyncCore.ts';
import type { SubmissionSyncForm } from './submissionSyncCore.ts';
import { parseCloudSubmissionPage } from './cloudSubmissionParse.ts';
import { runDownloadBatch } from './downloadBatch.ts';
import { writeTaxonomyCsv } from './taxonomyStorage.ts';

const parser = new Xml2Js.Parser();

export interface TaxonomySyncWarning {
    slug: string;
    reason: string;
    cached: boolean;
}

export interface TaxonomySyncResult {
    downloaded: string[];
    warnings: TaxonomySyncWarning[];
}

interface TaxonomyDefinition {
    slug: string;
    csv_file_stub: string;
}

const OPTIONAL_TAXONOMY_SLUGS = new Set(['medicinesv2']);

export const APP_VERSION = app.getVersion();
const isProduction = import.meta.env.MODE === 'production';
export const BAHIS_SERVER_URL =
    import.meta.env.VITE_BAHIS_SERVER_URL || (isProduction ? 'https://bman.dls.gov.bd' : 'http://localhost:3001');
const BAHIS_KOBOTOOLBOX_KF_API_URL =
    import.meta.env.VITE_BAHIS_KOBOTOOLBOX_KF_API_URL ||
    (isProduction ? 'https://bf.dls.gov.bd/api/v2/' : 'http://kf.localhost:80/api/v2/');
const BAHIS_KOBOTOOLBOX_KC_API_URL =
    import.meta.env.VITE_BAHIS_KOBOTOOLBOX_KC_API_URL ||
    (isProduction ? 'https://bcat.dls.gov.bd/api/v1/' : 'http://kc.localhost:80/api/v1/');
log.info(`BAHIS_SERVER_URL=${BAHIS_SERVER_URL} (BAHIS 3)`);

const _url = (url, time?) => {
    let conjunction = '?';
    if (url.includes('?')) {
        conjunction = '&';
    }

    if (time !== null && time !== undefined) {
        return `${url}${conjunction}last_modified=${time}&bahis_desk_version=${APP_VERSION}`;
    } else {
        return `${url}${conjunction}bahis_desk_version=${APP_VERSION}`;
    }
};

function _simplifyFormObj(formObj) {
    for (const prop in formObj) {
        if (
            Object.prototype.hasOwnProperty.call(formObj, prop) &&
            Object.prototype.toString.call(formObj[prop]) === '[object Array]'
        ) {
            formObj[prop] = formObj[prop][0].toString();
        }
    }

    return formObj;
}

function _xmlToJson(xml) {
    return new Promise((resolve, reject) => {
        parser.parseString(xml, (error, data) => {
            if (error) {
                log.info('error parsing xml and converting to JSON');
                reject(error);
            } else {
                resolve(data);
            }
        });
    });
}

export const getModules = async (db) => {
    log.info(`GET Module Definitions`);

    const BAHIS_MODULE_DEFINITION_ENDPOINT = `${BAHIS_SERVER_URL}/api/desk/modules`;
    const api_url = _url(BAHIS_MODULE_DEFINITION_ENDPOINT);
    log.info(`API URL: ${api_url}`);

    await auth
        .get(api_url)
        .then((response) => {
            if (response.data) {
                log.info('Modules received from server');

                const upsertQuery = db.prepare(
                    'INSERT INTO module (id, title, icon, description, form, external_url, sort_order, parent_module, module_type) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET title = excluded.title, icon = excluded.icon, description = excluded.description, form = excluded.form, external_url = excluded.external_url, sort_order = excluded.sort_order, parent_module = excluded.parent_module, module_type = excluded.module_type;',
                );
                const deleteQuery = db.prepare('DELETE FROM module WHERE id = ?');
                // const moduleIds = response.data.map(({ id }) => id);
                // BrowserLog(moduleIds);

                db.prepare('DELETE FROM module').run();

                for (const module of response.data) {
                    if (module.is_active) {
                        upsertQuery.run([
                            module.id,
                            module.title,
                            module.icon,
                            module.description,
                            module.form,
                            module.external_url,
                            module.sort_order,
                            module.parent_module,
                            module.module_type,
                        ]);
                    } else {
                        log.info(`Deleting module ${module.id} from local database as no longer active`);
                        deleteQuery.run([module.id]);
                    }
                }
                Toast('GET Module Definitions SUCCESS');
                log.info('GET Module Definitions SUCCESS');
            }
        })
        .catch((error) => {
            Toast('GET Module Definitions FAILED', 'error');
            log.error('GET Module Definitions FAILED with:');
            log.error(error);
            throw error;
        });
};

export const getWorkflows = async (db) => {
    log.info(`GET Workflow Definitions`);

    const BAHIS_WORKFLOW_DEFINITION_ENDPOINT = `${BAHIS_SERVER_URL}/api/desk/workflows`;
    const api_url = _url(BAHIS_WORKFLOW_DEFINITION_ENDPOINT);
    log.info(`API URL: ${api_url}`);

    await auth
        .get(api_url)
        .then((response) => {
            if (response.data) {
                log.info('Workflows received from server');

                const upsertQuery = db.prepare(
                    'INSERT INTO workflow (id, title, source_form, destination_form, definition) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET title = excluded.title, definition = excluded.definition;',
                );
                const deleteQuery = db.prepare('DELETE FROM workflow WHERE id = ?');

                db.prepare('DELETE FROM workflow').run();

                for (const workflow of response.data) {
                    if (workflow.is_active) {
                        upsertQuery.run([
                            workflow.id,
                            workflow.title,
                            workflow.source_form,
                            workflow.destination_form,
                            JSON.stringify(workflow.definition),
                        ]);
                    } else {
                        log.warn(`Deleting workflow ${workflow.id} from local database as no longer active`);
                        deleteQuery.run([workflow.id]);
                    }
                }
            }
            Toast('GET Workflow Definitions SUCCESS');
            log.info('GET Workflow Definitions SUCCESS');
        })
        .catch((error) => {
            Toast('GET Workflow Definitions FAILED', 'error');
            log.error('GET Workflow Definitions FAILED with:');
            log.error(error);
            throw error;
        });
};

export const getForms = async (db) => {
    log.info(`GET KoboToolbox Form Definitions`);

    log.info(`KOBOTOOLBOX KF API URL: ${BAHIS_KOBOTOOLBOX_KF_API_URL}`);

    const kcUrl = new URL(BAHIS_KOBOTOOLBOX_KC_API_URL);
    const formListUrl = kcUrl.origin + '/formList';
    log.info('GET Form UIDs from KoboToolbox', formListUrl);

    let formList: Form[];
    try {
        const response = await auth.get(formListUrl);
        const formListObj = (await _xmlToJson(response.data)) as FormListObj;
        if (!formListObj?.xforms?.xform) throw new Error('No assigned forms were returned');
        const rawForms = Array.isArray(formListObj.xforms.xform) ? formListObj.xforms.xform : [formListObj.xforms.xform];
        formList = rawForms.map((rawForm) => {
            const form = _simplifyFormObj(rawForm);
            setStatus(form.name);
            return {
                uid: form.formID,
                name: form.name,
                description: form.descriptionText,
                xml_url: form.downloadUrl,
            };
        });
        log.info(`GET Form UIDs SUCCESS`);
    } catch (error) {
        Toast('GET form list FAILED', 'error');
        log.error('GET KoboToolbox Form Definitions FAILED with:');
        log.error(error);
        throw error;
    }

    const upsertQuery = db.prepare(
        'INSERT INTO form (uid, name, description, xml) VALUES (?, ?, ?, ?) ON CONFLICT(uid) DO UPDATE SET name = excluded.name, description = excluded.description, xml = excluded.xml;',
    );

    try {
        const downloads = await runDownloadBatch({
            items: formList,
            keyOf: (form) => form.uid,
            download: async (form) => {
                log.info(`GET form ${form.uid} from KoboToolbox`);
                log.debug(form.xml_url);
                const response = await auth.get(form.xml_url);
                log.info(`GET form ${form.uid} SUCCESS`);
                return { form, deployment: response.data };
            },
        });
        if (downloads.failures.length > 0) {
            const details = downloads.failures.map(({ key, reason }) => `${key}: ${reason}`).join('; ');
            throw new Error(`Form definition downloads failed: ${details}`);
        }

        db.transaction(() => {
            db.prepare('DELETE FROM form').run();
            for (const { form, deployment } of downloads.completed) {
                upsertQuery.run([form.uid, form.name, form.description, deployment]);
                setStatus(form.name + ' updated');
            }
        })();

        Toast('Get Form Definitions SUCCESS');
        log.info(`GET KoboToolbox Form Definitions SUCCESS`);
        return formList;
    } catch (error) {
        Toast('GET Form Definitions FAILED', 'error');
        log.error('GET KoboToolbox Form Definitions FAILED with:');
        log.error(error);
        throw error;
    }
};

export { parseCloudSubmissionPage };

export const getFormCloudSubmissions = async (db) => {
    const formList = db.prepare('SELECT uid, name FROM form').all() as SubmissionSyncForm[];
    if (formList.length === 0) throw new Error('No local form definitions are available for submission sync');
    const ITEM_PER_PAGE = 500;
    const upsertQuery = db.prepare(
        'INSERT INTO formcloudsubmission (uuid, form_uid, xml) VALUES (?, ?, ?) ON CONFLICT(uuid) DO UPDATE SET form_uid = excluded.form_uid, xml = excluded.xml;',
    );
    const insertTransaction = db.transaction((records: CloudFormData[]) => {
        for (const { uuid, form_id, xml } of records) upsertQuery.run([uuid, form_id, xml]);
    });
    const fetchPage = async (url: string) => {
        log.debug(`GET cloud data from ${url}`);
        const response = await auth.get(url);
        const page = parseCloudSubmissionPage(response.data, url);
        if (page.skipped > 0) {
            log.warn(`Skipped ${page.skipped} submission(s) with no resolvable instance ID from ${url}`);
        }
        return page;
    };
    const upsertPage = (records: CloudFormData[], form: SubmissionSyncForm) => {
        if (records.length > 0) {
            insertTransaction(records.map((record) => ({ ...record, form_id: form.uid })));
        }
    };

    try {
        const recentBoundary = recentSubmissionBoundary();
        log.info(`Submission visibility catch-up boundary: ${recentBoundary}`);
        const { full: results, recent: recentResults } = await reconcileSubmissionPasses({
            forms: formList,
            buildFullInitialUrl: (form) => {
                log.info(`GET form ${form.uid} submissions from KoboToolbox (full reconciliation)`);
                return buildSubmissionDataUrl({
                    baseUrl: BAHIS_KOBOTOOLBOX_KF_API_URL,
                    formUid: form.uid,
                    limit: ITEM_PER_PAGE,
                });
            },
            buildRecentInitialUrl: (form) => {
                log.info(`GET form ${form.uid} recent submissions from KoboToolbox (visibility catch-up)`);
                return buildSubmissionDataUrl({
                    baseUrl: BAHIS_KOBOTOOLBOX_KF_API_URL,
                    formUid: form.uid,
                    limit: ITEM_PER_PAGE,
                    submittedSince: recentBoundary,
                });
            },
            fetchPage,
            upsertPage,
        });

        for (const result of results) {
            const form = formList.find(({ uid }) => uid === result.formUid);
            setStatus(`${form?.name || result.formUid}: reconciled ${result.received}`);
            Toast(`${form?.name || result.formUid} form sync SUCCESS (${result.received} records)`, 'info', 3000);
        }
        for (const result of recentResults) {
            log.info(`GET form ${result.formUid} visibility catch-up SUCCESS (${result.received} recent records)`);
        }
        log.info(`GET KoboToolbox Form Submissions SUCCESS`);
        return results;
    } catch (error) {
        Toast('GET KoboToolbox Form Submissions FAILED', 'error');
        log.error('GET KoboToolbox Form Submissions FAILED with:');
        log.error(error);
        throw error;
    }
};

export const postFormCloudSubmissions = async (db) => {
    log.info(`POST KoboToolbox Form Submissions`);

    log.info(`KOBOTOOLBOX KC API URL: ${BAHIS_KOBOTOOLBOX_KC_API_URL}`);
    const axios_config = {
        headers: {
            'Content-Type': 'multipart/form-data',
        },
    };

    log.info('Using Form Submitted to local database');
    const formcloudsubmissionList = db.prepare('SELECT * FROM formlocaldraft').all();

    const deleteQuery = db.prepare('DELETE FROM formlocaldraft WHERE uuid = ?');

    const failures: string[] = [];
    for (const form of formcloudsubmissionList) {
        log.info(`POST form ${form.uuid} submissions from KoboToolbox`);
        const selectedFile = new Blob([form.xml], { type: 'text/xml' });
        const formData = new FormData();
        formData.append('xml_submission_file', selectedFile, '@/submission.xml');

        try {
            const response = await auth.post(BAHIS_KOBOTOOLBOX_KC_API_URL + 'submissions', formData, axios_config);
            // 202 means the server already has this record.
            if (response.status !== 201 && response.status !== 202) {
                throw new Error(`Unexpected submission status ${response.status}`);
            }
            deleteQuery.run([form.uuid]);
            log.info(`POST form ${form.uuid} submissions SUCCESS`);
            Toast('Submitted submission successfully');
        } catch (error) {
            failures.push(form.uuid);
            Toast(`Submission ${form.uuid} FAILED`, 'error');
            log.error(`POST KoboToolbox Form Submission ${form.uuid} FAILED with:`);
            log.error(error);
        }
    }
    if (failures.length > 0) {
        throw new Error(`Failed to submit ${failures.length} draft(s): ${failures.join(', ')}`);
    }
    log.info(`POST KoboToolbox Form Submissions SUCCESS`);
};

export const getTaxonomies = async (db) => {
    log.info(`GET Taxonomy Definitions`);

    const BAHIS_TAXONOMY_DEFINITION_ENDPOINT = `${BAHIS_SERVER_URL}/api/taxonomy/taxonomies`;
    const api_url = _url(BAHIS_TAXONOMY_DEFINITION_ENDPOINT);
    log.info(`API URL: ${api_url}`);

    log.info('GET Taxonomy List from server');
    let taxonomyList: TaxonomyDefinition[];
    try {
        const response = await auth.get(api_url);
        taxonomyList = response.data as TaxonomyDefinition[];
        log.info('GET Taxonomy List SUCCESS');
    } catch (error) {
        Toast('GET Taxonomy List FAILED!!', 'error');
        log.error('GET Taxonomy List FAILED with:');
        log.error(error);
        throw error;
    }

    const upsertQuery = db.prepare(
        'INSERT INTO taxonomy (slug, csv_file) VALUES (?, ?) ON CONFLICT(slug) DO UPDATE SET csv_file = excluded.csv_file;',
    );
    const BAHIS_TAXONOMY_CSV_ENDPOINT = (filename) => `${BAHIS_SERVER_URL}/media/${filename}`;

    const downloads = await runDownloadBatch({
        items: taxonomyList,
        keyOf: (taxonomy) => taxonomy.slug as string,
        optionalKeys: OPTIONAL_TAXONOMY_SLUGS,
        download: async (taxonomy) => {
            log.info(`GET Taxonomy CSV ${taxonomy.slug} from server`);
            const response = await auth.get(BAHIS_TAXONOMY_CSV_ENDPOINT(taxonomy.csv_file_stub));
            const uPath = app.getPath('userData');
            writeTaxonomyCsv(uPath, taxonomy.csv_file_stub, response.data);
            upsertQuery.run([taxonomy.slug, taxonomy.csv_file_stub]);
            setStatus(taxonomy.csv_file_stub + ' updated');
            log.info(`GET Taxonomy CSV ${taxonomy.slug} SUCCESS`);
            return taxonomy.slug as string;
        },
    });

    const userDataPath = app.getPath('userData');
    const result: TaxonomySyncResult = {
        downloaded: downloads.completed,
        warnings: downloads.warnings.map(({ key, reason }) => {
            const cachedRow = db.prepare('SELECT csv_file FROM taxonomy WHERE slug = ?').get(key);
            const cached = Boolean(cachedRow?.csv_file && existsSync(`${userDataPath}/${cachedRow.csv_file}`));
            return { slug: key, reason, cached };
        }),
    };
    for (const warning of result.warnings) {
        log.warn(`GET optional taxonomy CSV ${warning.slug} FAILED: ${warning.reason}`);
        Toast(
            warning.cached
                ? `Optional taxonomy ${warning.slug} is unavailable; cached data was kept`
                : `Optional taxonomy ${warning.slug} is unavailable and has no cached copy`,
            'warning',
        );
    }

    if (downloads.failures.length > 0) {
        const details = downloads.failures.map(({ key, reason }) => `${key}: ${reason}`).join('; ');
        Toast('One or more required taxonomy downloads failed', 'error');
        log.error(`Required taxonomy downloads failed: ${details}`);
        throw new Error(`Required taxonomy downloads failed: ${details}`);
    }

    if (result.warnings.length === 0) Toast('GET Taxonomy Definitions SUCCESS');
    return result;
};

export const getAdministrativeRegions = async (db) => {
    log.info(`GET getAdministrativeRegionLevels Definitions`);

    const BAHIS_ADMINISTRATIVE_REGION_LEVELS_ENDPOINT = `${BAHIS_SERVER_URL}/api/taxonomy/administrative-region-levels`;
    const api_levels_url = _url(BAHIS_ADMINISTRATIVE_REGION_LEVELS_ENDPOINT);
    log.info(`API URL: ${api_levels_url}`);

    const levelsDownload = auth
        .get(api_levels_url)
        .then((response) => {
            if (response.data) {
                log.info('Administrative Region Levels received from server');

                const upsertQuery = db.prepare(
                    'INSERT INTO administrativeregionlevel (id, title) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET title = excluded.title;',
                );

                for (const administrativeregionlevel of response.data) {
                    upsertQuery.run([administrativeregionlevel.id, administrativeregionlevel.title]);
                    setStatus(administrativeregionlevel.title + ' Admin level updated');
                }
            }
            log.info('GET getAdministrativeRegionLevels Definitions SUCCESS');
        })
        .catch((error) => {
            log.error('GET getAdministrativeRegionLevels Definitions FAILED with:');
            Toast('GET getAdministrativeRegionLevels Definitions FAILED', 'error');
            log.error(error);
            throw error;
        });

    log.info(`GET getAdministrativeRegions Definitions`);

    const userAdminRegionQuery = 'SELECT upazila FROM users';
    const administrativeRegionID = db.prepare(userAdminRegionQuery).get().upazila; // FIXME replace when moving to BAHIS 3 user systems

    const BAHIS_ADMINISTRATIVE_REGIONS_ENDPOINT = (administrativeRegionID) =>
        `${BAHIS_SERVER_URL}/api/taxonomy/administrative-regions-catchment/?id=${administrativeRegionID}`;
    const api_url = _url(BAHIS_ADMINISTRATIVE_REGIONS_ENDPOINT(administrativeRegionID));
    log.info(`API URL: ${api_url}`);

    const regionsDownload = auth
        .get(api_url)
        .then((response) => {
            if (response.data) {
                log.info('Administrative Regions received from server');

                const upsertQuery = db.prepare(
                    'INSERT INTO administrativeregion (id, title, parent_administrative_region, administrative_region_level) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET title = excluded.title, parent_administrative_region = excluded.parent_administrative_region, administrative_region_level = excluded.administrative_region_level;',
                );

                for (const administrativeregion of response.data) {
                    upsertQuery.run([
                        administrativeregion.id,
                        administrativeregion.title,
                        administrativeregion.parent_administrative_region,
                        administrativeregion.administrative_region_level,
                    ]);
                    setStatus('Admin update ' + administrativeregion.title);
                }
            }
            log.info('GET getAdministrativeRegions Definitions SUCCESS');
        })
        .catch((error) => {
            log.error('GET getAdministrativeRegions Definitions FAILED with:');
            log.error(error);
            throw error;
        });

    await Promise.all([levelsDownload, regionsDownload]);
    return true;
};
