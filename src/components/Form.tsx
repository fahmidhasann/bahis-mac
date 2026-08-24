import { useEffect, useState } from 'react';
import { useLocation, useParams } from 'react-router-dom';
import { log } from '../helpers/log';
import { ipcRenderer } from 'electron';
import { EnketoForm } from './EnketoForm';
import { Footer } from './EnketoFooter';
import { LoadingSpinner } from './LoadingSpinner.tsx';
import { hydrateDeskTaxonomyInstances, prefillFormXML } from './formHydration.ts';

const readFormData = async (tableName: string, form_uid: string, instance_id?: string) => {
    log.info(`reading data from ${tableName} table...`);
    log.info(`  for form_uid: ${form_uid}...`);
    if (instance_id) log.info(`  for instance_id: ${instance_id}...`);
    let query = `SELECT *
                 FROM ${tableName}
                 WHERE form_uid IS '${form_uid}'`;
    if (instance_id) query += ` AND uuid IS '${instance_id}'`;
    return ipcRenderer
        .invoke('get-local-db', query)
        .then((response) => {
            log.info(`  read ${response.length} records`);
            return response;
        })
        .catch((error) => {
            log.error(`Error reading form data: ${error}`);
            return [];
        });
};

interface FormProps {
    draft?: boolean;
}

export const Form: React.FC<FormProps> = ({ draft }: FormProps) => {
    const [formXML, setFormXML] = useState<string>('');
    const [injectedData, setInjectedData] = useState<string>();
    const [hydratedFormXML, setHydratedFormXML] = useState<string>('');
    const [prefilledFormXML, setPrefilledFormXML] = useState<string>('');
    const [isPrefilled, setIsPrefilled] = useState<boolean>(false);

    const { state } = useLocation();

    const { form_uid, instance_id } = useParams();
    const tableName = draft ? 'formlocaldraft' : 'formcloudsubmission';
    const editable = !(!draft && instance_id);

    // catch changing location state for injected data via workflow
    useEffect(() => {
        if (state?.injectedData) {
            log.info('Injecting data via workflow');
            setInjectedData(state.injectedData);
        }
    }, [state]);

    // read form defintion
    useEffect(() => {
        const readForm = (form_uid: string) => {
            log.info(`reading XML definition from forms for form: ${form_uid}`);
            const query = `SELECT xml
                           FROM form
                           WHERE uid = '${form_uid}'`;
            ipcRenderer
                .invoke('get-local-db', query)
                .then((response) => {
                    if (response[0]?.xml) {
                        setFormXML(response[0]?.xml);
                        log.info('Form XML definition read successfully');
                    }
                })
                .catch((error) => {
                    log.error('Error reading form XML definition');
                    log.error(error);
                });
        };

        if (form_uid) {
            readForm(form_uid);
        }
    }, [form_uid]);

    // Hydrate every dynamic taxonomy before saved values are applied. Cloud
    // records remain read-only, but still need choices to resolve their labels.
    useEffect(() => {
        let cancelled = false;

        const replaceUserValues = async (xml: string): Promise<string> => {
            log.info('Replacing deskUser tags in form definition');
            const parser = new DOMParser();
            const serializer = new XMLSerializer();
            const doc = parser.parseFromString(xml, 'application/xml');

            const elements = doc.getElementsByTagName('*');
            const response = await ipcRenderer.invoke('read-user-administrative-region', 'asName');
            const availableLevels = ['1', '2', '3'].filter((level) => typeof response?.[level] === 'string');
            log.info(`Administrative region levels resolved: ${availableLevels.join(', ')}`);

            for (let i = 0; i < elements.length; i++) {
                const text = elements[i].textContent;
                if (!text?.startsWith('deskUser.administrative_region_')) continue;

                const level = text.slice('deskUser.administrative_region_'.length);
                const value = response?.[level];
                if (typeof value === 'string') {
                    elements[i].textContent = value;
                }
            }

            return serializer.serializeToString(doc);
        };

        const readTaxonomyChoices = async (taxonomySlug: string): Promise<string | null> => {
            log.info(`Reading taxonomy data for ${taxonomySlug}`);
            try {
                if (taxonomySlug === 'administrative_region') {
                    return await ipcRenderer.invoke('read-administrative-region-data');
                }
                return await ipcRenderer.invoke('read-taxonomy-data', taxonomySlug);
            } catch (error) {
                log.error(`Error reading ${taxonomySlug} taxonomy data`);
                log.error(error);
                return null;
            }
        };

        const prepareDefinition = async () => {
            if (!formXML) return;

            setHydratedFormXML('');
            setPrefilledFormXML('');
            setIsPrefilled(false);

            try {
                const withUserValues = !instance_id && !injectedData ? await replaceUserValues(formXML) : formXML;
                const withTaxonomyChoices = await hydrateDeskTaxonomyInstances(withUserValues, readTaxonomyChoices);
                if (!cancelled) {
                    setHydratedFormXML(withTaxonomyChoices);
                    log.info('deskTaxonomy choices hydrated successfully');
                }
            } catch (error) {
                log.error('Error hydrating form definition');
                log.error(error);
            }
        };

        void prepareDefinition();
        return () => {
            cancelled = true;
        };
    }, [formXML, instance_id, injectedData]);

    // if the form has been filled out previously, read the data
    // FIXME and then force it into the form as "default" data
    // because we couldn't get the instanceStr to work in the EnketoForm component
    // but we also use this for injecting data via a workflow
    useEffect(() => {
        let cancelled = false;

        const applyPrefill = (data: string) => {
            if (cancelled) return;
            setPrefilledFormXML(prefillFormXML(hydratedFormXML, data));
            setIsPrefilled(true);
            log.info('Prefilled values replaced successfully');
        };

        if (!hydratedFormXML) return;

        if (form_uid && instance_id) {
            log.info(`Reading data for form: ${form_uid} (${tableName}) and instance: ${instance_id}`);
            readFormData(tableName, form_uid, instance_id)
                .then((response) => {
                    const formData = response[0]?.xml as string | undefined;
                    if (formData) {
                        applyPrefill(formData);
                    } else {
                        log.error('No saved form data found for instance');
                        if (!cancelled) {
                            setPrefilledFormXML(hydratedFormXML);
                            setIsPrefilled(true);
                        }
                    }
                })
                .catch((error) => {
                    log.error('Error reading form data');
                    log.error(error);
                    if (!cancelled) {
                        setPrefilledFormXML(hydratedFormXML);
                        setIsPrefilled(true);
                    }
                });
        } else if (injectedData) {
            log.info('Prefilling form with injected data (probably a workflow)');
            applyPrefill(injectedData);
        } else {
            setPrefilledFormXML(hydratedFormXML);
            setIsPrefilled(true);
        }
        return () => {
            cancelled = true;
        };
    }, [form_uid, hydratedFormXML, tableName, instance_id, injectedData]);

    return (
        <>
            {form_uid && prefilledFormXML && isPrefilled ? (
                <EnketoForm formUID={form_uid} formODKXML={prefilledFormXML} instanceID={instance_id} editable={editable} />
            ) : (
                <LoadingSpinner loadingText="Form is Loading" />
            )}
            <Footer />
        </>
    );
};

Form.defaultProps = {
    draft: false,
};
