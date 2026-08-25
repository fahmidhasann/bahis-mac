import fs from 'node:fs';
import { parse } from 'csv-parse/sync';
import type { BahisDatabase } from './database.js';
import type { SpeciesChoice, SpeciesType, TaxonomyChoice } from './types.js';

type CsvRow = Record<string, string>;

function readRows(database: BahisDatabase, slug: string): CsvRow[] {
    return parse(fs.readFileSync(database.getTaxonomyPath(slug), 'utf8'), {
        columns: true,
        bom: true,
        skip_empty_lines: true,
        trim: true,
    }) as CsvRow[];
}

function requireColumns(rows: CsvRow[], slug: string, columns: string[], ignoreRow: (row: CsvRow) => boolean): void {
    if (rows.length === 0) throw new Error(`Taxonomy ${slug} is empty.`);
    for (const column of columns) {
        if (!(column in rows[0])) throw new Error(`Taxonomy ${slug} is missing required column ${column}.`);
    }
    rows.forEach((row, index) => {
        if (ignoreRow(row)) return;
        for (const column of columns) {
            if (!row[column]) throw new Error(`Taxonomy ${slug} row ${index + 2} has no ${column}.`);
        }
    });
}

export interface TaxonomyContext {
    species: SpeciesChoice[];
    clinicalSigns: Array<TaxonomyChoice & { speciesType: SpeciesType }>;
    tentativeDiagnoses: Array<TaxonomyChoice & { species: string }>;
}

export function loadTaxonomies(database: BahisDatabase): TaxonomyContext {
    const speciesRows = readRows(database, 'species');
    const clinicalSignRows = readRows(database, 'clinical_sign');
    const diagnosisRows = readRows(database, 'tentative_diagnosis');
    const isUnsupportedOther = (row: CsvRow) => row.name === 'other';
    requireColumns(speciesRows, 'species', ['name', 'label', 'species_type'], isUnsupportedOther);
    requireColumns(clinicalSignRows, 'clinical_sign', ['name', 'label', 'species_type'], isUnsupportedOther);
    requireColumns(diagnosisRows, 'tentative_diagnosis', ['name', 'label', 'species'], isUnsupportedOther);
    if (speciesRows.some((row) => !isUnsupportedOther(row) && row.species_type !== 'mammal' && row.species_type !== 'bird')) {
        throw new Error('Taxonomy species contains an unsupported species_type.');
    }
    if (clinicalSignRows.some((row) => !isUnsupportedOther(row) && row.species_type !== 'mammal' && row.species_type !== 'bird')) {
        throw new Error('Taxonomy clinical_sign contains an unsupported species_type.');
    }
    const species = speciesRows
        .filter((row) => !isUnsupportedOther(row))
        .map((row) => ({ id: row.name, label: row.label, speciesType: row.species_type as SpeciesType }));
    const clinicalSigns = clinicalSignRows
        .filter((row) => row.name !== 'other')
        .map((row) => ({ id: row.name, label: row.label, speciesType: row.species_type as SpeciesType }));
    const tentativeDiagnoses = diagnosisRows
        .filter((row) => row.name !== 'other')
        .map((row) => ({ id: row.name, label: row.label, species: row.species }));
    return { species, clinicalSigns, tentativeDiagnoses };
}
