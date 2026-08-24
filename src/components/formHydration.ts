/**
 * Replaces the placeholder taxonomy instances embedded in an XForm with the
 * choices stored locally. The replacement must happen before Enketo receives
 * saved instance values; otherwise dynamic itemsets cannot resolve their labels.
 */
export type TaxonomyChoiceReader = (taxonomySlug: string) => Promise<string | null>;

const taxonomyPrefix = 'deskTaxonomy.';

const taxonomySlugFor = (instanceId: string | null): string | null => {
    if (!instanceId?.startsWith(taxonomyPrefix)) return null;
    return instanceId.slice(taxonomyPrefix.length) || null;
};

const replaceInstanceContents = (document: Document, instance: Element, choices: Document) => {
    while (instance.firstChild) {
        instance.removeChild(instance.firstChild);
    }

    instance.appendChild(document.importNode(choices.documentElement, true));
};

export const hydrateDeskTaxonomyInstances = async (
    formXML: string,
    readTaxonomyChoices: TaxonomyChoiceReader,
): Promise<string> => {
    const parser = new DOMParser();
    const serializer = new XMLSerializer();
    const document = parser.parseFromString(formXML, 'application/xml');
    const instances = Array.from(document.getElementsByTagName('instance'));

    for (const instance of instances) {
        const taxonomySlug = taxonomySlugFor(instance.getAttribute('id'));
        if (!taxonomySlug) continue;

        const choiceXML = await readTaxonomyChoices(taxonomySlug);
        if (!choiceXML) throw new Error(`Unable to load ${taxonomySlug} taxonomy choices`);

        const choices = parser.parseFromString(choiceXML, 'application/xml');
        if (choices.getElementsByTagName('parsererror').length > 0) {
            throw new Error(`Unable to parse ${taxonomySlug} taxonomy choices`);
        }

        replaceInstanceContents(document, instance, choices);
        instance.setAttribute('id', taxonomySlug);

        const placeholderReference = `${taxonomyPrefix}${taxonomySlug}`;
        for (const itemset of Array.from(document.getElementsByTagName('itemset'))) {
            const nodeset = itemset.getAttribute('nodeset');
            if (nodeset?.includes(placeholderReference)) {
                itemset.setAttribute('nodeset', nodeset.split(placeholderReference).join(taxonomySlug));
            }
        }
    }

    return serializer.serializeToString(document);
};

/** Applies saved leaf values after all dynamic choice instances are hydrated. */
export const prefillFormXML = (formXML: string, formData: string): string => {
    const parser = new DOMParser();
    const serializer = new XMLSerializer();
    const document = parser.parseFromString(formXML, 'application/xml');
    const savedDocument = parser.parseFromString(formData, 'application/xml');

    for (const savedElement of Array.from(savedDocument.getElementsByTagName('*'))) {
        if (savedElement.children.length !== 0 || !savedElement.textContent) continue;

        const formElement = document.getElementsByTagName(savedElement.tagName)[0];
        if (formElement?.children.length === 0) {
            formElement.textContent = savedElement.textContent;
        }
    }

    return serializer.serializeToString(document);
};
