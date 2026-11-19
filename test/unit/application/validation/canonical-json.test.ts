import { describe, expect, it } from 'bun:test';
import { canonicalStringify, sha256Hex } from '../../../../src/application/validation/canonical-json.js';

describe('canonicalStringify', () => {
    it('sorts keys recursively and drops undefined', () => {
        expect(canonicalStringify({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: undefined } })).toBe('{"a":{"d":[3,{"y":2,"z":1}]},"b":1}');
    });

    it('is independent of key insertion order', () => {
        expect(canonicalStringify({ x: 1, y: 2 })).toBe(canonicalStringify({ y: 2, x: 1 }));
    });

    it('keeps null distinct from a missing key', () => {
        expect(canonicalStringify({ a: null })).toBe('{"a":null}');
        expect(canonicalStringify({ a: undefined })).toBe('{}');
    });

    it('hashes with sha256 hex', () => {
        expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    });
});
