import { createHash } from 'node:crypto';

/**
 * JSON canônico: chaves de objetos em ordem lexicográfica (recursivamente),
 * sem espaços, `undefined` omitido. Dois payloads de negócio equivalentes
 * produzem sempre a mesma string, independentemente da ordem das chaves.
 *
 * Algoritmo do `payloadHash` (documentado em ARCHITECTURE.md):
 *   sha256_hex( canonicalStringify( subconjunto de campos de negócio ) )
 */
export function canonicalStringify(value: unknown): string {
    if (value === null || typeof value !== 'object') {
        return JSON.stringify(value) ?? 'null';
    }
    if (Array.isArray(value)) {
        return `[${value.map((item) => canonicalStringify(item)).join(',')}]`;
    }
    const record = value as Record<string, unknown>;
    const entries = Object.keys(record)
        .filter((key) => record[key] !== undefined)
        .sort()
        .map((key) => `${JSON.stringify(key)}:${canonicalStringify(record[key])}`);
    return `{${entries.join(',')}}`;
}

export function sha256Hex(text: string): string {
    return createHash('sha256').update(text).digest('hex');
}
