import { strict as assert } from 'node:assert';
import test from 'node:test';
import { DOMParser as XmlDomParser, XMLSerializer as XmlSerializer } from '@xmldom/xmldom';
import { hydrateDeskTaxonomyInstances, prefillFormXML } from './formHydration.ts';

globalThis.DOMParser = XmlDomParser as unknown as typeof DOMParser;
globalThis.XMLSerializer = XmlSerializer as unknown as typeof XMLSerializer;

const parse = (xml: string) => new XmlDomParser().parseFromString(xml, 'application/xml');

const formDefinition = `
<html>
  <head>
    <model>
      <instance><data><division>deskUser.administrative_region_1</division><district>deskUser.administrative_region_2</district><upazila>deskUser.administrative_region_3</upazila><union/><species/><clinical_signs/><tentative_diagnosis/><patient_type/></data></instance>
      <instance id="deskTaxonomy.administrative_region"><root/></instance>
      <instance id="deskTaxonomy.species"><root/></instance>
      <instance id="deskTaxonomy.clinical_sign"><root/></instance>
      <instance id="deskTaxonomy.tentative_diagnosis"><root/></instance>
    </model>
  </head>
  <body>
    <select1 ref="/data/union"><itemset nodeset="instance('deskTaxonomy.administrative_region')/root/item"/></select1>
    <select1 ref="/data/species"><itemset nodeset="instance('deskTaxonomy.species')/root/item"/></select1>
    <select1 ref="/data/clinical_signs"><itemset nodeset="instance('deskTaxonomy.clinical_sign')/root/item"/></select1>
    <select1 ref="/data/tentative_diagnosis"><itemset nodeset="instance('deskTaxonomy.tentative_diagnosis')/root/item"/></select1>
    <select1 ref="/data/patient_type"><item><value>household</value><label>Household</label></item></select1>
  </body>
</html>`;

const taxonomyChoices: Record<string, string> = {
    administrative_region: '<root><item><name>901</name><label>Akram</label></item></root>',
    species: '<root><item><name>species.cattle</name><label>Cattle</label></item></root>',
    clinical_sign: '<root><item><name>clinical_sign.fever</name><label>Fever</label></item></root>',
    tentative_diagnosis: '<root><item><name>diagnosis.fmd</name><label>Foot and mouth disease</label></item></root>',
};

test('hydrates every dynamic dropdown before saved values are applied', async () => {
    const readChoices = async (slug: string) => taxonomyChoices[slug] ?? null;
    const hydrated = await hydrateDeskTaxonomyInstances(formDefinition, readChoices);
    const savedData = `
      <data>
        <division>Dhaka</division>
        <district>Dhaka</district>
        <upazila>Savar</upazila>
        <union>901</union>
        <species>species.cattle</species>
        <clinical_signs>clinical_sign.fever</clinical_signs>
        <tentative_diagnosis>diagnosis.fmd</tentative_diagnosis>
        <patient_type>household</patient_type>
      </data>`;
    const prefilled = prefillFormXML(hydrated, savedData);
    const document = parse(prefilled);

    assert.equal(document.getElementsByTagName('instance').item(1)?.getAttribute('id'), 'administrative_region');
    assert.equal(document.getElementsByTagName('instance').item(2)?.getAttribute('id'), 'species');
    assert.equal(document.getElementsByTagName('instance').item(3)?.getAttribute('id'), 'clinical_sign');
    assert.equal(document.getElementsByTagName('instance').item(4)?.getAttribute('id'), 'tentative_diagnosis');
    assert.equal(prefilled.includes('deskTaxonomy.'), false);
    assert.deepEqual(
        Array.from(document.getElementsByTagName('itemset')).map((itemset) => itemset.getAttribute('nodeset')),
        [
            "instance('administrative_region')/root/item",
            "instance('species')/root/item",
            "instance('clinical_sign')/root/item",
            "instance('tentative_diagnosis')/root/item",
        ],
    );
    assert.deepEqual(
        Array.from(document.getElementsByTagName('name')).map((choice) => choice.textContent),
        ['901', 'species.cattle', 'clinical_sign.fever', 'diagnosis.fmd'],
    );
    assert.equal(document.getElementsByTagName('union')[0].textContent, '901');
    assert.equal(document.getElementsByTagName('division')[0].textContent, 'Dhaka');
    assert.equal(document.getElementsByTagName('district')[0].textContent, 'Dhaka');
    assert.equal(document.getElementsByTagName('upazila')[0].textContent, 'Savar');
    assert.equal(document.getElementsByTagName('species')[0].textContent, 'species.cattle');
    assert.equal(document.getElementsByTagName('clinical_signs')[0].textContent, 'clinical_sign.fever');
    assert.equal(document.getElementsByTagName('tentative_diagnosis')[0].textContent, 'diagnosis.fmd');
    assert.equal(document.getElementsByTagName('patient_type')[0].textContent, 'household');
    assert.equal(document.getElementsByTagName('label')[4].textContent, 'Household');
});

test('fails closed when any dynamic taxonomy cannot be loaded', async () => {
    await assert.rejects(
        hydrateDeskTaxonomyInstances(formDefinition, async (slug) =>
            slug === 'tentative_diagnosis' ? null : (taxonomyChoices[slug] ?? null),
        ),
        /tentative_diagnosis/,
    );
});
